import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { businessLocalDateTimeToIso, businessToday, currentTimestamp, formatBRL, formatBusinessDate } from '../lib/formatters'
import { supabaseClient } from '../lib/supabase'

type Customer = {
  id: string
  name: string
  phone: string | null
  whatsapp_phone: string | null
  delivery_address: string | null
  is_active: boolean
}

type CustomerAddress = { id: string; label: string; address: string; is_default: boolean }

type Interaction = {
  id: string
  related_order_id: string | null
  interaction_type: 'call' | 'note' | 'whatsapp_manual' | 'other'
  direction: 'incoming' | 'outgoing' | 'not_applicable'
  call_outcome: 'answered' | 'missed' | 'other' | null
  outcome: string | null
  occurred_at: string
}

type CustomerOrder = {
  id: string
  total_cents: number
  status: 'open' | 'cancelled'
  created_at: string
}

type CustomerInstallmentRecord = {
  id: string
  order_id: string
  installment_number: number
  amount_cents: number
  due_on: string
  payment_method: string | null
}

type CustomerInstallment = CustomerInstallmentRecord & {
  received_cents: number
  balance_cents: number
  overdue: boolean
}

type CustomerPaymentRecord = { id: string; order_id: string; amount_cents: number }
type CustomerAllocationRecord = { id: string; order_id: string; installment_id: string; amount_cents: number }

type CustomerOrderHistory = CustomerOrder & {
  received_cents: number | null
  outstanding_cents: number | null
  installments: CustomerInstallment[] | null
}

type FollowUp = {
  id: string
  title: string
  due_on: string
  priority: 'low' | 'normal' | 'high'
  status: 'pending' | 'completed' | 'cancelled'
}

const customerOrderPageSize = 50

const interactionLabels: Record<Interaction['interaction_type'], string> = {
  call: 'Ligação registrada manualmente',
  note: 'Observação',
  whatsapp_manual: 'WhatsApp · anotação manual',
  other: 'Outro contato',
}
const callOutcomeLabels = { answered: 'Atendida', missed: 'Não atendida', other: 'Outro resultado' }

function businessDateTimeInputValue() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`
}

function getWhatsAppChatUrl(value: string | null) {
  if (!value) return null
  const trimmed = value.trim()
  const digits = trimmed.replace(/\D/g, '')
  return trimmed.startsWith('+') && digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0')
    ? `https://wa.me/${digits}`
    : null
}

type PageResponse = { data: unknown[] | null; error: unknown | null }

async function loadAllPages<T>(loadPage: (from: number, to: number) => PromiseLike<PageResponse>) {
  const rows: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await loadPage(from, from + 999)
    if (error) return { data: null, error }
    const page = (data ?? []) as T[]
    rows.push(...page)
    if (page.length < 1000) return { data: rows, error: null }
  }
}

function withoutOrderFinancials(orders: CustomerOrder[]): CustomerOrderHistory[] {
  return orders.map((order) => ({ ...order, received_cents: null, outstanding_cents: null, installments: null }))
}

async function loadCustomerOrderHistory(
  client: NonNullable<typeof supabaseClient>,
  businessId: string,
  orders: CustomerOrder[],
  today: string,
): Promise<CustomerOrderHistory[]> {
  if (orders.length === 0) return []
  const orderIds = orders.map((order) => order.id)
  const [installmentsResult, paymentsResult, allocationsResult] = await Promise.all([
    loadAllPages<CustomerInstallmentRecord>((from, to) => client.from('order_installments')
      .select('id, order_id, installment_number, amount_cents, due_on, payment_method')
      .eq('business_id', businessId).in('order_id', orderIds)
      .order('order_id', { ascending: true }).order('installment_number', { ascending: true })
      .range(from, to)),
    loadAllPages<CustomerPaymentRecord>((from, to) => client.from('order_payments')
      .select('id, order_id, amount_cents')
      .eq('business_id', businessId).in('order_id', orderIds)
      .order('id', { ascending: true }).range(from, to)),
    loadAllPages<CustomerAllocationRecord>((from, to) => client.from('order_payment_allocations')
      .select('id, order_id, installment_id, amount_cents')
      .eq('business_id', businessId).in('order_id', orderIds)
      .order('id', { ascending: true }).range(from, to)),
  ])
  if (installmentsResult.error || paymentsResult.error || allocationsResult.error) {
    throw new Error('Could not load customer order balances.')
  }

  const receivedByOrder = new Map<string, number>()
  for (const payment of paymentsResult.data ?? []) {
    receivedByOrder.set(payment.order_id, (receivedByOrder.get(payment.order_id) ?? 0) + payment.amount_cents)
  }
  const receivedByInstallment = new Map<string, number>()
  for (const allocation of allocationsResult.data ?? []) {
    receivedByInstallment.set(allocation.installment_id, (receivedByInstallment.get(allocation.installment_id) ?? 0) + allocation.amount_cents)
  }
  const installmentsByOrder = new Map<string, CustomerInstallment[]>()
  for (const installment of installmentsResult.data ?? []) {
    const order = orders.find((candidate) => candidate.id === installment.order_id)
    const received = receivedByInstallment.get(installment.id) ?? 0
    const balance = order?.status === 'cancelled' ? 0 : Math.max(0, installment.amount_cents - received)
    const item: CustomerInstallment = {
      ...installment,
      received_cents: received,
      balance_cents: balance,
      overdue: order?.status === 'open' && balance > 0 && installment.due_on < today,
    }
    const rows = installmentsByOrder.get(installment.order_id) ?? []
    rows.push(item)
    installmentsByOrder.set(installment.order_id, rows)
  }

  return orders.map((order) => {
    const received = receivedByOrder.get(order.id) ?? 0
    return {
      ...order,
      received_cents: received,
      outstanding_cents: order.status === 'open' ? Math.max(0, order.total_cents - received) : 0,
      installments: installmentsByOrder.get(order.id) ?? [],
    }
  })
}

function mergeCustomerOrders(...groups: CustomerOrder[][]) {
  const byId = new Map(groups.flat().map((order) => [order.id, order]))
  return [...byId.values()].sort((left, right) =>
    right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
  )
}

function mergeCustomerOrderHistory(current: CustomerOrderHistory[], next: CustomerOrderHistory[]) {
  const byId = new Map(current.map((order) => [order.id, order]))
  for (const order of next) byId.set(order.id, order)
  return [...byId.values()].sort((left, right) =>
    right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
  )
}

function formatOrderDate(value: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'medium',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date(value))
}

function orderLabel(order: CustomerOrder) {
  const cancelled = order.status === 'cancelled' ? ' · cancelado' : ''
  return `Pedido de ${formatOrderDate(order.created_at)} · ${formatBRL(order.total_cents)}${cancelled}`
}

export function CustomerDetailPage() {
  const { customerId = '' } = useParams()
  const { id: businessId } = useBusiness()
  const today = businessToday()
  const customerScope = JSON.stringify([businessId, customerId])
  const activeCustomerScopeRef = useRef(customerScope)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [loadedCustomerScope, setLoadedCustomerScope] = useState<string | null>(null)
  const [orders, setOrders] = useState<CustomerOrder[]>([])
  const [ordersScope, setOrdersScope] = useState<string | null>(null)
  const [ordersLoading, setOrdersLoading] = useState(true)
  const [purchaseOrders, setPurchaseOrders] = useState<CustomerOrderHistory[]>([])
  const [purchaseOrdersScope, setPurchaseOrdersScope] = useState<string | null>(null)
  const [orderHistoryLoading, setOrderHistoryLoading] = useState(true)
  const [orderHistoryError, setOrderHistoryError] = useState<string | null>(null)
  const [orderPageOffset, setOrderPageOffset] = useState(0)
  const [hasMoreOrders, setHasMoreOrders] = useState(false)
  const [loadingMoreOrders, setLoadingMoreOrders] = useState(false)
  const [orderError, setOrderError] = useState<string | null>(null)
  const [moreOrdersError, setMoreOrdersError] = useState<string | null>(null)
  const [interactions, setInteractions] = useState<Interaction[]>([])
  const [followUps, setFollowUps] = useState<FollowUp[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [customerErrorScope, setCustomerErrorScope] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [interactionOpen, setInteractionOpen] = useState(false)
  const [interactionFormMode, setInteractionFormMode] = useState<'general' | 'missed_call'>('general')
  const [interactionType, setInteractionType] = useState<Interaction['interaction_type']>('call')
  const [interactionCallOutcome, setInteractionCallOutcome] = useState<NonNullable<Interaction['call_outcome']>>('answered')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [customerAddresses, setCustomerAddresses] = useState<CustomerAddress[]>([])
  const [loadedAddressesScope, setLoadedAddressesScope] = useState<string | null>(null)
  const [addressesLoading, setAddressesLoading] = useState(true)
  const [addressesError, setAddressesError] = useState<string | null>(null)
  const [addressFormOpen, setAddressFormOpen] = useState(false)
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null)
  const [addressLabelDraft, setAddressLabelDraft] = useState('')
  const [addressDraft, setAddressDraft] = useState('')
  const [addressSaving, setAddressSaving] = useState(false)
  const [addressActionError, setAddressActionError] = useState<string | null>(null)
  const [addressActionStatus, setAddressActionStatus] = useState<string | null>(null)
  const [addressNotice, setAddressNotice] = useState<string | null>(null)
  const [interactionError, setInteractionError] = useState<string | null>(null)
  const [interactionNotice, setInteractionNotice] = useState<string | null>(null)
  const ordersById = new Map(orders.map((order) => [order.id, order]))
  const customerHeadingRef = useRef<HTMLHeadingElement>(null)
  const interactionFormHeadingRef = useRef<HTMLHeadingElement>(null)
  const wasInteractionOpenRef = useRef(false)
  const customerDataIsCurrent = loadedCustomerScope === customerScope
  const customerAddressesAreCurrent = loadedAddressesScope === customerScope
  const displayedCustomerAddresses = customerAddressesAreCurrent ? customerAddresses : []
  const displayedCustomerError = customerErrorScope === customerScope ? error : null
  const customerOrdersAreCurrent = ordersScope === customerScope
  const displayedOrders = customerOrdersAreCurrent ? orders : []
  const displayedOrderError = customerOrdersAreCurrent ? orderError : null
  const displayedMoreOrdersError = customerOrdersAreCurrent ? moreOrdersError : null
  const customerOrdersLoading = !customerOrdersAreCurrent || ordersLoading
  const customerHasMoreOrders = customerOrdersAreCurrent && hasMoreOrders
  const purchaseOrdersAreCurrent = purchaseOrdersScope === customerScope
  const displayedPurchaseOrders = purchaseOrdersAreCurrent ? purchaseOrders : []
  const displayedOrderHistoryError = purchaseOrdersAreCurrent ? orderHistoryError : null
  const loadingMoreOrdersRef = useRef(false)
  const interactionRequestRef = useRef<{ payload: string; requestId: string; occurredAt: string } | null>(null)
  const addressRequestRef = useRef(0)

  useLayoutEffect(() => {
    activeCustomerScopeRef.current = customerScope
  }, [customerScope])

  useEffect(() => {
    if (interactionOpen && customerDataIsCurrent) {
      interactionFormHeadingRef.current?.focus()
    } else if (!interactionOpen && wasInteractionOpenRef.current && customerDataIsCurrent) {
      customerHeadingRef.current?.focus()
    }
    wasInteractionOpenRef.current = interactionOpen
  }, [interactionOpen, customerDataIsCurrent, customerScope])

  const loadCustomer = useCallback(async () => {
    const requestScope = JSON.stringify([businessId, customerId])
    const client = supabaseClient
    setCustomerErrorScope(requestScope)
    setError(null)
    if (!client) {
      setError('A conexão da empresa não está disponível.')
      setLoading(false)
      setOrdersLoading(false)
      setOrderHistoryLoading(false)
      return
    }
    setOrdersLoading(true)
    setOrderHistoryLoading(true)
    setOrderError(null)
    setOrderHistoryError(null)
    setMoreOrdersError(null)
    try {
      const [customerResult, interactionResult, followUpResult] = await Promise.all([
        client.from('customers')
          .select('id, name, phone, whatsapp_phone, delivery_address, is_active')
          .eq('business_id', businessId).eq('id', customerId).maybeSingle(),
        client.from('customer_interactions')
          .select('id, related_order_id, interaction_type, direction, call_outcome, outcome, occurred_at')
          .eq('business_id', businessId).eq('customer_id', customerId)
          .order('occurred_at', { ascending: false }),
        client.from('follow_up_tasks')
          .select('id, title, due_on, priority, status')
          .eq('business_id', businessId).eq('customer_id', customerId)
          .eq('status', 'pending').order('due_on', { ascending: true }),
      ])

      if (activeCustomerScopeRef.current !== requestScope) return
      if (customerResult.error || interactionResult.error || followUpResult.error) {
        setError('Não foi possível carregar o histórico deste cliente. Tente novamente.')
      } else if (!customerResult.data) {
        setError('Este cliente não está disponível.')
      } else {
        setCustomer(customerResult.data as Customer)
        setInteractions((interactionResult.data ?? []) as Interaction[])
        setFollowUps((followUpResult.data ?? []) as FollowUp[])
        setError(null)
        setLoadedCustomerScope(requestScope)
        setLoading(false)

        let recentOrders: CustomerOrder[] = []
        let linkedOrders: CustomerOrder[] = []
        let recentOrdersLoaded = false
        let orderLoadFailed = false

        try {
          const { data, error: orderQueryError } = await client.from('orders')
            .select('id, total_cents, status, created_at')
            .eq('business_id', businessId).eq('customer_id', customerId)
            .order('created_at', { ascending: false }).order('id', { ascending: false })
            .range(0, customerOrderPageSize - 1)
          if (orderQueryError) {
            orderLoadFailed = true
          } else {
            recentOrders = (data ?? []) as CustomerOrder[]
            recentOrdersLoaded = true
          }
        } catch {
          orderLoadFailed = true
        }

        const recentOrderIds = new Set(recentOrders.map((order) => order.id))
        const linkedOrderIds = [...new Set(((interactionResult.data ?? []) as Interaction[])
          .flatMap((interaction) => interaction.related_order_id ? [interaction.related_order_id] : []))]
          .filter((id) => !recentOrderIds.has(id))
        const relatedOrderChunks = Array.from(
          { length: Math.ceil(linkedOrderIds.length / customerOrderPageSize) },
          (_, index) => linkedOrderIds.slice(index * customerOrderPageSize, (index + 1) * customerOrderPageSize),
        )
        if (relatedOrderChunks.length > 0) {
          try {
            const relatedOrderResults = await Promise.all(relatedOrderChunks.map((orderIds) =>
              client.from('orders')
                .select('id, total_cents, status, created_at')
                .eq('business_id', businessId).eq('customer_id', customerId)
                .in('id', orderIds),
            ))
            if (relatedOrderResults.some((result) => result.error)) {
              orderLoadFailed = true
            } else {
              linkedOrders = relatedOrderResults.flatMap((result) => (result.data ?? []) as CustomerOrder[])
            }
          } catch {
            orderLoadFailed = true
          }
        }

        let recentOrderHistory = withoutOrderFinancials(recentOrders)
        let orderHistoryFailed = !recentOrdersLoaded
        if (recentOrdersLoaded) {
          try {
            recentOrderHistory = await loadCustomerOrderHistory(client, businessId, recentOrders, today)
          } catch {
            orderHistoryFailed = true
          }
        }

        if (activeCustomerScopeRef.current !== requestScope) return
        setOrders(mergeCustomerOrders(recentOrders, linkedOrders))
        setOrdersScope(requestScope)
        setPurchaseOrders(recentOrderHistory)
        setPurchaseOrdersScope(requestScope)
        setOrderPageOffset(recentOrders.length)
        setHasMoreOrders(recentOrdersLoaded && recentOrders.length === customerOrderPageSize)
        setOrderError(orderLoadFailed ? 'Não foi possível carregar todos os pedidos. Você ainda pode salvar o contato ou tentar de novo.' : null)
        setOrderHistoryError(orderHistoryFailed ? 'Não foi possível carregar todos os pedidos e pagamentos. Alguns valores podem estar faltando.' : null)
        setMoreOrdersError(null)
      }
    } catch {
      if (activeCustomerScopeRef.current === requestScope) {
        setError('Não foi possível carregar o histórico deste cliente. Tente novamente.')
      }
    } finally {
      if (activeCustomerScopeRef.current === requestScope) {
        setLoading(false)
        setOrdersLoading(false)
        setOrderHistoryLoading(false)
      }
    }
  }, [businessId, customerId, today])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadCustomer() }, [loadCustomer])

  const loadCustomerAddresses = useCallback(async () => {
    const requestId = ++addressRequestRef.current
    const requestScope = JSON.stringify([businessId, customerId])
    const client = supabaseClient
    setCustomerAddresses([])
    setLoadedAddressesScope(null)
    setAddressesLoading(true)
    setAddressesError(null)
    if (!client) {
      setCustomerAddresses([])
      setLoadedAddressesScope(requestScope)
      setAddressesError('A conexão da empresa não está disponível.')
      setAddressesLoading(false)
      return
    }
    try {
      const { data, error: queryError } = await client.from('customer_addresses')
        .select('id, label, address, is_default')
        .eq('business_id', businessId).eq('customer_id', customerId)
        .order('is_default', { ascending: false }).order('label', { ascending: true }).order('id', { ascending: true })
      if (requestId !== addressRequestRef.current || activeCustomerScopeRef.current !== requestScope) return
      if (queryError) {
        setCustomerAddresses([])
        setLoadedAddressesScope(requestScope)
        setAddressesError('Não foi possível carregar os endereços deste cliente. Tente novamente.')
      } else {
        setCustomerAddresses((data ?? []) as CustomerAddress[])
        setLoadedAddressesScope(requestScope)
        setAddressesError(null)
      }
    } catch {
      if (requestId === addressRequestRef.current && activeCustomerScopeRef.current === requestScope) {
        setCustomerAddresses([])
        setLoadedAddressesScope(requestScope)
        setAddressesError('Não foi possível carregar os endereços deste cliente. Tente novamente.')
      }
    } finally {
      if (requestId === addressRequestRef.current && activeCustomerScopeRef.current === requestScope) setAddressesLoading(false)
    }
  }, [businessId, customerId])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void loadCustomerAddresses()
    return () => { addressRequestRef.current += 1 }
  }, [loadCustomerAddresses])

  async function loadMoreOrders() {
    const requestScope = customerScope
    const client = supabaseClient
    if (!client || loadingMoreOrdersRef.current || !hasMoreOrders || ordersScope !== customerScope || ordersLoading) return
    loadingMoreOrdersRef.current = true
    setLoadingMoreOrders(true)
    setMoreOrdersError(null)
    try {
      const { data, error: orderError } = await client.from('orders')
        .select('id, total_cents, status, created_at')
        .eq('business_id', businessId).eq('customer_id', customerId)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .range(orderPageOffset, orderPageOffset + customerOrderPageSize - 1)
      if (activeCustomerScopeRef.current !== requestScope) return
      if (orderError) {
        setMoreOrdersError('Não foi possível carregar mais pedidos. Tente novamente.')
        return
      }
      const nextOrders = (data ?? []) as CustomerOrder[]
      let nextOrderHistory = withoutOrderFinancials(nextOrders)
      try {
        nextOrderHistory = await loadCustomerOrderHistory(client, businessId, nextOrders, today)
      } catch {
        if (activeCustomerScopeRef.current === requestScope) {
          setOrderHistoryError('Não foi possível carregar todos os pedidos e pagamentos. Alguns valores podem estar faltando.')
        }
      }
      if (activeCustomerScopeRef.current !== requestScope) return
      setOrders((current) => mergeCustomerOrders(current, nextOrders))
      setPurchaseOrders((current) => mergeCustomerOrderHistory(current, nextOrderHistory))
      setOrderPageOffset((current) => current + nextOrders.length)
      setHasMoreOrders(nextOrders.length === customerOrderPageSize)
    } catch {
      if (activeCustomerScopeRef.current === requestScope) {
        setMoreOrdersError('Não foi possível carregar mais pedidos. Tente novamente.')
      }
    } finally {
      loadingMoreOrdersRef.current = false
      setLoadingMoreOrders(false)
    }
  }

  async function handleUpdateCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || !customer) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const whatsappPhone = String(form.get('whatsapp_phone') ?? '').trim()
    if (!name) {
      setFormError('Informe o nome do cliente.')
      return
    }
    if (whatsappPhone && !getWhatsAppChatUrl(whatsappPhone)) {
      setFormError('Informe o número começando com + e o código do país, por exemplo +55 21 99999-0000.')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const updateValues = {
        name,
        phone: String(form.get('phone') ?? '').trim() || null,
        whatsapp_phone: whatsappPhone || null,
        ...(form.has('delivery_address') ? { delivery_address: String(form.get('delivery_address') ?? '').trim() || null } : {}),
      }
      const { error: updateError } = await supabaseClient.from('customers')
        .update(updateValues)
        .eq('business_id', businessId).eq('id', customer.id)
      if (updateError) {
        setFormError('Não foi possível salvar. Seus dados continuam no formulário; tente novamente.')
        return
      }
      setEditOpen(false)
      await loadCustomer()
    } catch {
      setFormError('Não foi possível salvar. Seus dados continuam no formulário; tente novamente.')
    } finally {
      setSaving(false)
    }
  }

  function openNewAddress() {
    setEditingAddressId(null)
    setAddressLabelDraft('')
    setAddressDraft('')
    setAddressActionError(null)
    setAddressActionStatus(null)
    setAddressNotice(null)
    setAddressFormOpen(true)
  }

  function openEditAddress(address: CustomerAddress) {
    setEditingAddressId(address.id)
    setAddressLabelDraft(address.label)
    setAddressDraft(address.address)
    setAddressActionError(null)
    setAddressActionStatus(null)
    setAddressNotice(null)
    setAddressFormOpen(true)
  }

  async function handleSaveAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || !customer) return
    const label = addressLabelDraft.trim()
    const address = addressDraft.trim()
    if (!label || label.length > 80 || !address || address.length > 1000) {
      setAddressActionError('Informe um nome de até 80 caracteres e um endereço de até 1.000 caracteres.')
      return
    }
    setAddressSaving(true)
    setAddressActionError(null)
    setAddressNotice(null)
    try {
      let duplicateAlreadyExists = false
      if (editingAddressId) {
        const result = await supabaseClient.from('customer_addresses').update({ label, address })
          .eq('business_id', businessId).eq('customer_id', customer.id).eq('id', editingAddressId).select('id').maybeSingle()
        if (result.error || !result.data) {
          setAddressActionError('Não foi possível salvar. Os dados continuam no formulário; tente novamente.')
          return
        }
      } else {
        const result = await supabaseClient.from('customer_addresses').insert({ business_id: businessId, customer_id: customer.id, label, address })
          .select('id').maybeSingle()
        if (result.error || !result.data) {
          // If the insert committed but its response was lost, the unique key
          // lets a retry find the same row instead of inserting a duplicate.
          const { data: existing, error: lookupError } = await supabaseClient.from('customer_addresses')
            .select('id').eq('business_id', businessId).eq('customer_id', customer.id)
            .eq('label', label).eq('address', address).maybeSingle()
          if (lookupError || !existing) {
            setAddressActionError('Não foi possível salvar. Os dados continuam no formulário; tente novamente.')
            return
          }
          duplicateAlreadyExists = true
        }
      }
      setAddressFormOpen(false)
      setEditingAddressId(null)
      setAddressNotice(editingAddressId ? 'Endereço atualizado.' : duplicateAlreadyExists ? 'Este endereço já estava salvo; mantive apenas um registro.' : 'Endereço adicionado.')
      await loadCustomerAddresses()
    } catch {
      setAddressActionError('Não foi possível salvar. Os dados continuam no formulário; tente novamente.')
    } finally {
      setAddressSaving(false)
    }
  }

  async function handleSetPrimaryAddress(address: CustomerAddress) {
    if (!supabaseClient || !customer || address.is_default || addressSaving) return
    setAddressSaving(true)
    setAddressActionError(null)
    setAddressNotice(null)
    setAddressActionStatus(`Definindo “${address.label}” como principal…`)
    try {
      const { data, error: updateError } = await supabaseClient.from('customer_addresses')
        .update({ is_default: true })
        .eq('business_id', businessId).eq('customer_id', customer.id).eq('id', address.id)
        .select('id').maybeSingle()
      if (updateError || !data) {
        setAddressActionStatus(null)
        setAddressActionError('Não foi possível definir o endereço principal. Tente novamente.')
        return
      }
      setAddressActionStatus(null)
      setAddressNotice(`${address.label} agora é o endereço principal.`)
      await loadCustomerAddresses()
    } catch {
      setAddressActionStatus(null)
      setAddressActionError('Não foi possível definir o endereço principal. Tente novamente.')
    } finally {
      setAddressSaving(false)
    }
  }

  async function handleDeleteAddress(address: CustomerAddress) {
    if (!supabaseClient || !customer || addressSaving) return
    if (!window.confirm(`Remover o endereço “${address.label}”? Se ele for o principal, o endereço mais antigo restante será promovido automaticamente. Endereços registrados em pedidos anteriores serão preservados.`)) return
    setAddressSaving(true)
    setAddressActionError(null)
    setAddressNotice(null)
    setAddressActionStatus(`Removendo “${address.label}”…`)
    try {
      const { data, error: deleteError } = await supabaseClient.from('customer_addresses')
        .delete().eq('business_id', businessId).eq('customer_id', customer.id).eq('id', address.id)
        .select('id').maybeSingle()
      let removalConfirmed = Boolean(data && !deleteError)
      if (!removalConfirmed) {
        const { data: remainingAddress, error: confirmationError } = await supabaseClient.from('customer_addresses')
          .select('id').eq('business_id', businessId).eq('customer_id', customer.id).eq('id', address.id).maybeSingle()
        removalConfirmed = !confirmationError && !remainingAddress
      }
      if (!removalConfirmed) {
        setAddressActionStatus(null)
        setAddressActionError('Não foi possível remover o endereço. Tente novamente.')
        return
      }
      setAddressFormOpen(false)
      setEditingAddressId(null)
      setAddressActionStatus(null)
      setAddressNotice('Endereço removido. Os endereços dos pedidos anteriores foram preservados.')
      await loadCustomerAddresses()
    } catch {
      setAddressActionStatus(null)
      setAddressActionError('Não foi possível remover o endereço. Tente novamente.')
    } finally {
      setAddressSaving(false)
    }
  }

  async function handleArchiveCustomer() {
    if (!supabaseClient || !customer) return
    if (!window.confirm(`Arquivar ${customer.name}? O cadastro deixa de aparecer na lista de clientes ativos, mas o histórico será preservado.`)) return
    try {
      const { error: archiveError } = await supabaseClient.from('customers')
        .update({ is_active: false })
        .eq('business_id', businessId).eq('id', customer.id)
      if (archiveError) {
        setError('Não foi possível arquivar o cliente. Tente novamente.')
        return
      }
    setCustomer({ ...customer, is_active: false })
    setEditOpen(false)
    setInteractionOpen(false)
    } catch {
      setError('Não foi possível arquivar o cliente. Tente novamente.')
    }
  }

  async function handleReactivateCustomer() {
    if (!supabaseClient || !customer) return
    try {
      const { error: updateError } = await supabaseClient.from('customers')
        .update({ is_active: true })
        .eq('business_id', businessId).eq('id', customer.id)
      if (updateError) {
        setError('Não foi possível reativar o cliente. Tente novamente.')
        return
      }
      await loadCustomer()
    } catch {
      setError('Não foi possível reativar o cliente. Tente novamente.')
    }
  }

  function openGeneralInteraction() {
    if (interactionOpen) {
      setInteractionOpen(false)
      return
    }
    setInteractionFormMode('general')
    setInteractionType('call')
    setInteractionCallOutcome('answered')
    setInteractionError(null)
    setInteractionNotice(null)
    setInteractionOpen(true)
  }

  function openMissedCallInteraction() {
    setInteractionFormMode('missed_call')
    setInteractionType('call')
    setInteractionCallOutcome('missed')
    setInteractionError(null)
    setInteractionNotice(null)
    setInteractionOpen(true)
  }

  async function handleCreateInteraction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || !customer) return
    const form = new FormData(event.currentTarget)
    const nextAction = String(form.get('follow_up_title') ?? '').trim()
    const dueOn = String(form.get('follow_up_due_on') ?? '').trim()
    const type = String(form.get('interaction_type')) as Interaction['interaction_type']
    const callOutcome = type === 'call' ? String(form.get('call_outcome') ?? '') : null
    const occurredAtInput = String(form.get('occurred_at') ?? '').trim()
    if (callOutcome !== 'missed' && Boolean(nextAction) !== Boolean(dueOn)) {
      setInteractionError('Preencha o próximo passo e a data juntos, ou deixe os dois em branco.')
      return
    }

    const requestInput = {
      p_business_id: businessId,
      p_customer_id: customer.id,
      p_interaction_type: type,
      p_direction: String(form.get('direction')),
      p_call_outcome: callOutcome || null,
      p_outcome: null,
      p_notes: null,
      p_follow_up_title: nextAction || null,
      p_follow_up_due_on: dueOn || null,
      p_follow_up_priority: String(form.get('priority') ?? '').trim() || null,
      p_related_order_id: String(form.get('related_order_id') ?? '').trim() || null,
    }
    const requestPayload = JSON.stringify({ ...requestInput, occurred_at_input: occurredAtInput })
    let interactionRequest = interactionRequestRef.current
    if (!interactionRequest || interactionRequest.payload !== requestPayload) {
      const occurredAt = occurredAtInput ? businessLocalDateTimeToIso(occurredAtInput) : currentTimestamp()
      if (!occurredAt) {
        setInteractionError('Confira a data e o horário do contato.')
        return
      }
      interactionRequest = { payload: requestPayload, requestId: crypto.randomUUID(), occurredAt }
      interactionRequestRef.current = interactionRequest
    }
    const requestArgs = { ...requestInput, p_occurred_at: interactionRequest.occurredAt }

    setSaving(true)
    setInteractionError(null)
    try {
      let insertError = (await supabaseClient.rpc('record_customer_interaction_with_order_idempotent', {
        ...requestArgs,
        p_request_id: interactionRequest.requestId,
      })).error
      if (insertError?.code === 'PGRST202') {
        insertError = (await supabaseClient.rpc('record_customer_interaction_with_order', requestArgs)).error
      }
      if (insertError) {
        setInteractionError('Não foi possível salvar o contato e o lembrete. Seus dados continuam no formulário; tente de novo.')
        return
      }
      interactionRequestRef.current = null
      setInteractionNotice(interactionFormMode === 'missed_call'
        ? 'Ligação não atendida registrada. Um lembrete para hoje entrou na fila.'
        : 'Contato registrado.')
      setInteractionOpen(false)
      await loadCustomer()
    } catch {
      setInteractionError('Não foi possível salvar o contato e o lembrete. Seus dados continuam no formulário; tente de novo.')
    } finally {
      setSaving(false)
    }
  }

  if ((loading || !customerDataIsCurrent) && !displayedCustomerError) return <p className="inline-state" aria-live="polite">Carregando cliente…</p>
  if (displayedCustomerError || !customer) {
    return (
      <div className="page-stack">
        <Link className="quiet-link" to="/clientes">← Voltar para clientes</Link>
        <div className="inline-state inline-state-error" role="alert">
          <p>{displayedCustomerError ?? 'Cliente não encontrado.'}</p>
          <button className="text-button" onClick={() => { setLoading(true); void loadCustomer() }} type="button">Tentar novamente</button>
        </div>
      </div>
    )
  }

  const whatsappChatUrl = getWhatsAppChatUrl(customer.whatsapp_phone)

  return (
    <div className="page-stack">
      <Link className="quiet-link" to="/clientes">← Voltar para clientes</Link>
      <header className="page-heading">
        <div>
          <p className="eyebrow">CLIENTE</p>
          <h1 className="customer-detail-heading" ref={customerHeadingRef} tabIndex={-1}>{customer.name}</h1>
          <p className="page-description">{customer.phone ? `Telefone: ${customer.phone}` : 'Telefone não informado'}{customer.whatsapp_phone ? ` · WhatsApp: ${customer.whatsapp_phone}` : ''}{customer.is_active ? '' : ' · Cadastro arquivado'}</p>
        </div>
        <div className="record-heading-actions customer-heading-actions">
          {whatsappChatUrl && <a aria-label={`Abrir conversa no WhatsApp com ${customer.name}`} className="button button-secondary" href={whatsappChatUrl} rel="noopener noreferrer" target="_blank"><Icon name="message" /> Abrir WhatsApp</a>}
          {customer.is_active ? <>
            <Link className="button button-primary" to={`/pedidos/novo?cliente=${encodeURIComponent(customer.id)}`}><Icon name="bag" /> Novo pedido</Link>
            <button className="button button-secondary" onClick={() => { setEditOpen((opening) => !opening); setFormError(null) }} type="button">{editOpen ? 'Fechar edição' : 'Editar'}</button>
            <button className="button button-secondary" disabled={saving} onClick={openGeneralInteraction} type="button">{interactionOpen ? 'Fechar contato' : <><Icon name="plus" /> Registrar contato</>}</button>
            {!interactionOpen && <button className="button button-secondary" onClick={openMissedCallInteraction} type="button">Ligação não atendida</button>}
          </> : <button className="button button-primary" onClick={() => void handleReactivateCustomer()} type="button">Reativar cliente</button>}
        </div>
      </header>

      {interactionNotice && <p className="form-message form-message-success" role="status">{interactionNotice}</p>}

      {editOpen && (
        <form className="surface-panel record-form" onSubmit={handleUpdateCustomer}>
          <h2>Dados do cliente</h2>
          <div className="record-form-grid">
            <label className="record-field record-field-wide"><span className="field-label">Nome *</span><input className="text-input" defaultValue={customer.name} maxLength={160} name="name" required /></label>
            <label className="record-field"><span className="field-label">Telefone <span className="field-optional">opcional</span></span><input className="text-input" defaultValue={customer.phone ?? ''} maxLength={64} name="phone" type="tel" /></label>
            <label className="record-field"><span className="field-label">WhatsApp <span className="field-optional">opcional</span></span><input autoComplete="tel" className="text-input" defaultValue={customer.whatsapp_phone ?? ''} maxLength={64} name="whatsapp_phone" placeholder="+55 21 99999-0000" type="tel" /><span className="customer-whatsapp-hint">Use +55 e DDD no Brasil; para outros países, informe + e o DDI.</span></label>
            {addressesError && <label className="record-field record-field-wide"><span className="field-label">Endereço principal <span className="field-optional">modo compatível</span></span><input autoComplete="street-address" className="text-input" defaultValue={customer.delivery_address ?? ''} maxLength={1000} name="delivery_address" /><span className="customer-whatsapp-hint">A lista de endereços está indisponível. Você ainda pode editar o endereço principal por aqui.</span></label>}
          </div>
          {formError && <p className="form-message form-message-error" role="alert">{formError}</p>}
          <button className="button button-primary" disabled={saving} type="submit">{saving ? 'Salvando…' : 'Salvar alterações'}</button>
        </form>
      )}

      <section className="surface-panel record-panel" aria-labelledby="customer-addresses-heading">
        <div className="section-heading section-heading-compact">
          <div><p className="eyebrow">ENTREGA</p><h2 id="customer-addresses-heading">Endereços</h2></div>
          {customer.is_active && <button className="button button-secondary" disabled={addressesLoading || Boolean(addressesError) || addressSaving} onClick={openNewAddress} type="button"><Icon name="plus" /> Adicionar endereço</button>}
        </div>
        <p className="section-footnote">O endereço principal é sugerido nos novos pedidos. Cada pedido guarda o endereço confirmado no momento.</p>
        {addressNotice && <p className="form-message form-message-success" role="status">{addressNotice}</p>}
        {addressActionStatus && <p className="form-message" role="status">{addressActionStatus}</p>}
        {addressActionError && <p className="form-message form-message-error" role="alert">{addressActionError}</p>}
        {!customerAddressesAreCurrent || addressesLoading ? <p className="inline-state" aria-live="polite">Carregando endereços…</p>
          : addressesError ? <div className="inline-state inline-state-error" role="alert"><p>{addressesError}</p><button className="text-button" onClick={() => void loadCustomerAddresses()} type="button">Tentar novamente</button></div>
            : displayedCustomerAddresses.length === 0 ? <p className="inline-state">Nenhum endereço salvo. Você pode informar um endereço diretamente ao criar o pedido.</p>
              : <ul className="record-list customer-address-list">{displayedCustomerAddresses.map((address) => <li key={address.id}>
                <div className="record-list-link">
                  <div className="record-list-copy"><strong>{address.label}</strong><small title={address.address}>{address.address}</small></div>
                  {address.is_default && <span className="neutral-status">Principal</span>}
                  {customer.is_active && <div className="record-heading-actions">
                    {!address.is_default && <button className="text-button" disabled={addressSaving} onClick={() => void handleSetPrimaryAddress(address)} type="button">Tornar principal</button>}
                    <button className="text-button" disabled={addressSaving} onClick={() => openEditAddress(address)} type="button">Editar</button>
                    <button className="text-button archive-button" disabled={addressSaving} onClick={() => void handleDeleteAddress(address)} type="button">Remover</button>
                  </div>}
                </div>
              </li>)}</ul>}
        {addressFormOpen && customer.is_active && <form className="record-form" onSubmit={handleSaveAddress}>
          <h3>{editingAddressId ? 'Editar endereço' : 'Novo endereço'}</h3>
          <div className="record-form-grid">
            <label className="record-field"><span className="field-label">Nome do endereço *</span><input autoFocus className="text-input" disabled={addressSaving} maxLength={80} onChange={(event) => setAddressLabelDraft(event.target.value)} placeholder="Casa, trabalho…" required value={addressLabelDraft} /></label>
            <label className="record-field record-field-wide"><span className="field-label">Endereço completo *</span><textarea autoComplete="street-address" className="text-input record-textarea" disabled={addressSaving} maxLength={1000} onChange={(event) => setAddressDraft(event.target.value)} placeholder="Rua, número, bairro, cidade e complemento" required rows={2} value={addressDraft} /></label>
          </div>
          <div className="record-form-actions">
            <button className="button button-primary" disabled={addressSaving} type="submit">{addressSaving ? 'Salvando…' : editingAddressId ? 'Salvar endereço' : 'Adicionar endereço'}</button>
            <button className="button button-secondary" disabled={addressSaving} onClick={() => { setAddressFormOpen(false); setEditingAddressId(null); setAddressActionError(null) }} type="button">Cancelar</button>
          </div>
        </form>}
      </section>

      {interactionOpen && (
        <form className="surface-panel record-form" onSubmit={handleCreateInteraction}>
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">HISTÓRICO</p><h2 className="customer-interaction-form-heading" ref={interactionFormHeadingRef} tabIndex={-1}>{interactionFormMode === 'missed_call' ? 'Registrar ligação não atendida' : 'Registrar contato'}</h2></div></div>
          <div className="record-form-grid">
            {interactionFormMode === 'missed_call'
              ? <><input name="interaction_type" type="hidden" value="call" /><input name="call_outcome" type="hidden" value="missed" /></>
              : <label className="record-field"><span className="field-label">Tipo de contato</span><select className="text-input" name="interaction_type" onChange={(event) => setInteractionType(event.target.value as Interaction['interaction_type'])} value={interactionType}><option value="call">Ligação (registro manual)</option><option value="whatsapp_manual">WhatsApp</option><option value="other">Outro contato</option></select></label>}
            <label className="record-field"><span className="field-label">Direção</span><select className="text-input" name="direction"><option value="not_applicable">Não se aplica</option><option value="outgoing">Realizado pelo negócio</option><option value="incoming">Recebido do cliente</option></select></label>
            {interactionFormMode === 'general' && interactionType === 'call' && <label className="record-field"><span className="field-label">Resultado da ligação</span><select className="text-input" name="call_outcome" onChange={(event) => setInteractionCallOutcome(event.target.value as NonNullable<Interaction['call_outcome']>)} required value={interactionCallOutcome}><option value="answered">Atendida</option><option value="missed">Não atendida</option><option value="other">Outro resultado</option></select></label>}
            <label className="record-field"><span className="field-label">Quando aconteceu <span className="field-optional">padrão: agora · horário de Brasília · alterável</span></span><input className="text-input" defaultValue={businessDateTimeInputValue()} name="occurred_at" type="datetime-local" /></label>
            <label className="record-field record-field-wide"><span className="field-label">Pedido relacionado <span className="field-optional">opcional</span></span><select className="text-input" disabled={customerOrdersLoading || displayedOrders.length === 0} name="related_order_id"><option value="">{customerOrdersLoading ? 'Carregando pedidos…' : displayedOrderError && displayedOrders.length === 0 ? 'Pedidos indisponíveis' : 'Nenhum pedido'}</option>{displayedOrders.map((order) => <option key={order.id} value={order.id}>{orderLabel(order)}</option>)}</select></label>
            {displayedOrderError && <div className="form-message form-message-error record-field-wide" role="alert"><p>{displayedOrderError}</p><button className="text-button" disabled={loadingMoreOrders || saving} onClick={() => void loadCustomer()} type="button">Tentar novamente</button></div>}
            {customerHasMoreOrders && <button className="text-button record-field-wide" disabled={loadingMoreOrders || saving} onClick={() => void loadMoreOrders()} type="button">{loadingMoreOrders ? 'Carregando pedidos…' : 'Carregar mais pedidos'}</button>}
            {displayedMoreOrdersError && <div className="form-message form-message-error record-field-wide" role="alert"><p>{displayedMoreOrdersError}</p><button className="text-button" disabled={loadingMoreOrders || saving} onClick={() => void loadMoreOrders()} type="button">Tentar novamente</button></div>}
            {interactionFormMode === 'general' && <>
              <label className="record-field record-field-wide"><span className="field-label">Próximo passo <span className="field-optional">opcional</span></span><input className="text-input" maxLength={240} name="follow_up_title" placeholder="Ex.: confirmar entrega" /></label>
              <label className="record-field"><span className="field-label">Lembrar em <span className="field-optional">padrão: hoje</span></span><input className="text-input" defaultValue={businessToday()} name="follow_up_due_on" type="date" /></label>
              <label className="record-field"><span className="field-label">Importância</span><select className="text-input" defaultValue="" name="priority"><option value="">Automática</option><option value="normal">Normal</option><option value="high">Alta</option><option value="low">Baixa</option></select></label>
            </>}
          </div>
          <p className="section-footnote">{interactionFormMode === 'missed_call' ? 'Ao salvar, um lembrete para hoje entra na fila. A ligação é registrada manualmente.' : 'Uma ligação não atendida cria um lembrete para hoje. O atalho abre o WhatsApp, mas não envia mensagens.'}</p>
          {interactionError && <p className="form-message form-message-error" role="alert">{interactionError}</p>}
          <button className="button button-primary" disabled={saving} type="submit">{saving ? 'Salvando…' : interactionFormMode === 'missed_call' ? 'Salvar ligação e lembrete' : 'Salvar contato'}</button>
        </form>
      )}

      {displayedCustomerError && <p className="form-message form-message-error" role="alert">{displayedCustomerError}</p>}

      <div className="record-detail-grid">
        <section className="surface-panel record-panel" aria-labelledby="follow-up-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">PRÓXIMAS AÇÕES</p><h2 id="follow-up-title">Lembretes</h2></div></div>
          {followUps.length === 0 ? <p className="inline-state">Nenhum lembrete para este cliente.</p> : (
            <ul className="timeline-list">
              {followUps.map((task) => <li key={task.id}><span className="timeline-dot" /><div><strong>{task.title}</strong><p>Até {formatBusinessDate(task.due_on)} · Prioridade {task.priority === 'high' ? 'alta' : task.priority === 'low' ? 'baixa' : 'normal'}</p></div></li>)}
            </ul>
          )}
          <Link className="quiet-link" to="/atendimento">Abrir fila de atendimento <Icon name="arrow" /></Link>
        </section>
        <section className="surface-panel record-panel" aria-labelledby="customer-actions-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">CADASTRO</p><h2 id="customer-actions-title">Informações</h2></div></div>
          <dl className="customer-facts">
            <div><dt>Endereço</dt><dd>{customer.delivery_address || 'Não informado'}</dd></div>
          </dl>
          {customer.is_active && <button className="text-button archive-button" onClick={() => void handleArchiveCustomer()} type="button">Arquivar cliente</button>}
        </section>
      </div>

      <details className="surface-panel dashboard-trend-details customer-order-history">
        <summary>Ver pedidos e parcelas <span>{displayedPurchaseOrders.length} carregados</span></summary>
        <div className="customer-order-history-content">
        {displayedOrderHistoryError && <div className="form-message form-message-error" role="alert"><p>{displayedOrderHistoryError}</p><button className="text-button" disabled={orderHistoryLoading} onClick={() => void loadCustomer()} type="button">Tentar novamente</button></div>}
        {!purchaseOrdersAreCurrent || orderHistoryLoading ? <p className="inline-state" aria-live="polite">Carregando pedidos e parcelas…</p> : displayedPurchaseOrders.length === 0 ? displayedOrderHistoryError ? null : <p className="inline-state">Este cliente ainda não tem pedidos registrados.</p> : (
          <div className="customer-order-list">
            {displayedPurchaseOrders.map((order) => {
              const financeAvailable = order.received_cents !== null && order.outstanding_cents !== null
              const statusLabel = order.status === 'cancelled'
                ? 'Cancelado'
                : financeAvailable
                  ? order.outstanding_cents! > 0 ? 'Em aberto' : 'Recebido'
                  : 'Financeiro indisponível'
              const statusClass = order.status === 'cancelled'
                ? 'order-status-cancelled'
                : financeAvailable
                  ? order.outstanding_cents! > 0 ? 'order-status-open' : 'order-status-received'
                  : 'order-status-unavailable'
              return (
                <article className="customer-order-card" key={order.id}>
                  <div className="customer-order-card-heading">
                    <Link to={'/pedidos/' + order.id}>{orderLabel(order)}</Link>
                    <span className={'order-status ' + statusClass}>{statusLabel}</span>
                  </div>
                  <dl className="customer-order-values">
                    <div><dt>Total do pedido</dt><dd>{formatBRL(order.total_cents)}</dd></div>
                    <div><dt>Recebido</dt><dd>{financeAvailable ? formatBRL(order.received_cents!) : 'Indisponível'}</dd></div>
                    <div><dt>Falta receber</dt><dd>{financeAvailable ? formatBRL(order.outstanding_cents!) : 'Indisponível'}</dd></div>
                  </dl>
                  {order.installments && order.installments.length > 0 && (
                    <details className="customer-installment-details">
                      <summary>Ver parcelas ({order.installments.length})</summary>
                      <ul className="customer-installment-list">
                        {order.installments.map((installment) => (
                          <li key={installment.id}>
                            <div className="customer-installment-copy">
                              <strong>Parcela {installment.installment_number} · {formatBusinessDate(installment.due_on)}</strong>
                              <small className={installment.overdue ? 'customer-installment-overdue' : undefined}>{installment.overdue ? 'Atrasada · ' : ''}{installment.payment_method || 'Forma não informada'}</small>
                            </div>
                            <div className="customer-installment-values">
                              <strong>{formatBRL(installment.amount_cents)}</strong>
                              <small>{order.status === 'cancelled' ? 'Pedido cancelado · sem pagamento pendente' : 'Pago ' + formatBRL(installment.received_cents) + ' · falta receber ' + formatBRL(installment.balance_cents)}</small>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {order.installments?.length === 0 && <p className="customer-order-no-installments">Nenhuma parcela registrada.</p>}
                </article>
              )
            })}
          </div>
        )}
        {displayedMoreOrdersError && <div className="form-message form-message-error" role="alert"><p>{displayedMoreOrdersError}</p><button className="text-button" disabled={loadingMoreOrders} onClick={() => void loadMoreOrders()} type="button">Tentar novamente</button></div>}
        {customerHasMoreOrders && <button className="button button-secondary customer-order-more" disabled={loadingMoreOrders} onClick={() => void loadMoreOrders()} type="button">{loadingMoreOrders ? 'Carregando pedidos…' : 'Carregar mais pedidos'}</button>}
        </div>
      </details>

      <details className="surface-panel dashboard-trend-details customer-interaction-history">
        <summary>Ver contatos registrados <span>{interactions.length}</span></summary>
        {interactions.length === 0 ? <p className="inline-state">Nenhum contato registrado ainda.</p> : (
          <ul className="timeline-list">
            {interactions.map((interaction) => {
              const relatedOrder = interaction.related_order_id ? ordersById.get(interaction.related_order_id) : undefined
              return (
                <li key={interaction.id}>
                  <span className="timeline-dot" />
                  <div><strong>{interactionLabels[interaction.interaction_type]}</strong><p>{new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(interaction.occurred_at))}</p>
                    {interaction.direction !== 'not_applicable' && <p>{interaction.direction === 'incoming' ? 'Recebido' : 'Realizado pelo negócio'}</p>}
                    {interaction.call_outcome && <p><strong>Resultado da ligação:</strong> {callOutcomeLabels[interaction.call_outcome]}</p>}
                    {interaction.outcome && <p><strong>Resultado:</strong> {interaction.outcome}</p>}
                    {interaction.related_order_id && <p><Link to={`/pedidos/${interaction.related_order_id}`}>Pedido relacionado · {relatedOrder ? orderLabel(relatedOrder) : 'abrir pedido'}</Link></p>}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </details>
    </div>
  )
}
