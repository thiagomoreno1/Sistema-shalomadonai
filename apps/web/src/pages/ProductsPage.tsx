import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { formatBRL, parseBrazilianCurrency } from '../lib/formatters'
import { supabaseClient } from '../lib/supabase'

type ProductCategory = { id: string; name: string; is_active: boolean }
type Product = {
  id: string
  name: string
  description: string | null
  category_id: string | null
  inventory_unit: string | null
  inventory_tracked: boolean
  minimum_stock: number | null
  is_combo: boolean
  sale_price_cents: number | null
  cost_cents: number | null
  image_path: string | null
  pending_image_cleanup_path: string | null
  image_url?: string | null
  is_active: boolean
}
type ComboComponent = { combo_product_id: string; component_product_id: string; quantity_per_combo: number }
type ComboDraft = { key: string; componentProductId: string; quantity: string }

const PRODUCT_PHOTO_BUCKET = 'product-photos'
const PRODUCT_PHOTO_MAX_BYTES = 5 * 1024 * 1024
const PRODUCT_PHOTO_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

function newKey() { return crypto.randomUUID() }

function parseQuantity(value: string, allowZero = false) {
  const cleaned = value.trim().replace(',', '.')
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(cleaned)
  if (!match) return null
  const mills = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'))
  if (!Number.isSafeInteger(mills) || mills > 99999999999 || (allowZero ? mills < 0 : mills <= 0)) return null
  return mills / 1000
}

function quantityInput(value: number) {
  return String(value).replace('.', ',')
}

export function ProductsPage() {
  const { id: businessId } = useBusiness()
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [comboComponents, setComboComponents] = useState<ComboComponent[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [inventoryEnabled, setInventoryEnabled] = useState(false)
  const [comboEnabled, setComboEnabled] = useState(false)
  const [openingQuantity, setOpeningQuantity] = useState('')
  const [minimumStock, setMinimumStock] = useState('')
  const [comboDraft, setComboDraft] = useState<ComboDraft[]>([{ key: newKey(), componentProductId: '', quantity: '1' }])
  const [showCategoryForm, setShowCategoryForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [categoryError, setCategoryError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedPhoto, setSelectedPhoto] = useState<File | null>(null)
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const photoPreviewUrlRef = useRef<string | null>(null)
  const photoRefreshAttemptsRef = useRef(new Set<string>())
  const inventoryRequestIdRef = useRef(newKey())

  useEffect(() => () => {
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current)
  }, [])

  function selectProductPhoto(file: File | null) {
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current)
    const previewUrl = file ? URL.createObjectURL(file) : null
    photoPreviewUrlRef.current = previewUrl
    setPhotoPreviewUrl(previewUrl)
    setSelectedPhoto(file)
  }

  function handlePhotoChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null
    event.currentTarget.value = ''
    if (!file) return
    if (!Object.hasOwn(PRODUCT_PHOTO_EXTENSIONS, file.type)) {
      setPhotoError('Escolha uma imagem JPEG, PNG ou WEBP.')
      return
    }
    if (file.size > PRODUCT_PHOTO_MAX_BYTES) {
      setPhotoError('A imagem deve ter no máximo 5 MB.')
      return
    }
    setPhotoError(null)
    selectProductPhoto(file)
  }

  const loadProducts = useCallback(async () => {
    if (!supabaseClient) {
      setLoading(false)
      return false
    }
    try {
      const [productsResult, categoriesResult, componentsResult] = await Promise.all([
        supabaseClient.from('products')
        .select('id, name, description, category_id, inventory_unit, inventory_tracked, minimum_stock, is_combo, sale_price_cents, cost_cents, image_path, pending_image_cleanup_path, is_active')
          .eq('business_id', businessId).order('name', { ascending: true }),
        supabaseClient.from('product_categories')
          .select('id, name, is_active').eq('business_id', businessId)
          .eq('is_active', true).order('name', { ascending: true }),
        supabaseClient.from('combo_components')
          .select('combo_product_id, component_product_id, quantity_per_combo')
          .eq('business_id', businessId),
      ])
      if (productsResult.error || categoriesResult.error || componentsResult.error) {
        setError('Não foi possível carregar o catálogo. Tente novamente.')
        return false
      } else {
        const loadedProducts = (productsResult.data ?? []) as Product[]
        const paths = loadedProducts.flatMap((product) => product.image_path ? [product.image_path] : [])
        const signedUrlByPath = new Map<string, string>()
        if (paths.length > 0) {
          try {
            const { data: signedPhotos, error: signedPhotoError } = await supabaseClient.storage
              .from(PRODUCT_PHOTO_BUCKET).createSignedUrls(paths, 3600)
            if (!signedPhotoError) {
              for (const photo of signedPhotos ?? []) {
                if (photo.path && photo.signedUrl) signedUrlByPath.set(photo.path, photo.signedUrl)
              }
            }
          } catch {
            // A thumbnail failure should not prevent the catalog from loading.
          }
        }
        photoRefreshAttemptsRef.current.clear()
        setProducts(loadedProducts.map((product) => ({
          ...product,
          image_url: product.image_path ? signedUrlByPath.get(product.image_path) ?? null : null,
        })))
        setCategories((categoriesResult.data ?? []) as ProductCategory[])
        setComboComponents((componentsResult.data ?? []) as ComboComponent[])
        setError(null)
        return true
      }
    } catch {
      setError('Não foi possível carregar o catálogo. Tente novamente.')
      return false
    } finally {
      setLoading(false)
    }
  }, [businessId])

  async function refreshProductPhoto(productId: string, path: string) {
    if (!supabaseClient) return
    if (photoRefreshAttemptsRef.current.has(productId)) {
      setProducts((current) => current.map((product) => product.id === productId ? { ...product, image_url: null } : product))
      setEditingProduct((current) => current?.id === productId ? { ...current, image_url: null } : current)
      if (editingProduct?.id === productId) setPhotoError('Não foi possível carregar a foto. Tente atualizar a prévia.')
      return
    }
    photoRefreshAttemptsRef.current.add(productId)
    try {
      const { data, error: signedUrlError } = await supabaseClient.storage
        .from(PRODUCT_PHOTO_BUCKET).createSignedUrl(path, 3600)
      const imageUrl = signedUrlError ? null : data?.signedUrl ?? null
      setProducts((current) => current.map((product) => product.id === productId && product.image_path === path
        ? { ...product, image_url: imageUrl }
        : product))
      setEditingProduct((current) => current?.id === productId && current.image_path === path
        ? { ...current, image_url: imageUrl }
        : current)
      if (editingProduct?.id === productId) {
        setPhotoError(imageUrl ? null : 'Não foi possível carregar a foto. Tente atualizar a prévia.')
      }
    } catch {
      setProducts((current) => current.map((product) => product.id === productId ? { ...product, image_url: null } : product))
      setEditingProduct((current) => current?.id === productId ? { ...current, image_url: null } : current)
      if (editingProduct?.id === productId) setPhotoError('Não foi possível carregar a foto. Tente atualizar a prévia.')
    }
  }

  async function clearPendingPhotoCleanup(productId: string, path: string) {
    if (!supabaseClient) return false
    const { error: updateError } = await supabaseClient.from('products')
      .update({ pending_image_cleanup_path: null })
      .eq('business_id', businessId).eq('id', productId).eq('pending_image_cleanup_path', path).select('id').maybeSingle()
    if (!updateError) {
      setEditingProduct((current) => current?.id === productId && current.pending_image_cleanup_path === path
        ? { ...current, pending_image_cleanup_path: null }
        : current)
      return true
    }
    const { data, error: confirmationError } = await supabaseClient.from('products')
      .select('pending_image_cleanup_path').eq('business_id', businessId).eq('id', productId).maybeSingle()
    if (!confirmationError && data?.pending_image_cleanup_path !== path) {
      setEditingProduct((current) => current?.id === productId && current.pending_image_cleanup_path === path
        ? { ...current, pending_image_cleanup_path: null }
        : current)
      return true
    }
    return false
  }

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadProducts() }, [loadProducts])

  const filteredProducts = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('pt-BR')
    if (!needle) return products
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]))
    return products.filter((product) =>
      `${product.name} ${product.description ?? ''} ${categoryNames.get(product.category_id ?? '') ?? ''}`
        .toLocaleLowerCase('pt-BR').includes(needle),
    )
  }, [products, categories, search])

  function startCreate() {
    setNotice(null)
    setEditingProduct(null)
    setShowForm(true)
    setFormError(null)
    setPhotoError(null)
    selectProductPhoto(null)
    setInventoryEnabled(false)
    setComboEnabled(false)
    setOpeningQuantity('')
    setMinimumStock('')
    setComboDraft([{ key: newKey(), componentProductId: '', quantity: '1' }])
    inventoryRequestIdRef.current = newKey()
  }

  function startEdit(product: Product) {
    setNotice(null)
    setEditingProduct(product)
    setShowForm(true)
    setFormError(null)
    setPhotoError(product.image_path && !product.image_url ? 'A foto está cadastrada, mas a prévia não carregou. Tente atualizar a foto.' : null)
    selectProductPhoto(null)
    setInventoryEnabled(product.inventory_tracked)
    setComboEnabled(product.is_combo)
    setOpeningQuantity('')
    setMinimumStock(product.minimum_stock === null ? '' : quantityInput(Number(product.minimum_stock)))
    const recipe = comboComponents.filter((component) => component.combo_product_id === product.id)
    setComboDraft(recipe.length > 0
      ? recipe.map((component) => ({ key: newKey(), componentProductId: component.component_product_id, quantity: quantityInput(Number(component.quantity_per_combo)) }))
      : [{ key: newKey(), componentProductId: '', quantity: '1' }])
    inventoryRequestIdRef.current = newKey()
  }

  async function handleSaveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const salePrice = parseBrazilianCurrency(String(form.get('sale_price') ?? ''))
    const cost = parseBrazilianCurrency(String(form.get('cost') ?? ''))
    const isActive = form.get('is_active') === 'on'
    const isCombo = comboEnabled
    const inventoryUnit = editingProduct?.inventory_tracked
      ? editingProduct.inventory_unit ?? ''
      : String(form.get('inventory_unit') ?? '').trim()
    const opening = parseQuantity(openingQuantity, true)
    const minimum = minimumStock.trim() ? parseQuantity(minimumStock, true) : null
    if (!name) {
      setFormError('Informe o nome do produto.')
      return
    }
    if (Number.isNaN(salePrice) || Number.isNaN(cost)) {
      setFormError('Confira os valores. Use até duas casas decimais, por exemplo 12,50.')
      return
    }
    if (isActive && salePrice === null) {
      setFormError('Informe o preço de venda ou deixe o produto inativo enquanto completa o cadastro.')
      return
    }

    if (isCombo && inventoryEnabled) {
      setFormError('Um combo controla os saldos dos componentes; não configure um saldo próprio para ele.')
      return
    }
    if (inventoryEnabled && !editingProduct?.inventory_tracked && (!inventoryUnit || opening === null)) {
      setFormError('Para iniciar o controle, informe a unidade e a contagem inicial. Zero também é uma contagem válida.')
      return
    }
    if (inventoryEnabled && minimumStock.trim() && minimum === null) {
      setFormError('Confira o limite mínimo. Use uma quantidade com até três casas decimais.')
      return
    }
    if (editingProduct?.inventory_tracked && inventoryUnit !== editingProduct.inventory_unit) {
      setFormError('A unidade de um produto com movimentações não pode ser alterada por aqui.')
      return
    }

    const recipe = comboDraft
      .filter((component) => component.componentProductId)
      .map((component) => ({ component_product_id: component.componentProductId, quantity_per_combo: parseQuantity(component.quantity) }))
    if (isCombo) {
      if (recipe.length === 0 || recipe.length !== comboDraft.length || recipe.some((component) => component.quantity_per_combo === null)) {
        setFormError('Inclua pelo menos um componente e informe uma quantidade positiva com até três casas decimais.')
        return
      }
      if (new Set(recipe.map((component) => component.component_product_id)).size !== recipe.length) {
        setFormError('Cada componente deve aparecer uma única vez na composição do combo.')
        return
      }
      const eligibleComponents = new Set(products.filter((product) => product.is_active && product.inventory_tracked && !product.is_combo).map((product) => product.id))
      if (recipe.some((component) => !eligibleComponents.has(component.component_product_id) || component.component_product_id === editingProduct?.id)) {
        setFormError('A composição aceita apenas produtos ativos com estoque configurado, sem combos dentro de combos.')
        return
      }
    }

    const record = {
      name,
      description: String(form.get('description') ?? '').trim() || null,
      category_id: String(form.get('category_id') ?? '').trim() || null,
      inventory_unit: inventoryUnit || null,
      sale_price_cents: salePrice,
      cost_cents: cost,
      is_active: isActive,
    }
    setSaving(true)
    setFormError(null)
    try {
      const result = editingProduct
        ? await supabaseClient.from('products').update({ ...record, minimum_stock: inventoryEnabled ? minimum : null }).eq('business_id', businessId).eq('id', editingProduct.id).select('id').single()
        : await supabaseClient.from('products').insert({ business_id: businessId, ...record }).select('id').single()
      if (result.error || !result.data) {
        setFormError('Não foi possível salvar. Seus dados continuam no formulário; tente novamente.')
        return
      }
      const productId = result.data.id as string
      let trackingWasConfigured = editingProduct?.inventory_tracked ?? false
      let comboWasConfigured = editingProduct?.is_combo ?? false
      const savedProduct = {
        id: productId, ...record, minimum_stock: editingProduct?.inventory_tracked && inventoryEnabled ? minimum : null,
        inventory_tracked: trackingWasConfigured,
        is_combo: comboWasConfigured,
        image_path: editingProduct?.image_path ?? null,
        pending_image_cleanup_path: editingProduct?.pending_image_cleanup_path ?? null,
        image_url: editingProduct?.image_url ?? null,
      } as Product
      setEditingProduct(savedProduct)

      if (inventoryEnabled && !trackingWasConfigured) {
        const { error: inventoryError } = await supabaseClient.rpc('configure_product_inventory', {
          p_business_id: businessId,
          p_product_id: productId,
          p_inventory_unit: inventoryUnit,
          p_opening_quantity: opening,
          p_minimum_stock: minimum,
          p_request_id: inventoryRequestIdRef.current,
        })
        if (inventoryError) {
          setFormError('O produto foi salvo, mas o estoque inicial não foi confirmado. Tente novamente sem alterar os dados.')
          await loadProducts()
          return
        }
        trackingWasConfigured = true
      }

      if (isCombo) {
        const { error: recipeError } = await supabaseClient.rpc('set_combo_components', {
          p_business_id: businessId,
          p_combo_product_id: productId,
          p_components: recipe,
        })
        if (recipeError) {
          setFormError('O produto foi salvo, mas a composição do combo não foi confirmada. Confira os componentes e tente novamente.')
          await loadProducts()
          return
        }
        comboWasConfigured = true
      }

      setEditingProduct({ ...savedProduct, inventory_tracked: trackingWasConfigured, is_combo: comboWasConfigured, minimum_stock: inventoryEnabled ? minimum : null })

      if (selectedPhoto) {
        const extension = PRODUCT_PHOTO_EXTENSIONS[selectedPhoto.type]
        const photoPath = `${businessId}/${productId}/${crypto.randomUUID()}.${extension}`
        const { error: uploadError } = await supabaseClient.storage.from(PRODUCT_PHOTO_BUCKET).upload(photoPath, selectedPhoto, {
          contentType: selectedPhoto.type,
          upsert: false,
        })
        if (uploadError) {
          setPhotoError('O produto foi salvo, mas a foto não foi enviada. Tente salvar novamente para repetir o envio sem criar outro produto.')
          await loadProducts()
          return
        }

        const { error: imagePathError } = await supabaseClient.from('products')
          .update({ image_path: photoPath, pending_image_cleanup_path: savedProduct.image_path })
          .eq('business_id', businessId).eq('id', productId).select('id').single()
        if (imagePathError) {
          const { data: confirmedProduct, error: confirmationError } = await supabaseClient.from('products')
            .select('image_path, pending_image_cleanup_path').eq('business_id', businessId).eq('id', productId).maybeSingle()
          if (confirmationError) {
            setPhotoError('O produto foi salvo, mas não foi possível confirmar a foto. Tente salvar novamente sem criar outro produto.')
            await loadProducts()
            return
          }
          if (confirmedProduct?.image_path !== photoPath || confirmedProduct.pending_image_cleanup_path !== savedProduct.image_path) {
            await supabaseClient.storage.from(PRODUCT_PHOTO_BUCKET).remove([photoPath])
            setPhotoError('O produto foi salvo, mas a foto não foi vinculada. Tente salvar novamente sem criar outro produto.')
            await loadProducts()
            return
          }
        }

        if (savedProduct.image_path) {
          setEditingProduct({ ...savedProduct, image_path: photoPath, pending_image_cleanup_path: savedProduct.image_path, image_url: null })
          const { error: cleanupError } = await supabaseClient.storage.from(PRODUCT_PHOTO_BUCKET).remove([savedProduct.image_path])
          if (cleanupError) {
            setPhotoError('A nova foto foi salva, mas o arquivo anterior não pôde ser excluído. Você pode tentar novamente abaixo.')
            photoRefreshAttemptsRef.current.delete(productId)
            selectProductPhoto(null)
            await loadProducts()
            return
          }
          const cleanupCleared = await clearPendingPhotoCleanup(productId, savedProduct.image_path)
          if (!cleanupCleared) {
            setPhotoError('A nova foto foi salva, mas não foi possível confirmar a limpeza do arquivo anterior. Tente novamente abaixo.')
            photoRefreshAttemptsRef.current.delete(productId)
            selectProductPhoto(null)
            await loadProducts()
            return
          }
        }
        setEditingProduct({ ...savedProduct, image_path: photoPath, pending_image_cleanup_path: null, image_url: null })
        setPhotoError(null)
        photoRefreshAttemptsRef.current.delete(productId)
        selectProductPhoto(null)
      }

      setShowForm(false)
      setEditingProduct(null)
      const refreshed = await loadProducts()
      setNotice(refreshed
        ? 'Produto salvo.'
        : 'Produto salvo. A lista não atualizou; use “Tentar novamente” para recarregar sem salvar de novo.')
    } catch {
      setFormError('Não foi possível salvar. Seus dados continuam no formulário; tente novamente.')
    } finally {
      setSaving(false)
    }
  }

  async function handleCreateCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('category_name') ?? '').trim()
    if (!name) return
    setSaving(true)
    setCategoryError(null)
    try {
      const { error: insertError } = await supabaseClient.from('product_categories').insert({ business_id: businessId, name })
      if (insertError) {
        setCategoryError(insertError.code === '23505' ? 'Já existe uma categoria com esse nome.' : 'Não foi possível salvar a categoria. Tente novamente.')
        return
      }
      setShowCategoryForm(false)
      const refreshed = await loadProducts()
      setNotice(refreshed ? 'Categoria salva.' : 'Categoria salva. A lista não atualizou; use “Tentar novamente” para recarregar sem salvar de novo.')
    } catch {
      setCategoryError('Não foi possível salvar a categoria. Tente novamente.')
    } finally {
      setSaving(false)
    }
  }

  function cancelForm() {
    setShowForm(false)
    setEditingProduct(null)
    setFormError(null)
    setPhotoError(null)
    selectProductPhoto(null)
    setInventoryEnabled(false)
    setComboEnabled(false)
  }

  async function handleRemoveProductPhoto() {
    if (!supabaseClient || !editingProduct?.image_path) return
    const product = editingProduct
    const path = editingProduct.image_path
    setSaving(true)
    setPhotoError(null)
    try {
      const { error: updateError } = await supabaseClient.from('products')
        .update({ image_path: null, pending_image_cleanup_path: path })
        .eq('business_id', businessId).eq('id', product.id).select('id').single()
      if (updateError) {
        setPhotoError('Não foi possível remover a foto do cadastro. Tente novamente.')
        return
      }
      setEditingProduct({ ...product, image_path: null, pending_image_cleanup_path: path, image_url: null })
      const { error: removeError } = await supabaseClient.storage.from(PRODUCT_PHOTO_BUCKET).remove([path])
      if (removeError) {
        setPhotoError('A foto saiu do cadastro, mas o arquivo antigo não pôde ser excluído. Tente novamente abaixo.')
      } else {
        const cleanupCleared = await clearPendingPhotoCleanup(product.id, path)
        setPhotoError(cleanupCleared ? null : 'O arquivo foi excluído, mas não foi possível confirmar a limpeza. Tente novamente abaixo.')
      }
      await loadProducts()
    } catch {
      setPhotoError('Não foi possível remover a foto. Confira o cadastro e tente novamente.')
    } finally {
      setSaving(false)
    }
  }

  async function retryPhotoCleanup(productId: string, path: string) {
    if (!supabaseClient || editingProduct?.id !== productId || editingProduct.pending_image_cleanup_path !== path) return
    setSaving(true)
    setPhotoError(null)
    try {
      const { error: removeError } = await supabaseClient.storage.from(PRODUCT_PHOTO_BUCKET).remove([path])
      if (removeError) {
        setPhotoError('O arquivo antigo ainda não pôde ser excluído. Tente novamente.')
        return
      }
      const cleanupCleared = await clearPendingPhotoCleanup(productId, path)
      setPhotoError(cleanupCleared ? null : 'O arquivo foi excluído, mas a limpeza ainda não foi confirmada. Tente novamente.')
      if (cleanupCleared) await loadProducts()
    } catch {
      setPhotoError('Não foi possível excluir o arquivo antigo. Tente novamente.')
    } finally {
      setSaving(false)
    }
  }

  const categoryNames = new Map(categories.map((category) => [category.id, category.name]))

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div><p className="eyebrow">CATÁLOGO</p><h1>Produtos</h1><p className="page-description">Cadastro básico de produtos e categorias para a operação.</p></div>
        <button className="button button-primary" onClick={startCreate} type="button"><Icon name="plus" /> Novo produto</button>
      </header>

      {notice && <p className="form-message form-message-success" role="status">{notice}</p>}

      <p className="section-footnote">Preços e custos são dados atuais do cadastro. Produtos sem estoque configurado permanecem identificados como não controlados.</p>

      {showForm && (
        <form className="surface-panel record-form" key={editingProduct?.id ?? 'new-product'} onSubmit={handleSaveProduct}>
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">CADASTRO</p><h2>{editingProduct ? 'Editar produto' : 'Novo produto'}</h2></div><button className="text-button" onClick={cancelForm} type="button">Fechar</button></div>
          <div className="record-form-grid">
            <label className="record-field record-field-wide"><span className="field-label">Nome do produto <span aria-hidden="true">*</span></span><input autoFocus className="text-input" defaultValue={editingProduct?.name ?? ''} maxLength={160} name="name" required /></label>
            <label className="record-field"><span className="field-label">Categoria <span className="field-optional">opcional</span></span><select className="text-input" defaultValue={editingProduct?.category_id ?? ''} name="category_id"><option value="">Sem categoria</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <div className="record-field record-field-actions"><span className="field-label">Categorias</span><button className="text-button" onClick={() => { setShowCategoryForm((value) => !value); setCategoryError(null) }} type="button">{showCategoryForm ? 'Fechar categorias' : 'Cadastrar categoria'}</button></div>
            <label className="record-field"><span className="field-label">Unidade de estoque <span className="field-optional">{inventoryEnabled ? 'obrigatória para controlar' : 'opcional'}</span></span><input className="text-input" defaultValue={editingProduct?.inventory_unit ?? ''} disabled={saving || Boolean(editingProduct?.inventory_tracked)} maxLength={32} name="inventory_unit" placeholder="Ex.: un, kg" required={inventoryEnabled} /></label>
            <label className="record-field"><span className="field-label">Preço de venda <span className="field-optional">R$</span></span><input className="text-input" defaultValue={editingProduct?.sale_price_cents === null || !editingProduct ? '' : (editingProduct.sale_price_cents / 100).toFixed(2).replace('.', ',')} inputMode="decimal" name="sale_price" placeholder="0,00" /></label>
            <label className="record-field"><span className="field-label">Custo atual <span className="field-optional">R$ · opcional</span></span><input className="text-input" defaultValue={editingProduct?.cost_cents === null || !editingProduct ? '' : (editingProduct.cost_cents / 100).toFixed(2).replace('.', ',')} inputMode="decimal" name="cost" placeholder="0,00" /></label>
            <label className="record-field record-field-wide"><span className="field-label">Descrição <span className="field-optional">opcional</span></span><textarea className="text-input record-textarea" defaultValue={editingProduct?.description ?? ''} maxLength={2000} name="description" rows={3} /></label>
            <div className="record-field record-field-wide product-photo-field">
              <span className="field-label">Foto do produto <span className="field-optional">opcional · JPEG, PNG ou WEBP · até 5 MB</span></span>
              <div className="product-photo-layout">
                <span className="product-photo-preview">
                  {(photoPreviewUrl || editingProduct?.image_url) ? <img alt={editingProduct ? `Foto de ${editingProduct.name}` : 'Prévia da foto do produto'} onError={() => { if (editingProduct?.image_path) void refreshProductPhoto(editingProduct.id, editingProduct.image_path) }} src={photoPreviewUrl ?? editingProduct?.image_url ?? ''} /> : <Icon name="box" />}
                </span>
                <div className="product-photo-copy">
                  <p className="section-footnote">{!editingProduct
                    ? selectedPhoto
                      ? 'A foto será enviada junto com o primeiro salvamento do produto.'
                      : 'Escolha uma foto agora; ela será enviada junto com o primeiro salvamento.'
                    : selectedPhoto
                      ? `Nova foto pronta: ${selectedPhoto.name}. Ela será enviada ao salvar.`
                      : editingProduct.image_path
                        ? 'A foto atual aparece somente para usuários autorizados.'
                        : 'Nenhuma foto cadastrada.'}{editingProduct?.pending_image_cleanup_path ? ' Um arquivo antigo aguarda exclusão.' : ''}</p>
                  <div className="product-photo-actions">
                    <label className={`button button-secondary product-photo-picker${saving || editingProduct?.pending_image_cleanup_path ? ' is-disabled' : ''}`}>Escolher foto<input accept="image/jpeg,image/png,image/webp" aria-describedby="product-photo-help" disabled={saving || Boolean(editingProduct?.pending_image_cleanup_path)} onChange={handlePhotoChange} type="file" /></label>
                    {selectedPhoto && <button className="text-button" disabled={saving} onClick={() => { selectProductPhoto(null); setPhotoError(null) }} type="button">Cancelar troca</button>}
                    {editingProduct?.image_path && <button className="text-button" disabled={saving || Boolean(selectedPhoto) || Boolean(editingProduct.pending_image_cleanup_path)} onClick={() => void handleRemoveProductPhoto()} type="button">Remover foto atual</button>}
                    {editingProduct?.image_path && !editingProduct.image_url && !photoPreviewUrl && <button className="text-button" disabled={saving} onClick={() => { photoRefreshAttemptsRef.current.delete(editingProduct.id); void refreshProductPhoto(editingProduct.id, editingProduct.image_path as string) }} type="button">Tentar carregar foto</button>}
                    {editingProduct?.pending_image_cleanup_path && <button className="text-button" disabled={saving} onClick={() => void retryPhotoCleanup(editingProduct.id, editingProduct.pending_image_cleanup_path as string)} type="button">Tentar excluir arquivo antigo</button>}
                  </div>
                  <span className="visually-hidden" id="product-photo-help">Escolha uma imagem JPEG, PNG ou WEBP com até 5 megabytes.</span>
                </div>
              </div>
              {(saving && selectedPhoto) && <p className="section-footnote" aria-live="polite" role="status">Salvando produto e enviando foto…</p>}
              {photoError && <p className="form-message form-message-error" role="alert">{photoError}</p>}
            </div>
            <label className="record-checkbox record-field-wide"><input checked={inventoryEnabled} disabled={saving || Boolean(editingProduct?.inventory_tracked) || comboEnabled} onChange={(event) => { setInventoryEnabled(event.target.checked); setMinimumStock('') }} name="inventory_tracked" type="checkbox" /><span><strong>Controlar saldo deste produto</strong><small>Para iniciar, informe a unidade e a contagem física atual, inclusive quando for zero.</small></span></label>
            {inventoryEnabled && !editingProduct?.inventory_tracked && <>
              <label className="record-field"><span className="field-label">Contagem inicial <span aria-hidden="true">*</span></span><input className="text-input" inputMode="decimal" onChange={(event) => setOpeningQuantity(event.target.value)} placeholder="0" required value={openingQuantity} /></label>
              <label className="record-field"><span className="field-label">Estoque mínimo <span className="field-optional">opcional</span></span><input className="text-input" inputMode="decimal" onChange={(event) => setMinimumStock(event.target.value)} placeholder="Sem alerta" value={minimumStock} /></label>
            </>}
            {inventoryEnabled && editingProduct?.inventory_tracked && <label className="record-field"><span className="field-label">Estoque mínimo <span className="field-optional">opcional</span></span><input className="text-input" inputMode="decimal" onChange={(event) => setMinimumStock(event.target.value)} placeholder="Sem alerta" value={minimumStock} /></label>}
            <label className="record-checkbox record-field-wide"><input checked={comboEnabled} disabled={saving || Boolean(editingProduct?.is_combo) || Boolean(editingProduct?.inventory_tracked)} onChange={(event) => { setComboEnabled(event.target.checked); if (event.target.checked) setInventoryEnabled(false) }} name="is_combo" type="checkbox" /><span><strong>Este produto é um combo</strong><small>O saldo será calculado pelos componentes cadastrados.</small></span></label>
            {comboEnabled && <div className="combo-composition record-field-wide">
              <div className="section-heading section-heading-compact"><div><p className="eyebrow">COMPOSIÇÃO</p><h3>Itens consumidos por combo</h3></div><button className="button button-secondary" disabled={saving} onClick={() => setComboDraft((current) => [...current, { key: newKey(), componentProductId: '', quantity: '1' }])} type="button"><Icon name="plus" /> Adicionar item</button></div>
              <p className="section-footnote">Cada componente precisa ter unidade e estoque inicial configurados. Pedidos existentes guardam a composição usada na venda.</p>
              {comboDraft.map((component, index) => (
                <div className="combo-component-row" key={component.key}>
                  <label className="record-field"><span className="field-label">Componente {index + 1}</span><select className="text-input" onChange={(event) => setComboDraft((current) => current.map((row) => row.key === component.key ? { ...row, componentProductId: event.target.value } : row))} required value={component.componentProductId}><option value="">Selecione um produto com estoque</option>{products.filter((product) => product.is_active && product.inventory_tracked && !product.is_combo && product.id !== editingProduct?.id).map((product) => <option key={product.id} value={product.id}>{product.name} · {product.inventory_unit}</option>)}</select></label>
                  <label className="record-field"><span className="field-label">Quantidade por combo</span><input className="text-input" inputMode="decimal" onChange={(event) => setComboDraft((current) => current.map((row) => row.key === component.key ? { ...row, quantity: event.target.value } : row))} placeholder="1" required value={component.quantity} /></label>
                  <button aria-label={'Remover componente ' + (index + 1)} className="text-button order-remove-button" disabled={saving || comboDraft.length === 1} onClick={() => setComboDraft((current) => current.filter((row) => row.key !== component.key))} type="button">Remover</button>
                </div>
              ))}
            </div>}
            <label className="record-checkbox record-field-wide"><input defaultChecked={editingProduct?.is_active ?? true} name="is_active" type="checkbox" /><span>Disponível no catálogo</span></label>
          </div>
          {formError && <p className="form-message form-message-error" role="alert">{formError}</p>}
          <div className="record-form-actions"><button className="button button-primary" disabled={saving} type="submit">{saving ? 'Salvando…' : editingProduct ? 'Salvar alterações' : 'Salvar produto'}</button><p className="section-footnote">Produtos sem preço podem ser salvos como inativos para completar depois.</p></div>
        </form>
      )}
      {showCategoryForm && (
        <form className="surface-panel category-inline-form" onSubmit={(event) => { event.preventDefault(); void handleCreateCategory(event) }}>
          <label className="record-field"><span className="field-label">Nova categoria</span><input autoFocus className="text-input" maxLength={100} name="category_name" required /></label>
          <button className="button button-secondary" disabled={saving} type="submit">{saving ? 'Salvando…' : 'Salvar categoria'}</button>
          <button className="text-button" onClick={() => { setShowCategoryForm(false); setCategoryError(null) }} type="button">Fechar</button>
          {categoryError && <p className="form-message form-message-error" role="alert">{categoryError}</p>}
        </form>
      )}

      <section className="surface-panel record-panel" aria-labelledby="product-list-title">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">CADASTRO</p><h2 id="product-list-title">Produtos</h2></div><span className="neutral-status">{products.length} {products.length === 1 ? 'produto' : 'produtos'}</span></div>
        <label className="search-field"><Icon name="search" /><span className="visually-hidden">Buscar produtos por nome ou categoria</span><input onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nome ou categoria" value={search} /></label>
        {loading && <p className="inline-state" aria-live="polite">Carregando produtos…</p>}
        {!loading && error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => { setLoading(true); void loadProducts() }} type="button">Tentar novamente</button></div>}
        {!loading && !error && products.length === 0 && <div className="module-empty-panel record-empty"><span className="empty-icon"><Icon name="box" /></span><h2>Nenhum produto cadastrado</h2><p>Cadastre produtos, configure unidade e contagem inicial para iniciar o controle, e monte os componentes dos combos.</p><button className="button button-primary" onClick={startCreate} type="button">Cadastrar primeiro produto</button></div>}
        {!loading && !error && products.length > 0 && filteredProducts.length === 0 && <div className="inline-state"><p>Nenhum produto corresponde à busca.</p><button className="text-button" onClick={() => setSearch('')} type="button">Limpar busca</button></div>}
        {!loading && !error && filteredProducts.length > 0 && (
          <ul className="record-list product-list">
            {filteredProducts.map((product) => (
              <li className={product.is_active ? '' : 'record-inactive'} key={product.id}>
                <div className="product-row">
                  <span className="record-avatar">{product.image_url
                    ? <img alt={`Foto de ${product.name}`} onError={() => { if (product.image_path) void refreshProductPhoto(product.id, product.image_path) }} src={product.image_url} />
                    : <Icon name="box" />}</span>
                  <span className="record-list-copy"><strong>{product.name}</strong><small>{categoryNames.get(product.category_id ?? '') ?? 'Sem categoria'}{product.inventory_unit ? ' · ' + product.inventory_unit : ''}{product.is_combo ? ' · Combo (' + comboComponents.filter((component) => component.combo_product_id === product.id).length + ' itens)' : product.inventory_tracked ? ' · Estoque controlado' : ' · Estoque não configurado'}</small></span>
                  <span className="product-price"><strong>{formatBRL(product.sale_price_cents)}</strong><small>{product.is_active ? 'Ativo' : 'Inativo'}{product.is_combo && comboComponents.filter((component) => component.combo_product_id === product.id).length === 0 ? ' · Sem composição' : ''}</small></span>
                  <button className="text-button" onClick={() => startEdit(product)} type="button">Editar</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
