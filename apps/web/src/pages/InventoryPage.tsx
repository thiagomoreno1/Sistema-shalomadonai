import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { businessToday, formatBRL, formatBusinessDate } from '../lib/formatters'
import { isDiscreteInventoryUnit } from '../lib/inventoryUnits'
import { firstMonthlyDueDate, formatRecurringDay, type RecurringOperationTemplate } from '../lib/recurringOperations'
import { supabaseClient } from '../lib/supabase'

const PAGE_SIZE = 40

type Product = { id: string; name: string; inventory_unit: string | null; inventory_tracked: boolean; is_combo: boolean; is_active: boolean; cost_cents: number | null }
type Balance = { product_id: string; product_name: string; inventory_unit: string; minimum_stock: number | null; quantity_on_hand: number }
type Movement = { id: string; product_id: string; movement_type: 'opening' | 'receipt' | 'adjustment' | 'loss' | 'dispatch' | 'return'; quantity_delta: number; reason: string; order_id: string | null; receipt_id: string | null; occurred_at: string; actor_id: string }
type Receipt = { id: string; supplier_name: string | null; purchase_reference: string | null; received_on: string }
type ReceiptLineDraft = { key: string; productId: string; quantity: string; unitCost: string }

function newRequestId() { return crypto.randomUUID() }

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function parseQuantity(value: string, unit?: string | null) {
  const cleaned = value.trim().replace(',', '.')
  if (!/^\d+(?:\.\d{1,3})?$/.test(cleaned)) return null
  const quantity = Number(cleaned)
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 99999999.999) return null
  return isDiscreteInventoryUnit(unit) && !Number.isSafeInteger(quantity) ? null : quantity
}

function parseUnitCostCents(value: string) {
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value.trim())
  if (!match) return null
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null
}

function receiptLineTotalCents(quantity: number, unitCostCents: number) {
  const quantityMilli = Math.round(quantity * 1000)
  if (!Number.isSafeInteger(quantityMilli) || quantityMilli <= 0) return null
  const total = (BigInt(quantityMilli) * BigInt(unitCostCents) + 500n) / 1000n
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null
}

function unitCostInput(cents: number | null | undefined) {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2).replace('.', ',')
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(Number(value))
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value))
}

function movementLabel(type: Movement['movement_type']) {
  return ({ opening: 'Contagem inicial', receipt: 'Recebimento de compra', adjustment: 'Ajuste', loss: 'Perda ou avaria', dispatch: 'Despacho de pedido', return: 'Retorno conferido' })[type]
}

function newLine(productId = '', unitCost = ''): ReceiptLineDraft { return { key: newRequestId(), productId, quantity: '', unitCost } }

export function InventoryPage() {
  const { id: businessId } = useBusiness()
  const [products, setProducts] = useState<Product[]>([])
  const [balances, setBalances] = useState<Balance[]>([])
  const [movements, setMovements] = useState<Movement[]>([])
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [purchaseSchedules, setPurchaseSchedules] = useState<RecurringOperationTemplate[]>([])
  const [purchaseScheduleError, setPurchaseScheduleError] = useState<string | null>(null)
  const [showPurchaseScheduleForm, setShowPurchaseScheduleForm] = useState(false)
  const [editingPurchaseSchedule, setEditingPurchaseSchedule] = useState<RecurringOperationTemplate | null>(null)
  const [purchaseScheduleProductId, setPurchaseScheduleProductId] = useState('')
  const [purchaseScheduleQuantity, setPurchaseScheduleQuantity] = useState('')
  const [purchaseScheduleUnitCost, setPurchaseScheduleUnitCost] = useState('')
  const [purchaseScheduleSupplier, setPurchaseScheduleSupplier] = useState('')
  const [purchaseScheduleDay, setPurchaseScheduleDay] = useState(String(Number(businessToday().slice(8, 10))))
  const [purchaseScheduleStartsOn, setPurchaseScheduleStartsOn] = useState(businessToday())
  const [purchaseScheduleSaving, setPurchaseScheduleSaving] = useState(false)
  const [purchaseScheduleBusyId, setPurchaseScheduleBusyId] = useState<string | null>(null)
  const [selectedPurchaseScheduleId, setSelectedPurchaseScheduleId] = useState<string | null>(null)
  const [pendingPurchaseScheduleCompletion, setPendingPurchaseScheduleCompletion] = useState<{ templateId: string; dueOn: string; receiptId: string } | null>(null)
  const [purchaseScheduleCompletionError, setPurchaseScheduleCompletionError] = useState<string | null>(null)
  const [movementTotal, setMovementTotal] = useState(0)
  const [movementOffset, setMovementOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [balanceSearch, setBalanceSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showReceiptForm, setShowReceiptForm] = useState(false)
  const [showMovementForm, setShowMovementForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [registeredReceiptId, setRegisteredReceiptId] = useState<string | null>(null)
  const [receiptSuggestionNotice, setReceiptSuggestionNotice] = useState<string | null>(null)
  const [repeatingReceipt, setRepeatingReceipt] = useState(false)
  const [showReplenishmentList, setShowReplenishmentList] = useState(false)
  const [receiptSupplier, setReceiptSupplier] = useState('')
  const [receiptReference, setReceiptReference] = useState('')
  const [receiptDate, setReceiptDate] = useState(businessToday())
  const [receiptRecordAsPaid, setReceiptRecordAsPaid] = useState(true)
  const [receiptLines, setReceiptLines] = useState<ReceiptLineDraft[]>([newLine()])
  const [movementProductId, setMovementProductId] = useState('')
  const [movementDirection, setMovementDirection] = useState<'increase' | 'decrease'>('increase')
  const [movementQuantity, setMovementQuantity] = useState('')
  const [historyPage, setHistoryPage] = useState(0)
  const receiptRequestIdRef = useRef(newRequestId())
  const movementRequestIdRef = useRef(newRequestId())
  const receiptTriggerRef = useRef<HTMLButtonElement>(null)
  const movementTriggerRef = useRef<HTMLButtonElement>(null)
  const receiptHeadingRef = useRef<HTMLHeadingElement>(null)
  const movementHeadingRef = useRef<HTMLHeadingElement>(null)
  const wasReceiptOpenRef = useRef(false)
  const wasMovementOpenRef = useRef(false)

  const loadData = useCallback(async (showLoading = true) => {
    if (!supabaseClient) {
      setError('A conexão da empresa não está disponível.')
      setLoading(false)
      return false
    }
    if (showLoading) setLoading(true)
    try {
      const [productsResult, balancesResult, movementsResult, receiptsResult, schedulesResult] = await Promise.all([
        supabaseClient.from('products').select('id, name, inventory_unit, inventory_tracked, is_combo, is_active, cost_cents')
          .eq('business_id', businessId).order('name', { ascending: true }),
        supabaseClient.from('inventory_balances').select('product_id, product_name, inventory_unit, minimum_stock, quantity_on_hand')
          .eq('business_id', businessId).order('product_name', { ascending: true }),
        supabaseClient.from('inventory_movements').select('id, product_id, movement_type, quantity_delta, reason, order_id, receipt_id, occurred_at, actor_id', { count: 'exact' })
          .eq('business_id', businessId).order('occurred_at', { ascending: false }).order('id', { ascending: false }).range(0, PAGE_SIZE - 1),
        supabaseClient.from('inventory_receipts').select('id, supplier_name, purchase_reference, received_on')
          .eq('business_id', businessId).order('received_on', { ascending: false }).range(0, PAGE_SIZE - 1),
        supabaseClient.from('recurring_operation_templates').select('*')
          .eq('business_id', businessId).eq('kind', 'inventory_purchase').order('is_active', { ascending: false }).order('next_due_on', { ascending: true }),
      ])
      if (productsResult.error || balancesResult.error || movementsResult.error || receiptsResult.error) {
        setError('Não foi possível carregar os saldos e o histórico. Tente novamente.')
        return false
      }
      setProducts((productsResult.data ?? []) as Product[])
      setBalances((balancesResult.data ?? []) as Balance[])
      setMovements((movementsResult.data ?? []) as Movement[])
      setMovementTotal(movementsResult.count ?? 0)
      setMovementOffset(movementsResult.data?.length ?? 0)
      setReceipts((receiptsResult.data ?? []) as Receipt[])
      if (schedulesResult.error) {
        setPurchaseSchedules([])
        setPurchaseScheduleError('Os lembretes de compra não puderam ser carregados. O estoque e os recebimentos continuam disponíveis.')
      } else {
        setPurchaseSchedules((schedulesResult.data ?? []) as RecurringOperationTemplate[])
        setPurchaseScheduleError(null)
      }
      setHistoryPage(0)
      setError(null)
      return true
    } catch {
      setError('Não foi possível carregar os saldos e o histórico. Tente novamente.')
      return false
    } finally {
      setLoading(false)
    }
  }, [businessId])

  const refreshPurchaseSchedules = useCallback(async () => {
    if (!supabaseClient) return false
    try {
      const { data, error: queryError } = await supabaseClient.from('recurring_operation_templates').select('*')
        .eq('business_id', businessId).eq('kind', 'inventory_purchase')
        .order('is_active', { ascending: false }).order('next_due_on', { ascending: true })
      if (queryError) throw queryError
      setPurchaseSchedules((data ?? []) as RecurringOperationTemplate[])
      setPurchaseScheduleError(null)
      return true
    } catch {
      setPurchaseScheduleError('Não foi possível atualizar os lembretes.')
      return false
    }
  }, [businessId])

  const refreshStockActivity = useCallback(async (includeReceiptDetails = false) => {
    if (!supabaseClient) return false
    try {
      const [balancesResult, movementsResult, productsResult, receiptsResult] = await Promise.all([
        supabaseClient.from('inventory_balances').select('product_id, product_name, inventory_unit, minimum_stock, quantity_on_hand')
          .eq('business_id', businessId).order('product_name', { ascending: true }),
        supabaseClient.from('inventory_movements').select('id, product_id, movement_type, quantity_delta, reason, order_id, receipt_id, occurred_at, actor_id', { count: 'exact' })
          .eq('business_id', businessId).order('occurred_at', { ascending: false }).order('id', { ascending: false }).range(0, PAGE_SIZE - 1),
        includeReceiptDetails
          ? supabaseClient.from('products').select('id, name, inventory_unit, inventory_tracked, is_combo, is_active, cost_cents')
            .eq('business_id', businessId).order('name', { ascending: true })
          : Promise.resolve(null),
        includeReceiptDetails
          ? supabaseClient.from('inventory_receipts').select('id, supplier_name, purchase_reference, received_on')
            .eq('business_id', businessId).order('received_on', { ascending: false }).range(0, PAGE_SIZE - 1)
          : Promise.resolve(null),
      ])
      if (balancesResult.error || movementsResult.error) throw balancesResult.error ?? movementsResult.error
      setBalances((balancesResult.data ?? []) as Balance[])
      setMovements((movementsResult.data ?? []) as Movement[])
      setMovementTotal(movementsResult.count ?? 0)
      setMovementOffset(movementsResult.data?.length ?? 0)
      setHistoryPage(0)

      if (includeReceiptDetails) {
        if (!productsResult || !receiptsResult || productsResult.error || receiptsResult.error) {
          throw productsResult?.error ?? receiptsResult?.error ?? new Error('Dados de recebimento indisponíveis.')
        }
        setProducts((productsResult.data ?? []) as Product[])
        setReceipts((receiptsResult.data ?? []) as Receipt[])
      }
      setError(null)
      return true
    } catch {
      setError('A alteração foi salva, mas a tela não atualizou. Tente atualizar os saldos.')
      return false
    }
  }, [businessId])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadData() }, [loadData])

  useEffect(() => {
    if (showReceiptForm) receiptHeadingRef.current?.focus()
    else if (wasReceiptOpenRef.current && !showMovementForm) receiptTriggerRef.current?.focus()
    wasReceiptOpenRef.current = showReceiptForm
  }, [showReceiptForm, showMovementForm])

  useEffect(() => {
    if (showMovementForm) movementHeadingRef.current?.focus()
    else if (wasMovementOpenRef.current && !showReceiptForm) movementTriggerRef.current?.focus()
    wasMovementOpenRef.current = showMovementForm
  }, [showMovementForm, showReceiptForm])

  const trackedProducts = products.filter((product) => product.inventory_tracked)
  const untrackedProducts = products.filter((product) => !product.inventory_tracked && !product.is_combo)
  const belowMinimum = balances.filter((balance) => Number(balance.quantity_on_hand) <= 0 || (balance.minimum_stock !== null && Number(balance.quantity_on_hand) < Number(balance.minimum_stock)))
  const recentSuppliers = [...receipts.reduce((suppliers, receipt) => {
    const supplier = receipt.supplier_name?.trim() ?? ''
    if (supplier) suppliers.set(supplier.toLocaleLowerCase('pt-BR'), supplier)
    return suppliers
  }, new Map<string, string>()).values()]
  const negativeBalances = balances.filter((balance) => Number(balance.quantity_on_hand) < 0)
  const receiptMap = new Map(receipts.map((receipt) => [receipt.id, receipt]))
  const productMap = new Map(products.map((product) => [product.id, product]))
  const filteredBalances = balances.filter((balance) => `${balance.product_name} ${balance.inventory_unit}`.toLocaleLowerCase('pt-BR').includes(balanceSearch.trim().toLocaleLowerCase('pt-BR')))
  const selectedMovementUnit = trackedProducts.find((product) => product.id === movementProductId)?.inventory_unit
  const receiptHasProductLines = receiptLines.some((line) => line.productId || line.quantity.trim())
  const receiptEstimatedTotalCents = receiptLines.reduce((total, line) => {
    const product = trackedProducts.find((item) => item.id === line.productId)
    const quantity = parseQuantity(line.quantity, product?.inventory_unit)
    const unitCost = parseUnitCostCents(line.unitCost)
    if (quantity === null || unitCost === null) return total
    const lineTotal = receiptLineTotalCents(quantity, unitCost)
    if (lineTotal === null || !Number.isSafeInteger(total + lineTotal)) return Number.MAX_SAFE_INTEGER + 1
    return total + lineTotal
  }, 0)
  const receiptFormDisabled = saving || uncertain || repeatingReceipt

  function startReceipt(productIds?: string[]) {
    setNotice(null)
    setRegisteredReceiptId(null)
    setFormError(null)
    setReceiptSuggestionNotice(null)
    setShowMovementForm(false)
    setShowReceiptForm(true)
    setShowReplenishmentList(false)
    setUncertain(false)
    setReceiptSupplier('')
    setReceiptReference('')
    setReceiptDate(businessToday())
    setReceiptRecordAsPaid(true)
    setSelectedPurchaseScheduleId(null)
    setPurchaseScheduleCompletionError(null)
    const uniqueProductIds = [...new Set(productIds ?? [])].filter((id) => trackedProducts.some((product) => product.id === id))
    setReceiptLines(uniqueProductIds.length > 0 ? uniqueProductIds.map((id) => newLine(id, unitCostInput(trackedProducts.find((product) => product.id === id)?.cost_cents))) : [newLine()])
    receiptRequestIdRef.current = newRequestId()
  }

  function startScheduledReceipt(template: RecurringOperationTemplate) {
    if (!template.product_id) return
    startReceipt([template.product_id])
    setSelectedPurchaseScheduleId(template.id)
    const quantity = template.quantity === null ? '' : String(template.quantity).replace('.', ',')
    const productCost = trackedProducts.find((product) => product.id === template.product_id)?.cost_cents
    setReceiptLines([{
      key: newRequestId(),
      productId: template.product_id,
      quantity,
      unitCost: unitCostInput(template.expected_unit_cost_cents === null ? productCost : Number(template.expected_unit_cost_cents)),
    }])
    setReceiptSupplier(template.counterparty_name ?? '')
    setReceiptRecordAsPaid(false)
    setReceiptSuggestionNotice(`Compra programada para ${formatBusinessDate(template.next_due_on)}. Confira os dados e confirme somente quando a mercadoria chegar.`)
    setShowReplenishmentList(false)
  }

  async function completePurchaseSchedule(templateId: string, dueOn: string, receiptId: string) {
    if (!supabaseClient) {
      setPurchaseScheduleCompletionError('O recebimento foi salvo, mas não foi possível atualizar o lembrete. A conexão voltou? Tente atualizar o lembrete; não registre a compra novamente.')
      setPendingPurchaseScheduleCompletion({ templateId, dueOn, receiptId })
      return false
    }
    try {
      const { error: completionError } = await supabaseClient.rpc('complete_recurring_operation_template', {
        p_business_id: businessId,
        p_template_id: templateId,
        p_due_on: dueOn,
        p_inventory_receipt_id: receiptId,
        p_financial_outflow_id: null,
      })
      if (completionError) throw completionError
    } catch {
      setPurchaseScheduleCompletionError('A compra foi recebida, mas o lembrete continua pendente porque não foi possível avançar a data. Tente atualizar o lembrete; não registre a compra novamente.')
      setPendingPurchaseScheduleCompletion({ templateId, dueOn, receiptId })
      return false
    }
    setPendingPurchaseScheduleCompletion(null)
    setPurchaseScheduleCompletionError(null)
    await refreshPurchaseSchedules()
    return true
  }

  async function retryPurchaseScheduleCompletion() {
    if (!pendingPurchaseScheduleCompletion || purchaseScheduleBusyId) return
    setPurchaseScheduleBusyId(pendingPurchaseScheduleCompletion.templateId)
    try {
      const completed = await completePurchaseSchedule(
        pendingPurchaseScheduleCompletion.templateId,
        pendingPurchaseScheduleCompletion.dueOn,
        pendingPurchaseScheduleCompletion.receiptId,
      )
      if (completed) setNotice('A data do lembrete foi atualizada. O recebimento já estava salvo; nenhum novo movimento foi criado.')
    } finally {
      setPurchaseScheduleBusyId(null)
    }
  }

  function openPurchaseScheduleForm(template?: RecurringOperationTemplate) {
    setEditingPurchaseSchedule(template ?? null)
    setPurchaseScheduleProductId(template?.product_id ?? trackedProducts[0]?.id ?? '')
    setPurchaseScheduleQuantity(template?.quantity === null || template?.quantity === undefined ? '' : String(template.quantity).replace('.', ','))
    setPurchaseScheduleUnitCost(template?.expected_unit_cost_cents === null || template?.expected_unit_cost_cents === undefined ? '' : unitCostInput(Number(template.expected_unit_cost_cents)))
    setPurchaseScheduleSupplier(template?.counterparty_name ?? '')
    setPurchaseScheduleDay(String(template?.day_of_month ?? Number(businessToday().slice(8, 10))))
    setPurchaseScheduleStartsOn(template?.starts_on ?? businessToday())
    setPurchaseScheduleError(null)
    setShowPurchaseScheduleForm(true)
  }

  async function savePurchaseSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || purchaseScheduleSaving) return
    const product = trackedProducts.find((item) => item.id === purchaseScheduleProductId)
    const quantity = product ? parseQuantity(purchaseScheduleQuantity, product.inventory_unit) : null
    const unitCostCents = purchaseScheduleUnitCost.trim() ? parseUnitCostCents(purchaseScheduleUnitCost) : null
    const day = Number(purchaseScheduleDay)
    if (!product || quantity === null || !Number.isInteger(day) || day < 1 || day > 31 || !isCalendarDate(purchaseScheduleStartsOn)) {
      setPurchaseScheduleError('Informe o produto, a quantidade, o dia do mês (1 a 31) e uma data inicial válida.')
      return
    }
    if (purchaseScheduleUnitCost.trim() && unitCostCents === null) {
      setPurchaseScheduleError('Confira o custo unitário previsto ou deixe o campo vazio.')
      return
    }
    setPurchaseScheduleSaving(true)
    setPurchaseScheduleError(null)
    const dueAnchor = purchaseScheduleStartsOn < businessToday() ? businessToday() : purchaseScheduleStartsOn
    const nextDueOn = editingPurchaseSchedule
      && day === editingPurchaseSchedule.day_of_month
      && purchaseScheduleStartsOn === editingPurchaseSchedule.starts_on
      ? editingPurchaseSchedule.next_due_on
      : firstMonthlyDueDate(dueAnchor, day)
    const templateValues = {
      name: `Compra · ${product.name}`.slice(0, 120),
      description: null,
      category: null,
      counterparty_name: purchaseScheduleSupplier.trim() || null,
      product_id: product.id,
      quantity,
      expected_unit_cost_cents: unitCostCents,
      amount_cents: null,
      day_of_month: day,
      starts_on: purchaseScheduleStartsOn,
      next_due_on: nextDueOn,
      is_active: editingPurchaseSchedule?.is_active ?? true,
    }
    const payload = { business_id: businessId, kind: 'inventory_purchase' as const, ...templateValues }
    try {
      const result = editingPurchaseSchedule
        ? await supabaseClient.from('recurring_operation_templates').update(templateValues).eq('business_id', businessId).eq('id', editingPurchaseSchedule.id)
        : await supabaseClient.from('recurring_operation_templates').insert(payload)
      if (result.error) {
        setPurchaseScheduleError('Não foi possível salvar o lembrete. Confira os dados e tente novamente.')
        return
      }
      setShowPurchaseScheduleForm(false)
      setEditingPurchaseSchedule(null)
      setNotice(editingPurchaseSchedule ? 'Lembrete de compra atualizado.' : 'Lembrete de compra mensal criado. Ele não altera o estoque sozinho.')
      await refreshPurchaseSchedules()
    } catch {
      setPurchaseScheduleError('Não foi possível salvar o lembrete. Confira sua conexão e tente novamente.')
    } finally {
      setPurchaseScheduleSaving(false)
    }
  }

  async function pausePurchaseSchedule(template: RecurringOperationTemplate) {
    if (!supabaseClient || purchaseScheduleBusyId) return
    setPurchaseScheduleBusyId(template.id)
    setPurchaseScheduleError(null)
    try {
      const { error: updateError } = await supabaseClient.from('recurring_operation_templates').update({ is_active: false }).eq('business_id', businessId).eq('id', template.id)
      if (updateError) throw updateError
      await refreshPurchaseSchedules()
    } catch {
      setPurchaseScheduleError('Não foi possível pausar este lembrete. Tente novamente.')
    } finally {
      setPurchaseScheduleBusyId(null)
    }
  }

  async function resumePurchaseSchedule(template: RecurringOperationTemplate) {
    if (!supabaseClient || purchaseScheduleBusyId) return
    setPurchaseScheduleBusyId(template.id)
    setPurchaseScheduleError(null)
    try {
      const { error: updateError } = await supabaseClient.from('recurring_operation_templates').update({ is_active: true }).eq('business_id', businessId).eq('id', template.id)
      if (updateError) throw updateError
      await refreshPurchaseSchedules()
    } catch {
      setPurchaseScheduleError('Não foi possível reativar este lembrete. Tente novamente.')
    } finally {
      setPurchaseScheduleBusyId(null)
    }
  }

  async function repeatLastReceiptProducts() {
    const sourceReceipt = receipts[0]
    if (!supabaseClient || !sourceReceipt || repeatingReceipt) return
    if (receiptHasProductLines) {
      setFormError('Para carregar os produtos anteriores, remova primeiro os produtos já adicionados. Seus dados atuais foram preservados.')
      return
    }
    setRepeatingReceipt(true)
    setFormError(null)
    setReceiptSuggestionNotice(null)
    try {
      const { data, error: queryError } = await supabaseClient.from('inventory_movements')
        .select('product_id')
        .eq('business_id', businessId).eq('receipt_id', sourceReceipt.id).eq('movement_type', 'receipt')
        .order('occurred_at', { ascending: true }).order('id', { ascending: true })
      if (queryError) {
        setFormError('Não foi possível carregar os produtos do recebimento anterior. Você pode seguir preenchendo a compra manualmente.')
        return
      }
      const productIds = [...new Set((data ?? []).map((item) => item.product_id))]
        .filter((id) => trackedProducts.some((product) => product.id === id))
      if (productIds.length === 0) {
        setFormError('O recebimento anterior não tem produtos ativos para reaproveitar.')
        return
      }
      setReceiptSupplier((current) => current.trim() ? current : sourceReceipt.supplier_name ?? '')
      setReceiptLines(productIds.map((id) => newLine(id, unitCostInput(trackedProducts.find((product) => product.id === id)?.cost_cents))))
      setReceiptSuggestionNotice('Produtos e custos atuais preenchidos. Confira o custo unitário e informe somente as quantidades que chegaram agora.')
    } catch {
      setFormError('Não foi possível carregar os produtos do recebimento anterior. Você pode seguir preenchendo a compra manualmente.')
    } finally {
      setRepeatingReceipt(false)
    }
  }

  function startMovement() {
    setNotice(null)
    setRegisteredReceiptId(null)
    setFormError(null)
    setShowReceiptForm(false)
    setShowMovementForm(true)
    setUncertain(false)
    setMovementProductId('')
    setMovementDirection('increase')
    setMovementQuantity('')
    movementRequestIdRef.current = newRequestId()
  }

  async function handleReceiptSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || saving || trackedProducts.length === 0) return
    const supplier = receiptSupplier.trim()
    const reference = receiptReference.trim()
    if (supplier.length > 160 || reference.length > 120) {
      setFormError('Confira o tamanho do fornecedor ou da referência.')
      return
    }
    if (!isCalendarDate(receiptDate) || receiptDate > businessToday()) {
      setFormError('Informe uma data de recebimento válida, hoje ou anterior.')
      return
    }
    const itemPayload = receiptLines.map((line) => ({
      product_id: line.productId,
      quantity: parseQuantity(line.quantity, trackedProducts.find((product) => product.id === line.productId)?.inventory_unit),
      unit_cost_cents: parseUnitCostCents(line.unitCost),
    }))
    if (itemPayload.length === 0 || itemPayload.some((item) => !item.product_id || item.quantity === null || item.unit_cost_cents === null)) {
      setFormError('Escolha o produto, informe a quantidade recebida e confira o custo por unidade. Produtos por unidade precisam de números inteiros.')
      return
    }
    if (receiptRecordAsPaid && !Number.isSafeInteger(receiptEstimatedTotalCents)) {
      setFormError('O total da compra é muito alto para registrar com segurança. Confira as quantidades e os custos por unidade.')
      return
    }
    if (new Set(itemPayload.map((item) => item.product_id)).size !== itemPayload.length) {
      setFormError('Cada produto deve aparecer uma única vez. Ajuste a quantidade na linha correspondente.')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const { data, error: rpcError, status } = await supabaseClient.rpc('record_inventory_receipt_with_payment', {
        p_business_id: businessId,
        p_supplier_name: supplier || null,
        p_purchase_reference: reference || null,
        p_received_on: receiptDate,
        p_notes: null,
        p_items: itemPayload,
        p_record_as_paid: receiptRecordAsPaid,
        p_request_id: receiptRequestIdRef.current,
      })
      if (rpcError) {
        if (status >= 400 && status < 500) {
          receiptRequestIdRef.current = newRequestId()
          setFormError(rpcError.message.includes('Existing positive stock requires a baseline unit cost')
            ? 'Este produto já tem saldo sem custo cadastrado. Informe o custo atual no Catálogo antes de receber uma nova compra.'
            : 'O recebimento não foi registrado. Confira produtos, quantidades e custo por unidade e tente novamente.')
        } else {
          setUncertain(true)
          setFormError('Não foi possível confirmar se o recebimento foi registrado. Tente novamente sem alterar os dados.')
        }
        return
      }
      if (typeof data !== 'string') {
        setUncertain(true)
        setFormError('A resposta do recebimento não chegou completa. Tente novamente sem alterar o formulário.')
        return
      }
      const linkedSchedule = selectedPurchaseScheduleId
        ? purchaseSchedules.find((template) => template.id === selectedPurchaseScheduleId)
        : null
      const scheduleAdvanced = linkedSchedule
        ? await completePurchaseSchedule(linkedSchedule.id, linkedSchedule.next_due_on, data)
        : null
      setShowReceiptForm(false)
      setUncertain(false)
      const receiptHasPaidOutflow = receiptRecordAsPaid && receiptEstimatedTotalCents > 0
      const receiptNotice = receiptHasPaidOutflow
        ? `Estoque atualizado e compra paga de ${formatBRL(receiptEstimatedTotalCents)} lançada automaticamente em Compras de estoque.`
        : receiptRecordAsPaid
          ? 'Estoque atualizado. Como o custo informado foi R$ 0,00, não houve saída financeira.'
          : 'Estoque atualizado; como a compra ainda não foi paga, ela não entrou nas saídas financeiras.'
      setNotice(linkedSchedule
        ? `${receiptNotice} ${scheduleAdvanced ? 'Próxima compra: lembrete atualizado.' : 'O recebimento está salvo; use “Atualizar lembrete” abaixo para avançar a data sem registrar a compra novamente.'}`
        : receiptNotice)
      setRegisteredReceiptId(!receiptRecordAsPaid && receiptEstimatedTotalCents > 0 ? data : null)
      setSelectedPurchaseScheduleId(null)
      receiptRequestIdRef.current = newRequestId()
      await refreshStockActivity(true)
    } catch {
      setUncertain(true)
      setFormError('Não foi possível confirmar se o recebimento foi registrado. Tente novamente sem alterar os dados.')
    } finally {
      setSaving(false)
    }
  }

  async function handleMovementSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || saving) return
    const quantity = parseQuantity(movementQuantity, selectedMovementUnit)
    if (!trackedProducts.some((product) => product.id === movementProductId) || quantity === null) {
      setFormError('Escolha um produto com estoque e informe a quantidade. Produtos por unidade precisam de números inteiros.')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const { data, error: rpcError, status } = await supabaseClient.rpc('record_inventory_movement', {
        p_business_id: businessId,
        p_product_id: movementProductId,
        p_movement_type: 'adjustment',
        p_quantity: quantity,
        p_direction: movementDirection,
        p_reason: 'Correção de quantidade',
        p_order_id: null,
        p_occurred_at: null,
        p_request_id: movementRequestIdRef.current,
      })
      if (rpcError) {
        if (status >= 400 && status < 500) {
          movementRequestIdRef.current = newRequestId()
          setFormError('A quantidade não foi atualizada. Confira o produto e tente novamente.')
        } else {
          setUncertain(true)
          setFormError('Não foi possível confirmar se a movimentação foi registrada. Tente novamente sem alterar os dados.')
        }
        return
      }
      if (typeof data !== 'string') {
        setUncertain(true)
        setFormError('A resposta da movimentação não chegou completa. Tente novamente sem alterar o formulário.')
        return
      }
      setShowMovementForm(false)
      setUncertain(false)
      setNotice('Quantidade do estoque atualizada.')
      movementRequestIdRef.current = newRequestId()
      await refreshStockActivity()
    } catch {
      setUncertain(true)
      setFormError('Não foi possível confirmar se a movimentação foi registrada. Tente novamente sem alterar os dados.')
    } finally {
      setSaving(false)
    }
  }

  async function loadMoreMovements() {
    if (!supabaseClient || loadingMore || movementOffset >= movementTotal) return
    setLoadingMore(true)
    try {
      const { data, error: queryError, count } = await supabaseClient.from('inventory_movements')
        .select('id, product_id, movement_type, quantity_delta, reason, order_id, receipt_id, occurred_at, actor_id', { count: 'exact' })
        .eq('business_id', businessId).order('occurred_at', { ascending: false }).order('id', { ascending: false })
        .range(movementOffset, movementOffset + PAGE_SIZE - 1)
      if (queryError) {
        setError('Não foi possível carregar mais movimentações.')
        return
      }
      setMovements((current) => [...current, ...((data ?? []) as Movement[])])
      setMovementOffset((current) => current + (data?.length ?? 0))
      setMovementTotal(count ?? movementTotal)
    } catch {
      setError('Não foi possível carregar mais movimentações.')
    } finally {
      setLoadingMore(false)
    }
  }

  const duePurchaseSchedules = purchaseSchedules.filter((template) => template.is_active && template.next_due_on <= businessToday())
  const pagedMovements = movements.slice(historyPage * PAGE_SIZE, (historyPage + 1) * PAGE_SIZE)
  const lastHistoryPage = Math.max(0, Math.ceil(movements.length / PAGE_SIZE) - 1)

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div><p className="eyebrow">OPERAÇÃO · ESTOQUE</p><h1>Estoque</h1><p className="page-description">Receba produtos, corrija o saldo ou crie um lembrete.</p></div>
        <div className="record-heading-actions"><button className="button button-secondary" disabled={repeatingReceipt || showReceiptForm || showMovementForm} onClick={() => openPurchaseScheduleForm()} type="button">Criar lembrete</button><button className="button button-secondary" disabled={repeatingReceipt || showPurchaseScheduleForm || showMovementForm || showReceiptForm} onClick={startMovement} ref={movementTriggerRef} type="button"><Icon name="plus" /> Corrigir quantidade</button><button className="button button-primary" disabled={repeatingReceipt || showPurchaseScheduleForm || showReceiptForm || showMovementForm} onClick={() => startReceipt()} ref={receiptTriggerRef} type="button"><Icon name="file" /> Receber compra</button></div>
      </header>

      {notice && <div className="form-message form-message-success" role="status"><p>{notice}</p>{registeredReceiptId && <><p className="section-footnote">Quando o pagamento for feito, registre a saída para atualizar o caixa. O custo do produto já ficou salvo para calcular o resultado na venda.</p><Link className="button button-primary" to={`/financeiro/saidas?receiptId=${encodeURIComponent(registeredReceiptId)}`}>Registrar pagamento quando pagar →</Link></>}</div>}
      {purchaseScheduleCompletionError && <div className="form-message form-message-warning" role="alert"><p>{purchaseScheduleCompletionError}</p><button className="text-button" disabled={Boolean(purchaseScheduleBusyId)} onClick={() => void retryPurchaseScheduleCompletion()} type="button">{purchaseScheduleBusyId ? 'Atualizando…' : 'Atualizar lembrete'}</button></div>}
      {purchaseScheduleError && <p className="form-message form-message-warning" role="status">{purchaseScheduleError}</p>}
      {error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => { setLoading(true); void loadData() }} type="button">Tentar novamente</button></div>}
      {showPurchaseScheduleForm && <form className="surface-panel record-form" onSubmit={(event) => void savePurchaseSchedule(event)}>
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">LEMBRETE OPCIONAL</p><h2>{editingPurchaseSchedule ? 'Editar lembrete mensal' : 'Lembrete de compra mensal'}</h2></div><button className="text-button" disabled={purchaseScheduleSaving} onClick={() => { setShowPurchaseScheduleForm(false); setEditingPurchaseSchedule(null) }} type="button">Fechar</button></div>
        <p className="section-footnote">O lembrete não altera o estoque. Registre o recebimento quando a mercadoria chegar.</p>
        <div className="record-form-grid">
          <label className="record-field"><span className="field-label">Produto</span><select className="text-input" disabled={purchaseScheduleSaving || Boolean(editingPurchaseSchedule)} onChange={(event) => setPurchaseScheduleProductId(event.target.value)} required value={purchaseScheduleProductId}><option value="">Selecione um produto</option>{trackedProducts.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.inventory_unit}</option>)}</select></label>
          <label className="record-field"><span className="field-label">Quantidade prevista</span><input className="text-input" disabled={purchaseScheduleSaving} inputMode={isDiscreteInventoryUnit(trackedProducts.find((product) => product.id === purchaseScheduleProductId)?.inventory_unit) ? 'numeric' : 'decimal'} onChange={(event) => setPurchaseScheduleQuantity(event.target.value)} placeholder="Ex.: 10" required value={purchaseScheduleQuantity} /></label>
          <label className="record-field"><span className="field-label">Custo por unidade previsto · R$ <span className="field-optional">opcional</span></span><input className="text-input" disabled={purchaseScheduleSaving} inputMode="decimal" onChange={(event) => setPurchaseScheduleUnitCost(event.target.value)} placeholder="Ex.: 5,00" value={purchaseScheduleUnitCost} /></label>
          <label className="record-field"><span className="field-label">Fornecedor <span className="field-optional">opcional</span></span><input className="text-input" disabled={purchaseScheduleSaving} maxLength={160} onChange={(event) => setPurchaseScheduleSupplier(event.target.value)} value={purchaseScheduleSupplier} /></label>
          <label className="record-field"><span className="field-label">Dia do mês</span><input className="text-input" disabled={purchaseScheduleSaving} inputMode="numeric" max="31" min="1" onChange={(event) => setPurchaseScheduleDay(event.target.value)} required type="number" value={purchaseScheduleDay} /><small className="field-optional">{purchaseScheduleDay ? formatRecurringDay(Number(purchaseScheduleDay)) : 'Escolha de 1 a 31'}; em meses curtos, usa o último dia.</small></label>
          <label className="record-field"><span className="field-label">Começar em</span><input className="text-input" disabled={purchaseScheduleSaving} onChange={(event) => setPurchaseScheduleStartsOn(event.target.value)} required type="date" value={purchaseScheduleStartsOn} /></label>
        </div>
        {purchaseScheduleError && <p className="form-message form-message-error" role="alert">{purchaseScheduleError}</p>}
        <div className="record-form-actions"><button className="button button-primary" disabled={purchaseScheduleSaving} type="submit">{purchaseScheduleSaving ? 'Salvando…' : editingPurchaseSchedule ? 'Salvar alterações' : 'Salvar lembrete'}</button><button className="text-button" disabled={purchaseScheduleSaving} onClick={() => { setShowPurchaseScheduleForm(false); setEditingPurchaseSchedule(null) }} type="button">Cancelar</button></div>
      </form>}

      {purchaseSchedules.length > 0 && <details className="surface-panel dashboard-trend-details" open={duePurchaseSchedules.length > 0}>
        <summary>Compras programadas <span>{duePurchaseSchedules.length ? duePurchaseSchedules.length + ' para confirmar' : purchaseSchedules.filter((template) => template.is_active).length + ' ativas'}{purchaseSchedules.some((template) => !template.is_active) ? ` · ${purchaseSchedules.filter((template) => !template.is_active).length} pausadas` : ''}</span></summary>
        <div className="inventory-history-content"><p className="section-footnote">O lembrete fica pendente até você registrar o recebimento real.</p>
          <ul className="inventory-balance-list">{purchaseSchedules.map((template) => {
            const product = products.find((item) => item.id === template.product_id)
            const unit = product?.inventory_unit ?? 'un.'
            const due = template.is_active && template.next_due_on <= businessToday()
            const expectedCost = template.expected_unit_cost_cents === null ? '' : ' · custo previsto ' + formatBRL(Number(template.expected_unit_cost_cents)) + '/un.'
            return <li key={template.id}><span className="inventory-balance-copy"><strong>{template.name}{!template.is_active && ' · Pausada'}</strong><small>{formatRecurringDay(template.day_of_month)} · próxima: {formatBusinessDate(template.next_due_on)} · {formatQuantity(Number(template.quantity ?? 0))} {unit}{expectedCost}{template.counterparty_name ? ' · ' + template.counterparty_name : ''}</small></span><span className="record-form-actions">{template.is_active ? <><button className="button button-secondary" disabled={Boolean(purchaseScheduleBusyId)} onClick={() => startScheduledReceipt(template)} type="button">{due ? 'Registrar recebimento' : 'Receber compra'}</button><button className="text-button" disabled={Boolean(purchaseScheduleBusyId)} onClick={() => openPurchaseScheduleForm(template)} type="button">Editar</button><button className="text-button" disabled={Boolean(purchaseScheduleBusyId)} onClick={() => void pausePurchaseSchedule(template)} type="button">{purchaseScheduleBusyId === template.id ? 'Pausando…' : 'Pausar'}</button></> : <button className="text-button" disabled={Boolean(purchaseScheduleBusyId)} onClick={() => void resumePurchaseSchedule(template)} type="button">{purchaseScheduleBusyId === template.id ? 'Reativando…' : 'Reativar'}</button>}</span></li>
          })}</ul>
        </div>
      </details>}

      <section className="order-balance-grid inventory-summary" aria-label="Resumo do estoque">
        <article className="surface-panel order-balance-card"><span>Produtos com saldo no sistema</span><strong>{loading ? '—' : trackedProducts.length}</strong><small>Atualizado em despachos, retiradas e recebimentos.</small></article>
        <article className="surface-panel order-balance-card"><span>Estoque em atenção</span><strong>{loading ? '—' : belowMinimum.length}</strong><small>Saldo zero ou abaixo do mínimo informado.</small>{!loading && belowMinimum.length > 0 && <button className="text-button" onClick={() => setShowReplenishmentList((value) => !value)} type="button">{showReplenishmentList ? 'Fechar lista' : 'Ver produtos'}</button>}</article>
        <article className="surface-panel order-balance-card"><span>Estoque negativo</span><strong>{loading ? '—' : negativeBalances.length}</strong><small>Saíram mais unidades do que havia no saldo.</small></article>
      </section>

      {showReplenishmentList && belowMinimum.length > 0 && <section className="surface-panel record-panel" aria-labelledby="inventory-replenishment-heading">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">SUGESTÃO DE COMPRA</p><h2 id="inventory-replenishment-heading">Lista de reposição</h2></div><span className="neutral-status">{belowMinimum.length}</span></div>
        <p className="section-footnote">Saldo zero ou abaixo do mínimo informado. A entrada só atualiza o estoque após confirmar o recebimento.</p>
        <ul className="inventory-balance-list">{belowMinimum.map((balance) => {
          const deficit = balance.minimum_stock === null ? null : Math.max(0, Math.round((Number(balance.minimum_stock) - Number(balance.quantity_on_hand)) * 1000) / 1000)
          return <li key={balance.product_id}><span className="inventory-balance-copy"><strong>{balance.product_name}</strong><small>Saldo {formatQuantity(Number(balance.quantity_on_hand))}{balance.minimum_stock === null ? '' : ` · mínimo ${formatQuantity(Number(balance.minimum_stock))}`}</small></span><span className="inventory-balance-value"><strong>{deficit === null ? '—' : formatQuantity(deficit)} <small>{balance.inventory_unit}</small></strong><span className="stock-state stock-state-low">{deficit === null ? 'Defina quanto repor' : 'Sugestão para repor'}</span></span></li>
        })}</ul>
        <div className="record-form-actions"><button className="button button-secondary" disabled={loading || saving} onClick={() => startReceipt(belowMinimum.map((balance) => balance.product_id))} type="button">Usar produtos na entrada de estoque</button></div>
      </section>}

      {showReceiptForm && <form className="surface-panel record-form" onSubmit={(event) => void handleReceiptSubmit(event)}>
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">ENTRADA DE PRODUTOS</p><h2 ref={receiptHeadingRef} tabIndex={-1}>{selectedPurchaseScheduleId ? 'Confirmar recebimento' : 'Receber compra'}</h2></div><button className="text-button" disabled={receiptFormDisabled} onClick={() => { setShowReceiptForm(false); setSelectedPurchaseScheduleId(null) }} type="button">Fechar</button></div>
        <p className="section-footnote inventory-form-hint">Informe quantidade e custo. Marque se a compra já foi paga para lançar a saída.</p>
        {trackedProducts.length === 0 ? <p className="inline-state">Edite um produto no <Link to="/catalogo">Catálogo</Link> e informe sua unidade e quantidade física para registrar compras recebidas.</p> : <>
          {receipts[0] && <button className="text-button" disabled={saving || uncertain || repeatingReceipt || receiptHasProductLines} onClick={() => void repeatLastReceiptProducts()} type="button">{repeatingReceipt ? 'Carregando produtos…' : 'Repetir produtos da última compra'}</button>}
          {receiptSuggestionNotice && <p className="form-message form-message-success" role="status">{receiptSuggestionNotice}</p>}
          <div className="inventory-line-list">
            {receiptLines.map((line, index) => {
              const selected = trackedProducts.find((product) => product.id === line.productId)
              return <div className="inventory-line-row" key={line.key}>
                <label className="record-field"><span className="field-label">Produto {index + 1}</span><select className="text-input" disabled={receiptFormDisabled || Boolean(selectedPurchaseScheduleId)} onChange={(event) => setReceiptLines((current) => current.map((row) => {
                  if (row.key !== line.key) return row
                  const product = trackedProducts.find((item) => item.id === event.target.value)
                  return { ...row, productId: event.target.value, unitCost: unitCostInput(product?.cost_cents) }
                }))} required value={line.productId}><option value="">Selecione um produto</option>{trackedProducts.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.inventory_unit}</option>)}</select></label>
                <label className="record-field"><span className="field-label">Quantidade recebida{selected?.inventory_unit ? ' · ' + selected.inventory_unit : ''}</span><input className="text-input" disabled={receiptFormDisabled} inputMode={isDiscreteInventoryUnit(selected?.inventory_unit) ? 'numeric' : 'decimal'} maxLength={16} onChange={(event) => setReceiptLines((current) => current.map((row) => row.key === line.key ? { ...row, quantity: event.target.value } : row))} placeholder="1" required value={line.quantity} /></label>
                <label className="record-field"><span className="field-label">Custo por unidade · R$</span><input className="text-input" disabled={receiptFormDisabled} inputMode="decimal" maxLength={16} onChange={(event) => setReceiptLines((current) => current.map((row) => row.key === line.key ? { ...row, unitCost: event.target.value } : row))} placeholder="0,00" required value={line.unitCost} /><small className="field-optional">{selected?.cost_cents !== null && selected?.cost_cents !== undefined ? 'Pré-preenchido com o custo atual.' : 'Informe o custo da compra.'}</small></label>
                <button aria-label={'Remover produto ' + (index + 1)} className="text-button order-remove-button" disabled={receiptFormDisabled || receiptLines.length === 1} onClick={() => setReceiptLines((current) => current.filter((row) => row.key !== line.key))} type="button">Remover</button>
              </div>
            })}
          </div>
          <button className="button button-secondary inventory-add-line" disabled={receiptFormDisabled || Boolean(selectedPurchaseScheduleId)} onClick={() => setReceiptLines((current) => [...current, newLine()])} type="button"><Icon name="plus" /> Adicionar produto</button>
          <div className="record-form-grid inventory-receipt-date-row">
            <label className="record-field"><span className="field-label">Recebido em</span><input className="text-input" disabled={receiptFormDisabled} max={businessToday()} onChange={(event) => setReceiptDate(event.target.value)} required type="date" value={receiptDate} /><small className="field-optional">Padrão: hoje. Mude somente se recebeu em outro dia.</small></label>
          </div>
          <div className="record-field-wide inventory-purchase-total">
            <label className="record-checkbox"><input checked={receiptRecordAsPaid} disabled={receiptFormDisabled} onChange={(event) => setReceiptRecordAsPaid(event.target.checked)} type="checkbox" /><span><strong>A compra já foi paga</strong><small>Marcado: lança {Number.isSafeInteger(receiptEstimatedTotalCents) ? formatBRL(receiptEstimatedTotalCents) : 'o total calculado'} em Compras de estoque, na data de hoje. Desmarque se ainda não pagou.</small></span></label>
            <p className="section-footnote">A saída financeira é registrada na data de hoje. O custo do produto entra no resultado conforme ele for vendido.</p>
          </div>
          <details className="record-field-wide inventory-receipt-details">
            <summary>Detalhes opcionais da compra</summary>
            <div className="record-form-grid">
              <label className="record-field"><span className="field-label">Fornecedor</span><input autoComplete="off" className="text-input" disabled={receiptFormDisabled} list="inventory-recent-suppliers" maxLength={160} onChange={(event) => setReceiptSupplier(event.target.value)} placeholder="Opcional" value={receiptSupplier} /><datalist id="inventory-recent-suppliers">{recentSuppliers.map((supplier) => <option key={supplier} value={supplier} />)}</datalist></label>
              <label className="record-field"><span className="field-label">Nº da nota ou referência</span><input className="text-input" disabled={receiptFormDisabled} maxLength={120} onChange={(event) => setReceiptReference(event.target.value)} placeholder="Opcional" value={receiptReference} /></label>
            </div>
          </details>
          {formError && <p className="form-message form-message-error" role="alert">{formError}</p>}
          <div className="record-form-actions"><button className="button button-primary" disabled={saving || repeatingReceipt} type="submit">{saving ? 'Registrando…' : uncertain ? 'Tentar novamente sem alterar os dados' : repeatingReceipt ? 'Carregando produtos…' : 'Confirmar recebimento físico'}</button></div>
        </>}
      </form>}

      {showMovementForm && <form className="surface-panel record-form" onSubmit={(event) => void handleMovementSubmit(event)}>
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">AJUSTE DE SALDO</p><h2 ref={movementHeadingRef} tabIndex={-1}>Corrigir quantidade</h2></div><button className="text-button" disabled={saving || uncertain} onClick={() => setShowMovementForm(false)} type="button">Fechar</button></div>
        <p className="section-footnote inventory-form-hint">Atualiza a quantidade atual do produto.</p>
        <div className="record-form-grid">
          <label className="record-field"><span className="field-label">Produto <span aria-hidden="true">*</span></span><select className="text-input" disabled={saving || uncertain} onChange={(event) => setMovementProductId(event.target.value)} required value={movementProductId}><option value="">Selecione um produto</option>{trackedProducts.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.inventory_unit}</option>)}</select></label>
          <label className="record-field"><span className="field-label">Quantidade{movementProductId && selectedMovementUnit ? ' · ' + selectedMovementUnit : ''} <span aria-hidden="true">*</span></span><input className="text-input" disabled={saving || uncertain} inputMode={isDiscreteInventoryUnit(selectedMovementUnit) ? 'numeric' : 'decimal'} maxLength={16} onChange={(event) => setMovementQuantity(event.target.value)} placeholder="0" required value={movementQuantity} /></label>
          <label className="record-field"><span className="field-label">Direção <span aria-hidden="true">*</span></span><select className="text-input" disabled={saving || uncertain} onChange={(event) => setMovementDirection(event.target.value as 'increase' | 'decrease')} value={movementDirection}><option value="increase">Adicionar ao saldo</option><option value="decrease">Retirar do saldo</option></select></label>
        </div>
        {formError && <p className="form-message form-message-error" role="alert">{formError}</p>}
        <div className="record-form-actions"><button className="button button-primary" disabled={saving} type="submit">{saving ? 'Salvando…' : uncertain ? 'Tentar novamente sem alterar os dados' : 'Salvar quantidade'}</button></div>
      </form>}

      <section className="surface-panel record-panel" aria-labelledby="inventory-balance-heading">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">QUANTIDADE ATUAL</p><h2 id="inventory-balance-heading">Produtos com saldo</h2></div><span className="neutral-status">{loading ? '—' : balances.length}</span></div>
        {!loading && balances.length > 0 && <label className="search-field"><Icon name="search" /><span className="visually-hidden">Buscar produtos no estoque</span><input onChange={(event) => setBalanceSearch(event.target.value)} placeholder="Buscar produto" value={balanceSearch} /></label>}
        {loading ? <p className="inline-state" aria-live="polite">Carregando saldos…</p> : balances.length === 0 ? <div className="inline-state"><p>Não há saldos configurados. Configure a unidade e a contagem inicial no catálogo.</p><Link className="quiet-link" to="/catalogo">Abrir catálogo →</Link></div> : <ul className="inventory-balance-list">
          {filteredBalances.length === 0 ? <li className="inline-state">Nenhum produto corresponde à busca.</li> : filteredBalances.map((balance) => {
            const quantity = Number(balance.quantity_on_hand)
            const isNegative = quantity < 0
            const isZero = quantity === 0
            const isBelow = quantity <= 0 || (balance.minimum_stock !== null && quantity < Number(balance.minimum_stock))
            return <li key={balance.product_id}>
              <span className="inventory-balance-copy"><strong>{balance.product_name}</strong><small>Unidade: {balance.inventory_unit}{balance.minimum_stock !== null ? ' · Mínimo ' + formatQuantity(Number(balance.minimum_stock)) : ' · Sem limite mínimo'}</small></span>
              <span className="inventory-balance-value"><strong>{formatQuantity(quantity)} <small>{balance.inventory_unit}</small></strong><span className={'stock-state' + (isNegative ? ' stock-state-negative' : isZero ? ' stock-state-zero' : isBelow ? ' stock-state-low' : '')}>{isNegative ? 'Estoque negativo' : isZero ? 'Sem estoque' : isBelow ? 'Abaixo do mínimo' : 'Disponível'}</span></span>
            </li>
          })}
        </ul>}
        {!loading && untrackedProducts.length > 0 && <div className="inventory-untracked"><p className="eyebrow">PRODUTOS AGUARDANDO CONTAGEM</p><p>{untrackedProducts.map((product) => product.name).join(' · ')}</p><Link className="quiet-link" to="/catalogo">Definir unidade e quantidade →</Link></div>}
      </section>

      <details className="surface-panel dashboard-trend-details inventory-history-details" aria-label="Histórico de movimentações">
        <summary>Ver histórico de movimentações <span>{movementTotal} registros</span></summary>
        <div className="inventory-history-content">
        {loading ? <p className="inline-state" aria-live="polite">Carregando movimentações…</p> : movements.length === 0 ? <p className="inline-state">Nenhuma movimentação registrada.</p> : <ul className="timeline-list inventory-movement-list">
          {pagedMovements.map((movement) => {
            const product = productMap.get(movement.product_id)
            const quantity = Number(movement.quantity_delta)
            const receipt = movement.receipt_id ? receiptMap.get(movement.receipt_id) : undefined
            return <li key={movement.id}><span className="timeline-dot" /><div className="inventory-movement-detail">
              <strong>{movementLabel(movement.movement_type)} · {quantity > 0 ? '+' : ''}{formatQuantity(quantity)} {product?.inventory_unit ?? ''}</strong>
              <p>{product?.name ?? 'Produto arquivado'} · {formatTimestamp(movement.occurred_at)} · Proprietário</p>
              <p>{movement.reason}{movement.order_id ? ' · Pedido ' + movement.order_id.slice(0, 8) : ''}{receipt?.supplier_name ? ' · Fornecedor: ' + receipt.supplier_name : ''}{receipt?.purchase_reference ? ' · Ref. ' + receipt.purchase_reference : ''}</p>
              {movement.order_id && <Link to={'/pedidos/' + movement.order_id}>Abrir pedido →</Link>}
            </div></li>
          })}
        </ul>}
        {!loading && movements.length > 0 && <div className="record-form-actions inventory-history-actions">
          {historyPage > 0 && <button className="button button-secondary" onClick={() => setHistoryPage((page) => Math.max(0, page - 1))} type="button">Movimentações mais recentes</button>}
          {historyPage < lastHistoryPage && <button className="button button-secondary" onClick={() => setHistoryPage((page) => Math.min(lastHistoryPage, page + 1))} type="button">Movimentações anteriores</button>}
          {movementOffset < movementTotal && historyPage === lastHistoryPage && <button className="button button-secondary" disabled={loadingMore} onClick={() => void loadMoreMovements()} type="button">{loadingMore ? 'Carregando…' : 'Carregar histórico anterior'}</button>}
        </div>}
        </div>
      </details>
    </div>
  )
}
