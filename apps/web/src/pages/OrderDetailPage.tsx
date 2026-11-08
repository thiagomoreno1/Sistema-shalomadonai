import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { businessLocalDateTimeToIso, businessToday, formatBRL, formatBusinessDate, parseBrazilianCurrency } from '../lib/formatters'
import { supabaseClient } from '../lib/supabase'

type Order = {
  id: string
  customer_id: string
  customer_name_snapshot: string
  delivery_address_snapshot: string | null
  subtotal_cents: number
  delivery_fee_cents: number
  discount_cents: number
  total_cents: number
  notes: string | null
  status: 'open' | 'cancelled'
  requires_delivery: boolean
  cancellation_reason: string | null
  created_at: string
  cancelled_at: string | null
}
type OrderLine = {
  id: string
  product_id: string
  line_number: number
  product_name_snapshot: string
  inventory_unit_snapshot: string | null
  quantity: number
  unit_price_snapshot_cents: number
  line_total_cents: number
}
type OrderLineComponent = { id: string; order_line_id: string; product_id: string; product_name_snapshot: string; inventory_unit_snapshot: string | null; quantity_snapshot: number; inventory_tracked_snapshot: boolean }
type Installment = {
  id: string
  installment_number: number
  amount_cents: number
  due_on: string
  payment_method: string | null
}
type Payment = {
  id: string
  amount_cents: number
  received_at: string
  payment_method: string | null
  notes: string | null
}
type PaymentAllocation = { id: string; payment_id: string; installment_id: string; amount_cents: number }
type PickupWarning = { product_id: string; product_name: string; inventory_unit: string; quantity_on_hand: number }
type PickupPreviewItem = PickupWarning & { available: number; needed: number; projected: number }
type PickupPreviewWarning = PickupPreviewItem
type OrderEvent = { id: string; event_type: 'created' | 'cancelled' | 'picked_up'; reason: string | null; stock_warnings: PickupWarning[]; occurred_at: string }
type DeliveryStatus = 'awaiting_separation' | 'ready' | 'dispatched' | 'delivered' | 'attempted' | 'rescheduled' | 'returned'
type Delivery = { id: string; status: DeliveryStatus; delivery_worker_id: string | null; scheduled_on: string | null; time_window: string | null; notes: string | null; canceled_at: string | null; dispatched_at: string | null; delivered_at: string | null; attempted_at: string | null; returned_at: string | null }
type DeliveryEvent = { id: string; event_type: 'created' | 'plan_updated' | 'status_changed'; from_status: DeliveryStatus | null; to_status: DeliveryStatus; note: string | null; next_step: string | null; stock_warnings: Array<{ product_name: string; inventory_unit: string; quantity_on_hand: number }>; occurred_at: string }
type LocationState = { successMessage?: string } | null

const deliveryStatusLabels: Record<DeliveryStatus, string> = {
  awaiting_separation: 'Aguardando separação',
  ready: 'Pronta para despacho',
  dispatched: 'Em rota',
  delivered: 'Entregue',
  attempted: 'Entrega não concluída',
  rescheduled: 'Reagendada',
  returned: 'Devolvida',
}

function newRequestId() {
  return crypto.randomUUID()
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(value)
}

function formatOrderTimestamp(value: string, withTime = false) {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' as const } : {}),
    timeZone: 'America/Sao_Paulo',
  }).format(new Date(value))
}

export function OrderDetailPage() {
  const { orderId = '' } = useParams()
  const { id: businessId, role } = useBusiness()
  const location = useLocation()
  const navigate = useNavigate()
  const locationState = location.state as LocationState
  const [order, setOrder] = useState<Order | null>(null)
  const [lines, setLines] = useState<OrderLine[]>([])
  const [lineComponents, setLineComponents] = useState<OrderLineComponent[]>([])
  const [delivery, setDelivery] = useState<Delivery | null>(null)
  const [deliveryEvents, setDeliveryEvents] = useState<DeliveryEvent[]>([])
  const [deliveryWorkerName, setDeliveryWorkerName] = useState<string | null>(null)
  const [installments, setInstallments] = useState<Installment[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [allocations, setAllocations] = useState<PaymentAllocation[]>([])
  const [events, setEvents] = useState<OrderEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(locationState?.successMessage ?? null)
  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [receivedAt, setReceivedAt] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [paymentNotes, setPaymentNotes] = useState('')
  const [allocationDraft, setAllocationDraft] = useState<Record<string, string>>({})
  const [paymentSaving, setPaymentSaving] = useState(false)
  const [paymentUncertain, setPaymentUncertain] = useState(false)
  const [paymentError, setPaymentError] = useState<string | null>(null)
  const paymentRequestIdRef = useRef(newRequestId())
  const paymentAmountInputRef = useRef<HTMLInputElement>(null)
  const wasPaymentFormOpenRef = useRef(false)
  const orderHeadingRef = useRef<HTMLHeadingElement>(null)
  const [showCancelForm, setShowCancelForm] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelSaving, setCancelSaving] = useState(false)
  const [showDeleteForm, setShowDeleteForm] = useState(false)
  const [deleteSaving, setDeleteSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showPickupForm, setShowPickupForm] = useState(false)
  const [pickupPreviewLoading, setPickupPreviewLoading] = useState(false)
  const [pickupPreviewReady, setPickupPreviewReady] = useState(false)
  const [pickupPreviewItems, setPickupPreviewItems] = useState<PickupPreviewItem[]>([])
  const [pickupWarnings, setPickupWarnings] = useState<PickupPreviewWarning[]>([])
  const [pickupSaving, setPickupSaving] = useState(false)
  const [pickupUncertain, setPickupUncertain] = useState(false)
  const [pickupError, setPickupError] = useState<string | null>(null)
  const pickupRequestIdRef = useRef(newRequestId())
  const pickupHeadingRef = useRef<HTMLHeadingElement>(null)
  const wasPickupFormOpenRef = useRef(false)
  const pickupEvent = events.find((event) => event.event_type === 'picked_up')

  const loadDetail = useCallback(async (showBusy = true) => {
    if (!supabaseClient) {
      setError('A conexão da empresa não está disponível.')
      setLoading(false)
      return
    }
    if (showBusy) setLoading(true)
    let orderExists = false
    try {
      const orderResult = await supabaseClient.from('orders')
        .select('id, customer_id, customer_name_snapshot, delivery_address_snapshot, subtotal_cents, delivery_fee_cents, discount_cents, total_cents, notes, status, cancellation_reason, created_at, cancelled_at, requires_delivery')
        .eq('business_id', businessId).eq('id', orderId).maybeSingle()
      if (orderResult.error || !orderResult.data) {
        setError(locationState?.successMessage
          ? 'O pedido foi criado, mas não consegui carregar os detalhes agora. Atualize esta tela ou volte à lista para abri-lo novamente.'
          : orderResult.error ? 'Não foi possível carregar este pedido. Tente novamente.' : 'Este pedido não está disponível.')
        return
      }
      orderExists = true

      const [linesResult, installmentsResult, paymentsResult, eventsResult, componentsResult, deliveryResult] = await Promise.all([
        supabaseClient.from('order_lines')
          .select('id, product_id, line_number, product_name_snapshot, inventory_unit_snapshot, quantity, unit_price_snapshot_cents, line_total_cents')
          .eq('business_id', businessId).eq('order_id', orderId).order('line_number', { ascending: true }),
        supabaseClient.from('order_installments')
          .select('id, installment_number, amount_cents, due_on, payment_method')
          .eq('business_id', businessId).eq('order_id', orderId).order('installment_number', { ascending: true }),
        supabaseClient.from('order_payments')
          .select('id, amount_cents, received_at, payment_method, notes')
          .eq('business_id', businessId).eq('order_id', orderId).order('received_at', { ascending: false }),
        supabaseClient.from('order_events')
          .select('id, event_type, reason, stock_warnings, occurred_at')
          .eq('business_id', businessId).eq('order_id', orderId).order('occurred_at', { ascending: false }),
        supabaseClient.from('order_line_components')
          .select('id, order_line_id, product_id, product_name_snapshot, inventory_unit_snapshot, quantity_snapshot, inventory_tracked_snapshot')
          .eq('business_id', businessId).eq('order_id', orderId).order('product_name_snapshot', { ascending: true }),
        supabaseClient.from('deliveries')
          .select('id, status, delivery_worker_id, scheduled_on, time_window, notes, canceled_at, dispatched_at, delivered_at, attempted_at, returned_at')
          .eq('business_id', businessId).eq('order_id', orderId).maybeSingle(),
      ])
      const failedRead = [
        { label: 'os produtos do pedido', error: linesResult.error },
        { label: 'o cronograma de pagamento do pedido', error: installmentsResult.error },
        { label: 'os pagamentos recebidos', error: paymentsResult.error },
        { label: 'o histórico do pedido', error: eventsResult.error },
        { label: 'os itens das cestas', error: componentsResult.error },
        { label: 'os dados da entrega', error: deliveryResult.error },
      ].find((result) => result.error)
      if (failedRead) {
        setError(`O pedido foi salvo, mas não consegui carregar ${failedRead.label}. Atualize esta tela para tentar novamente.`)
        return
      }
      let deliveryEventRows: DeliveryEvent[] = []
      let workerName: string | null = null
      if (deliveryResult.data) {
        const [deliveryEventsResult, workerResult] = await Promise.all([
          supabaseClient.from('delivery_events').select('id, event_type, from_status, to_status, note, next_step, stock_warnings, occurred_at')
            .eq('business_id', businessId).eq('delivery_id', deliveryResult.data.id).order('occurred_at', { ascending: false }),
          deliveryResult.data.delivery_worker_id
            ? supabaseClient.from('delivery_workers').select('name').eq('business_id', businessId).eq('id', deliveryResult.data.delivery_worker_id).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ])
        if (deliveryEventsResult.error || workerResult.error) {
          setError('O pedido foi salvo, mas não consegui carregar o histórico de entrega. Atualize esta tela para tentar novamente.')
          return
        }
        deliveryEventRows = (deliveryEventsResult.data ?? []) as DeliveryEvent[]
        workerName = workerResult.data?.name ?? null
      }
      const loadedPayments = (paymentsResult.data ?? []) as Payment[]
      let loadedAllocations: PaymentAllocation[] = []
      if (loadedPayments.length > 0) {
        const allocationResult = await supabaseClient.from('order_payment_allocations')
          .select('id, payment_id, installment_id, amount_cents')
          .eq('business_id', businessId).eq('order_id', orderId)
          .in('payment_id', loadedPayments.map((payment) => payment.id))
        if (allocationResult.error) {
          setError('O pedido foi salvo, mas não consegui carregar a distribuição dos recebimentos. Atualize esta tela para tentar novamente.')
          return
        }
        loadedAllocations = (allocationResult.data ?? []) as PaymentAllocation[]
      }
      setOrder(orderResult.data as Order)
      setLines((linesResult.data ?? []) as OrderLine[])
      setLineComponents((componentsResult.data ?? []) as OrderLineComponent[])
      setDelivery(deliveryResult.data as Delivery | null)
      setDeliveryEvents(deliveryEventRows)
      setDeliveryWorkerName(workerName)
      setInstallments((installmentsResult.data ?? []) as Installment[])
      setPayments(loadedPayments)
      setAllocations(loadedAllocations)
      setEvents((eventsResult.data ?? []) as OrderEvent[])
      setError(null)
    } catch {
      setError(orderExists || locationState?.successMessage
        ? 'O pedido está salvo, mas não consegui carregar os detalhes agora. Atualize esta tela ou volte à lista para abri-lo novamente.'
        : 'Não foi possível carregar este pedido. Tente novamente.')
    } finally {
      setLoading(false)
    }
  }, [businessId, orderId, locationState])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadDetail() }, [loadDetail])

  useEffect(() => {
    if (showPaymentForm) paymentAmountInputRef.current?.focus()
    else if (wasPaymentFormOpenRef.current) orderHeadingRef.current?.focus()
    wasPaymentFormOpenRef.current = showPaymentForm
  }, [showPaymentForm])

  useEffect(() => {
    if (showPickupForm) pickupHeadingRef.current?.focus()
    else if (wasPickupFormOpenRef.current) orderHeadingRef.current?.focus()
    wasPickupFormOpenRef.current = showPickupForm
  }, [showPickupForm])

  const receivedCents = payments.reduce((sum, payment) => sum + payment.amount_cents, 0)
  const outstandingCents = order?.status === 'open' ? Math.max(0, (order?.total_cents ?? 0) - receivedCents) : 0
  const deleteEligible = role === 'owner'
    && payments.length === 0
    && !pickupEvent
    && (!delivery || delivery.status === 'awaiting_separation' || delivery.status === 'ready')
  const today = businessToday()
  const paidByInstallment = useMemo(() => {
    const result = new Map<string, number>()
    for (const allocation of allocations) result.set(allocation.installment_id, (result.get(allocation.installment_id) ?? 0) + allocation.amount_cents)
    return result
  }, [allocations])
  const componentsByLine = new Map<string, OrderLineComponent[]>()
  for (const component of lineComponents) {
    const current = componentsByLine.get(component.order_line_id) ?? []
    current.push(component)
    componentsByLine.set(component.order_line_id, current)
  }
  const selectedAllocations = Object.entries(allocationDraft)
    .map(([installment_id, value]) => ({ installment_id, amount_cents: parseBrazilianCurrency(value) }))
    .filter((allocation): allocation is { installment_id: string; amount_cents: number } => allocation.amount_cents !== null && !Number.isNaN(allocation.amount_cents) && allocation.amount_cents > 0)
  const selectedAllocationTotal = selectedAllocations.reduce((sum, allocation) => sum + allocation.amount_cents, 0)
  const parsedPaymentAmount = parseBrazilianCurrency(paymentAmount)
  const allocationDifference = parsedPaymentAmount !== null && !Number.isNaN(parsedPaymentAmount)
    ? parsedPaymentAmount - selectedAllocationTotal
    : null
  const allocationComplete = parsedPaymentAmount !== null && !Number.isNaN(parsedPaymentAmount)
    && parsedPaymentAmount > 0 && selectedAllocationTotal > 0 && allocationDifference === 0

  function startPayment() {
    paymentRequestIdRef.current = newRequestId()
    setPaymentAmount('')
    setReceivedAt('')
    setPaymentMethod('')
    setPaymentNotes('')
    setAllocationDraft(Object.fromEntries(installments.map((installment) => [installment.id, ''])))
    setPaymentError(null)
    setPaymentUncertain(false)
    setShowPaymentForm(true)
  }

  function closePaymentForm() {
    setShowPaymentForm(false)
    setPaymentUncertain(false)
    setPaymentError(null)
    paymentRequestIdRef.current = newRequestId()
  }

  function suggestOldestFirstAllocation() {
    if (parsedPaymentAmount === null || Number.isNaN(parsedPaymentAmount) || parsedPaymentAmount <= 0) {
      setPaymentError('Informe primeiro um valor recebido positivo para sugerir a distribuição.')
      return
    }
    let remaining = parsedPaymentAmount
    const nextDraft = Object.fromEntries(installments.map((installment) => [installment.id, ''])) as Record<string, string>
    const oldestFirst = [...installments].sort((left, right) =>
      left.due_on.localeCompare(right.due_on) || left.installment_number - right.installment_number,
    )
    for (const installment of oldestFirst) {
      const balance = Math.max(0, installment.amount_cents - (paidByInstallment.get(installment.id) ?? 0))
      if (balance <= 0 || remaining <= 0) continue
      const allocated = Math.min(balance, remaining)
      nextDraft[installment.id] = `${Math.floor(allocated / 100)},${String(allocated % 100).padStart(2, '0')}`
      remaining -= allocated
    }
    setAllocationDraft(nextDraft)
    setPaymentError(null)
  }

  async function previewPickupStock() {
    if (!supabaseClient || !order) return
    setPickupPreviewLoading(true)
    setPickupPreviewReady(false)
    setPickupError(null)
    try {
      const neededByProduct = new Map<string, { name: string; unit: string; needed: number }>()
      for (const component of lineComponents) {
        if (!component.inventory_tracked_snapshot) continue
        const current = neededByProduct.get(component.product_id) ?? {
          name: component.product_name_snapshot,
          unit: component.inventory_unit_snapshot ?? '',
          needed: 0,
        }
        current.needed += Number(component.quantity_snapshot)
        neededByProduct.set(component.product_id, current)
      }

      const productIds = [...neededByProduct.keys()]
      let balances: Array<{ product_id: string; quantity_on_hand: number }> = []
      if (productIds.length > 0) {
        const { data, error: balanceError } = await supabaseClient.from('inventory_balances')
          .select('product_id, quantity_on_hand')
          .eq('business_id', businessId)
          .in('product_id', productIds)
        if (balanceError) {
          setPickupError('Não foi possível conferir os saldos atuais. Tente conferir novamente antes de confirmar a retirada.')
          return
        }
        balances = (data ?? []) as Array<{ product_id: string; quantity_on_hand: number }>
      }
      const balanceByProduct = new Map(balances.map((balance) => [balance.product_id, Number(balance.quantity_on_hand)]))
      const previewItems: PickupPreviewItem[] = []
      for (const [productId, item] of neededByProduct) {
        const available = balanceByProduct.get(productId) ?? 0
        const projected = available - item.needed
        previewItems.push({
          product_id: productId,
          product_name: item.name,
          inventory_unit: item.unit,
          quantity_on_hand: projected,
          available,
          needed: item.needed,
          projected,
        })
      }
      setPickupPreviewItems(previewItems)
      setPickupWarnings(previewItems.filter((item) => item.projected < 0))
      setPickupPreviewReady(true)
    } catch {
      setPickupError('Não foi possível conferir os saldos atuais. Tente conferir novamente antes de confirmar a retirada.')
    } finally {
      setPickupPreviewLoading(false)
    }
  }

  async function startPickup() {
    if (!order || order.status !== 'open' || order.requires_delivery || pickupEvent || pickupPreviewLoading) return
    setNotice(null)
    setActionError(null)
    setPickupError(null)
    setPickupPreviewItems([])
    setPickupWarnings([])
    setPickupPreviewReady(false)
    if (!pickupUncertain) pickupRequestIdRef.current = newRequestId()
    setPickupUncertain(false)
    setShowPickupForm(true)
    await previewPickupStock()
  }

  function closePickupForm() {
    setShowPickupForm(false)
    if (!pickupUncertain) pickupRequestIdRef.current = newRequestId()
    setPickupError(null)
  }

  async function handlePickupSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || !order || pickupSaving || !pickupPreviewReady) return
    setPickupSaving(true)
    setPickupError(null)
    try {
      const { data, error: rpcError, status } = await supabaseClient.rpc('record_order_pickup', {
        p_business_id: businessId,
        p_order_id: order.id,
        p_request_id: pickupRequestIdRef.current,
      })
      if (rpcError) {
        if (status >= 400 && status < 500) {
          pickupRequestIdRef.current = newRequestId()
          setPickupUncertain(false)
          setPickupError('A retirada não foi registrada. Atualize o pedido e confira se ele continua elegível antes de tentar novamente.')
          await loadDetail(false)
        } else {
          setPickupUncertain(true)
          setPickupError('Não foi possível confirmar se a retirada foi registrada. Tente novamente sem alterar a ação para evitar uma baixa duplicada.')
        }
        return
      }
      if (typeof data !== 'string') {
        setPickupUncertain(true)
        setPickupError('A resposta da retirada não chegou completa. Tente novamente sem alterar a ação.')
        return
      }
      setShowPickupForm(false)
      setPickupUncertain(false)
      setNotice('Retirada pelo cliente registrada. O estoque foi atualizado e o histórico preservado.')
      pickupRequestIdRef.current = newRequestId()
      await loadDetail(false)
    } catch {
      setPickupUncertain(true)
      setPickupError('Não foi possível confirmar se a retirada foi registrada. Tente novamente sem alterar a ação.')
    } finally {
      setPickupSaving(false)
    }
  }

  async function handlePaymentSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || !order || paymentSaving) return
    if (parsedPaymentAmount === null || Number.isNaN(parsedPaymentAmount) || parsedPaymentAmount <= 0) {
      setPaymentError('Informe um valor recebido positivo, com até duas casas decimais.')
      return
    }
    if (paymentMethod.trim().length > 64 || paymentNotes.trim().length > 1000) {
      setPaymentError('Confira o tamanho da forma informada ou das observações.')
      return
    }
    if (selectedAllocations.length === 0 || selectedAllocationTotal !== parsedPaymentAmount) {
      setPaymentError('Distribua o valor recebido manualmente. A soma das destinações deve ser igual ao recebimento.')
      return
    }
    for (const allocation of selectedAllocations) {
      const installment = installments.find((candidate) => candidate.id === allocation.installment_id)
      const balance = installment ? installment.amount_cents - (paidByInstallment.get(installment.id) ?? 0) : 0
      if (!installment || allocation.amount_cents > balance) {
        setPaymentError('Uma destinação excede o saldo do vencimento. Confira os valores atuais e tente novamente.')
        return
      }
    }
    if (parsedPaymentAmount > outstandingCents) {
      setPaymentError('O valor pago não pode ser maior do que falta receber neste pedido.')
      return
    }
    const receivedAtIso = receivedAt ? businessLocalDateTimeToIso(receivedAt) : null
    if (receivedAt && !receivedAtIso) {
      setPaymentError('Confira a data e hora do recebimento.')
      return
    }
    setPaymentSaving(true)
    setPaymentError(null)
    try {
      const { data, error: rpcError, status: rpcStatus } = await supabaseClient.rpc('record_order_payment', {
        p_business_id: businessId,
        p_order_id: order.id,
        p_amount_cents: parsedPaymentAmount,
        p_received_at: receivedAtIso,
        p_payment_method: paymentMethod.trim() || null,
        p_notes: paymentNotes.trim() || null,
        p_allocations: selectedAllocations,
        p_request_id: paymentRequestIdRef.current,
      })
      if (rpcError) {
        if (rpcStatus >= 400 && rpcStatus < 500) {
          paymentRequestIdRef.current = newRequestId()
          setPaymentUncertain(false)
          setPaymentError('O recebimento não foi registrado. Confira os saldos atuais e os dados informados; depois tente novamente.')
          await loadDetail(false)
        } else {
          setPaymentUncertain(true)
          setPaymentError('Não foi possível confirmar se o recebimento foi registrado. Tente novamente sem alterar os dados para evitar duplicidade.')
        }
        return
      }
      if (typeof data !== 'string') {
        setPaymentUncertain(true)
        setPaymentError('A resposta do recebimento não chegou completa. Tente novamente sem alterar o formulário.')
        return
      }
      setNotice('Recebimento registrado manualmente.')
      closePaymentForm()
      await loadDetail(false)
    } catch {
      setPaymentUncertain(true)
      setPaymentError('Não foi possível confirmar se o recebimento foi registrado. Seus dados foram preservados; tente novamente sem alterar o formulário.')
    } finally {
      setPaymentSaving(false)
    }
  }

  async function handleCancelSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || !order || cancelSaving) return
    if (cancelReason.trim().length > 1000) {
      setActionError('A justificativa pode ter até 1.000 caracteres.')
      return
    }
    setCancelSaving(true)
    setActionError(null)
    try {
      const { error: rpcError } = await supabaseClient.rpc('cancel_order', {
        p_business_id: businessId,
        p_order_id: order.id,
        p_reason: cancelReason.trim() || null,
      })
      if (rpcError) {
        setActionError('Não foi possível cancelar o pedido. Atualize o histórico e tente novamente.')
        await loadDetail(false)
        return
      }
      setShowCancelForm(false)
      setNotice('Pedido cancelado. O histórico foi preservado.')
      await loadDetail(false)
    } catch {
      setActionError('Não foi possível confirmar o cancelamento. Atualize o histórico para conferir o estado do pedido.')
    } finally {
      setCancelSaving(false)
    }
  }

  async function handleDeleteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || !order || deleteSaving) return
    setDeleteSaving(true)
    setActionError(null)
    try {
      const { error: rpcError } = await supabaseClient.rpc('delete_unfulfilled_order', {
        p_business_id: businessId,
        p_order_id: order.id,
      })
      if (rpcError) {
        setActionError(rpcError.message.includes('order_delete_has_side_effects')
          ? 'Este pedido já tem pagamento, movimentação de estoque, entrega avançada ou vínculo com atendimento. Ele foi preservado; use o cancelamento quando permitido.'
          : 'Não foi possível excluir o pedido. Atualize o histórico e tente novamente.')
        await loadDetail(false)
        return
      }
      navigate('/pedidos', { replace: true, state: { successMessage: 'Pedido excluído.' } })
    } catch {
      setActionError('Não consegui confirmar a exclusão. Volte à lista de pedidos e confira se ele ainda aparece antes de tentar novamente.')
    } finally {
      setDeleteSaving(false)
    }
  }

  if (loading) return <p className="inline-state" aria-live="polite">Carregando pedido…</p>
  if (error || !order) {
    return (
      <div className="page-stack">
        <Link className="quiet-link" to="/pedidos">← Voltar para pedidos</Link>
        <div className="inline-state inline-state-error" role="alert">
          {locationState?.successMessage && <p className="form-message form-message-success" role="status">{locationState.successMessage}</p>}
          <p>{error ?? 'Este pedido não está disponível.'}</p>
          <button className="text-button" onClick={() => void loadDetail()} type="button">Tentar novamente</button>
        </div>
      </div>
    )
  }

  return (
    <div className="page-stack">
      <Link className="quiet-link" to="/pedidos">← Voltar para pedidos</Link>
      <header className="page-heading">
        <div><p className="eyebrow">PEDIDO · {order.status === 'cancelled' ? 'CANCELADO' : outstandingCents > 0 ? 'EM ABERTO' : 'RECEBIDO'}</p><h1 ref={orderHeadingRef} tabIndex={-1}>{order.customer_name_snapshot}</h1><p className="page-description">Criado em {formatOrderTimestamp(order.created_at)}</p></div>
        <div className="record-heading-actions">
          {order.status === 'open' && <Link className="button button-secondary" to={`/pedidos/novo?origem=${encodeURIComponent(order.id)}`}>Criar pedido parecido</Link>}
          {order.status === 'open' && outstandingCents > 0 && <button className="button button-primary" onClick={startPayment} type="button"><Icon name="coin" /> Registrar recebimento</button>}
          {order.status === 'open' && payments.length === 0 && !pickupEvent && <button className="button button-secondary order-cancel-trigger" onClick={() => { setShowCancelForm((current) => !current); setActionError(null) }} type="button">{showCancelForm ? 'Fechar cancelamento' : 'Cancelar pedido'}</button>}
          {deleteEligible && <button className="button button-secondary order-delete-trigger" disabled={deleteSaving} onClick={() => { setShowDeleteForm((current) => !current); setActionError(null) }} type="button">{showDeleteForm ? 'Fechar exclusão' : 'Excluir pedido'}</button>}
        </div>
      </header>

      {notice && <p className="form-message form-message-success" role="status">{notice}</p>}
      {actionError && <div className="form-message form-message-error" role="alert"><p>{actionError}</p><button className="text-button" onClick={() => void loadDetail(false)} type="button">Atualizar histórico</button></div>}

      <section className="order-balance-grid" aria-label="Resumo financeiro do pedido">
        <article className="surface-panel order-balance-card"><span>Total do pedido</span><strong>{formatBRL(order.total_cents)}</strong><small>Inclui itens, taxa de entrega e desconto informados.</small></article>
        <article className="surface-panel order-balance-card"><span>Recebido</span><strong>{formatBRL(receivedCents)}</strong><small>Registros manuais associados ao pedido.</small></article>
        <article className="surface-panel order-balance-card"><span>{order.status === 'open' ? 'Falta receber' : 'Valor após cancelamento'}</span><strong>{formatBRL(outstandingCents)}</strong><small>{order.status === 'open' ? 'Valor ainda não pago pelo cliente.' : 'Este pedido está cancelado.'}</small></article>
      </section>

      {showCancelForm && order.status === 'open' && payments.length === 0 && !pickupEvent && (
        <form className="surface-panel record-form" onSubmit={handleCancelSubmit}>
          <p className="eyebrow">CANCELAMENTO</p><h2>Confirmar cancelamento</h2>
          <p className="section-footnote">Um pedido com qualquer recebimento não pode ser cancelado nesta etapa. O registro será preservado no histórico.</p>
          <label className="record-field"><span className="field-label">Motivo <span className="field-optional">opcional</span></span><textarea className="text-input record-textarea" disabled={cancelSaving} maxLength={1000} onChange={(event) => setCancelReason(event.target.value)} rows={2} value={cancelReason} /></label>
          <div className="record-form-actions"><button className="button button-secondary order-cancel-confirm" disabled={cancelSaving} type="submit">{cancelSaving ? 'Cancelando…' : 'Confirmar cancelamento'}</button><button className="text-button" disabled={cancelSaving} onClick={() => setShowCancelForm(false)} type="button">Manter pedido</button></div>
        </form>
      )}

      {showDeleteForm && deleteEligible && (
        <form className="surface-panel record-form order-delete-form" onSubmit={handleDeleteSubmit}>
          <p className="eyebrow">EXCLUSÃO DEFINITIVA</p><h2>Apagar este pedido?</h2>
          <p className="section-footnote">O pedido e os registros de planejamento serão removidos. Só é permitido apagar antes de haver pagamento, baixa de estoque, retirada, entrega avançada ou vínculo com atendimento/WhatsApp.</p>
          <div className="record-form-actions"><button className="button button-secondary order-delete-confirm" disabled={deleteSaving} type="submit">{deleteSaving ? 'Excluindo…' : 'Apagar pedido definitivamente'}</button><button className="text-button" disabled={deleteSaving} onClick={() => setShowDeleteForm(false)} type="button">Manter pedido</button></div>
        </form>
      )}

      {showPaymentForm && order.status === 'open' && (
        <form className="surface-panel record-form" onSubmit={handlePaymentSubmit}>
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">RECEBIMENTO MANUAL</p><h2>Registrar valor recebido</h2></div><button className="text-button" disabled={paymentSaving || paymentUncertain} onClick={closePaymentForm} type="button">Fechar</button></div>
          <p className="section-footnote order-payment-hint">Este registro anota um recebimento informado por você. Não processa o pagamento. A sugestão abaixo é editável e não salva nada até você confirmar o recebimento.</p>
          <div className="record-form-grid">
            <label className="record-field"><span className="field-label">Valor recebido <span aria-hidden="true">*</span></span><input className="text-input" disabled={paymentSaving || paymentUncertain} inputMode="decimal" onChange={(event) => setPaymentAmount(event.target.value)} placeholder="0,00" ref={paymentAmountInputRef} value={paymentAmount} /></label>
            <label className="record-field"><span className="field-label">Recebido em <span className="field-optional">Horário de Brasília; em branco = agora</span></span><input className="text-input" disabled={paymentSaving || paymentUncertain} onChange={(event) => setReceivedAt(event.target.value)} type="datetime-local" value={receivedAt} /></label>
            <label className="record-field"><span className="field-label">Forma informada <span className="field-optional">texto opcional</span></span><input className="text-input" disabled={paymentSaving || paymentUncertain} maxLength={64} onChange={(event) => setPaymentMethod(event.target.value)} placeholder="Ex.: Pix, dinheiro, transferência" value={paymentMethod} /></label>
            <label className="record-field"><span className="field-label">Observações <span className="field-optional">opcional</span></span><input className="text-input" disabled={paymentSaving || paymentUncertain} maxLength={1000} onChange={(event) => setPaymentNotes(event.target.value)} value={paymentNotes} /></label>
          </div>
          <div className="order-allocation-panel">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">DESTINAÇÃO DO RECEBIMENTO</p><h3>Como o valor se distribui</h3></div><span className="neutral-status">{formatBRL(selectedAllocationTotal)}</span></div>
          <button className="button button-secondary" disabled={paymentSaving || paymentUncertain} onClick={suggestOldestFirstAllocation} type="button">Sugerir por vencimento, mais antigas primeiro</button>
            {installments.map((installment) => {
              const balance = installment.amount_cents - (paidByInstallment.get(installment.id) ?? 0)
              if (balance <= 0) return null
              return <label className="order-allocation-row" key={installment.id}>
                <span><strong>Vencimento {installment.installment_number}</strong><small>{formatBusinessDate(installment.due_on)} · saldo {formatBRL(balance)}</small></span>
                <span className="order-allocation-input"><span className="visually-hidden">Valor destinado ao vencimento {installment.installment_number}</span><input className="text-input" disabled={paymentSaving || paymentUncertain} inputMode="decimal" onChange={(event) => setAllocationDraft((current) => ({ ...current, [installment.id]: event.target.value }))} placeholder="0,00" value={allocationDraft[installment.id] ?? ''} /></span>
              </label>
            })}
            <p className={`order-schedule-total ${allocationComplete ? 'order-schedule-match' : ''}`} aria-live="polite">
              Valor recebido: <strong>{parsedPaymentAmount !== null && !Number.isNaN(parsedPaymentAmount) ? formatBRL(parsedPaymentAmount) : '—'}</strong> · Distribuído: <strong>{formatBRL(selectedAllocationTotal)}</strong>
              {allocationDifference !== null && allocationDifference > 0 && <> · Faltam <strong>{formatBRL(allocationDifference)}</strong> para distribuir</>}
              {allocationDifference !== null && allocationDifference < 0 && <> · Distribuído excede o recebido em <strong>{formatBRL(Math.abs(allocationDifference))}</strong></>}
              {allocationComplete && <> · Distribuição completa</>}
            </p>
          </div>
          {paymentError && <p className="form-message form-message-error" role="alert">{paymentError}</p>}
          <div className="record-form-actions"><button className="button button-primary" disabled={paymentSaving} type="submit">{paymentSaving ? 'Registrando…' : paymentUncertain ? 'Tentar novamente sem alterar os dados' : 'Salvar recebimento'}</button><button className="text-button" disabled={paymentSaving || paymentUncertain} onClick={closePaymentForm} type="button">Descartar</button></div>
        </form>
      )}

      {order.status === 'cancelled' && <p className="form-message form-message-warning" role="status">Cancelado{order.cancelled_at ? ` em ${formatOrderTimestamp(order.cancelled_at)}` : ''}{order.cancellation_reason ? ` · ${order.cancellation_reason}` : ''}</p>}

      {!order.requires_delivery && <section className="surface-panel record-panel order-pickup-panel" aria-labelledby="order-pickup-heading">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">RETIRADA PELO CLIENTE</p><h2 id="order-pickup-heading">Entrega ao cliente</h2></div>{pickupEvent && <span className="delivery-status delivery-status-delivered">Retirada registrada</span>}</div>
        {pickupEvent ? <>
          <p className="section-footnote">Registrada em {formatOrderTimestamp(pickupEvent.occurred_at, true)}. Os produtos com estoque configurado foram baixados; o evento não entrou na fila de entregas.</p>
          {pickupEvent.stock_warnings.length > 0 && <div className="form-message form-message-warning" role="status"><strong>Estoque abaixo de zero após a retirada:</strong><ul>{pickupEvent.stock_warnings.map((warning) => <li key={warning.product_id}>{warning.product_name}: {formatQuantity(warning.quantity_on_hand)} {warning.inventory_unit}.</li>)}</ul></div>}
        </> : order.status === 'open' ? <>
          <p className="section-footnote">Este pedido não foi marcado para entrega e não aparece na fila. Registre a retirada quando o cliente receber os produtos; o estoque baixa nesse momento.</p>
          <button className="button button-primary" disabled={pickupPreviewLoading} onClick={() => void startPickup()} type="button"><Icon name="box" /> Registrar retirada pelo cliente</button>
        </> : <p className="section-footnote">Pedido cancelado; não há retirada registrada.</p>}
      </section>}

      {showPickupForm && order.status === 'open' && !order.requires_delivery && !pickupEvent && <form className="surface-panel record-form" onSubmit={(event) => void handlePickupSubmit(event)}>
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">CONFIRMAÇÃO DE ENTREGA</p><h2 ref={pickupHeadingRef} tabIndex={-1}>Registrar retirada pelo cliente</h2></div><button className="text-button" disabled={pickupSaving || pickupPreviewLoading} onClick={closePickupForm} type="button">Fechar</button></div>
        <p className="section-footnote">A confirmação baixa do estoque somente os itens com controle configurado. Confira as quantidades e os saldos atuais antes de concluir.</p>
        {pickupPreviewLoading ? <p className="inline-state" aria-live="polite">Conferindo saldo atual…</p> : null}
        {!pickupPreviewLoading && pickupPreviewReady && pickupPreviewItems.length === 0 && <p className="section-footnote">Este pedido não contém itens com estoque configurado. A retirada será registrada no histórico sem movimentação de estoque.</p>}
        {!pickupPreviewLoading && pickupPreviewReady && pickupPreviewItems.length > 0 && <ul className="pickup-stock-preview" aria-label="Itens controlados e saldos previstos">
          {pickupPreviewItems.map((item) => <li className={item.projected < 0 ? 'pickup-stock-short' : ''} key={item.product_id}><span><strong>{item.product_name}</strong><small>Disponível {formatQuantity(item.available)} {item.inventory_unit} · quantidade do pedido {formatQuantity(item.needed)} {item.inventory_unit}</small></span><span><small>Após a retirada</small><strong>{formatQuantity(item.projected)} {item.inventory_unit}</strong></span></li>)}
        </ul>}
        {!pickupPreviewLoading && pickupPreviewReady && pickupPreviewItems.length > 0 && pickupWarnings.length === 0 && <p className="form-message form-message-success" role="status">Os saldos consultados cobrem as quantidades controladas. A operação final será conferida novamente e ficará no histórico.</p>}
        {!pickupPreviewLoading && pickupPreviewReady && pickupWarnings.length > 0 && <div className="form-message form-message-warning" role="status"><strong>Não há estoque suficiente para esta retirada.</strong><span>A retirada pode continuar; a quantidade ficará abaixo de zero e o aviso será registrado. O estoque pode mudar antes da confirmação.</span></div>}
        {pickupError && <p className="form-message form-message-error" role="alert">{pickupError}</p>}
        <div className="record-form-actions">{!pickupPreviewReady && !pickupPreviewLoading && <button className="button button-secondary" disabled={pickupSaving} onClick={() => void previewPickupStock()} type="button">Conferir estoque novamente</button>}<button className="button button-primary" disabled={pickupSaving || pickupPreviewLoading || !pickupPreviewReady} type="submit">{pickupSaving ? 'Registrando…' : pickupUncertain ? 'Tentar novamente sem alterar a ação' : pickupWarnings.length > 0 ? 'Confirmar retirada mesmo sem estoque suficiente' : 'Confirmar retirada e atualizar estoque'}</button><button className="text-button" disabled={pickupSaving || pickupPreviewLoading} onClick={closePickupForm} type="button">Manter pedido</button></div>
      </form>}

      {order.requires_delivery && <section className="surface-panel record-panel order-delivery-panel" aria-labelledby="order-delivery-heading">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">LOGÍSTICA</p><h2 id="order-delivery-heading">Entrega vinculada</h2></div>{delivery && <span className="delivery-status">{delivery.canceled_at ? 'Cancelada com o pedido' : deliveryStatusLabels[delivery.status]}</span>}</div>
        {!delivery ? <p className="form-message form-message-warning" role="status">Este pedido foi marcado para entrega, mas não há registro de entrega carregado. Atualize o histórico antes de continuar.</p> : <>
          <dl className="customer-facts order-address-facts"><div><dt>Endereço</dt><dd>{order.delivery_address_snapshot || 'Não informado'}</dd></div><div><dt>Entregador</dt><dd>{deliveryWorkerName || 'Sem atribuição'}</dd></div><div><dt>Agendamento</dt><dd>{delivery.scheduled_on ? formatBusinessDate(delivery.scheduled_on) + (delivery.time_window ? ' · ' + delivery.time_window : '') : 'Sem data ou horário definido'}</dd></div><div><dt>Observações da entrega</dt><dd>{delivery.notes || 'Nenhuma observação'}</dd></div></dl>
          <div className="record-form-actions"><Link className="button button-secondary" to="/entregas">Abrir fila de entregas</Link>{delivery.dispatched_at && <span className="section-footnote">Despachado em {formatOrderTimestamp(delivery.dispatched_at, true)}</span>}{delivery.delivered_at && <span className="section-footnote">Concluído em {formatOrderTimestamp(delivery.delivered_at, true)}</span>}</div>
          {deliveryEvents.length > 0 && <ul className="timeline-list order-delivery-history">{deliveryEvents.map((event) => <li key={event.id}><span className="timeline-dot" /><div><strong>{event.event_type === 'created' ? 'Entrega criada' : event.event_type === 'plan_updated' ? 'Horário ou entregador atualizado' : (event.from_status ? deliveryStatusLabels[event.from_status] + ' → ' : '') + deliveryStatusLabels[event.to_status]}</strong><p>{formatOrderTimestamp(event.occurred_at, true)}</p>{event.note && <p>{event.note}</p>}{event.next_step && <p>Próximo passo: {event.next_step}</p>}{event.stock_warnings.length > 0 && <p className="delivery-stock-warning">Estoque abaixo de zero após o despacho: {event.stock_warnings.map((warning) => warning.product_name + ' (' + formatQuantity(warning.quantity_on_hand) + ' ' + warning.inventory_unit + ')').join(' · ')}.</p>}</div></li>)}</ul>}
        </>}
      </section>}

      <div className="record-detail-grid order-detail-grid">
        <section className="surface-panel record-panel" aria-labelledby="order-lines-heading">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">FOTOGRAFIA DO PEDIDO</p><h2 id="order-lines-heading">Produtos registrados</h2></div></div>
          {lines.length === 0 ? <p className="inline-state">Nenhum item foi encontrado neste pedido.</p> : <ul className="order-detail-lines">
            {lines.map((line) => {
              const components = componentsByLine.get(line.id) ?? []
              const comboComponents = components.filter((component) => component.product_id !== line.product_id)
              return <li key={line.id}>
              <span><strong>{line.product_name_snapshot}</strong><small>{formatQuantity(line.quantity)}{line.inventory_unit_snapshot ? ` ${line.inventory_unit_snapshot}` : ''} × {formatBRL(line.unit_price_snapshot_cents)}</small>{comboComponents.length > 0 && <small>Composição registrada: {comboComponents.map((component) => formatQuantity(component.quantity_snapshot) + (component.inventory_unit_snapshot ? ' ' + component.inventory_unit_snapshot : '') + ' ' + component.product_name_snapshot).join(' · ')}</small>}</span>
              <strong>{formatBRL(line.line_total_cents)}</strong>
            </li>
            })}
          </ul>}
          <dl className="order-total-list order-detail-totals">
            <div><dt>Subtotal</dt><dd>{formatBRL(order.subtotal_cents)}</dd></div>
            <div><dt>Taxa de entrega</dt><dd>{formatBRL(order.delivery_fee_cents)}</dd></div>
            <div><dt>Desconto</dt><dd>− {formatBRL(order.discount_cents)}</dd></div>
            <div className="order-total-grand"><dt>Total</dt><dd>{formatBRL(order.total_cents)}</dd></div>
          </dl>
          <dl className="customer-facts order-address-facts"><div><dt>Cliente</dt><dd><Link to={`/clientes/${order.customer_id}`}>{order.customer_name_snapshot}</Link></dd></div><div><dt>Endereço deste pedido</dt><dd>{order.delivery_address_snapshot || 'Não informado'}</dd></div><div><dt>Observações</dt><dd>{order.notes || 'Nenhuma observação'}</dd></div></dl>
        </section>

        <section className="surface-panel record-panel" aria-labelledby="order-installments-detail-heading">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">PRAZOS INFORMADOS</p><h2 id="order-installments-detail-heading">Vencimentos</h2></div></div>
          {installments.length === 0 ? <p className="inline-state">Nenhum vencimento registrado.</p> : <ul className="order-installment-list">
            {installments.map((installment) => {
              const paid = paidByInstallment.get(installment.id) ?? 0
              const balance = order.status === 'cancelled' ? 0 : installment.amount_cents - paid
              const overdue = order.status === 'open' && balance > 0 && installment.due_on < today
              return <li key={installment.id}>
                <span className="order-installment-number">{installment.installment_number}</span>
                <span className="order-installment-copy"><strong>{formatBusinessDate(installment.due_on)}</strong><small>{overdue ? 'Atrasado · ' : ''}{installment.payment_method || 'Forma não informada'}</small></span>
                <span className="order-installment-values"><strong>{formatBRL(installment.amount_cents)}</strong><small>{order.status === 'cancelled' ? 'Pedido cancelado · sem pagamento pendente' : `Pago ${formatBRL(paid)} · falta receber ${formatBRL(balance)}`}</small></span>
              </li>
            })}
          </ul>}
        </section>
      </div>

      <section className="surface-panel record-panel" aria-labelledby="order-payments-heading">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">HISTÓRICO FINANCEIRO</p><h2 id="order-payments-heading">Recebimentos registrados</h2></div><span className="neutral-status">{payments.length}</span></div>
        {payments.length === 0 ? <p className="inline-state">Nenhum recebimento manual registrado.</p> : <ul className="timeline-list order-payment-history">
          {payments.map((payment) => {
            const paymentAllocations = allocations.filter((allocation) => allocation.payment_id === payment.id)
            return <li key={payment.id}><span className="timeline-dot" /><div>
              <strong>{formatBRL(payment.amount_cents)} · {formatOrderTimestamp(payment.received_at, true)}</strong>
              <p>{payment.payment_method || 'Forma não informada'}{payment.notes ? ` · ${payment.notes}` : ''}</p>
              <p>Destinado: {paymentAllocations.map((allocation) => {
                const installment = installments.find((candidate) => candidate.id === allocation.installment_id)
                return `${installment ? `vencimento ${installment.installment_number}` : 'vencimento'} ${formatBRL(allocation.amount_cents)}`
              }).join(' · ') || 'Nenhuma destinação encontrada'}</p>
            </div></li>
          })}
        </ul>}
      </section>

      <section className="surface-panel record-panel" aria-labelledby="order-events-heading">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">HISTÓRICO</p><h2 id="order-events-heading">Eventos do pedido</h2></div></div>
        {events.length === 0 ? <p className="inline-state">Nenhum evento registrado.</p> : <ul className="timeline-list">
          {events.map((event) => <li key={event.id}><span className="timeline-dot" /><div><strong>{event.event_type === 'created' ? 'Pedido criado' : event.event_type === 'picked_up' ? 'Retirada pelo cliente registrada' : 'Pedido cancelado'}</strong><p>{formatOrderTimestamp(event.occurred_at, true)}</p>{event.reason && <p>{event.reason}</p>}{event.event_type === 'picked_up' && event.stock_warnings.length > 0 && <p className="delivery-stock-warning">Estoque abaixo de zero após a retirada: {event.stock_warnings.map((warning) => warning.product_name + ' (' + formatQuantity(warning.quantity_on_hand) + ' ' + warning.inventory_unit + ')').join(' · ')}.</p>}</div></li>)}
        </ul>}
      </section>
    </div>
  )
}
