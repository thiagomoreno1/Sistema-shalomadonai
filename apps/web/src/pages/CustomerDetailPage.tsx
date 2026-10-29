import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { currentTimestamp, formatBusinessDate } from '../lib/formatters'
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
  interaction_type: 'call' | 'note' | 'whatsapp_manual' | 'other'
  direction: 'incoming' | 'outgoing' | 'not_applicable'
  call_outcome: 'answered' | 'missed' | 'other' | null
  outcome: string | null
  notes: string | null
  occurred_at: string
}

type FollowUp = {
  id: string
  title: string
  due_on: string
  priority: 'low' | 'normal' | 'high'
  status: 'pending' | 'completed' | 'cancelled'
}

const interactionLabels: Record<Interaction['interaction_type'], string> = {
  call: 'Ligação registrada manualmente',
  note: 'Observação',
  whatsapp_manual: 'WhatsApp · anotação manual',
  other: 'Outro contato',
}
const callOutcomeLabels = { answered: 'Atendida', missed: 'Não atendida', other: 'Outro resultado' }

export function CustomerDetailPage() {
  const { customerId = '' } = useParams()
  const { id: businessId } = useBusiness()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [interactions, setInteractions] = useState<Interaction[]>([])
  const [followUps, setFollowUps] = useState<FollowUp[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [interactionOpen, setInteractionOpen] = useState(false)
  const [interactionType, setInteractionType] = useState<Interaction['interaction_type']>('call')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [interactionError, setInteractionError] = useState<string | null>(null)

  const loadCustomer = useCallback(async () => {
    if (!supabaseClient) {
      setError('A conexão da empresa não está disponível.')
      setLoading(false)
      return
    }
    try {
      const [customerResult, interactionResult, followUpResult] = await Promise.all([
        supabaseClient.from('customers')
          .select('id, name, phone, delivery_address, notes, is_active')
          .eq('business_id', businessId).eq('id', customerId).maybeSingle(),
        supabaseClient.from('customer_interactions')
          .select('id, interaction_type, direction, call_outcome, outcome, notes, occurred_at')
          .eq('business_id', businessId).eq('customer_id', customerId)
          .order('occurred_at', { ascending: false }),
        supabaseClient.from('follow_up_tasks')
          .select('id, title, due_on, priority, status')
          .eq('business_id', businessId).eq('customer_id', customerId)
          .eq('status', 'pending').order('due_on', { ascending: true }),
      ])

      if (customerResult.error || interactionResult.error || followUpResult.error) {
        setError('Não foi possível carregar o histórico deste cliente. Tente novamente.')
      } else if (!customerResult.data) {
        setError('Este cliente não está disponível.')
      } else {
        setCustomer(customerResult.data as Customer)
        setInteractions((interactionResult.data ?? []) as Interaction[])
        setFollowUps((followUpResult.data ?? []) as FollowUp[])
        setError(null)
      }
    } catch {
      setError('Não foi possível carregar o histórico deste cliente. Tente novamente.')
    } finally {
      setLoading(false)
    }
  }, [businessId, customerId])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadCustomer() }, [loadCustomer])

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
      const { error: insertError } = await supabaseClient.rpc('record_customer_interaction', {
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

  if (loading) return <p className="inline-state" aria-live="polite">Carregando cliente…</p>
  if (error || !customer) {
    return (
      <div className="page-stack">
        <Link className="quiet-link" to="/clientes">← Voltar para clientes</Link>
        <div className="inline-state inline-state-error" role="alert">
          <p>{error ?? 'Cliente não encontrado.'}</p>
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

      {error && <p className="form-message form-message-error" role="alert">{error}</p>}

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

      <section className="surface-panel record-panel" aria-labelledby="interaction-title">
        <div className="section-heading section-heading-compact"><div><p className="eyebrow">HISTÓRICO</p><h2 id="interaction-title">Contatos registrados</h2></div><span className="neutral-status">{interactions.length}</span></div>
        {interactions.length === 0 ? <p className="inline-state">Nenhum contato registrado ainda.</p> : (
          <ul className="timeline-list">
            {interactions.map((interaction) => (
              <li key={interaction.id}>
                <span className="timeline-dot" />
                <div><strong>{interactionLabels[interaction.interaction_type]}</strong><p>{new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(interaction.occurred_at))}</p>
                  {interaction.direction !== 'not_applicable' && <p>{interaction.direction === 'incoming' ? 'Recebido' : 'Realizado pelo negócio'}</p>}
                  {interaction.call_outcome && <p><strong>Resultado da ligação:</strong> {callOutcomeLabels[interaction.call_outcome]}</p>}
                  {interaction.outcome && <p><strong>Resultado:</strong> {interaction.outcome}</p>}
                  {interaction.notes && <p>{interaction.notes}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
