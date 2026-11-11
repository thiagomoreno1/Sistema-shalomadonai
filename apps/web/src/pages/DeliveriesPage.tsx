import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { businessToday, formatBusinessDate } from '../lib/formatters'
import { supabaseClient } from '../lib/supabase'

type DeliveryStatus = 'awaiting_separation' | 'ready' | 'dispatched' | 'delivered' | 'attempted' | 'rescheduled' | 'returned'
type Delivery = { id: string; order_id: string; status: DeliveryStatus; delivery_worker_id: string | null; scheduled_on: string | null; time_window: string | null; notes: string | null; canceled_at: string | null; dispatched_at: string | null; delivered_at: string | null; attempted_at: string | null; returned_at: string | null; created_at: string }
type Order = { id: string; customer_id: string; customer_name_snapshot: string; delivery_address_snapshot: string | null; status: 'open' | 'cancelled'; delivery_fee_cents: number; created_at: string }
type Worker = { id: string; name: string; phone: string | null; is_active: boolean; user_id: string | null }
type OrderComponent = { order_id: string; product_id: string; product_name_snapshot: string; inventory_unit_snapshot: string | null; quantity_snapshot: number; inventory_tracked_snapshot: boolean }
type InventoryMovement = { order_id: string | null; product_id: string; movement_type: string; quantity_delta: number }
type Balance = { product_id: string; quantity_on_hand: number; inventory_unit: string }
type StockWarning = { product_id: string; product_name: string; inventory_unit: string; quantity_on_hand: number }
type DeliveryEvent = { id: string; delivery_id: string; event_type: 'created' | 'plan_updated' | 'status_changed'; from_status: DeliveryStatus | null; to_status: DeliveryStatus; delivery_worker_id: string | null; scheduled_on: string | null; time_window: string | null; note: string | null; next_step: string | null; stock_warnings: StockWarning[]; occurred_at: string }
type Filter = 'pending' | 'all' | DeliveryStatus

const statusLabels: Record<DeliveryStatus, string> = {
  awaiting_separation: 'Aguardando separação',
  ready: 'Pronta para despacho',
  dispatched: 'Em rota',
  delivered: 'Entregue',
  attempted: 'Entrega não concluída',
  rescheduled: 'Reagendada',
  returned: 'Devolvida',
}

const statusOrder: DeliveryStatus[] = ['awaiting_separation', 'ready', 'dispatched', 'attempted', 'rescheduled', 'delivered', 'returned']
const pendingDeliveryStatuses: DeliveryStatus[] = ['awaiting_separation', 'ready', 'dispatched', 'attempted', 'rescheduled']
const DELIVERY_PAGE_SIZE = 40
const deliveryWindowPresets = ['Manhã', '13h–15h', '15h–17h', '17h–19h']
const failedDeliveryPresets = [
  { label: 'Cliente ausente', note: 'Cliente não estava disponível no endereço.', nextStep: 'Entrar em contato e combinar novo horário.' },
  { label: 'Endereço não localizado', note: 'Não foi possível localizar o endereço informado.', nextStep: 'Pedir confirmação do endereço antes de reagendar.' },
  { label: 'Cliente pediu reagendamento', note: 'Cliente solicitou reagendamento durante a tentativa.', nextStep: 'Confirmar novo dia e período com o cliente.' },
]

function newRequestId() { return crypto.randomUUID() }
function formatQuantity(value: number) { return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(Number(value)) }
function timestamp(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value))
}
function statusActions(status: DeliveryStatus): DeliveryStatus[] {
  if (status === 'awaiting_separation') return ['ready']
  if (status === 'ready') return ['dispatched', 'awaiting_separation']
  if (status === 'dispatched') return ['delivered', 'attempted']
  if (status === 'attempted') return ['rescheduled', 'returned']
  if (status === 'rescheduled') return ['ready']
  return []
}

export function DeliveriesPage() {
  const { id: businessId } = useBusiness()
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [workers, setWorkers] = useState<Worker[]>([])
  const [components, setComponents] = useState<OrderComponent[]>([])
  const [movements, setMovements] = useState<InventoryMovement[]>([])
  const [balances, setBalances] = useState<Balance[]>([])
  const [events, setEvents] = useState<DeliveryEvent[]>([])
  const [eventsLoadedIds, setEventsLoadedIds] = useState<Set<string>>(new Set())
  const [eventLoadingIds, setEventLoadingIds] = useState<Set<string>>(new Set())
  const [eventErrorIds, setEventErrorIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const nextOffsetRef = useRef(0)
  const [pendingTotal, setPendingTotal] = useState(0)
  const [filteredTotal, setFilteredTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('pending')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null)
  const [planWorkerId, setPlanWorkerId] = useState('')
  const [planDate, setPlanDate] = useState('')
  const [planScheduleEnabled, setPlanScheduleEnabled] = useState(false)
  const [planWindow, setPlanWindow] = useState('')
  const [planNotes, setPlanNotes] = useState('')
  const [planSaving, setPlanSaving] = useState(false)
  const [planUncertain, setPlanUncertain] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [statusTarget, setStatusTarget] = useState<{ deliveryId: string; status: DeliveryStatus } | null>(null)
  const [statusNote, setStatusNote] = useState('')
  const [nextStep, setNextStep] = useState('')
  const [statusSaving, setStatusSaving] = useState(false)
  const [statusUncertain, setStatusUncertain] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [dispatchWarnings, setDispatchWarnings] = useState<Array<{ name: string; unit: string; available: number; needed: number; projected: number }>>([])
  const planRequestIdRef = useRef(newRequestId())
  const statusRequestIdsRef = useRef(new Map<string, string>())
  const formReturnFocusRef = useRef<HTMLElement | null>(null)
  const planHeadingRef = useRef<HTMLHeadingElement>(null)
  const statusHeadingRef = useRef<HTMLHeadingElement>(null)
  const queueHeadingRef = useRef<HTMLHeadingElement>(null)
  const wasPlanOpenRef = useRef(false)
  const wasStatusOpenRef = useRef(false)

  const loadQueue = useCallback(async (append = false, requestedFilter: Filter = filter) => {
    if (!supabaseClient) {
      setError('A conexão da empresa não está disponível.')
      setLoading(false)
      return false
    }
    if (append) setLoadingMore(true)
    else setLoading(true)
    try {
      const offset = append ? nextOffsetRef.current : 0
      let deliveryQuery = supabaseClient.from('deliveries')
        .select('id, order_id, status, delivery_worker_id, scheduled_on, time_window, notes, canceled_at, dispatched_at, delivered_at, attempted_at, returned_at, created_at, order:orders!inner(status)', { count: 'exact' })
        .eq('business_id', businessId)
        .eq('order.status', 'open')
        .is('canceled_at', null)
        .order('scheduled_on', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false })
      if (requestedFilter === 'pending') deliveryQuery = deliveryQuery.in('status', pendingDeliveryStatuses)
      else if (requestedFilter !== 'all') deliveryQuery = deliveryQuery.eq('status', requestedFilter)
      const deliveryResult = await deliveryQuery.range(offset, offset + DELIVERY_PAGE_SIZE - 1)
      if (deliveryResult.error) {
        setError('Não foi possível carregar a fila de entregas. Tente novamente.')
        return false
      }
      const deliveryRows = (deliveryResult.data ?? []) as Delivery[]
      const total = deliveryResult.count ?? offset + deliveryRows.length
      setFilteredTotal(total)
      setHasMore(offset + deliveryRows.length < total)
      nextOffsetRef.current = offset + deliveryRows.length

      if (!append) {
        const [workerResult, balanceResult, pendingCountResult] = await Promise.all([
          supabaseClient.from('delivery_workers').select('id, name, phone, is_active, user_id')
            .eq('business_id', businessId).eq('member_type', 'delivery_driver').order('is_active', { ascending: false }).order('name', { ascending: true }),
          supabaseClient.from('inventory_balances').select('product_id, quantity_on_hand, inventory_unit').eq('business_id', businessId),
          supabaseClient.from('deliveries').select('id, order:orders!inner(status)', { count: 'exact', head: true })
            .eq('business_id', businessId).eq('order.status', 'open').is('canceled_at', null).in('status', pendingDeliveryStatuses),
        ])
        if (workerResult.error || balanceResult.error || pendingCountResult.error) {
          setError('Não foi possível carregar os dados de apoio da fila. Tente novamente.')
          return false
        }
        setWorkers((workerResult.data ?? []) as Worker[])
        setBalances((balanceResult.data ?? []) as Balance[])
        setPendingTotal(pendingCountResult.count ?? 0)
        setEvents([])
        setEventsLoadedIds(new Set())
        setEventErrorIds(new Set())
      }
      const orderIds = [...new Set(deliveryRows.map((delivery) => delivery.order_id))]
      if (orderIds.length === 0) {
        if (!append) {
          setDeliveries([])
          setOrders([])
          setComponents([])
          setMovements([])
        }
        setError(null)
        return true
      }
      const [orderResult, componentResult, movementResult] = await Promise.all([
        supabaseClient.from('orders').select('id, customer_id, customer_name_snapshot, delivery_address_snapshot, status, delivery_fee_cents, created_at')
          .eq('business_id', businessId).in('id', orderIds),
        supabaseClient.from('order_line_components').select('order_id, product_id, product_name_snapshot, inventory_unit_snapshot, quantity_snapshot, inventory_tracked_snapshot')
          .eq('business_id', businessId).in('order_id', orderIds),
        supabaseClient.from('inventory_movements').select('order_id, product_id, movement_type, quantity_delta')
          .eq('business_id', businessId).in('order_id', orderIds),
      ])
      if (orderResult.error || componentResult.error || movementResult.error) {
        setError('Não foi possível carregar os dados dos pedidos para entrega.')
        return false
      }
      const mergeById = <T extends { id: string }>(existing: T[], incoming: T[]) => {
        const merged = new Map(existing.map((item) => [item.id, item]))
        for (const item of incoming) merged.set(item.id, item)
        return [...merged.values()]
      }
      setDeliveries((existing) => append ? mergeById(existing, deliveryRows) : deliveryRows)
      setOrders((existing) => append ? mergeById(existing, (orderResult.data ?? []) as Order[]) : (orderResult.data ?? []) as Order[])
      setComponents((existing) => append ? [...existing, ...((componentResult.data ?? []) as OrderComponent[])] : (componentResult.data ?? []) as OrderComponent[])
      setMovements((existing) => append ? [...existing, ...((movementResult.data ?? []) as InventoryMovement[])] : (movementResult.data ?? []) as InventoryMovement[])
      setError(null)
      return true
    } catch {
      setError('Não foi possível carregar a fila de entregas. Tente novamente.')
      return false
    } finally {
      if (append) setLoadingMore(false)
      else setLoading(false)
    }
  }, [businessId, filter])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadQueue() }, [loadQueue])

  const loadDeliveryEvents = useCallback(async (deliveryId: string) => {
    if (!supabaseClient || eventsLoadedIds.has(deliveryId) || eventLoadingIds.has(deliveryId)) return
    setEventLoadingIds((current) => new Set(current).add(deliveryId))
    setEventErrorIds((current) => { const next = new Set(current); next.delete(deliveryId); return next })
    try {
      const history: DeliveryEvent[] = []
      const pageSize = 200
      for (let offset = 0; ; offset += pageSize) {
        const { data, error: eventsError, count } = await supabaseClient.from('delivery_events')
          .select('id, delivery_id, event_type, from_status, to_status, delivery_worker_id, scheduled_on, time_window, note, next_step, stock_warnings, occurred_at', { count: 'exact' })
          .eq('business_id', businessId)
          .eq('delivery_id', deliveryId)
          .order('occurred_at', { ascending: false })
          .range(offset, offset + pageSize - 1)
        if (eventsError) throw eventsError
        const page = (data ?? []) as DeliveryEvent[]
        history.push(...page)
        if (page.length < pageSize || (count !== null && count !== undefined && history.length >= count)) break
      }
      setEvents((current) => [...current.filter((event) => event.delivery_id !== deliveryId), ...history])
      setEventsLoadedIds((current) => new Set(current).add(deliveryId))
    } catch {
      setEventErrorIds((current) => new Set(current).add(deliveryId))
    } finally {
      setEventLoadingIds((current) => { const next = new Set(current); next.delete(deliveryId); return next })
    }
  }, [businessId, eventLoadingIds, eventsLoadedIds])

  useEffect(() => {
    if (editingPlanId) planHeadingRef.current?.focus()
    else if (wasPlanOpenRef.current && !statusTarget) formReturnFocusRef.current?.focus()
    wasPlanOpenRef.current = Boolean(editingPlanId)
  }, [editingPlanId, statusTarget])

  useEffect(() => {
    if (statusTarget) statusHeadingRef.current?.focus()
    else if (wasStatusOpenRef.current && !editingPlanId) formReturnFocusRef.current?.focus()
    wasStatusOpenRef.current = Boolean(statusTarget)
  }, [editingPlanId, statusTarget])

  const orderMap = useMemo(() => new Map(orders.map((order) => [order.id, order])), [orders])
  const workerMap = new Map(workers.map((worker) => [worker.id, worker]))
  const balanceMap = new Map(balances.map((balance) => [balance.product_id, balance]))
  const lastDeliveredPlanByCustomer = useMemo(() => {
    const result = new Map<string, Delivery>()
    const activeWorkerIds = new Set(workers.filter((worker) => worker.is_active).map((worker) => worker.id))
    for (const delivery of deliveries) {
      if (delivery.status !== 'delivered' || !delivery.delivered_at) continue
      if (!activeWorkerIds.has(delivery.delivery_worker_id ?? '') && !delivery.time_window) continue
      const customerId = orderMap.get(delivery.order_id)?.customer_id
      if (!customerId) continue
      const previous = result.get(customerId)
      if (!previous || (delivery.delivered_at ?? '') > (previous.delivered_at ?? '')) result.set(customerId, delivery)
    }
    return result
  }, [deliveries, orderMap, workers])
  const filteredDeliveries = useMemo(() => {
    if (error) return []
    const eligible = deliveries.filter((delivery) => orderMap.get(delivery.order_id)?.status === 'open')
    const filtered = filter === 'all'
      ? eligible
      : filter === 'pending'
        ? eligible.filter((delivery) => delivery.status !== 'delivered' && delivery.status !== 'returned')
        : eligible.filter((delivery) => delivery.status === filter)
    return [...filtered].sort((a, b) => (a.scheduled_on ?? '9999-12-31').localeCompare(b.scheduled_on ?? '9999-12-31') || b.created_at.localeCompare(a.created_at))
  }, [deliveries, error, filter, orderMap])

  function openPlan(delivery: Delivery, trigger: HTMLElement) {
    if (error) return
    formReturnFocusRef.current = trigger
    setStatusTarget(null)
    setExpandedId(delivery.id)
    setEditingPlanId(delivery.id)
    setPlanWorkerId(delivery.delivery_worker_id ?? '')
    setPlanDate(delivery.scheduled_on ?? businessToday())
    setPlanScheduleEnabled(Boolean(delivery.scheduled_on || delivery.time_window))
    setPlanWindow(delivery.time_window ?? '')
    setPlanNotes(delivery.notes ?? '')
    setPlanError(null)
    setPlanUncertain(false)
    planRequestIdRef.current = newRequestId()
  }

  async function handlePlanSubmit(event: FormEvent<HTMLFormElement>, delivery: Delivery) {
    event.preventDefault()
    if (!supabaseClient || planSaving || planUncertain || error) return
    if (planWindow.trim().length > 120 || planNotes.trim().length > 2000) {
      setPlanError('Confira o tamanho da janela ou da observação.')
      return
    }
    setPlanSaving(true)
    setPlanError(null)
    try {
      const { error: rpcError, status } = await supabaseClient.rpc('update_delivery_plan', {
        p_business_id: businessId,
        p_delivery_id: delivery.id,
        p_delivery_worker_id: planWorkerId || null,
        p_scheduled_on: planScheduleEnabled ? planDate || null : null,
        p_time_window: planScheduleEnabled ? planWindow.trim() || null : null,
        p_notes: planNotes.trim() || null,
        p_request_id: planRequestIdRef.current,
      })
      if (rpcError) {
        if (status >= 400 && status < 500) {
          planRequestIdRef.current = newRequestId()
          setPlanError('O planejamento não foi salvo. Confira a atribuição e a data, depois tente novamente.')
        } else {
          setPlanUncertain(true)
          setPlanError('Não foi possível confirmar se o planejamento foi salvo. Tente novamente sem alterar os dados.')
        }
        return
      }
      setEditingPlanId(null)
      setPlanUncertain(false)
      setNotice('Planejamento de entrega atualizado.')
      planRequestIdRef.current = newRequestId()
      await loadQueue()
    } catch {
      setPlanUncertain(true)
      setPlanError('Não foi possível confirmar se o planejamento foi salvo. Tente novamente sem alterar os dados.')
    } finally {
      setPlanSaving(false)
    }
  }

  function beginStatus(delivery: Delivery, status: DeliveryStatus, trigger: HTMLElement) {
    if (error) return
    formReturnFocusRef.current = trigger
    setEditingPlanId(null)
    setExpandedId(delivery.id)
    setStatusTarget({ deliveryId: delivery.id, status })
    setStatusNote('')
    setNextStep('')
    setStatusError(null)
    setStatusUncertain(false)
    const key = delivery.id + ':' + status
    if (!statusRequestIdsRef.current.has(key)) statusRequestIdsRef.current.set(key, newRequestId())
    if (status === 'dispatched') {
      const relevant = components.filter((component) => component.order_id === delivery.order_id && component.inventory_tracked_snapshot)
      const quantities = new Map<string, { name: string; unit: string; orderedMilli: number }>()
      for (const component of relevant) {
        const current = quantities.get(component.product_id) ?? { name: component.product_name_snapshot, unit: component.inventory_unit_snapshot ?? '', orderedMilli: 0 }
        current.orderedMilli += Math.round(Number(component.quantity_snapshot) * 1000)
        quantities.set(component.product_id, current)
      }
      const warnings: Array<{ name: string; unit: string; available: number; needed: number; projected: number }> = []
      for (const [productId, line] of quantities) {
        const netIssuedMilli = Math.max(
          -movements
            .filter((movement) => movement.order_id === delivery.order_id && movement.product_id === productId && ['dispatch', 'return'].includes(movement.movement_type))
            .reduce((sum, movement) => sum + Math.round(Number(movement.quantity_delta) * 1000), 0),
          0,
        )
        const neededMilli = Math.max(line.orderedMilli - netIssuedMilli, 0)
        const availableMilli = Math.round(Number(balanceMap.get(productId)?.quantity_on_hand ?? 0) * 1000)
        const projectedMilli = availableMilli - neededMilli
        const needed = neededMilli / 1000
        const available = availableMilli / 1000
        const projected = projectedMilli / 1000
        if (needed > 0 && projected < 0) warnings.push({ name: line.name, unit: line.unit, available, needed, projected })
      }
      setDispatchWarnings(warnings)
    } else {
      setDispatchWarnings([])
    }
  }

  function requestIdFor(deliveryId: string, status: DeliveryStatus) {
    const key = deliveryId + ':' + status
    const requestId = statusRequestIdsRef.current.get(key) ?? newRequestId()
    statusRequestIdsRef.current.set(key, requestId)
    return requestId
  }

  async function handleStatusSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || !statusTarget || statusSaving || statusUncertain || error) return
    if (statusTarget.status === 'attempted' && (!statusNote.trim() || !nextStep.trim())) {
      setStatusError('Registre o que ocorreu e a próxima ação para concluir a tentativa.')
      return
    }
    setStatusSaving(true)
    setStatusError(null)
    try {
      const { data, error: rpcError, status } = await supabaseClient.rpc('transition_delivery', {
        p_business_id: businessId,
        p_delivery_id: statusTarget.deliveryId,
        p_status: statusTarget.status,
        p_note: statusNote.trim() || null,
        p_next_step: nextStep.trim() || null,
        p_request_id: requestIdFor(statusTarget.deliveryId, statusTarget.status),
      })
      if (rpcError) {
        if (status >= 400 && status < 500) {
          statusRequestIdsRef.current.set(statusTarget.deliveryId + ':' + statusTarget.status, newRequestId())
          setStatusError('A mudança não foi registrada. Atualize a fila e confira o próximo estado permitido.')
        } else {
          setStatusUncertain(true)
          setStatusError('Não foi possível confirmar a mudança. Tente novamente sem alterar os dados.')
        }
        return
      }
      if (typeof data !== 'string') {
        setStatusUncertain(true)
        setStatusError('A resposta da mudança não chegou completa. Tente novamente sem alterar os dados.')
        return
      }
      setStatusTarget(null)
      setStatusUncertain(false)
      setNotice('Entrega atualizada para “' + statusLabels[statusTarget.status] + '”.')
      statusRequestIdsRef.current.delete(statusTarget.deliveryId + ':' + statusTarget.status)
      await loadQueue()
      queueHeadingRef.current?.focus()
    } catch {
      setStatusUncertain(true)
      setStatusError('Não foi possível confirmar a mudança. Tente novamente sem alterar os dados.')
    } finally {
      setStatusSaving(false)
    }
  }

  const pendingCount = pendingTotal
  const currentDate = businessToday()

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div><p className="eyebrow">OPERAÇÃO · ROTA</p><h1>Entregas</h1><p className="page-description">Fila ligada aos pedidos marcados para entrega, com atribuição e histórico.</p></div>
        <Link className="button button-primary" to="/equipe"><Icon name="people" /> Gerenciar equipe</Link>
      </header>

      {notice && <p className="form-message form-message-success" role="status">{notice}</p>}
      {error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => void loadQueue()} type="button">Tentar novamente</button></div>}

      <section className="surface-panel record-panel" aria-labelledby="delivery-workers-heading">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">ATRIBUIÇÃO</p><h2 id="delivery-workers-heading">Entregadores cadastrados</h2></div><span className="neutral-status">{workers.filter((worker) => worker.is_active).length} ativos</span></div>
        {loading ? <p className="inline-state" aria-live="polite">Carregando entregadores…</p> : workers.length === 0 ? <p className="inline-state">Nenhum entregador cadastrado.</p> : <ul className="worker-list">{workers.map((worker) => <li key={worker.id} className={worker.is_active ? '' : 'record-inactive'}><span><strong>{worker.name}</strong><small>{worker.phone || 'Telefone não informado'} · {worker.is_active ? 'Ativo' : 'Inativo'}</small></span></li>)}</ul>}
        <Link className="quiet-link" to="/equipe">Cadastrar e conectar entregadores <Icon name="arrow" /></Link>
      </section>

      <section className="surface-panel record-panel" aria-labelledby="delivery-queue-heading">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">FILA DE PEDIDOS PARA ENTREGA</p><h2 id="delivery-queue-heading" ref={queueHeadingRef} tabIndex={-1}>Acompanhamento</h2></div><span className="neutral-status">{loading ? '—' : pendingCount + ' pendentes'}</span></div>
        <div className="delivery-filters" role="group" aria-label="Filtrar entregas">
          <button aria-pressed={filter === 'pending'} className={filter === 'pending' ? 'delivery-filter is-active' : 'delivery-filter'} onClick={() => setFilter('pending')} type="button">Pendentes</button>
          <button aria-pressed={filter === 'all'} className={filter === 'all' ? 'delivery-filter is-active' : 'delivery-filter'} onClick={() => setFilter('all')} type="button">Todas</button>
          {statusOrder.map((status) => <button aria-pressed={filter === status} className={filter === status ? 'delivery-filter is-active' : 'delivery-filter'} key={status} onClick={() => setFilter(status)} type="button">{statusLabels[status]}</button>)}
        </div>
        {loading ? <p className="inline-state" aria-live="polite">Carregando fila de entregas…</p> : error ? <p className="inline-state" role="status">A fila não foi atualizada. Os cartões anteriores foram ocultados e nenhuma ação de entrega está disponível até uma atualização bem-sucedida.</p> : filteredDeliveries.length === 0 ? <div className="inline-state"><p>{filter === 'pending' ? 'Nenhum pedido marcado para entrega está pendente.' : 'Nenhuma entrega aparece neste filtro.'}</p><p className="section-footnote">Pedidos só entram nesta fila quando “Este pedido precisa ser entregue” é marcado na criação.</p></div> : <ul className="delivery-list">
          {filteredDeliveries.map((delivery) => {
            const order = orderMap.get(delivery.order_id)
            const worker = delivery.delivery_worker_id ? workerMap.get(delivery.delivery_worker_id) : null
            const previousPlan = order ? lastDeliveredPlanByCustomer.get(order.customer_id) : null
            const previousWorker = previousPlan?.delivery_worker_id ? workers.find((item) => item.id === previousPlan.delivery_worker_id && item.is_active) : null
            const expanded = expandedId === delivery.id
            const deliveryEvents = events.filter((event) => event.delivery_id === delivery.id)
            const actions = statusActions(delivery.status)
            const isEditingPlan = editingPlanId === delivery.id
            const target = statusTarget?.deliveryId === delivery.id ? statusTarget : null
            if (!order) return null
            return <li className="delivery-card" key={delivery.id}>
              <div className="delivery-card-head">
                <span className="delivery-order-mark"><Icon name="truck" /></span>
                <div className="delivery-card-main"><div className="delivery-customer-line"><strong>{order.customer_name_snapshot}</strong><span className={'delivery-status delivery-status-' + delivery.status}>{statusLabels[delivery.status]}</span></div><small><Link to={'/pedidos/' + order.id}>Pedido {order.id.slice(0, 8)} →</Link>{delivery.scheduled_on ? ' · ' + (delivery.scheduled_on < currentDate ? 'Agendada ' : '') + formatBusinessDate(delivery.scheduled_on) : ' · Sem data agendada'}</small></div>
                <button aria-expanded={expanded} aria-label={(expanded ? 'Fechar detalhes de ' : 'Abrir detalhes de ') + order.customer_name_snapshot} className="button button-secondary delivery-expand-button" onClick={() => { setExpandedId(expanded ? null : delivery.id); setStatusTarget(null); setEditingPlanId(null); if (!expanded) void loadDeliveryEvents(delivery.id) }} type="button">{expanded ? 'Fechar' : 'Abrir'}</button>
              </div>
              <div className="delivery-card-summary"><span><small>Endereço</small><strong>{order.delivery_address_snapshot || 'Não informado'}</strong></span><span><small>Entregador</small><strong>{worker?.name ?? 'Sem atribuição'}</strong></span></div>
              {expanded && <div className="delivery-card-details">
                <dl className="customer-facts delivery-facts"><div><dt>Pedido</dt><dd><Link to={'/pedidos/' + order.id}>Abrir pedido</Link></dd></div><div><dt>Endereço</dt><dd>{order.delivery_address_snapshot || 'Não informado'}</dd></div><div><dt>Taxa de entrega</dt><dd>{order.delivery_fee_cents === 0 ? 'Sem taxa' : 'Conferir no pedido'}</dd></div><div><dt>Entregador</dt><dd>{worker ? worker.name + (worker.phone ? ' · ' + worker.phone : '') : 'Nenhum'}</dd></div><div><dt>Agendamento</dt><dd>{delivery.scheduled_on ? formatBusinessDate(delivery.scheduled_on) + (delivery.time_window ? ' · ' + delivery.time_window : '') : 'Não informado'}</dd></div></dl>
                <div className="delivery-card-actions"><button className="button button-secondary" disabled={delivery.status === 'delivered' || delivery.status === 'returned' || Boolean(error)} onClick={(event) => openPlan(delivery, event.currentTarget)} type="button">Editar entregador e horário</button>{actions.map((nextStatus) => <button className={nextStatus === 'dispatched' ? 'button button-primary' : 'button button-secondary'} disabled={Boolean(error)} key={nextStatus} onClick={(event) => beginStatus(delivery, nextStatus, event.currentTarget)} type="button">{nextStatus === 'dispatched' ? 'Preparar despacho' : nextStatus === 'attempted' ? 'Registrar entrega não concluída' : 'Marcar: ' + statusLabels[nextStatus]}</button>)}</div>

                {isEditingPlan && <form className="delivery-action-form" onSubmit={(event) => void handlePlanSubmit(event, delivery)}>
                  <div className="section-heading section-heading-compact"><div><p className="eyebrow">PLANEJAMENTO</p><h3 ref={planHeadingRef} tabIndex={-1}>Atribuição e horário</h3></div></div>
                  <div className="record-form-grid">
                    {previousPlan && <div className="record-field record-field-wide"><span className="field-label">Entrega anterior deste cliente</span><div className="record-form-actions"><button className="button button-secondary" disabled={planSaving || planUncertain} onClick={() => { setPlanWorkerId(previousWorker?.id ?? ''); setPlanWindow(previousPlan.time_window ?? ''); setPlanDate(businessToday()); setPlanScheduleEnabled(Boolean(previousPlan.time_window)) }} type="button">Reutilizar {previousWorker ? previousWorker.name : 'horário'}{previousPlan.time_window ? ` · ${previousPlan.time_window}` : ''}</button></div><span className="section-footnote">Carrega entregador e período da última entrega concluída. Confira antes de salvar.</span></div>}
                    <label className="record-field"><span className="field-label">Entregador <span className="field-optional">opcional</span></span><select className="text-input" disabled={planSaving || planUncertain} onChange={(event) => setPlanWorkerId(event.target.value)} value={planWorkerId}><option value="">Sem atribuição</option>{workers.filter((item) => item.is_active).map((item) => <option key={item.id} value={item.id}>{item.name}{item.user_id ? '' : ' · sem painel'}</option>)}</select></label>
                    <div className="record-field"><span className="field-label">Data agendada <span className="field-optional">opcional · {delivery.scheduled_on ? 'data salva' : 'padrão: hoje · alterável'}</span></span><label className="field-label"><input checked={planScheduleEnabled} disabled={planSaving || planUncertain} onChange={(event) => setPlanScheduleEnabled(event.target.checked)} type="checkbox" /> Agendar entrega para esta data</label><input className="text-input" disabled={planSaving || planUncertain || !planScheduleEnabled} onChange={(event) => { setPlanDate(event.target.value); setPlanScheduleEnabled(true) }} type="date" value={planDate} /></div>
                    <div className="record-field record-field-wide"><span className="field-label">Janela rápida <span className="field-optional">opcional</span></span><div className="record-form-actions" aria-label="Escolher janela de entrega">{deliveryWindowPresets.map((window) => <button aria-pressed={planWindow === window} className="button button-secondary" disabled={planSaving || planUncertain} key={window} onClick={() => { setPlanWindow(window); setPlanScheduleEnabled(true) }} type="button">{window}</button>)}</div></div>
                    <label className="record-field"><span className="field-label">Personalizar janela ou horário <span className="field-optional">opcional</span></span><input className="text-input" disabled={planSaving || planUncertain} maxLength={120} onChange={(event) => { setPlanWindow(event.target.value); if (event.target.value.trim()) setPlanScheduleEnabled(true) }} placeholder="Ex.: manhã, 14h–16h" value={planWindow} /></label>
                    <label className="record-field"><span className="field-label">Instruções para o entregador</span><input className="text-input" disabled={planSaving || planUncertain} maxLength={2000} onChange={(event) => setPlanNotes(event.target.value)} value={planNotes} /></label>
                  </div>
                  <p className="section-footnote">A data começa preenchida com hoje, mas só será aplicada se você marcar “Agendar entrega”. Assim, salvar apenas a atribuição do entregador não agenda a entrega.</p>
                  {planError && <p className="form-message form-message-error" role="alert">{planError}</p>}
                  <div className="record-form-actions"><button className="button button-primary" disabled={planSaving} type="submit">{planSaving ? 'Salvando…' : planUncertain ? 'Tentar novamente sem alterar os dados' : 'Salvar planejamento'}</button><button className="text-button" disabled={planSaving || planUncertain} onClick={() => setEditingPlanId(null)} type="button">Cancelar</button></div>
                </form>}

                {target && <form className="delivery-action-form" onSubmit={(event) => void handleStatusSubmit(event)}>
                  <p className="eyebrow">MUDANÇA DE ESTADO</p><h3 ref={statusHeadingRef} tabIndex={-1}>{statusLabels[target.status]}</h3>
                  {target.status === 'attempted' && <>
                    <div className="record-field record-field-wide"><span className="field-label">Preencher com um caso comum</span><div className="record-form-actions">{failedDeliveryPresets.map((preset) => <button className="button button-secondary" disabled={statusSaving || statusUncertain} key={preset.label} onClick={() => { setStatusNote(preset.note); setNextStep(preset.nextStep) }} type="button">{preset.label}</button>)}</div></div>
                    <label className="record-field"><span className="field-label">O que ocorreu? <span aria-hidden="true">*</span></span><textarea className="text-input record-textarea" disabled={statusSaving || statusUncertain} maxLength={1000} onChange={(event) => setStatusNote(event.target.value)} required rows={2} value={statusNote} /></label>
                    <label className="record-field"><span className="field-label">Próxima ação <span aria-hidden="true">*</span></span><input className="text-input" disabled={statusSaving || statusUncertain} maxLength={1000} onChange={(event) => setNextStep(event.target.value)} required value={nextStep} /></label>
                  </>}
                  {target.status === 'dispatched' && <><p className="section-footnote">O estoque baixa no despacho. Reentregas consideram os itens já enviados e retornos conferidos.</p>{dispatchWarnings.length > 0 && <div className="form-message form-message-warning" role="status"><strong>Saldo insuficiente para este despacho.</strong><ul>{dispatchWarnings.map((warning) => <li key={warning.name}>{warning.name}: disponível {formatQuantity(warning.available)} {warning.unit}, necessário {formatQuantity(warning.needed)} {warning.unit}; saldo após despacho {formatQuantity(warning.projected)} {warning.unit}.</li>)}</ul><span>Você pode continuar; o saldo ficará negativo e o aviso será registrado.</span></div>}</>}
                  {target.status === 'returned' && <p className="form-message form-message-warning" role="status">Marcar a entrega como devolvida não adiciona mercadoria ao estoque. Registre o retorno após conferência em Estoque.</p>}
                  {statusError && <p className="form-message form-message-error" role="alert">{statusError}</p>}
                  <div className="record-form-actions"><button className="button button-primary" disabled={statusSaving} type="submit">{statusSaving ? 'Atualizando…' : statusUncertain ? 'Tentar novamente sem alterar os dados' : target.status === 'dispatched' && dispatchWarnings.length > 0 ? 'Despachar mesmo sem estoque suficiente' : 'Confirmar estado'}</button><button className="text-button" disabled={statusSaving || statusUncertain} onClick={() => setStatusTarget(null)} type="button">Cancelar</button></div>
                </form>}

                <section className="delivery-history" aria-label="Histórico desta entrega"><details className="dashboard-trend-details delivery-history-details"><summary>Ver histórico da entrega <span>{eventsLoadedIds.has(delivery.id) ? `${deliveryEvents.length} atualizações` : 'Carregar histórico'}</span></summary>{eventLoadingIds.has(delivery.id) ? <p className="inline-state" aria-live="polite">Carregando histórico…</p> : eventErrorIds.has(delivery.id) ? <p className="inline-state inline-state-error" role="alert">Não foi possível carregar o histórico. <button className="text-button" onClick={() => void loadDeliveryEvents(delivery.id)} type="button">Tentar novamente</button></p> : !eventsLoadedIds.has(delivery.id) ? <p className="inline-state">Abra os detalhes da entrega para carregar o histórico.</p> : deliveryEvents.length === 0 ? <p className="inline-state">Nenhuma atualização de entrega encontrada.</p> : <ul className="timeline-list">{deliveryEvents.map((entry) => <li key={entry.id}><span className="timeline-dot" /><div><strong>{entry.event_type === 'created' ? 'Entrega criada' : entry.event_type === 'plan_updated' ? 'Horário ou entregador atualizado' : (entry.from_status ? statusLabels[entry.from_status] + ' → ' : '') + statusLabels[entry.to_status]}</strong><p>{timestamp(entry.occurred_at)}</p>{entry.note && <p>{entry.note}</p>}{entry.next_step && <p>Próximo passo: {entry.next_step}</p>}{entry.event_type === 'status_changed' && entry.to_status === 'dispatched' && <p>O estoque foi atualizado quando o pedido saiu para entrega.</p>}{entry.stock_warnings?.length > 0 && <p className="delivery-stock-warning">Estoque abaixo de zero após o despacho: {entry.stock_warnings.map((warning) => warning.product_name + ' (' + formatQuantity(Number(warning.quantity_on_hand)) + ' ' + warning.inventory_unit + ')').join(' · ')}.</p>}</div></li>)}</ul>}</details></section>
                {['attempted', 'rescheduled', 'returned', 'delivered'].includes(delivery.status) && <p className="section-footnote delivery-return-note">Se algum item voltou, registre a quantidade conferida separadamente em <Link to="/estoque">Estoque</Link>. A mudança de estado não repõe saldo.</p>}
              </div>}
            </li>
          })}
        </ul>}
        {!loading && !error && <div className="record-form-actions delivery-pagination" aria-live="polite">
          <span className="section-footnote">Mostrando {deliveries.length} de {filteredTotal} entregas neste filtro.</span>
          {hasMore && <button className="button button-secondary" disabled={loadingMore} onClick={() => void loadQueue(true)} type="button">{loadingMore ? 'Carregando…' : 'Carregar mais entregas'}</button>}
        </div>}
      </section>
    </div>
  )
}
