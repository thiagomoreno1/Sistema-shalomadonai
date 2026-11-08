import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { DashboardTrends, type DashboardTrendDay, type DashboardTrendPeriod } from '../components/DashboardTrends'
import { formatBRLExact, formatBusinessDate } from '../lib/formatters'
import { createDemoRevenueTrendDays, loadDashboardRevenueTrendDays, type DashboardRevenueTrendDay } from '../lib/dashboardRevenueTrends'
import { useBusinessToday } from '../lib/useBusinessToday'
import { useVisibleAutoRefresh } from '../lib/useVisibleAutoRefresh'
import { isDemoPreviewEnabled } from '../lib/demoPreview'
import { supabaseClient } from '../lib/supabase'
import './DashboardDesignReferencesPage.css'

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

type DashboardFinancialSummary = {
  receipts: { amount_cents: string }
  outflows: { purchase_cents: string }
  managerial_result: {
    sales_cents: string
    product_subtotal_cents: string
    customer_delivery_fee_cents: string
    discount_cents: string
    item_cost_cents: string | null
    missing_cost_line_count: number
    returned_order_count: number
    operating_expense_cents: string
    delivery_cost_cents: string
    available: boolean
    result_cents: string | null
  }
}

type ActionFilter = 'all' | 'followups' | 'receivables' | 'deliveries' | 'inventory'
type DashboardPriorityAction = {
  key: string
  dueOn: string
  severity: number
  category: number
  href: string
  icon: 'phone' | 'coin' | 'truck' | 'box'
  title: string
  detail: string
  state: string
}

const actionFilters: Array<{ value: ActionFilter; label: string }> = [
  { value: 'all', label: 'Todos' },
  { value: 'followups', label: 'Retornos' },
  { value: 'receivables', label: 'Clientes e salários' },
  { value: 'deliveries', label: 'Entregas' },
  { value: 'inventory', label: 'Estoque' },
]

const trendPeriodOptions: Array<{ value: DashboardTrendPeriod; label: string }> = [
  { value: 'today', label: 'Hoje' },
  { value: 'week', label: 'Esta semana' },
  { value: 'last_7', label: 'Últimos 7 dias' },
  { value: 'month', label: 'Este mês' },
  { value: 'last_30', label: 'Últimos 30 dias' },
  { value: 'year', label: 'Este ano' },
]

const deliveryStatusLabels: Record<DashboardPriorities['deliveries']['items'][number]['status'], string> = {
  awaiting_separation: 'Aguardando separação',
  ready: 'Pronta para despacho',
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

function createDemoTrends(startOn: string, dayCount: number): DashboardTrendDay[] {
  const orders = [0, 1, 2, 1, 3, 2, 4]
  const receipts = [0, 125000, 86000, 250000, 0, 340000, 422000]
  const outflows = [45000, 0, 95000, 145000, 62000, 88000, 73000]
  return Array.from({ length: dayCount }, (_, index) => {
    const patternIndex = index % orders.length
    const orderCount = orders[patternIndex]
    return {
      business_date: shiftCalendarDate(startOn, index),
      order_count: BigInt(orderCount),
      receipts_cents: BigInt(receipts[patternIndex]),
      paid_outflows_cents: BigInt(outflows[patternIndex]),
    }
  })
}

function createDemoFinancialSummary(days: DashboardTrendDay[]): DashboardFinancialSummary {
  const orders = days.reduce((total, day) => total + day.order_count, 0n)
  const grossSales = orders * 230000n
  const deliveryFees = orders * 5000n
  const discounts = orders * 12000n
  const sales = grossSales - discounts
  const paidOutflows = days.reduce((total, day) => total + day.paid_outflows_cents, 0n)
  const itemCost = sales * 55n / 100n
  const inventoryPurchases = paidOutflows / 4n
  const operatingExpenses = paidOutflows * 55n / 100n
  const deliveryCost = paidOutflows - operatingExpenses - inventoryPurchases
  return {
    receipts: { amount_cents: days.reduce((total, day) => total + day.receipts_cents, 0n).toString() },
    outflows: { purchase_cents: inventoryPurchases.toString() },
    managerial_result: {
      sales_cents: sales.toString(),
      product_subtotal_cents: (grossSales - deliveryFees).toString(),
      customer_delivery_fee_cents: deliveryFees.toString(),
      discount_cents: discounts.toString(),
      item_cost_cents: itemCost.toString(),
      missing_cost_line_count: 0,
      returned_order_count: 0,
      operating_expense_cents: operatingExpenses.toString(),
      delivery_cost_cents: deliveryCost.toString(),
      available: true,
      result_cents: (sales - itemCost - operatingExpenses - deliveryCost).toString(),
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

function formatOrderDate(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'America/Sao_Paulo' }).format(new Date(value))
}

function shiftCalendarDate(value: string, offset: number) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function getTrendDateRange(today: string, period: DashboardTrendPeriod) {
  const date = new Date(`${today}T12:00:00Z`)
  const weekday = date.getUTCDay()
  const startOn = period === 'today'
    ? today
    : period === 'week'
      ? shiftCalendarDate(today, -((weekday + 6) % 7))
      : period === 'last_7'
      ? shiftCalendarDate(today, -6)
      : period === 'month'
        ? `${today.slice(0, 7)}-01`
        : period === 'last_30'
          ? shiftCalendarDate(today, -29)
          : `${today.slice(0, 4)}-01-01`
  const dayCount = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${startOn}T00:00:00Z`)) / 86_400_000) + 1
  return { startOn, dayCount, label: trendPeriodOptions.find((option) => option.value === period)?.label ?? 'Últimos 7 dias' }
}

function getTrendDateChunks(startOn: string, dayCount: number) {
  const chunks: Array<{ startOn: string; endOn: string; dayCount: number }> = []
  for (let offset = 0; offset < dayCount; offset += 30) {
    const chunkDayCount = Math.min(30, dayCount - offset)
    const chunkStartOn = shiftCalendarDate(startOn, offset)
    chunks.push({ startOn: chunkStartOn, endOn: shiftCalendarDate(chunkStartOn, chunkDayCount - 1), dayCount: chunkDayCount })
  }
  return chunks
}

function readTrendInteger(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  throw new Error('Invalid daily aggregate.')
}

function readTrendDays(value: unknown, startOn: string, dayCount: number): DashboardTrendDay[] {
  if (!Array.isArray(value) || value.length !== dayCount) throw new Error('Incomplete daily series.')
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
  const demoPreview = role === 'owner' && isDemoPreviewEnabled()
  const today = useBusinessToday()
  const businessDate = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeZone: 'America/Sao_Paulo' }).format(new Date(`${today}T12:00:00Z`))
  const prioritiesScopeKey = `${businessId}:${role}:${today}`
  const prioritiesRequestId = useRef(0)
  const [priorityState, setPriorityState] = useState<{ scopeKey: string; loading: boolean; error: boolean; data: DashboardPriorities | null }>({ scopeKey: '', loading: true, error: false, data: null })
  const currentPriorities = priorityState.scopeKey === prioritiesScopeKey ? priorityState : { loading: true, error: false, data: null }
  const priorities = currentPriorities.data
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
  const [trendPeriod, setTrendPeriod] = useState<DashboardTrendPeriod>('last_7')
  const { startOn: trendStartOn, dayCount: trendDayCount, label: trendPeriodLabel } = getTrendDateRange(today, trendPeriod)
  const trendScopeKey = `${businessId}:${trendStartOn}:${today}`
  const trendRequestId = useRef(0)
  const [trendState, setTrendState] = useState<{ scopeKey: string; loading: boolean; error: boolean; days: DashboardTrendDay[] }>({ scopeKey: '', loading: true, error: false, days: [] })
  const currentTrends = trendState.scopeKey === trendScopeKey ? trendState : { loading: true, error: false, days: [] }
  const revenueTrendRequestId = useRef(0)
  const [revenueTrendState, setRevenueTrendState] = useState<{ scopeKey: string; loading: boolean; error: boolean; days: DashboardRevenueTrendDay[] }>({ scopeKey: '', loading: true, error: false, days: [] })
  const currentRevenueTrends = revenueTrendState.scopeKey === trendScopeKey ? revenueTrendState : { loading: true, error: false, days: [] }
  const financialSummaryScopeKey = `${businessId}:${role}:${trendStartOn}:${today}`
  const financialSummaryRequestId = useRef(0)
  const [financialSummaryState, setFinancialSummaryState] = useState<{ scopeKey: string; loading: boolean; error: boolean; data: DashboardFinancialSummary | null }>({ scopeKey: '', loading: true, error: false, data: null })
  const currentFinancialSummary = financialSummaryState.scopeKey === financialSummaryScopeKey
    ? financialSummaryState
    : { loading: true, error: false, data: null }

  const loadTrends = useCallback(async (silent = false) => {
    const requestId = ++trendRequestId.current
    if (role !== 'owner') {
      setTrendState({ scopeKey: trendScopeKey, loading: false, error: false, days: [] })
      return
    }
    if (!silent) setTrendState({ scopeKey: trendScopeKey, loading: true, error: false, days: [] })
    try {
      if (demoPreview) {
        setTrendState({ scopeKey: trendScopeKey, loading: false, error: false, days: createDemoTrends(trendStartOn, trendDayCount) })
        return
      }
      const client = supabaseClient
      if (!client) throw new Error('Authentication service unavailable.')
      const chunks = getTrendDateChunks(trendStartOn, trendDayCount)
      const dailyResults = await Promise.all(chunks.map(async (chunk) => {
        const { data, error } = await client.rpc('get_dashboard_daily_trends', {
          p_business_id: businessId,
          p_start_on: chunk.startOn,
          p_end_on: chunk.endOn,
        })
        if (error) throw error
        return readTrendDays(data, chunk.startOn, chunk.dayCount)
      }))
      const days = dailyResults.flat()
      if (days.length !== trendDayCount) throw new Error('Incomplete daily series.')
      if (requestId === trendRequestId.current) setTrendState({ scopeKey: trendScopeKey, loading: false, error: false, days })
    } catch {
      if (!silent && requestId === trendRequestId.current) setTrendState({ scopeKey: trendScopeKey, loading: false, error: true, days: [] })
    }
  }, [businessId, demoPreview, role, today, trendDayCount, trendScopeKey, trendStartOn])

  const loadRevenueTrends = useCallback(async (silent = false) => {
    const requestId = ++revenueTrendRequestId.current
    if (role !== 'owner') {
      setRevenueTrendState({ scopeKey: trendScopeKey, loading: false, error: false, days: [] })
      return
    }
    if (!silent) setRevenueTrendState({ scopeKey: trendScopeKey, loading: true, error: false, days: [] })
    try {
      if (demoPreview) {
        setRevenueTrendState({ scopeKey: trendScopeKey, loading: false, error: false, days: createDemoRevenueTrendDays(trendStartOn, trendDayCount) })
        return
      }
      const client = supabaseClient
      if (!client) throw new Error('Authentication service unavailable.')
      const days = await loadDashboardRevenueTrendDays(trendStartOn, trendDayCount, async (startOn, endOn) => {
        const { data, error } = await client.rpc('get_dashboard_revenue_trends', {
          p_business_id: businessId,
          p_start_on: startOn,
          p_end_on: endOn,
        })
        return { data, error }
      })
      if (requestId === revenueTrendRequestId.current) setRevenueTrendState({ scopeKey: trendScopeKey, loading: false, error: false, days })
    } catch {
      if (!silent && requestId === revenueTrendRequestId.current) setRevenueTrendState({ scopeKey: trendScopeKey, loading: false, error: true, days: [] })
    }
  }, [businessId, demoPreview, role, trendDayCount, trendScopeKey, trendStartOn])

  const loadFinancialSummary = useCallback(async (silent = false) => {
    const requestId = ++financialSummaryRequestId.current
    if (role !== 'owner') return
    if (!silent) setFinancialSummaryState({ scopeKey: financialSummaryScopeKey, loading: true, error: false, data: null })
    try {
      if (demoPreview) {
        setFinancialSummaryState({ scopeKey: financialSummaryScopeKey, loading: false, error: false, data: createDemoFinancialSummary(createDemoTrends(trendStartOn, trendDayCount)) })
        return
      }
      if (!supabaseClient) throw new Error('Authentication service unavailable.')
      const { data, error } = await supabaseClient.rpc('get_financial_report_summary', {
        p_business_id: businessId,
        p_start_on: trendStartOn,
        p_end_on: today,
      })
      if (error || !data) throw error
      const summary = data as DashboardFinancialSummary
      if (requestId === financialSummaryRequestId.current) setFinancialSummaryState({ scopeKey: financialSummaryScopeKey, loading: false, error: false, data: summary })
    } catch {
      if (!silent && requestId === financialSummaryRequestId.current) setFinancialSummaryState({ scopeKey: financialSummaryScopeKey, loading: false, error: true, data: null })
    }
  }, [businessId, demoPreview, financialSummaryScopeKey, role, today, trendDayCount, trendStartOn])

  const loadPriorities = useCallback(async (silent = false) => {
    const requestId = ++prioritiesRequestId.current
    if (role !== 'owner') {
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
    if (role !== 'owner') {
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

  const refreshDashboard = useCallback(async () => {
    await Promise.allSettled([
      loadPriorities(true),
      loadRecentOrders(true),
      loadTrends(true),
      loadRevenueTrends(true),
      loadFinancialSummary(true),
    ])
  }, [loadFinancialSummary, loadPriorities, loadRecentOrders, loadRevenueTrends, loadTrends])
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
    void loadTrends()
    return () => { trendRequestId.current += 1 }
  }, [loadTrends])
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    void loadRevenueTrends()
    return () => { revenueTrendRequestId.current += 1 }
  }, [loadRevenueTrends])
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    void loadFinancialSummary()
    return () => { financialSummaryRequestId.current += 1 }
  }, [loadFinancialSummary])

  const financialSummary = currentFinancialSummary.data?.managerial_result
  const grossBillingCents = financialSummary
    ? BigInt(financialSummary.product_subtotal_cents) + BigInt(financialSummary.customer_delivery_fee_cents)
    : null
  const netBillingCents = financialSummary ? BigInt(financialSummary.sales_cents) : null
  const productCostCents = financialSummary?.item_cost_cents === null || !financialSummary ? null : BigInt(financialSummary.item_cost_cents)
  const grossProfitCents = financialSummary?.available && productCostCents !== null && netBillingCents !== null ? netBillingCents - productCostCents : null
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
      detail: `${followUp.customer_name ?? 'Sem cliente vinculado'} · ${followUp.due_on < today ? 'Atrasado' : followUp.due_on === today ? 'Hoje' : formatBusinessDate(followUp.due_on)}`,
      state: 'Retorno',
    })) ?? []),
    ...(priorities?.receivables.items.map((receivable) => ({
      key: receivable.installment_id,
      dueOn: receivable.due_on,
      severity: receivable.overdue ? 0 : 2,
      category: 1,
      href: demoPreview ? '/financeiro' : `/pedidos/${receivable.order_id}`,
      icon: 'coin' as const,
      title: receivable.customer_name,
      detail: `Parcela ${receivable.installment_number} · ${formatBusinessDate(receivable.due_on)} · ${formatBRLExact(receivable.balance_cents)}`,
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
      detail: `${formatBusinessDate(item.due_on)} · ${formatBRLExact(item.amount_cents)}`,
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
      severity: stockItem.quantity_on_hand < 0 ? 0 : 5,
      category: 3,
      href: '/estoque',
      icon: 'box' as const,
      title: stockItem.product_name,
      detail: `${formatQuantity(stockItem.quantity_on_hand)} ${stockItem.inventory_unit} disponíveis`,
      state: stockItem.quantity_on_hand < 0 ? 'Estoque negativo' : 'Abaixo do mínimo',
    })) ?? []),
  ].sort((left, right) => left.severity - right.severity || left.dueOn.localeCompare(right.dueOn) || left.category - right.category)
  const visiblePriorityActions = priorityActionCandidates.slice(0, 3)
  const remainingPriorityActionCount = Math.max(0, (totalPriorityActionCount ?? 0) - visiblePriorityActions.length)
  const visibleStockItems = priorities?.inventory.items.slice(0, 2) ?? []
  const additionalStockItems = priorities?.inventory.items.slice(2) ?? []
  const renderStockItem = (item: DashboardPriorities['inventory']['items'][number]) => <li key={item.product_id}>
    <span><strong>{item.product_name}</strong><small>{item.quantity_on_hand < 0 ? 'Estoque negativo' : item.minimum_stock === null ? 'Defina um mínimo para receber alerta' : `Estoque mínimo: ${formatQuantity(item.minimum_stock)} ${item.inventory_unit}`}</small></span>
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
        {role === 'owner' && <div className="dashboard-heading-actions">
          <label className="dashboard-range-picker" htmlFor="dashboard-period">
            <span>Período</span>
            <select id="dashboard-period" value={trendPeriod} onChange={(event) => setTrendPeriod(event.target.value as DashboardTrendPeriod)}>
              {trendPeriodOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>}
      </header>

      {role === 'owner' ? <>

      <nav className="dashboard-day-summary" aria-label="Prioridades do dia" aria-busy={prioritiesLoading}>
        <Link className="dashboard-summary-link is-followups" to="/atendimento">
          <span className="dashboard-summary-icon"><Icon name="phone" /></span>
          <span className="dashboard-summary-copy"><strong>Retornos prioritários</strong><small>Atrasados ou de hoje</small></span>
          <span className="dashboard-summary-count">{priorities ? priorities.follow_ups.pending_count : '—'}</span>
          <Icon className="dashboard-summary-arrow" name="arrow" />
        </Link>
        <Link className="dashboard-summary-link is-overdue" to="/equipe">
          <span className="dashboard-summary-icon"><Icon name="coin" /></span>
          <span className="dashboard-summary-copy"><strong>Salários atrasados</strong><small>Equipe · {priorities ? formatBRLExact(priorities.payroll.overdue_amount_cents) : prioritiesLoading ? 'Carregando…' : 'Indisponível'}</small></span>
          <span className="dashboard-summary-count">{priorities ? priorities.payroll.overdue_count : '—'}</span>
          <Icon className="dashboard-summary-arrow" name="arrow" />
        </Link>
        <Link className="dashboard-summary-link is-due-today" to="/financeiro">
          <span className="dashboard-summary-icon"><Icon name="clock" /></span>
          <span className="dashboard-summary-copy"><strong>Parcelas dos clientes</strong><small>Valores que vencem hoje · {priorities ? formatBRLExact(priorities.receivables.due_today_balance_cents) : prioritiesLoading ? 'Carregando…' : 'Indisponível'}</small></span>
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

      <div className="dashboard-command-grid dashboard-command-priorities">
        <section className="surface-panel dashboard-action-panel" aria-labelledby="attention-title">
          <div className="section-heading">
            <h2 id="attention-title">Fila de ações do dia</h2>
            <span className="dashboard-today-label"><Icon name="clock" /> {totalPriorityActionCount === null ? 'Hoje' : `${totalPriorityActionCount} pendências`}</span>
          </div>
          {prioritiesLoading && <p className="inline-state" aria-live="polite">Carregando prioridades…</p>}
          {prioritiesError && <div className="dashboard-priority-retry" role="alert"><p>{priorities ? 'Não foi possível atualizar; os indicadores podem estar desatualizados.' : 'Não foi possível carregar as prioridades.'}</p><button className="text-button" onClick={() => void loadPriorities()} type="button">Tentar novamente</button></div>}
          {!prioritiesLoading && priorities && visiblePriorityActions.length > 0 && <ul className="dashboard-action-list dashboard-action-preview">
            {visiblePriorityActions.map((action) => <li key={action.key}>
              <Link to={action.href}>
                <span className={`dashboard-action-symbol${action.severity === 0 ? ' is-overdue' : action.severity === 1 ? ' is-today' : ''}`}><Icon name={action.icon} /></span>
                <span className="dashboard-action-copy"><strong>{action.title}</strong><small>{action.detail}</small></span>
                <span className={`dashboard-row-state${action.severity === 0 ? ' is-overdue' : action.severity === 1 ? ' is-today' : ''}`}>{action.state}</span>
                <Icon className="dashboard-row-arrow" name="arrow" />
              </Link>
            </li>)}
          </ul>}
          {!prioritiesLoading && !prioritiesError && noActions && <p className="dashboard-priority-empty">Nenhum retorno, pagamento, entrega ou alerta de estoque precisa de atenção.</p>}
          {remainingPriorityActionCount > 0 && <p className="section-footnote dashboard-action-preview-note">Mais {remainingPriorityActionCount} ações na fila.</p>}
          <details className="dashboard-action-details">
            <summary>Ver fila por tipo <span>Retornos, pagamentos, entregas e estoque</span></summary>
          <div className="dashboard-action-filters" role="group" aria-label="Filtrar fila por tipo de ação">
            {actionFilters.map((filter) => <button aria-pressed={actionFilter === filter.value} key={filter.value} onClick={() => setActionFilter(filter.value)} type="button">{filter.label}</button>)}
          </div>
          <span className="visually-hidden" aria-live="polite" aria-atomic="true">{visibleActionCount !== null && !prioritiesLoading && !prioritiesError ? `${activeActionFilterLabel}: ${visibleActionCount} ${visibleActionCount === 1 ? 'item exibido' : 'itens exibidos'}.` : ''}</span>
          {prioritiesLoading && <p className="inline-state" aria-live="polite">Carregando prioridades…</p>}
          {!prioritiesLoading && prioritiesError && <div className="dashboard-panel-state" role="alert"><span className="empty-icon"><Icon name="clock" /></span><h3>Não foi possível carregar as prioridades</h3><button className="text-button" onClick={() => void loadPriorities()} type="button">Tentar novamente</button></div>}
          {!prioritiesLoading && !prioritiesError && priorities && <div className="dashboard-action-queue">
            {actionFilter === 'all' && noActions ? <div className="dashboard-panel-state is-clear"><span className="empty-icon"><Icon name="check" /></span><h3>Tudo em dia</h3><p>Nenhum retorno, pagamento, entrega ou saldo de estoque precisa de atenção.</p></div> : <>
              {(actionFilter === 'followups' || (actionFilter === 'all' && priorities.follow_ups.items.length > 0)) && <section className="dashboard-action-group" aria-labelledby="dashboard-followups-title">
                <div className="dashboard-action-group-heading"><h3 id="dashboard-followups-title">Retornos</h3><Link className="quiet-link" to="/atendimento">Ver retornos <Icon name="arrow" /></Link></div>
                {priorities.follow_ups.items.length === 0 ? <p className="dashboard-priority-empty">Nenhum retorno vencido ou com prazo para hoje.</p> : <ul className="dashboard-action-list">
                  {priorities.follow_ups.items.map((task) => <li key={task.id}>
                    <Link to="/atendimento">
                      <span className={`dashboard-action-symbol${task.due_on < today ? ' is-overdue' : ' is-today'}`}><Icon name="phone" /></span>
                      <span className="dashboard-action-copy"><strong>{task.title}</strong><small>{task.customer_name ?? 'Sem cliente vinculado'}</small></span>
                      <span className={`dashboard-row-state${task.due_on < today ? ' is-overdue' : ' is-today'}`}>{task.due_on < today ? 'Atrasado' : task.due_on === today ? 'Hoje' : formatBusinessDate(task.due_on)}</span>
                      <Icon className="dashboard-row-arrow" name="arrow" />
                    </Link>
                  </li>)}
                </ul>}
                {priorities.follow_ups.pending_count > priorities.follow_ups.items.length && <p className="section-footnote">Mostrando {priorities.follow_ups.items.length} de {priorities.follow_ups.pending_count} retornos com prazo até hoje.</p>}
              </section>}

              {(actionFilter === 'receivables' || (actionFilter === 'all' && priorities.receivables.items.length > 0)) && <section className="dashboard-action-group" aria-labelledby="dashboard-receivables-title">
                <div className="dashboard-action-group-heading"><h3 id="dashboard-receivables-title">Parcelas que clientes ainda devem</h3><Link className="quiet-link" to="/financeiro">Ver parcelas <Icon name="arrow" /></Link></div>
                {priorities.receivables.items.length === 0 ? <p className="dashboard-priority-empty">Nenhuma parcela atrasada ou com vencimento hoje.</p> : <ul className="dashboard-action-list">
                  {priorities.receivables.items.map((item) => <li key={item.installment_id}>
                    <Link to={demoPreview ? '/financeiro' : `/pedidos/${item.order_id}`}>
                      <span className={`dashboard-action-symbol${item.overdue ? ' is-overdue' : ' is-today'}`}><Icon name="coin" /></span>
                      <span className="dashboard-action-copy"><strong>{item.customer_name}</strong><small>Parcela {item.installment_number} · {formatBusinessDate(item.due_on)}</small></span>
                      <span className="dashboard-action-meta"><strong>{formatBRLExact(item.balance_cents)}</strong><span className={`dashboard-row-state${item.overdue ? ' is-overdue' : ' is-today'}`}>{item.overdue ? 'Atrasado' : 'Vence hoje'}</span></span>
                      <Icon className="dashboard-row-arrow" name="arrow" />
                    </Link>
                  </li>)}
                </ul>}
                {priorities.receivables.overdue_count + priorities.receivables.due_today_count > priorities.receivables.items.length && <p className="section-footnote">Mostrando {priorities.receivables.items.length} de {priorities.receivables.overdue_count + priorities.receivables.due_today_count} parcelas prioritárias.</p>}
              </section>}

              {(actionFilter === 'receivables' || (actionFilter === 'all' && priorities.payroll.items.some((item) => item.paid_on === null && item.due_on <= today))) && <section className="dashboard-action-group" aria-labelledby="dashboard-payroll-title">
                <div className="dashboard-action-group-heading"><h3 id="dashboard-payroll-title">Salários da equipe</h3><Link className="quiet-link" to="/equipe">Ver equipe <Icon name="arrow" /></Link></div>
                {priorities.payroll.items.filter((item) => item.paid_on === null && item.due_on <= today).length === 0 ? <p className="dashboard-priority-empty">Nenhum salário vencido ou com vencimento hoje.</p> : <ul className="dashboard-action-list">
                  {priorities.payroll.items.filter((item) => item.paid_on === null && item.due_on <= today).map((item) => <li key={`${item.worker_id}-${item.period_start}`}>
                    <Link to="/equipe">
                      <span className={`dashboard-action-symbol${item.due_on < today ? ' is-overdue' : ' is-today'}`}><Icon name="coin" /></span>
                      <span className="dashboard-action-copy"><strong>{item.name}</strong><small>Salário · {formatBusinessDate(item.due_on)}</small></span>
                      <span className="dashboard-action-meta"><strong>{formatBRLExact(item.amount_cents)}</strong><span className={`dashboard-row-state${item.due_on < today ? ' is-overdue' : ' is-today'}`}>{item.due_on < today ? 'Atrasado' : 'Vence hoje'}</span></span>
                      <Icon className="dashboard-row-arrow" name="arrow" />
                    </Link>
                  </li>)}
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
                      <span className="dashboard-action-copy"><strong>{item.product_name}</strong><small>{item.minimum_stock === null ? 'Defina um mínimo para receber alerta' : `Mínimo: ${formatQuantity(item.minimum_stock)} ${item.inventory_unit}`}</small></span>
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

        <section className="dashboard-financial-overview" aria-labelledby="dashboard-financial-title">
          <div className="section-heading dashboard-financial-heading">
            <div>
              <p className="eyebrow">{trendPeriodLabel.toUpperCase()}</p>
          <h2 id="dashboard-financial-title">Dashboard de faturamento</h2>
              <p className="dashboard-financial-period">{formatBusinessDate(trendStartOn)} a {formatBusinessDate(today)} · atualização automática a cada minuto</p>
            </div>
            <Link className="quiet-link" to="/relatorios">Ver relatórios <Icon name="arrow" /></Link>
          </div>
          {currentFinancialSummary.loading && <p className="inline-state" aria-live="polite">Carregando indicadores financeiros…</p>}
          {!currentFinancialSummary.loading && currentFinancialSummary.error && <div className="dashboard-panel-state" role="alert"><p>Não foi possível carregar os indicadores financeiros.</p><button className="text-button" onClick={() => void loadFinancialSummary()} type="button">Tentar novamente</button></div>}
          {!currentFinancialSummary.loading && !currentFinancialSummary.error && currentFinancialSummary.data && <>
            <div className="indicator-grid dashboard-financial-indicators">
              <article className="indicator-card"><p>Faturamento bruto</p><strong>{grossBillingCents === null ? '—' : formatBRLExact(grossBillingCents)}</strong><span>Produtos e entrega cobrados, antes da redução no preço</span></article>
              <article className="indicator-card"><p>Faturamento líquido</p><strong>{netBillingCents === null ? '—' : formatBRLExact(netBillingCents)}</strong><span>Vendas após a redução no preço dos pedidos</span></article>
              <article className="indicator-card"><p>Custo dos produtos vendidos</p><strong>{productCostCents === null ? 'Indisponível' : formatBRLExact(productCostCents)}</strong><span>Custo cadastrado dos itens entregues ou retirados</span></article>
              <article className="indicator-card"><p>Compras para estoque</p><strong>{formatBRLExact(currentFinancialSummary.data.outflows.purchase_cents ?? '0')}</strong><span>Valor pago por mercadorias recebidas neste período</span></article>
              <article className="indicator-card"><p>Lucro estimado</p><strong>{currentFinancialSummary.data.managerial_result.available && currentFinancialSummary.data.managerial_result.result_cents !== null ? formatBRLExact(currentFinancialSummary.data.managerial_result.result_cents) : 'Indisponível'}</strong><span>Após custo vendido, despesas e entregas · antes de impostos</span></article>
            </div>
            <details className="surface-panel dashboard-result-breakdown">
              <summary>Ver faturamento e despesas</summary>
              <div className="dashboard-result-breakdown-heading"><h3>Composição do período</h3><span>Vendas entregues ou retiradas; despesas pagas</span></div>
              <dl>
                <div><dt>Faturamento bruto</dt><dd>{grossBillingCents === null ? 'Indisponível' : formatBRLExact(grossBillingCents)}</dd></div>
                <div><dt>Redução no preço dos pedidos</dt><dd>− {formatBRLExact(currentFinancialSummary.data.managerial_result.discount_cents)}</dd></div>
                <div className="is-total"><dt>Faturamento líquido</dt><dd>{netBillingCents === null ? 'Indisponível' : formatBRLExact(netBillingCents)}</dd></div>
                <div><dt>Custo dos produtos vendidos</dt><dd>{currentFinancialSummary.data.managerial_result.item_cost_cents === null ? 'Indisponível' : `− ${formatBRLExact(currentFinancialSummary.data.managerial_result.item_cost_cents)}`}</dd></div>
                <div className="is-total"><dt>Lucro bruto</dt><dd>{grossProfitCents === null ? 'Indisponível' : formatBRLExact(grossProfitCents)}</dd></div>
                <div><dt>Despesas da empresa, incluindo salários</dt><dd>− {formatBRLExact(currentFinancialSummary.data.managerial_result.operating_expense_cents)}</dd></div>
                <div><dt>Despesas com entregas</dt><dd>− {formatBRLExact(currentFinancialSummary.data.managerial_result.delivery_cost_cents)}</dd></div>
                <div className="is-total"><dt>Lucro estimado antes de impostos</dt><dd>{currentFinancialSummary.data.managerial_result.available && currentFinancialSummary.data.managerial_result.result_cents !== null ? formatBRLExact(currentFinancialSummary.data.managerial_result.result_cents) : 'Indisponível'}</dd></div>
              </dl>
              <div className="dashboard-purchase-cash-outflow">
                <div><strong>Compras de estoque pagas</strong><span>Saída de caixa · fora do cálculo do lucro até os itens serem vendidos</span></div>
                <strong>{formatBRLExact(currentFinancialSummary.data.outflows.purchase_cents ?? '0')}</strong>
              </div>
              <p className="dashboard-result-note">Bruto = produtos + taxa de entrega cobrada do cliente. Líquido = bruto − valor reduzido no preço dos pedidos. Essa redução diminui o faturamento; não é uma despesa paga. Lucro estimado = líquido − custo dos produtos vendidos − despesas da empresa − entregas pagas. Compra de estoque aparece como saída de caixa e entra no lucro quando o produto for vendido, para não contar o custo duas vezes.</p>
              {!currentFinancialSummary.data.managerial_result.available && <p className="dashboard-result-note">{currentFinancialSummary.data.managerial_result.missing_cost_line_count > 0 ? `Falta informar o custo de ${currentFinancialSummary.data.managerial_result.missing_cost_line_count} produto(s). ` : ''}{currentFinancialSummary.data.managerial_result.returned_order_count > 0 ? `${currentFinancialSummary.data.managerial_result.returned_order_count} pedido(s) têm devolução sem ajuste.` : ''}</p>}
            </details>
          </>}
        </section>
        <DashboardTrends
          days={currentTrends.days}
          revenueDays={currentRevenueTrends.days}
          endOn={today}
          error={currentTrends.error}
          revenueError={currentRevenueTrends.error}
          revenueLoading={currentRevenueTrends.loading}
          loading={currentTrends.loading}
          onRetry={() => void loadTrends()}
          onRetryRevenue={() => void loadRevenueTrends()}
          period={trendPeriod}
          periodLabel={trendPeriodLabel}
          startOn={trendStartOn}
        />

      <div className="dashboard-columns dashboard-operations-grid">
        <section className="surface-panel dashboard-recent-panel" aria-labelledby="dashboard-recent-orders-title">
          <div className="section-heading">
            <h2 id="dashboard-recent-orders-title">Pedidos recentes</h2>
            {role === 'owner' && <Link className="quiet-link" to="/pedidos">Ver todos <Icon name="arrow" /></Link>}
          </div>
          {role !== 'owner' ? <div className="dashboard-panel-state"><span className="empty-icon"><Icon name="shield" /></span><h3>Acesso indisponível</h3><p>Seu perfil atual não tem permissão para consultar pedidos recentes.</p></div> : <>
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
          {prioritiesLoading && <p className="inline-state" aria-live="polite">Carregando saldos…</p>}
          {!prioritiesLoading && prioritiesError && <div className="small-empty-state"><p>As informações de estoque fazem parte da atualização geral do painel. Use “Tentar novamente” acima.</p></div>}
          {!prioritiesLoading && !prioritiesError && priorities && priorities.inventory.tracked_product_count === 0 && <div className="small-empty-state"><p>Nenhum produto está configurado para controle de estoque.</p><Link className="quiet-link" to="/catalogo">Configurar produtos <Icon name="arrow" /></Link></div>}
          {!prioritiesLoading && !prioritiesError && priorities && priorities.inventory.tracked_product_count > 0 && priorities.inventory.attention_count === 0 && <div className="small-empty-state"><p>Nenhum saldo está negativo ou abaixo do mínimo definido.{priorities.inventory.without_minimum_count > 0 ? ` ${priorities.inventory.without_minimum_count} produto(s) ainda sem mínimo definido.` : ''}</p><Link className="quiet-link" to="/estoque">Abrir estoque <Icon name="arrow" /></Link></div>}
          {!prioritiesLoading && !prioritiesError && priorities && priorities.inventory.attention_count > 0 && <>
            <ul className="dashboard-stock-list">{visibleStockItems.map(renderStockItem)}</ul>
            {additionalStockItems.length > 0 && <details className="dashboard-stock-details">
              <summary>Ver mais produtos <span>{Math.min(additionalStockItems.length, priorities.inventory.attention_count - visibleStockItems.length)} produtos</span></summary>
              <ul className="dashboard-stock-list">{additionalStockItems.map(renderStockItem)}</ul>
              {priorities.inventory.attention_count > priorities.inventory.items.length && <p className="section-footnote">Mostrando {priorities.inventory.items.length} de {priorities.inventory.attention_count} produtos em atenção.</p>}
            </details>}
            {priorities.inventory.without_minimum_count > 0 && <p className="section-footnote">{priorities.inventory.without_minimum_count} produto(s) sem mínimo configurado para alerta.</p>}
            <Link className="quiet-link" to="/estoque">Ver produtos em atenção <Icon name="arrow" /></Link>
          </>}
        </section>
      </div>
      </> : <section className="surface-panel dashboard-role-note" aria-label="Resumo do dia">
        <h2>Resumo de gestão</h2>
        <p>Indicadores financeiros, vencimentos, entregas e alertas de estoque ficam disponíveis para o perfil proprietário.</p>
      </section>}

      <section className="quick-links" aria-label="Atalhos">
        <Link className="quick-link" to="/atendimento"><Icon name="phone" /><span><strong>Atendimento</strong><small>Chamadas e retornos</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
        <Link className="quick-link" to="/pedidos"><Icon name="bag" /><span><strong>Pedidos</strong><small>Vendas e entregas</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
        <Link className="quick-link" to="/clientes"><Icon name="people" /><span><strong>Clientes</strong><small>Cadastros e histórico</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
        <Link className="quick-link" to="/catalogo"><Icon name="box" /><span><strong>Catálogo</strong><small>Produtos e categorias</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
      </section>
    </div>
  )
}
