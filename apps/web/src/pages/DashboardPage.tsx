import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { DashboardTrends, type DashboardTrendDay, type DashboardTrendPeriod } from '../components/DashboardTrends'
import { formatBRLExact, formatBusinessDate } from '../lib/formatters'
import { useBusinessToday } from '../lib/useBusinessToday'
import { supabaseClient } from '../lib/supabase'

type DashboardPriorities = {
  as_of_on: string
  follow_ups: { pending_count: number; items: Array<{ id: string; title: string; due_on: string; priority: 'low' | 'normal' | 'high'; customer_id: string | null; customer_name: string | null }> }
  receivables: {
    overdue_count: number
    overdue_balance_cents: string
    due_today_count: number
    due_today_balance_cents: string
    items: Array<{ installment_id: string; order_id: string; installment_number: number; due_on: string; customer_name: string; balance_cents: string; overdue: boolean }>
  }
  deliveries: {
    pending_count: number
    items: Array<{ delivery_id: string; order_id: string; customer_name: string; status: 'awaiting_separation' | 'ready' | 'dispatched' | 'attempted' | 'rescheduled'; scheduled_on: string | null; time_window: string | null; delivery_worker_name: string | null }>
  }
  inventory: {
    tracked_product_count: number
    without_minimum_count: number
    attention_count: number
    items: Array<{ product_id: string; product_name: string; inventory_unit: string; minimum_stock: number | null; quantity_on_hand: number }>
  }
}

type RecentOrder = {
  id: string
  customer_name_snapshot: string
  status: 'open' | 'cancelled'
  requires_delivery: boolean
  created_at: string
}

const integrations = [
  { label: 'WhatsApp', state: 'Conexão pendente' },
  { label: 'Banco', state: 'Open Finance não conectado' },
  { label: 'Fiscal', state: 'Dados pendentes' },
]

const deliveryStatusLabels: Record<DashboardPriorities['deliveries']['items'][number]['status'], string> = {
  awaiting_separation: 'Aguardando separação',
  ready: 'Pronta para despacho',
  dispatched: 'Em rota',
  attempted: 'Tentativa sem sucesso',
  rescheduled: 'Reagendada',
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(value)
}

function formatOrderDate(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'America/Sao_Paulo' }).format(new Date(value))
}

function shiftCalendarDate(value: string, offset: number) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function readTrendInteger(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  throw new Error('Invalid daily aggregate.')
}

function readTrendDays(value: unknown, startOn: string, period: DashboardTrendPeriod): DashboardTrendDay[] {
  if (!Array.isArray(value) || value.length !== period) throw new Error('Incomplete daily series.')
  return value.map((row: unknown, index) => {
    if (typeof row !== 'object' || row === null) throw new Error('Invalid daily series.')
    const item = row as Record<string, unknown>
    const expectedDate = shiftCalendarDate(startOn, index)
    if (item.business_date !== expectedDate) throw new Error('Unexpected daily series date.')
    return {
      business_date: expectedDate,
      order_count: readTrendInteger(item.order_count),
      receipts_cents: readTrendInteger(item.receipts_cents),
      paid_outflows_cents: readTrendInteger(item.paid_outflows_cents),
    }
  })
}

export function DashboardPage() {
  const { id: businessId, role } = useBusiness()
  const today = useBusinessToday()
  const businessDate = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeZone: 'America/Sao_Paulo' }).format(new Date(`${today}T12:00:00Z`))
  const prioritiesScopeKey = `${businessId}:${role}:${today}`
  const prioritiesRequestId = useRef(0)
  const [priorityState, setPriorityState] = useState<{ scopeKey: string; loading: boolean; error: boolean; data: DashboardPriorities | null }>({ scopeKey: '', loading: true, error: false, data: null })
  const currentPriorities = priorityState.scopeKey === prioritiesScopeKey ? priorityState : { loading: true, error: false, data: null }
  const priorities = currentPriorities.data
  const prioritiesLoading = currentPriorities.loading
  const prioritiesError = currentPriorities.error
  const recentOrdersScopeKey = `${businessId}:${role}`
  const recentOrdersRequestId = useRef(0)
  const [recentOrdersState, setRecentOrdersState] = useState<{ scopeKey: string; loading: boolean; error: boolean; orders: RecentOrder[] }>({ scopeKey: '', loading: true, error: false, orders: [] })
  const currentRecentOrders = recentOrdersState.scopeKey === recentOrdersScopeKey ? recentOrdersState : { loading: true, error: false, orders: [] }
  const [trendPeriod, setTrendPeriod] = useState<DashboardTrendPeriod>(7)
  const trendStartOn = shiftCalendarDate(today, 1 - trendPeriod)
  const trendScopeKey = `${businessId}:${trendStartOn}:${today}`
  const trendRequestId = useRef(0)
  const [trendState, setTrendState] = useState<{ scopeKey: string; loading: boolean; error: boolean; days: DashboardTrendDay[] }>({ scopeKey: '', loading: true, error: false, days: [] })
  const currentTrends = trendState.scopeKey === trendScopeKey ? trendState : { loading: true, error: false, days: [] }

  const loadTrends = useCallback(async () => {
    const requestId = ++trendRequestId.current
    setTrendState({ scopeKey: trendScopeKey, loading: true, error: false, days: [] })
    try {
      if (!supabaseClient) throw new Error('Authentication service unavailable.')
      const { data, error } = await supabaseClient.rpc('get_dashboard_daily_trends', {
        p_business_id: businessId,
        p_start_on: trendStartOn,
        p_end_on: today,
      })
      if (error) throw error
      const days = readTrendDays(data, trendStartOn, trendPeriod)
      if (requestId === trendRequestId.current) setTrendState({ scopeKey: trendScopeKey, loading: false, error: false, days })
    } catch {
      if (requestId === trendRequestId.current) setTrendState({ scopeKey: trendScopeKey, loading: false, error: true, days: [] })
    }
  }, [businessId, today, trendPeriod, trendScopeKey, trendStartOn])

  const loadPriorities = useCallback(async () => {
    const requestId = ++prioritiesRequestId.current
    setPriorityState({ scopeKey: prioritiesScopeKey, loading: true, error: false, data: null })
    try {
      if (!supabaseClient) throw new Error('Authentication service unavailable.')
      const { data, error } = await supabaseClient.rpc('get_dashboard_priorities', {
        p_business_id: businessId,
        p_today: today,
      })
      if (error || !data) throw error
      if (requestId === prioritiesRequestId.current) setPriorityState({ scopeKey: prioritiesScopeKey, loading: false, error: false, data: data as DashboardPriorities })
    } catch {
      if (requestId === prioritiesRequestId.current) setPriorityState({ scopeKey: prioritiesScopeKey, loading: false, error: true, data: null })
    }
  }, [businessId, today, prioritiesScopeKey])

  const loadRecentOrders = useCallback(async () => {
    const requestId = ++recentOrdersRequestId.current
    if (role !== 'owner') {
      setRecentOrdersState({ scopeKey: recentOrdersScopeKey, loading: false, error: false, orders: [] })
      return
    }
    setRecentOrdersState({ scopeKey: recentOrdersScopeKey, loading: true, error: false, orders: [] })
    try {
      if (!supabaseClient) throw new Error('Authentication service unavailable.')
      const { data, error } = await supabaseClient.from('orders')
        .select('id, customer_name_snapshot, status, requires_delivery, created_at')
        .eq('business_id', businessId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(4)
      if (error) throw error
      if (requestId === recentOrdersRequestId.current) setRecentOrdersState({ scopeKey: recentOrdersScopeKey, loading: false, error: false, orders: (data ?? []) as RecentOrder[] })
    } catch {
      if (requestId === recentOrdersRequestId.current) setRecentOrdersState({ scopeKey: recentOrdersScopeKey, loading: false, error: true, orders: [] })
    }
  }, [businessId, role, recentOrdersScopeKey])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    void loadPriorities()
    return () => { prioritiesRequestId.current += 1 }
  }, [loadPriorities])
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    void loadRecentOrders()
    return () => { recentOrdersRequestId.current += 1 }
  }, [loadRecentOrders])
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    void loadTrends()
    return () => { trendRequestId.current += 1 }
  }, [loadTrends])

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{businessDate}</p>
          <h1>Central do dia</h1>
          <p className="page-description">O que precisa de ação hoje?</p>
        </div>
        <span className="period-badge">Operação</span>
      </header>

      <nav className="dashboard-day-summary" aria-label="Prioridades do dia" aria-busy={prioritiesLoading}>
        <Link className="dashboard-summary-link" to="/atendimento">
          <span className="dashboard-summary-icon"><Icon name="phone" /></span>
          <span className="dashboard-summary-copy"><strong>Retornos prioritários</strong><small>Atrasados ou com prazo para hoje</small></span>
          <span className="dashboard-summary-count">{priorities ? priorities.follow_ups.pending_count : '—'}</span>
          <Icon className="dashboard-summary-arrow" name="arrow" />
        </Link>
        <Link className="dashboard-summary-link is-receivables" to="/financeiro">
          <span className="dashboard-summary-icon"><Icon name="coin" /></span>
          <span className="dashboard-summary-copy"><strong>Contas a receber</strong><small>Vencidas ou com vencimento hoje</small></span>
          <span className="dashboard-summary-count">{priorities ? priorities.receivables.overdue_count + priorities.receivables.due_today_count : '—'}</span>
          <Icon className="dashboard-summary-arrow" name="arrow" />
        </Link>
        <Link className="dashboard-summary-link" to="/entregas">
          <span className="dashboard-summary-icon"><Icon name="truck" /></span>
          <span className="dashboard-summary-copy"><strong>Entregas em atenção</strong><small>Precisam de atualização hoje</small></span>
          <span className="dashboard-summary-count">{priorities ? priorities.deliveries.pending_count : '—'}</span>
          <Icon className="dashboard-summary-arrow" name="arrow" />
        </Link>
      </nav>

      <div className="dashboard-command-grid">
      <section className="surface-panel dashboard-action-panel" aria-labelledby="attention-title">
        <div className="section-heading">
          <div><p className="eyebrow">PRÓXIMAS AÇÕES</p><h2 id="attention-title">Fila de ações</h2></div>
          <span className="neutral-status">Hoje</span>
        </div>
        {prioritiesLoading && <p className="inline-state" aria-live="polite">Carregando prioridades…</p>}
        {!prioritiesLoading && prioritiesError && <div className="empty-state"><span className="empty-icon"><Icon name="clock" /></span><div><h3>Não foi possível carregar as prioridades</h3><button className="text-button" onClick={() => void loadPriorities()} type="button">Tentar novamente</button></div></div>}
        {!prioritiesLoading && !prioritiesError && priorities && <div className="dashboard-action-queue">
          <section className="dashboard-priority-block dashboard-action-group" aria-labelledby="dashboard-followups-title">
            <div className="dashboard-priority-heading"><div className="dashboard-priority-title"><Icon name="phone" /><h3 id="dashboard-followups-title">Retornos atrasados ou de hoje</h3><span>{priorities.follow_ups.pending_count}</span></div><Link className="quiet-link" to="/atendimento">Ver retornos <Icon name="arrow" /></Link></div>
            {priorities.follow_ups.items.length === 0 ? <p className="dashboard-priority-empty">Nenhum retorno vencido ou com prazo para hoje.</p> : <ul className="dashboard-priority-list">
              {priorities.follow_ups.items.map((task) => <li key={task.id}>
                <Link to="/atendimento"><strong>{task.title}</strong><small>{task.customer_name ?? 'Sem cliente vinculado'}</small></Link>
                <span className={task.due_on < today ? 'dashboard-task-date is-overdue' : 'dashboard-task-date'}>{task.due_on < today ? 'Atrasado' : task.due_on === today ? 'Hoje' : formatBusinessDate(task.due_on)}</span>
              </li>)}
            </ul>}
            {priorities.follow_ups.pending_count > priorities.follow_ups.items.length && <p className="section-footnote">Mostrando {priorities.follow_ups.items.length} de {priorities.follow_ups.pending_count} retornos com prazo até hoje.</p>}
          </section>

          <section className="dashboard-priority-block dashboard-action-group" aria-labelledby="dashboard-receivables-title">
            <div className="dashboard-priority-heading"><div className="dashboard-priority-title"><Icon name="coin" /><h3 id="dashboard-receivables-title">Contas a receber</h3></div><Link className="quiet-link" to="/financeiro">Abrir <Icon name="arrow" /></Link></div>
            <dl className="dashboard-receivable-totals">
              <div><dt>Vencidas · {priorities.receivables.overdue_count}</dt><dd>{formatBRLExact(priorities.receivables.overdue_balance_cents)}</dd></div>
              <div><dt>Vencem hoje · {priorities.receivables.due_today_count}</dt><dd>{formatBRLExact(priorities.receivables.due_today_balance_cents)}</dd></div>
            </dl>
            {priorities.receivables.items.length > 0 && <ul className="dashboard-priority-list dashboard-receivable-list">
              {priorities.receivables.items.map((item) => <li key={item.installment_id}>
                <Link to={`/pedidos/${item.order_id}`}><strong>{item.customer_name}</strong><small>Vencimento {item.installment_number} · {item.overdue ? 'Atrasado' : 'Hoje'}</small></Link>
                <span className="dashboard-task-date">{formatBRLExact(item.balance_cents)}</span>
              </li>)}
            </ul>}
            {priorities.receivables.items.length > 0 && <p className="section-footnote">A lista mostra até quatro vencimentos prioritários; os totais incluem todos os saldos devidos.</p>}
            {priorities.receivables.items.length === 0 && <p className="dashboard-priority-empty">Nenhum saldo vencido ou com vencimento hoje.</p>}
          </section>

          <section className="dashboard-priority-block dashboard-action-group" aria-labelledby="dashboard-deliveries-title">
            <div className="dashboard-priority-heading"><div className="dashboard-priority-title"><Icon name="truck" /><h3 id="dashboard-deliveries-title">Entregas para tratar hoje</h3><span>{priorities.deliveries.pending_count}</span></div><Link className="quiet-link" to="/entregas">Abrir fila <Icon name="arrow" /></Link></div>
            {priorities.deliveries.items.length === 0 ? <p className="dashboard-priority-empty">Nenhuma entrega precisa de atualização.</p> : <ul className="dashboard-priority-list">
              {priorities.deliveries.items.map((delivery) => <li key={delivery.delivery_id}>
                <Link to={`/pedidos/${delivery.order_id}`}><strong>{delivery.customer_name}</strong><small>{deliveryStatusLabels[delivery.status]}{delivery.delivery_worker_name ? ` · ${delivery.delivery_worker_name}` : ''}</small></Link>
                <span className="dashboard-task-date">{delivery.scheduled_on === null ? 'Sem data' : delivery.scheduled_on < today ? 'Data vencida' : delivery.scheduled_on === today ? 'Hoje' : formatBusinessDate(delivery.scheduled_on)}</span>
              </li>)}
            </ul>}
            {priorities.deliveries.pending_count > priorities.deliveries.items.length && <p className="section-footnote">Mostrando {priorities.deliveries.items.length} de {priorities.deliveries.pending_count} entregas que precisam de atenção.</p>}
          </section>
        </div>}
      </section>

      <section className="surface-panel dashboard-recent-panel" aria-labelledby="dashboard-recent-orders-title">
        <div className="section-heading section-heading-compact">
          <div><p className="eyebrow">ACOMPANHAMENTO</p><h2 id="dashboard-recent-orders-title">Pedidos recentes</h2></div>
          {role === 'owner' && <Link className="quiet-link" to="/pedidos">Ver todos <Icon name="arrow" /></Link>}
        </div>
        {role !== 'owner' ? <div className="dashboard-panel-state"><span className="empty-icon"><Icon name="shield" /></span><h3>Acesso indisponível</h3><p>Seu perfil atual não tem permissão para consultar pedidos recentes.</p></div> : <>
          {currentRecentOrders.loading && <p className="inline-state" aria-live="polite">Carregando pedidos recentes…</p>}
          {!currentRecentOrders.loading && currentRecentOrders.error && <div className="dashboard-panel-state" role="alert"><span className="empty-icon"><Icon name="bag" /></span><h3>Não foi possível carregar os pedidos</h3><p>Tente novamente para atualizar esta lista.</p><button className="text-button" onClick={() => void loadRecentOrders()} type="button">Tentar novamente</button></div>}
          {!currentRecentOrders.loading && !currentRecentOrders.error && currentRecentOrders.orders.length === 0 && <div className="dashboard-panel-state"><span className="empty-icon"><Icon name="bag" /></span><h3>Ainda não há pedidos registrados</h3><p>Os últimos quatro pedidos aparecerão aqui para facilitar o acompanhamento.</p><Link className="quiet-link" to="/pedidos/novo">Criar primeiro pedido <Icon name="arrow" /></Link></div>}
          {!currentRecentOrders.loading && !currentRecentOrders.error && currentRecentOrders.orders.length > 0 && <ul className="dashboard-recent-order-list">
            {currentRecentOrders.orders.map((order) => <li key={order.id}>
              <Link to={`/pedidos/${order.id}`}>
                <span className="dashboard-order-mark"><Icon name="bag" /></span>
                <span className="dashboard-recent-order-copy"><strong>{order.customer_name_snapshot}</strong><small>{formatOrderDate(order.created_at)} · {order.requires_delivery ? 'Entrega' : 'Retirada'}</small><span className={`dashboard-recent-order-status${order.status === 'cancelled' ? ' is-cancelled' : ''}`}>{order.status === 'cancelled' ? 'Cancelado' : 'Pedido ativo'}</span></span>
                <Icon className="dashboard-recent-order-arrow" name="arrow" />
              </Link>
            </li>)}
          </ul>}
        </>}
      </section>
      </div>

      <DashboardTrends
        days={currentTrends.days}
        endOn={today}
        error={currentTrends.error}
        loading={currentTrends.loading}
        onPeriodChange={setTrendPeriod}
        onRetry={() => void loadTrends()}
        period={trendPeriod}
        startOn={trendStartOn}
      />

      <div className="dashboard-columns">
        <section className="surface-panel" aria-labelledby="integrations-title">
          <div className="section-heading section-heading-compact">
            <div>
              <p className="eyebrow">CONFIGURAÇÃO</p>
              <h2 id="integrations-title">Conexões</h2>
            </div>
            <Link className="quiet-link" to="/configuracoes">Ver status <Icon name="arrow" /></Link>
          </div>
          <ul className="status-list">
            {integrations.map((item) => (
              <li key={item.label}>
                <span className="status-indicator" aria-hidden="true" />
                <span className="status-name">{item.label}</span>
                <span className="status-copy">{item.state}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="surface-panel stock-panel" aria-labelledby="stock-title">
          <div className="section-heading section-heading-compact">
            <div>
              <p className="eyebrow">ESTOQUE</p>
              <h2 id="stock-title">Nível de atenção</h2>
            </div>
            {prioritiesLoading || prioritiesError ? <Icon className="section-icon" name="box" /> : <span className="dashboard-stock-count" aria-label={`${priorities?.inventory.attention_count ?? 0} produtos em atenção`}>{priorities?.inventory.attention_count ?? 0}</span>}
          </div>
          {prioritiesLoading && <p className="inline-state" aria-live="polite">Carregando saldos…</p>}
          {!prioritiesLoading && prioritiesError && <div className="small-empty-state"><p>As informações de estoque fazem parte da atualização geral do painel. Use “Tentar novamente” acima.</p></div>}
          {!prioritiesLoading && !prioritiesError && priorities && priorities.inventory.tracked_product_count === 0 && <div className="small-empty-state"><p>Nenhum produto está configurado para controle de estoque.</p><Link className="quiet-link" to="/catalogo">Configurar produtos <Icon name="arrow" /></Link></div>}
          {!prioritiesLoading && !prioritiesError && priorities && priorities.inventory.tracked_product_count > 0 && priorities.inventory.attention_count === 0 && <div className="small-empty-state"><p>Nenhum saldo está negativo ou abaixo do mínimo definido.{priorities.inventory.without_minimum_count > 0 ? ` ${priorities.inventory.without_minimum_count} produto(s) ainda sem mínimo definido.` : ''}</p><Link className="quiet-link" to="/estoque">Abrir estoque <Icon name="arrow" /></Link></div>}
          {!prioritiesLoading && !prioritiesError && priorities && priorities.inventory.attention_count > 0 && <>
            <ul className="dashboard-stock-list">{priorities.inventory.items.map((item) => <li key={item.product_id}><span><strong>{item.product_name}</strong><small>{item.minimum_stock === null ? 'Saldo negativo · sem mínimo definido' : `${item.quantity_on_hand < 0 ? 'Saldo negativo · ' : ''}Mínimo ${formatQuantity(item.minimum_stock)} ${item.inventory_unit}`}</small></span><span className="dashboard-stock-quantity">{formatQuantity(item.quantity_on_hand)} {item.inventory_unit}</span></li>)}</ul>
            {priorities.inventory.attention_count > priorities.inventory.items.length && <p className="section-footnote">Mostrando {priorities.inventory.items.length} de {priorities.inventory.attention_count} produtos em atenção.</p>}
            {priorities.inventory.without_minimum_count > 0 && <p className="section-footnote">{priorities.inventory.without_minimum_count} produto(s) controlado(s) ainda sem mínimo definido.</p>}
            <Link className="quiet-link" to="/estoque">Ver produtos em atenção <Icon name="arrow" /></Link>
          </>}
        </section>
      </div>

      <section className="quick-links" aria-label="Atalhos">
        <Link className="quick-link" to="/atendimento"><Icon name="phone" /><span><strong>Atendimento</strong><small>Chamadas e retornos</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
        <Link className="quick-link" to="/pedidos"><Icon name="bag" /><span><strong>Pedidos</strong><small>Vendas e entregas</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
        <Link className="quick-link" to="/clientes"><Icon name="people" /><span><strong>Clientes</strong><small>Cadastros e histórico</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
        <Link className="quick-link" to="/catalogo"><Icon name="box" /><span><strong>Catálogo</strong><small>Produtos e categorias</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
      </section>
    </div>
  )
}
