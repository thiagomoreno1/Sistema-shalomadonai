import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { businessLocalDateTimeToIso, businessToday } from '../lib/formatters'
import { isDiscreteInventoryUnit } from '../lib/inventoryUnits'
import { supabaseClient } from '../lib/supabase'

const PAGE_SIZE = 40

type Product = { id: string; name: string; inventory_unit: string | null; inventory_tracked: boolean; is_combo: boolean; is_active: boolean; cost_cents: number | null }
type Balance = { product_id: string; product_name: string; inventory_unit: string; minimum_stock: number | null; quantity_on_hand: number }
type Movement = { id: string; product_id: string; movement_type: 'opening' | 'receipt' | 'adjustment' | 'loss' | 'dispatch' | 'return'; quantity_delta: number; reason: string; order_id: string | null; receipt_id: string | null; occurred_at: string; actor_id: string }
type Receipt = { id: string; supplier_name: string | null; purchase_reference: string | null; received_on: string }
type ReturnCandidate = { id: string; customer_name_snapshot: string; fulfillment_type: 'delivery' | 'pickup' }
type ReturnableItem = { product_id: string; product_name: string; inventory_unit: string; remaining_quantity: number }
type ReceiptLineDraft = { key: string; productId: string; quantity: string; unitCost: string }
type InventoryCountDraft = { productId: string; productName: string; inventoryUnit: string; expectedQuantity: number; quantity: string }
type MovementKind = 'adjustment' | 'loss' | 'return'

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

function parseCountQuantity(value: string, unit?: string | null) {
  const cleaned = value.trim().replace(',', '.')
  if (!/^\d+(?:\.\d{1,3})?$/.test(cleaned)) return null
  const quantity = Number(cleaned)
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > 99999999.999) return null
  return isDiscreteInventoryUnit(unit) && !Number.isSafeInteger(quantity) ? null : quantity
}

function parseUnitCostCents(value: string) {
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value.trim())
  if (!match) return null
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null
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
  const [returnCandidates, setReturnCandidates] = useState<ReturnCandidate[]>([])
  const [returnableItems, setReturnableItems] = useState<ReturnableItem[]>([])
  const [returnItemsLoading, setReturnItemsLoading] = useState(false)
  const [movementTotal, setMovementTotal] = useState(0)
  const [movementOffset, setMovementOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [balanceSearch, setBalanceSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showReceiptForm, setShowReceiptForm] = useState(false)
  const [showMovementForm, setShowMovementForm] = useState(false)
  const [showCountForm, setShowCountForm] = useState(false)
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
  const [receiptNotes, setReceiptNotes] = useState('')
  const [receiptLines, setReceiptLines] = useState<ReceiptLineDraft[]>([newLine()])
  const [movementProductId, setMovementProductId] = useState('')
  const [movementKind, setMovementKind] = useState<MovementKind>('adjustment')
  const [movementDirection, setMovementDirection] = useState<'increase' | 'decrease'>('increase')
  const [movementQuantity, setMovementQuantity] = useState('')
  const [movementReason, setMovementReason] = useState('')
  const [movementOrderId, setMovementOrderId] = useState('')
  const [movementDate, setMovementDate] = useState('')
  const [countDrafts, setCountDrafts] = useState<InventoryCountDraft[]>([])
  const [countSnapshotId, setCountSnapshotId] = useState<string | null>(null)
  const [countStarting, setCountStarting] = useState(false)
  const [countStartError, setCountStartError] = useState<string | null>(null)
  const [countStartErrorKind, setCountStartErrorKind] = useState<'network' | 'empty' | 'over-limit' | 'begin' | null>(null)
  const [historyPage, setHistoryPage] = useState(0)
  const receiptRequestIdRef = useRef(newRequestId())
  const movementRequestIdRef = useRef(newRequestId())
  const countBeginRequestIdRef = useRef(newRequestId())
  const returnItemsRequestRef = useRef(0)
  const receiptTriggerRef = useRef<HTMLButtonElement>(null)
  const movementTriggerRef = useRef<HTMLButtonElement>(null)
  const receiptHeadingRef = useRef<HTMLHeadingElement>(null)
  const movementHeadingRef = useRef<HTMLHeadingElement>(null)
  const countTriggerRef = useRef<HTMLButtonElement>(null)
  const countHeadingRef = useRef<HTMLHeadingElement>(null)
  const wasReceiptOpenRef = useRef(false)
  const wasMovementOpenRef = useRef(false)
  const wasCountOpenRef = useRef(false)

  const loadData = useCallback(async (showLoading = true) => {
    if (!supabaseClient) {
      setError('A conexão da empresa não está disponível.')
      setLoading(false)
      return false
    }
    if (showLoading) setLoading(true)
    try {
      const [productsResult, balancesResult, movementsResult, receiptsResult, deliveriesResult, pickupEventsResult] = await Promise.all([
        supabaseClient.from('products').select('id, name, inventory_unit, inventory_tracked, is_combo, is_active, cost_cents')
          .eq('business_id', businessId).order('name', { ascending: true }),
        supabaseClient.from('inventory_balances').select('product_id, product_name, inventory_unit, minimum_stock, quantity_on_hand')
          .eq('business_id', businessId).order('product_name', { ascending: true }),
        supabaseClient.from('inventory_movements').select('id, product_id, movement_type, quantity_delta, reason, order_id, receipt_id, occurred_at, actor_id', { count: 'exact' })
          .eq('business_id', businessId).order('occurred_at', { ascending: false }).order('id', { ascending: false }).range(0, PAGE_SIZE - 1),
        supabaseClient.from('inventory_receipts').select('id, supplier_name, purchase_reference, received_on')
          .eq('business_id', businessId).order('received_on', { ascending: false }).range(0, PAGE_SIZE - 1),
        supabaseClient.from('deliveries').select('order_id, status, canceled_at')
          .eq('business_id', businessId).is('canceled_at', null).in('status', ['attempted', 'rescheduled', 'delivered', 'returned']),
        supabaseClient.from('order_events').select('order_id')
          .eq('business_id', businessId).eq('event_type', 'picked_up'),
      ])
      if (productsResult.error || balancesResult.error || movementsResult.error || receiptsResult.error || deliveriesResult.error || pickupEventsResult.error) {
        setError('Não foi possível carregar os saldos e o histórico. Tente novamente.')
        return false
      }
      const deliveryOrderIds = new Set((deliveriesResult.data ?? []).map((delivery) => delivery.order_id))
      const pickupOrderIds = new Set((pickupEventsResult.data ?? []).map((event) => event.order_id))
      const orderIds = [...new Set([...deliveryOrderIds, ...pickupOrderIds])]
      const ordersResult = orderIds.length > 0
        ? await supabaseClient.from('orders').select('id, customer_name_snapshot')
          .eq('business_id', businessId).eq('status', 'open').in('id', orderIds)
        : { data: [], error: null }
      if (ordersResult.error) {
        setError('Não foi possível carregar pedidos elegíveis para retorno conferido.')
        return false
      }
      setProducts((productsResult.data ?? []) as Product[])
      setBalances((balancesResult.data ?? []) as Balance[])
      setMovements((movementsResult.data ?? []) as Movement[])
      setMovementTotal(movementsResult.count ?? 0)
      setMovementOffset(movementsResult.data?.length ?? 0)
      setReceipts((receiptsResult.data ?? []) as Receipt[])
      setReturnCandidates((ordersResult.data ?? []).map((order) => ({
        ...order,
        fulfillment_type: deliveryOrderIds.has(order.id) ? 'delivery' as const : 'pickup' as const,
      })) as ReturnCandidate[])
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

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadData() }, [loadData])

  useEffect(() => {
    if (showReceiptForm) receiptHeadingRef.current?.focus()
    else if (wasReceiptOpenRef.current && !showMovementForm && !showCountForm) receiptTriggerRef.current?.focus()
    wasReceiptOpenRef.current = showReceiptForm
  }, [showReceiptForm, showMovementForm, showCountForm])

  useEffect(() => {
    if (showMovementForm) movementHeadingRef.current?.focus()
    else if (wasMovementOpenRef.current && !showReceiptForm && !showCountForm) movementTriggerRef.current?.focus()
    wasMovementOpenRef.current = showMovementForm
  }, [showMovementForm, showReceiptForm, showCountForm])

  useEffect(() => {
    if (showCountForm) countHeadingRef.current?.focus()
    else if (wasCountOpenRef.current && !showReceiptForm && !showMovementForm) countTriggerRef.current?.focus()
    wasCountOpenRef.current = showCountForm
  }, [showCountForm, showReceiptForm, showMovementForm])

  const trackedProducts = products.filter((product) => product.inventory_tracked)
  const untrackedProducts = products.filter((product) => product.is_active && !product.inventory_tracked && !product.is_combo)
  const belowMinimum = balances.filter((balance) => balance.minimum_stock !== null && Number(balance.quantity_on_hand) < Number(balance.minimum_stock))
  const recentSuppliers = [...receipts.reduce((suppliers, receipt) => {
    const supplier = receipt.supplier_name?.trim() ?? ''
    if (supplier) suppliers.set(supplier.toLocaleLowerCase('pt-BR'), supplier)
    return suppliers
  }, new Map<string, string>()).values()]
  const negativeBalances = balances.filter((balance) => Number(balance.quantity_on_hand) < 0)
  const receiptMap = new Map(receipts.map((receipt) => [receipt.id, receipt]))
  const productMap = new Map(products.map((product) => [product.id, product]))
  const filteredBalances = balances.filter((balance) => `${balance.product_name} ${balance.inventory_unit}`.toLocaleLowerCase('pt-BR').includes(balanceSearch.trim().toLocaleLowerCase('pt-BR')))
  const selectedReturnableItem = returnableItems.find((item) => item.product_id === movementProductId) ?? null
  const selectedMovementUnit = movementKind === 'return'
    ? selectedReturnableItem?.inventory_unit
    : trackedProducts.find((product) => product.id === movementProductId)?.inventory_unit
  const receiptHasProductLines = receiptLines.some((line) => line.productId || line.quantity.trim())
  const receiptFormDisabled = saving || uncertain || repeatingReceipt

  function startReceipt(productIds?: string[]) {
    setNotice(null)
    setRegisteredReceiptId(null)
    setFormError(null)
    setReceiptSuggestionNotice(null)
    setShowMovementForm(false)
    setShowReceiptForm(true)
    setShowCountForm(false)
    setShowReplenishmentList(false)
    setUncertain(false)
    setReceiptSupplier('')
    setReceiptReference('')
    setReceiptDate(businessToday())
    setReceiptNotes('')
    const uniqueProductIds = [...new Set(productIds ?? [])].filter((id) => trackedProducts.some((product) => product.id === id))
    setReceiptLines(uniqueProductIds.length > 0 ? uniqueProductIds.map((id) => newLine(id, unitCostInput(trackedProducts.find((product) => product.id === id)?.cost_cents))) : [newLine()])
    receiptRequestIdRef.current = newRequestId()
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
    setShowCountForm(false)
    setShowMovementForm(true)
    setUncertain(false)
    setMovementProductId('')
    setMovementKind('adjustment')
    setMovementDirection('increase')
    setMovementQuantity('')
    setMovementReason('')
    setMovementOrderId('')
    setMovementDate('')
    setReturnableItems([])
    setReturnItemsLoading(false)
    movementRequestIdRef.current = newRequestId()
  }

  async function loadCountSnapshot(inventoryCountId: string, manageLoading = true) {
    if (!supabaseClient) return false
    if (manageLoading) setCountStarting(true)
    setCountStartError(null)
    setCountStartErrorKind(null)
    try {
      const { data, error: queryError } = await supabaseClient.from('inventory_count_lines')
        .select('product_id, product_name_snapshot, inventory_unit_snapshot, expected_quantity')
        .eq('business_id', businessId).eq('inventory_count_id', inventoryCountId)
        .order('product_name_snapshot', { ascending: true })
      if (queryError) {
        setCountStartError('A contagem foi iniciada, mas não foi possível carregar os saldos de referência. Tente carregar novamente.')
        setCountStartErrorKind('network')
        return false
      }
      const snapshots = data ?? []
      if (snapshots.length === 0) {
        setCountStartError('A referência desta contagem não contém produtos. Confira quais produtos têm controle de estoque configurado no catálogo.')
        setCountStartErrorKind('empty')
        return false
      }
      if (snapshots.length > 500) {
        setCountStartError('Esta referência ultrapassa o limite de 500 produtos. A contagem não pode continuar com este estoque.')
        setCountStartErrorKind('over-limit')
        return false
      }
      setCountDrafts(snapshots.map((item) => ({
        productId: item.product_id,
        productName: item.product_name_snapshot,
        inventoryUnit: item.inventory_unit_snapshot,
        expectedQuantity: Number(item.expected_quantity),
        quantity: '',
      })))
      return true
    } catch {
      setCountStartError('A contagem foi iniciada, mas não foi possível carregar os saldos de referência. Tente carregar novamente.')
      setCountStartErrorKind('network')
      return false
    } finally {
      if (manageLoading) setCountStarting(false)
    }
  }

  async function beginCountSnapshot() {
    if (!supabaseClient) {
      setCountStartError('A conexão do estoque não está disponível.')
      return
    }
    setCountStarting(true)
    setCountStartError(null)
    setCountStartErrorKind(null)
    try {
      const { data, error: rpcError, status } = await supabaseClient.rpc('begin_inventory_count', {
        p_business_id: businessId,
        p_request_id: countBeginRequestIdRef.current,
      })
      if (rpcError) {
        if (status >= 400 && status < 500) {
          countBeginRequestIdRef.current = newRequestId()
          if (balances.length > 500) {
            setCountStartError('A contagem física não está disponível para este estoque: o limite atual é 500 produtos.')
            setCountStartErrorKind('over-limit')
          } else {
            setCountStartError('Não foi possível iniciar a contagem. Confira o estoque e tente novamente.')
            setCountStartErrorKind('begin')
          }
        } else {
          setCountStartError('Não foi possível confirmar se a contagem iniciou. Tente novamente para recuperar o mesmo registro.')
          setCountStartErrorKind('network')
        }
        return
      }
      if (typeof data !== 'string') {
        setCountStartError('A resposta do início da contagem não chegou completa. Tente novamente para recuperar o mesmo registro.')
        setCountStartErrorKind('network')
        return
      }
      setCountSnapshotId(data)
      await loadCountSnapshot(data, false)
    } catch {
      setCountStartError('Não foi possível confirmar se a contagem iniciou. Tente novamente para recuperar o mesmo registro.')
      setCountStartErrorKind('network')
    } finally {
      setCountStarting(false)
    }
  }

  function retryCountStart() {
    if (countSnapshotId) void loadCountSnapshot(countSnapshotId)
    else void beginCountSnapshot()
  }

  function startCount() {
    if (balances.length === 0 || balances.length > 500) return
    setNotice(null)
    setRegisteredReceiptId(null)
    setFormError(null)
    setCountStartError(null)
    setCountStartErrorKind(null)
    setShowReceiptForm(false)
    setShowMovementForm(false)
    setShowCountForm(true)
    setUncertain(false)
    setCountSnapshotId(null)
    setCountDrafts([])
    countBeginRequestIdRef.current = newRequestId()
    void beginCountSnapshot()
  }

  async function loadReturnableItems(orderId: string) {
    const requestNumber = ++returnItemsRequestRef.current
    setReturnableItems([])
    if (!supabaseClient || !orderId) {
      setReturnItemsLoading(false)
      return
    }
    setReturnItemsLoading(true)
    setFormError(null)
    try {
      const [componentsResult, movementsResult] = await Promise.all([
        supabaseClient.from('order_line_components')
          .select('product_id, product_name_snapshot, inventory_unit_snapshot, inventory_tracked_snapshot')
          .eq('business_id', businessId).eq('order_id', orderId),
        supabaseClient.from('inventory_movements')
          .select('product_id, movement_type, quantity_delta')
          .eq('business_id', businessId).eq('order_id', orderId).in('movement_type', ['dispatch', 'return']),
      ])
      if (componentsResult.error || movementsResult.error) {
        setFormError('Não foi possível conferir os itens ainda enviados deste pedido. Tente carregar novamente.')
        return
      }
      const orderedByProduct = new Map<string, { product_name: string; inventory_unit: string }>()
      for (const component of componentsResult.data ?? []) {
        if (!component.inventory_tracked_snapshot || !component.inventory_unit_snapshot) continue
        const current = orderedByProduct.get(component.product_id) ?? {
          product_name: component.product_name_snapshot,
          inventory_unit: component.inventory_unit_snapshot,
        }
        orderedByProduct.set(component.product_id, current)
      }
      const netMovementMilliByProduct = new Map<string, number>()
      for (const movement of movementsResult.data ?? []) {
        const quantityMilli = Math.round(Number(movement.quantity_delta) * 1000)
        netMovementMilliByProduct.set(movement.product_id, (netMovementMilliByProduct.get(movement.product_id) ?? 0) + quantityMilli)
      }
      const returnable = [...orderedByProduct].map(([product_id, item]) => ({
        product_id,
        product_name: item.product_name,
        inventory_unit: item.inventory_unit,
        remaining_quantity: Math.max(-(netMovementMilliByProduct.get(product_id) ?? 0), 0) / 1000,
      })).filter((item) => item.remaining_quantity > 0)
      if (requestNumber === returnItemsRequestRef.current) setReturnableItems(returnable)
    } catch {
      if (requestNumber === returnItemsRequestRef.current) setFormError('Não foi possível conferir os itens ainda enviados deste pedido. Tente carregar novamente.')
    } finally {
      if (requestNumber === returnItemsRequestRef.current) setReturnItemsLoading(false)
    }
  }

  async function handleReceiptSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || saving || trackedProducts.length === 0) return
    const supplier = receiptSupplier.trim()
    const reference = receiptReference.trim()
    const notes = receiptNotes.trim()
    if (supplier.length > 160 || reference.length > 120 || notes.length > 2000) {
      setFormError('Confira o tamanho do fornecedor, referência ou observação.')
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
    if (new Set(itemPayload.map((item) => item.product_id)).size !== itemPayload.length) {
      setFormError('Cada produto deve aparecer uma única vez. Ajuste a quantidade na linha correspondente.')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const { data, error: rpcError, status } = await supabaseClient.rpc('record_inventory_receipt', {
        p_business_id: businessId,
        p_supplier_name: supplier || null,
        p_purchase_reference: reference || null,
        p_received_on: receiptDate,
        p_notes: notes || null,
        p_items: itemPayload,
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
      setShowReceiptForm(false)
      setUncertain(false)
      setNotice('Entrada de estoque registrada para os itens recebidos fisicamente.')
      setRegisteredReceiptId(data)
      receiptRequestIdRef.current = newRequestId()
      await loadData(false)
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
    if (!movementReason.trim() || movementReason.trim().length > 1000) {
      setFormError('Informe o motivo da movimentação (até 1.000 caracteres).')
      return
    }
    if (movementKind === 'return' && !movementOrderId) {
      setFormError('Escolha o pedido associado ao retorno conferido.')
      return
    }
    if (movementKind === 'return') {
      if (returnItemsLoading) {
        setFormError('Aguarde a conferência dos itens ainda enviados deste pedido.')
        return
      }
      if (!selectedReturnableItem) {
        setFormError('Escolha um item que ainda conste como enviado neste pedido.')
        return
      }
      if (quantity > selectedReturnableItem.remaining_quantity) {
        setFormError(`A quantidade informada excede o saldo ainda enviado (${formatQuantity(selectedReturnableItem.remaining_quantity)} ${selectedReturnableItem.inventory_unit}).`)
        return
      }
    }
    const occurredAt = movementDate ? businessLocalDateTimeToIso(movementDate) : null
    if (movementDate && !occurredAt) {
      setFormError('Confira a data e hora no horário de Brasília.')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const { data, error: rpcError, status } = await supabaseClient.rpc('record_inventory_movement', {
        p_business_id: businessId,
        p_product_id: movementProductId,
        p_movement_type: movementKind,
        p_quantity: quantity,
        p_direction: movementKind === 'adjustment' ? movementDirection : null,
        p_reason: movementReason.trim(),
        p_order_id: movementKind === 'return' ? movementOrderId : null,
        p_occurred_at: occurredAt,
        p_request_id: movementRequestIdRef.current,
      })
      if (rpcError) {
        if (status >= 400 && status < 500) {
          movementRequestIdRef.current = newRequestId()
          setFormError(movementKind === 'return'
            ? 'O retorno não foi registrado. Confira se o produto pertence ao pedido e se a quantidade ainda está em trânsito.'
            : 'A movimentação não foi registrada. Confira os dados e tente novamente.')
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
      setNotice(movementKind === 'return' ? 'Retorno conferido registrado manualmente.' : 'Movimentação de estoque registrada.')
      movementRequestIdRef.current = newRequestId()
      await loadData(false)
    } catch {
      setUncertain(true)
      setFormError('Não foi possível confirmar se a movimentação foi registrada. Tente novamente sem alterar os dados.')
    } finally {
      setSaving(false)
    }
  }

  async function handleCountSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || saving || !countSnapshotId || countDrafts.length === 0) return
    const itemPayload = countDrafts.map((draft) => ({
      product_id: draft.productId,
      counted_quantity: parseCountQuantity(draft.quantity, draft.inventoryUnit),
    }))
    if (itemPayload.length !== countDrafts.length || itemPayload.some((item) => !item.product_id || item.counted_quantity === null)) {
      setFormError('Informe a quantidade contada para cada produto. Peças e unidades precisam ser números inteiros; zero também vale.')
      return
    }

    setSaving(true)
    setFormError(null)
    try {
      const { data, error: rpcError, status } = await supabaseClient.rpc('complete_inventory_count', {
        p_business_id: businessId,
        p_inventory_count_id: countSnapshotId,
        p_items: itemPayload,
      })
      if (rpcError) {
        if (status >= 400 && status < 500) {
          setUncertain(false)
          setFormError('A contagem não foi registrada. Confira as quantidades e tente novamente.')
        } else {
          setUncertain(true)
          setFormError('Não foi possível confirmar se a contagem foi registrada. Tente novamente sem alterar os dados.')
        }
        return
      }
      if (typeof data !== 'string') {
        setUncertain(true)
        setFormError('A resposta da contagem não chegou completa. Tente novamente sem alterar os dados.')
        return
      }
      setShowCountForm(false)
      setUncertain(false)
      setNotice('Contagem física registrada. As diferenças foram lançadas no histórico do estoque.')
      setCountSnapshotId(null)
      await loadData(false)
    } catch {
      setUncertain(true)
      setFormError('Não foi possível confirmar se a contagem foi registrada. Tente novamente sem alterar os dados.')
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

  const pagedMovements = movements.slice(historyPage * PAGE_SIZE, (historyPage + 1) * PAGE_SIZE)
  const lastHistoryPage = Math.max(0, Math.ceil(movements.length / PAGE_SIZE) - 1)

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div><p className="eyebrow">OPERAÇÃO · ESTOQUE</p><h1>Estoque</h1><p className="page-description">Quantidade atual de cada produto, compras recebidas e alterações registradas.</p></div>
        <div className="record-heading-actions"><button className="button button-secondary" disabled={countStarting || repeatingReceipt} onClick={startMovement} ref={movementTriggerRef} type="button"><Icon name="plus" /> Movimentar estoque</button><button aria-describedby={!loading && balances.length === 0 ? 'inventory-count-prerequisite' : undefined} className="button button-secondary" disabled={loading || countStarting || repeatingReceipt || balances.length === 0 || balances.length > 500} onClick={startCount} ref={countTriggerRef} type="button"><Icon name="check" /> Contagem física</button><button className="button button-primary" disabled={countStarting || repeatingReceipt} onClick={() => startReceipt()} ref={receiptTriggerRef} type="button"><Icon name="file" /> Receber compra</button></div>
      </header>

      {!loading && balances.length === 0 && <p className="section-footnote" id="inventory-count-prerequisite">Para fazer uma contagem, configure o estoque e o saldo inicial de um produto no <Link to="/catalogo">Catálogo</Link>.</p>}

      {notice && <div className="form-message form-message-success" role="status"><p>{notice}</p>{registeredReceiptId && <Link className="quiet-link" to={`/financeiro/saidas?receiptId=${encodeURIComponent(registeredReceiptId)}`}>Registrar o valor pago desta compra →</Link>}</div>}
      {error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => { setLoading(true); void loadData() }} type="button">Tentar novamente</button></div>}
      {!loading && balances.length > 500 && <p className="form-message form-message-warning" role="status">A contagem física está indisponível: há {balances.length} produtos com saldo registrado; o limite é 500.</p>}

      {showCountForm && <form className="surface-panel record-form" onSubmit={(event) => void handleCountSubmit(event)}>
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">CONFERÊNCIA FÍSICA</p><h2 ref={countHeadingRef} tabIndex={-1}>Contagem de estoque</h2></div><button className="text-button" disabled={saving || uncertain || countStarting} onClick={() => setShowCountForm(false)} type="button">Fechar</button></div>
        <p className="section-footnote inventory-form-hint">Confira o saldo físico. Se fechar, a mesma contagem será retomada; movimentações feitas depois do início serão preservadas.</p>
        {countStarting && <p className="inline-state" aria-live="polite">Capturando os saldos de referência…</p>}
        {countStartError && <div className="form-message form-message-error" role="alert"><p>{countStartError}</p>{countStartErrorKind === 'network' || countStartErrorKind === 'begin' ? <button className="text-button" disabled={countStarting} onClick={retryCountStart} type="button">{countSnapshotId ? 'Tentar carregar a referência' : 'Tentar iniciar ou retomar a contagem'}</button> : countStartErrorKind === 'empty' ? <Link className="quiet-link" to="/catalogo">Conferir produtos no catálogo →</Link> : null}</div>}
        {!countStarting && countSnapshotId && countDrafts.length > 0 && <div className="inventory-line-list">
          {countDrafts.map((draft) => {
            const quantityText = draft.quantity
            const counted = parseCountQuantity(quantityText, draft.inventoryUnit)
            const difference = counted === null ? null : Math.round((counted - draft.expectedQuantity) * 1000) / 1000
            const differenceClass = difference === null || difference === 0 ? '' : difference < 0 ? ' stock-state-low' : ''
            return <div className="inventory-line-row" key={draft.productId}>
              <span className="inventory-balance-copy"><strong>{draft.productName}</strong><small>Saldo no início da contagem: {formatQuantity(draft.expectedQuantity)} {draft.inventoryUnit}</small>{quantityText !== formatQuantity(draft.expectedQuantity) && <button aria-label={`Confirmar que ${draft.productName} tem o mesmo saldo do sistema`} className="text-button" disabled={saving || uncertain} onClick={() => setCountDrafts((current) => current.map((item) => item.productId === draft.productId ? { ...item, quantity: formatQuantity(item.expectedQuantity) } : item))} type="button">Confirmar sem diferença</button>}</span>
              <label className="record-field"><span className="field-label">Quantidade contada · {draft.inventoryUnit}</span><input aria-invalid={quantityText !== '' && counted === null} aria-label={'Quantidade contada de ' + draft.productName} className="text-input" disabled={saving || uncertain} inputMode={isDiscreteInventoryUnit(draft.inventoryUnit) ? 'numeric' : 'decimal'} maxLength={16} onChange={(event) => setCountDrafts((current) => current.map((item) => item.productId === draft.productId ? { ...item, quantity: event.target.value } : item))} placeholder="0" value={quantityText} /></label>
              <span className="inventory-balance-value"><strong>{difference === null ? '—' : `${difference > 0 ? '+' : ''}${formatQuantity(difference)}`} <small>{draft.inventoryUnit}</small></strong><span className={'stock-state' + differenceClass}>{difference === null ? quantityText ? 'Valor inválido' : 'Informe o contado' : difference === 0 ? 'Sem diferença' : 'Diferença'}</span></span>
            </div>
          })}
        </div>}
        {formError && <p className="form-message form-message-error" role="alert">{formError}</p>}
        {countDrafts.length > 0 && <div className="record-form-actions"><button className="button button-primary" disabled={saving || countStarting || !countSnapshotId} type="submit">{saving ? 'Salvando contagem…' : uncertain ? 'Tentar novamente sem alterar os dados' : 'Confirmar contagem física'}</button></div>}
      </form>}

      <section className="order-balance-grid inventory-summary" aria-label="Resumo do estoque">
        <article className="surface-panel order-balance-card"><span>Produtos com saldo no sistema</span><strong>{loading ? '—' : trackedProducts.length}</strong><small>Atualizado em despachos, retiradas e recebimentos.</small></article>
        <article className="surface-panel order-balance-card"><span>Abaixo do mínimo</span><strong>{loading ? '—' : belowMinimum.length}</strong><small>Somente produtos com limite configurado.</small>{!loading && belowMinimum.length > 0 && <button className="text-button" onClick={() => setShowReplenishmentList((value) => !value)} type="button">{showReplenishmentList ? 'Fechar lista' : 'Montar lista de reposição'}</button>}</article>
        <article className="surface-panel order-balance-card"><span>Estoque negativo</span><strong>{loading ? '—' : negativeBalances.length}</strong><small>Saíram mais unidades do que havia no saldo.</small></article>
      </section>

      {showReplenishmentList && belowMinimum.length > 0 && <section className="surface-panel record-panel" aria-labelledby="inventory-replenishment-heading">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">SUGESTÃO DE COMPRA</p><h2 id="inventory-replenishment-heading">Lista de reposição</h2></div><span className="neutral-status">{belowMinimum.length}</span></div>
        <p className="section-footnote">A sugestão mostra quanto falta para chegar ao mínimo cadastrado. Ela não altera o estoque; informe a quantidade que realmente chegar.</p>
        <ul className="inventory-balance-list">{belowMinimum.map((balance) => {
          const deficit = Math.round((Number(balance.minimum_stock) - Number(balance.quantity_on_hand)) * 1000) / 1000
          return <li key={balance.product_id}><span className="inventory-balance-copy"><strong>{balance.product_name}</strong><small>Saldo {formatQuantity(Number(balance.quantity_on_hand))} · mínimo {formatQuantity(Number(balance.minimum_stock))}</small></span><span className="inventory-balance-value"><strong>{formatQuantity(deficit)} <small>{balance.inventory_unit}</small></strong><span className="stock-state stock-state-low">Sugestão para repor</span></span></li>
        })}</ul>
        <div className="record-form-actions"><button className="button button-secondary" disabled={loading || saving} onClick={() => startReceipt(belowMinimum.map((balance) => balance.product_id))} type="button">Usar produtos na entrada de estoque</button></div>
      </section>}

      {showReceiptForm && <form className="surface-panel record-form" onSubmit={(event) => void handleReceiptSubmit(event)}>
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">ENTRADA FÍSICA</p><h2 ref={receiptHeadingRef} tabIndex={-1}>Registrar compra recebida</h2></div><button className="text-button" disabled={receiptFormDisabled} onClick={() => setShowReceiptForm(false)} type="button">Fechar</button></div>
        <p className="section-footnote inventory-form-hint">Informe quantidade e custo unitário recebido. O custo médio atualiza os próximos pedidos; compras antigas não alteram vendas já registradas.</p>
        {trackedProducts.length === 0 ? <p className="inline-state">Edite um produto no <Link to="/catalogo">Catálogo</Link> e informe sua unidade e quantidade física para registrar compras recebidas.</p> : <>
          {receipts[0] && <button className="text-button" disabled={saving || uncertain || repeatingReceipt || receiptHasProductLines} onClick={() => void repeatLastReceiptProducts()} type="button">{repeatingReceipt ? 'Carregando produtos…' : 'Repetir produtos da última compra'}</button>}
          {receiptSuggestionNotice && <p className="form-message form-message-success" role="status">{receiptSuggestionNotice}</p>}
          <div className="inventory-line-list">
            {receiptLines.map((line, index) => {
              const selected = trackedProducts.find((product) => product.id === line.productId)
              return <div className="inventory-line-row" key={line.key}>
                <label className="record-field"><span className="field-label">Produto {index + 1}</span><select className="text-input" disabled={receiptFormDisabled} onChange={(event) => setReceiptLines((current) => current.map((row) => {
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
          <button className="button button-secondary inventory-add-line" disabled={receiptFormDisabled} onClick={() => setReceiptLines((current) => [...current, newLine()])} type="button"><Icon name="plus" /> Adicionar produto</button>
          <div className="record-form-grid inventory-receipt-date-row">
            <label className="record-field"><span className="field-label">Recebido em</span><input className="text-input" disabled={receiptFormDisabled} max={businessToday()} onChange={(event) => setReceiptDate(event.target.value)} required type="date" value={receiptDate} /><small className="field-optional">Padrão: hoje. Mude somente se recebeu em outro dia.</small></label>
          </div>
          <details className="record-field-wide inventory-receipt-details">
            <summary>Detalhes opcionais da compra</summary>
            <div className="record-form-grid">
              <label className="record-field"><span className="field-label">Fornecedor</span><input autoComplete="off" className="text-input" disabled={receiptFormDisabled} list="inventory-recent-suppliers" maxLength={160} onChange={(event) => setReceiptSupplier(event.target.value)} placeholder="Opcional" value={receiptSupplier} /><datalist id="inventory-recent-suppliers">{recentSuppliers.map((supplier) => <option key={supplier} value={supplier} />)}</datalist></label>
              <label className="record-field"><span className="field-label">Nº da nota ou referência</span><input className="text-input" disabled={receiptFormDisabled} maxLength={120} onChange={(event) => setReceiptReference(event.target.value)} placeholder="Opcional" value={receiptReference} /></label>
              <label className="record-field record-field-wide"><span className="field-label">Observações</span><input className="text-input" disabled={receiptFormDisabled} maxLength={2000} onChange={(event) => setReceiptNotes(event.target.value)} placeholder="Opcional" value={receiptNotes} /></label>
            </div>
          </details>
          {formError && <p className="form-message form-message-error" role="alert">{formError}</p>}
          <div className="record-form-actions"><button className="button button-primary" disabled={saving || repeatingReceipt} type="submit">{saving ? 'Registrando…' : uncertain ? 'Tentar novamente sem alterar os dados' : repeatingReceipt ? 'Carregando produtos…' : 'Confirmar recebimento físico'}</button></div>
        </>}
      </form>}

      {showMovementForm && <form className="surface-panel record-form" onSubmit={(event) => void handleMovementSubmit(event)}>
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">MOVIMENTAÇÃO MANUAL</p><h2 ref={movementHeadingRef} tabIndex={-1}>Ajustar estoque</h2></div><button className="text-button" disabled={saving || uncertain} onClick={() => setShowMovementForm(false)} type="button">Fechar</button></div>
        <p className="section-footnote inventory-form-hint">Corrija uma contagem, registre uma perda ou adicione um retorno já conferido.</p>
        <div className="record-form-grid">
          <label className="record-field"><span className="field-label">O que aconteceu? <span aria-hidden="true">*</span></span><select className="text-input" disabled={saving || uncertain} onChange={(event) => { setMovementKind(event.target.value as MovementKind); setMovementOrderId(''); setMovementProductId(''); setReturnableItems([]); setFormError(null) }} value={movementKind}><option value="adjustment">Corrigir quantidade</option><option value="loss">Registrar perda ou avaria</option><option value="return">Registrar retorno conferido</option></select></label>
          {movementKind === 'return' && <label className="record-field"><span className="field-label">Pedido associado <span aria-hidden="true">*</span></span><select className="text-input" disabled={saving || uncertain} onChange={(event) => { const orderId = event.target.value; setMovementOrderId(orderId); setMovementProductId(''); setReturnableItems([]); if (orderId) void loadReturnableItems(orderId) }} required value={movementOrderId}><option value="">Selecione um pedido enviado</option>{returnCandidates.map((order) => <option key={order.id} value={order.id}>{order.customer_name_snapshot} · {order.fulfillment_type === 'pickup' ? 'Retirada' : 'Entrega'} · {order.id.slice(0, 8)}</option>)}</select></label>}
          <label className="record-field"><span className="field-label">Produto <span aria-hidden="true">*</span></span><select className="text-input" disabled={saving || uncertain || (movementKind === 'return' && (returnItemsLoading || !movementOrderId))} onChange={(event) => setMovementProductId(event.target.value)} required value={movementProductId}><option value="">{movementKind === 'return' ? returnItemsLoading ? 'Conferindo itens do pedido…' : 'Selecione um item enviado' : 'Selecione um produto com estoque'}</option>{movementKind === 'return' ? returnableItems.map((item) => <option key={item.product_id} value={item.product_id}>{item.product_name} · ainda enviado {formatQuantity(item.remaining_quantity)} {item.inventory_unit}</option>) : trackedProducts.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.inventory_unit}</option>)}</select></label>
          <label className="record-field"><span className="field-label">Quantidade{movementProductId && selectedMovementUnit ? ' · ' + selectedMovementUnit : ''} <span aria-hidden="true">*</span></span><input className="text-input" disabled={saving || uncertain} inputMode={isDiscreteInventoryUnit(selectedMovementUnit) ? 'numeric' : 'decimal'} maxLength={16} onChange={(event) => setMovementQuantity(event.target.value)} placeholder="0" required value={movementQuantity} /></label>
          {movementKind === 'adjustment' && <label className="record-field"><span className="field-label">Direção do ajuste <span aria-hidden="true">*</span></span><select className="text-input" disabled={saving || uncertain} onChange={(event) => setMovementDirection(event.target.value as 'increase' | 'decrease')} value={movementDirection}><option value="increase">Adicionar ao saldo</option><option value="decrease">Retirar do saldo</option></select></label>}
          <label className="record-field"><span className="field-label">Data e hora <span className="field-optional">Brasília · vazio = agora</span></span><input className="text-input" disabled={saving || uncertain} onChange={(event) => setMovementDate(event.target.value)} type="datetime-local" value={movementDate} /></label>
          <label className="record-field record-field-wide"><span className="field-label">Motivo ou conferência <span aria-hidden="true">*</span></span><textarea className="text-input record-textarea" disabled={saving || uncertain} maxLength={1000} onChange={(event) => setMovementReason(event.target.value)} required rows={2} value={movementReason} /></label>
        </div>
        {movementKind === 'return' && <>
          {returnItemsLoading && <p className="inline-state" aria-live="polite">Conferindo quantidades enviadas e retornadas deste pedido…</p>}
          {!returnItemsLoading && movementOrderId && returnableItems.length === 0 && !formError && <p className="inline-state">Este pedido não tem quantidade controlada ainda enviada para retorno. Confira o pedido e o histórico de estoque.</p>}
          {selectedReturnableItem && <p className="form-message form-message-warning" role="status">Ainda enviado neste pedido: <strong>{formatQuantity(selectedReturnableItem.remaining_quantity)} {selectedReturnableItem.inventory_unit}</strong>. O saldo só aumenta depois da conferência física, e a quantidade do retorno não pode exceder esse valor.</p>}
          {!movementOrderId && <p className="section-footnote">Escolha um pedido para ver quais itens ainda constam como enviados e os limites de retorno de cada um.</p>}
        </>}
        {formError && <div className="form-message form-message-error" role="alert"><p>{formError}</p>{movementKind === 'return' && movementOrderId && <button className="text-button" disabled={returnItemsLoading} onClick={() => void loadReturnableItems(movementOrderId)} type="button">Recarregar itens ainda enviados</button>}</div>}
        <div className="record-form-actions"><button className="button button-primary" disabled={saving} type="submit">{saving ? 'Registrando…' : uncertain ? 'Tentar novamente sem alterar os dados' : 'Salvar movimentação'}</button></div>
      </form>}

      <section className="surface-panel record-panel" aria-labelledby="inventory-balance-heading">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">QUANTIDADE ATUAL</p><h2 id="inventory-balance-heading">Produtos com saldo</h2></div><span className="neutral-status">{loading ? '—' : balances.length}</span></div>
        {!loading && balances.length > 0 && <label className="search-field"><Icon name="search" /><span className="visually-hidden">Buscar produtos no estoque</span><input onChange={(event) => setBalanceSearch(event.target.value)} placeholder="Buscar produto" value={balanceSearch} /></label>}
        {loading ? <p className="inline-state" aria-live="polite">Carregando saldos…</p> : balances.length === 0 ? <div className="inline-state"><p>Não há saldos configurados. Configure a unidade e a contagem inicial no catálogo.</p><Link className="quiet-link" to="/catalogo">Abrir catálogo →</Link></div> : <ul className="inventory-balance-list">
          {filteredBalances.length === 0 ? <li className="inline-state">Nenhum produto corresponde à busca.</li> : filteredBalances.map((balance) => {
            const quantity = Number(balance.quantity_on_hand)
            const isNegative = quantity < 0
            const isZero = quantity === 0
            const isBelow = balance.minimum_stock !== null && quantity < Number(balance.minimum_stock)
            return <li key={balance.product_id}>
              <span className="inventory-balance-copy"><strong>{balance.product_name}</strong><small>Unidade: {balance.inventory_unit}{balance.minimum_stock !== null ? ' · Mínimo ' + formatQuantity(Number(balance.minimum_stock)) : ' · Sem limite mínimo'}</small></span>
              <span className="inventory-balance-value"><strong>{formatQuantity(quantity)} <small>{balance.inventory_unit}</small></strong><span className={'stock-state' + (isNegative ? ' stock-state-negative' : isZero ? ' stock-state-zero' : isBelow ? ' stock-state-low' : '')}>{isNegative ? 'Estoque negativo' : isZero ? 'Sem estoque' : isBelow ? 'Abaixo do mínimo' : 'Disponível'}</span></span>
            </li>
          })}
        </ul>}
        {!loading && untrackedProducts.length > 0 && <div className="inventory-untracked"><p className="eyebrow">SEM CONTROLE DE ESTOQUE</p><p>{untrackedProducts.map((product) => product.name).join(' · ')}</p><Link className="quiet-link" to="/catalogo">Ativar estoque no catálogo →</Link></div>}
        {!loading && products.some((product) => product.is_combo) && <p className="section-footnote inventory-combo-note">Combos não têm saldo próprio. A disponibilidade é formada pelos saldos dos produtos da composição.</p>}
      </section>

      <section className="surface-panel record-panel" aria-labelledby="inventory-history-heading">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">RASTREABILIDADE</p><h2 id="inventory-history-heading">Histórico de movimentações</h2></div><span className="neutral-status">{movementTotal}</span></div>
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
      </section>
    </div>
  )
}
