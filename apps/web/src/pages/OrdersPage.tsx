import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { formatBRL } from '../lib/formatters'
import { supabaseClient } from '../lib/supabase'

type Order = {
  id: string
  customer_name_snapshot: string
  total_cents: number
  status: 'open' | 'cancelled'
  requires_delivery: boolean
  created_at: string
}

type Payment = { order_id: string; amount_cents: number }

type OrderSummary = Order & { received_cents: number; outstanding_cents: number; has_pickup: boolean }

function formatOrderDate(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'America/Sao_Paulo' }).format(new Date(value))
}

export function OrdersPage() {
  const { id: businessId } = useBusiness()
  const [orders, setOrders] = useState<OrderSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadOrders = useCallback(async () => {
    if (!supabaseClient) {
      setError('A conexão da empresa não está disponível.')
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const ordersResult = await supabaseClient.from('orders')
        .select('id, customer_name_snapshot, total_cents, status, created_at, requires_delivery')
        .eq('business_id', businessId)
        .order('created_at', { ascending: false })
      if (ordersResult.error) {
        setError('Não foi possível carregar os pedidos. Tente novamente.')
        return
      }

      const rows = (ordersResult.data ?? []) as Order[]
      const orderIds = rows.map((order) => order.id)
      let payments: Payment[] = []
      let pickupOrderIds = new Set<string>()
      if (orderIds.length > 0) {
        const [paymentsResult, pickupEventsResult] = await Promise.all([
          supabaseClient.from('order_payments')
            .select('order_id, amount_cents')
            .eq('business_id', businessId)
            .in('order_id', orderIds),
          supabaseClient.from('order_events')
            .select('order_id')
            .eq('business_id', businessId)
            .eq('event_type', 'picked_up')
            .in('order_id', orderIds),
        ])
        if (paymentsResult.error || pickupEventsResult.error) {
          setError('Os pedidos foram encontrados, mas não foi possível carregar os recebimentos e as retiradas. Tente novamente.')
          return
        }
        payments = (paymentsResult.data ?? []) as Payment[]
        pickupOrderIds = new Set((pickupEventsResult.data ?? []).map((event) => event.order_id))
      }

      const receivedByOrder = new Map<string, number>()
      for (const payment of payments) {
        receivedByOrder.set(payment.order_id, (receivedByOrder.get(payment.order_id) ?? 0) + payment.amount_cents)
      }
      setOrders(rows.map((order) => {
        const received_cents = receivedByOrder.get(order.id) ?? 0
        return {
          ...order,
          received_cents,
          outstanding_cents: order.status === 'open' ? Math.max(0, order.total_cents - received_cents) : 0,
          has_pickup: pickupOrderIds.has(order.id),
        }
      }))
      setError(null)
    } catch {
      setError('Não foi possível carregar os pedidos. Tente novamente.')
    } finally {
      setLoading(false)
    }
  }, [businessId])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadOrders() }, [loadOrders])

  const openOrders = orders.filter((order) => order.status === 'open')
  const cancelledOrders = orders.filter((order) => order.status === 'cancelled')

  function renderOrders(items: OrderSummary[], emptyText: string) {
    if (items.length === 0) return <p className="inline-state">{emptyText}</p>
    return (
      <ul className="record-list order-list">
        {items.map((order) => (
          <li key={order.id}>
            <Link className="order-list-link" to={`/pedidos/${order.id}`}>
              <span className="record-avatar"><Icon name="bag" /></span>
              <span className="order-list-main">
                <strong>{order.customer_name_snapshot}</strong>
                <small>Pedido de {formatOrderDate(order.created_at)} · {order.requires_delivery ? order.status === 'cancelled' ? 'Entrega cancelada' : 'Entrega' : order.status === 'cancelled' ? 'Retirada cancelada' : order.has_pickup ? 'Retirada registrada' : 'Retirada pendente'}</small>
                <span className={`order-status ${order.status === 'cancelled' ? 'order-status-cancelled' : order.outstanding_cents > 0 ? 'order-status-open' : 'order-status-received'}`}>
                  {order.status === 'cancelled' ? 'Cancelado' : order.outstanding_cents > 0 ? 'Em aberto' : 'Recebido'}
                </span>
              </span>
              <span className="order-financials">
                <span><small>Pedido</small><strong>{formatBRL(order.total_cents)}</strong></span>
                <span><small>Recebido</small><strong>{formatBRL(order.received_cents)}</strong></span>
                <span><small>Em aberto</small><strong>{formatBRL(order.outstanding_cents)}</strong></span>
              </span>
              <Icon className="order-list-arrow" name="arrow" />
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
          <p className="eyebrow">VENDAS E RECEBÍVEIS</p>
          <h1>Pedidos</h1>
          <p className="page-description">Pedidos, prazos combinados e valores recebidos manualmente.</p>
        </div>
        <Link className="button button-primary" to="/pedidos/novo"><Icon name="plus" /> Novo pedido</Link>
      </header>

      <p className="section-footnote order-policy-note">Prazos, valores e formas combinadas são informados em cada pedido. O registro de um recebimento não processa pagamentos.</p>

      {error && (
        <div className="inline-state inline-state-error" role="alert">
          <p>{error}</p>
          <button className="text-button" onClick={() => void loadOrders()} type="button">Tentar novamente</button>
        </div>
      )}

      {loading ? <p className="inline-state" aria-live="polite">Carregando pedidos…</p> : !error && (
        <>
          <section className="surface-panel record-panel" aria-labelledby="orders-open-title">
            <div className="section-heading section-heading-compact">
              <div><p className="eyebrow">ACOMPANHAMENTO</p><h2 id="orders-open-title">Pedidos ativos</h2></div>
              <span className="neutral-status">{openOrders.length}</span>
            </div>
            {renderOrders(openOrders, 'Nenhum pedido ativo. Crie um pedido para registrar os produtos e os vencimentos combinados.')}
          </section>
          <section className="surface-panel record-panel" aria-labelledby="orders-cancelled-title">
            <div className="section-heading section-heading-compact">
              <div><p className="eyebrow">HISTÓRICO</p><h2 id="orders-cancelled-title">Cancelados</h2></div>
              <span className="neutral-status">{cancelledOrders.length}</span>
            </div>
            {renderOrders(cancelledOrders, 'Nenhum pedido cancelado.')}
          </section>
          {orders.length === 0 && <p className="section-footnote">O total do pedido, o valor recebido e o saldo em aberto aparecem separados em cada registro.</p>}
        </>
      )}
    </div>
  )
}
