import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { businessLocalDateTimeToIso, businessToday, currentTimestamp, formatBusinessDate } from '../lib/formatters'
import { supabaseClient } from '../lib/supabase'

type FollowUp = {
  id: string
  customer_id: string | null
  title: string
  due_on: string
  priority: 'low' | 'normal' | 'high'
  customerName: string | null
}

type CustomerOption = { id: string; name: string; is_active: boolean }
type RecentCall = { id: string; customer_id: string | null; call_outcome: 'answered' | 'missed' | 'other'; notes: string | null; occurred_at: string }
const pageBusinessDate = businessToday()
const callPageSize = 20
const callOutcomeLabels: Record<RecentCall['call_outcome'], string> = { answered: 'Atendida', missed: 'Não atendida', other: 'Outro resultado' }

function businessDateTimeInputValue() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`
}

export function FollowUpsPage() {
  const { id: businessId } = useBusiness()
  const [tasks, setTasks] = useState<FollowUp[]>([])
  const [customers, setCustomers] = useState<CustomerOption[]>([])
  const [recentCalls, setRecentCalls] = useState<RecentCall[]>([])
  const [hasMoreCalls, setHasMoreCalls] = useState(false)
  const [loadingMoreCalls, setLoadingMoreCalls] = useState(false)
  const [callHistoryError, setCallHistoryError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [showCallForm, setShowCallForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [callError, setCallError] = useState<string | null>(null)

  const loadTasks = useCallback(async () => {
    if (!supabaseClient) {
      setLoading(false)
      return
    }
    try {
      const [taskResult, customerResult, callsResult] = await Promise.all([
        supabaseClient.from('follow_up_tasks')
          .select('id, customer_id, title, due_on, priority')
          .eq('business_id', businessId).eq('status', 'pending')
          .order('due_on', { ascending: true }).order('created_at', { ascending: true }),
        supabaseClient.from('customers').select('id, name, is_active')
          .eq('business_id', businessId).order('name', { ascending: true }),
        supabaseClient.from('customer_interactions')
          .select('id, customer_id, call_outcome, notes, occurred_at')
          .eq('business_id', businessId)
          .eq('interaction_type', 'call').order('occurred_at', { ascending: false })
          .order('id', { ascending: false }).range(0, callPageSize - 1),
      ])

      if (taskResult.error || customerResult.error) {
        setError('Não foi possível carregar os retornos. Tente novamente.')
        return
      }
      const customerOptions = (customerResult.data ?? []) as CustomerOption[]
      const names = new Map(customerOptions.map((customer) => [customer.id, customer.name]))
      setCustomers(customerOptions)
      setTasks(((taskResult.data ?? []) as Omit<FollowUp, 'customerName'>[]).map((task) => ({
        ...task,
        customerName: task.customer_id ? names.get(task.customer_id) ?? null : null,
      })))
      setError(null)
      if (callsResult.error) {
        setCallHistoryError('Não foi possível carregar o histórico de ligações.')
        setRecentCalls([])
        setHasMoreCalls(false)
      } else {
        const calls = (callsResult.data ?? []) as RecentCall[]
        setRecentCalls(calls)
        setHasMoreCalls(calls.length === callPageSize)
        setCallHistoryError(null)
      }
    } catch {
      setError('Não foi possível carregar os retornos. Tente novamente.')
    } finally {
      setLoading(false)
    }
  }, [businessId])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadTasks() }, [loadTasks])

  async function loadMoreCalls() {
    if (!supabaseClient || loadingMoreCalls) return
    setLoadingMoreCalls(true)
    setCallHistoryError(null)
    try {
      const cursor = recentCalls.at(-1)
      let query = supabaseClient.from('customer_interactions')
        .select('id, customer_id, call_outcome, notes, occurred_at')
        .eq('business_id', businessId).eq('interaction_type', 'call')
      if (cursor) {
        query = query.or(`occurred_at.lt.${cursor.occurred_at},and(occurred_at.eq.${cursor.occurred_at},id.lt.${cursor.id})`)
      }
      const { data, error: queryError } = await query
        .order('occurred_at', { ascending: false }).order('id', { ascending: false })
        .range(0, callPageSize - 1)
      if (queryError) {
        setCallHistoryError('Não foi possível carregar o histórico de ligações. Tente novamente.')
        return
      }
      const calls = (data ?? []) as RecentCall[]
      setRecentCalls((current) => cursor ? [...current, ...calls] : calls)
      setHasMoreCalls(calls.length === callPageSize)
    } catch {
      setCallHistoryError('Não foi possível carregar o histórico de ligações. Tente novamente.')
    } finally {
      setLoadingMoreCalls(false)
    }
  }

  async function handleCreateTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient) return
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const title = String(form.get('title') ?? '').trim()
    const dueOn = String(form.get('due_on') ?? '').trim()
    if (!title || !dueOn) {
      setSaveError('Informe o próximo passo e a data do retorno.')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const { error: insertError } = await supabaseClient.from('follow_up_tasks').insert({
        business_id: businessId,
        customer_id: String(form.get('customer_id') ?? '').trim() || null,
        title,
        due_on: dueOn,
        priority: String(form.get('priority') ?? 'normal'),
      })
      if (insertError) {
        setSaveError('Não foi possível salvar o retorno. Seus dados continuam no formulário; tente novamente.')
        return
      }
      formElement.reset()
      setShowForm(false)
      await loadTasks()
    } catch {
      setSaveError('Não foi possível salvar o retorno. Seus dados continuam no formulário; tente novamente.')
    } finally {
      setSaving(false)
    }
  }

  async function closeTask(taskId: string, status: 'completed' | 'cancelled') {
    if (!supabaseClient) return
    try {
      const { error: updateError } = await supabaseClient.from('follow_up_tasks')
        .update({ status, closed_at: currentTimestamp() })
        .eq('business_id', businessId).eq('id', taskId)
      if (updateError) {
        setActionError('Não foi possível atualizar o retorno. A fila continua disponível; tente novamente.')
        return
      }
      setTasks((current) => current.filter((task) => task.id !== taskId))
      setActionError(null)
    } catch {
      setActionError('Não foi possível atualizar o retorno. A fila continua disponível; tente novamente.')
    }
  }

  async function handleLogCall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient) return
    const form = new FormData(event.currentTarget)
    const followUpTitle = String(form.get('follow_up_title') ?? '').trim()
    const dueOn = String(form.get('follow_up_due_on') ?? '').trim()
    const callOutcome = String(form.get('call_outcome') ?? '')
    const occurredAtInput = String(form.get('occurred_at') ?? '').trim()
    const occurredAt = occurredAtInput ? businessLocalDateTimeToIso(occurredAtInput) : currentTimestamp()
    if (!occurredAt) {
      setCallError('Confira a data e o horário da ligação.')
      return
    }
    if (callOutcome !== 'missed' && Boolean(followUpTitle) !== Boolean(dueOn)) {
      setCallError('Preencha o próximo passo e a data juntos, ou deixe os dois em branco.')
      return
    }
    setSaving(true)
    setCallError(null)
    try {
      const { error: logError } = await supabaseClient.rpc('record_customer_interaction', {
        p_business_id: businessId,
        p_customer_id: String(form.get('customer_id') ?? '').trim() || null,
        p_interaction_type: 'call',
        p_direction: String(form.get('direction')),
        p_call_outcome: callOutcome,
        p_outcome: null,
        p_notes: String(form.get('notes') ?? '').trim() || null,
        p_occurred_at: occurredAt,
        p_follow_up_title: followUpTitle || null,
        p_follow_up_due_on: dueOn || null,
        p_follow_up_priority: String(form.get('priority') ?? '').trim() || null,
      })
      if (logError) {
        setCallError('Não foi possível registrar a ligação. Seus dados continuam no formulário; tente novamente.')
        return
      }
      setShowCallForm(false)
      await loadTasks()
    } catch {
      setCallError('Não foi possível registrar a ligação. Seus dados continuam no formulário; tente novamente.')
    } finally {
      setSaving(false)
    }
  }

  const today = pageBusinessDate
  const overdueCount = tasks.filter((task) => task.due_on < today).length

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div><p className="eyebrow">ATENDIMENTO</p><h1>Atendimento</h1><p className="page-description">Ligações registradas manualmente e próximos passos.</p></div>
        <div className="record-heading-actions"><button className="button button-secondary" onClick={() => { setShowCallForm((value) => !value); setCallError(null) }} type="button"><Icon name="phone" /> {showCallForm ? 'Fechar ligação' : 'Registrar ligação'}</button><button className="button button-primary" onClick={() => { setShowForm((value) => !value); setSaveError(null) }} type="button"><Icon name="plus" /> {showForm ? 'Fechar' : 'Novo retorno'}</button></div>
      </header>

      {showCallForm && (
        <form className="surface-panel record-form" onSubmit={handleLogCall}>
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">REGISTRO MANUAL</p><h2>Nova ligação</h2></div></div>
          <div className="record-form-grid">
            <label className="record-field"><span className="field-label">Cliente <span className="field-optional">opcional</span></span><select className="text-input" defaultValue="" name="customer_id"><option value="">Não identificado</option>{customers.filter((customer) => customer.is_active).map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
            <label className="record-field"><span className="field-label">Direção</span><select className="text-input" name="direction"><option value="outgoing">Realizada pelo negócio</option><option value="incoming">Recebida do cliente</option></select></label>
            <label className="record-field"><span className="field-label">Resultado da ligação</span><select className="text-input" defaultValue="answered" name="call_outcome" required><option value="answered">Atendida</option><option value="missed">Não atendida</option><option value="other">Outro resultado</option></select></label>
            <label className="record-field"><span className="field-label">Quando aconteceu <span className="field-optional">padrão: agora · horário de Brasília · alterável</span></span><input className="text-input" defaultValue={businessDateTimeInputValue()} name="occurred_at" type="datetime-local" /></label>
            <label className="record-field record-field-wide"><span className="field-label">Anotações <span className="field-optional">opcional</span></span><textarea className="text-input record-textarea" maxLength={4000} name="notes" rows={3} /></label>
            <label className="record-field record-field-wide"><span className="field-label">Próximo passo <span className="field-optional">opcional</span></span><input className="text-input" maxLength={240} name="follow_up_title" /></label>
            <label className="record-field"><span className="field-label">Data do retorno <span className="field-optional">padrão: hoje · alterável</span></span><input className="text-input" defaultValue={businessToday()} name="follow_up_due_on" type="date" /></label>
            <label className="record-field"><span className="field-label">Prioridade do retorno</span><select className="text-input" defaultValue="" name="priority"><option value="">Automática</option><option value="normal">Normal</option><option value="high">Alta</option><option value="low">Baixa</option></select></label>
          </div>
          <p className="section-footnote">Chamadas não são importadas do celular. Uma ligação não atendida cria automaticamente um retorno para hoje, com prioridade alta.</p>
          {callError && <p className="form-message form-message-error" role="alert">{callError}</p>}
          <button className="button button-primary" disabled={saving} type="submit">{saving ? 'Salvando…' : 'Salvar ligação'}</button>
        </form>
      )}

      {showForm && (
        <form className="surface-panel record-form" onSubmit={handleCreateTask}>
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">LEMBRETE MANUAL</p><h2>Novo retorno</h2></div></div>
          <div className="record-form-grid">
            <label className="record-field record-field-wide"><span className="field-label">Próximo passo *</span><input autoFocus className="text-input" maxLength={240} name="title" required /></label>
            <label className="record-field"><span className="field-label">Data do retorno * <span className="field-optional">padrão: hoje · alterável</span></span><input className="text-input" defaultValue={businessToday()} name="due_on" required type="date" /></label>
            <label className="record-field"><span className="field-label">Prioridade</span><select className="text-input" name="priority"><option value="normal">Normal</option><option value="high">Alta</option><option value="low">Baixa</option></select></label>
            <label className="record-field record-field-wide"><span className="field-label">Cliente <span className="field-optional">opcional</span></span><select className="text-input" defaultValue="" name="customer_id"><option value="">Sem cliente vinculado</option>{customers.filter((customer) => customer.is_active).map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
          </div>
          {saveError && <p className="form-message form-message-error" role="alert">{saveError}</p>}
          <button className="button button-primary" disabled={saving} type="submit">{saving ? 'Salvando…' : 'Salvar retorno'}</button>
        </form>
      )}

      <section className="surface-panel record-panel" aria-labelledby="follow-up-list-title">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">FILA DE ATENDIMENTO</p><h2 id="follow-up-list-title">Pendentes</h2></div><span className="neutral-status">{tasks.length} {tasks.length === 1 ? 'retorno' : 'retornos'}</span></div>
        {overdueCount > 0 && <p className="form-message form-message-warning" role="status">{overdueCount} {overdueCount === 1 ? 'retorno está' : 'retornos estão'} atrasado(s).</p>}
        {actionError && <p className="form-message form-message-error" role="alert">{actionError}</p>}
        {loading && <p className="inline-state" aria-live="polite">Carregando retornos…</p>}
        {!loading && error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => { setLoading(true); void loadTasks() }} type="button">Tentar novamente</button></div>}
        {!loading && !error && tasks.length === 0 && (
          <div className="module-empty-panel record-empty"><span className="empty-icon"><Icon name="check" /></span><h2>Nenhum retorno pendente</h2><p>Registre contatos e próximos passos nos cadastros de clientes ou crie um lembrete manual.</p><Link className="button button-secondary" to="/clientes">Abrir clientes</Link></div>
        )}
        {!loading && !error && tasks.length > 0 && (
          <ul className="follow-up-list">
            {tasks.map((task) => {
              const overdue = task.due_on < today
              return (
                <li className={overdue ? 'follow-up-item is-overdue' : 'follow-up-item'} key={task.id}>
                  <span className="follow-up-date"><Icon name="clock" /><strong>{formatBusinessDate(task.due_on)}</strong><small>{overdue ? 'Atrasado' : task.due_on === today ? 'Hoje' : 'Agendado'}</small></span>
                  <span className="follow-up-copy"><strong>{task.title}</strong><small>{task.customerName ? <Link to={`/clientes/${task.customer_id}`}>{task.customerName}</Link> : 'Sem cliente vinculado'} · Prioridade {task.priority === 'high' ? 'alta' : task.priority === 'low' ? 'baixa' : 'normal'}</small></span>
                  <span className="follow-up-actions"><button className="text-button" onClick={() => void closeTask(task.id, 'completed')} type="button">Concluir</button><button className="text-button follow-up-cancel" onClick={() => void closeTask(task.id, 'cancelled')} type="button">Cancelar</button></span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {(recentCalls.length > 0 || callHistoryError || (!loading && recentCalls.length === 0)) && (
        <section className="surface-panel record-panel" aria-labelledby="recent-calls-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">HISTÓRICO</p><h2 id="recent-calls-title">Ligações registradas</h2></div><span className="neutral-status">{recentCalls.length} carregadas</span></div>
          {callHistoryError && <div className="inline-state inline-state-error" role="alert"><p>{callHistoryError}</p><button className="text-button" disabled={loadingMoreCalls} onClick={() => void loadMoreCalls()} type="button">Tentar novamente</button></div>}
          {!callHistoryError && recentCalls.length === 0 && <p className="inline-state">Nenhuma ligação registrada ainda.</p>}
          {recentCalls.length > 0 && <ul className="timeline-list">{recentCalls.map((call) => <li key={call.id}><span className="timeline-dot" /><div><strong>{callOutcomeLabels[call.call_outcome]}</strong><p>{new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(call.occurred_at))}</p>{call.customer_id ? <p><Link to={`/clientes/${call.customer_id}`}>{customerLabel(call.customer_id, customers)}</Link></p> : <p>Cliente não identificado</p>}{call.notes && <p>{call.notes}</p>}</div></li>)}</ul>}
          {hasMoreCalls && !callHistoryError && <button className="button button-secondary" disabled={loadingMoreCalls} onClick={() => void loadMoreCalls()} type="button">{loadingMoreCalls ? 'Carregando…' : 'Carregar ligações anteriores'}</button>}
        </section>
      )}
    </div>
  )
}

function customerLabel(customerId: string, customers: CustomerOption[]) {
  return customers.find((customer) => customer.id === customerId)?.name ?? 'Cliente arquivado'
}
