import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { canManageBusiness, useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { formatBRLExact, formatBusinessDate } from '../lib/formatters'
import { useBusinessToday } from '../lib/useBusinessToday'
import { useVisibleAutoRefresh } from '../lib/useVisibleAutoRefresh'
import { isDemoPreviewEnabled } from '../lib/demoPreview'
import { supabaseClient } from '../lib/supabase'
import './DashboardDesignReferencesPage.css'
import './DashboardPage.css'

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
  payroll: {
    overdue_count: number
    overdue_amount_cents: string
    due_today_count: number
    due_today_amount_cents: string
    items: Array<{ worker_id: string; name: string; member_type: 'delivery_driver' | 'employee'; period_start: string; due_on: string; amount_cents: string; paid_on: string | null; outflow_id: string | null }>
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
  status: 'open' | 'completed' | 'cancelled'
  requires_delivery: boolean
  created_at: string
}

type FinancialSummary = {
  managerial_result: {
    completed_order_count: number
    sales_cents: string
    product_subtotal_cents: string
    customer_delivery_fee_cents: string
    item_cost_cents: string | null
  }
}

type ActionFilter = 'all' | 'followups' | 'receivables' | 'deliveries' | 'inventory'
type MoneyDirection = 'incoming' | 'outgoing'
type DashboardMoney = { label: string; tone: 'positive' | 'negative' | 'neutral'; accessibleLabel: string }
type DashboardPriorityAction = {
  key: string
  dueOn: string
  severity: number
  category: number
  href: string
  icon: 'phone' | 'coin' | 'truck' | 'box'
  title: string
  detail: string
  money?: DashboardMoney
  state: string
}

const actionFilters: Array<{ value: ActionFilter; label: string }> = [
  { value: 'all', label: 'Todos' },
  { value: 'followups', label: 'Lembretes' },
  { value: 'receivables', label: 'Clientes e salários' },
  { value: 'deliveries', label: 'Entregas' },
  { value: 'inventory', label: 'Estoque' },
]

const deliveryStatusLabels: Record<DashboardPriorities['deliveries']['items'][number]['status'], string> = {
  awaiting_separation: 'Aguardando separação',
  ready: 'Pronta para sair',
  dispatched: 'Em rota',
  attempted: 'Entrega não concluída',
  rescheduled: 'Reagendada',
}

const deliveryPriorityRanks: Record<DashboardPriorities['deliveries']['items'][number]['status'], number> = {
  attempted: 0,
  awaiting_separation: 1,
  ready: 2,
  rescheduled: 3,
  dispatched: 4,
}

function createDemoPriorities(today: string): DashboardPriorities {
  const yesterday = shiftCalendarDate(today, -1)
  const twoDaysAgo = shiftCalendarDate(today, -2)
  return {
    as_of_on: today,
    follow_ups: {
      pending_count: 3,
      items: [
        { id: 'demo-follow-up-1', title: 'Confirmar reposição do sabão neutro', due_on: yesterday, priority: 'high', customer_id: null, customer_name: 'Mercado Boa Praça' },
        { id: 'demo-follow-up-2', title: 'Retornar sobre orçamento de novembro', due_on: today, priority: 'normal', customer_id: null, customer_name: 'Condomínio Vila Verde' },
        { id: 'demo-follow-up-3', title: 'Confirmar quantidade para sexta-feira', due_on: today, priority: 'normal', customer_id: null, customer_name: 'Restaurante Sabor Caseiro' },
      ],
    },
    receivables: {
      overdue_count: 2,
      overdue_balance_cents: '31800',
      due_today_count: 1,
      due_today_balance_cents: '8700',
      items: [
        { installment_id: 'demo-installment-1', order_id: 'demo-order-1', installment_number: 2, due_on: twoDaysAgo, customer_name: 'Mercado Boa Praça', balance_cents: '12000', overdue: true },
        { installment_id: 'demo-installment-4', order_id: 'demo-order-5', installment_number: 1, due_on: yesterday, customer_name: 'Lavanderia Ponto Limpo', balance_cents: '19800', overdue: true },
        { installment_id: 'demo-installment-2', order_id: 'demo-order-2', installment_number: 1, due_on: today, customer_name: 'Condomínio Vila Verde', balance_cents: '8700', overdue: false },
      ],
    },
    payroll: {
      overdue_count: 1,
      overdue_amount_cents: '180000',
      due_today_count: 0,
      due_today_amount_cents: '0',
      items: [
        { worker_id: 'demo-team-1', name: 'Rafael', member_type: 'delivery_driver', period_start: `${yesterday.slice(0, 7)}-01`, due_on: yesterday, amount_cents: '180000', paid_on: null, outflow_id: null },
      ],
    },
    deliveries: {
      pending_count: 3,
      items: [
        { delivery_id: 'demo-delivery-1', order_id: 'demo-order-1', customer_name: 'Mercado Boa Praça', status: 'awaiting_separation', scheduled_on: today, time_window: '09:00–12:00', delivery_worker_name: 'Rafael' },
        { delivery_id: 'demo-delivery-2', order_id: 'demo-order-3', customer_name: 'Restaurante Sabor Caseiro', status: 'dispatched', scheduled_on: today, time_window: '13:00–16:00', delivery_worker_name: 'João' },
        { delivery_id: 'demo-delivery-3', order_id: 'demo-order-5', customer_name: 'Lavanderia Ponto Limpo', status: 'attempted', scheduled_on: today, time_window: '16:00–18:00', delivery_worker_name: 'Rafael' },
      ],
    },
    inventory: {
      tracked_product_count: 12,
      without_minimum_count: 2,
      attention_count: 2,
      items: [
        { product_id: 'demo-product-1', product_name: 'Detergente neutro 5 L', inventory_unit: 'un.', minimum_stock: 8, quantity_on_hand: 3 },
        { product_id: 'demo-product-2', product_name: 'Desinfetante floral 2 L', inventory_unit: 'un.', minimum_stock: null, quantity_on_hand: -1 },
      ],
    },
  }
}

function createDemoRecentOrders(today: string): RecentOrder[] {
  return [
    { id: 'demo-order-1', customer_name_snapshot: 'Mercado Boa Praça', status: 'open', requires_delivery: true, created_at: `${today}T13:10:00-03:00` },
    { id: 'demo-order-2', customer_name_snapshot: 'Condomínio Vila Verde', status: 'open', requires_delivery: false, created_at: `${today}T11:45:00-03:00` },
    { id: 'demo-order-3', customer_name_snapshot: 'Restaurante Sabor Caseiro', status: 'open', requires_delivery: true, created_at: `${shiftCalendarDate(today, -1)}T16:20:00-03:00` },
    { id: 'demo-order-4', customer_name_snapshot: 'Flor & Afeto', status: 'completed', requires_delivery: true, created_at: `${shiftCalendarDate(today, -2)}T09:30:00-03:00` },
  ]
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(value)
}

function formatDashboardMoney(value: string, direction: MoneyDirection, context: string): DashboardMoney {
  const cents = BigInt(value)
  const absoluteCents = cents < 0n ? -cents : cents
  if (absoluteCents === 0n) {
    const label = formatBRLExact(0n)
    return { label, tone: 'neutral', accessibleLabel: `${context}: ${label}` }
  }

  const tone = direction === 'incoming' ? 'positive' : 'negative'
  const label = `${direction === 'incoming' ? '+' : '−'} ${formatBRLExact(absoluteCents)}`
  return { label, tone, accessibleLabel: `${context}: ${label}` }
}

function DashboardMoneyValue({ amount, element = 'span' }: { amount: DashboardMoney; element?: 'span' | 'strong' }) {
  const className = `dashboard-money is-${amount.tone}`
  return element === 'strong'
    ? <strong className={className} aria-label={amount.accessibleLabel}>{amount.label}</strong>
    : <span className={className} aria-label={amount.accessibleLabel}>{amount.label}</span>
}

function formatOrderDate(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'America/Sao_Paulo' }).format(new Date(value))
}

function shiftCalendarDate(value: string, offset: number) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

export function DashboardPage() {
  const { id: businessId, role } = useBusiness()
  const demoPreview = canManageBusiness(role) && isDemoPreviewEnabled()
  const today = useBusinessToday()
  const businessDate = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeZone: 'America/Sao_Paulo' }).format(new Date(`${today}T12:00:00Z`))
  const prioritiesScopeKey = `${businessId}:${role}:${today}`
  const prioritiesRequestId = useRef(0)
  const [priorityState, setPriorityState] = useState<{ scopeKey: string; loading: boolean; error: boolean; data: DashboardPriorities | null }>({ scopeKey: '', loading: true, error: false, data: null })
  const currentPriorities = priorityState.scopeKey === prioritiesScopeKey ? priorityState : { loading: true, error: false, data: null }
  const priorities = currentPriorities.data
  const overduePayrollMoney = priorities ? formatDashboardMoney(priorities.payroll.overdue_amount_cents, 'outgoing', 'Total de salários atrasados') : null
  const receivablesDueTodayMoney = priorities ? formatDashboardMoney(priorities.receivables.due_today_balance_cents, 'incoming', 'Total a receber hoje') : null
  const prioritiesLoading = currentPriorities.loading
  const prioritiesError = currentPriorities.error
  const [actionFilter, setActionFilter] = useState<ActionFilter>('all')
  const noActions = priorities !== null && priorities.follow_ups.pending_count === 0 && priorities.receivables.overdue_count === 0 && priorities.receivables.due_today_count === 0 && priorities.payroll.overdue_count === 0 && priorities.payroll.due_today_count === 0 && priorities.deliveries.pending_count === 0 && priorities.inventory.attention_count === 0
  const visibleActionCount = priorities === null ? null : {
    all: priorities.follow_ups.pending_count + priorities.receivables.overdue_count + priorities.receivables.due_today_count + priorities.payroll.overdue_count + priorities.payroll.due_today_count + priorities.deliveries.pending_count + priorities.inventory.attention_count,
    followups: priorities.follow_ups.pending_count,
    receivables: priorities.receivables.overdue_count + priorities.receivables.due_today_count + priorities.payroll.overdue_count + priorities.payroll.due_today_count,
    deliveries: priorities.deliveries.pending_count,
    inventory: priorities.inventory.attention_count,
  }[actionFilter]
  const activeActionFilterLabel = actionFilters.find((filter) => filter.value === actionFilter)?.label ?? 'Todos'
  const recentOrdersScopeKey = `${businessId}:${role}`
  const recentOrdersRequestId = useRef(0)
  const [recentOrdersState, setRecentOrdersState] = useState<{ scopeKey: string; loading: boolean; error: boolean; orders: RecentOrder[] }>({ scopeKey: '', loading: true, error: false, orders: [] })
  const currentRecentOrders = recentOrdersState.scopeKey === recentOrdersScopeKey ? recentOrdersState : { loading: true, error: false, orders: [] }
  const financialSummaryRequestId = useRef(0)
  const [financialSummaryState, setFinancialSummaryState] = useState<{ scopeKey: string; loading: boolean; error: boolean; data: FinancialSummary | null }>({ scopeKey: '', loading: true, error: false, data: null })
  const financialSummaryScopeKey = `${businessId}:${role}:${today}`
  const currentFinancialSummary = financialSummaryState.scopeKey === financialSummaryScopeKey ? financialSummaryState : { loading: true, error: false, data: null }
  const financialSummary = currentFinancialSummary.data
  const financialGrossMoney = financialSummary ? formatDashboardMoney((BigInt(financialSummary.managerial_result.product_subtotal_cents) + BigInt(financialSummary.managerial_result.customer_delivery_fee_cents)).toString(), 'incoming', 'Faturamento bruto') : null
  const financialNetMoney = financialSummary ? formatDashboardMoney(financialSummary.managerial_result.sales_cents, 'incoming', 'Faturamento líquido') : null
  const financialProductCostMoney = financialSummary?.managerial_result.item_cost_cents === null || financialSummary?.managerial_result.item_cost_cents === undefined
    ? null
    : formatDashboardMoney(financialSummary.managerial_result.item_cost_cents, 'outgoing', 'Custo dos produtos vendidos')
  const loadPriorities = useCallback(async (silent = false) => {
    const requestId = ++prioritiesRequestId.current
    if (!canManageBusiness(role)) {
      setPriorityState({ scopeKey: prioritiesScopeKey, loading: false, error: false, data: null })
      return
    }
    if (!silent) setPriorityState({ scopeKey: prioritiesScopeKey, loading: true, error: false, data: null })
    try {
      if (demoPreview) {
        setPriorityState({ scopeKey: prioritiesScopeKey, loading: false, error: false, data: createDemoPriorities(today) })
        return
      }
      if (!supabaseClient) throw new Error('Authentication service unavailable.')
      const [priorityResult, payrollResult] = await Promise.all([
        supabaseClient.rpc('get_dashboard_priorities', {
          p_business_id: businessId,
          p_today: today,
        }),
        supabaseClient.rpc('get_team_salary_status', {
          p_business_id: businessId,
          p_today: today,
        }),
      ])
      if (priorityResult.error || !priorityResult.data || payrollResult.error || !payrollResult.data) throw priorityResult.error ?? payrollResult.error
      const data = { ...(priorityResult.data as Omit<DashboardPriorities, 'payroll'>), payroll: payrollResult.data } as DashboardPriorities
      if (requestId === prioritiesRequestId.current) setPriorityState({ scopeKey: prioritiesScopeKey, loading: false, error: false, data })
    } catch {
      if (requestId === prioritiesRequestId.current) setPriorityState((previous) => ({
        scopeKey: prioritiesScopeKey,
        loading: false,
        error: true,
        data: previous.scopeKey === prioritiesScopeKey ? previous.data : null,
      }))
    }
  }, [businessId, demoPreview, role, today, prioritiesScopeKey])

  const loadRecentOrders = useCallback(async (silent = false) => {
    const requestId = ++recentOrdersRequestId.current
    if (!canManageBusiness(role)) {
      setRecentOrdersState({ scopeKey: recentOrdersScopeKey, loading: false, error: false, orders: [] })
      return
    }
    if (!silent) setRecentOrdersState({ scopeKey: recentOrdersScopeKey, loading: true, error: false, orders: [] })
    try {
      if (demoPreview) {
        setRecentOrdersState({ scopeKey: recentOrdersScopeKey, loading: false, error: false, orders: createDemoRecentOrders(today) })
        return
      }
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
      if (!silent && requestId === recentOrdersRequestId.current) setRecentOrdersState({ scopeKey: recentOrdersScopeKey, loading: false, error: true, orders: [] })
    }
  }, [businessId, demoPreview, role, recentOrdersScopeKey, today])

  const loadFinancialSummary = useCallback(async (silent = false) => {
    const requestId = ++financialSummaryRequestId.current
    if (!canManageBusiness(role)) {
      setFinancialSummaryState({ scopeKey: financialSummaryScopeKey, loading: false, error: false, data: null })
      return
    }
    if (!silent) setFinancialSummaryState({ scopeKey: financialSummaryScopeKey, loading: true, error: false, data: null })
    try {
      if (demoPreview) {
        setFinancialSummaryState({
          scopeKey: financialSummaryScopeKey,
          loading: false,
          error: false,
          data: { managerial_result: { completed_order_count: 1, sales_cents: '29600', product_subtotal_cents: '28000', customer_delivery_fee_cents: '1600', item_cost_cents: '14200' } },
        })
        return
      }
      if (!supabaseClient) throw new Error('Authentication service unavailable.')
      const { data, error } = await supabaseClient.rpc('get_financial_report_summary', {
        p_business_id: businessId,
        p_start_on: `${today.slice(0, 7)}-01`,
        p_end_on: today,
      })
      if (error || !data) throw error ?? new Error('Financial summary was empty.')
      if (requestId === financialSummaryRequestId.current) setFinancialSummaryState({ scopeKey: financialSummaryScopeKey, loading: false, error: false, data: data as FinancialSummary })
    } catch {
      if (!silent && requestId === financialSummaryRequestId.current) setFinancialSummaryState((previous) => ({
        scopeKey: financialSummaryScopeKey,
        loading: false,
        error: true,
        data: previous.scopeKey === financialSummaryScopeKey ? previous.data : null,
      }))
    }
  }, [businessId, demoPreview, financialSummaryScopeKey, role, today])

  const refreshDashboard = useCallback(async () => {
    await Promise.allSettled([loadPriorities(true), loadRecentOrders(true), loadFinancialSummary(true)])
  }, [loadFinancialSummary, loadPriorities, loadRecentOrders])
  useVisibleAutoRefresh(refreshDashboard)

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
    void loadFinancialSummary()
    return () => { financialSummaryRequestId.current += 1 }
  }, [loadFinancialSummary])
  const totalPriorityActionCount = priorities
    ? priorities.follow_ups.pending_count + priorities.receivables.overdue_count + priorities.receivables.due_today_count + priorities.payroll.overdue_count + priorities.payroll.due_today_count + priorities.deliveries.pending_count + priorities.inventory.attention_count
    : null
  const priorityActionCandidates: DashboardPriorityAction[] = [
    ...(priorities?.follow_ups.items.map((followUp) => ({
      key: followUp.id,
      dueOn: followUp.due_on,
      severity: followUp.due_on < today ? 0 : followUp.priority === 'high' ? 1 : 2,
      category: 0,
      href: '/atendimento',
      icon: 'phone' as const,
      title: followUp.title,
      detail: `${followUp.customer_name ?? 'Sem cliente escolhido'} · ${followUp.due_on < today ? 'Atrasado' : followUp.due_on === today ? 'Hoje' : formatBusinessDate(followUp.due_on)}`,
      state: 'Lembrete',
    })) ?? []),
    ...(priorities?.receivables.items.map((receivable) => ({
      key: receivable.installment_id,
      dueOn: receivable.due_on,
      severity: receivable.overdue ? 0 : 2,
      category: 1,
      href: demoPreview ? '/financeiro/receber' : `/pedidos/${receivable.order_id}`,
      icon: 'coin' as const,
      title: receivable.customer_name,
      detail: `Parcela ${receivable.installment_number} · ${formatBusinessDate(receivable.due_on)}`,
      money: formatDashboardMoney(receivable.balance_cents, 'incoming', `Valor a receber de ${receivable.customer_name}`),
      state: receivable.overdue ? 'Atrasado' : 'Vence hoje',
    })) ?? []),
    ...(priorities?.payroll.items.filter((item) => item.paid_on === null && item.due_on <= today).map((item) => ({
      key: `salary-${item.worker_id}-${item.period_start}`,
      dueOn: item.due_on,
      severity: item.due_on < today ? 0 : 1,
      category: 1,
      href: '/equipe',
      icon: 'coin' as const,
      title: `Salário · ${item.name}`,
      detail: formatBusinessDate(item.due_on),
      money: formatDashboardMoney(item.amount_cents, 'outgoing', `Salário de ${item.name}`),
      state: item.due_on < today ? 'Atrasado' : 'Vence hoje',
    })) ?? []),
    ...(priorities?.deliveries.items.map((delivery) => ({
      key: delivery.delivery_id,
      dueOn: delivery.scheduled_on ?? '',
      severity: deliveryPriorityRanks[delivery.status],
      category: 2,
      href: demoPreview ? '/entregas' : `/pedidos/${delivery.order_id}`,
      icon: 'truck' as const,
      title: delivery.customer_name,
      detail: `${delivery.delivery_worker_name ?? 'Sem entregador definido'} · ${delivery.scheduled_on === null ? 'Sem data' : delivery.scheduled_on < today ? 'Data vencida' : delivery.scheduled_on === today ? 'Hoje' : formatBusinessDate(delivery.scheduled_on)}`,
      state: deliveryStatusLabels[delivery.status],
    })) ?? []),
    ...(priorities?.inventory.items.map((stockItem) => ({
      key: stockItem.product_id,
      dueOn: '9999-12-31',
      severity: stockItem.quantity_on_hand < 0 ? 0 : stockItem.quantity_on_hand === 0 ? 1 : 5,
      category: 3,
      href: '/estoque',
      icon: 'box' as const,
      title: stockItem.product_name,
      detail: `${formatQuantity(stockItem.quantity_on_hand)} ${stockItem.inventory_unit} disponíveis`,
      state: stockItem.quantity_on_hand < 0 ? 'Estoque negativo' : stockItem.quantity_on_hand === 0 ? 'Sem estoque' : 'Abaixo do mínimo',
    })) ?? []),
  ].sort((left, right) => left.severity - right.severity || left.dueOn.localeCompare(right.dueOn) || left.category - right.category)
  const visiblePriorityActions = priorityActionCandidates.slice(0, 3)
  const remainingPriorityActionCount = Math.max(0, (totalPriorityActionCount ?? 0) - visiblePriorityActions.length)
  const visibleStockItems = priorities?.inventory.items.slice(0, 2) ?? []
  const additionalStockItems = priorities?.inventory.items.slice(2) ?? []
  const renderStockItem = (item: DashboardPriorities['inventory']['items'][number]) => <li key={item.product_id}>
    <span><strong>{item.product_name}</strong><small>{item.quantity_on_hand < 0 ? 'Estoque negativo' : item.quantity_on_hand === 0 ? 'Sem estoque' : item.minimum_stock === null ? 'Quantidade baixa' : `Mínimo: ${formatQuantity(item.minimum_stock)} ${item.inventory_unit}`}</small></span>
    <span className="dashboard-stock-quantity">{formatQuantity(item.quantity_on_hand)} {item.inventory_unit}</span>
  </li>
  return (
    <div className="page-stack dashboard-page">
      <header className="page-heading dashboard-heading">
        <div>
          <p className="eyebrow">{businessDate}</p>
          <h1>Início</h1>
          <p className="page-description">O que precisa de ação hoje?</p>
        </div>
      </header>

      {canManageBusiness(role) ? <>

      <nav className="dashboard-day-summary" aria-label="Prioridades do dia" aria-busy={prioritiesLoading}>
        <Link className="dashboard-summary-link is-followups" to="/atendimento">
          <span className="dashboard-summary-icon"><Icon name="phone" /></span>
          <span className="dashboard-summary-copy"><strong>Lembretes importantes</strong><small>Atrasados ou para hoje</small></span>
          <span className="dashboard-summary-count">{priorities ? priorities.follow_ups.pending_count : '—'}</span>
          <Icon className="dashboard-summary-arrow" name="arrow" />
        </Link>
        <Link className="dashboard-summary-link is-overdue" to="/equipe">
          <span className="dashboard-summary-icon"><Icon name="coin" /></span>
          <span className="dashboard-summary-copy"><strong>Salários atrasados</strong><small>Equipe · {overduePayrollMoney ? <DashboardMoneyValue amount={overduePayrollMoney} /> : prioritiesLoading ? 'Carregando…' : '—'}</small></span>
          <span className="dashboard-summary-count">{priorities ? priorities.payroll.overdue_count : '—'}</span>
          <Icon className="dashboard-summary-arrow" name="arrow" />
        </Link>
        <Link className="dashboard-summary-link is-due-today" to="/financeiro/receber">
          <span className="dashboard-summary-icon"><Icon name="clock" /></span>
          <span className="dashboard-summary-copy"><strong>Parcelas dos clientes</strong><small>Valores que vencem hoje · {receivablesDueTodayMoney ? <DashboardMoneyValue amount={receivablesDueTodayMoney} /> : prioritiesLoading ? 'Carregando…' : '—'}</small></span>
          <span className="dashboard-summary-count">{priorities ? priorities.receivables.due_today_count : '—'}</span>
          <Icon className="dashboard-summary-arrow" name="arrow" />
        </Link>
        <Link className="dashboard-summary-link is-deliveries" to="/entregas">
          <span className="dashboard-summary-icon"><Icon name="truck" /></span>
          <span className="dashboard-summary-copy"><strong>Entregas em atenção</strong><small>Precisam de atualização</small></span>
          <span className="dashboard-summary-count">{priorities ? priorities.deliveries.pending_count : '—'}</span>
          <Icon className="dashboard-summary-arrow" name="arrow" />
        </Link>
        <Link className="dashboard-summary-link is-stock" to="/estoque">
          <span className="dashboard-summary-icon"><Icon name="box" /></span>
          <span className="dashboard-summary-copy"><strong>Estoque em atenção</strong><small>Abaixo do mínimo ou negativo</small></span>
          <span className="dashboard-summary-count">{priorities ? priorities.inventory.attention_count : '—'}</span>
          <Icon className="dashboard-summary-arrow" name="arrow" />
        </Link>
      </nav>

      <section className="surface-panel dashboard-financial-overview" aria-labelledby="dashboard-financial-title">
        <div className="section-heading dashboard-financial-heading">
          <div>
            <p className="eyebrow">FINANCEIRO</p>
            <h2 id="dashboard-financial-title">Resumo do mês</h2>
          </div>
          <Link className="quiet-link" to="/financeiro">Ver gráficos <Icon name="arrow" /></Link>
        </div>
        {currentFinancialSummary.loading && <p className="inline-state" aria-live="polite">Carregando resumo…</p>}
        {!currentFinancialSummary.loading && currentFinancialSummary.error && !financialSummary && <div className="inline-state inline-state-error" role="alert"><span>Não foi possível carregar o resumo financeiro.</span><button className="text-button" onClick={() => void loadFinancialSummary()} type="button">Tentar novamente</button></div>}
        {!currentFinancialSummary.loading && financialSummary && <div className="dashboard-financial-metrics" aria-label="Resumo financeiro deste mês">
          <article><span>Faturamento líquido</span>{financialNetMoney && <DashboardMoneyValue amount={financialNetMoney} element="strong" />}</article>
          <article><span>Custo dos produtos</span>{financialProductCostMoney ? <DashboardMoneyValue amount={financialProductCostMoney} element="strong" /> : <strong className="dashboard-financial-unavailable">A conferir</strong>}</article>
          <article><span>Pedidos concluídos</span><strong>{financialSummary.managerial_result.completed_order_count}</strong></article>
          <article><span>Faturamento bruto</span>{financialGrossMoney && <DashboardMoneyValue amount={financialGrossMoney} element="strong" />}</article>
        </div>}
        {currentFinancialSummary.error && financialSummary && <p className="section-footnote" role="status">Resumo desatualizado; a última informação carregada continua visível.</p>}
      </section>

      <div className="dashboard-command-grid dashboard-command-priorities">
        <section className="surface-panel dashboard-action-panel" aria-labelledby="attention-title">
          <div className="section-heading">
            <h2 id="attention-title">Fila de ações do dia</h2>
            <span className="dashboard-today-label"><Icon name="clock" /> {totalPriorityActionCount === null ? 'Hoje' : `${totalPriorityActionCount} itens para resolver`}</span>
          </div>
          {prioritiesLoading && <p className="inline-state" aria-live="polite">Carregando prioridades…</p>}
          {prioritiesError && <div className="dashboard-priority-retry" role="alert"><p>{priorities ? 'Não foi possível atualizar; os indicadores podem estar desatualizados.' : 'Não foi possível carregar as prioridades.'}</p><button className="text-button" onClick={() => void loadPriorities()} type="button">Tentar novamente</button></div>}
          {!prioritiesLoading && priorities && visiblePriorityActions.length > 0 && <ul className="dashboard-action-list dashboard-action-preview">
            {visiblePriorityActions.map((action) => <li key={action.key}>
              <Link to={action.href}>
                <span className={`dashboard-action-symbol${action.severity === 0 ? ' is-overdue' : action.severity === 1 ? ' is-today' : ''}`}><Icon name={action.icon} /></span>
                <span className="dashboard-action-copy"><strong>{action.title}</strong><small>{action.detail}{action.money && <> · <DashboardMoneyValue amount={action.money} /></>}</small></span>
                <span className={`dashboard-row-state${action.severity === 0 ? ' is-overdue' : action.severity === 1 ? ' is-today' : ''}`}>{action.state}</span>
                <Icon className="dashboard-row-arrow" name="arrow" />
              </Link>
            </li>)}
          </ul>}
          {!prioritiesLoading && !prioritiesError && noActions && <p className="dashboard-priority-empty">Nenhum lembrete, pagamento, entrega ou estoque precisa de atenção.</p>}
          {remainingPriorityActionCount > 0 && <p className="section-footnote dashboard-action-preview-note">Mais {remainingPriorityActionCount} ações na fila.</p>}
          <details className="dashboard-action-details">
            <summary>Ver por tipo <span>Lembretes, pagamentos, entregas e estoque</span></summary>
          <div className="dashboard-action-filters" role="group" aria-label="Filtrar fila por tipo de ação">
            {actionFilters.map((filter) => <button aria-pressed={actionFilter === filter.value} key={filter.value} onClick={() => setActionFilter(filter.value)} type="button">{filter.label}</button>)}
          </div>
          <span className="visually-hidden" aria-live="polite" aria-atomic="true">{visibleActionCount !== null && !prioritiesLoading && !prioritiesError ? `${activeActionFilterLabel}: ${visibleActionCount} ${visibleActionCount === 1 ? 'item exibido' : 'itens exibidos'}.` : ''}</span>
          {prioritiesLoading && <p className="inline-state" aria-live="polite">Carregando prioridades…</p>}
          {!prioritiesLoading && prioritiesError && <div className="dashboard-panel-state" role="alert"><span className="empty-icon"><Icon name="clock" /></span><h3>Não foi possível carregar as prioridades</h3><button className="text-button" onClick={() => void loadPriorities()} type="button">Tentar novamente</button></div>}
          {!prioritiesLoading && !prioritiesError && priorities && <div className="dashboard-action-queue">
            {actionFilter === 'all' && noActions ? <div className="dashboard-panel-state is-clear"><span className="empty-icon"><Icon name="check" /></span><h3>Tudo em dia</h3><p>Nenhum lembrete, pagamento, entrega ou produto em falta precisa de atenção.</p></div> : <>
              {(actionFilter === 'followups' || (actionFilter === 'all' && priorities.follow_ups.items.length > 0)) && <section className="dashboard-action-group" aria-labelledby="dashboard-followups-title">
                <div className="dashboard-action-group-heading"><h3 id="dashboard-followups-title">Lembretes</h3><Link className="quiet-link" to="/atendimento">Ver lembretes <Icon name="arrow" /></Link></div>
                {priorities.follow_ups.items.length === 0 ? <p className="dashboard-priority-empty">Nenhum lembrete atrasado ou para hoje.</p> : <ul className="dashboard-action-list">
                  {priorities.follow_ups.items.map((task) => <li key={task.id}>
                    <Link to="/atendimento">
                      <span className={`dashboard-action-symbol${task.due_on < today ? ' is-overdue' : ' is-today'}`}><Icon name="phone" /></span>
                      <span className="dashboard-action-copy"><strong>{task.title}</strong><small>{task.customer_name ?? 'Sem cliente vinculado'}</small></span>
                      <span className={`dashboard-row-state${task.due_on < today ? ' is-overdue' : ' is-today'}`}>{task.due_on < today ? 'Atrasado' : task.due_on === today ? 'Hoje' : formatBusinessDate(task.due_on)}</span>
                      <Icon className="dashboard-row-arrow" name="arrow" />
                    </Link>
                  </li>)}
                </ul>}
                {priorities.follow_ups.pending_count > priorities.follow_ups.items.length && <p className="section-footnote">Mostrando {priorities.follow_ups.items.length} de {priorities.follow_ups.pending_count} lembretes para hoje ou atrasados.</p>}
              </section>}

              {(actionFilter === 'receivables' || (actionFilter === 'all' && priorities.receivables.items.length > 0)) && <section className="dashboard-action-group" aria-labelledby="dashboard-receivables-title">
                <div className="dashboard-action-group-heading"><h3 id="dashboard-receivables-title">Parcelas que clientes ainda devem</h3><Link className="quiet-link" to="/financeiro/receber">Ver parcelas <Icon name="arrow" /></Link></div>
                {priorities.receivables.items.length === 0 ? <p className="dashboard-priority-empty">Nenhuma parcela atrasada ou para pagar hoje.</p> : <ul className="dashboard-action-list">
                  {priorities.receivables.items.map((item) => {
                    const amount = formatDashboardMoney(item.balance_cents, 'incoming', `Valor a receber de ${item.customer_name}`)
                    return <li key={item.installment_id}>
                      <Link to={demoPreview ? '/financeiro/receber' : `/pedidos/${item.order_id}`}>
                        <span className={`dashboard-action-symbol${item.overdue ? ' is-overdue' : ' is-today'}`}><Icon name="coin" /></span>
                        <span className="dashboard-action-copy"><strong>{item.customer_name}</strong><small>Parcela {item.installment_number} · {formatBusinessDate(item.due_on)}</small></span>
                        <span className="dashboard-action-meta"><DashboardMoneyValue amount={amount} element="strong" /><span className={`dashboard-row-state${item.overdue ? ' is-overdue' : ' is-today'}`}>{item.overdue ? 'Atrasado' : 'Vence hoje'}</span></span>
                        <Icon className="dashboard-row-arrow" name="arrow" />
                      </Link>
                    </li>
                  })}
                </ul>}
                {priorities.receivables.overdue_count + priorities.receivables.due_today_count > priorities.receivables.items.length && <p className="section-footnote">Mostrando {priorities.receivables.items.length} de {priorities.receivables.overdue_count + priorities.receivables.due_today_count} parcelas prioritárias.</p>}
              </section>}

              {(actionFilter === 'receivables' || (actionFilter === 'all' && priorities.payroll.items.some((item) => item.paid_on === null && item.due_on <= today))) && <section className="dashboard-action-group" aria-labelledby="dashboard-payroll-title">
                <div className="dashboard-action-group-heading"><h3 id="dashboard-payroll-title">Salários da equipe</h3><Link className="quiet-link" to="/equipe">Ver equipe <Icon name="arrow" /></Link></div>
                {priorities.payroll.items.filter((item) => item.paid_on === null && item.due_on <= today).length === 0 ? <p className="dashboard-priority-empty">Nenhum salário atrasado ou para pagar hoje.</p> : <ul className="dashboard-action-list">
                  {priorities.payroll.items.filter((item) => item.paid_on === null && item.due_on <= today).map((item) => {
                    const amount = formatDashboardMoney(item.amount_cents, 'outgoing', `Salário de ${item.name}`)
                    return <li key={`${item.worker_id}-${item.period_start}`}>
                      <Link to="/equipe">
                        <span className={`dashboard-action-symbol${item.due_on < today ? ' is-overdue' : ' is-today'}`}><Icon name="coin" /></span>
                        <span className="dashboard-action-copy"><strong>{item.name}</strong><small>Salário · {formatBusinessDate(item.due_on)}</small></span>
                        <span className="dashboard-action-meta"><DashboardMoneyValue amount={amount} element="strong" /><span className={`dashboard-row-state${item.due_on < today ? ' is-overdue' : ' is-today'}`}>{item.due_on < today ? 'Atrasado' : 'Vence hoje'}</span></span>
                        <Icon className="dashboard-row-arrow" name="arrow" />
                      </Link>
                    </li>
                  })}
                </ul>}
              </section>}

              {(actionFilter === 'deliveries' || (actionFilter === 'all' && priorities.deliveries.items.length > 0)) && <section className="dashboard-action-group" aria-labelledby="dashboard-deliveries-title">
                <div className="dashboard-action-group-heading"><h3 id="dashboard-deliveries-title">Entregas</h3><Link className="quiet-link" to="/entregas">Ver fila <Icon name="arrow" /></Link></div>
                {priorities.deliveries.items.length === 0 ? <p className="dashboard-priority-empty">Nenhuma entrega precisa de atualização.</p> : <ul className="dashboard-action-list">
                  {priorities.deliveries.items.map((delivery) => <li key={delivery.delivery_id}>
                    <Link to={demoPreview ? '/entregas' : `/pedidos/${delivery.order_id}`}>
                      <span className={`dashboard-action-symbol${delivery.status === 'attempted' ? ' is-overdue' : ' is-delivery'}`}><Icon name="truck" /></span>
                      <span className="dashboard-action-copy"><strong>{delivery.customer_name}</strong><small>{delivery.delivery_worker_name ?? 'Entrega a acompanhar'}</small></span>
                      <span className="dashboard-action-meta"><span className={`dashboard-row-state${delivery.status === 'attempted' ? ' is-overdue' : ' is-delivery'}`}>{deliveryStatusLabels[delivery.status]}</span><small>{delivery.scheduled_on === null ? 'Sem data' : delivery.scheduled_on < today ? 'Data vencida' : delivery.scheduled_on === today ? 'Hoje' : formatBusinessDate(delivery.scheduled_on)}</small></span>
                      <Icon className="dashboard-row-arrow" name="arrow" />
                    </Link>
                  </li>)}
                </ul>}
                {priorities.deliveries.pending_count > priorities.deliveries.items.length && <p className="section-footnote">Mostrando {priorities.deliveries.items.length} de {priorities.deliveries.pending_count} entregas em atenção.</p>}
              </section>}

              {(actionFilter === 'inventory' || (actionFilter === 'all' && priorities.inventory.attention_count > 0)) && <section className="dashboard-action-group" aria-labelledby="dashboard-inventory-title">
                <div className="dashboard-action-group-heading"><h3 id="dashboard-inventory-title">Estoque</h3><Link className="quiet-link" to="/estoque">Abrir estoque <Icon name="arrow" /></Link></div>
                {priorities.inventory.items.length === 0 ? <p className="dashboard-priority-empty">Nenhum produto em atenção.</p> : <ul className="dashboard-action-list">
                  {priorities.inventory.items.map((item) => <li key={item.product_id}>
                    <Link to="/estoque">
                      <span className={`dashboard-action-symbol${item.quantity_on_hand < 0 ? ' is-overdue' : ''}`}><Icon name="box" /></span>
                      <span className="dashboard-action-copy"><strong>{item.product_name}</strong><small>{item.quantity_on_hand < 0 ? 'Estoque negativo' : item.quantity_on_hand === 0 ? 'Sem estoque' : item.minimum_stock === null ? 'Quantidade baixa' : `Mínimo: ${formatQuantity(item.minimum_stock)} ${item.inventory_unit}`}</small></span>
                      <span className={`dashboard-row-state${item.quantity_on_hand < 0 ? ' is-overdue' : ''}`}>{formatQuantity(item.quantity_on_hand)} {item.inventory_unit}</span>
                      <Icon className="dashboard-row-arrow" name="arrow" />
                    </Link>
                  </li>)}
                </ul>}
                {priorities.inventory.attention_count > priorities.inventory.items.length && <p className="section-footnote">Mostrando {priorities.inventory.items.length} de {priorities.inventory.attention_count} produtos em atenção.</p>}
              </section>}
            </>}
          </div>}
          </details>
        </section>

      </div>

      <div className="dashboard-columns dashboard-operations-grid">
        <section className="surface-panel dashboard-recent-panel" aria-labelledby="dashboard-recent-orders-title">
          <div className="section-heading">
            <h2 id="dashboard-recent-orders-title">Pedidos recentes</h2>
            {canManageBusiness(role) && <Link className="quiet-link" to="/pedidos">Ver todos <Icon name="arrow" /></Link>}
          </div>
          {!canManageBusiness(role) ? <div className="dashboard-panel-state"><span className="empty-icon"><Icon name="shield" /></span><h3>Acesso indisponível</h3><p>Seu perfil atual não tem permissão para consultar pedidos recentes.</p></div> : <>
            {currentRecentOrders.loading && <p className="inline-state" aria-live="polite">Carregando pedidos recentes…</p>}
            {!currentRecentOrders.loading && currentRecentOrders.error && <div className="dashboard-panel-state" role="alert"><span className="empty-icon"><Icon name="bag" /></span><h3>Não foi possível carregar os pedidos</h3><p>Tente novamente para atualizar esta lista.</p><button className="text-button" onClick={() => void loadRecentOrders()} type="button">Tentar novamente</button></div>}
            {!currentRecentOrders.loading && !currentRecentOrders.error && currentRecentOrders.orders.length === 0 && <div className="dashboard-panel-state"><span className="empty-icon"><Icon name="bag" /></span><h3>Ainda não há pedidos registrados</h3><p>Os últimos quatro pedidos aparecerão aqui.</p><Link className="quiet-link" to="/pedidos/novo">Criar primeiro pedido <Icon name="arrow" /></Link></div>}
            {!currentRecentOrders.loading && !currentRecentOrders.error && currentRecentOrders.orders.length > 0 && <details className="dashboard-recent-details">
              <summary>Ver últimos pedidos <span>{currentRecentOrders.orders.length} registros</span></summary>
              <ul className="dashboard-recent-order-list">
                {currentRecentOrders.orders.map((order) => <li key={order.id}>
                  <Link to={demoPreview ? '/pedidos' : `/pedidos/${order.id}`}>
                    <span className={`dashboard-order-dot${order.status === 'cancelled' ? ' is-cancelled' : ''}`} aria-hidden="true" />
                    <span className="dashboard-recent-order-copy"><strong>{order.customer_name_snapshot}</strong><small>{formatOrderDate(order.created_at)} · {order.requires_delivery ? 'Entrega' : 'Retirada'}</small></span>
                    <span className={`dashboard-recent-order-status${order.status === 'cancelled' ? ' is-cancelled' : ''}`}>{order.status === 'cancelled' ? 'Cancelado' : order.status === 'completed' ? 'Concluído' : 'Pedido ativo'}</span>
                    <Icon className="dashboard-row-arrow" name="arrow" />
                  </Link>
                </li>)}
              </ul>
            </details>}
          </>}
        </section>
        <section className="surface-panel stock-panel" aria-labelledby="stock-title">
          <div className="section-heading section-heading-compact">
            <div>
              <p className="eyebrow">ESTOQUE</p>
              <h2 id="stock-title">Nível de atenção</h2>
            </div>
            {prioritiesLoading || prioritiesError ? <Icon className="section-icon" name="box" /> : <span className="dashboard-stock-count" aria-label={`${priorities?.inventory.attention_count ?? 0} produtos em atenção`}>{priorities?.inventory.attention_count ?? 0}</span>}
          </div>
          {prioritiesLoading && <p className="inline-state" aria-live="polite">Conferindo estoque…</p>}
          {!prioritiesLoading && prioritiesError && <div className="small-empty-state"><p>As informações de estoque fazem parte da atualização geral do painel. Use “Tentar novamente” acima.</p></div>}
          {!prioritiesLoading && !prioritiesError && priorities && priorities.inventory.tracked_product_count === 0 && <div className="small-empty-state"><p>Nenhum produto está configurado para controle de estoque.</p><Link className="quiet-link" to="/catalogo">Configurar produtos <Icon name="arrow" /></Link></div>}
          {!prioritiesLoading && !prioritiesError && priorities && priorities.inventory.tracked_product_count > 0 && priorities.inventory.attention_count === 0 && <div className="small-empty-state"><p>Todos os produtos têm quantidade suficiente.{priorities.inventory.without_minimum_count > 0 ? ` Produto sem quantidade mínima ainda gera alerta quando chega a zero.` : ''}</p><Link className="quiet-link" to="/estoque">Abrir estoque <Icon name="arrow" /></Link></div>}
          {!prioritiesLoading && !prioritiesError && priorities && priorities.inventory.attention_count > 0 && <>
            <ul className="dashboard-stock-list">{visibleStockItems.map(renderStockItem)}</ul>
            {additionalStockItems.length > 0 && <details className="dashboard-stock-details">
              <summary>Ver mais produtos <span>{Math.min(additionalStockItems.length, priorities.inventory.attention_count - visibleStockItems.length)} produtos</span></summary>
              <ul className="dashboard-stock-list">{additionalStockItems.map(renderStockItem)}</ul>
              {priorities.inventory.attention_count > priorities.inventory.items.length && <p className="section-footnote">Mostrando {priorities.inventory.items.length} de {priorities.inventory.attention_count} produtos em atenção.</p>}
            </details>}
            {priorities.inventory.without_minimum_count > 0 && <p className="section-footnote">Produto sem quantidade mínima ainda gera alerta quando chega a zero.</p>}
            <Link className="quiet-link" to="/estoque">Ver produtos em atenção <Icon name="arrow" /></Link>
          </>}
        </section>
      </div>
      </> : <section className="surface-panel dashboard-role-note" aria-label="Resumo do dia">
        <h2>Resumo de gestão</h2>
        <p>O financeiro, os pagamentos, as entregas e o estoque aparecem para quem tem acesso de proprietário.</p>
      </section>}

      <section className="quick-links" aria-label="Atalhos">
        <Link className="quick-link" to="/atendimento"><Icon name="phone" /><span><strong>Atendimento</strong><small>Chamadas e lembretes</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
        <Link className="quick-link" to="/pedidos"><Icon name="bag" /><span><strong>Pedidos</strong><small>Vendas e entregas</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
        <Link className="quick-link" to="/clientes"><Icon name="people" /><span><strong>Clientes</strong><small>Cadastros e histórico</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
        <Link className="quick-link" to="/catalogo"><Icon name="box" /><span><strong>Catálogo</strong><small>Produtos e categorias</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
      </section>
    </div>
  )
}
