import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { FinanceNavigation } from '../components/FinanceNavigation'
import { formatBRLExact, formatBusinessDate, parseBrazilianCurrency } from '../lib/formatters'
import { firstMonthlyDueDate, formatRecurringDay, type RecurringOperationTemplate } from '../lib/recurringOperations'
import { useBusinessToday } from '../lib/useBusinessToday'
import { supabaseClient } from '../lib/supabase'

const PAGE_SIZE = 25
const RECEIPT_OPTION_LIMIT = 50

type OutflowType = 'purchase' | 'operating_expense' | 'delivery_cost'
type Outflow = {
  id: string
  business_id: string
  outflow_type: OutflowType
  description: string
  amount_cents: number | string
  paid_on: string
  order_id: string | null
  created_at: string
}
type InventoryReceipt = {
  id: string
  supplier_name: string | null
  purchase_reference: string | null
  received_on: string
}
type InventoryReceiptCostLine = { quantity: string | number; unit_cost_cents: string | number | null }
type ReceiptPrefillStatus = { receiptId: string; state: 'loading' | 'ready' | 'error'; message: string }
type OutflowReceiptLink = { outflow_id: string; inventory_receipt_id: string }
type OutflowVoid = { outflow_id: string; reason: string; created_at: string }
type OrderOption = { id: string; customer_name_snapshot: string }
type OutflowView = Outflow & { receipts: InventoryReceipt[]; order_name: string | null; void_event: OutflowVoid | null }
type QueryResponse = { data: unknown[] | null; error: unknown; count?: number | null }

function newRequestId() {
  return crypto.randomUUID()
}

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function outflowTypeLabel(type: OutflowType) {
  return ({
    purchase: 'Compra de produtos para revenda',
    operating_expense: 'Gasto da empresa',
    delivery_cost: 'Pagamento de entrega',
  })[type]
}

function formatAmount(cents: string | number) {
  return formatBRLExact(String(cents))
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

function estimateInventoryReceiptCents(lines: InventoryReceiptCostLine[]) {
  if (lines.length === 0) return null
  let total = 0n
  for (const line of lines) {
    const quantityMatch = /^(\d+)(?:\.(\d{1,3}))?$/.exec(String(line.quantity))
    if (!quantityMatch || line.unit_cost_cents === null || !/^\d+$/.test(String(line.unit_cost_cents))) return null
    const quantityMills = BigInt(quantityMatch[1]) * 1000n + BigInt((quantityMatch[2] ?? '').padEnd(3, '0') || '0')
    const unitCostCents = BigInt(String(line.unit_cost_cents))
    total += (quantityMills * unitCostCents + 500n) / 1000n
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) return null
  }
  return total > 0n ? total : null
}

function centsToBrazilianInput(cents: bigint) {
  return `${cents / 100n},${String(cents % 100n).padStart(2, '0')}`
}

async function loadAllPages<T>(
  loadPage: (from: number, to: number) => PromiseLike<QueryResponse>,
): Promise<{ data: T[] | null; error: unknown }> {
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
      if (expectedCount !== null && rows.length < expectedCount) {
        return { data: null, error: new Error('A consulta paginada terminou antes de carregar todos os vínculos.') }
      }
      return { data: rows, error: null }
    }
    from += page.length
    if (expectedCount !== null && rows.length >= expectedCount) return { data: rows, error: null }
    if (expectedCount === null && page.length < 1000) return { data: rows, error: null }
  }
}

export function FinancialOutflowsPage() {
  const { id: businessId } = useBusiness()
  const today = useBusinessToday()
  const [searchParams, setSearchParams] = useSearchParams()
  const receiptIdFromUrl = searchParams.get('receiptId')
  const [outflows, setOutflows] = useState<OutflowView[]>([])
  const [historyPage, setHistoryPage] = useState(0)
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [referenceWarning, setReferenceWarning] = useState<string | null>(null)
  const [expenseSchedules, setExpenseSchedules] = useState<RecurringOperationTemplate[]>([])
  const [expenseScheduleError, setExpenseScheduleError] = useState<string | null>(null)
  const [showExpenseScheduleForm, setShowExpenseScheduleForm] = useState(false)
  const [editingExpenseSchedule, setEditingExpenseSchedule] = useState<RecurringOperationTemplate | null>(null)
  const [expenseScheduleDescription, setExpenseScheduleDescription] = useState('')
  const [expenseScheduleAmount, setExpenseScheduleAmount] = useState('')
  const [expenseScheduleDay, setExpenseScheduleDay] = useState(String(Number(today.slice(8, 10))))
  const [expenseScheduleStartsOn, setExpenseScheduleStartsOn] = useState(today)
  const [expenseScheduleSaving, setExpenseScheduleSaving] = useState(false)
  const [expenseScheduleBusyId, setExpenseScheduleBusyId] = useState<string | null>(null)
  const [selectedExpenseScheduleId, setSelectedExpenseScheduleId] = useState<string | null>(null)
  const [pendingExpenseScheduleCompletion, setPendingExpenseScheduleCompletion] = useState<{ templateId: string; dueOn: string; outflowId: string } | null>(null)
  const [expenseScheduleCompletionError, setExpenseScheduleCompletionError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [voidNotice, setVoidNotice] = useState<string | null>(null)
  const [voidTarget, setVoidTarget] = useState<OutflowView | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [voidError, setVoidError] = useState<string | null>(null)
  const [voiding, setVoiding] = useState(false)
  const [voidUncertain, setVoidUncertain] = useState(false)

  const [outflowType, setOutflowType] = useState<OutflowType | ''>('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [paidOnOverride, setPaidOnOverride] = useState<string | null>(null)
  const paidOn = paidOnOverride ?? today
  const [orderSearch, setOrderSearch] = useState('')
  const [orderOptions, setOrderOptions] = useState<OrderOption[]>([])
  const [selectedOrder, setSelectedOrder] = useState<OrderOption | null>(null)
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [ordersError, setOrdersError] = useState<string | null>(null)
  const [receiptOptions, setReceiptOptions] = useState<InventoryReceipt[]>([])
  const [receiptOptionsTotal, setReceiptOptionsTotal] = useState(0)
  const [receiptLoading, setReceiptLoading] = useState(false)
  const [receiptLoadingMore, setReceiptLoadingMore] = useState(false)
  const [receiptError, setReceiptError] = useState<string | null>(null)
  const [selectedReceiptIds, setSelectedReceiptIds] = useState<string[]>([])
  const [receiptPrefillStatus, setReceiptPrefillStatus] = useState<ReceiptPrefillStatus | null>(null)
  const receiptPrefillBlocked = receiptPrefillStatus?.state === 'loading' || receiptPrefillStatus?.state === 'error'
  const salaryExpenseDraft = outflowType === 'operating_expense' && /sal[aá]rios?|folha/i.test(description)

  const requestIdRef = useRef(newRequestId())
  const historyRequestRef = useRef(0)
  const orderSearchRequestRef = useRef(0)
  const receiptOffsetRef = useRef(0)
  const receiptPrefillRequestRef = useRef<string | null>(null)
  const prefilledReceiptRef = useRef<InventoryReceipt | null>(null)
  const formTriggerRef = useRef<HTMLButtonElement>(null)
  const formHeadingRef = useRef<HTMLHeadingElement>(null)
  const amountInputRef = useRef<HTMLInputElement>(null)
  const wasFormOpenRef = useRef(false)
  const voidHeadingRef = useRef<HTMLHeadingElement>(null)
  const voidNoticeRef = useRef<HTMLParagraphElement>(null)
  const voidTriggerRef = useRef<HTMLButtonElement | null>(null)
  const wasVoidOpenRef = useRef(false)
  const voidRequestIdRef = useRef(newRequestId())

  function clearReceiptPrefillFromUrl() {
    if (!searchParams.has('receiptId')) return
    const next = new URLSearchParams(searchParams)
    next.delete('receiptId')
    setSearchParams(next, { replace: true })
    receiptPrefillRequestRef.current = null
  }

  function continueWithoutReceiptLink() {
    clearReceiptPrefillFromUrl()
    prefilledReceiptRef.current = null
    setReceiptPrefillStatus(null)
    setSelectedReceiptIds([])
  }

  const loadHistory = useCallback(async (page = 0) => {
    const client = supabaseClient
    const request = ++historyRequestRef.current
    if (!client) {
      setHistoryError('A conexão da empresa não está disponível.')
      setHistoryLoading(false)
      return
    }

    setHistoryLoading(true)
    setHistoryError(null)
    setReferenceWarning(null)
    try {
      const from = page * PAGE_SIZE
      const { data, error, count } = await client.from('financial_outflows')
        .select('id, business_id, outflow_type, description, amount_cents, paid_on, order_id, created_at', { count: 'exact' })
        .eq('business_id', businessId)
        .order('paid_on', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + PAGE_SIZE - 1)
      if (error) throw error
      const rows = (data ?? []) as Outflow[]
      const receiptLinks: OutflowReceiptLink[] = []
      const orderIds = Array.from(new Set(rows.flatMap((row) => row.order_id ? [row.order_id] : [])))
      let relatedReceipts: InventoryReceipt[] = []
      let relatedOrders: OrderOption[] = []
      let voidEvents: OutflowVoid[] = []
      let warning: string | null = null

      const rowIds = rows.map((row) => row.id)
      if (rowIds.length > 0) {
        const voidResult = await client.from('financial_outflow_voids')
          .select('outflow_id, reason, created_at')
          .eq('business_id', businessId)
          .in('outflow_id', rowIds)
        if (voidResult.error) throw voidResult.error
        voidEvents = (voidResult.data ?? []) as OutflowVoid[]
        try {
          const linkResult = await loadAllPages<OutflowReceiptLink>((linkFrom, linkTo) => client.from('financial_outflow_inventory_receipts')
            .select('outflow_id, inventory_receipt_id', { count: 'exact' })
            .eq('business_id', businessId)
            .in('outflow_id', rowIds)
            .order('outflow_id', { ascending: true })
            .order('inventory_receipt_id', { ascending: true })
            .range(linkFrom, linkTo))
          if (linkResult.error) throw linkResult.error
          receiptLinks.push(...(linkResult.data ?? []))
        } catch {
          warning = 'As despesas abriram, mas as compras relacionadas não foram carregadas.'
        }
      }

      const receiptIds = Array.from(new Set(receiptLinks.map((link) => link.inventory_receipt_id)))
      if (receiptIds.length > 0) {
        try {
          const loaded: InventoryReceipt[] = []
          for (let start = 0; start < receiptIds.length; start += 100) {
            const batch = receiptIds.slice(start, start + 100)
            const { data: receiptData, error: receiptQueryError } = await client.from('inventory_receipts')
              .select('id, supplier_name, purchase_reference, received_on')
              .eq('business_id', businessId)
              .in('id', batch)
            if (receiptQueryError) throw receiptQueryError
            loaded.push(...((receiptData ?? []) as InventoryReceipt[]))
          }
          relatedReceipts = loaded
        } catch {
          warning = 'As despesas abriram, mas os detalhes das compras relacionadas não apareceram.'
        }
      }

      if (orderIds.length > 0) {
        try {
          const loaded: OrderOption[] = []
          for (let start = 0; start < orderIds.length; start += 100) {
            const batch = orderIds.slice(start, start + 100)
            const { data: orderData, error: orderQueryError } = await client.from('orders')
              .select('id, customer_name_snapshot')
              .eq('business_id', businessId)
              .in('id', batch)
            if (orderQueryError) throw orderQueryError
            loaded.push(...((orderData ?? []) as OrderOption[]))
          }
          relatedOrders = loaded
        } catch {
          warning = 'As despesas abriram, mas os nomes dos pedidos relacionados não apareceram.'
        }
      }

      if (request !== historyRequestRef.current) return
      const receiptById = new Map(relatedReceipts.map((receipt) => [receipt.id, receipt]))
      const orderById = new Map(relatedOrders.map((order) => [order.id, order]))
      const voidByOutflowId = new Map(voidEvents.map((voidEvent) => [voidEvent.outflow_id, voidEvent]))
      const linksByOutflow = new Map<string, InventoryReceipt[]>()
      for (const link of receiptLinks) {
        const receipt = receiptById.get(link.inventory_receipt_id)
        if (!receipt) continue
        linksByOutflow.set(link.outflow_id, [...(linksByOutflow.get(link.outflow_id) ?? []), receipt])
      }
      setOutflows(rows.map((row) => ({
        ...row,
        receipts: linksByOutflow.get(row.id) ?? [],
        order_name: row.order_id ? orderById.get(row.order_id)?.customer_name_snapshot ?? null : null,
        void_event: voidByOutflowId.get(row.id) ?? null,
      })))
      setHistoryPage(page)
      setHistoryTotal(count ?? rows.length)
      setReferenceWarning(warning)
    } catch {
      if (request !== historyRequestRef.current) return
      setHistoryError('Não foi possível carregar as despesas pagas. Tente de novo.')
      setOutflows([])
      setHistoryTotal(0)
      setReferenceWarning(null)
    } finally {
      if (request === historyRequestRef.current) setHistoryLoading(false)
    }
  }, [businessId])

  const loadExpenseSchedules = useCallback(async () => {
    if (!supabaseClient) {
      setExpenseScheduleError('Não há conexão para carregar os lembretes de despesas.')
      return
    }
    try {
      const { data, error } = await supabaseClient.from('recurring_operation_templates')
        .select('*')
        .eq('business_id', businessId)
        .eq('kind', 'operating_expense')
        .order('is_active', { ascending: false })
        .order('next_due_on', { ascending: true })
      if (error) throw error
      setExpenseSchedules((data ?? []) as RecurringOperationTemplate[])
      setExpenseScheduleError(null)
    } catch {
      setExpenseScheduleError('Não foi possível carregar os lembretes recorrentes.')
    }
  }, [businessId])

  const loadReceiptOptions = useCallback(async (append = false) => {
    if (!supabaseClient) {
      setReceiptError('A conexão da empresa não está disponível para carregar recebimentos.')
      return
    }
    const from = append ? receiptOffsetRef.current : 0
    if (append) setReceiptLoadingMore(true)
    else setReceiptLoading(true)
    setReceiptError(null)
    try {
      const { data, error, count } = await supabaseClient.from('inventory_receipts')
        .select('id, supplier_name, purchase_reference, received_on', { count: 'exact' })
        .eq('business_id', businessId)
        .order('received_on', { ascending: false })
        .order('created_at', { ascending: false })
        .range(from, from + RECEIPT_OPTION_LIMIT - 1)
      if (error) throw error
      const fetchedRows = (data ?? []) as InventoryReceipt[]
      const candidateRows = [...fetchedRows]
      const prefilledReceipt = prefilledReceiptRef.current
      if (prefilledReceipt && !candidateRows.some((row) => row.id === prefilledReceipt.id)) candidateRows.unshift(prefilledReceipt)
      const candidateIds = candidateRows.map((row) => row.id)
      let activeLinkedReceiptIds = new Set<string>()
      if (candidateIds.length > 0) {
        const { data: linkRows, error: linkError } = await supabaseClient.from('financial_outflow_inventory_receipts')
          .select('outflow_id, inventory_receipt_id')
          .eq('business_id', businessId)
          .in('inventory_receipt_id', candidateIds)
        if (linkError) throw linkError
        const links = (linkRows ?? []) as OutflowReceiptLink[]
        const outflowIds = Array.from(new Set(links.map((link) => link.outflow_id)))
        let voidedOutflowIds = new Set<string>()
        if (outflowIds.length > 0) {
          const { data: voidRows, error: voidError } = await supabaseClient.from('financial_outflow_voids')
            .select('outflow_id')
            .eq('business_id', businessId)
            .in('outflow_id', outflowIds)
          if (voidError) throw voidError
          voidedOutflowIds = new Set((voidRows ?? []).map((row) => (row as { outflow_id: string }).outflow_id))
        }
        activeLinkedReceiptIds = new Set(links
          .filter((link) => !voidedOutflowIds.has(link.outflow_id))
          .map((link) => link.inventory_receipt_id))
      }
      const rows = candidateRows.filter((row) => !activeLinkedReceiptIds.has(row.id))
      receiptOffsetRef.current = from + fetchedRows.length
      setSelectedReceiptIds((current) => current.filter((id) => !activeLinkedReceiptIds.has(id)))
      setReceiptOptions((current) => {
        const combined = append ? [...current, ...rows] : rows
        return Array.from(new Map<string, InventoryReceipt>(combined.map((row): [string, InventoryReceipt] => [row.id, row])).values())
      })
      setReceiptOptionsTotal(count ?? (append ? from + fetchedRows.length : fetchedRows.length))
    } catch {
      setReceiptError('Não foi possível carregar as compras recebidas. Você ainda pode registrar a despesa sem escolher uma compra.')
      if (!append) setReceiptOptions([])
    } finally {
      if (append) setReceiptLoadingMore(false)
      else setReceiptLoading(false)
    }
  }, [businessId])

  const loadOrderOptions = useCallback(async (search: string) => {
    const client = supabaseClient
    const request = ++orderSearchRequestRef.current
    if (!client) {
      setOrdersError('A conexão da empresa não está disponível para localizar pedidos.')
      return
    }
    setOrdersLoading(true)
    setOrdersError(null)
    try {
      const cleanedSearch = search.trim().replace(/[%_]/g, '')
      let query = client.from('orders')
        .select('id, customer_name_snapshot')
        .eq('business_id', businessId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
      if (cleanedSearch.length > 0) query = query.ilike('customer_name_snapshot', `%${cleanedSearch}%`)
      const { data, error } = await query.range(0, 49)
      if (error) throw error
      if (request !== orderSearchRequestRef.current) return
      const results = (data ?? []) as OrderOption[]
      if (selectedOrder && !results.some((order) => order.id === selectedOrder.id)) results.unshift(selectedOrder)
      setOrderOptions(results)
    } catch {
      if (request === orderSearchRequestRef.current) {
      setOrdersError('Não foi possível localizar pedidos. Escolher um pedido é opcional.')
        setOrderOptions(selectedOrder ? [selectedOrder] : [])
      }
    } finally {
      if (request === orderSearchRequestRef.current) setOrdersLoading(false)
    }
  }, [businessId, selectedOrder])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadHistory(0) }, [loadHistory])
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadReceiptOptions() }, [loadReceiptOptions])
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadExpenseSchedules() }, [loadExpenseSchedules])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    if (!receiptIdFromUrl) return
    const requestKey = `${businessId}:${receiptIdFromUrl}`
    if (receiptPrefillRequestRef.current === requestKey) return
    receiptPrefillRequestRef.current = requestKey
    prefilledReceiptRef.current = null
    setShowForm(true)
    setNotice(null)
    setFormError(null)
    setOutflowType('purchase')
    setDescription('')
    setAmount('')
    setPaidOnOverride(null)
    setSelectedReceiptIds([])
    setReceiptPrefillStatus({ receiptId: receiptIdFromUrl, state: 'loading', message: 'Carregando o recebimento para vincular ao pagamento…' })

    const setPrefillError = (message: string) => setReceiptPrefillStatus({ receiptId: receiptIdFromUrl, state: 'error', message })
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receiptIdFromUrl)) {
      setPrefillError('O identificador do recebimento não é válido. Confira o link ou continue sem vincular um recebimento.')
      return
    }
    if (!supabaseClient) {
      setPrefillError('Não foi possível confirmar esta compra. Nenhuma despesa foi salva; abra o link novamente ou continue sem escolher uma compra.')
      return
    }

    let active = true
    void (async () => {
      try {
        const { data, error } = await supabaseClient.from('inventory_receipts')
          .select('id, supplier_name, purchase_reference, received_on')
          .eq('business_id', businessId).eq('id', receiptIdFromUrl).maybeSingle()
        if (!active) return
        if (error) {
          setPrefillError('Não foi possível carregar esta compra. Nenhuma despesa foi salva; abra o link novamente ou continue sem escolher uma compra.')
          return
        }
        if (!data) {
          setPrefillError('Esta compra não foi encontrada. Nenhuma despesa foi salva; confira o estoque ou continue sem escolher uma compra.')
          return
        }
        const receipt = data as InventoryReceipt
        const { data: linkRows, error: linkError } = await supabaseClient.from('financial_outflow_inventory_receipts')
          .select('outflow_id')
          .eq('business_id', businessId)
          .eq('inventory_receipt_id', receipt.id)
        if (!active) return
        if (linkError) {
          setPrefillError('Não foi possível conferir se esta compra já foi paga. Nenhuma despesa nova foi preparada.')
          return
        }
        const linkedOutflowIds = (linkRows ?? []).map((row) => (row as { outflow_id: string }).outflow_id)
        if (linkedOutflowIds.length > 0) {
          const { data: voidRows, error: voidError } = await supabaseClient.from('financial_outflow_voids')
            .select('outflow_id')
            .eq('business_id', businessId)
            .in('outflow_id', linkedOutflowIds)
          if (!active) return
          if (voidError) {
            setPrefillError('Não foi possível conferir se esta compra já foi paga. Nenhuma despesa nova foi preparada.')
            return
          }
          const voidedOutflowIds = new Set((voidRows ?? []).map((row) => (row as { outflow_id: string }).outflow_id))
          if (linkedOutflowIds.some((id) => !voidedOutflowIds.has(id))) {
            setPrefillError('Este recebimento já está vinculado a uma compra paga. Não é necessário registrar outra saída.')
            return
          }
        }
        const { data: lineData, error: lineError } = await supabaseClient.from('inventory_receipt_lines')
          .select('quantity, unit_cost_cents')
          .eq('business_id', businessId)
          .eq('receipt_id', receipt.id)
        if (!active) return
        const receiptLines = (lineData ?? []) as InventoryReceiptCostLine[]
        const estimateCents = lineError ? null : estimateInventoryReceiptCents(receiptLines)
        prefilledReceiptRef.current = receipt
        setReceiptOptions((current) => [receipt, ...current.filter((row) => row.id !== receipt.id)])
        setSelectedReceiptIds([receipt.id])
        setOutflowType('purchase')
        setDescription(receipt.purchase_reference
          ? `Compra de estoque · ${receipt.purchase_reference}`.slice(0, 200)
          : 'Compra de estoque')
        setAmount(estimateCents === null ? '' : centsToBrazilianInput(estimateCents))
        setPaidOnOverride(null)
        setReceiptPrefillStatus({
          receiptId: receipt.id,
          state: 'ready',
          message: estimateCents !== null
            ? `Recebimento de ${formatBusinessDate(receipt.received_on)} vinculado. O custo cadastrado sugere ${formatBRLExact(String(estimateCents))}; confira o valor realmente pago. Nada foi lançado ainda.`
            : `Recebimento de ${formatBusinessDate(receipt.received_on)} vinculado. ${lineError ? 'Não foi possível ler o custo cadastrado.' : 'Cadastre o custo unitário de todos os itens ou informe o total pago.'} Informe o valor realmente pago; nada foi lançado ainda.`,
        })
      } catch {
        if (active) setPrefillError('Não foi possível confirmar esta compra. Nenhuma despesa foi salva; abra o link novamente ou continue sem escolher uma compra.')
      }
    })()
    return () => { active = false }
  }, [businessId, receiptIdFromUrl])

  useEffect(() => {
    if (!showForm || outflowType !== 'delivery_cost') return
    const timer = window.setTimeout(() => { void loadOrderOptions(orderSearch) }, 250)
    return () => window.clearTimeout(timer)
  }, [loadOrderOptions, orderSearch, outflowType, showForm])

  useEffect(() => {
    if (showForm) formHeadingRef.current?.focus()
    else if (wasFormOpenRef.current) formTriggerRef.current?.focus()
    wasFormOpenRef.current = showForm
  }, [showForm])

  useEffect(() => {
    if (receiptPrefillStatus?.state === 'ready') amountInputRef.current?.focus()
  }, [receiptPrefillStatus?.state])

  useEffect(() => {
    if (voidTarget) voidHeadingRef.current?.focus()
    else if (wasVoidOpenRef.current) voidTriggerRef.current?.focus()
    wasVoidOpenRef.current = Boolean(voidTarget)
  }, [voidTarget])

  function resetForm() {
    clearReceiptPrefillFromUrl()
    prefilledReceiptRef.current = null
    setReceiptPrefillStatus(null)
    setOutflowType('')
    setDescription('')
    setAmount('')
    setPaidOnOverride(null)
    setOrderSearch('')
    setSelectedOrder(null)
    setOrderOptions([])
    setOrdersError(null)
    setSelectedReceiptIds([])
    setFormError(null)
    setUncertain(false)
    setSelectedExpenseScheduleId(null)
  }

  function openExpenseScheduleForm(template?: RecurringOperationTemplate) {
    setEditingExpenseSchedule(template ?? null)
    setExpenseScheduleDescription(template?.description ?? template?.name ?? '')
    setExpenseScheduleAmount(template?.amount_cents === null || template?.amount_cents === undefined ? '' : centsToBrazilianInput(BigInt(template.amount_cents)))
    setExpenseScheduleDay(String(template?.day_of_month ?? Number(today.slice(8, 10))))
    setExpenseScheduleStartsOn(template?.starts_on ?? today)
    setExpenseScheduleError(null)
    setShowExpenseScheduleForm(true)
  }

  async function saveExpenseSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || expenseScheduleSaving) return
    const name = expenseScheduleDescription.trim()
    const amountCents = parseBrazilianCurrency(expenseScheduleAmount)
    const day = Number(expenseScheduleDay)
    if (!name || name.length > 200
      || amountCents === null || !Number.isSafeInteger(amountCents) || amountCents <= 0
      || !Number.isInteger(day) || day < 1 || day > 31
      || !isCalendarDate(expenseScheduleStartsOn)) {
      setExpenseScheduleError('Informe a descrição, um valor positivo, o dia do mês (1 a 31) e uma data inicial válida.')
      return
    }
    setExpenseScheduleSaving(true)
    setExpenseScheduleError(null)
    const dueAnchor = expenseScheduleStartsOn < today ? today : expenseScheduleStartsOn
    const nextDueOn = editingExpenseSchedule
      && day === editingExpenseSchedule.day_of_month
      && expenseScheduleStartsOn === editingExpenseSchedule.starts_on
      ? editingExpenseSchedule.next_due_on
      : firstMonthlyDueDate(dueAnchor, day)
    const templateValues = {
      name,
      description: name,
      category: editingExpenseSchedule?.category ?? null,
      product_id: null,
      quantity: null,
      expected_unit_cost_cents: null,
      amount_cents: amountCents,
      day_of_month: day,
      starts_on: expenseScheduleStartsOn,
      next_due_on: nextDueOn,
      is_active: editingExpenseSchedule?.is_active ?? true,
    }
    try {
      const result = editingExpenseSchedule
        ? await supabaseClient.from('recurring_operation_templates').update(templateValues).eq('business_id', businessId).eq('id', editingExpenseSchedule.id)
        : await supabaseClient.from('recurring_operation_templates').insert({ business_id: businessId, kind: 'operating_expense' as const, counterparty_name: null, ...templateValues })
      if (result.error) throw result.error
      setShowExpenseScheduleForm(false)
      setEditingExpenseSchedule(null)
      setNotice(editingExpenseSchedule ? 'Lembrete de despesa atualizado.' : 'Lembrete de despesa mensal criado. Ele não registra pagamento sozinho.')
      await loadExpenseSchedules()
    } catch {
      setExpenseScheduleError('Não foi possível salvar o lembrete. Confira os dados e tente novamente.')
    } finally {
      setExpenseScheduleSaving(false)
    }
  }

  async function pauseExpenseSchedule(template: RecurringOperationTemplate) {
    if (!supabaseClient || expenseScheduleBusyId) return
    setExpenseScheduleBusyId(template.id)
    setExpenseScheduleError(null)
    try {
      const { error } = await supabaseClient.from('recurring_operation_templates').update({ is_active: false })
        .eq('business_id', businessId).eq('id', template.id)
      if (error) throw error
      await loadExpenseSchedules()
    } catch {
      setExpenseScheduleError('Não foi possível pausar este lembrete. Tente novamente.')
    } finally {
      setExpenseScheduleBusyId(null)
    }
  }

  async function resumeExpenseSchedule(template: RecurringOperationTemplate) {
    if (!supabaseClient || expenseScheduleBusyId) return
    setExpenseScheduleBusyId(template.id)
    setExpenseScheduleError(null)
    try {
      const { error } = await supabaseClient.from('recurring_operation_templates').update({ is_active: true })
        .eq('business_id', businessId).eq('id', template.id)
      if (error) throw error
      await loadExpenseSchedules()
    } catch {
      setExpenseScheduleError('Não foi possível reativar este lembrete. Tente novamente.')
    } finally {
      setExpenseScheduleBusyId(null)
    }
  }

  function startScheduledExpense(template: RecurringOperationTemplate) {
    resetForm()
    setShowForm(true)
    setNotice(null)
    setOutflowType('operating_expense')
    setDescription(template.description ?? template.name)
    setAmount(template.amount_cents === null ? '' : centsToBrazilianInput(BigInt(template.amount_cents)))
    setPaidOnOverride(null)
    setSelectedExpenseScheduleId(template.id)
  }

  async function completeExpenseSchedule(templateId: string, dueOn: string, outflowId: string) {
    if (!supabaseClient) {
      setExpenseScheduleCompletionError('O gasto foi salvo, mas o lembrete continua pendente. Atualize-o sem registrar o pagamento outra vez.')
      setPendingExpenseScheduleCompletion({ templateId, dueOn, outflowId })
      return false
    }
    try {
      const { error } = await supabaseClient.rpc('complete_recurring_operation_template', {
        p_business_id: businessId,
        p_template_id: templateId,
        p_due_on: dueOn,
        p_inventory_receipt_id: null,
        p_financial_outflow_id: outflowId,
      })
      if (error) throw error
      setPendingExpenseScheduleCompletion(null)
      setExpenseScheduleCompletionError(null)
      await loadExpenseSchedules()
      return true
    } catch {
      setExpenseScheduleCompletionError('O gasto foi salvo, mas o lembrete continua pendente. Atualize-o sem registrar o pagamento outra vez.')
      setPendingExpenseScheduleCompletion({ templateId, dueOn, outflowId })
      return false
    }
  }

  async function retryExpenseScheduleCompletion() {
    if (!pendingExpenseScheduleCompletion || expenseScheduleBusyId) return
    setExpenseScheduleBusyId(pendingExpenseScheduleCompletion.templateId)
    try {
      const completed = await completeExpenseSchedule(
        pendingExpenseScheduleCompletion.templateId,
        pendingExpenseScheduleCompletion.dueOn,
        pendingExpenseScheduleCompletion.outflowId,
      )
      if (completed) setNotice('Lembrete atualizado. O pagamento já estava salvo; nenhuma despesa repetida foi criada.')
    } finally {
      setExpenseScheduleBusyId(null)
    }
  }

  function toggleReceipt(receiptId: string) {
    if (receiptPrefillStatus?.state === 'ready' && selectedReceiptIds.includes(receiptId)) {
      clearReceiptPrefillFromUrl()
      prefilledReceiptRef.current = null
      setReceiptPrefillStatus(null)
      setSelectedReceiptIds((current) => current.filter((id) => id !== receiptId))
      return
    }
    setSelectedReceiptIds((current) => current.includes(receiptId)
      ? current.filter((id) => id !== receiptId)
      : [...current, receiptId])
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    if (!supabaseClient) {
      setFormError('A conexão da empresa não está disponível.')
      return
    }
    const trimmedDescription = description.trim()
    const amountCents = parseBrazilianCurrency(amount)

    if (trimmedDescription.length < 1 || trimmedDescription.length > 200) {
      setFormError('Informe uma descrição com até 200 caracteres.')
      return
    }
    if (amountCents === null || Number.isNaN(amountCents) || amountCents <= 0) {
      setFormError('Informe um valor pago positivo em reais.')
      return
    }
    if (!isCalendarDate(paidOn) || paidOn > today) {
      setFormError('Informe a data real do pagamento, hoje ou anterior.')
      return
    }
    if (!outflowType) {
      setFormError('Escolha o tipo de despesa.')
      return
    }
    if (outflowType !== 'purchase' && selectedReceiptIds.length > 0) {
      setFormError('Só compras podem ser relacionadas a uma compra recebida.')
      return
    }

    setSaving(true)
    setFormError(null)
    try {
      const { data: savedOutflowId, error, status } = await supabaseClient.rpc('record_financial_outflow', {
        p_business_id: businessId,
        p_outflow_type: outflowType,
        p_description: trimmedDescription,
        p_category: null,
        p_counterparty_name: null,
        p_amount_cents: amountCents,
        p_paid_on: paidOn,
        p_order_id: outflowType === 'delivery_cost' ? selectedOrder?.id ?? null : null,
        p_notes: null,
        p_inventory_receipt_ids: outflowType === 'purchase' ? selectedReceiptIds : [],
        p_request_id: requestIdRef.current,
      })
      if (error) {
        if (status >= 400 && status < 500) {
          requestIdRef.current = newRequestId()
          setUncertain(false)
          setFormError('A despesa não foi salva. Confira os campos e tente de novo.')
        } else {
          setUncertain(true)
          setFormError('Não foi possível confirmar se a despesa foi salva. Tente de novo sem mudar os dados para evitar repetição.')
        }
        return
      }
      const linkedSchedule = selectedExpenseScheduleId
        ? expenseSchedules.find((template) => template.id === selectedExpenseScheduleId)
        : null
      const scheduleAdvanced = linkedSchedule && typeof savedOutflowId === 'string'
        ? await completeExpenseSchedule(linkedSchedule.id, linkedSchedule.next_due_on, savedOutflowId)
        : null
      if (linkedSchedule && typeof savedOutflowId !== 'string') {
        setExpenseScheduleCompletionError('O pagamento foi salvo, mas o lembrete não foi atualizado. Atualize a tela antes de registrar outra despesa.')
      }
      const paidReceiptIds = outflowType === 'purchase' ? new Set(selectedReceiptIds) : new Set<string>()
      if (paidReceiptIds.size > 0) {
        setReceiptOptions((current) => current.filter((receipt) => !paidReceiptIds.has(receipt.id)))
      }
      setNotice(linkedSchedule
        ? scheduleAdvanced
          ? 'Despesa paga registrada. O lembrete foi avançado para o próximo mês.'
          : 'Despesa paga registrada. O lembrete segue pendente; atualize a data sem registrar o pagamento outra vez.'
        : linkedSchedule
          ? 'Despesa paga registrada. Confira o aviso do lembrete antes de fechar.'
          : 'Despesa paga salva. O sistema não fez o pagamento nem consultou o banco.')
      setShowForm(false)
      resetForm()
      requestIdRef.current = newRequestId()
      await loadHistory(0)
    } catch {
      setUncertain(true)
      setFormError('Não foi possível confirmar se a despesa foi salva. Seus dados continuam no formulário; tente de novo sem mudar nada.')
    } finally {
      setSaving(false)
    }
  }

  function changeOutflowType(value: OutflowType | '') {
    if (receiptPrefillStatus?.state === 'ready' && value !== 'purchase') continueWithoutReceiptLink()
    setOutflowType(value)
    setFormError(null)
    if (value !== 'purchase') setSelectedReceiptIds([])
    if (value !== 'delivery_cost') {
      setSelectedOrder(null)
      setOrderSearch('')
      setOrderOptions([])
      setOrdersError(null)
    }
  }

  function applyRecentOutflowSuggestion(outflow: OutflowView) {
    setOutflowType(outflow.outflow_type)
    setDescription(outflow.description)
    setAmount('')
    setPaidOnOverride(null)
    setSelectedOrder(null)
    setOrderSearch('')
    setSelectedReceiptIds([])
    setFormError(null)
    setReceiptPrefillStatus(null)
    prefilledReceiptRef.current = null
    clearReceiptPrefillFromUrl()
  }

  function openVoidForm(outflow: OutflowView, trigger: HTMLButtonElement) {
    setShowForm(false)
    voidTriggerRef.current = trigger
    voidRequestIdRef.current = newRequestId()
    setVoidReason('')
    setVoidError(null)
    setVoidUncertain(false)
    setVoidNotice(null)
    setVoidTarget(outflow)
  }

  async function handleVoidSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!voidTarget || voiding) return
    if (!supabaseClient) {
      setVoidError('A conexão da empresa não está disponível.')
      return
    }
    const reason = voidReason.trim()
    if (reason.length < 1 || reason.length > 1000) {
      setVoidError('Informe o motivo da anulação, com até 1.000 caracteres.')
      return
    }
    const confirmed = window.confirm(`Corrigir a despesa de ${formatAmount(voidTarget.amount_cents)}? Ela sai dos totais, mas continua no histórico. Esta ação não registra outra entrada ou saída de dinheiro.`)
    if (!confirmed) return

    setVoiding(true)
    setVoidError(null)
    try {
      const { error, status } = await supabaseClient.rpc('void_financial_outflow', {
        p_business_id: businessId,
        p_outflow_id: voidTarget.id,
        p_reason: reason,
        p_request_id: voidRequestIdRef.current,
      })
      if (error) {
        if (status >= 400 && status < 500) {
          voidRequestIdRef.current = newRequestId()
          setVoidUncertain(false)
          setVoidError('A anulação não foi registrada. Confira o motivo e tente novamente.')
        } else {
          setVoidUncertain(true)
          setVoidError('Não foi possível confirmar a anulação. Tente novamente sem alterar o motivo para evitar duplicidade.')
        }
        return
      }
      setVoidNotice('Despesa corrigida e mantida no histórico. Nenhuma outra entrada ou saída de dinheiro foi registrada.')
      setVoidTarget(null)
      setVoidReason('')
      setVoidUncertain(false)
      voidRequestIdRef.current = newRequestId()
      await loadHistory(historyPage)
      window.requestAnimationFrame(() => voidNoticeRef.current?.focus())
    } catch {
      setVoidUncertain(true)
      setVoidError('Não foi possível confirmar a anulação. Tente novamente sem alterar o motivo para evitar duplicidade.')
    } finally {
      setVoiding(false)
    }
  }

  const startRow = historyTotal === 0 ? 0 : historyPage * PAGE_SIZE + 1
  const endRow = Math.min((historyPage + 1) * PAGE_SIZE, historyTotal)
  const pageCount = Math.max(1, Math.ceil(historyTotal / PAGE_SIZE))
  const recentOutflowSuggestions = Array.from(new Map<string, OutflowView>(outflows
    .filter((outflow) => !outflow.void_event)
    .map((outflow): [string, OutflowView] => [
      `${outflow.outflow_type}|${outflow.description}`,
      outflow,
    ])).values()).slice(0, 4)
  const dueExpenseSchedules = expenseSchedules.filter((template) => template.is_active && template.next_due_on <= today)

  return (
    <div className="page-stack">
      <FinanceNavigation active="outflows" />
      <header className="page-heading">
        <div>
          <p className="eyebrow">FINANCEIRO · DESPESAS PAGAS</p>
          <h1>Despesas pagas</h1>
        </div>
        <div className="record-heading-actions"><button className="button button-secondary" disabled={Boolean(voidTarget) || showForm} onClick={() => openExpenseScheduleForm()} type="button">Agendar despesa</button><button className="button button-primary" disabled={Boolean(voidTarget) || showExpenseScheduleForm} onClick={() => { resetForm(); setNotice(null); setVoidNotice(null); setShowForm(true) }} ref={formTriggerRef} type="button">Adicionar despesa paga</button></div>
      </header>

      {notice && <p className="form-message form-message-success" role="status">{notice}</p>}
      {voidNotice && <p className="form-message form-message-success" ref={voidNoticeRef} role="status" tabIndex={-1}>{voidNotice}</p>}
      {expenseScheduleCompletionError && <div className="form-message form-message-warning" role="alert"><p>{expenseScheduleCompletionError}</p>{pendingExpenseScheduleCompletion && <button className="text-button" disabled={Boolean(expenseScheduleBusyId)} onClick={() => void retryExpenseScheduleCompletion()} type="button">{expenseScheduleBusyId ? 'Atualizando…' : 'Atualizar lembrete'}</button>}</div>}
      {expenseScheduleError && <p className="form-message form-message-warning" role="status">{expenseScheduleError}</p>}

      {showExpenseScheduleForm && <form className="surface-panel record-form" onSubmit={(event) => void saveExpenseSchedule(event)}>
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">LEMBRETE OPCIONAL</p><h2>{editingExpenseSchedule ? 'Editar despesa mensal' : 'Agendar despesa mensal'}</h2></div><button className="text-button" disabled={expenseScheduleSaving} onClick={() => { setShowExpenseScheduleForm(false); setEditingExpenseSchedule(null) }} type="button">Fechar</button></div>
        <p className="section-footnote">O lembrete não paga a conta automaticamente.</p>
        <div className="record-form-grid">
          <label className="record-field"><span className="field-label">Despesa</span><input className="text-input" disabled={expenseScheduleSaving} maxLength={200} onChange={(event) => setExpenseScheduleDescription(event.target.value)} placeholder="Ex.: Conta de luz" required value={expenseScheduleDescription} /></label>
          <label className="record-field"><span className="field-label">Valor previsto · R$</span><input className="text-input" disabled={expenseScheduleSaving} inputMode="decimal" onChange={(event) => setExpenseScheduleAmount(event.target.value)} placeholder="Ex.: 180,00" required value={expenseScheduleAmount} /></label>
          <label className="record-field"><span className="field-label">Dia do mês</span><input className="text-input" disabled={expenseScheduleSaving} inputMode="numeric" max="31" min="1" onChange={(event) => setExpenseScheduleDay(event.target.value)} required type="number" value={expenseScheduleDay} /><small className="field-optional">{expenseScheduleDay ? formatRecurringDay(Number(expenseScheduleDay)) : 'Escolha de 1 a 31'}; em meses curtos, usa o último dia.</small></label>
          <label className="record-field"><span className="field-label">Começar em</span><input className="text-input" disabled={expenseScheduleSaving} onChange={(event) => setExpenseScheduleStartsOn(event.target.value)} required type="date" value={expenseScheduleStartsOn} /></label>
        </div>
        {expenseScheduleError && <p className="form-message form-message-error" role="alert">{expenseScheduleError}</p>}
        <div className="record-form-actions"><button className="button button-primary" disabled={expenseScheduleSaving} type="submit">{expenseScheduleSaving ? 'Salvando…' : editingExpenseSchedule ? 'Salvar alterações' : 'Salvar lembrete'}</button><button className="text-button" disabled={expenseScheduleSaving} onClick={() => { setShowExpenseScheduleForm(false); setEditingExpenseSchedule(null) }} type="button">Cancelar</button></div>
      </form>}

      {expenseSchedules.length > 0 && <details className="surface-panel dashboard-trend-details" open={dueExpenseSchedules.length > 0}>
        <summary>Despesas programadas <span>{dueExpenseSchedules.length ? dueExpenseSchedules.length + ' para conferir' : expenseSchedules.filter((template) => template.is_active).length + ' ativas'}{expenseSchedules.some((template) => !template.is_active) ? ` · ${expenseSchedules.filter((template) => !template.is_active).length} pausadas` : ''}</span></summary>
        <div className="inventory-history-content">
          <ul className="inventory-balance-list">{expenseSchedules.map((template) => {
            const due = template.is_active && template.next_due_on <= today
            const amountText = template.amount_cents === null ? '' : formatBRLExact(String(template.amount_cents))
            return <li key={template.id}><span className="inventory-balance-copy"><strong>{template.name}{!template.is_active && ' · Pausada'}</strong><small>{formatRecurringDay(template.day_of_month)} · próxima: {formatBusinessDate(template.next_due_on)} · previsto {amountText}</small></span><span className="record-form-actions">{template.is_active ? <><button className="button button-secondary" disabled={Boolean(expenseScheduleBusyId)} onClick={() => startScheduledExpense(template)} type="button">{due ? 'Registrar como pago' : 'Registrar pagamento'}</button><button className="text-button" disabled={Boolean(expenseScheduleBusyId)} onClick={() => openExpenseScheduleForm(template)} type="button">Editar</button><button className="text-button" disabled={Boolean(expenseScheduleBusyId)} onClick={() => void pauseExpenseSchedule(template)} type="button">{expenseScheduleBusyId === template.id ? 'Pausando…' : 'Pausar'}</button></> : <button className="text-button" disabled={Boolean(expenseScheduleBusyId)} onClick={() => void resumeExpenseSchedule(template)} type="button">{expenseScheduleBusyId === template.id ? 'Reativando…' : 'Reativar'}</button>}</span></li>
          })}</ul>
        </div>
      </details>}

      {showForm && (
        <form className="surface-panel record-form" onSubmit={handleSubmit}>
          <div className="section-heading section-heading-compact">
            <div><p className="eyebrow">NOVA DESPESA</p><h2 ref={formHeadingRef} tabIndex={-1}>Adicionar despesa já paga</h2></div>
            <button className="text-button" disabled={saving || uncertain} onClick={() => { setShowForm(false); clearReceiptPrefillFromUrl(); prefilledReceiptRef.current = null; setReceiptPrefillStatus(null) }} type="button">Fechar</button>
          </div>
          {receiptPrefillStatus && <div className={`form-message ${receiptPrefillStatus.state === 'error' ? 'form-message-warning' : receiptPrefillStatus.state === 'ready' ? 'form-message-success' : ''}`} role={receiptPrefillStatus.state === 'error' ? 'alert' : 'status'}>
            <p>{receiptPrefillStatus.message}</p>
            {receiptPrefillStatus.state === 'error' && <button className="text-button" disabled={saving} onClick={continueWithoutReceiptLink} type="button">Continuar sem vincular recebimento</button>}
          </div>}
          {!receiptPrefillStatus && recentOutflowSuggestions.length > 0 && <div className="record-field record-field-wide">
            <span className="field-label">Gastos recentes</span>
            <div className="record-form-actions">
              {recentOutflowSuggestions.map((outflow) => <button className="button button-secondary" key={`${outflow.id}-${outflow.description}`} onClick={() => applyRecentOutflowSuggestion(outflow)} type="button">
                {outflow.description}
              </button>)}
            </div>
          </div>}

          <div className="record-form-grid">
            <label className="record-field">
              <span className="field-label">Tipo de gasto <span aria-hidden="true">*</span></span>
              <select className="text-input" disabled={saving || uncertain || receiptPrefillBlocked || receiptPrefillStatus?.state === 'ready' || Boolean(selectedExpenseScheduleId)} onChange={(event) => changeOutflowType(event.target.value as OutflowType | '')} required value={outflowType}>
                <option value="">Selecione o tipo de gasto</option>
              <option value="purchase">Compra de estoque</option>
              <option value="operating_expense">Despesa da empresa</option>
              <option value="delivery_cost">Custo de entrega</option>
              </select>
            </label>
            <label className="record-field">
              <span className="field-label">Valor pago (R$) <span aria-hidden="true">*</span></span>
              <input className="text-input" disabled={saving || uncertain || receiptPrefillBlocked} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} placeholder="0,00" ref={amountInputRef} required value={amount} />
            </label>
            <label className="record-field">
              <span className="field-label">Nome do gasto <span aria-hidden="true">*</span></span>
              <input className="text-input" disabled={saving || uncertain || receiptPrefillBlocked} maxLength={200} onChange={(event) => setDescription(event.target.value)} required value={description} />
            </label>
            <label className="record-field">
              <span className="field-label">Pago em <span aria-hidden="true">*</span></span>
              <input className="text-input" disabled={saving || uncertain || receiptPrefillBlocked} max={today} onChange={(event) => setPaidOnOverride(event.target.value)} required type="date" value={paidOn} />
            </label>
            {salaryExpenseDraft && <p className="form-message form-message-warning record-field-wide" role="status">Se o salário está cadastrado na equipe, registre o pagamento em <Link className="quiet-link" to="/equipe#pagamentos-equipe">Equipe · Salários a pagar</Link> para evitar lançar a mesma competência duas vezes.</p>}
            {outflowType === 'purchase' && <div className="record-field record-field-wide">
              <span className="field-label">Compra de estoque relacionada <span className="field-optional">opcional</span></span>
              <p className="section-footnote">Escolha a compra relacionada a esta despesa.</p>
              {receiptLoading && <p className="inline-state">Carregando compras recebidas…</p>}
              {receiptError && <div className="form-message form-message-warning" role="status"><p>{receiptError}</p><button className="text-button" disabled={saving || uncertain} onClick={() => void loadReceiptOptions()} type="button">Tentar carregar novamente</button></div>}
              {!receiptLoading && !receiptError && receiptOptions.length === 0 && <p className="inline-state">Nenhum recebimento disponível neste lote. Compras já pagas ficam ocultas.</p>}
              {!receiptLoading && !receiptError && receiptOptions.length > 0 && (
                <div className="inventory-receipt-choice-list">
                  {receiptOptions.map((receipt) => {
                    const supplier = receipt.supplier_name?.trim() || 'Fornecedor não informado'
                    const reference = receipt.purchase_reference?.trim()
                    return <label className="record-checkbox" key={receipt.id}>
                      <input checked={selectedReceiptIds.includes(receipt.id)} disabled={saving || uncertain || receiptPrefillBlocked} onChange={() => toggleReceipt(receipt.id)} type="checkbox" />
                      <span>{supplier}{reference ? ` · Ref. ${reference}` : ''} · {formatBusinessDate(receipt.received_on)}</span>
                    </label>
                  })}
                  <p className="field-optional">{receiptOptions.length} recebimentos disponíveis entre {Math.min(receiptOffsetRef.current, receiptOptionsTotal)} analisados; compras já pagas ficam ocultas.</p>
                </div>
              )}
              {!receiptLoading && !receiptError && receiptOffsetRef.current < receiptOptionsTotal && <button className="text-button" disabled={saving || uncertain || receiptLoadingMore} onClick={() => void loadReceiptOptions(true)} type="button">{receiptLoadingMore ? 'Carregando…' : 'Carregar recebimentos anteriores'}</button>}
            </div>}

            {outflowType === 'delivery_cost' && <div className="record-field record-field-wide">
              <label className="record-field">
                <span className="field-label">Localizar pedido vinculado <span className="field-optional">opcional</span></span>
                <input className="text-input" disabled={saving || uncertain} onChange={(event) => setOrderSearch(event.target.value)} placeholder="Nome do cliente" value={orderSearch} />
              </label>
              <label className="record-field">
                <span className="field-label">Pedido <span className="field-optional">opcional</span></span>
                <select className="text-input" disabled={saving || uncertain || ordersLoading} onChange={(event) => {
                  const selected = orderOptions.find((order) => order.id === event.target.value) ?? null
                  setSelectedOrder(selected)
                }} value={selectedOrder?.id ?? ''}>
                  <option value="">Sem pedido vinculado</option>
                  {orderOptions.map((order) => <option key={order.id} value={order.id}>{order.customer_name_snapshot} · {order.id.slice(0, 8)}</option>)}
                </select>
              </label>
              {ordersLoading && <p className="inline-state">Localizando pedidos…</p>}
              {ordersError && <p className="form-message form-message-warning" role="status">{ordersError}</p>}
              <p className="section-footnote">Informe o custo pago manualmente. Ele não é calculado pela taxa cobrada do cliente.</p>
            </div>}

          </div>

          {formError && <p className="form-message form-message-error" role="alert">{formError}</p>}
          <div className="record-form-actions">
            <button className="button button-primary" disabled={saving || receiptPrefillStatus?.state === 'loading' || receiptPrefillStatus?.state === 'error'} type="submit">{saving ? 'Registrando…' : uncertain ? 'Tentar novamente sem alterar os dados' : 'Registrar valor pago'}</button>
            <button className="text-button" disabled={saving || uncertain} onClick={() => { setShowForm(false); clearReceiptPrefillFromUrl(); prefilledReceiptRef.current = null; setReceiptPrefillStatus(null) }} type="button">Descartar</button>
          </div>
        </form>
      )}

      {voidTarget && <form className="surface-panel record-form" onSubmit={handleVoidSubmit}>
        <div className="section-heading section-heading-compact">
          <div><p className="eyebrow">CORRIGIR DESPESA</p><h2 ref={voidHeadingRef} tabIndex={-1}>Corrigir despesa registrada por engano</h2></div>
          <button className="text-button" disabled={voiding || voidUncertain} onClick={() => setVoidTarget(null)} type="button">Fechar</button>
        </div>
        <p className="section-footnote">{outflowTypeLabel(voidTarget.outflow_type)} · {voidTarget.description} · {formatAmount(voidTarget.amount_cents)}. A correção tira este valor dos totais, mas mantém o registro no histórico. Não cria um reembolso.</p>
        <label className="record-field record-field-wide"><span className="field-label">Por que está corrigindo? <span aria-hidden="true">*</span></span><textarea className="text-input record-textarea" disabled={voiding || voidUncertain} maxLength={1000} onChange={(event) => setVoidReason(event.target.value)} required rows={2} value={voidReason} /></label>
        {voidError && <p className="form-message form-message-error" role="alert">{voidError}</p>}
        <div className="record-form-actions">
          <button className="button button-secondary" disabled={voiding || voidUncertain} onClick={() => setVoidTarget(null)} type="button">Manter despesa</button>
          <button className="button button-primary" disabled={voiding || voidUncertain} type="submit">{voiding ? 'Corrigindo…' : voidUncertain ? 'Tentar de novo sem mudar o motivo' : 'Corrigir despesa'}</button>
        </div>
      </form>}

      <section className="surface-panel record-panel" aria-labelledby="financial-outflows-heading">
        <div className="section-heading section-heading-compact">
          <div><p className="eyebrow">HISTÓRICO</p><h2 id="financial-outflows-heading">Despesas pagas</h2></div>
          <span className="neutral-status">{historyLoading ? '…' : historyTotal}</span>
        </div>
        <p className="section-footnote">Aqui ficam as despesas que a equipe informou como pagas. Corrija uma despesa errada; isso não cria um reembolso.</p>
        {referenceWarning && <p className="form-message form-message-warning" role="status">{referenceWarning}</p>}
        {historyError && <div className="inline-state inline-state-error" role="alert"><p>{historyError}</p><button className="text-button" onClick={() => void loadHistory(historyPage)} type="button">Tentar novamente</button></div>}
        {historyLoading && <p className="inline-state" aria-live="polite">Carregando despesas…</p>}
        {!historyLoading && !historyError && outflows.length === 0 && <p className="inline-state">Nenhuma saída paga registrada ainda.</p>}
        {!historyLoading && !historyError && outflows.length > 0 && <>
          <div aria-label="Pagamentos informados" className="report-table-wrap" role="region" tabIndex={0}>
            <table className="report-table">
              <thead><tr><th>Pago em</th><th>Tipo</th><th>Gasto</th><th>Valor pago</th><th>Referências</th><th>Situação / ação</th></tr></thead>
              <tbody>{outflows.map((outflow) => (
                <tr key={outflow.id}>
                  <td>{formatBusinessDate(outflow.paid_on)}</td>
                  <td>{outflowTypeLabel(outflow.outflow_type)}</td>
                  <td>{outflow.description}</td>
                  <td>{formatAmount(outflow.amount_cents)}</td>
                  <td>
                    {outflow.order_id && <p><Link className="report-order-link" to={`/pedidos/${outflow.order_id}`}>{outflow.order_name || `Pedido ${outflow.order_id.slice(0, 8)}`}</Link></p>}
                    {outflow.receipts.map((receipt) => <p key={receipt.id}>{receipt.supplier_name || 'Recebimento de estoque'}{receipt.purchase_reference ? ` · Ref. ${receipt.purchase_reference}` : ''} · {formatBusinessDate(receipt.received_on)}</p>)}
                    {!outflow.order_id && outflow.receipts.length === 0 && '—'}
                  </td>
                  <td>{outflow.void_event ? <><strong>Corrigido</strong><small className="section-footnote">{formatBusinessDate(businessDateFromTimestamp(outflow.void_event.created_at))} · {outflow.void_event.reason}</small></> : <button className="text-button" disabled={voiding} onClick={(event) => openVoidForm(outflow, event.currentTarget)} type="button">Corrigir</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {referenceWarning && <p className="section-footnote">Alguns pedidos ou compras relacionadas podem não aparecer.</p>}
          <div className="inventory-history-actions">
            <span className="section-footnote">Exibindo {startRow}–{endRow} de {historyTotal} despesas.</span>
            <div className="record-heading-actions">
              <button className="button button-secondary" disabled={historyLoading || historyPage === 0} onClick={() => void loadHistory(historyPage - 1)} type="button">Anterior</button>
              <span className="neutral-status">Página {historyPage + 1} de {pageCount}</span>
              <button className="button button-secondary" disabled={historyLoading || endRow >= historyTotal} onClick={() => void loadHistory(historyPage + 1)} type="button">Próxima</button>
            </div>
          </div>
        </>}
      </section>
    </div>
  )
}
