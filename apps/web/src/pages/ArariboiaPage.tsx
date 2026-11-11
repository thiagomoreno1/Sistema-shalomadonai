import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { canManageBusiness, useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { businessToday, formatBRL, formatBusinessDate } from '../lib/formatters'
import { isArariboiaPaymentMethod } from '../lib/arariboia'
import { supabaseClient } from '../lib/supabase'
import './ArariboiaPage.css'

type Customer = {
  id: string
  name: string
  phone: string | null
  is_active: boolean
  arariboia_limit_cents: number | null
}

type Order = { id: string; customer_id: string }
type Installment = {
  id: string
  order_id: string
  installment_number: number
  amount_cents: number
  due_on: string
  payment_method: string | null
}
type Allocation = { installment_id: string; amount_cents: number }
type OpenInstallment = Installment & { balance_cents: number }
type CustomerAccount = Customer & { open_cents: number; installments: OpenInstallment[] }
type PageResponse = { data: unknown[] | null; error: unknown | null }

async function loadAllPages<T>(loadPage: (from: number, to: number) => PromiseLike<PageResponse>) {
  const rows: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await loadPage(from, from + 999)
    if (error) return { data: null, error }
    const page = (data ?? []) as T[]
    rows.push(...page)
    if (page.length < 1000) return { data: rows, error: null }
  }
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

function formatOrderReference(orderId: string) {
  return `#${orderId.slice(0, 8).toLocaleUpperCase('pt-BR')}`
}

export function ArariboiaPage() {
  const { id: businessId, role } = useBusiness()
  const canViewAccounts = canManageBusiness(role)
  const today = businessToday()
  const [accounts, setAccounts] = useState<CustomerAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const loadAccounts = useCallback(async () => {
    if (!canViewAccounts) {
      setAccounts([])
      setLoading(false)
      return
    }
    const client = supabaseClient
    if (!client) {
      setError('Não foi possível conectar ao sistema.')
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const customerResult = await loadAllPages<Customer>((from, to) => client.from('customers')
        .select('id, name, phone, is_active, arariboia_limit_cents')
        .eq('business_id', businessId)
        .eq('is_arariboia', true)
        .order('name', { ascending: true })
        .range(from, to))
      if (customerResult.error) throw new Error('Não foi possível carregar os clientes Arariboia.')
      const customers = customerResult.data ?? []
      if (customers.length === 0) {
        setAccounts([])
        return
      }

      const customerIds = customers.map((customer) => customer.id)
      const orders: Order[] = []
      for (const customerIdChunk of chunks(customerIds, 100)) {
        const result = await loadAllPages<Order>((from, to) => client.from('orders')
          .select('id, customer_id')
          .eq('business_id', businessId)
          .eq('status', 'open')
          .in('customer_id', customerIdChunk)
          .order('id', { ascending: true })
          .range(from, to))
        if (result.error) throw new Error('Não foi possível carregar os pedidos Arariboia.')
        orders.push(...(result.data ?? []))
      }

      const orderIds = orders.map((order) => order.id)
      const installments: Installment[] = []
      const allocations: Allocation[] = []
      for (const orderIdChunk of chunks(orderIds, 100)) {
        const [installmentResult, allocationResult] = await Promise.all([
          loadAllPages<Installment>((from, to) => client.from('order_installments')
            .select('id, order_id, installment_number, amount_cents, due_on, payment_method')
            .eq('business_id', businessId)
            .in('order_id', orderIdChunk)
            .order('due_on', { ascending: true })
            .order('installment_number', { ascending: true })
            .range(from, to)),
          loadAllPages<Allocation>((from, to) => client.from('order_payment_allocations')
            .select('installment_id, amount_cents')
            .eq('business_id', businessId)
            .in('order_id', orderIdChunk)
            .order('id', { ascending: true })
            .range(from, to)),
        ])
        if (installmentResult.error || allocationResult.error) throw new Error('Não foi possível carregar os vencimentos Arariboia.')
        installments.push(...(installmentResult.data ?? []))
        allocations.push(...(allocationResult.data ?? []))
      }

      const arariboiaOrderById = new Map(orders.map((order) => [order.id, order]))
      const paidByInstallment = new Map<string, number>()
      for (const allocation of allocations) {
        paidByInstallment.set(allocation.installment_id, (paidByInstallment.get(allocation.installment_id) ?? 0) + Number(allocation.amount_cents))
      }

      const installmentsByCustomer = new Map<string, OpenInstallment[]>()
      for (const installment of installments) {
        if (!isArariboiaPaymentMethod(installment.payment_method)) continue
        const customerId = arariboiaOrderById.get(installment.order_id)?.customer_id
        if (!customerId) continue
        const balance = Math.max(0, Number(installment.amount_cents) - (paidByInstallment.get(installment.id) ?? 0))
        if (!Number.isSafeInteger(balance) || balance <= 0) continue
        const items = installmentsByCustomer.get(customerId) ?? []
        items.push({ ...installment, amount_cents: Number(installment.amount_cents), balance_cents: balance })
        installmentsByCustomer.set(customerId, items)
      }

      const customerAccounts = customers.map((customer) => {
        const openInstallments = installmentsByCustomer.get(customer.id) ?? []
        return {
          ...customer,
          arariboia_limit_cents: customer.arariboia_limit_cents === null ? null : Number(customer.arariboia_limit_cents),
          open_cents: openInstallments.reduce((total, item) => total + item.balance_cents, 0),
          installments: openInstallments,
        }
      })
      // An archived customer should stay visible here while there is still
      // an amount to collect; hiding them would also hide an open balance.
      setAccounts(customerAccounts.filter((customer) => customer.is_active || customer.open_cents > 0))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível carregar os dados Arariboia.')
    } finally {
      setLoading(false)
    }
  }, [businessId, canViewAccounts])

  useEffect(() => { void loadAccounts() }, [loadAccounts])

  const filteredAccounts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('pt-BR')
    if (!query) return accounts
    return accounts.filter((account) => `${account.name} ${account.phone ?? ''}`.toLocaleLowerCase('pt-BR').includes(query))
  }, [accounts, search])

  const totals = useMemo(() => accounts.reduce((result, account) => {
    result.limitCount += account.arariboia_limit_cents === null ? 0 : 1
    result.limits += account.arariboia_limit_cents ?? 0
    result.open += account.open_cents
    if (account.arariboia_limit_cents !== null) result.available += account.arariboia_limit_cents - account.open_cents
    result.overdueCount += account.installments.filter((item) => item.due_on < today).length
    return result
  }, { limits: 0, open: 0, available: 0, limitCount: 0, overdueCount: 0 }), [accounts, today])

  return (
    <div className="page-stack arariboia-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">CLIENTES</p>
          <h1>Arariboia</h1>
          <p className="page-description">Limites, valores em aberto e próximos vencimentos.</p>
        </div>
        <div className="record-heading-actions">
          <Link className="button button-secondary" to="/clientes">Voltar aos clientes</Link>
          {canViewAccounts && <button className="button button-secondary" disabled={loading} onClick={() => void loadAccounts()} type="button">Atualizar</button>}
        </div>
      </header>

      {canViewAccounts && <section className="arariboia-summary" aria-label="Resumo Arariboia" aria-live="polite">
        <article className="surface-panel arariboia-summary-card"><span>Clientes</span><strong>{loading ? '—' : accounts.length}</strong></article>
        <article className="surface-panel arariboia-summary-card"><span>Limite cadastrado</span><strong>{loading ? '—' : formatBRL(totals.limits)}</strong><small>{totals.limitCount} com limite definido</small></article>
        <article className="surface-panel arariboia-summary-card"><span>Em aberto</span><strong className={totals.open > 0 ? 'arariboia-positive' : 'arariboia-neutral'}>{loading ? '—' : formatBRL(totals.open)}</strong><small>{totals.overdueCount} parcelas atrasadas</small></article>
        <article className="surface-panel arariboia-summary-card"><span>Limite disponível</span><strong className={totals.available < 0 ? 'arariboia-negative' : 'arariboia-positive'}>{loading ? '—' : totals.limitCount ? formatBRL(totals.available) : '—'}</strong><small>{totals.limitCount ? 'Limites menos valores em aberto' : 'Defina um limite no cadastro'}</small></article>
      </section>}

      {!canViewAccounts && <div className="inline-state" role="status">Esta área é exclusiva da gestão.</div>}

      {canViewAccounts && <section className="surface-panel record-panel" aria-labelledby="arariboia-list-title">
        <div className="section-heading section-heading-compact">
          <div><p className="eyebrow">CLIENTES</p><h2 id="arariboia-list-title">Clientes Arariboia</h2></div>
          <span className="neutral-status">{loading ? 'Carregando…' : `${filteredAccounts.length} clientes`}</span>
        </div>
        <label className="search-field arariboia-search"><Icon name="search" /><span className="visually-hidden">Buscar cliente Arariboia</span><input onChange={(event) => setSearch(event.target.value)} placeholder="Buscar cliente" value={search} /></label>
        {loading && <p className="inline-state" aria-live="polite">Carregando contas…</p>}
        {error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => void loadAccounts()} type="button">Tentar novamente</button></div>}
        {!loading && !error && accounts.length === 0 && <div className="module-empty-panel record-empty"><span className="empty-icon"><Icon name="coin" /></span><h2>Nenhum cliente Arariboia</h2><p>Ative Arariboia no cadastro do cliente para acompanhar limite e vencimentos.</p><Link className="button button-primary" to="/clientes">Abrir clientes</Link></div>}
        {!loading && !error && accounts.length > 0 && filteredAccounts.length === 0 && <p className="inline-state">Nenhum cliente encontrado.</p>}
        {!loading && !error && filteredAccounts.length > 0 && (
          <div className="arariboia-table-wrap">
            <table className="arariboia-table">
              <caption className="visually-hidden">Limites e valores em aberto dos clientes Arariboia</caption>
              <thead><tr><th scope="col">Cliente</th><th scope="col">Limite</th><th scope="col">Em aberto</th><th scope="col">Disponível</th><th scope="col">Próximo vencimento</th><th scope="col">Detalhes</th></tr></thead>
              <tbody>{filteredAccounts.map((account) => {
                const available = account.arariboia_limit_cents === null ? null : account.arariboia_limit_cents - account.open_cents
                const nextInstallment = [...account.installments].sort((left, right) => left.due_on.localeCompare(right.due_on))[0]
                const overdue = account.installments.some((item) => item.due_on < today)
                return <tr key={account.id}>
                  <td data-label="Cliente"><Link className="arariboia-customer" to={`/clientes/${account.id}`}><span className="record-avatar" aria-hidden="true">{account.name.slice(0, 1).toLocaleUpperCase('pt-BR')}</span><span><strong>{account.name}</strong><small>{account.phone || 'Sem telefone'}{!account.is_active && ' · Arquivado'}</small></span></Link></td>
                  <td data-label="Limite" className="arariboia-money">{account.arariboia_limit_cents === null ? 'Não definido' : formatBRL(account.arariboia_limit_cents)}</td>
                  <td data-label="Em aberto" className={`arariboia-money${account.open_cents > 0 ? ' arariboia-positive' : ' arariboia-neutral'}`}>{formatBRL(account.open_cents)}</td>
                  <td data-label="Disponível" className={`arariboia-money${available === null ? '' : available < 0 ? ' arariboia-negative' : ' arariboia-positive'}`}>{available === null ? '—' : formatBRL(available)}</td>
                  <td data-label="Próximo vencimento">{nextInstallment ? <span className={overdue ? 'arariboia-negative' : ''}>{formatBusinessDate(nextInstallment.due_on)}{overdue && <small className="arariboia-due-label">Atrasado</small>}</span> : 'Em dia'}</td>
                  <td data-label="Detalhes">{account.installments.length > 0 ? <details className="arariboia-details"><summary>Ver parcelas ({account.installments.length})</summary><div className="arariboia-installments">{account.installments.map((item) => <div className="arariboia-installment" key={item.id}><span><strong>{formatBusinessDate(item.due_on)}</strong><small>Parcela {item.installment_number} · pedido {formatOrderReference(item.order_id)}</small></span><strong className={item.due_on < today ? 'arariboia-negative' : ''}>{formatBRL(item.balance_cents)}</strong><Link to={`/pedidos/${item.order_id}`}>Abrir</Link></div>)}</div></details> : <span className="arariboia-muted">Sem valores em aberto</span>}</td>
                </tr>
              })}</tbody>
            </table>
          </div>
        )}
      </section>}
    </div>
  )
}
