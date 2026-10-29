import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
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
  cancellation_reason: string | null
  created_at: string
  cancelled_at: string | null
}
type OrderLine = {
  id: string
  line_number: number
  product_name_snapshot: string
  inventory_unit_snapshot: string | null
  quantity: number
  unit_price_snapshot_cents: number
  line_total_cents: number
}
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
type OrderEvent = { id: string; event_type: 'created' | 'cancelled'; reason: string | null; occurred_at: string }
type LocationState = { successMessage?: string } | null

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
  const { id: businessId } = useBusiness()
  const location = useLocation()
  const locationState = location.state as LocationState
  const [order, setOrder] = useState<Order | null>(null)
  const [lines, setLines] = useState<OrderLine[]>([])
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
  const [actionError, setActionError] = useState<string | null>(null)

  const loadDetail = useCallback(async (showBusy = true) => {
    if (!supabaseClient) {
      setError('A conexão da empresa não está disponível.')
      setLoading(false)
      return
    }
    if (showBusy) setLoading(true)
    try {
      const orderResult = await supabaseClient.from('orders')
        .select('id, customer_id, customer_name_snapshot, delivery_address_snapshot, subtotal_cents, delivery_fee_cents, discount_cents, total_cents, notes, status, cancellation_reason, created_at, cancelled_at')
        .eq('business_id', businessId).eq('id', orderId).maybeSingle()
      if (orderResult.error || !orderResult.data) {
        setError(orderResult.error ? 'Não foi possível carregar este pedido. Tente novamente.' : 'Este pedido não está disponível.')
        return
      }

      const [linesResult, installmentsResult, paymentsResult, eventsResult] = await Promise.all([
        supabaseClient.from('order_lines')
          .select('id, line_number, product_name_snapshot, inventory_unit_snapshot, quantity, unit_price_snapshot_cents, line_total_cents')
          .eq('business_id', businessId).eq('order_id', orderId).order('line_number', { ascending: true }),
        supabaseClient.from('order_installments')
          .select('id, installment_number, amount_cents, due_on, payment_method')
          .eq('business_id', businessId).eq('order_id', orderId).order('installment_number', { ascending: true }),
        supabaseClient.from('order_payments')
          .select('id, amount_cents, received_at, payment_method, notes')
          .eq('business_id', businessId).eq('order_id', orderId).order('received_at', { ascending: false }),
        supabaseClient.from('order_events')
          .select('id, event_type, reason, occurred_at')
          .eq('business_id', businessId).eq('order_id', orderId).order('occurred_at', { ascending: false }),
      ])
      if (linesResult.error || installmentsResult.error || paymentsResult.error || eventsResult.error) {
        setError('Não foi possível carregar o histórico completo do pedido. Tente novamente.')
        return
      }
      const loadedPayments = (paymentsResult.data ?? []) as Payment[]
      let loadedAllocations: PaymentAllocation[] = []
      if (loadedPayments.length > 0) {
        const allocationResult = await supabaseClient.from('order_payment_allocations')
          .select('id, payment_id, installment_id, amount_cents')
          .eq('business_id', businessId).eq('order_id', orderId)
          .in('payment_id', loadedPayments.map((payment) => payment.id))
        if (allocationResult.error) {
          setError('Não foi possível carregar as destinações dos recebimentos. Tente novamente.')
          return
        }
        loadedAllocations = (allocationResult.data ?? []) as PaymentAllocation[]
      }
      setOrder(orderResult.data as Order)
      setLines((linesResult.data ?? []) as OrderLine[])
      setInstallments((installmentsResult.data ?? []) as Installment[])
      setPayments(loadedPayments)
      setAllocations(loadedAllocations)
      setEvents((eventsResult.data ?? []) as OrderEvent[])
      setError(null)
    } catch {
      setError('Não foi possível carregar este pedido. Tente novamente.')
    } finally {
      setLoading(false)
    }
  }, [businessId, orderId])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadDetail() }, [loadDetail])

  useEffect(() => {
    if (showPaymentForm) paymentAmountInputRef.current?.focus()
    else if (wasPaymentFormOpenRef.current) orderHeadingRef.current?.focus()
    wasPaymentFormOpenRef.current = showPaymentForm
  }, [showPaymentForm])

  const receivedCents = payments.reduce((sum, payment) => sum + payment.amount_cents, 0)
  const outstandingCents = order?.status === 'open' ? Math.max(0, (order?.total_cents ?? 0) - receivedCents) : 0
  const today = businessToday()
  const paidByInstallment = useMemo(() => {
    const result = new Map<string, number>()
    for (const allocation of allocations) result.set(allocation.installment_id, (result.get(allocation.installment_id) ?? 0) + allocation.amount_cents)
    return result
  }, [allocations])
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
      setPaymentError('O valor recebido não pode exceder o saldo em aberto do pedido.')
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

  if (loading) return <p className="inline-state" aria-live="polite">Carregando pedido…</p>
  if (error || !order) {
    return (
      <div className="page-stack">
        <Link className="quiet-link" to="/pedidos">← Voltar para pedidos</Link>
        <div className="inline-state inline-state-error" role="alert">
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
          {order.status === 'open' && outstandingCents > 0 && <button className="button button-primary" onClick={startPayment} type="button"><Icon name="coin" /> Registrar recebimento</button>}
          {order.status === 'open' && payments.length === 0 && <button className="button button-secondary order-cancel-trigger" onClick={() => { setShowCancelForm((current) => !current); setActionError(null) }} type="button">{showCancelForm ? 'Fechar cancelamento' : 'Cancelar pedido'}</button>}
        </div>
      </header>

      {notice && <p className="form-message form-message-success" role="status">{notice}</p>}
      {actionError && <div className="form-message form-message-error" role="alert"><p>{actionError}</p><button className="text-button" onClick={() => void loadDetail(false)} type="button">Atualizar histórico</button></div>}

      <section className="order-balance-grid" aria-label="Resumo financeiro do pedido">
        <article className="surface-panel order-balance-card"><span>Total do pedido</span><strong>{formatBRL(order.total_cents)}</strong><small>Inclui itens, taxa de entrega e desconto informados.</small></article>
        <article className="surface-panel order-balance-card"><span>Recebido</span><strong>{formatBRL(receivedCents)}</strong><small>Registros manuais associados ao pedido.</small></article>
        <article className="surface-panel order-balance-card"><span>{order.status === 'open' ? 'Saldo em aberto' : 'Saldo após cancelamento'}</span><strong>{formatBRL(outstandingCents)}</strong><small>{order.status === 'open' ? 'Sem juros ou encargos automáticos.' : 'Este pedido está cancelado.'}</small></article>
      </section>

      {showCancelForm && order.status === 'open' && payments.length === 0 && (
        <form className="surface-panel record-form" onSubmit={handleCancelSubmit}>
          <p className="eyebrow">CANCELAMENTO</p><h2>Confirmar cancelamento</h2>
          <p className="section-footnote">Um pedido com qualquer recebimento não pode ser cancelado nesta etapa. O registro será preservado no histórico.</p>
          <label className="record-field"><span className="field-label">Motivo <span className="field-optional">opcional</span></span><textarea className="text-input record-textarea" disabled={cancelSaving} maxLength={1000} onChange={(event) => setCancelReason(event.target.value)} rows={2} value={cancelReason} /></label>
          <div className="record-form-actions"><button className="button button-secondary order-cancel-confirm" disabled={cancelSaving} type="submit">{cancelSaving ? 'Cancelando…' : 'Confirmar cancelamento'}</button><button className="text-button" disabled={cancelSaving} onClick={() => setShowCancelForm(false)} type="button">Manter pedido</button></div>
        </form>
      )}

      {showPaymentForm && order.status === 'open' && (
        <form className="surface-panel record-form" onSubmit={handlePaymentSubmit}>
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">RECEBIMENTO MANUAL</p><h2>Registrar valor recebido</h2></div><button className="text-button" disabled={paymentSaving || paymentUncertain} onClick={closePaymentForm} type="button">Fechar</button></div>
          <p className="section-footnote order-payment-hint">Este registro anota um recebimento informado por você. Não processa o pagamento. Distribua o valor recebido pelos vencimentos escolhidos; não há destinação automática.</p>
          <div className="record-form-grid">
            <label className="record-field"><span className="field-label">Valor recebido <span aria-hidden="true">*</span></span><input className="text-input" disabled={paymentSaving || paymentUncertain} inputMode="decimal" onChange={(event) => setPaymentAmount(event.target.value)} placeholder="0,00" ref={paymentAmountInputRef} value={paymentAmount} /></label>
            <label className="record-field"><span className="field-label">Recebido em <span className="field-optional">Horário de Brasília; em branco = agora</span></span><input className="text-input" disabled={paymentSaving || paymentUncertain} onChange={(event) => setReceivedAt(event.target.value)} type="datetime-local" value={receivedAt} /></label>
            <label className="record-field"><span className="field-label">Forma informada <span className="field-optional">texto opcional</span></span><input className="text-input" disabled={paymentSaving || paymentUncertain} maxLength={64} onChange={(event) => setPaymentMethod(event.target.value)} placeholder="Ex.: Pix, dinheiro, transferência" value={paymentMethod} /></label>
            <label className="record-field"><span className="field-label">Observações <span className="field-optional">opcional</span></span><input className="text-input" disabled={paymentSaving || paymentUncertain} maxLength={1000} onChange={(event) => setPaymentNotes(event.target.value)} value={paymentNotes} /></label>
          </div>
          <div className="order-allocation-panel">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">DESTINAÇÃO MANUAL</p><h3>Como o valor se distribui</h3></div><span className="neutral-status">{formatBRL(selectedAllocationTotal)}</span></div>
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

      <div className="record-detail-grid order-detail-grid">
        <section className="surface-panel record-panel" aria-labelledby="order-lines-heading">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">FOTOGRAFIA DO PEDIDO</p><h2 id="order-lines-heading">Produtos registrados</h2></div></div>
          {lines.length === 0 ? <p className="inline-state">Nenhum item foi encontrado neste pedido.</p> : <ul className="order-detail-lines">
            {lines.map((line) => <li key={line.id}>
              <span><strong>{line.product_name_snapshot}</strong><small>{formatQuantity(line.quantity)}{line.inventory_unit_snapshot ? ` ${line.inventory_unit_snapshot}` : ''} × {formatBRL(line.unit_price_snapshot_cents)}</small></span>
              <strong>{formatBRL(line.line_total_cents)}</strong>
            </li>)}
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
                <span className="order-installment-copy"><strong>{formatBusinessDate(installment.due_on)}</strong><small>{overdue ? 'Vencido · ' : ''}{installment.payment_method || 'Forma não informada'}</small></span>
                <span className="order-installment-values"><strong>{formatBRL(installment.amount_cents)}</strong><small>{order.status === 'cancelled' ? 'Cancelado · sem saldo a receber' : `Recebido ${formatBRL(paid)} · saldo ${formatBRL(balance)}`}</small></span>
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
          {events.map((event) => <li key={event.id}><span className="timeline-dot" /><div><strong>{event.event_type === 'created' ? 'Pedido criado' : 'Pedido cancelado'}</strong><p>{formatOrderTimestamp(event.occurred_at, true)}</p>{event.reason && <p>{event.reason}</p>}</div></li>)}
        </ul>}
      </section>
    </div>
  )
}
