import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { FinanceNavigation } from '../components/FinanceNavigation'
import { formatBRLExact, formatBusinessDate, parseBrazilianCurrency } from '../lib/formatters'
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
  category: string | null
  counterparty_name: string | null
  amount_cents: number | string
  paid_on: string
  order_id: string | null
  notes: string | null
  created_at: string
}
type InventoryReceipt = {
  id: string
  supplier_name: string | null
  purchase_reference: string | null
  received_on: string
}
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
  const [outflows, setOutflows] = useState<OutflowView[]>([])
  const [historyPage, setHistoryPage] = useState(0)
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [referenceWarning, setReferenceWarning] = useState<string | null>(null)
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
  const [category, setCategory] = useState('')
  const [counterpartyName, setCounterpartyName] = useState('')
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
  const [notes, setNotes] = useState('')

  const requestIdRef = useRef(newRequestId())
  const historyRequestRef = useRef(0)
  const orderSearchRequestRef = useRef(0)
  const receiptOffsetRef = useRef(0)
  const formTriggerRef = useRef<HTMLButtonElement>(null)
  const formHeadingRef = useRef<HTMLHeadingElement>(null)
  const wasFormOpenRef = useRef(false)
  const voidHeadingRef = useRef<HTMLHeadingElement>(null)
  const voidNoticeRef = useRef<HTMLParagraphElement>(null)
  const voidTriggerRef = useRef<HTMLButtonElement | null>(null)
  const wasVoidOpenRef = useRef(false)
  const voidRequestIdRef = useRef(newRequestId())

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
        .select('id, business_id, outflow_type, description, category, counterparty_name, amount_cents, paid_on, order_id, notes, created_at', { count: 'exact' })
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
          warning = 'Os lançamentos foram carregados, mas não foi possível carregar os vínculos com recebimentos físicos.'
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
          warning = 'Os lançamentos foram carregados, mas não foi possível carregar os detalhes dos recebimentos físicos vinculados.'
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
          warning = 'Os lançamentos foram carregados, mas não foi possível carregar os nomes dos pedidos vinculados.'
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
      setHistoryError('Não foi possível carregar os lançamentos pagos. Tente novamente.')
      setOutflows([])
      setHistoryTotal(0)
      setReferenceWarning(null)
    } finally {
      if (request === historyRequestRef.current) setHistoryLoading(false)
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
      const rows = (data ?? []) as InventoryReceipt[]
      receiptOffsetRef.current = from + rows.length
      setReceiptOptions((current) => append ? [...current, ...rows] : rows)
      setReceiptOptionsTotal(count ?? (append ? from + rows.length : rows.length))
    } catch {
      setReceiptError('Não foi possível carregar os recebimentos físicos. Você ainda pode registrar a compra sem vinculá-la.')
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
        setOrdersError('Não foi possível localizar pedidos. O vínculo é opcional; você pode registrar o custo sem associá-lo.')
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
    if (voidTarget) voidHeadingRef.current?.focus()
    else if (wasVoidOpenRef.current) voidTriggerRef.current?.focus()
    wasVoidOpenRef.current = Boolean(voidTarget)
  }, [voidTarget])

  function resetForm() {
    setOutflowType('')
    setDescription('')
    setCategory('')
    setCounterpartyName('')
    setAmount('')
    setPaidOnOverride(null)
    setOrderSearch('')
    setSelectedOrder(null)
    setOrderOptions([])
    setOrdersError(null)
    setSelectedReceiptIds([])
    setNotes('')
    setFormError(null)
    setUncertain(false)
  }

  function toggleReceipt(receiptId: string) {
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
    const trimmedCategory = category.trim()
    const trimmedCounterparty = counterpartyName.trim()
    const trimmedNotes = notes.trim()
    const amountCents = parseBrazilianCurrency(amount)

    if (trimmedDescription.length < 1 || trimmedDescription.length > 200) {
      setFormError('Informe uma descrição com até 200 caracteres.')
      return
    }
    if (trimmedCategory.length > 120 || trimmedCounterparty.length > 160 || trimmedNotes.length > 2000) {
      setFormError('Confira o tamanho da categoria, contraparte ou observação.')
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
      setFormError('Escolha o tipo de gasto para salvar o registro.')
      return
    }
    if (outflowType !== 'purchase' && selectedReceiptIds.length > 0) {
      setFormError('Vínculos a recebimentos físicos só podem ser usados em compras.')
      return
    }

    setSaving(true)
    setFormError(null)
    try {
      const { error, status } = await supabaseClient.rpc('record_financial_outflow', {
        p_business_id: businessId,
        p_outflow_type: outflowType,
        p_description: trimmedDescription,
        p_category: trimmedCategory || null,
        p_counterparty_name: trimmedCounterparty || null,
        p_amount_cents: amountCents,
        p_paid_on: paidOn,
        p_order_id: outflowType === 'delivery_cost' ? selectedOrder?.id ?? null : null,
        p_notes: trimmedNotes || null,
        p_inventory_receipt_ids: outflowType === 'purchase' ? selectedReceiptIds : [],
        p_request_id: requestIdRef.current,
      })
      if (error) {
        if (status >= 400 && status < 500) {
          requestIdRef.current = newRequestId()
          setUncertain(false)
          setFormError('O lançamento não foi registrado. Confira os campos e tente novamente.')
        } else {
          setUncertain(true)
          setFormError('Não foi possível confirmar se o lançamento foi registrado. Tente novamente sem alterar os dados para evitar duplicidade.')
        }
        return
      }
      setNotice('Gasto pago registrado. O sistema não processou o pagamento nem consultou o banco.')
      setShowForm(false)
      resetForm()
      requestIdRef.current = newRequestId()
      await loadHistory(0)
    } catch {
      setUncertain(true)
      setFormError('Não foi possível confirmar se o lançamento foi registrado. Seus dados foram preservados; tente novamente sem alterá-los.')
    } finally {
      setSaving(false)
    }
  }

  function changeOutflowType(value: OutflowType | '') {
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
    const confirmed = window.confirm(`Anular por erro o lançamento de ${formatAmount(voidTarget.amount_cents)}? Ele deixará de compor os totais, mas continuará no histórico. Esta ação não registra entrada ou saída adicional de dinheiro.`)
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
      setVoidNotice('Lançamento anulado por erro e mantido no histórico. Nenhuma movimentação de dinheiro foi registrada pela anulação.')
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

  return (
    <div className="page-stack">
      <FinanceNavigation active="outflows" />
      <header className="page-heading">
        <div>
          <p className="eyebrow">FINANCEIRO · GASTOS PAGOS</p>
          <h1>Gastos pagos</h1>
          <p className="page-description">Registre compras de produtos, gastos da empresa e pagamentos de entrega depois que o dinheiro sair.</p>
        </div>
        <button className="button button-primary" disabled={Boolean(voidTarget)} onClick={() => { resetForm(); setNotice(null); setVoidNotice(null); setShowForm(true) }} ref={formTriggerRef} type="button">Registrar gasto pago</button>
      </header>

      {notice && <p className="form-message form-message-success" role="status">{notice}</p>}
      {voidNotice && <p className="form-message form-message-success" ref={voidNoticeRef} role="status" tabIndex={-1}>{voidNotice}</p>}

      {showForm && (
        <form className="surface-panel record-form" onSubmit={handleSubmit}>
          <div className="section-heading section-heading-compact">
            <div><p className="eyebrow">LANÇAMENTOS</p><h2 ref={formHeadingRef} tabIndex={-1}>Registrar gasto já pago</h2></div>
            <button className="text-button" disabled={saving || uncertain} onClick={() => setShowForm(false)} type="button">Fechar</button>
          </div>
          <p className="section-footnote">Cada registro representa um valor que você já pagou. Esta tela não acompanha contas que ainda não foram pagas.</p>

          <div className="record-form-grid">
            <label className="record-field">
              <span className="field-label">Tipo de gasto <span aria-hidden="true">*</span></span>
              <select className="text-input" disabled={saving || uncertain} onChange={(event) => changeOutflowType(event.target.value as OutflowType | '')} required value={outflowType}>
                <option value="">Selecione o tipo de gasto</option>
                <option value="purchase">Compra de produtos para revenda</option>
                <option value="operating_expense">Gasto da empresa</option>
                <option value="delivery_cost">Pagamento de entrega</option>
              </select>
              {outflowType === 'purchase' && <small className="field-optional">Use quando comprar produtos que serão revendidos. Esse valor entra no lucro quando o produto é vendido.</small>}
              {outflowType === 'operating_expense' && <small className="field-optional">Use para contas da empresa, materiais e compras que não serão revendidos.</small>}
              {outflowType === 'delivery_cost' && <small className="field-optional">Informe quanto você pagou ao entregador. Esse valor pode ser diferente da taxa cobrada do cliente.</small>}
            </label>
            <label className="record-field">
              <span className="field-label">Valor pago (R$) <span aria-hidden="true">*</span></span>
              <input className="text-input" disabled={saving || uncertain} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} placeholder="0,00" required value={amount} />
            </label>
            <label className="record-field">
              <span className="field-label">Descrição <span aria-hidden="true">*</span></span>
              <input className="text-input" disabled={saving || uncertain} maxLength={200} onChange={(event) => setDescription(event.target.value)} required value={description} />
            </label>
            <label className="record-field">
              <span className="field-label">Categoria <span className="field-optional">opcional, texto livre</span></span>
              <input className="text-input" disabled={saving || uncertain} maxLength={120} onChange={(event) => setCategory(event.target.value)} value={category} />
            </label>
            <label className="record-field">
              <span className="field-label">{outflowType === 'purchase' ? 'Fornecedor' : outflowType === 'delivery_cost' ? 'Entregador / prestador' : 'Favorecido'} <span className="field-optional">opcional</span></span>
              <input className="text-input" disabled={saving || uncertain} maxLength={160} onChange={(event) => setCounterpartyName(event.target.value)} value={counterpartyName} />
            </label>
            <label className="record-field">
              <span className="field-label">Pago em <span aria-hidden="true">*</span></span>
              <input className="text-input" disabled={saving || uncertain} max={today} onChange={(event) => setPaidOnOverride(event.target.value)} required type="date" value={paidOn} />
            </label>

            {outflowType === 'purchase' && <div className="record-field record-field-wide">
              <span className="field-label">Recebimentos de estoque vinculados <span className="field-optional">opcional</span></span>
              <p className="section-footnote">O vínculo serve apenas para conferência. Ele não altera o estoque nem registra outro pagamento.</p>
              {receiptLoading && <p className="inline-state">Carregando recebimentos físicos…</p>}
              {receiptError && <div className="form-message form-message-warning" role="status"><p>{receiptError}</p><button className="text-button" disabled={saving || uncertain} onClick={() => void loadReceiptOptions()} type="button">Tentar carregar novamente</button></div>}
              {!receiptLoading && !receiptError && receiptOptions.length === 0 && <p className="inline-state">Nenhum recebimento físico disponível para vincular. A compra ainda pode ser registrada sem vínculo.</p>}
              {!receiptLoading && !receiptError && receiptOptions.length > 0 && (
                <div className="inventory-receipt-choice-list">
                  {receiptOptions.map((receipt) => {
                    const supplier = receipt.supplier_name?.trim() || 'Fornecedor não informado'
                    const reference = receipt.purchase_reference?.trim()
                    return <label className="record-checkbox" key={receipt.id}>
                      <input checked={selectedReceiptIds.includes(receipt.id)} disabled={saving || uncertain} onChange={() => toggleReceipt(receipt.id)} type="checkbox" />
                      <span>{supplier}{reference ? ` · Ref. ${reference}` : ''} · {formatBusinessDate(receipt.received_on)}</span>
                    </label>
                  })}
                  <p className="field-optional">Mostrando {receiptOptions.length} de {receiptOptionsTotal} recebimentos físicos recentes.</p>
                  {receiptOptions.length < receiptOptionsTotal && <button className="text-button" disabled={saving || uncertain || receiptLoadingMore} onClick={() => void loadReceiptOptions(true)} type="button">{receiptLoadingMore ? 'Carregando…' : 'Carregar recebimentos anteriores'}</button>}
                </div>
              )}
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

            <label className="record-field record-field-wide">
              <span className="field-label">Observações <span className="field-optional">opcional</span></span>
              <textarea className="text-input record-textarea" disabled={saving || uncertain} maxLength={2000} onChange={(event) => setNotes(event.target.value)} rows={2} value={notes} />
            </label>
          </div>

          {formError && <p className="form-message form-message-error" role="alert">{formError}</p>}
          <div className="record-form-actions">
            <button className="button button-primary" disabled={saving} type="submit">{saving ? 'Registrando…' : uncertain ? 'Tentar novamente sem alterar os dados' : 'Registrar valor pago'}</button>
            <button className="text-button" disabled={saving || uncertain} onClick={() => setShowForm(false)} type="button">Descartar</button>
          </div>
        </form>
      )}

      {voidTarget && <form className="surface-panel record-form" onSubmit={handleVoidSubmit}>
        <div className="section-heading section-heading-compact">
          <div><p className="eyebrow">CORREÇÃO AUDITÁVEL</p><h2 ref={voidHeadingRef} tabIndex={-1}>Anular lançamento por erro</h2></div>
          <button className="text-button" disabled={voiding || voidUncertain} onClick={() => setVoidTarget(null)} type="button">Fechar</button>
        </div>
        <p className="section-footnote">{outflowTypeLabel(voidTarget.outflow_type)} · {voidTarget.description} · {formatAmount(voidTarget.amount_cents)}. A anulação mantém o registro e o motivo no histórico, remove este valor dos totais e não registra um reembolso nem outra movimentação financeira.</p>
        <label className="record-field record-field-wide"><span className="field-label">Motivo da anulação <span aria-hidden="true">*</span></span><textarea className="text-input record-textarea" disabled={voiding || voidUncertain} maxLength={1000} onChange={(event) => setVoidReason(event.target.value)} required rows={2} value={voidReason} /></label>
        {voidError && <p className="form-message form-message-error" role="alert">{voidError}</p>}
        <div className="record-form-actions">
          <button className="button button-secondary" disabled={voiding || voidUncertain} onClick={() => setVoidTarget(null)} type="button">Manter lançamento</button>
          <button className="button button-primary" disabled={voiding || voidUncertain} type="submit">{voiding ? 'Anulando…' : voidUncertain ? 'Tentar novamente sem alterar o motivo' : 'Anular lançamento por erro'}</button>
        </div>
      </form>}

      <section className="surface-panel record-panel" aria-labelledby="financial-outflows-heading">
        <div className="section-heading section-heading-compact">
          <div><p className="eyebrow">PAGAMENTOS INFORMADOS</p><h2 id="financial-outflows-heading">Lançamentos pagos</h2></div>
          <span className="neutral-status">{historyLoading ? '…' : historyTotal}</span>
        </div>
        <p className="section-footnote">Cada linha é um valor pago informado manualmente. Se houver erro de lançamento, anule com um motivo e registre outro valor correto; a anulação não cria um reembolso. Esta lista não é pagamento processado nem extrato bancário.</p>
        {referenceWarning && <p className="form-message form-message-warning" role="status">{referenceWarning}</p>}
        {historyError && <div className="inline-state inline-state-error" role="alert"><p>{historyError}</p><button className="text-button" onClick={() => void loadHistory(historyPage)} type="button">Tentar novamente</button></div>}
        {historyLoading && <p className="inline-state" aria-live="polite">Carregando lançamentos…</p>}
        {!historyLoading && !historyError && outflows.length === 0 && <p className="inline-state">Nenhuma saída paga registrada ainda.</p>}
        {!historyLoading && !historyError && outflows.length > 0 && <>
          <div aria-label="Pagamentos informados" className="report-table-wrap" role="region" tabIndex={0}>
            <table className="report-table">
              <thead><tr><th>Pago em</th><th>Tipo</th><th>Descrição</th><th>Categoria</th><th>Quem recebeu</th><th>Valor pago</th><th>Referências</th><th>Situação / ação</th></tr></thead>
              <tbody>{outflows.map((outflow) => (
                <tr key={outflow.id}>
                  <td>{formatBusinessDate(outflow.paid_on)}</td>
                  <td>{outflowTypeLabel(outflow.outflow_type)}</td>
                  <td>{outflow.description}{outflow.notes && <small className="section-footnote">{outflow.notes}</small>}</td>
                  <td>{outflow.category || '—'}</td>
                  <td>{outflow.counterparty_name || '—'}</td>
                  <td>{formatAmount(outflow.amount_cents)}</td>
                  <td>
                    {outflow.order_id && <p><Link className="report-order-link" to={`/pedidos/${outflow.order_id}`}>{outflow.order_name || `Pedido ${outflow.order_id.slice(0, 8)}`}</Link></p>}
                    {outflow.receipts.map((receipt) => <p key={receipt.id}>{receipt.supplier_name || 'Recebimento de estoque'}{receipt.purchase_reference ? ` · Ref. ${receipt.purchase_reference}` : ''} · {formatBusinessDate(receipt.received_on)}</p>)}
                    {!outflow.order_id && outflow.receipts.length === 0 && '—'}
                  </td>
                  <td>{outflow.void_event ? <><strong>Anulado por erro</strong><small className="section-footnote">{formatBusinessDate(outflow.void_event.created_at)} · {outflow.void_event.reason}</small></> : <button className="text-button" disabled={voiding} onClick={(event) => openVoidForm(outflow, event.currentTarget)} type="button">Anular por erro</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {referenceWarning && <p className="section-footnote">Alguns vínculos opcionais podem estar indisponíveis nesta consulta.</p>}
          <div className="inventory-history-actions">
            <span className="section-footnote">Exibindo {startRow}–{endRow} de {historyTotal} lançamentos.</span>
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
