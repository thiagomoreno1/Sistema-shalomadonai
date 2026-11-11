import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { canManageBusiness, useBusiness } from '../business/BusinessContext'
import { FinanceNavigation } from '../components/FinanceNavigation'
import { businessToday, currentTimestamp, formatBRL, formatBusinessDate } from '../lib/formatters'
import { supabaseClient } from '../lib/supabase'

type Order = { id: string; customer_id: string | null; customer_name_snapshot: string; status: 'open' | 'cancelled' }
type Installment = { id: string; order_id: string; installment_number: number; amount_cents: number; due_on: string }
type Allocation = { id: string; order_id: string; installment_id: string; amount_cents: number }
type Receivable = Installment & { customer_id: string | null; customer_name: string; balance_cents: number; overdue: boolean }
type FollowUpPriority = 'low' | 'normal' | 'high'
type FollowUpRpcArgs = {
  p_business_id: string
  p_customer_id: string
  p_interaction_type: 'note'
  p_direction: 'not_applicable'
  p_call_outcome: null
  p_outcome: null
  p_notes: string
  p_occurred_at: string
  p_follow_up_title: string
  p_follow_up_due_on: string
  p_follow_up_priority: FollowUpPriority
  p_related_order_id: string
}
type FollowUpDraft = {
  installmentId: string
  customerId: string | null
  customerName: string
  orderId: string
  installmentNumber: number
  originalDueOn: string
  balanceCents: number
  title: string
  dueOn: string
  priority: FollowUpPriority
  pending: boolean
  requestId: string | null
  occurredAt: string | null
  requestArgs: FollowUpRpcArgs | null
}
type StoredFollowUpAttempt = {
  version: 1
  businessId: string
  installmentId: string
  customerId: string
  orderId: string
  installmentNumber: number
  originalDueOn: string
  balanceCents: number
  title: string
  dueOn: string
  priority: FollowUpPriority
  requestId: string
  occurredAt: string
  requestArgs: FollowUpRpcArgs
}
type PageResponse = { data: unknown[] | null; error: unknown }

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

function groupTotal(items: Receivable[]) {
  return items.reduce((total, item) => total + item.balance_cents, 0)
}

function followUpStoragePrefix(businessId: string) {
  return `shalom-receivable-follow-up:v1:${businessId}:`
}

function followUpStorageKey(businessId: string, installmentId: string) {
  return `${followUpStoragePrefix(businessId)}${installmentId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function followUpNote(draft: Pick<FollowUpDraft, 'orderId' | 'installmentNumber' | 'originalDueOn' | 'balanceCents'>) {
  const orderReference = draft.orderId.slice(0, 8).toUpperCase()
  return `Retorno manual programado para a parcela ${draft.installmentNumber} do pedido #${orderReference}. Vencimento original: ${formatBusinessDate(draft.originalDueOn)}. Saldo exibido ao abrir o retorno: ${formatBRL(draft.balanceCents)}. Nenhum contato foi realizado por este registro.`
}

function readPendingFollowUp(businessId: string): { attempt: StoredFollowUpAttempt | null; error: string | null } {
  try {
    const prefix = followUpStoragePrefix(businessId)
    let pendingAttempt: StoredFollowUpAttempt | null = null
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index)
      if (!key?.startsWith(prefix)) continue
      const installmentId = key.slice(prefix.length)
      const raw = sessionStorage.getItem(key)
      if (!raw || !isUuid(installmentId)) {
        return { attempt: null, error: 'O rascunho pendente desta aba está inválido. Nenhuma nova tentativa será enviada até ele poder ser conferido.' }
      }

      const value: unknown = JSON.parse(raw)
      if (!isRecord(value) || !isRecord(value.requestArgs)) {
        return { attempt: null, error: 'O rascunho pendente desta aba não pôde ser validado. Nenhuma nova tentativa será enviada.' }
      }
      const args = value.requestArgs
      const candidate = value as unknown as StoredFollowUpAttempt
      const validPriority = candidate.priority === 'low' || candidate.priority === 'normal' || candidate.priority === 'high'
      const occurredAt = typeof candidate.occurredAt === 'string' && Number.isFinite(Date.parse(candidate.occurredAt))
      const validTitle = typeof candidate.title === 'string' && candidate.title.trim().length > 0 && candidate.title.trim().length <= 240
      const validArgs = args.p_business_id === businessId && args.p_customer_id === candidate.customerId &&
        args.p_interaction_type === 'note' && args.p_direction === 'not_applicable' &&
        args.p_call_outcome === null && args.p_outcome === null && args.p_notes === followUpNote(candidate) &&
        args.p_occurred_at === candidate.occurredAt && args.p_follow_up_title === candidate.title.trim() &&
        args.p_follow_up_due_on === candidate.dueOn && args.p_follow_up_priority === candidate.priority &&
        args.p_related_order_id === candidate.orderId
      if (candidate.version !== 1 || candidate.businessId !== businessId || candidate.installmentId !== installmentId ||
          !isUuid(candidate.customerId) || !isUuid(candidate.orderId) || !isUuid(candidate.requestId) ||
          !Number.isInteger(candidate.installmentNumber) || candidate.installmentNumber < 1 ||
          !isDateOnly(candidate.originalDueOn) || !isDateOnly(candidate.dueOn) ||
          !Number.isSafeInteger(candidate.balanceCents) || candidate.balanceCents < 0 ||
          !validPriority || !validTitle || !occurredAt || !validArgs) {
        return { attempt: null, error: 'O rascunho pendente desta aba não pôde ser validado. Nenhuma nova tentativa será enviada.' }
      }

      if (pendingAttempt) {
        return { attempt: null, error: 'Há mais de uma tentativa pendente nesta aba. Nenhuma nova gravação será enviada até que os rascunhos possam ser conferidos.' }
      }
      pendingAttempt = candidate
    }
    return { attempt: pendingAttempt, error: null }
  } catch {
    return { attempt: null, error: 'Não foi possível acessar o armazenamento desta aba. Nenhuma gravação será enviada até que o rascunho possa ser lido.' }
  }
}

function storePendingFollowUp(attempt: StoredFollowUpAttempt) {
  try {
    sessionStorage.setItem(followUpStorageKey(attempt.businessId, attempt.installmentId), JSON.stringify(attempt))
    return true
  } catch {
    return false
  }
}

function clearPendingFollowUp(businessId: string, installmentId: string) {
  try {
    sessionStorage.removeItem(followUpStorageKey(businessId, installmentId))
    return true
  } catch {
    return false
  }
}

function storedAttemptFromDraft(businessId: string, draft: FollowUpDraft): StoredFollowUpAttempt | null {
  if (!draft.customerId || !draft.requestId || !draft.occurredAt || !draft.requestArgs) return null
  return {
    version: 1,
    businessId,
    installmentId: draft.installmentId,
    customerId: draft.customerId,
    orderId: draft.orderId,
    installmentNumber: draft.installmentNumber,
    originalDueOn: draft.originalDueOn,
    balanceCents: draft.balanceCents,
    title: draft.title,
    dueOn: draft.dueOn,
    priority: draft.priority,
    requestId: draft.requestId,
    occurredAt: draft.occurredAt,
    requestArgs: draft.requestArgs,
  }
}

export function ReceivablesPage() {
  const { id: businessId, role: businessRole } = useBusiness()
  const [receivables, setReceivables] = useState<Receivable[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [followUpDraft, setFollowUpDraft] = useState<FollowUpDraft | null>(null)
  const [followUpSavingId, setFollowUpSavingId] = useState<string | null>(null)
  const [followUpError, setFollowUpError] = useState<string | null>(null)
  const [followUpNotice, setFollowUpNotice] = useState<string | null>(null)
  const [followUpStorageError, setFollowUpStorageError] = useState<string | null>(null)
  const [followUpStorageBusinessId, setFollowUpStorageBusinessId] = useState<string | null>(null)
  const followUpHeadingRef = useRef<HTMLHeadingElement>(null)
  const followUpTriggerRef = useRef<HTMLButtonElement>(null)
  const activeFollowUpId = followUpDraft?.installmentId ?? null
  const followUpStorageReady = followUpStorageBusinessId === businessId && !followUpStorageError
  const today = businessToday()

  useEffect(() => {
    setFollowUpStorageBusinessId(null)
    setFollowUpStorageError(null)
    setFollowUpDraft(null)
    setFollowUpError(null)
    if (businessRole !== 'owner') {
      setFollowUpStorageBusinessId(businessId)
      return
    }
    const { attempt, error: storageError } = readPendingFollowUp(businessId)
    if (storageError) {
      setFollowUpStorageError(storageError)
      setFollowUpStorageBusinessId(businessId)
      return
    }
    if (attempt) {
      setFollowUpDraft({
        installmentId: attempt.installmentId,
        customerId: attempt.customerId,
        customerName: 'Cliente',
        orderId: attempt.orderId,
        installmentNumber: attempt.installmentNumber,
        originalDueOn: attempt.originalDueOn,
        balanceCents: attempt.balanceCents,
        title: attempt.title,
        dueOn: attempt.dueOn,
        priority: attempt.priority,
        pending: true,
        requestId: attempt.requestId,
        occurredAt: attempt.occurredAt,
        requestArgs: attempt.requestArgs,
      })
      setFollowUpError('Uma tentativa anterior teve resposta inconclusiva. Confira ou reenvie com o mesmo identificador para evitar duplicidade.')
    }
    setFollowUpStorageBusinessId(businessId)
  }, [businessId, businessRole])

  const loadReceivables = useCallback(async () => {
    const client = supabaseClient
    if (!client) {
      setError('A conexão da empresa não está disponível.')
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const ordersResult = await loadAllPages<Order>((from, to) => client.from('orders')
        .select('id, customer_id, customer_name_snapshot, status')
        .eq('business_id', businessId)
        .eq('status', 'open')
        .order('id', { ascending: true })
        .range(from, to))
      if (ordersResult.error) {
        setError('Não foi possível carregar os pagamentos que faltam receber. Tente novamente.')
        return
      }

      const orders = ordersResult.data ?? []
      const orderIds = orders.map((order) => order.id)
      if (orderIds.length === 0) {
        setReceivables([])
        setError(null)
        return
      }

      const loadedInstallments: Installment[] = []
      const loadedAllocations: Allocation[] = []
      for (let start = 0; start < orderIds.length; start += 100) {
        const orderIdBatch = orderIds.slice(start, start + 100)
        const [installmentsResult, allocationsResult] = await Promise.all([
          loadAllPages<Installment>((from, to) => client.from('order_installments')
            .select('id, order_id, installment_number, amount_cents, due_on')
            .eq('business_id', businessId)
            .in('order_id', orderIdBatch)
            .order('id', { ascending: true })
            .range(from, to)),
          loadAllPages<Allocation>((from, to) => client.from('order_payment_allocations')
            .select('id, order_id, installment_id, amount_cents')
            .eq('business_id', businessId)
            .in('order_id', orderIdBatch)
            .order('installment_id', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to)),
        ])
        if (installmentsResult.error || allocationsResult.error) {
          setError('Não foi possível carregar todos os vencimentos e seus saldos. Tente novamente.')
          return
        }
        loadedInstallments.push(...(installmentsResult.data ?? []))
        loadedAllocations.push(...(allocationsResult.data ?? []))
      }

      const customerByOrder = new Map(orders.map((order) => [order.id, {
        id: order.customer_id,
        name: order.customer_name_snapshot,
      }]))
      const paidByInstallment = new Map<string, number>()
      for (const allocation of loadedAllocations) {
        paidByInstallment.set(allocation.installment_id, (paidByInstallment.get(allocation.installment_id) ?? 0) + allocation.amount_cents)
      }

      const nextReceivables = loadedInstallments
        .map((installment) => ({
          ...installment,
          customer_id: customerByOrder.get(installment.order_id)?.id ?? null,
          customer_name: customerByOrder.get(installment.order_id)?.name ?? 'Cliente não disponível',
          balance_cents: Math.max(0, installment.amount_cents - (paidByInstallment.get(installment.id) ?? 0)),
          overdue: installment.due_on < today,
        }))
        .filter((installment) => installment.balance_cents > 0)
        .sort((left, right) => left.due_on.localeCompare(right.due_on) || left.customer_name.localeCompare(right.customer_name, 'pt-BR'))

      setReceivables(nextReceivables)
      setError(null)
    } catch {
      setError('Não foi possível carregar os pagamentos que faltam receber. Tente novamente.')
    } finally {
      setLoading(false)
    }
  }, [businessId, today])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadReceivables() }, [loadReceivables])

  useEffect(() => {
    if (activeFollowUpId) followUpHeadingRef.current?.focus()
  }, [activeFollowUpId])

  const overdue = useMemo(() => receivables.filter((item) => item.due_on < today), [receivables, today])
  const dueToday = useMemo(() => receivables.filter((item) => item.due_on === today), [receivables, today])
  const upcoming = useMemo(() => receivables.filter((item) => item.due_on > today), [receivables, today])

  function openFollowUp(item: Receivable, trigger: HTMLButtonElement) {
    if (followUpSavingId || followUpDraft?.pending || !followUpStorageReady) return
    if (followUpDraft?.installmentId === item.id) {
      setFollowUpDraft(null)
      setFollowUpError(null)
      requestAnimationFrame(() => trigger.focus())
      return
    }

    const orderReference = item.order_id.slice(0, 8).toUpperCase()
    followUpTriggerRef.current = trigger
    setFollowUpNotice(null)
    setFollowUpError(null)
    setFollowUpDraft({
      installmentId: item.id,
      customerId: item.customer_id,
      customerName: item.customer_name,
      orderId: item.order_id,
      installmentNumber: item.installment_number,
      originalDueOn: item.due_on,
      balanceCents: item.balance_cents,
      title: `Cobrar parcela ${item.installment_number} · pedido #${orderReference} · venc. ${formatBusinessDate(item.due_on)} · saldo ${formatBRL(item.balance_cents)}`,
      dueOn: today,
      priority: 'normal',
      pending: false,
      requestId: null,
      occurredAt: null,
      requestArgs: null,
    })
  }

  function closeFollowUp() {
    if (followUpSavingId || followUpDraft?.pending) return
    setFollowUpDraft(null)
    setFollowUpError(null)
    requestAnimationFrame(() => followUpTriggerRef.current?.focus())
  }

  async function sendFollowUpAttempt(draft: FollowUpDraft, attempt: StoredFollowUpAttempt) {
    if (!supabaseClient || followUpSavingId) return
    setFollowUpSavingId(draft.installmentId)
    setFollowUpError(null)
    try {
      const { error: insertError } = await supabaseClient.rpc('record_customer_interaction_with_order_idempotent', {
        ...attempt.requestArgs,
        p_request_id: attempt.requestId,
      })
      if (insertError) {
        const statusValue = (insertError as unknown as { status?: unknown }).status
        const status = typeof statusValue === 'number' ? statusValue : null
        const definitelyNotCommitted = insertError.code === 'PGRST202' || (status !== null && status >= 400 && status < 500)
        if (definitelyNotCommitted) {
          if (clearPendingFollowUp(businessId, draft.installmentId)) {
            setFollowUpStorageError(null)
            setFollowUpDraft((current) => current?.installmentId === draft.installmentId ? {
              ...current, pending: false, requestId: null, occurredAt: null, requestArgs: null,
            } : current)
            setFollowUpError(insertError.code === 'PGRST202'
              ? 'A função idempotente ainda não está disponível no Supabase. Nenhuma anotação ou retorno foi criado; os campos foram liberados para uma nova tentativa após a atualização.'
              : 'O Supabase rejeitou esta solicitação sem gravar o retorno. Confira os dados e tente novamente.')
          } else {
            setFollowUpStorageError('O armazenamento desta aba não conseguiu remover a tentativa rejeitada. Ela continua bloqueada e pode ser reenviada com o mesmo identificador.')
            setFollowUpError('O Supabase rejeitou a solicitação sem gravar o retorno, mas não foi possível limpar o rascunho. Reenvie este mesmo retorno para manter a proteção contra duplicidade.')
          }
          return
        }
        setFollowUpError('A resposta do Supabase foi inconclusiva. A tentativa foi preservada; reenvie com o mesmo identificador para verificar sem criar duplicidade.')
        return
      }

      const cleared = clearPendingFollowUp(businessId, draft.installmentId)
      const orderReference = draft.orderId.slice(0, 8).toUpperCase()
      setFollowUpNotice(`Retorno manual criado para ${draft.customerName}, com anotação ligada ao pedido #${orderReference}. Nenhuma mensagem foi enviada.`)
      if (cleared) {
        setFollowUpStorageError(null)
        setFollowUpDraft(null)
        setFollowUpError(null)
        requestAnimationFrame(() => followUpTriggerRef.current?.focus())
      } else {
        setFollowUpStorageError('O retorno foi confirmado, mas o rascunho desta aba não pôde ser removido. Reenviar a mesma tentativa continuará protegido contra duplicidade.')
        setFollowUpError('O retorno foi criado. O rascunho de recuperação permanece bloqueado; se necessário, reenvie com o mesmo identificador.')
      }
    } catch {
      setFollowUpError('A conexão caiu antes da confirmação. A tentativa foi salva nesta aba; reenvie com o mesmo identificador para verificar sem criar duplicidade.')
    } finally {
      setFollowUpSavingId(null)
    }
  }

  async function retryPendingFollowUp() {
    const draft = followUpDraft
    if (!draft?.pending || followUpSavingId) return
    const attempt = storedAttemptFromDraft(businessId, draft)
    if (!attempt) {
      setFollowUpStorageError('O rascunho pendente desta aba está incompleto. Nenhuma nova tentativa será enviada.')
      return
    }
    const receivable = receivables.find((item) => item.id === draft.installmentId)
    await sendFollowUpAttempt(receivable ? { ...draft, customerName: receivable.customer_name } : draft, attempt)
  }

  async function saveFollowUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const draft = followUpDraft
    if (!supabaseClient || !draft || followUpSavingId) return

    if (draft.pending) {
      await retryPendingFollowUp()
      return
    }

    if (!followUpStorageReady) {
      setFollowUpError(followUpStorageError ?? 'Aguarde a verificação do rascunho desta aba. Nenhuma gravação foi enviada.')
      return
    }

    const title = draft.title.trim()
    if (!draft.customerId) {
      setFollowUpError('Este pedido não tem um cliente vinculado; não foi possível criar o retorno.')
      return
    }
    if (!title || title.length > 240 || !isDateOnly(draft.dueOn) || !['low', 'normal', 'high'].includes(draft.priority)) {
      setFollowUpError('Confira o texto e a data do retorno.')
      return
    }

    const requestId = crypto.randomUUID()
    const occurredAt = currentTimestamp()
    const requestArgs: FollowUpRpcArgs = {
      p_business_id: businessId,
      p_customer_id: draft.customerId,
      p_interaction_type: 'note',
      p_direction: 'not_applicable',
      p_call_outcome: null,
      p_outcome: null,
      p_notes: followUpNote(draft),
      p_occurred_at: occurredAt,
      p_follow_up_title: title,
      p_follow_up_due_on: draft.dueOn,
      p_follow_up_priority: draft.priority,
      p_related_order_id: draft.orderId,
    }
    const attempt: StoredFollowUpAttempt = {
      version: 1,
      businessId,
      installmentId: draft.installmentId,
      customerId: draft.customerId,
      orderId: draft.orderId,
      installmentNumber: draft.installmentNumber,
      originalDueOn: draft.originalDueOn,
      balanceCents: draft.balanceCents,
      title,
      dueOn: draft.dueOn,
      priority: draft.priority,
      requestId,
      occurredAt,
      requestArgs,
    }

    if (!storePendingFollowUp(attempt)) {
      setFollowUpError('Não foi possível guardar a tentativa nesta aba. Nenhuma anotação ou retorno foi enviado; tente novamente quando o armazenamento estiver disponível.')
      return
    }
    setFollowUpStorageError(null)
    const pendingDraft = { ...draft, title, pending: true, requestId, occurredAt, requestArgs }
    setFollowUpDraft(pendingDraft)
    await sendFollowUpAttempt(pendingDraft, attempt)
  }

  function renderGroup(items: Receivable[], emptyText: string) {
    if (items.length === 0) return <p className="inline-state">{emptyText}</p>
    return (
      <ul className="receivable-list">
        {items.map((item) => (
          <li className="receivable-item" key={item.id}>
            <div className="receivable-item-entry">
              <Link to={`/pedidos/${item.order_id}`} className="receivable-link" aria-label={`Abrir pedido da parcela ${item.installment_number} de ${item.customer_name}`}>
                <span className={`receivable-date ${item.overdue ? 'receivable-date-overdue' : ''}`}>
                  <strong>{formatBusinessDate(item.due_on)}</strong>
                  <small>Parcela {item.installment_number}</small>
                </span>
                <span className="receivable-customer"><strong>{item.customer_name}</strong><small className={item.overdue ? 'receivable-overdue-label' : undefined}>{item.overdue ? 'Atrasado' : item.due_on === today ? 'Vence hoje' : 'Próximo vencimento'}</small></span>
                <span className="receivable-balance"><small>Saldo do vencimento</small><strong>{formatBRL(item.balance_cents)}</strong></span>
              </Link>
              <div className="receivable-actions">
                {item.customer_id && businessRole === 'owner' ? <button
                  aria-controls={followUpDraft?.installmentId === item.id ? `receivable-follow-up-${item.id}` : undefined}
                  aria-expanded={followUpDraft?.installmentId === item.id}
                  aria-label={`Criar retorno para ${item.customer_name}, parcela ${item.installment_number} do pedido #${item.order_id.slice(0, 8).toUpperCase()}`}
                  className="text-button receivable-follow-up-toggle"
                  disabled={!followUpStorageReady || Boolean(followUpSavingId) || Boolean(followUpDraft?.pending) || Boolean(followUpDraft && followUpDraft.installmentId !== item.id)}
                  onClick={(event) => openFollowUp(item, event.currentTarget)}
                  type="button"
                >{followUpDraft?.installmentId === item.id && followUpDraft.pending ? 'Tentativa pendente' : followUpDraft?.installmentId === item.id ? 'Fechar retorno' : 'Criar retorno'}</button> : <span className="receivable-action-note">{item.customer_id ? 'Apenas o responsável pode criar retornos' : 'Sem cliente vinculado'}</span>}
              </div>
            </div>
            {followUpDraft?.installmentId === item.id && <form aria-labelledby={`receivable-follow-up-title-${item.id}`} className="receivable-follow-up-form" id={`receivable-follow-up-${item.id}`} onSubmit={(event) => void saveFollowUp(event)}>
              <div className="section-heading section-heading-compact"><div><p className="eyebrow">LEMBRETE INTERNO</p><h3 id={`receivable-follow-up-title-${item.id}`} ref={followUpHeadingRef} tabIndex={-1}>Criar retorno manual</h3></div></div>
              <p className="section-footnote">{followUpDraft.pending && followUpDraft.customerName !== 'Cliente' ? followUpDraft.customerName : item.customer_name} · Parcela {followUpDraft.pending ? followUpDraft.installmentNumber : item.installment_number} · Pedido #{(followUpDraft.pending ? followUpDraft.orderId : item.order_id).slice(0, 8).toUpperCase()} · vencimento {formatBusinessDate(followUpDraft.pending ? followUpDraft.originalDueOn : item.due_on)} · saldo {formatBRL(followUpDraft.pending ? followUpDraft.balanceCents : item.balance_cents)}.</p>
              <p className="section-footnote">Este retorno aparecerá na fila de Atendimento. Nenhuma mensagem será enviada.</p>
              {followUpDraft.pending && <p className="form-message form-message-warning" role="status">Os campos estão bloqueados para preservar a tentativa original. Reenviar usa o mesmo identificador e não deve criar uma duplicidade.</p>}
              <div className="record-form-grid">
                <label className="record-field record-field-wide" htmlFor={`receivable-follow-up-text-${item.id}`}><span className="field-label">Texto do retorno</span><input className="text-input" disabled={followUpSavingId === item.id || followUpDraft.pending} id={`receivable-follow-up-text-${item.id}`} maxLength={240} onChange={(event) => setFollowUpDraft((current) => current?.installmentId === item.id && !current.pending ? { ...current, title: event.target.value } : current)} required value={followUpDraft.title} /></label>
                <label className="record-field" htmlFor={`receivable-follow-up-date-${item.id}`}><span className="field-label">Data do retorno</span><input className="text-input" disabled={followUpSavingId === item.id || followUpDraft.pending} id={`receivable-follow-up-date-${item.id}`} onChange={(event) => setFollowUpDraft((current) => current?.installmentId === item.id && !current.pending ? { ...current, dueOn: event.target.value } : current)} required type="date" value={followUpDraft.dueOn} /></label>
                <label className="record-field" htmlFor={`receivable-follow-up-priority-${item.id}`}><span className="field-label">Prioridade</span><select className="text-input" disabled={followUpSavingId === item.id || followUpDraft.pending} id={`receivable-follow-up-priority-${item.id}`} onChange={(event) => setFollowUpDraft((current) => current?.installmentId === item.id && !current.pending ? { ...current, priority: event.target.value as FollowUpPriority } : current)} value={followUpDraft.priority}><option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option></select></label>
              </div>
              {followUpError && <p className="form-message form-message-error" role="alert">{followUpError}</p>}
              <div className="record-form-actions"><button className="button button-primary" disabled={followUpSavingId === item.id} type="submit">{followUpSavingId === item.id ? 'Salvando…' : followUpDraft.pending ? 'Reenviar com segurança' : 'Salvar retorno'}</button><button className="text-button" disabled={Boolean(followUpSavingId) || followUpDraft.pending} onClick={closeFollowUp} type="button">Cancelar</button></div>
            </form>}
          </li>
        ))}
      </ul>
    )
  }

  return (
    <div className="page-stack">
      <header className="page-heading receivables-page-heading">
        <div>
          <p className="eyebrow">FINANCEIRO</p>
          <h1>Pagamentos a receber</h1>
          <p className="page-description">Parcelas pendentes e próximos vencimentos.</p>
        </div>
        <Link className="button button-secondary" to="/pedidos">Ver pedidos</Link>
      </header>
      <FinanceNavigation active="receivables" />

      <div className="section-heading receivables-section-heading"><h2>Pagamentos a receber</h2></div>
      <p className="section-footnote order-policy-note">Atrasado = ainda há saldo e a data de vencimento já passou.</p>

      {followUpStorageError && <p className="form-message form-message-error" role="alert">{followUpStorageError}</p>}
      {followUpDraft?.pending && !loading && !receivables.some((item) => item.id === followUpDraft.installmentId) && <section className="surface-panel record-panel" aria-labelledby="pending-follow-up-heading">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">TENTATIVA PRESERVADA</p><h2 id="pending-follow-up-heading">Confirmar retorno pendente</h2></div></div>
        <p className="section-footnote">Parcela {followUpDraft.installmentNumber} · Pedido #{followUpDraft.orderId.slice(0, 8).toUpperCase()}. O pedido não aparece mais na lista de saldos em aberto, mas a tentativa original pode ser consultada com segurança.</p>
        {followUpError && <p className="form-message form-message-error" role="alert">{followUpError}</p>}
        <button className="button button-primary" disabled={Boolean(followUpSavingId)} onClick={() => void retryPendingFollowUp()} type="button">{followUpSavingId ? 'Verificando…' : 'Reenviar tentativa preservada'}</button>
      </section>}

      {followUpNotice && <p className="form-message form-message-success" role="status">{followUpNotice} <Link to="/atendimento">Abrir fila de Atendimento</Link></p>}

      {!loading && !error && <section className="receivable-summary-grid" aria-label="Resumo dos pagamentos a receber">
        <article className="surface-panel receivable-summary-card"><span>Parcelas de clientes atrasadas</span><strong>{formatBRL(groupTotal(overdue))}</strong><small>{overdue.length} parcelas passaram da data</small></article>
        <article className="surface-panel receivable-summary-card"><span>Parcelas de clientes vencendo hoje</span><strong>{formatBRL(groupTotal(dueToday))}</strong><small>{dueToday.length} parcelas ainda sem pagamento</small></article>
        <article className="surface-panel receivable-summary-card"><span>Próximos vencimentos</span><strong>{formatBRL(groupTotal(upcoming))}</strong><small>{upcoming.length} parcelas ainda sem pagamento</small></article>
      </section>}

      {error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => void loadReceivables()} type="button">Tentar novamente</button></div>}

      {loading ? <p className="inline-state" aria-live="polite">Carregando vencimentos…</p> : !error && (
        <div className="page-stack receivable-groups">
          <section className="surface-panel record-panel" aria-labelledby="receivable-overdue-heading">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">PRIORIDADE</p><h2 id="receivable-overdue-heading">Parcelas de clientes atrasadas</h2></div><span className="neutral-status">{overdue.length}</span></div>
            {renderGroup(overdue, 'Nenhum pagamento atrasado.')}
          </section>
          <section className="surface-panel record-panel" aria-labelledby="receivable-today-heading">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">HOJE</p><h2 id="receivable-today-heading">Parcelas de clientes vencendo hoje</h2></div><span className="neutral-status">{dueToday.length}</span></div>
            {renderGroup(dueToday, 'Nenhuma parcela vence hoje.')}
          </section>
          <section className="surface-panel record-panel" aria-labelledby="receivable-upcoming-heading">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">AGENDA</p><h2 id="receivable-upcoming-heading">Próximos vencimentos</h2></div><span className="neutral-status">{upcoming.length}</span></div>
            {renderGroup(upcoming, 'Nenhum pagamento com vencimento futuro.')}
          </section>
          {receivables.length === 0 && <p className="section-footnote">Nenhum pagamento pendente neste período.</p>}
        </div>
      )}
    </div>
  )
}
