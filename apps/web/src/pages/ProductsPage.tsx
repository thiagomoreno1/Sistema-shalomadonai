import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type SyntheticEvent } from 'react'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { formatBRL, parseBrazilianCurrency } from '../lib/formatters'
import { INVENTORY_UNIT_OPTIONS, isDiscreteInventoryUnit, isKnownInventoryUnit, OTHER_INVENTORY_UNIT_OPTION } from '../lib/inventoryUnits'
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
type ProductPriceHistoryEntry = {
  id: string
  event_sequence: number | string
  event_kind: 'baseline' | 'created' | 'updated'
  old_sale_price_cents: number | null
  new_sale_price_cents: number | null
  old_cost_cents: number | null
  new_cost_cents: number | null
  changed_at: string
}

const PRODUCT_PHOTO_BUCKET = 'product-photos'
const PRODUCT_PHOTO_MAX_BYTES = 5 * 1024 * 1024
const PRODUCT_PHOTO_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}
const PRODUCT_PRICE_HISTORY_PAGE_SIZE = 50

function newKey() { return crypto.randomUUID() }

function parseQuantity(value: string, allowZero = false) {
  const cleaned = value.trim().replace(',', '.')
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(cleaned)
  if (!match) return null
  const mills = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'))
  if (!Number.isSafeInteger(mills) || mills > 99999999999 || (allowZero ? mills < 0 : mills <= 0)) return null
  return mills / 1000
}

function parseStockQuantity(value: string, unit: string | null | undefined, allowZero = false) {
  const quantity = parseQuantity(value, allowZero)
  return isDiscreteInventoryUnit(unit) && quantity !== null && !Number.isSafeInteger(quantity) ? null : quantity
}

function quantityInput(value: number) {
  return String(value).replace('.', ',')
}

function formatPriceHistoryDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Data não disponível'
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(date)
}

function ProductPriceHistory({ businessId, productId, refreshToken }: { businessId: string; productId: string; refreshToken: number }) {
  const [entries, setEntries] = useState<ProductPriceHistoryEntry[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorMode, setErrorMode] = useState<'initial' | 'more' | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const entriesRef = useRef<ProductPriceHistoryEntry[]>([])
  const requestIdRef = useRef(0)
  const previousRefreshTokenRef = useRef(refreshToken)

  const loadHistory = useCallback(async (reset: boolean) => {
    if (!supabaseClient) {
      setError('O histórico não está disponível agora. Tente novamente.')
      setErrorMode(reset ? 'initial' : 'more')
      return
    }

    const requestId = ++requestIdRef.current
    const cursor = reset ? null : entriesRef.current.at(-1)?.event_sequence ?? null
    if (!reset && cursor === null) return
    setError(null)
    setErrorMode(null)
    if (reset) setLoading(true)
    else setLoadingMore(true)

    try {
      let query = supabaseClient.from('product_price_history')
        .select('id, event_sequence, event_kind, old_sale_price_cents, new_sale_price_cents, old_cost_cents, new_cost_cents, changed_at')
        .eq('business_id', businessId)
        .eq('product_id', productId)
        .order('event_sequence', { ascending: false })
        .limit(PRODUCT_PRICE_HISTORY_PAGE_SIZE)
      if (cursor !== null) query = query.lt('event_sequence', String(cursor))
      const { data, error: historyError } = await query

      if (requestId !== requestIdRef.current) return
      if (historyError) {
        setError('Não foi possível carregar o histórico de preço e custo. Tente novamente.')
        setErrorMode(reset ? 'initial' : 'more')
        return
      }

      const page = (data ?? []) as ProductPriceHistoryEntry[]
      const nextEntries = reset ? page : [...entriesRef.current, ...page]
      entriesRef.current = nextEntries
      setEntries(nextEntries)
      setHasMore(page.length === PRODUCT_PRICE_HISTORY_PAGE_SIZE)
    } catch {
      if (requestId !== requestIdRef.current) return
      setError('Não foi possível carregar o histórico de preço e custo. Tente novamente.')
      setErrorMode(reset ? 'initial' : 'more')
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [businessId, productId])

  // Refresh persisted history after the product write succeeds.
  useEffect(() => {
    if (previousRefreshTokenRef.current === refreshToken) return
    previousRefreshTokenRef.current = refreshToken
    // oxlint-disable-next-line react/set-state-in-effect
    if (isOpen) void loadHistory(true)
  }, [isOpen, loadHistory, refreshToken])

  useEffect(() => () => { requestIdRef.current += 1 }, [])

  function handleToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    const open = event.currentTarget.open
    setIsOpen(open)
    if (open && entries.length === 0 && !loading && !error) void loadHistory(true)
  }

  function valueLabel(value: number | null) {
    return value === null ? 'Não informado' : formatBRL(value)
  }

  function historySummary(entry: ProductPriceHistoryEntry) {
    if (entry.event_kind === 'baseline' || entry.event_kind === 'created') {
      const prefix = entry.event_kind === 'baseline' ? 'Ponto de partida' : 'No cadastro'
      return [
        `${prefix} · preço de venda: ${valueLabel(entry.new_sale_price_cents)}`,
        `${prefix} · custo: ${valueLabel(entry.new_cost_cents)}`,
      ]
    }
    const changes: string[] = []
    if (entry.old_sale_price_cents !== entry.new_sale_price_cents) {
      changes.push(`Preço de venda: ${valueLabel(entry.old_sale_price_cents)} → ${valueLabel(entry.new_sale_price_cents)}`)
    }
    if (entry.old_cost_cents !== entry.new_cost_cents) {
      changes.push(`Custo: ${valueLabel(entry.old_cost_cents)} → ${valueLabel(entry.new_cost_cents)}`)
    }
    return changes
  }

  return (
    <details className="product-price-history" onToggle={handleToggle} open={isOpen}>
      <summary>Histórico de preço e custo</summary>
      <p className="product-price-history-note">O ponto de partida foi registrado na data exibida: ele mostra os valores atuais naquele momento; alterações anteriores não foram recuperadas.</p>
      {loading && <p className="inline-state" aria-live="polite">Carregando histórico…</p>}
      {error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" disabled={loading || loadingMore} onClick={() => void loadHistory(errorMode !== 'more')} type="button">Tentar novamente</button></div>}
      {!loading && !error && entries.length === 0 && <p className="inline-state">Nenhuma alteração registrada ainda.</p>}
      {entries.length > 0 && (
        <ol className="product-price-history-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <div className="product-price-history-heading"><strong>{entry.event_kind === 'baseline' ? 'Ponto de partida do histórico' : entry.event_kind === 'created' ? 'Produto cadastrado' : 'Valores atualizados'}</strong><time dateTime={entry.changed_at}>{formatPriceHistoryDate(entry.changed_at)}</time></div>
              <ul>{historySummary(entry).map((change) => <li key={change}>{change}</li>)}</ul>
            </li>
          ))}
        </ol>
      )}
      {hasMore && errorMode !== 'more' && <div className="product-price-history-more"><button className="button button-secondary" disabled={loadingMore || loading} onClick={() => void loadHistory(false)} type="button">{loadingMore ? 'Carregando…' : 'Carregar mais alterações'}</button></div>}
    </details>
  )
}

export function ProductsPage() {
  const { id: businessId } = useBusiness()
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [search, setSearch] = useState('')
  const [selectedCategoryId, setSelectedCategoryId] = useState('all')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [productIsActive, setProductIsActive] = useState(true)
  const comboEnabled = Boolean(editingProduct?.is_combo)
  const [inventoryUnitChoice, setInventoryUnitChoice] = useState('un')
  const [customInventoryUnit, setCustomInventoryUnit] = useState('')
  const [openingQuantity, setOpeningQuantity] = useState('')
  const [minimumStock, setMinimumStock] = useState('')
  const [showCategoryForm, setShowCategoryForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [categoryError, setCategoryError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [priceHistoryRefreshToken, setPriceHistoryRefreshToken] = useState(0)
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
      const [productsResult, categoriesResult] = await Promise.all([
        supabaseClient.from('products')
        .select('id, name, description, category_id, inventory_unit, inventory_tracked, minimum_stock, is_combo, sale_price_cents, cost_cents, image_path, pending_image_cleanup_path, is_active')
          .eq('business_id', businessId).order('name', { ascending: true }),
        supabaseClient.from('product_categories')
          .select('id, name, is_active').eq('business_id', businessId)
          .eq('is_active', true).order('name', { ascending: true }),
      ])
      if (productsResult.error || categoriesResult.error) {
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
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]))
    return products.filter((product) => {
      const matchesCategory = selectedCategoryId === 'all' || (selectedCategoryId === 'uncategorized'
        ? product.category_id === null
        : product.category_id === selectedCategoryId)
      const matchesSearch = !needle || `${product.name} ${product.description ?? ''} ${categoryNames.get(product.category_id ?? '') ?? ''}`
        .toLocaleLowerCase('pt-BR').includes(needle)
      return matchesCategory && matchesSearch
    })
  }, [products, categories, search, selectedCategoryId])

  const chosenInventoryUnit = inventoryUnitChoice === OTHER_INVENTORY_UNIT_OPTION ? customInventoryUnit.trim() : inventoryUnitChoice
  const formInventoryUnit = editingProduct?.inventory_tracked ? editingProduct.inventory_unit ?? '' : chosenInventoryUnit

  function startCreate() {
    setNotice(null)
    setEditingProduct(null)
    setShowForm(true)
    setProductIsActive(true)
    setInventoryUnitChoice('un')
    setCustomInventoryUnit('')
    setFormError(null)
    setPhotoError(null)
    selectProductPhoto(null)
    setOpeningQuantity('')
    setMinimumStock('')
    inventoryRequestIdRef.current = newKey()
  }

  function startEdit(product: Product) {
    setNotice(null)
    setEditingProduct(product)
    setShowForm(true)
    setProductIsActive(product.is_active)
    const productUnit = product.inventory_unit ?? 'un'
    setInventoryUnitChoice(isKnownInventoryUnit(productUnit) ? productUnit : OTHER_INVENTORY_UNIT_OPTION)
    setCustomInventoryUnit(isKnownInventoryUnit(productUnit) ? '' : productUnit)
    setFormError(null)
    setPhotoError(product.image_path && !product.image_url ? 'A foto está cadastrada, mas a prévia não carregou. Tente atualizar a foto.' : null)
    selectProductPhoto(null)
    setOpeningQuantity('')
    setMinimumStock(product.minimum_stock === null ? '' : quantityInput(Number(product.minimum_stock)))
    inventoryRequestIdRef.current = newKey()
  }

  async function handleSaveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const salePrice = parseBrazilianCurrency(String(form.get('sale_price') ?? ''))
    const cost = parseBrazilianCurrency(String(form.get('cost') ?? ''))
    const isActive = productIsActive
    const isCombo = Boolean(editingProduct?.is_combo)
    const inventoryUnit = isCombo
      ? ''
      : editingProduct?.inventory_tracked
        ? editingProduct.inventory_unit ?? ''
        : chosenInventoryUnit
    const opening = parseStockQuantity(openingQuantity, inventoryUnit, true)
    const minimum = minimumStock.trim() ? parseStockQuantity(minimumStock, inventoryUnit, true) : null
    if (!name) {
      setFormError('Informe o nome do produto.')
      return
    }
    if (Number.isNaN(salePrice) || Number.isNaN(cost)) {
      setFormError('Confira os valores. Use até duas casas decimais, por exemplo 12,50.')
      return
    }
    if ((isActive || isCombo) && cost === null) {
      setFormError('Informe o custo unitário para ativar o produto. O faturamento usa esse valor nos próximos pedidos.')
      return
    }
    if (isActive && salePrice === null) {
      setFormError('Informe o preço de venda ou deixe o produto inativo enquanto completa o cadastro.')
      return
    }

    if (!isCombo && !editingProduct?.inventory_tracked && (!inventoryUnit || opening === null)) {
      const quantityGuidance = isDiscreteInventoryUnit(inventoryUnit)
        ? `Para ${inventoryUnit || 'unidade/peça'}, use um número inteiro.`
        : 'Para medidas como kg e litros, use até 3 casas decimais.'
      setFormError(`Escolha a unidade e informe quantos produtos há agora. ${quantityGuidance} Use 0 se não houver nenhum.`)
      return
    }
    if (!isCombo && !editingProduct?.inventory_tracked && opening !== null && opening > 0 && cost === null) {
      setFormError('Informe quanto custa cada unidade para calcular o valor inicial do estoque.')
      return
    }
    if (!isCombo && minimumStock.trim() && minimum === null) {
      setFormError(isDiscreteInventoryUnit(inventoryUnit)
        ? 'O estoque mínimo para essa unidade precisa ser um número inteiro.'
        : 'Confira o estoque mínimo. Use até 3 casas decimais.')
      return
    }
    if (editingProduct?.inventory_tracked && inventoryUnit !== editingProduct.inventory_unit) {
      setFormError('A unidade de um produto com movimentações não pode ser alterada por aqui.')
      return
    }

    const mustConfigureInventory = !isCombo && !editingProduct?.inventory_tracked
    const isInitiallyActive = mustConfigureInventory ? false : isActive
    const record = {
      name,
      // Keep legacy product descriptions intact without asking people to maintain
      // free-form copy that is not used by the operational workflow.
      description: editingProduct?.description ?? null,
      category_id: String(form.get('category_id') ?? '').trim() || null,
      inventory_unit: inventoryUnit || null,
      sale_price_cents: salePrice,
      cost_cents: cost,
      is_active: isInitiallyActive,
    }
    setSaving(true)
    setFormError(null)
    try {
      const result = editingProduct
        ? await supabaseClient.from('products').update({ ...record, minimum_stock: editingProduct.inventory_tracked && !isCombo ? minimum : null }).eq('business_id', businessId).eq('id', editingProduct.id).select('id').single()
        : await supabaseClient.from('products').insert({ business_id: businessId, ...record }).select('id').single()
      if (result.error || !result.data) {
        setFormError('Não foi possível salvar. Seus dados continuam no formulário; tente novamente.')
        return
      }
      const productId = result.data.id as string
      setPriceHistoryRefreshToken((current) => current + 1)
      let trackingWasConfigured = editingProduct?.inventory_tracked ?? false
      const comboWasConfigured = editingProduct?.is_combo ?? false
      let savedProduct = {
        id: productId, ...record, minimum_stock: editingProduct?.inventory_tracked && !isCombo ? minimum : null,
        inventory_tracked: trackingWasConfigured,
        is_combo: comboWasConfigured,
        image_path: editingProduct?.image_path ?? null,
        pending_image_cleanup_path: editingProduct?.pending_image_cleanup_path ?? null,
        image_url: editingProduct?.image_url ?? null,
      } as Product
      setEditingProduct(savedProduct)

      if (mustConfigureInventory && !trackingWasConfigured) {
        const { error: inventoryError } = await supabaseClient.rpc('configure_product_inventory', {
          p_business_id: businessId,
          p_product_id: productId,
          p_inventory_unit: inventoryUnit,
          p_opening_quantity: opening,
          p_minimum_stock: minimum,
          p_request_id: inventoryRequestIdRef.current,
        })
        if (inventoryError) {
          savedProduct = { ...savedProduct, is_active: false }
          setEditingProduct(savedProduct)
          setProductIsActive(false)
          setFormError('O produto foi salvo, mas o estoque inicial não foi confirmado. Tente novamente sem alterar os dados.')
          await loadProducts()
          return
        }
        trackingWasConfigured = true
      }

      if (isInitiallyActive !== isActive && (mustConfigureInventory || isCombo)) {
        const { data: activationData, error: activationError } = await supabaseClient.from('products')
          .update({ is_active: isActive })
          .eq('business_id', businessId).eq('id', productId).select('id').single()
        if (activationError || !activationData) {
          const { data: currentStatus } = await supabaseClient.from('products').select('is_active')
            .eq('business_id', businessId).eq('id', productId).maybeSingle()
          const confirmedAvailable = currentStatus?.is_active ?? isInitiallyActive
          savedProduct = { ...savedProduct, is_active: confirmedAvailable }
          setEditingProduct(savedProduct)
          setProductIsActive(confirmedAvailable)
          setFormError('A configuração foi salva, mas não foi possível atualizar a disponibilidade do produto. Tente novamente.')
          await loadProducts()
          return
        }
      }

      savedProduct = { ...savedProduct, is_active: isActive }
      setProductIsActive(isActive)

      setEditingProduct({ ...savedProduct, inventory_tracked: trackingWasConfigured, is_combo: comboWasConfigured, minimum_stock: !isCombo ? minimum : null })

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
    setProductIsActive(true)
    setInventoryUnitChoice('un')
    setCustomInventoryUnit('')
    selectProductPhoto(null)
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
        <div><p className="eyebrow">CATÁLOGO</p><h1>Produtos</h1></div>
        <button className="button button-primary" onClick={startCreate} type="button"><Icon name="plus" /> Novo produto</button>
      </header>

      {notice && <p className="form-message form-message-success" role="status">{notice}</p>}

      {showForm && (
        <form className="surface-panel record-form" key={editingProduct?.id ?? 'new-product'} onSubmit={handleSaveProduct}>
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">CADASTRO</p><h2>{editingProduct ? 'Editar produto' : 'Novo produto'}</h2></div><button className="text-button" onClick={cancelForm} type="button">Fechar</button></div>
          <div className="record-form-grid">
            <label className="record-field record-field-wide"><span className="field-label">Nome do produto <span aria-hidden="true">*</span></span><input autoFocus className="text-input" defaultValue={editingProduct?.name ?? ''} maxLength={160} name="name" required /></label>
            <label className="record-field"><span className="field-label">Preço de venda <span className="field-optional">R$</span> {productIsActive && <span aria-hidden="true">*</span>}</span><input className="text-input" defaultValue={editingProduct?.sale_price_cents === null || !editingProduct ? '' : (editingProduct.sale_price_cents / 100).toFixed(2).replace('.', ',')} inputMode="decimal" name="sale_price" placeholder="0,00" required={productIsActive} /></label>
            <label className="record-field"><span className="field-label">Custo por unidade <span className="field-optional">R$</span> {(productIsActive || comboEnabled) && <span aria-hidden="true">*</span>}</span><input className="text-input" defaultValue={editingProduct?.cost_cents === null || !editingProduct ? '' : (editingProduct.cost_cents / 100).toFixed(2).replace('.', ',')} inputMode="decimal" name="cost" placeholder="0,00" required={productIsActive || comboEnabled} /></label>
            <details className="optional-record-details record-field-wide" open={Boolean(editingProduct?.image_path || photoPreviewUrl) || undefined}>
              <summary>Foto do produto <span className="field-optional">opcional</span></summary>
              <div className="record-form-grid">
            <div className="record-field record-field-wide product-photo-field">
              <span className="field-label">Imagem <span className="field-optional">JPEG, PNG ou WEBP · até 5 MB</span></span>
              <div className="product-photo-layout">
                <span className="product-photo-preview">
                  {(photoPreviewUrl || editingProduct?.image_url) ? <img alt={editingProduct ? `Foto de ${editingProduct.name}` : 'Prévia da foto do produto'} onError={() => { if (editingProduct?.image_path) void refreshProductPhoto(editingProduct.id, editingProduct.image_path) }} src={photoPreviewUrl ?? editingProduct?.image_url ?? ''} /> : <Icon name="box" />}
                </span>
                <div className="product-photo-copy">
                  <p className="section-footnote">{selectedPhoto
                    ? `${selectedPhoto.name} · será salva junto com o produto.`
                    : editingProduct?.image_path
                      ? 'Foto cadastrada.'
                      : 'Nenhuma foto.'}{editingProduct?.pending_image_cleanup_path ? ' Uma foto antiga aguarda exclusão.' : ''}</p>
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
              </div>
            </details>
            <section className="product-stock-settings record-field-wide" hidden={comboEnabled} aria-labelledby="product-stock-heading">
              <div className="section-heading section-heading-compact"><div><p className="eyebrow">ESTOQUE</p><h3 id="product-stock-heading">Quantidade inicial</h3></div></div>
              <div className="record-form-grid product-stock-grid">
                <label className="record-field"><span className="field-label">Unidade de contagem <span aria-hidden="true">*</span></span>
                  <select className="text-input" disabled={saving || comboEnabled || Boolean(editingProduct?.inventory_tracked)} onChange={(event) => setInventoryUnitChoice(event.target.value)} required={!comboEnabled} value={inventoryUnitChoice}>
                    {INVENTORY_UNIT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    <option value={OTHER_INVENTORY_UNIT_OPTION}>Outra unidade…</option>
                  </select>
                </label>
                {inventoryUnitChoice === OTHER_INVENTORY_UNIT_OPTION && <label className="record-field"><span className="field-label">Especifique a unidade <span aria-hidden="true">*</span></span><input className="text-input" disabled={saving || comboEnabled || Boolean(editingProduct?.inventory_tracked)} maxLength={32} onChange={(event) => setCustomInventoryUnit(event.target.value)} placeholder="Ex.: fardo, bandeja" required={!comboEnabled} value={customInventoryUnit} /></label>}
                {!editingProduct?.inventory_tracked && <label className="record-field"><span className="field-label">Quantidade inicial{chosenInventoryUnit ? ` · ${chosenInventoryUnit}` : ''} <span aria-hidden="true">*</span></span><input className="text-input" disabled={saving || comboEnabled} inputMode={isDiscreteInventoryUnit(chosenInventoryUnit) ? 'numeric' : 'decimal'} max={999999999.999} min={0} onChange={(event) => setOpeningQuantity(event.target.value)} placeholder="0" required={!comboEnabled} step={isDiscreteInventoryUnit(chosenInventoryUnit) ? 1 : 0.001} value={openingQuantity} /></label>}
                <details className="optional-record-details product-stock-minimum" open={Boolean(minimumStock) || undefined}>
                  <summary>Definir estoque mínimo <span className="field-optional">opcional</span></summary>
                  <label className="record-field"><span className="field-label">Estoque mínimo{formInventoryUnit ? ` · ${formInventoryUnit}` : ''}</span><input className="text-input" disabled={saving || comboEnabled} inputMode={isDiscreteInventoryUnit(formInventoryUnit) ? 'numeric' : 'decimal'} max={999999999.999} min={0} onChange={(event) => setMinimumStock(event.target.value)} placeholder="Sem alerta" step={isDiscreteInventoryUnit(formInventoryUnit) ? 1 : 0.001} value={minimumStock} /></label>
                </details>
              </div>
            </section>
            <details className="optional-record-details record-field-wide product-more-options" open={Boolean(comboEnabled || editingProduct?.category_id || editingProduct?.is_combo || editingProduct?.image_path || minimumStock || !productIsActive) || undefined}>
              <summary>Mais opções</summary>
              <div className="record-form-grid">
                {editingProduct && <div className="record-field record-field-wide"><ProductPriceHistory businessId={businessId} productId={editingProduct.id} refreshToken={priceHistoryRefreshToken} /></div>}
                <label className="record-field"><span className="field-label">Categoria <span className="field-optional">opcional</span></span><select className="text-input" defaultValue={editingProduct?.category_id ?? ''} name="category_id"><option value="">Sem categoria</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
                <div className="record-field record-field-actions"><span className="field-label">Categorias</span><button className="text-button" onClick={() => { setShowCategoryForm((value) => !value); setCategoryError(null) }} type="button">{showCategoryForm ? 'Fechar categorias' : 'Cadastrar categoria'}</button></div>
                {editingProduct?.is_combo && <p className="section-footnote record-field-wide">Este item antigo mantém a composição usada nos pedidos já registrados.</p>}
                <label className="record-checkbox record-field-wide"><input checked={productIsActive} onChange={(event) => setProductIsActive(event.target.checked)} name="is_active" type="checkbox" /><span>Disponível no catálogo</span></label>
              </div>
            </details>
          </div>
          {formError && <p className="form-message form-message-error" role="alert">{formError}</p>}
          <div className="record-form-actions"><button className="button button-primary" disabled={saving} type="submit">{saving ? 'Salvando…' : editingProduct ? 'Salvar alterações' : 'Salvar produto'}</button></div>
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
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">CADASTRO</p><h2 id="product-list-title">Produtos</h2></div><span className="neutral-status">{filteredProducts.length} de {products.length} {products.length === 1 ? 'produto' : 'produtos'}</span></div>
        <label className="search-field"><Icon name="search" /><span className="visually-hidden">Buscar produtos por nome ou categoria</span><input onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nome ou categoria" value={search} /></label>
        <div className="product-category-filters" role="group" aria-label="Filtrar produtos por uma categoria">
          <button aria-pressed={selectedCategoryId === 'all'} className={selectedCategoryId === 'all' ? 'is-active' : ''} onClick={() => setSelectedCategoryId('all')} type="button">Todos <span>{products.length}</span></button>
          {categories.map((category) => {
            const count = products.filter((product) => product.category_id === category.id).length
            return <button aria-pressed={selectedCategoryId === category.id} className={selectedCategoryId === category.id ? 'is-active' : ''} key={category.id} onClick={() => setSelectedCategoryId(category.id)} type="button">{category.name} <span>{count}</span></button>
          })}
          {products.some((product) => product.category_id === null) && <button aria-pressed={selectedCategoryId === 'uncategorized'} className={selectedCategoryId === 'uncategorized' ? 'is-active' : ''} onClick={() => setSelectedCategoryId('uncategorized')} type="button">Sem categoria <span>{products.filter((product) => product.category_id === null).length}</span></button>}
        </div>
        {loading && <p className="inline-state" aria-live="polite">Carregando produtos…</p>}
        {!loading && error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => { setLoading(true); void loadProducts() }} type="button">Tentar novamente</button></div>}
        {!loading && !error && products.length === 0 && <div className="module-empty-panel record-empty"><span className="empty-icon"><Icon name="box" /></span><h2>Nenhum produto cadastrado</h2><p>Cadastre o produto, a unidade e a quantidade atual. O estoque começa junto com o cadastro.</p><button className="button button-primary" onClick={startCreate} type="button">Cadastrar primeiro produto</button></div>}
        {!loading && !error && products.length > 0 && filteredProducts.length === 0 && <div className="inline-state"><p>Nenhum produto corresponde à busca ou categoria selecionada.</p><button className="text-button" onClick={() => { setSearch(''); setSelectedCategoryId('all') }} type="button">Limpar filtros</button></div>}
        {!loading && !error && filteredProducts.length > 0 && (
          <ul className="record-list product-list">
            {filteredProducts.map((product) => (
              <li className={product.is_active ? '' : 'record-inactive'} key={product.id}>
                <div className="product-row">
                  <span className="record-avatar">{product.image_url
                    ? <img alt={`Foto de ${product.name}`} onError={() => { if (product.image_path) void refreshProductPhoto(product.id, product.image_path) }} src={product.image_url} />
                    : <Icon name="box" />}</span>
                  <span className="record-list-copy"><strong>{product.name}</strong><small>{categoryNames.get(product.category_id ?? '') ?? 'Sem categoria'}{product.inventory_unit ? ' · ' + product.inventory_unit : ''}{product.is_combo ? '' : product.inventory_tracked ? ' · Estoque automático' : ' · Contagem inicial pendente'}</small></span>
                  <span className="product-price"><strong>{formatBRL(product.sale_price_cents)}</strong><small>{product.is_active ? 'Ativo' : 'Inativo'}</small></span>
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
