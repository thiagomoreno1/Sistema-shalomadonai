import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { formatBRL, formatBusinessDate, businessToday } from '../lib/formatters'
import { supabaseClient } from '../lib/supabase'

type Order = { id: string; customer_name_snapshot: string; status: 'open' | 'cancelled' }
type Installment = { id: string; order_id: string; installment_number: number; amount_cents: number; due_on: string }
type Allocation = { id: string; order_id: string; installment_id: string; amount_cents: number }
type Receivable = Installment & { customer_name: string; balance_cents: number; overdue: boolean }
type PageResponse = { data: unknown[] | null; error: unknown }

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

function groupTotal(items: Receivable[]) {
  return items.reduce((total, item) => total + item.balance_cents, 0)
}

export function ReceivablesPage() {
  const { id: businessId } = useBusiness()
  const [receivables, setReceivables] = useState<Receivable[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const today = businessToday()

  const loadReceivables = useCallback(async () => {
    const client = supabaseClient
    if (!client) {
      setError('A conexão da empresa não está disponível.')
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const ordersResult = await loadAllPages<Order>((from, to) => client.from('orders')
        .select('id, customer_name_snapshot, status')
        .eq('business_id', businessId)
        .eq('status', 'open')
        .order('id', { ascending: true })
        .range(from, to))
      if (ordersResult.error) {
        setError('Não foi possível carregar as contas a receber. Tente novamente.')
        return
      }

      const orders = ordersResult.data ?? []
      const orderIds = orders.map((order) => order.id)
      if (orderIds.length === 0) {
        setReceivables([])
        setError(null)
        return
      }

      const loadedInstallments: Installment[] = []
      const loadedAllocations: Allocation[] = []
      for (let start = 0; start < orderIds.length; start += 100) {
        const orderIdBatch = orderIds.slice(start, start + 100)
        const [installmentsResult, allocationsResult] = await Promise.all([
          loadAllPages<Installment>((from, to) => client.from('order_installments')
            .select('id, order_id, installment_number, amount_cents, due_on')
            .eq('business_id', businessId)
            .in('order_id', orderIdBatch)
            .order('id', { ascending: true })
            .range(from, to)),
          loadAllPages<Allocation>((from, to) => client.from('order_payment_allocations')
            .select('id, order_id, installment_id, amount_cents')
            .eq('business_id', businessId)
            .in('order_id', orderIdBatch)
            .order('installment_id', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to)),
        ])
        if (installmentsResult.error || allocationsResult.error) {
          setError('Não foi possível carregar todos os vencimentos e seus saldos. Tente novamente.')
          return
        }
        loadedInstallments.push(...(installmentsResult.data ?? []))
        loadedAllocations.push(...(allocationsResult.data ?? []))
      }

      const customerByOrder = new Map(orders.map((order) => [order.id, order.customer_name_snapshot]))
      const paidByInstallment = new Map<string, number>()
      for (const allocation of loadedAllocations) {
        paidByInstallment.set(allocation.installment_id, (paidByInstallment.get(allocation.installment_id) ?? 0) + allocation.amount_cents)
      }

      const nextReceivables = loadedInstallments
        .map((installment) => ({
          ...installment,
          customer_name: customerByOrder.get(installment.order_id) ?? 'Cliente não disponível',
          balance_cents: Math.max(0, installment.amount_cents - (paidByInstallment.get(installment.id) ?? 0)),
          overdue: installment.due_on < today,
        }))
        .filter((installment) => installment.balance_cents > 0)
        .sort((left, right) => left.due_on.localeCompare(right.due_on) || left.customer_name.localeCompare(right.customer_name, 'pt-BR'))

      setReceivables(nextReceivables)
      setError(null)
    } catch {
      setError('Não foi possível carregar as contas a receber. Tente novamente.')
    } finally {
      setLoading(false)
    }
  }, [businessId, today])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadReceivables() }, [loadReceivables])

  const overdue = useMemo(() => receivables.filter((item) => item.due_on < today), [receivables, today])
  const dueToday = useMemo(() => receivables.filter((item) => item.due_on === today), [receivables, today])
  const upcoming = useMemo(() => receivables.filter((item) => item.due_on > today), [receivables, today])

  function renderGroup(items: Receivable[], emptyText: string) {
    if (items.length === 0) return <p className="inline-state">{emptyText}</p>
    return (
      <ul className="receivable-list">
        {items.map((item) => (
          <li key={item.id}>
            <Link to={`/pedidos/${item.order_id}`} className="receivable-link">
              <span className={`receivable-date ${item.overdue ? 'receivable-date-overdue' : ''}`}>
                <strong>{formatBusinessDate(item.due_on)}</strong>
                <small>Vencimento {item.installment_number}</small>
              </span>
              <span className="receivable-customer"><strong>{item.customer_name}</strong><small className={item.overdue ? 'receivable-overdue-label' : undefined}>{item.overdue ? 'Vencido' : item.due_on === today ? 'Vence hoje' : 'A vencer'}</small></span>
              <span className="receivable-balance"><small>Saldo do vencimento</small><strong>{formatBRL(item.balance_cents)}</strong></span>
            </Link>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">FINANCEIRO · PEDIDOS</p>
          <h1>Contas a receber</h1>
          <p className="page-description">Saldos de vencimentos informados manualmente em pedidos ativos.</p>
        </div>
        <Link className="button button-secondary" to="/pedidos">Ver pedidos</Link>
      </header>

      <p className="section-footnote order-policy-note">Atraso é calculado quando a data informada já passou e ainda há saldo. Nenhum juro, lembrete ou mensagem é gerado automaticamente.</p>

      {!loading && !error && <section className="receivable-summary-grid" aria-label="Resumo das contas a receber">
        <article className="surface-panel receivable-summary-card"><span>Saldo vencido</span><strong>{formatBRL(groupTotal(overdue))}</strong><small>{overdue.length} vencimentos</small></article>
        <article className="surface-panel receivable-summary-card"><span>Vence hoje</span><strong>{formatBRL(groupTotal(dueToday))}</strong><small>{dueToday.length} vencimentos</small></article>
        <article className="surface-panel receivable-summary-card"><span>A vencer</span><strong>{formatBRL(groupTotal(upcoming))}</strong><small>{upcoming.length} vencimentos</small></article>
      </section>}

      {error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => void loadReceivables()} type="button">Tentar novamente</button></div>}

      {loading ? <p className="inline-state" aria-live="polite">Carregando vencimentos…</p> : !error && (
        <div className="page-stack receivable-groups">
          <section className="surface-panel record-panel" aria-labelledby="receivable-overdue-heading">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">PRIORIDADE</p><h2 id="receivable-overdue-heading">Vencidos</h2></div><span className="neutral-status">{overdue.length}</span></div>
            {renderGroup(overdue, 'Nenhum vencimento em atraso.')}
          </section>
          <section className="surface-panel record-panel" aria-labelledby="receivable-today-heading">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">HOJE</p><h2 id="receivable-today-heading">Vencem hoje</h2></div><span className="neutral-status">{dueToday.length}</span></div>
            {renderGroup(dueToday, 'Nenhum vencimento para hoje.')}
          </section>
          <section className="surface-panel record-panel" aria-labelledby="receivable-upcoming-heading">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">AGENDA</p><h2 id="receivable-upcoming-heading">Próximos vencimentos</h2></div><span className="neutral-status">{upcoming.length}</span></div>
            {renderGroup(upcoming, 'Nenhum vencimento futuro em aberto.')}
          </section>
          {receivables.length === 0 && <p className="section-footnote">Despesas, caixa, conciliação e resultado gerencial continuam pendentes das regras e fontes de dados da próxima etapa.</p>}
        </div>
      )}
    </div>
  )
}
