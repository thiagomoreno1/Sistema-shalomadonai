import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { ReportsNavigation } from '../components/ReportsNavigation'
import { businessLocalDateTimeToIso, formatBRLExact, formatBusinessDate } from '../lib/formatters'
import { useBusinessToday } from '../lib/useBusinessToday'
import { supabaseClient } from '../lib/supabase'

type PeriodMode = 'week' | 'month' | 'year' | 'custom'
type OrderRow = {
  id: string
  customer_name_snapshot: string
  total_cents: number | string
  status: 'open' | 'cancelled'
  created_at: string
  requires_delivery: boolean
  fulfillment_status?: string | null
}
type DeliveryRow = { id: string; status: string }
type RecentDeliveryRow = { order_id: string; status: string }
type Overview = {
  orderCount: number
  cancelledOrderCount: number
  completedDeliveryCount: number
  pickupCount: number
  newCustomerCount: number
  failedAttemptCount: number
  deliveries: DeliveryRow[]
  orders: OrderRow[]
}

function nextDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

function mondayOf(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  const offset = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - offset)
  return date.toISOString().slice(0, 10)
}

function rangeTimestamps(startOn: string, endOn: string) {
  const startAt = businessLocalDateTimeToIso(`${startOn}T00:00`)
  const endAt = businessLocalDateTimeToIso(`${nextDate(endOn)}T00:00`)
  if (!startAt || !endAt) throw new Error('O período informado não contém datas válidas.')
  return { startAt, endAt }
}

async function loadAllDeliveryStatuses(businessId: string, startAt: string, endAt: string) {
  if (!supabaseClient) throw new Error('A conexão da empresa não está disponível.')
  const deliveries: DeliveryRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabaseClient.from('deliveries').select('id, status').eq('business_id', businessId).is('canceled_at', null).gte('created_at', startAt).lt('created_at', endAt).order('created_at', { ascending: false }).range(from, from + 999)
    if (error) throw error
    const page = (data ?? []) as DeliveryRow[]
    deliveries.push(...page)
    if (page.length < 1000) return deliveries
    from += page.length
  }
}

function deliveryStatusLabel(status: string) {
  const labels: Record<string, string> = {
    awaiting_separation: 'Aguardando separação',
    ready: 'Pronta para sair',
    dispatched: 'Em rota',
    delivered: 'Concluída',
    attempted: 'Tentativa sem sucesso',
    rescheduled: 'Reagendada',
    returned: 'Retornada',
  }
  return labels[status] ?? 'Em andamento'
}

function businessDateFromTimestamp(value: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function reportOrderStatus(order: OrderRow) {
  if (order.status === 'cancelled') return 'Cancelado'
  if (order.fulfillment_status === 'picked_up') return 'Retirado'
  const deliveryStatus = order.fulfillment_status
  if (deliveryStatus === 'delivered') return 'Entregue'
  if (deliveryStatus === 'dispatched') return 'Em rota'
  if (deliveryStatus === 'attempted') return 'Tentativa sem sucesso'
  if (deliveryStatus === 'ready') return 'Pronto para sair'
  if (deliveryStatus === 'awaiting_separation') return 'Aguardando separação'
  if (deliveryStatus === 'rescheduled') return 'Reagendada'
  if (deliveryStatus === 'returned') return 'Retornada'
  return 'Em andamento'
}

export function ReportsPage() {
  const { id: businessId } = useBusiness()
  const today = useBusinessToday()
  const firstDayOfMonth = `${today.slice(0, 7)}-01`
  const firstDayOfYear = `${today.slice(0, 4)}-01-01`
  const [periodMode, setPeriodMode] = useState<PeriodMode>('month')
  const [customStartOverride, setCustomStartOverride] = useState<string | null>(null)
  const [customEndOverride, setCustomEndOverride] = useState<string | null>(null)
  const customStart = customStartOverride ?? firstDayOfMonth
  const customEnd = customEndOverride ?? today
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  const { startOn, endOn } = useMemo(() => {
    if (periodMode === 'week') return { startOn: mondayOf(today), endOn: today }
    if (periodMode === 'month') return { startOn: firstDayOfMonth, endOn: today }
    if (periodMode === 'year') return { startOn: firstDayOfYear, endOn: today }
    return { startOn: customStart, endOn: customEnd }
  }, [customEnd, customStart, firstDayOfMonth, firstDayOfYear, periodMode, today])
  const rangeError = periodMode === 'custom'
    ? !customStart || !customEnd ? 'Informe as duas datas do intervalo.' : customEnd < customStart ? 'A data final deve ser igual ou posterior à data inicial.' : null
    : null

  const loadOverview = useCallback(async () => {
    const currentRequestId = requestId.current + 1
    requestId.current = currentRequestId
    if (!supabaseClient) {
      setError('A conexão da empresa não está disponível.')
      setLoading(false)
      return
    }
    if (rangeError || !startOn || !endOn || endOn < startOn) {
      setOverview(null)
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const { startAt, endAt } = rangeTimestamps(startOn, endOn)
      const client = supabaseClient
      const [ordersCountResult, cancelledCountResult, customerCountResult, completedDeliveriesResult, pickupsResult, failedAttemptsResult, deliveries, ordersResult] = await Promise.all([
        client.from('orders').select('id', { count: 'exact', head: true }).eq('business_id', businessId).gte('created_at', startAt).lt('created_at', endAt),
        client.from('orders').select('id', { count: 'exact', head: true }).eq('business_id', businessId).eq('status', 'cancelled').gte('cancelled_at', startAt).lt('cancelled_at', endAt),
        client.from('customers').select('id', { count: 'exact', head: true }).eq('business_id', businessId).gte('created_at', startAt).lt('created_at', endAt),
        client.from('deliveries').select('id', { count: 'exact', head: true }).eq('business_id', businessId).eq('status', 'delivered').is('canceled_at', null).gte('delivered_at', startAt).lt('delivered_at', endAt),
        client.from('order_events').select('id', { count: 'exact', head: true }).eq('business_id', businessId).eq('event_type', 'picked_up').gte('occurred_at', startAt).lt('occurred_at', endAt),
        client.from('delivery_events').select('id', { count: 'exact', head: true }).eq('business_id', businessId).eq('to_status', 'attempted').gte('occurred_at', startAt).lt('occurred_at', endAt),
        loadAllDeliveryStatuses(businessId, startAt, endAt),
        client.from('orders').select('id, customer_name_snapshot, total_cents, status, created_at, requires_delivery').eq('business_id', businessId).gte('created_at', startAt).lt('created_at', endAt).order('created_at', { ascending: false }).limit(12),
      ])
      if (requestId.current !== currentRequestId) return
      const failed = [ordersCountResult, cancelledCountResult, customerCountResult, completedDeliveriesResult, pickupsResult, failedAttemptsResult, ordersResult].find((result) => result.error)
      if (failed?.error) throw failed.error
      const recentOrders = (ordersResult.data ?? []) as OrderRow[]
      const recentOrderIds = recentOrders.map((order) => order.id)
      const [recentDeliveriesResult, recentPickupsResult] = recentOrderIds.length > 0 ? await Promise.all([
        client.from('deliveries').select('order_id, status').eq('business_id', businessId).is('canceled_at', null).in('order_id', recentOrderIds),
        client.from('order_events').select('order_id').eq('business_id', businessId).eq('event_type', 'picked_up').in('order_id', recentOrderIds),
      ]) : [{ data: [], error: null }, { data: [], error: null }]
      if (requestId.current !== currentRequestId) return
      if (recentDeliveriesResult.error || recentPickupsResult.error) throw recentDeliveriesResult.error ?? recentPickupsResult.error
      const fulfillmentStatusByOrder = new Map<string, string>((recentDeliveriesResult.data as RecentDeliveryRow[] | null ?? []).map((delivery) => [delivery.order_id, delivery.status]))
      for (const pickup of recentPickupsResult.data ?? []) fulfillmentStatusByOrder.set(pickup.order_id, 'picked_up')
      setOverview({
        orderCount: ordersCountResult.count ?? 0,
        cancelledOrderCount: cancelledCountResult.count ?? 0,
        newCustomerCount: customerCountResult.count ?? 0,
        completedDeliveryCount: completedDeliveriesResult.count ?? 0,
        pickupCount: pickupsResult.count ?? 0,
        failedAttemptCount: failedAttemptsResult.count ?? 0,
        deliveries,
        orders: recentOrders.map((order) => ({ ...order, fulfillment_status: fulfillmentStatusByOrder.get(order.id) ?? null })),
      })
    } catch {
      if (requestId.current === currentRequestId) {
        setOverview(null)
        setError('Não foi possível montar o relatório geral. Tente novamente.')
      }
    } finally {
      if (requestId.current === currentRequestId) setLoading(false)
    }
  }, [businessId, endOn, rangeError, startOn])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void loadOverview()
    return () => { requestId.current += 1 }
  }, [loadOverview])

  const totals = overview ? [
    { label: 'Pedidos criados', value: overview.orderCount, note: 'Criados no período' },
    { label: 'Pedidos cancelados', value: overview.cancelledOrderCount, note: 'Cancelados no período' },
    { label: 'Entregas concluídas', value: overview.completedDeliveryCount, note: 'Concluídas dentro do período' },
    { label: 'Retiradas registradas', value: overview.pickupCount, note: 'Pedidos retirados pelo cliente' },
    { label: 'Novos clientes', value: overview.newCustomerCount, note: 'Cadastros feitos no período' },
    { label: 'Tentativas de entrega sem sucesso', value: overview.failedAttemptCount, note: 'Ocorrências registradas no período' },
  ] : []
  const deliveryCounts = overview?.deliveries.reduce<Record<string, number>>((counts, delivery) => {
    counts[delivery.status] = (counts[delivery.status] ?? 0) + 1
    return counts
  }, {}) ?? {}

  return (
    <div className="page-stack report-page">
      <ReportsNavigation active="general" />
      <header className="page-heading">
        <div>
          <p className="eyebrow">RELATÓRIO DO SISTEMA</p>
          <h1>Relatório geral</h1>
          <p className="page-description">Pedidos, entregas e clientes no período.</p>
        </div>
        <button className="button button-secondary report-actions" disabled={loading || !overview} onClick={() => window.print()} type="button">Imprimir</button>
      </header>
      <p className="report-print-range">Período: {startOn && endOn ? `${formatBusinessDate(startOn)} a ${formatBusinessDate(endOn)}` : 'Datas pendentes'} · horário de Brasília</p>

      <section className="surface-panel record-panel report-period-panel" aria-label="Período do relatório">
        <div className="report-period-controls">
          <label className="record-field"><span className="field-label">Período</span><select className="text-input" onChange={(event) => setPeriodMode(event.target.value as PeriodMode)} value={periodMode}><option value="week">Esta semana</option><option value="month">Este mês</option><option value="year">Este ano</option><option value="custom">Intervalo personalizado</option></select></label>
          {periodMode === 'custom' && <>
            <label className="record-field"><span className="field-label">De</span><input aria-describedby={rangeError ? 'overview-period-error' : undefined} aria-invalid={Boolean(rangeError)} className="text-input" max={customEnd || undefined} onChange={(event) => setCustomStartOverride(event.target.value)} type="date" value={customStart} /></label>
            <label className="record-field"><span className="field-label">Até</span><input aria-describedby={rangeError ? 'overview-period-error' : undefined} aria-invalid={Boolean(rangeError)} className="text-input" min={customStart || undefined} onChange={(event) => setCustomEndOverride(event.target.value)} type="date" value={customEnd} /></label>
          </>}
          {rangeError && <p className="form-message form-message-error report-period-error" id="overview-period-error" role="alert">{rangeError}</p>}
          <p className="section-footnote">Resumo operacional. Os valores financeiros ficam no relatório financeiro.</p>
        </div>
      </section>

      {error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => void loadOverview()} type="button">Tentar novamente</button></div>}
      {loading && <p className="inline-state" aria-live="polite">Carregando o relatório…</p>}
      {!loading && overview && !error && <>
        <section className="report-summary-grid" aria-label="Resumo operacional do período">
          {totals.map((item) => <article className="surface-panel report-summary-card" key={item.label}><span>{item.label}</span><strong>{new Intl.NumberFormat('pt-BR').format(item.value)}</strong><small>{item.note}</small></article>)}
        </section>

        <section className="surface-panel record-panel report-section" aria-labelledby="overview-deliveries-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">ENTREGAS CRIADAS</p><h2 id="overview-deliveries-title">Situação das entregas</h2></div><span className="neutral-status">{overview.deliveries.length}</span></div>
          {overview.deliveries.length === 0 ? <p className="inline-state">Nenhuma entrega criada neste período.</p> : <ul className="general-report-delivery-list" aria-label="Entregas agrupadas por situação">{Object.entries(deliveryCounts).map(([status, count]) => <li key={status}><span>{deliveryStatusLabel(status)}</span><strong>{count}</strong></li>)}</ul>}
          <p className="section-footnote">Mostra a situação atual de cada entrega criada no período.</p>
        </section>

        <section className="surface-panel record-panel report-section" aria-labelledby="overview-orders-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">PEDIDOS CRIADOS</p><h2 id="overview-orders-title">Pedidos recentes do período</h2></div><span className="neutral-status">{overview.orderCount}</span></div>
          {overview.orders.length === 0 ? <p className="inline-state">Nenhum pedido criado neste período.</p> : <details className="dashboard-trend-details report-orders-details"><summary>Ver pedidos do período <span>{Math.min(overview.orders.length, 12)} de {overview.orderCount}</span></summary><div aria-label="Pedidos recentes do período" className="report-table-wrap" role="region" tabIndex={0}><table className="report-table"><thead><tr><th>Data</th><th>Pedido / cliente</th><th>Tipo</th><th>Situação</th><th>Valor</th></tr></thead><tbody>{overview.orders.map((order) => <tr key={order.id}><td>{formatBusinessDate(businessDateFromTimestamp(order.created_at))}</td><td><Link className="report-order-link" to={`/pedidos/${order.id}`}>{order.customer_name_snapshot}</Link></td><td>{order.requires_delivery ? 'Entrega' : 'Retirada'}</td><td>{reportOrderStatus(order)}</td><td>{formatBRLExact(String(order.total_cents))}</td></tr>)}</tbody></table></div></details>}
          {overview.orderCount > overview.orders.length && <p className="section-footnote">Exibindo os 12 pedidos mais recentes de {overview.orderCount} no período.</p>}
        </section>
      </>}
    </div>
  )
}
