import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { businessToday, currentTimestamp, formatBRL, formatBusinessDate } from '../lib/formatters'
import { supabaseClient } from '../lib/supabase'

type Customer = {
  id: string
  name: string
  phone: string | null
  delivery_address: string | null
  notes: string | null
  is_active: boolean
}

type Interaction = {
  id: string
  related_order_id: string | null
  interaction_type: 'call' | 'note' | 'whatsapp_manual' | 'other'
  direction: 'incoming' | 'outgoing' | 'not_applicable'
  call_outcome: 'answered' | 'missed' | 'other' | null
  outcome: string | null
  notes: string | null
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
  const [interactionType, setInteractionType] = useState<Interaction['interaction_type']>('call')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [interactionError, setInteractionError] = useState<string | null>(null)
  const ordersById = new Map(orders.map((order) => [order.id, order]))
  const customerDataIsCurrent = loadedCustomerScope === customerScope
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

  useLayoutEffect(() => {
    activeCustomerScopeRef.current = customerScope
  }, [customerScope])

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
          .select('id, name, phone, delivery_address, notes, is_active')
          .eq('business_id', businessId).eq('id', customerId).maybeSingle(),
        client.from('customer_interactions')
          .select('id, related_order_id, interaction_type, direction, call_outcome, outcome, notes, occurred_at')
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
        setOrderError(orderLoadFailed ? 'Não foi possível carregar todos os pedidos. Você ainda pode registrar o contato sem vínculo ou tentar carregar novamente.' : null)
        setOrderHistoryError(orderHistoryFailed ? 'Não foi possível carregar pedidos, parcelas e saldos completos. Os valores indisponíveis não serão tratados como zero.' : null)
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
          setOrderHistoryError('Não foi possível carregar pedidos, parcelas e saldos completos. Os valores indisponíveis não serão tratados como zero.')
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
    if (!name) {
      setFormError('Informe o nome do cliente.')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const { error: updateError } = await supabaseClient.from('customers')
        .update({
          name,
          phone: String(form.get('phone') ?? '').trim() || null,
          delivery_address: String(form.get('delivery_address') ?? '').trim() || null,
          notes: String(form.get('notes') ?? '').trim() || null,
        })
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

  async function handleCreateInteraction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || !customer) return
    const form = new FormData(event.currentTarget)
    const nextAction = String(form.get('follow_up_title') ?? '').trim()
    const dueOn = String(form.get('follow_up_due_on') ?? '').trim()
    const type = String(form.get('interaction_type')) as Interaction['interaction_type']
    const callOutcome = type === 'call' ? String(form.get('call_outcome') ?? '') : null
    if (callOutcome !== 'missed' && Boolean(nextAction) !== Boolean(dueOn)) {
      setInteractionError('Preencha o próximo passo e a data juntos, ou deixe os dois em branco.')
      return
    }

    setSaving(true)
    setInteractionError(null)
    try {
      const { error: insertError } = await supabaseClient.rpc('record_customer_interaction_with_order', {
        p_business_id: businessId,
        p_customer_id: customer.id,
        p_interaction_type: type,
        p_direction: String(form.get('direction')),
        p_call_outcome: callOutcome || null,
        p_outcome: null,
        p_notes: String(form.get('notes') ?? '').trim() || null,
        p_occurred_at: String(form.get('occurred_at') ?? '').trim()
          ? new Date(String(form.get('occurred_at'))).toISOString()
          : currentTimestamp(),
        p_follow_up_title: nextAction || null,
        p_follow_up_due_on: dueOn || null,
        p_follow_up_priority: String(form.get('priority') ?? '').trim() || null,
        p_related_order_id: String(form.get('related_order_id') ?? '').trim() || null,
      })
      if (insertError) {
        setInteractionError('Não foi possível registrar o contato e o retorno. Seus dados continuam no formulário; tente novamente.')
        return
      }
      setInteractionOpen(false)
      await loadCustomer()
    } catch {
      setInteractionError('Não foi possível registrar o contato e o retorno. Seus dados continuam no formulário; tente novamente.')
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

  return (
    <div className="page-stack">
      <Link className="quiet-link" to="/clientes">← Voltar para clientes</Link>
      <header className="page-heading">
        <div>
          <p className="eyebrow">CLIENTE</p>
          <h1>{customer.name}</h1>
          <p className="page-description">{customer.phone || 'Telefone não informado'}{customer.is_active ? '' : ' · Cadastro arquivado'}</p>
        </div>
        <div className="record-heading-actions">
          {customer.is_active ? <>
            <Link className="button button-primary" to={`/pedidos/novo?cliente=${encodeURIComponent(customer.id)}`}><Icon name="bag" /> Novo pedido</Link>
            <button className="button button-secondary" onClick={() => { setEditOpen((value) => !value); setFormError(null) }} type="button">{editOpen ? 'Fechar edição' : 'Editar'}</button>
            <button className="button button-secondary" onClick={() => { setInteractionType('call'); setInteractionOpen((value) => !value); setInteractionError(null) }} type="button"><Icon name="plus" /> Registrar contato</button>
          </> : <button className="button button-primary" onClick={() => void handleReactivateCustomer()} type="button">Reativar cliente</button>}
        </div>
      </header>

      {editOpen && (
        <form className="surface-panel record-form" onSubmit={handleUpdateCustomer}>
          <h2>Dados do cliente</h2>
          <div className="record-form-grid">
            <label className="record-field record-field-wide"><span className="field-label">Nome *</span><input className="text-input" defaultValue={customer.name} maxLength={160} name="name" required /></label>
            <label className="record-field"><span className="field-label">Telefone <span className="field-optional">opcional</span></span><input className="text-input" defaultValue={customer.phone ?? ''} maxLength={64} name="phone" type="tel" /></label>
            <label className="record-field record-field-wide"><span className="field-label">Endereço de entrega <span className="field-optional">opcional</span></span><input className="text-input" defaultValue={customer.delivery_address ?? ''} maxLength={1000} name="delivery_address" /></label>
            <label className="record-field record-field-wide"><span className="field-label">Observações <span className="field-optional">opcional</span></span><textarea className="text-input record-textarea" defaultValue={customer.notes ?? ''} maxLength={4000} name="notes" rows={3} /></label>
          </div>
          {formError && <p className="form-message form-message-error" role="alert">{formError}</p>}
          <button className="button button-primary" disabled={saving} type="submit">{saving ? 'Salvando…' : 'Salvar alterações'}</button>
        </form>
      )}

      {interactionOpen && (
        <form className="surface-panel record-form" onSubmit={handleCreateInteraction}>
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">HISTÓRICO</p><h2>Registrar contato</h2></div></div>
          <div className="record-form-grid">
            <label className="record-field"><span className="field-label">Tipo de contato</span><select className="text-input" name="interaction_type" onChange={(event) => setInteractionType(event.target.value as Interaction['interaction_type'])} value={interactionType}><option value="call">Ligação (registro manual)</option><option value="whatsapp_manual">WhatsApp (anotação manual)</option><option value="note">Observação</option><option value="other">Outro contato</option></select></label>
            <label className="record-field"><span className="field-label">Direção</span><select className="text-input" name="direction"><option value="not_applicable">Não se aplica</option><option value="outgoing">Realizado pelo negócio</option><option value="incoming">Recebido do cliente</option></select></label>
            {interactionType === 'call' && <><label className="record-field"><span className="field-label">Resultado da ligação</span><select className="text-input" defaultValue="answered" name="call_outcome" required><option value="answered">Atendida</option><option value="missed">Não atendida</option><option value="other">Outro resultado</option></select></label><label className="record-field"><span className="field-label">Quando aconteceu <span className="field-optional">em branco = agora</span></span><input className="text-input" name="occurred_at" type="datetime-local" /></label></>}
            {interactionType !== 'call' && <label className="record-field"><span className="field-label">Quando aconteceu <span className="field-optional">em branco = agora</span></span><input className="text-input" name="occurred_at" type="datetime-local" /></label>}
            <label className="record-field record-field-wide"><span className="field-label">Pedido relacionado <span className="field-optional">opcional</span></span><select className="text-input" disabled={customerOrdersLoading || displayedOrders.length === 0} name="related_order_id"><option value="">{customerOrdersLoading ? 'Carregando pedidos…' : displayedOrderError && displayedOrders.length === 0 ? 'Pedidos indisponíveis' : 'Nenhum pedido'}</option>{displayedOrders.map((order) => <option key={order.id} value={order.id}>{orderLabel(order)}</option>)}</select></label>
            {displayedOrderError && <div className="form-message form-message-error record-field-wide" role="alert"><p>{displayedOrderError}</p><button className="text-button" disabled={loadingMoreOrders || saving} onClick={() => void loadCustomer()} type="button">Tentar novamente</button></div>}
            {displayedOrders.length === 0 && !displayedOrderError && !customerOrdersLoading && <p className="section-footnote record-field-wide">Este cliente ainda não tem pedidos para vincular.</p>}
            {customerHasMoreOrders && <button className="text-button record-field-wide" disabled={loadingMoreOrders || saving} onClick={() => void loadMoreOrders()} type="button">{loadingMoreOrders ? 'Carregando pedidos…' : 'Carregar mais pedidos'}</button>}
            {displayedMoreOrdersError && <div className="form-message form-message-error record-field-wide" role="alert"><p>{displayedMoreOrdersError}</p><button className="text-button" disabled={loadingMoreOrders || saving} onClick={() => void loadMoreOrders()} type="button">Tentar novamente</button></div>}
            <label className="record-field record-field-wide"><span className="field-label">Anotações <span className="field-optional">opcional</span></span><textarea className="text-input record-textarea" maxLength={4000} name="notes" rows={3} /></label>
            <label className="record-field record-field-wide"><span className="field-label">Próximo passo <span className="field-optional">opcional</span></span><input className="text-input" maxLength={240} name="follow_up_title" placeholder="Ex.: confirmar entrega" /></label>
            <label className="record-field"><span className="field-label">Data do retorno</span><input className="text-input" name="follow_up_due_on" type="date" /></label>
            <label className="record-field"><span className="field-label">Prioridade do retorno</span><select className="text-input" defaultValue="" name="priority"><option value="">Automática</option><option value="normal">Normal</option><option value="high">Alta</option><option value="low">Baixa</option></select></label>
          </div>
          <p className="section-footnote">O registro é manual. Uma ligação não atendida cria um retorno para hoje, com prioridade alta. Esta tela não lê chamadas nem conecta ao WhatsApp.</p>
          {interactionError && <p className="form-message form-message-error" role="alert">{interactionError}</p>}
          <button className="button button-primary" disabled={saving} type="submit">{saving ? 'Salvando…' : 'Salvar contato'}</button>
        </form>
      )}

      {displayedCustomerError && <p className="form-message form-message-error" role="alert">{displayedCustomerError}</p>}

      <div className="record-detail-grid">
        <section className="surface-panel record-panel" aria-labelledby="follow-up-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">PRÓXIMAS AÇÕES</p><h2 id="follow-up-title">Retornos pendentes</h2></div></div>
          {followUps.length === 0 ? <p className="inline-state">Nenhum retorno agendado para este cliente.</p> : (
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
            <div><dt>Observações</dt><dd>{customer.notes || 'Nenhuma observação cadastrada'}</dd></div>
          </dl>
          {customer.is_active && <button className="text-button archive-button" onClick={() => void handleArchiveCustomer()} type="button">Arquivar cliente</button>}
        </section>
      </div>

      <section className="surface-panel record-panel customer-order-history" aria-labelledby="customer-orders-heading">
        <div className="section-heading section-heading-compact">
          <div><p className="eyebrow">HISTÓRICO FINANCEIRO</p><h2 id="customer-orders-heading">Pedidos e parcelas</h2></div>
          <span className="neutral-status">{displayedPurchaseOrders.length} carregados</span>
        </div>
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
                    <div><dt>Saldo a receber</dt><dd>{financeAvailable ? formatBRL(order.outstanding_cents!) : 'Indisponível'}</dd></div>
                  </dl>
                  {order.installments && order.installments.length > 0 && (
                    <details className="customer-installment-details">
                      <summary>Ver parcelas ({order.installments.length})</summary>
                      <ul className="customer-installment-list">
                        {order.installments.map((installment) => (
                          <li key={installment.id}>
                            <div className="customer-installment-copy">
                              <strong>Parcela {installment.installment_number} · {formatBusinessDate(installment.due_on)}</strong>
                              <small className={installment.overdue ? 'customer-installment-overdue' : undefined}>{installment.overdue ? 'Vencida · ' : ''}{installment.payment_method || 'Forma não informada'}</small>
                            </div>
                            <div className="customer-installment-values">
                              <strong>{formatBRL(installment.amount_cents)}</strong>
                              <small>{order.status === 'cancelled' ? 'Cancelado · sem saldo a receber' : 'Recebido ' + formatBRL(installment.received_cents) + ' · saldo ' + formatBRL(installment.balance_cents)}</small>
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
      </section>

      <section className="surface-panel record-panel" aria-labelledby="interaction-title">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">HISTÓRICO</p><h2 id="interaction-title">Contatos registrados</h2></div><span className="neutral-status">{interactions.length}</span></div>
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
                    {interaction.notes && <p>{interaction.notes}</p>}
                    {interaction.related_order_id && <p><Link to={`/pedidos/${interaction.related_order_id}`}>Pedido relacionado · {relatedOrder ? orderLabel(relatedOrder) : 'abrir pedido'}</Link></p>}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
