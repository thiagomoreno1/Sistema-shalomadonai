import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
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
  sale_price_cents: number | null
  cost_cents: number | null
  is_active: boolean
}

export function ProductsPage() {
  const { id: businessId } = useBusiness()
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [showCategoryForm, setShowCategoryForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [categoryError, setCategoryError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const loadProducts = useCallback(async () => {
    if (!supabaseClient) {
      setLoading(false)
      return false
    }
    try {
      const [productsResult, categoriesResult] = await Promise.all([
        supabaseClient.from('products')
          .select('id, name, description, category_id, inventory_unit, sale_price_cents, cost_cents, is_active')
          .eq('business_id', businessId).order('name', { ascending: true }),
        supabaseClient.from('product_categories')
          .select('id, name, is_active').eq('business_id', businessId)
          .eq('is_active', true).order('name', { ascending: true }),
      ])
      if (productsResult.error || categoriesResult.error) {
        setError('Não foi possível carregar o catálogo. Tente novamente.')
        return false
      } else {
        setProducts((productsResult.data ?? []) as Product[])
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
  }

  function startEdit(product: Product) {
    setNotice(null)
    setEditingProduct(product)
    setShowForm(true)
    setFormError(null)
  }

  async function handleSaveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const salePrice = parseBrazilianCurrency(String(form.get('sale_price') ?? ''))
    const cost = parseBrazilianCurrency(String(form.get('cost') ?? ''))
    const isActive = form.get('is_active') === 'on'
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

    const record = {
      name,
      description: String(form.get('description') ?? '').trim() || null,
      category_id: String(form.get('category_id') ?? '').trim() || null,
      inventory_unit: String(form.get('inventory_unit') ?? '').trim() || null,
      sale_price_cents: salePrice,
      cost_cents: cost,
      is_active: isActive,
    }
    setSaving(true)
    setFormError(null)
    try {
      const result = editingProduct
        ? await supabaseClient.from('products').update(record).eq('business_id', businessId).eq('id', editingProduct.id)
        : await supabaseClient.from('products').insert({ business_id: businessId, ...record })
      if (result.error) {
        setFormError('Não foi possível salvar. Seus dados continuam no formulário; tente novamente.')
        return
      }
      setShowForm(false)
      setEditingProduct(null)
      const refreshed = await loadProducts()
      setNotice(refreshed ? 'Produto salvo.' : 'Produto salvo. A lista não atualizou; use “Tentar novamente” para recarregar sem salvar de novo.')
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
  }

  const categoryNames = new Map(categories.map((category) => [category.id, category.name]))

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div><p className="eyebrow">CATÁLOGO</p><h1>Produtos</h1><p className="page-description">Cadastro básico de produtos e categorias para a operação.</p></div>
        <button className="button button-primary" onClick={startCreate} type="button"><Icon name="plus" /> Novo produto</button>
      </header>

      {notice && <p className="form-message form-message-success" role="status">{notice}</p>}

      <p className="section-footnote">Preços e custos são dados atuais do cadastro. Composição de combos e saldo de estoque ainda não estão configurados.</p>

      {showForm && (
        <form className="surface-panel record-form" onSubmit={handleSaveProduct}>
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">CADASTRO</p><h2>{editingProduct ? 'Editar produto' : 'Novo produto'}</h2></div><button className="text-button" onClick={cancelForm} type="button">Fechar</button></div>
          <div className="record-form-grid">
            <label className="record-field record-field-wide"><span className="field-label">Nome do produto <span aria-hidden="true">*</span></span><input autoFocus className="text-input" defaultValue={editingProduct?.name ?? ''} maxLength={160} name="name" required /></label>
            <label className="record-field"><span className="field-label">Categoria <span className="field-optional">opcional</span></span><select className="text-input" defaultValue={editingProduct?.category_id ?? ''} name="category_id"><option value="">Sem categoria</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <div className="record-field record-field-actions"><span className="field-label">Categorias</span><button className="text-button" onClick={() => { setShowCategoryForm((value) => !value); setCategoryError(null) }} type="button">{showCategoryForm ? 'Fechar categorias' : 'Cadastrar categoria'}</button></div>
            <label className="record-field"><span className="field-label">Unidade de estoque <span className="field-optional">opcional</span></span><input className="text-input" defaultValue={editingProduct?.inventory_unit ?? ''} maxLength={32} name="inventory_unit" placeholder="Ex.: un, kg" /></label>
            <label className="record-field"><span className="field-label">Preço de venda <span className="field-optional">R$</span></span><input className="text-input" defaultValue={editingProduct?.sale_price_cents === null || !editingProduct ? '' : (editingProduct.sale_price_cents / 100).toFixed(2).replace('.', ',')} inputMode="decimal" name="sale_price" placeholder="0,00" /></label>
            <label className="record-field"><span className="field-label">Custo atual <span className="field-optional">R$ · opcional</span></span><input className="text-input" defaultValue={editingProduct?.cost_cents === null || !editingProduct ? '' : (editingProduct.cost_cents / 100).toFixed(2).replace('.', ',')} inputMode="decimal" name="cost" placeholder="0,00" /></label>
            <label className="record-field record-field-wide"><span className="field-label">Descrição <span className="field-optional">opcional</span></span><textarea className="text-input record-textarea" defaultValue={editingProduct?.description ?? ''} maxLength={2000} name="description" rows={3} /></label>
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
        {!loading && !error && products.length === 0 && <div className="module-empty-panel record-empty"><span className="empty-icon"><Icon name="box" /></span><h2>Nenhum produto cadastrado</h2><p>Cadastre os itens do catálogo. Quantidades iniciais de estoque serão lançadas como movimentações em uma próxima etapa.</p><button className="button button-primary" onClick={startCreate} type="button">Cadastrar primeiro produto</button></div>}
        {!loading && !error && products.length > 0 && filteredProducts.length === 0 && <div className="inline-state"><p>Nenhum produto corresponde à busca.</p><button className="text-button" onClick={() => setSearch('')} type="button">Limpar busca</button></div>}
        {!loading && !error && filteredProducts.length > 0 && (
          <ul className="record-list product-list">
            {filteredProducts.map((product) => (
              <li className={product.is_active ? '' : 'record-inactive'} key={product.id}>
                <div className="product-row">
                  <span className="record-avatar"><Icon name="box" /></span>
                  <span className="record-list-copy"><strong>{product.name}</strong><small>{categoryNames.get(product.category_id ?? '') ?? 'Sem categoria'}{product.inventory_unit ? ` · ${product.inventory_unit}` : ''}</small></span>
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
