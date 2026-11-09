import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { ReportsNavigation } from '../components/ReportsNavigation'
import { businessLocalDateTimeToIso, formatBRLExact, formatBusinessDate } from '../lib/formatters'
import { useBusinessToday } from '../lib/useBusinessToday'
import { supabaseClient } from '../lib/supabase'

type PeriodMode = 'today' | 'month' | 'year' | 'custom'
type OrderRow = {
  id: string
  customer_name_snapshot: string
  subtotal_cents: number | string
  delivery_fee_cents: number | string
  discount_cents: number | string
  total_cents: number | string
  status: 'open' | 'cancelled'
  created_at: string
  cancelled_at: string | null
}
type PaymentRow = {
  id: string
  order_id: string
  amount_cents: number | string
  received_at: string
  payment_method: string | null
  customer_name: string
}
type InstallmentRow = {
  id: string
  order_id: string
  installment_number: number
  amount_cents: number | string
  due_on: string
}
type AllocationRow = { id: string; installment_id: string; amount_cents: number | string }
type OutflowRow = {
  id: string
  outflow_type: 'purchase' | 'operating_expense' | 'delivery_cost'
  description: string
  category: string | null
  counterparty_name: string | null
  amount_cents: number | string
  paid_on: string
  order_id: string | null
  void_event: { reason: string; created_at: string } | null
}
type OutflowVoidRow = { outflow_id: string; reason: string; created_at: string }
type CompletedOrder = {
  id: string
  customer_name_snapshot: string
  total_cents: number | string
  completed_at: string
  item_cost_cents: bigint | null
  missing_cost_line_count: number
  return_movement_count: number
}
type FulfillmentRow = { order_id: string; delivered_at?: string | null; occurred_at?: string | null }
type OrderLineCost = { order_id: string; unit_cost_snapshot_cents: number | string | null; quantity: number | string }
type ReturnedMovement = { order_id: string; occurred_at: string }
type Summary = {
  start_on: string
  end_on: string
  as_of_on: string
  sales: {
    record_count: number
    active_order_count: number
    active_subtotal_cents: string
    active_delivery_fee_cents: string
    active_discount_cents: string
    active_total_cents: string
    cancelled_order_count: number
    cancelled_total_cents: string
  }
  receipts: { record_count: number; amount_cents: string }
  receivables: { installment_count: number; open_balance_cents: string; overdue_balance_cents: string }
  outflows: {
    record_count: number
    purchase_count: number
    purchase_cents: string
    operating_expense_count: number
    operating_expense_cents: string
    delivery_cost_count: number
    delivery_cost_cents: string
    total_cents: string
  }
  inventory_finance: {
    inventory_value_cents: string | null
    inventory_value_missing_cost_products: number | string
    inventory_loss_cents: string | null
    inventory_loss_movement_count: number | string
    inventory_loss_missing_cost_count: number | string
  }
  cash_movement: { reported_receipts_cents: string; paid_outflows_cents: string; net_recorded_cents: string }
  managerial_result: {
    completed_order_count: number
    sales_cents: string
    product_subtotal_cents: string
    customer_delivery_fee_cents: string
    discount_cents: string
    item_cost_cents: string | null
    missing_cost_line_count: number
    returned_order_count: number
    operating_expense_cents: string
    delivery_cost_cents: string
    inventory_loss_cents: string | null
    available: boolean
    result_cents: string | null
    sales_date_basis: string
    cost_date_basis: string
    expense_date_basis: string
    inventory_purchase_treatment: string
  }
}
type ReceivableRow = InstallmentRow & { customer_name: string; balance_cents: bigint }
type QueryResponse = { data: unknown[] | null; error: unknown; count?: number | null }

async function loadAllPages<T>(loadPage: (from: number, to: number) => PromiseLike<QueryResponse>) {
  const rows: T[] = []
  let from = 0
  let expectedCount: number | null = null
  for (;;) {
    const { data, error, count } = await loadPage(from, from + 999)
    if (error) return { data: null, error }
    const page = (data ?? []) as T[]
    if (expectedCount === null && count != null) expectedCount = count
    rows.push(...page)
    if (page.length === 0) {
      if (expectedCount !== null && rows.length < expectedCount) return { data: null, error: new Error('A paginated report query ended before all rows were read.') }
      return { data: rows, error: null }
    }
    from += page.length
    if (expectedCount !== null && rows.length >= expectedCount) return { data: rows, error: null }
    if (expectedCount === null && page.length < 1000) return { data: rows, error: null }
  }
}

function cents(value: number | string) {
  return BigInt(value)
}

function quantityThousandths(value: number | string) {
  const [integer = '0', fraction = ''] = String(value).split('.')
  if (!/^\d+$/.test(integer) || !/^\d*$/.test(fraction) || fraction.length > 3) {
    throw new Error('A quantidade de um item não pôde ser interpretada.')
  }
  return BigInt(integer) * 1000n + BigInt(fraction.padEnd(3, '0') || '0')
}

function roundMilliCents(value: bigint) {
  return (value + 500n) / 1000n
}

function outflowTypeLabel(type: OutflowRow['outflow_type']) {
  if (type === 'purchase') return 'Compra de estoque'
  if (type === 'operating_expense') return 'Despesa operacional'
  return 'Custo de entrega'
}

function nextBusinessDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

function timestampRange(startOn: string, endOn: string) {
  const startAt = businessLocalDateTimeToIso(`${startOn}T00:00`)
  const endAt = businessLocalDateTimeToIso(`${nextBusinessDate(endOn)}T00:00`)
  if (!startAt || !endAt) throw new Error('O período informado não contém datas válidas.')
  return { startAt, endAt }
}

function reportDate(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value))
}

function csvCell(value: string) {
  let index = 0
  while (index < value.length) {
    const code = value.charCodeAt(index)
    const character = value[index] ?? ''
    if (code <= 32 || code === 0xfeff || /\s/u.test(character)) index += 1
    else break
  }
  const firstSignificantCharacter = value[index] ?? ''
  const hasFormulaPrefix = ['=', '+', '-', '@'].includes(firstSignificantCharacter)
  const startsWithControlCharacter = value.length > 0 && value.charCodeAt(0) <= 31
  const safe = hasFormulaPrefix || startsWithControlCharacter ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}

function csvMoney(value: string | bigint) {
  const amount = BigInt(value)
  const sign = amount < 0n ? '-' : ''
  const absolute = amount < 0n ? -amount : amount
  return `${sign}${absolute / 100n},${(absolute % 100n).toString().padStart(2, '0')}`
}

function getCompletedBilling(summary: Summary) {
  const result = summary.managerial_result
  const grossCents = BigInt(result.product_subtotal_cents) + BigInt(result.customer_delivery_fee_cents)
  const netBillingCents = result.missing_cost_line_count === 0 && result.returned_order_count === 0 && result.item_cost_cents !== null
    ? BigInt(result.sales_cents) - BigInt(result.item_cost_cents)
    : null
  return { grossCents, netBillingCents }
}

function statusLabel(order: OrderRow) {
  if (order.status === 'cancelled') return order.cancelled_at ? `Cancelado em ${reportDate(order.cancelled_at)}` : 'Cancelado'
  return 'Ativo'
}

export function FinancialReportsPage() {
  const { id: businessId } = useBusiness()
  const today = useBusinessToday()
  const firstDayOfMonth = `${today.slice(0, 7)}-01`
  const firstDayOfYear = `${today.slice(0, 4)}-01-01`
  const [periodMode, setPeriodMode] = useState<PeriodMode>('month')
  const [customStartOverride, setCustomStartOverride] = useState<string | null>(null)
  const [customEndOverride, setCustomEndOverride] = useState<string | null>(null)
  const customStart = customStartOverride ?? firstDayOfMonth
  const customEnd = customEndOverride ?? today
  const [summary, setSummary] = useState<Summary | null>(null)
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [receivables, setReceivables] = useState<ReceivableRow[]>([])
  const [outflows, setOutflows] = useState<OutflowRow[]>([])
  const [completedOrders, setCompletedOrders] = useState<CompletedOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reconciliationWarning, setReconciliationWarning] = useState(false)
  const reportRequestId = useRef(0)

  const { startOn, endOn } = useMemo(() => {
    if (periodMode === 'today') return { startOn: today, endOn: today }
    if (periodMode === 'month') return { startOn: firstDayOfMonth, endOn: today }
    if (periodMode === 'year') return { startOn: firstDayOfYear, endOn: today }
    return { startOn: customStart, endOn: customEnd }
  }, [customEnd, customStart, firstDayOfMonth, firstDayOfYear, periodMode, today])
  const rangeError = useMemo(() => {
    if (periodMode !== 'custom') return null
    if (!customStart || !customEnd) return 'Informe as duas datas do intervalo.'
    if (customEnd < customStart) return 'A data final deve ser igual ou posterior à data inicial.'
    return null
  }, [customEnd, customStart, periodMode])

  const loadReport = useCallback(async () => {
    const requestId = reportRequestId.current + 1
    reportRequestId.current = requestId
    const client = supabaseClient
    if (!client) {
      setError('A conexão da empresa não está disponível.')
      setLoading(false)
      return
    }
    if (rangeError || !startOn || !endOn || endOn < startOn) {
      setError(null)
      setSummary(null)
      setOrders([])
      setPayments([])
      setReceivables([])
      setOutflows([])
      setCompletedOrders([])
      setReconciliationWarning(false)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const { startAt, endAt } = timestampRange(startOn, endOn)
      const [orderResult, paymentResult, installmentResult, outflowResult, deliveryResult, pickupResult] = await Promise.all([
        loadAllPages<OrderRow>((from, to) => client.from('orders')
          .select('id, customer_name_snapshot, subtotal_cents, delivery_fee_cents, discount_cents, total_cents, status, created_at, cancelled_at', { count: 'exact' })
          .eq('business_id', businessId)
          .gte('created_at', startAt)
          .lt('created_at', endAt)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to)),
        loadAllPages<PaymentRow>((from, to) => client.from('order_payments')
          .select('id, order_id, amount_cents, received_at, payment_method', { count: 'exact' })
          .eq('business_id', businessId)
          .gte('received_at', startAt)
          .lt('received_at', endAt)
          .order('received_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to)),
        loadAllPages<InstallmentRow>((from, to) => client.from('order_installments')
          .select('id, order_id, installment_number, amount_cents, due_on', { count: 'exact' })
          .eq('business_id', businessId)
          .gte('due_on', startOn)
          .lte('due_on', endOn)
          .order('due_on', { ascending: true })
          .order('order_id', { ascending: true })
          .order('installment_number', { ascending: true })
          .range(from, to)),
        loadAllPages<OutflowRow>((from, to) => client.from('financial_outflows')
          .select('id, outflow_type, description, category, counterparty_name, amount_cents, paid_on, order_id', { count: 'exact' })
          .eq('business_id', businessId)
          .gte('paid_on', startOn)
          .lte('paid_on', endOn)
          .order('paid_on', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to)),
        loadAllPages<FulfillmentRow>((from, to) => client.from('deliveries')
          .select('order_id, delivered_at', { count: 'exact' })
          .eq('business_id', businessId)
          .eq('status', 'delivered')
          .is('canceled_at', null)
          .gte('delivered_at', startAt)
          .lt('delivered_at', endAt)
          .order('order_id', { ascending: true })
          .range(from, to)),
        loadAllPages<FulfillmentRow>((from, to) => client.from('order_events')
          .select('order_id, occurred_at', { count: 'exact' })
          .eq('business_id', businessId)
          .eq('event_type', 'picked_up')
          .gte('occurred_at', startAt)
          .lt('occurred_at', endAt)
          .order('order_id', { ascending: true })
          .range(from, to)),
      ])

      if (reportRequestId.current !== requestId) return
      if (orderResult.error || paymentResult.error || installmentResult.error || outflowResult.error || deliveryResult.error || pickupResult.error) {
        throw new Error('Não foi possível carregar todos os dados deste período. Tente novamente.')
      }

      const loadedOrders = orderResult.data ?? []
      const loadedPayments = paymentResult.data ?? []
      const loadedInstallments = installmentResult.data ?? []
      const rawOutflows = outflowResult.data ?? []
      const outflowVoids: OutflowVoidRow[] = []
      const outflowIds = rawOutflows.map((outflow) => outflow.id)
      for (let start = 0; start < outflowIds.length; start += 100) {
        if (reportRequestId.current !== requestId) return
        const batch = outflowIds.slice(start, start + 100)
        const { data, error: voidError } = await client.from('financial_outflow_voids')
          .select('outflow_id, reason, created_at')
          .eq('business_id', businessId)
          .in('outflow_id', batch)
        if (voidError) throw voidError
        outflowVoids.push(...((data ?? []) as OutflowVoidRow[]))
      }
      const voidByOutflowId = new Map(outflowVoids.map((event) => [event.outflow_id, { reason: event.reason, created_at: event.created_at }]))
      const loadedOutflows = rawOutflows.map((outflow) => ({ ...outflow, void_event: voidByOutflowId.get(outflow.id) ?? null }))
      const activeOutflows = loadedOutflows.filter((outflow) => outflow.void_event === null)
      const fulfillmentDates = new Map<string, string>()
      for (const handoff of [...(deliveryResult.data ?? []), ...(pickupResult.data ?? [])]) {
        const completedAt = handoff.delivered_at ?? handoff.occurred_at
        if (!completedAt) continue
        const existing = fulfillmentDates.get(handoff.order_id)
        if (!existing || completedAt < existing) fulfillmentDates.set(handoff.order_id, completedAt)
      }
      const fulfilledOrderIds = Array.from(fulfillmentDates.keys())
      const fulfilledOrderRows: OrderRow[] = []
      for (let start = 0; start < fulfilledOrderIds.length; start += 100) {
        if (reportRequestId.current !== requestId) return
        const batch = fulfilledOrderIds.slice(start, start + 100)
        const result = await loadAllPages<OrderRow>((from, to) => client.from('orders')
          .select('id, customer_name_snapshot, subtotal_cents, delivery_fee_cents, discount_cents, total_cents, status, created_at, cancelled_at', { count: 'exact' })
          .eq('business_id', businessId)
          .eq('status', 'open')
          .in('id', batch)
          .order('id', { ascending: true })
          .range(from, to))
        if (result.error) throw result.error
        fulfilledOrderRows.push(...(result.data ?? []))
      }
      const fulfilledOrderIdsActive = fulfilledOrderRows.map((order) => order.id)
      const lineCosts: OrderLineCost[] = []
      for (let start = 0; start < fulfilledOrderIdsActive.length; start += 100) {
        if (reportRequestId.current !== requestId) return
        const batch = fulfilledOrderIdsActive.slice(start, start + 100)
        const result = await loadAllPages<OrderLineCost>((from, to) => client.from('order_lines')
          .select('order_id, unit_cost_snapshot_cents, quantity', { count: 'exact' })
          .eq('business_id', businessId)
          .in('order_id', batch)
          .order('order_id', { ascending: true })
          .range(from, to))
        if (result.error) throw result.error
        lineCosts.push(...(result.data ?? []))
      }
      const returnMovements: ReturnedMovement[] = []
      for (let start = 0; start < fulfilledOrderIdsActive.length; start += 100) {
        if (reportRequestId.current !== requestId) return
        const batch = fulfilledOrderIdsActive.slice(start, start + 100)
        const result = await loadAllPages<ReturnedMovement>((from, to) => client.from('inventory_movements')
          .select('order_id, occurred_at', { count: 'exact' })
          .eq('business_id', businessId)
          .eq('movement_type', 'return')
          .in('order_id', batch)
          .order('order_id', { ascending: true })
          .range(from, to))
        if (result.error) throw result.error
        returnMovements.push(...(result.data ?? []))
      }
      const itemCostMilliCents = new Map<string, bigint>()
      const missingCostsByOrder = new Map<string, number>()
      const returnedMovementsByOrder = new Map<string, number>()
      for (const orderId of fulfilledOrderIdsActive) {
        itemCostMilliCents.set(orderId, 0n)
        missingCostsByOrder.set(orderId, 0)
        returnedMovementsByOrder.set(orderId, 0)
      }
      for (const movement of returnMovements) {
        const completedAt = fulfillmentDates.get(movement.order_id)
        if (!completedAt || movement.occurred_at <= completedAt) continue
        returnedMovementsByOrder.set(movement.order_id, (returnedMovementsByOrder.get(movement.order_id) ?? 0) + 1)
      }
      for (const line of lineCosts) {
        if (line.unit_cost_snapshot_cents === null) {
          missingCostsByOrder.set(line.order_id, (missingCostsByOrder.get(line.order_id) ?? 0) + 1)
          continue
        }
        const lineCost = cents(line.unit_cost_snapshot_cents) * quantityThousandths(line.quantity)
        itemCostMilliCents.set(line.order_id, (itemCostMilliCents.get(line.order_id) ?? 0n) + lineCost)
      }
      const loadedCompletedOrders: CompletedOrder[] = fulfilledOrderRows.map((order) => {
        const missing = missingCostsByOrder.get(order.id) ?? 0
        const returnCount = returnedMovementsByOrder.get(order.id) ?? 0
        return {
          id: order.id,
          customer_name_snapshot: order.customer_name_snapshot,
          total_cents: order.total_cents,
          completed_at: fulfillmentDates.get(order.id) ?? '',
          item_cost_cents: missing === 0 && returnCount === 0 ? roundMilliCents(itemCostMilliCents.get(order.id) ?? 0n) : null,
          missing_cost_line_count: missing,
          return_movement_count: returnCount,
        }
      }).sort((left, right) => right.completed_at.localeCompare(left.completed_at) || left.id.localeCompare(right.id))
      const referencedOrderIds = Array.from(new Set([
        ...loadedPayments.map((payment) => payment.order_id),
        ...loadedInstallments.map((installment) => installment.order_id),
      ]))
      const relatedOrders: Array<Pick<OrderRow, 'id' | 'customer_name_snapshot' | 'status'>> = []
      for (let start = 0; start < referencedOrderIds.length; start += 100) {
        if (reportRequestId.current !== requestId) return
        const batch = referencedOrderIds.slice(start, start + 100)
        const { data, error: relatedOrderError } = await client.from('orders')
          .select('id, customer_name_snapshot, status')
          .eq('business_id', businessId)
          .in('id', batch)
        if (relatedOrderError) throw relatedOrderError
        relatedOrders.push(...(data ?? []))
      }
      const orderById = new Map(relatedOrders.map((order) => [order.id, order]))
      const installmentIds = loadedInstallments.map((installment) => installment.id)
      const allocations: AllocationRow[] = []
      for (let start = 0; start < installmentIds.length; start += 100) {
        if (reportRequestId.current !== requestId) return
        const batch = installmentIds.slice(start, start + 100)
        const allocationResult = await loadAllPages<AllocationRow>((from, to) => client.from('order_payment_allocations')
          .select('id, installment_id, amount_cents', { count: 'exact' })
          .eq('business_id', businessId)
          .in('installment_id', batch)
          .order('installment_id', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to))
        if (allocationResult.error) throw allocationResult.error
        allocations.push(...(allocationResult.data ?? []))
      }
      if (reportRequestId.current !== requestId) return
      const [summaryResult, inventoryFinanceResult] = await Promise.all([
        client.rpc('get_financial_report_summary', {
          p_business_id: businessId,
          p_start_on: startOn,
          p_end_on: endOn,
        }),
        client.rpc('get_inventory_finance_summary', {
          p_business_id: businessId,
          p_start_on: startOn,
          p_end_on: endOn,
        }),
      ])
      if (summaryResult.error || !summaryResult.data || inventoryFinanceResult.error || !inventoryFinanceResult.data?.[0]) {
        throw new Error('Não foi possível calcular o resumo deste período.')
      }
      const baseSummary = summaryResult.data as Omit<Summary, 'inventory_finance'>
      const inventoryFinance = inventoryFinanceResult.data[0] as Summary['inventory_finance']
      const inventoryLossMissingCostCount = Number(inventoryFinance.inventory_loss_missing_cost_count)
      const inventoryLossCents = inventoryFinance.inventory_loss_cents === null || inventoryLossMissingCostCount > 0
        ? null
        : String(inventoryFinance.inventory_loss_cents)

      const paidByInstallment = new Map<string, bigint>()
      for (const allocation of allocations) {
        paidByInstallment.set(allocation.installment_id, (paidByInstallment.get(allocation.installment_id) ?? 0n) + cents(allocation.amount_cents))
      }
      const outstanding = loadedInstallments.flatMap((installment) => {
        const order = orderById.get(installment.order_id)
        const balance = cents(installment.amount_cents) - (paidByInstallment.get(installment.id) ?? 0n)
        if (!order || order.status !== 'open' || balance <= 0n) return []
        return [{ ...installment, customer_name: order.customer_name_snapshot, balance_cents: balance }]
      })
      const paymentsWithCustomer = loadedPayments.map((payment) => ({
        ...payment,
        customer_name: orderById.get(payment.order_id)?.customer_name_snapshot ?? 'Pedido não disponível',
      }))
      const resultAvailable = baseSummary.managerial_result.available && inventoryLossCents !== null
      const adjustedResultCents = resultAvailable && baseSummary.managerial_result.result_cents !== null
        ? (cents(baseSummary.managerial_result.result_cents) - cents(inventoryLossCents)).toString()
        : null
      const reportSummary: Summary = {
        ...baseSummary,
        inventory_finance: inventoryFinance,
        managerial_result: {
          ...baseSummary.managerial_result,
          inventory_loss_cents: inventoryLossCents,
          available: resultAvailable,
          result_cents: adjustedResultCents,
        },
      }
      const activeOrders = loadedOrders.filter((order) => order.status === 'open')
      const cancelledOrders = loadedOrders.filter((order) => order.status === 'cancelled')
      const sum = (values: Array<number | string>) => values.reduce((total, value) => total + cents(value), 0n)
      const listOpenBalance = outstanding.reduce((total, item) => total + item.balance_cents, 0n)
      const listOverdueBalance = outstanding
        .filter((item) => item.due_on < reportSummary.as_of_on)
        .reduce((total, item) => total + item.balance_cents, 0n)
      const outflowTotalByType = (type: OutflowRow['outflow_type']) => activeOutflows
        .filter((outflow) => outflow.outflow_type === type)
      const purchaseOutflows = outflowTotalByType('purchase')
      const operatingOutflows = outflowTotalByType('operating_expense')
      const deliveryOutflows = outflowTotalByType('delivery_cost')
      const outflowTotal = sum(activeOutflows.map((outflow) => outflow.amount_cents))
      const reportedReceipts = sum(loadedPayments.map((payment) => payment.amount_cents))
      const completedSales = sum(loadedCompletedOrders.map((order) => order.total_cents))
      const missingCostLineCount = loadedCompletedOrders.reduce((total, order) => total + order.missing_cost_line_count, 0)
      const returnedOrderCount = loadedCompletedOrders.filter((order) => order.return_movement_count > 0).length
      const completedItemCost = missingCostLineCount === 0 && returnedOrderCount === 0
        ? loadedCompletedOrders.reduce((total, order) => total + (order.item_cost_cents ?? 0n), 0n)
        : null
      const operatingExpenseTotal = sum(operatingOutflows.map((outflow) => outflow.amount_cents))
      const deliveryCostTotal = sum(deliveryOutflows.map((outflow) => outflow.amount_cents))
      const expectedResult = completedItemCost === null || inventoryLossCents === null
        ? null
        : completedSales - completedItemCost - operatingExpenseTotal - deliveryCostTotal - cents(inventoryLossCents)
      const expectedResultAvailable = missingCostLineCount === 0 && returnedOrderCount === 0 && inventoryLossCents !== null
      const summaryMismatch =
        reportSummary.sales.record_count !== loadedOrders.length ||
        reportSummary.sales.active_order_count !== activeOrders.length ||
        reportSummary.sales.cancelled_order_count !== cancelledOrders.length ||
        BigInt(reportSummary.sales.active_subtotal_cents) !== sum(activeOrders.map((order) => order.subtotal_cents)) ||
        BigInt(reportSummary.sales.active_delivery_fee_cents) !== sum(activeOrders.map((order) => order.delivery_fee_cents)) ||
        BigInt(reportSummary.sales.active_discount_cents) !== sum(activeOrders.map((order) => order.discount_cents)) ||
        BigInt(reportSummary.sales.active_total_cents) !== sum(activeOrders.map((order) => order.total_cents)) ||
        BigInt(reportSummary.sales.cancelled_total_cents) !== sum(cancelledOrders.map((order) => order.total_cents)) ||
        reportSummary.receipts.record_count !== loadedPayments.length ||
        BigInt(reportSummary.receipts.amount_cents) !== sum(loadedPayments.map((payment) => payment.amount_cents)) ||
        reportSummary.receivables.installment_count !== outstanding.length ||
        BigInt(reportSummary.receivables.open_balance_cents) !== listOpenBalance ||
        BigInt(reportSummary.receivables.overdue_balance_cents) !== listOverdueBalance ||
        reportSummary.outflows.record_count !== activeOutflows.length ||
        reportSummary.outflows.purchase_count !== purchaseOutflows.length ||
        BigInt(reportSummary.outflows.purchase_cents) !== sum(purchaseOutflows.map((outflow) => outflow.amount_cents)) ||
        reportSummary.outflows.operating_expense_count !== operatingOutflows.length ||
        BigInt(reportSummary.outflows.operating_expense_cents) !== operatingExpenseTotal ||
        reportSummary.outflows.delivery_cost_count !== deliveryOutflows.length ||
        BigInt(reportSummary.outflows.delivery_cost_cents) !== deliveryCostTotal ||
        BigInt(reportSummary.outflows.total_cents) !== outflowTotal ||
        BigInt(reportSummary.cash_movement.reported_receipts_cents) !== reportedReceipts ||
        BigInt(reportSummary.cash_movement.paid_outflows_cents) !== outflowTotal ||
        BigInt(reportSummary.cash_movement.net_recorded_cents) !== reportedReceipts - outflowTotal ||
        reportSummary.managerial_result.completed_order_count !== loadedCompletedOrders.length ||
        BigInt(reportSummary.managerial_result.sales_cents) !== completedSales ||
        reportSummary.managerial_result.missing_cost_line_count !== missingCostLineCount ||
        reportSummary.managerial_result.returned_order_count !== returnedOrderCount ||
        reportSummary.managerial_result.available !== expectedResultAvailable ||
        (completedItemCost === null
          ? reportSummary.managerial_result.item_cost_cents !== null
          : BigInt(reportSummary.managerial_result.item_cost_cents ?? '0') !== completedItemCost) ||
        (expectedResult === null
          ? reportSummary.managerial_result.result_cents !== null
          : BigInt(reportSummary.managerial_result.result_cents ?? '0') !== expectedResult)

      if (reportRequestId.current !== requestId) return
      setSummary(reportSummary)
      setOrders(loadedOrders)
      setPayments(paymentsWithCustomer)
      setReceivables(outstanding)
      setOutflows(loadedOutflows)
      setCompletedOrders(loadedCompletedOrders)
      setReconciliationWarning(summaryMismatch)
    } catch {
      if (reportRequestId.current !== requestId) return
      setError('Não foi possível carregar todos os dados deste período. Tente novamente.')
      setSummary(null)
      setOrders([])
      setPayments([])
      setReceivables([])
      setOutflows([])
      setCompletedOrders([])
      setReconciliationWarning(false)
    } finally {
      if (reportRequestId.current === requestId) setLoading(false)
    }
  }, [businessId, endOn, rangeError, startOn])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void loadReport()
    return () => { reportRequestId.current += 1 }
  }, [loadReport])

  const reportMatchesPeriod = Boolean(summary && summary.start_on === startOn && summary.end_on === endOn)
  const reportCanBeUsed = reportMatchesPeriod && !loading && !error && !reconciliationWarning
  const completedBilling = summary ? getCompletedBilling(summary) : null
  const currentInventoryMissingCostCount = Number(summary?.inventory_finance.inventory_value_missing_cost_products ?? 0)
  const currentInventoryValue = summary?.inventory_finance.inventory_value_cents === null || !summary || currentInventoryMissingCostCount > 0
    ? null
    : summary.inventory_finance.inventory_value_cents
  const inventoryLossMissingCostCount = Number(summary?.inventory_finance.inventory_loss_missing_cost_count ?? 0)

  function exportCsv() {
    if (!summary || !completedBilling) return
    const rows: string[][] = [
      ['Relatório financeiro', `${formatBusinessDate(summary.start_on)} a ${formatBusinessDate(summary.end_on)}`],
      ['Escopo', 'Este arquivo inclui pedidos, pagamentos recebidos registrados manualmente, parcelas ainda não pagas, gastos pagos, entradas menos gastos registrados e lucro estimado antes de impostos. O valor atual do estoque é uma fotografia de hoje, fora do período escolhido. Perdas físicas reduzem o lucro, mas não alteram pagamentos já feitos. Lançamentos anulados por erro ficam visíveis na lista, mas são excluídos dos totais. Não representa saldo bancário.'],
      ['Nota sobre pagamentos recebidos', 'Os pagamentos são registrados manualmente pelo proprietário; o sistema não processa nem verifica pagamentos ou créditos bancários.'],
      ['Nota sobre saídas', 'Compras, despesas e custos de entrega aparecem somente quando pagos e são informados manualmente. Compra de estoque afeta o caixa; o resultado reconhece o custo congelado nos itens vendidos.'],
      ['Como o faturamento líquido é calculado', 'Vendas concluídas após descontos − custo dos produtos vendidos. Os pedidos entram pela data de entrega ou retirada.'],
      ['Como o resultado estimado é calculado', 'Vendas após descontos − custo dos produtos vendidos − perdas reais no estoque − gastos da empresa pagos − pagamentos de entrega. Correções de contagem alteram o valor atual do estoque, não o dinheiro já pago.'],
      ['Datas usadas no cálculo do lucro', 'Pedidos e custo dos produtos: data de entrega concluída ou retirada pelo cliente. Gastos e pagamentos de entrega: data do pagamento informado.'],
      ['Lucro estimado antes de impostos (R$)', summary.managerial_result.result_cents === null ? 'Indisponível; falta o custo de algum produto ou há devolução sem ajuste financeiro.' : csvMoney(summary.managerial_result.result_cents)],
      ['Itens sem custo congelado', String(summary.managerial_result.missing_cost_line_count)],
      ['Pedidos concluídos com devolução registrada', String(summary.managerial_result.returned_order_count)],
      ['Pagamentos recebidos menos gastos pagos (R$)', csvMoney(summary.cash_movement.net_recorded_cents)],
      ['Pedidos concluídos (entrega ou retirada)', String(summary.managerial_result.completed_order_count)],
      ['Faturamento bruto das vendas concluídas (R$)', csvMoney(completedBilling.grossCents)],
      ['Descontos nas vendas concluídas (R$)', csvMoney(summary.managerial_result.discount_cents)],
      ['Vendas concluídas após descontos (R$)', csvMoney(summary.managerial_result.sales_cents)],
      ['Custo dos produtos vendidos (R$)', summary.managerial_result.item_cost_cents === null ? 'Indisponível' : csvMoney(summary.managerial_result.item_cost_cents)],
      ['Perdas reais no estoque no período (R$)', summary.managerial_result.inventory_loss_cents === null ? 'Indisponível' : csvMoney(summary.managerial_result.inventory_loss_cents)],
      ['Valor atual do estoque (R$)', currentInventoryValue === null ? 'Indisponível' : csvMoney(currentInventoryValue)],
      ['Faturamento líquido (R$)', completedBilling.netBillingCents === null ? 'Indisponível' : csvMoney(completedBilling.netBillingCents)],
      ['Pedidos ainda em andamento criados no período', String(summary.sales.active_order_count)],
      ['Pedidos criados no período atualmente cancelados', String(summary.sales.cancelled_order_count)],
      ['Total originalmente registrado nesses pedidos atualmente cancelados (R$)', csvMoney(summary.sales.cancelled_total_cents)],
      ['Pagamentos recebidos no período (R$)', csvMoney(summary.receipts.amount_cents)],
      [`Saldos em vencimentos do período, apurados em ${formatBusinessDate(summary.as_of_on)} (R$)`, csvMoney(summary.receivables.open_balance_cents)],
      [`Parte vencida desse saldo em ${formatBusinessDate(summary.as_of_on)} (R$)`, csvMoney(summary.receivables.overdue_balance_cents)],
      ['Compras de produtos para revenda no período (R$)', csvMoney(summary.outflows.purchase_cents)],
      ['Gastos da empresa pagos no período (R$)', csvMoney(summary.outflows.operating_expense_cents)],
      ['Pagamentos de entrega no período (R$)', csvMoney(summary.outflows.delivery_cost_cents)],
      [],
      ['Pedidos entregues ou retirados', 'Data de conclusão', 'Pedido', 'Cliente', 'Valor da venda após descontos (R$)', 'Custo dos produtos no pedido (R$)', 'Produtos sem custo registrado', 'Devoluções registradas'],
      ...completedOrders.map((order) => [order.id, reportDate(order.completed_at), order.id, order.customer_name_snapshot, csvMoney(String(order.total_cents)), order.item_cost_cents === null ? 'Indisponível' : csvMoney(order.item_cost_cents), String(order.missing_cost_line_count), String(order.return_movement_count)]),
      [],
      ['Pedidos', 'Data do pedido', 'Cliente', 'Produtos (R$)', 'Taxa cobrada (R$)', 'Desconto (R$)', 'Total original (R$)', 'Situação'],
      ...orders.map((order) => [order.id, reportDate(order.created_at), order.customer_name_snapshot, csvMoney(String(order.subtotal_cents)), csvMoney(String(order.delivery_fee_cents)), csvMoney(String(order.discount_cents)), csvMoney(String(order.total_cents)), statusLabel(order)]),
      [],
      ['Pagamentos recebidos', 'Data do pagamento', 'Cliente', 'Forma de pagamento', 'Valor (R$)'],
      ...payments.map((payment) => [payment.order_id, reportDate(payment.received_at), payment.customer_name, payment.payment_method ?? '', csvMoney(String(payment.amount_cents))]),
      [],
      ['Gastos pagos', 'Data paga', 'Tipo', 'Descrição', 'Categoria', 'Pago a', 'Pedido relacionado', 'Valor (R$)', 'Situação', 'Motivo da anulação'],
      ...outflows.map((outflow) => [outflow.id, formatBusinessDate(outflow.paid_on), outflowTypeLabel(outflow.outflow_type), outflow.description, outflow.category ?? '', outflow.counterparty_name ?? '', outflow.order_id ?? '', csvMoney(String(outflow.amount_cents)), outflow.void_event ? 'Anulado por erro; excluído dos totais' : 'Ativo', outflow.void_event?.reason ?? '']),
      [],
      ['Pagamentos que ainda faltam receber', 'Data limite', 'Cliente', 'Parcela', 'Valor original (R$)', 'Falta receber hoje (R$)', 'Situação'],
      ...receivables.map((item) => [item.order_id, formatBusinessDate(item.due_on), item.customer_name, String(item.installment_number), csvMoney(String(item.amount_cents)), csvMoney(item.balance_cents), item.due_on < (summary.as_of_on ?? today) ? 'Atrasado' : 'Ainda não pago']),
    ]
    const content = `\uFEFF${rows.map((row) => row.map(csvCell).join(';')).join('\r\n')}`
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `relatorio-financeiro-${summary.start_on}-${summary.end_on}.csv`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="page-stack report-page">
      <ReportsNavigation active="financial" />
      <header className="page-heading">
        <div>
          <p className="eyebrow">DASHBOARD · FINANCEIRO</p>
          <h1>Relatório financeiro</h1>
          <p className="page-description">Faturamento, pagamentos e gastos registrados no período.</p>
        </div>
        <div className="record-heading-actions report-actions">
          <button className="button button-secondary" disabled={!reportCanBeUsed} onClick={exportCsv} type="button">Exportar CSV</button>
          <button className="button button-secondary" disabled={!reportCanBeUsed} onClick={() => window.print()} type="button">Imprimir</button>
        </div>
      </header>
      <p className="report-print-range">Período: {reportMatchesPeriod && summary ? `${formatBusinessDate(summary.start_on)} a ${formatBusinessDate(summary.end_on)}` : startOn && endOn ? `${formatBusinessDate(startOn)} a ${formatBusinessDate(endOn)}` : 'Datas pendentes'} · Valores que faltam receber apurados em {formatBusinessDate(summary?.as_of_on ?? today)}</p>

      <section className="surface-panel record-panel report-period-panel" aria-label="Período do relatório">
        <div className="report-period-controls">
          <label className="record-field"><span className="field-label">Período</span><select className="text-input" onChange={(event) => setPeriodMode(event.target.value as PeriodMode)} value={periodMode}><option value="today">Hoje</option><option value="month">Este mês até hoje</option><option value="year">Este ano até hoje</option><option value="custom">Intervalo personalizado</option></select></label>
          {periodMode === 'custom' && <>
            <label className="record-field"><span className="field-label">De</span><input aria-describedby={rangeError ? 'report-period-error' : undefined} aria-invalid={Boolean(rangeError)} className="text-input" max={customEnd || undefined} onChange={(event) => setCustomStartOverride(event.target.value)} type="date" value={customStart} /></label>
            <label className="record-field"><span className="field-label">Até</span><input aria-describedby={rangeError ? 'report-period-error' : undefined} aria-invalid={Boolean(rangeError)} className="text-input" min={customStart || undefined} onChange={(event) => setCustomEndOverride(event.target.value)} type="date" value={customEnd} /></label>
          </>}
          {rangeError && <p className="form-message form-message-error report-period-error" id="report-period-error" role="alert">{rangeError}</p>}
          <p className="section-footnote">{startOn && endOn ? `${formatBusinessDate(startOn)} a ${formatBusinessDate(endOn)} · ` : ''}A receber: data do vencimento · gastos: data do pagamento · lucro: entrega ou retirada.</p>
        </div>
      </section>

      {error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => void loadReport()} type="button">Tentar novamente</button></div>}
      {(loading || (summary !== null && !reportMatchesPeriod)) && <p className="inline-state" aria-live="polite">Carregando lançamentos do período…</p>}

      {!loading && reportMatchesPeriod && summary && !error && <>
        {reconciliationWarning && <div className="form-message form-message-warning report-reconciliation-warning" role="alert"><span>O resumo e os lançamentos detalhados não coincidem neste carregamento. Confira novamente antes de usar estes valores.</span><button className="text-button" disabled={loading} onClick={() => void loadReport()} type="button">Reconciliar novamente</button></div>}
        {!reconciliationWarning && <>
        <p className="section-footnote report-scope-note">Faturamento pela data da entrega ou retirada. Pedidos em andamento não entram no faturamento.</p>
        <section className="report-summary-grid" aria-label="Resumo do período">
          <article className="surface-panel report-summary-card"><span>Faturamento bruto</span><strong>{formatBRLExact(completedBilling?.grossCents ?? 0n)}</strong><small>{summary.managerial_result.completed_order_count} entregas ou retiradas · antes dos descontos</small></article>
          <article className="surface-panel report-summary-card"><span>Faturamento líquido</span><strong>{completedBilling?.netBillingCents === null ? 'A conferir' : formatBRLExact(completedBilling?.netBillingCents ?? 0n)}</strong><small>Vendas após descontos − custo dos produtos</small></article>
          <article className="surface-panel report-summary-card"><span>Pagamentos recebidos</span><strong>{formatBRLExact(summary.receipts.amount_cents)}</strong><small>{summary.receipts.record_count} pagamentos registrados</small></article>
          <article className="surface-panel report-summary-card"><span>Saldo a receber</span><strong>{formatBRLExact(summary.receivables.open_balance_cents)}</strong><small>{summary.receivables.installment_count} parcelas pendentes</small></article>
          <article className="surface-panel report-summary-card"><span>Parcelas de clientes atrasadas</span><strong>{formatBRLExact(summary.receivables.overdue_balance_cents)}</strong><small>Valores que os clientes ainda não pagaram no prazo</small></article>
          <article className="surface-panel report-summary-card"><span>Gastos pagos</span><strong>{formatBRLExact(summary.outflows.total_cents)}</strong><small>{summary.outflows.record_count} gastos registrados</small></article>
        </section>

        <section className="surface-panel record-panel report-section" aria-labelledby="report-inventory-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">POSIÇÃO DE HOJE</p><h2 id="report-inventory-title">Valor dos produtos em estoque</h2></div><span className="neutral-status">Fora do período</span></div>
          <div className="report-breakdown report-result-breakdown" aria-label="Valor atual do estoque e perdas do período">
            <div><span>Saldo atual pelo custo médio</span><strong>{currentInventoryValue === null ? 'A conferir' : formatBRLExact(currentInventoryValue)}</strong></div>
            <div><span>Perdas reais no período</span><strong>{summary.inventory_finance.inventory_loss_cents === null || inventoryLossMissingCostCount > 0 ? 'A conferir' : formatBRLExact(summary.inventory_finance.inventory_loss_cents)}</strong></div>
          </div>
          <p className="section-footnote">O saldo atual muda quando você corrige a contagem. Isso não altera compras já pagas nem o caixa histórico; perdas ou avarias reais reduzem o lucro estimado.</p>
          {currentInventoryMissingCostCount > 0 && <p className="form-message form-message-warning" role="status">Não foi possível valorar o saldo: falta custo cadastrado em {currentInventoryMissingCostCount} produto(s) com estoque.</p>}
          {inventoryLossMissingCostCount > 0 && <p className="form-message form-message-warning" role="status">O lucro fica indisponível porque {inventoryLossMissingCostCount} perda(s) no período não têm custo registrado.</p>}
        </section>

        <section className="surface-panel report-definition-panel" aria-labelledby="report-result-title">
          <div>
            <p className="eyebrow">LUCRO ESTIMADO · ANTES DE IMPOSTOS</p>
            <h2 id="report-result-title">{summary.managerial_result.available && summary.managerial_result.result_cents !== null ? formatBRLExact(summary.managerial_result.result_cents) : 'Não foi possível calcular o lucro deste período'}</h2>
            <p className="report-result-formula">Vendas após descontos − custo dos produtos vendidos − perdas reais − gastos pagos − entregas pagas.</p>
            <div className="report-breakdown report-result-breakdown" aria-label="Valores usados no lucro estimado">
              <div><span>Faturamento bruto</span><strong>{formatBRLExact(completedBilling?.grossCents ?? 0n)}</strong></div>
              <div><span>Descontos</span><strong>− {formatBRLExact(summary.managerial_result.discount_cents)}</strong></div>
              <div><span>Vendas após descontos</span><strong>{formatBRLExact(summary.managerial_result.sales_cents)}</strong></div>
              <div><span>Custo dos produtos</span><strong>{summary.managerial_result.item_cost_cents === null ? 'Indisponível' : formatBRLExact(summary.managerial_result.item_cost_cents)}</strong></div>
              <div><span>Faturamento líquido</span><strong>{completedBilling?.netBillingCents === null ? 'A conferir' : formatBRLExact(completedBilling?.netBillingCents ?? 0n)}</strong></div>
              <div><span>Perdas reais no estoque</span><strong>{summary.managerial_result.inventory_loss_cents === null ? 'Indisponível' : `− ${formatBRLExact(summary.managerial_result.inventory_loss_cents)}`}</strong></div>
              <div><span>Gastos</span><strong>{formatBRLExact(summary.managerial_result.operating_expense_cents)}</strong></div>
              <div><span>Entregas</span><strong>{formatBRLExact(summary.managerial_result.delivery_cost_cents)}</strong></div>
            </div>
            {!summary.managerial_result.available && <p className="report-scope-note">{summary.managerial_result.missing_cost_line_count > 0 ? `Falta o custo de ${summary.managerial_result.missing_cost_line_count} produto(s) vendido(s).` : ''}{summary.managerial_result.returned_order_count > 0 ? ` ${summary.managerial_result.returned_order_count} pedido(s) têm produtos devolvidos sem ajuste financeiro.` : ''}{inventoryLossMissingCostCount > 0 ? ` ${inventoryLossMissingCostCount} perda(s) não têm custo registrado.` : ''} O valor fica oculto enquanto não for possível calcular com segurança.</p>}
            <details className="report-calculation-details">
              <summary>Como calculamos</summary>
              <p>O custo de produtos para revenda entra quando cada produto é vendido. O registro de gastos é opcional; gastos não informados ficam fora do cálculo. Impostos, reembolsos e ajustes não estão incluídos.</p>
            </details>
          </div>
          <Link className="quiet-link report-related-link" to="/financeiro/saidas">Registrar gasto pago</Link>
        </section>

        <section className="surface-panel record-panel report-section" aria-labelledby="report-completed-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">DATA DA ENTREGA OU RETIRADA</p><h2 id="report-completed-title">Pedidos entregues ou retirados</h2></div><span className="neutral-status">{completedOrders.length}</span></div>
          {completedOrders.length === 0 ? <p className="inline-state">Nenhuma entrega concluída ou retirada registrada neste período.</p> : <details className="dashboard-trend-details report-table-details"><summary>Ver pedidos entregues ou retirados <span>{completedOrders.length} registros</span></summary><div aria-label="Pedidos entregues ou retirados e seus custos" className="report-table-wrap" role="region" tabIndex={0}><table className="report-table"><thead><tr><th>Data</th><th>Pedido / cliente</th><th>Valor da venda após descontos</th><th>Custo dos produtos vendidos</th><th>Custos registrados?</th></tr></thead><tbody>{completedOrders.map((order) => <tr key={order.id}><td>{reportDate(order.completed_at)}</td><td><Link className="report-order-link" to={`/pedidos/${order.id}`}>{order.customer_name_snapshot}</Link></td><td>{formatBRLExact(String(order.total_cents))}</td><td>{order.item_cost_cents === null ? 'Indisponível' : formatBRLExact(order.item_cost_cents.toString())}</td><td>{order.return_movement_count > 0 ? `${order.return_movement_count} produto(s) devolvido(s)` : order.missing_cost_line_count > 0 ? `${order.missing_cost_line_count} produto(s) sem custo` : 'Sim'}</td></tr>)}</tbody></table></div></details>}
          <p className="section-footnote">Conta no lucro pela data da entrega ou retirada.</p>
        </section>

        <section className="surface-panel record-panel report-section" aria-labelledby="report-sales-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">DATA DO PEDIDO</p><h2 id="report-sales-title">Pedidos criados no período</h2></div><span className="neutral-status">{orders.length}</span></div>
          <div className="report-breakdown" aria-label="Composição dos pedidos ativos">
            <span>Produtos <strong>{formatBRLExact(summary.sales.active_subtotal_cents)}</strong></span>
            <span>Taxa cobrada <strong>{formatBRLExact(summary.sales.active_delivery_fee_cents)}</strong></span>
            <span>Descontos <strong>{formatBRLExact(summary.sales.active_discount_cents)}</strong></span>
            <span>Atualmente cancelados entre os pedidos criados no período <strong>{summary.sales.cancelled_order_count} · {formatBRLExact(summary.sales.cancelled_total_cents)}</strong></span>
          </div>
          <p className="section-footnote">Cancelamentos posteriores podem alterar o total atual deste período.</p>
          {orders.length === 0 ? <p className="inline-state">Nenhum pedido criado no período.</p> : <details className="dashboard-trend-details report-table-details"><summary>Ver pedidos criados no período <span>{orders.length} registros</span></summary><div aria-label="Tabela de pedidos do período" className="report-table-wrap" role="region" tabIndex={0}><table className="report-table"><thead><tr><th>Data</th><th>Pedido / cliente</th><th>Produtos</th><th>Taxa</th><th>Desconto</th><th>Total original</th><th>Situação atual</th></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td>{reportDate(order.created_at)}</td><td><Link className="report-order-link" to={`/pedidos/${order.id}`}>{order.customer_name_snapshot}</Link></td><td>{formatBRLExact(String(order.subtotal_cents))}</td><td>{formatBRLExact(String(order.delivery_fee_cents))}</td><td>{formatBRLExact(String(order.discount_cents))}</td><td>{formatBRLExact(String(order.total_cents))}</td><td>{statusLabel(order)}</td></tr>)}</tbody></table></div></details>}
        </section>

        <section className="surface-panel record-panel report-section" aria-labelledby="report-receipts-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">DATA DO PAGAMENTO</p><h2 id="report-receipts-title">Pagamentos recebidos</h2></div><span className="neutral-status">{payments.length}</span></div>
          {payments.length === 0 ? <p className="inline-state">Nenhum pagamento recebido neste período.</p> : <details className="dashboard-trend-details report-table-details"><summary>Ver pagamentos recebidos no período <span>{payments.length} registros</span></summary><div aria-label="Tabela de pagamentos recebidos" className="report-table-wrap" role="region" tabIndex={0}><table className="report-table"><thead><tr><th>Data</th><th>Pedido</th><th>Cliente</th><th>Forma de pagamento</th><th>Valor</th></tr></thead><tbody>{payments.map((payment) => <tr key={payment.id}><td>{reportDate(payment.received_at)}</td><td><Link className="report-order-link" to={`/pedidos/${payment.order_id}`}>Abrir pedido</Link></td><td>{payment.customer_name}</td><td>{payment.payment_method || 'Não informada'}</td><td>{formatBRLExact(String(payment.amount_cents))}</td></tr>)}</tbody></table></div></details>}
        </section>

        <section className="surface-panel record-panel report-section" aria-labelledby="report-outflows-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">DATA DO PAGAMENTO</p><h2 id="report-outflows-title">Gastos pagos</h2></div><span className="neutral-status">{outflows.length}</span></div>
          <div className="report-breakdown" aria-label="Totais de gastos pagos">
            <span>Produtos para revenda <strong>{formatBRLExact(summary.outflows.purchase_cents)}</strong></span>
            <span>Gastos da empresa <strong>{formatBRLExact(summary.outflows.operating_expense_cents)}</strong></span>
            <span>Pagamentos de entrega <strong>{formatBRLExact(summary.outflows.delivery_cost_cents)}</strong></span>
          </div>
          {outflows.length === 0 ? <p className="inline-state">Nenhum gasto pago neste período.</p> : <details className="dashboard-trend-details report-table-details"><summary>Ver gastos pagos no período <span>{outflows.length} registros</span></summary><div aria-label="Tabela de gastos pagos do período" className="report-table-wrap" role="region" tabIndex={0}><table className="report-table"><thead><tr><th>Data paga</th><th>Tipo</th><th>Descrição</th><th>Categoria</th><th>Pago a</th><th>Pedido</th><th>Valor</th><th>Situação</th></tr></thead><tbody>{outflows.map((outflow) => <tr key={outflow.id}><td>{formatBusinessDate(outflow.paid_on)}</td><td>{outflowTypeLabel(outflow.outflow_type)}</td><td>{outflow.description}</td><td>{outflow.category || '—'}</td><td>{outflow.counterparty_name || '—'}</td><td>{outflow.order_id ? <Link className="report-order-link" to={`/pedidos/${outflow.order_id}`}>Abrir pedido</Link> : '—'}</td><td>{formatBRLExact(String(outflow.amount_cents))}</td><td>{outflow.void_event ? <><strong>Anulado por erro</strong><small className="section-footnote">{formatBusinessDate(outflow.void_event.created_at)} · {outflow.void_event.reason}</small></> : 'Ativo'}</td></tr>)}</tbody></table></div></details>}
          <p className="section-footnote">Inclui gastos pagos e compras para revenda.</p>
        </section>

        <section className="surface-panel record-panel report-section" aria-labelledby="report-receivables-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">DATA LIMITE DO PAGAMENTO</p><h2 id="report-receivables-title">Pagamentos que ainda faltam receber</h2></div><span className="neutral-status">{receivables.length}</span></div>
          {receivables.length === 0 ? <p className="inline-state">Nenhum pagamento pendente neste período.</p> : <details className="dashboard-trend-details report-table-details"><summary>Ver parcelas a receber no período <span>{receivables.length} registros</span></summary><div aria-label="Tabela de pagamentos pendentes" className="report-table-wrap" role="region" tabIndex={0}><table className="report-table"><thead><tr><th>Data limite</th><th>Cliente / pedido</th><th>Parcela</th><th>Valor original</th><th>Falta receber hoje</th><th>Situação</th></tr></thead><tbody>{receivables.map((item) => <tr key={item.id}><td>{formatBusinessDate(item.due_on)}</td><td><Link className="report-order-link" to={`/pedidos/${item.order_id}`}>{item.customer_name}</Link></td><td>{item.installment_number}</td><td>{formatBRLExact(String(item.amount_cents))}</td><td>{formatBRLExact(item.balance_cents.toString())}</td><td>{item.due_on < (summary.as_of_on ?? today) ? 'Atrasado' : 'Ainda não pago'}</td></tr>)}</tbody></table></div></details>}
          <p className="section-footnote">Saldo restante após os pagamentos registrados.</p>
        </section>
        </>}
      </>}
    </div>
  )
}
