import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { supabaseClient } from '../lib/supabase'

type Customer = {
  id: string
  name: string
  phone: string | null
  delivery_address: string | null
  notes: string | null
  created_at: string
  is_active: boolean
}

export function CustomersPage() {
  const { id: businessId } = useBusiness()
  const navigate = useNavigate()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const loadCustomers = useCallback(async () => {
    if (!supabaseClient) {
      setLoading(false)
      return
    }
    try {
      const { data, error: queryError } = await supabaseClient
        .from('customers')
        .select('id, name, phone, delivery_address, notes, created_at, is_active')
        .eq('business_id', businessId)
        .eq('is_active', !showArchived)
        .order('name', { ascending: true })

      if (queryError) {
        setError('Não foi possível carregar os clientes. Tente novamente.')
      } else {
        setCustomers((data ?? []) as Customer[])
        setError(null)
      }
    } catch {
      setError('Não foi possível carregar os clientes. Tente novamente.')
    } finally {
      setLoading(false)
    }
  }, [businessId, showArchived])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadCustomers() }, [loadCustomers])

  const filteredCustomers = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('pt-BR')
    if (!needle) return customers
    return customers.filter((customer) =>
      `${customer.name} ${customer.phone ?? ''}`.toLocaleLowerCase('pt-BR').includes(needle),
    )
  }, [customers, search])

  async function handleCreateCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    if (!name) {
      setSaveError('Informe o nome do cliente.')
      return
    }

    setSaving(true)
    setSaveError(null)
    try {
      const { data, error: insertError } = await supabaseClient
        .from('customers')
        .insert({
          business_id: businessId,
          name,
          phone: String(form.get('phone') ?? '').trim() || null,
          delivery_address: String(form.get('delivery_address') ?? '').trim() || null,
          notes: String(form.get('notes') ?? '').trim() || null,
        })
        .select('id')
        .single()

      if (insertError || !data) {
        setSaveError('Não foi possível salvar. Seus dados continuam no formulário; tente novamente.')
        return
      }
      navigate(`/clientes/${data.id}`)
    } catch {
      setSaveError('Não foi possível salvar. Seus dados continuam no formulário; tente novamente.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">RELACIONAMENTO</p>
          <h1>Clientes</h1>
          <p className="page-description">Cadastros, contatos e histórico de relacionamento.</p>
        </div>
        <button className="button button-primary" onClick={() => { setShowForm((value) => !value); setSaveError(null) }} type="button">
          <Icon name="plus" /> {showForm ? 'Fechar' : 'Novo cliente'}
        </button>
      </header>

      {showForm && (
        <form className="surface-panel record-form" onSubmit={handleCreateCustomer}>
          <div className="section-heading section-heading-compact">
            <div><p className="eyebrow">CADASTRO RÁPIDO</p><h2>Novo cliente</h2></div>
          </div>
          <div className="record-form-grid">
            <label className="record-field record-field-wide">
              <span className="field-label">Nome <span aria-hidden="true">*</span></span>
              <input autoFocus className="text-input" maxLength={160} name="name" required />
            </label>
            <label className="record-field">
              <span className="field-label">Telefone <span className="field-optional">opcional</span></span>
              <input autoComplete="tel" className="text-input" maxLength={64} name="phone" type="tel" />
            </label>
            <label className="record-field record-field-wide">
              <span className="field-label">Endereço de entrega <span className="field-optional">opcional</span></span>
              <input className="text-input" maxLength={1000} name="delivery_address" />
            </label>
            <label className="record-field record-field-wide">
              <span className="field-label">Observações <span className="field-optional">opcional</span></span>
              <textarea className="text-input record-textarea" maxLength={4000} name="notes" rows={3} />
            </label>
          </div>
          {saveError && <p className="form-message form-message-error" role="alert">{saveError}</p>}
          <div className="record-form-actions">
            <button className="button button-primary" disabled={saving} type="submit">{saving ? 'Salvando…' : 'Salvar cliente'}</button>
            <p className="section-footnote">Nome obrigatório. Telefone e endereço podem ser preenchidos depois.</p>
          </div>
        </form>
      )}

      <section className="surface-panel record-panel" aria-labelledby="customer-list-title">
        <div className="section-heading section-heading-compact">
          <div><p className="eyebrow">CADASTROS</p><h2 id="customer-list-title">{showArchived ? 'Clientes arquivados' : 'Clientes ativos'}</h2></div>
          <div className="record-heading-actions"><span className="neutral-status">{customers.length} {customers.length === 1 ? 'cadastro' : 'cadastros'}</span><button className="text-button" onClick={() => { setLoading(true); setError(null); setShowArchived((value) => !value) }} type="button">{showArchived ? 'Ver ativos' : 'Ver arquivados'}</button></div>
        </div>
        <label className="search-field">
          <Icon name="search" />
          <span className="visually-hidden">Buscar clientes por nome ou telefone</span>
          <input onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nome ou telefone" value={search} />
        </label>

        {loading ? <p className="inline-state" aria-live="polite">Carregando clientes…</p> : null}
        {!loading && error && (
          <div className="inline-state inline-state-error" role="alert">
            <p>{error}</p><button className="text-button" onClick={() => { setLoading(true); void loadCustomers() }} type="button">Tentar novamente</button>
          </div>
        )}
        {!loading && !error && customers.length === 0 && (
          <div className="module-empty-panel record-empty">
            <span className="empty-icon"><Icon name="people" /></span>
            <h2>{showArchived ? 'Nenhum cliente arquivado' : 'Nenhum cliente cadastrado'}</h2>
            <p>{showArchived ? 'Clientes arquivados preservam o histórico e podem ser reativados na ficha.' : 'Comece pelo nome. Telefone, endereço e observações podem ser adicionados depois.'}</p>
            {!showArchived && <button className="button button-primary" onClick={() => setShowForm(true)} type="button">Cadastrar primeiro cliente</button>}
          </div>
        )}
        {!loading && !error && customers.length > 0 && filteredCustomers.length === 0 && (
          <div className="inline-state"><p>Nenhum cliente corresponde à busca.</p><button className="text-button" onClick={() => setSearch('')} type="button">Limpar busca</button></div>
        )}
        {!loading && !error && filteredCustomers.length > 0 && (
          <ul className="record-list">
            {filteredCustomers.map((customer) => (
              <li key={customer.id}>
                <Link className="record-list-link" to={`/clientes/${customer.id}`}>
                  <span className="record-avatar" aria-hidden="true">{customer.name.slice(0, 1).toLocaleUpperCase('pt-BR')}</span>
                  <span className="record-list-copy"><strong>{customer.name}</strong><small>{customer.phone || 'Telefone não informado'}{customer.is_active ? '' : ' · Arquivado'}</small></span>
                  <Icon className="quick-link-arrow" name="arrow" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
