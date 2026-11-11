import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { canManageBusiness, useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { formatBRLExact, formatBusinessDate, parseBrazilianCurrency } from '../lib/formatters'
import { useBusinessToday } from '../lib/useBusinessToday'
import { supabaseClient } from '../lib/supabase'

type DeliveryWorker = { id: string; name: string; phone: string | null; is_active: boolean; user_id: string | null; member_type: 'delivery_driver' | 'employee'; monthly_salary_cents: number | string | null; salary_due_day: number | null }
type SalaryItem = { worker_id: string; name: string; member_type: 'delivery_driver' | 'employee'; period_start: string; due_on: string; amount_cents: string; paid_on: string | null; outflow_id: string | null }
type SalaryStatus = { overdue_count: number; overdue_amount_cents: string; due_today_count: number; due_today_amount_cents: string; items: SalaryItem[] }

function newRequestId() { return crypto.randomUUID() }

export function TeamPage() {
  const { id: businessId, role } = useBusiness()
  const today = useBusinessToday()
  const [workers, setWorkers] = useState<DeliveryWorker[]>([])
  const [salaryStatus, setSalaryStatus] = useState<SalaryStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [memberType, setMemberType] = useState<'delivery_driver' | 'employee'>('delivery_driver')
  const [monthlySalary, setMonthlySalary] = useState('')
  const [salaryDueDay, setSalaryDueDay] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [accountWorkerId, setAccountWorkerId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [linkWorkerId, setLinkWorkerId] = useState<string | null>(null)
  const [linkEmail, setLinkEmail] = useState('')
  const [actionWorkerId, setActionWorkerId] = useState<string | null>(null)
  const [confirmUnlinkWorkerId, setConfirmUnlinkWorkerId] = useState<string | null>(null)
  const [salaryEditWorkerId, setSalaryEditWorkerId] = useState<string | null>(null)
  const [salaryEditAmount, setSalaryEditAmount] = useState('')
  const [salaryEditDueDay, setSalaryEditDueDay] = useState('')
  const [payingSalaryKey, setPayingSalaryKey] = useState<string | null>(null)
  const [confirmSalaryItem, setConfirmSalaryItem] = useState<SalaryItem | null>(null)

  const loadWorkers = useCallback(async () => {
    if (!supabaseClient || !canManageBusiness(role)) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [workersResult, salaryResult] = await Promise.all([
        supabaseClient.from('delivery_workers')
          .select('id, name, phone, is_active, user_id, member_type, monthly_salary_cents, salary_due_day')
          .eq('business_id', businessId)
          .order('is_active', { ascending: false })
          .order('name', { ascending: true }),
        supabaseClient.rpc('get_team_salary_status', { p_business_id: businessId, p_today: today }),
      ])
      if (workersResult.error || salaryResult.error || !salaryResult.data) setError('Não foi possível carregar a equipe e os salários. Confira se a atualização do banco foi aplicada.')
      else {
        setWorkers((workersResult.data ?? []) as DeliveryWorker[])
        setSalaryStatus(salaryResult.data as SalaryStatus)
      }
    } catch {
      setError('Não foi possível carregar a equipe e os salários.')
    } finally {
      setLoading(false)
    }
  }, [businessId, role, today])

  useEffect(() => { void loadWorkers() }, [loadWorkers])

  async function createWorker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || saving || !canManageBusiness(role)) return
    const cleanName = name.trim()
    const cleanPhone = phone.trim()
    const cleanEmail = email.trim().toLowerCase()
    const salaryCents = monthlySalary.trim() ? parseBrazilianCurrency(monthlySalary) : null
    const dueDay = salaryDueDay ? Number(salaryDueDay) : null
    const needsPortal = memberType === 'delivery_driver'
    if ((!accountWorkerId && (cleanName.length < 2 || cleanName.length > 120)) || cleanPhone.length > 64
      || (needsPortal && !accountWorkerId && (!cleanEmail || password.length < 8 || password.length > 128))
      || (monthlySalary.trim() && (salaryCents === null || !Number.isSafeInteger(salaryCents) || salaryCents <= 0))
      || (salaryCents !== null && (!Number.isInteger(dueDay) || dueDay === null || dueDay < 1 || dueDay > 31))) {
      setError('Confira o nome e o salário. Para criar acesso de entregador, informe também o e-mail e a senha inicial.')
      return
    }
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      let workerId = accountWorkerId
      if (!workerId) {
        const { data: workerData, error: insertError } = await supabaseClient.from('delivery_workers').insert({
          business_id: businessId,
          name: cleanName,
          phone: cleanPhone || null,
          member_type: memberType,
          monthly_salary_cents: salaryCents,
          salary_due_day: salaryCents === null ? null : dueDay,
        }).select('id').single()
        if (insertError || !workerData?.id) {
          setError('Não foi possível cadastrar essa pessoa. Tente novamente.')
          return
        }
        workerId = workerData.id
        if (memberType === 'employee') {
          setName('')
          setPhone('')
          setMonthlySalary('')
          setSalaryDueDay('')
          setShowForm(false)
          setNotice(`${cleanName} foi cadastrado na equipe. ${salaryCents === null ? '' : 'O salário mensal e o dia de pagamento foram configurados.'}`)
          await loadWorkers()
          return
        }
        setAccountWorkerId(workerId)
      }

      const { error: accountError } = await supabaseClient.functions.invoke('create-delivery-driver', {
        body: { business_id: businessId, worker_id: workerId, email: cleanEmail, password },
      })
      if (accountError) {
        const response = (accountError as unknown as { context?: Response }).context
        let failureCode: string | null = null
        if (response && typeof response.clone === 'function') {
          const failure = await response.clone().json().catch(() => null) as { error?: string } | null
          failureCode = failure?.error ?? null
        }
        if (failureCode === 'email_already_exists') {
          setShowForm(false)
          setAccountWorkerId(null)
          setPassword('')
          setLinkWorkerId(workerId)
          setLinkEmail(cleanEmail)
          await loadWorkers()
          setError('Esse e-mail já tem uma conta. Confira se é a conta do entregador e vincule-a abaixo.')
          return
        }
        if (failureCode === 'email_has_management_access') {
          setShowForm(false)
          setAccountWorkerId(null)
          setPassword('')
          await loadWorkers()
          setError('Este e-mail já tem acesso à gestão. Use outro e-mail para criar o acesso do entregador.')
          return
        }
        if (failureCode === 'account_created_unlinked') {
          setShowForm(false)
          setAccountWorkerId(null)
          setPassword('')
          setLinkWorkerId(workerId)
          setLinkEmail(cleanEmail)
          await loadWorkers()
          setError('A conta foi criada, mas ainda não foi vinculada. Use “Vincular conta existente” para concluir o acesso.')
          return
        }
        await loadWorkers()
        setError('O cadastro do entregador foi salvo, mas não foi possível criar o acesso. Tente novamente; a pessoa não será cadastrada em duplicidade.')
        return
      }

      setName('')
      setPhone('')
      setMemberType('delivery_driver')
      setMonthlySalary('')
      setSalaryDueDay('')
      setEmail('')
      setPassword('')
      setAccountWorkerId(null)
      setShowForm(false)
      setNotice(`Acesso criado para ${cleanName || workers.find((worker) => worker.id === workerId)?.name || 'o entregador'}. A pessoa já pode entrar pelo mesmo botão “Entrar” do sistema.`)
      await loadWorkers()
    } catch {
      setError('Não foi possível cadastrar o entregador. Tente novamente.')
    } finally {
      setSaving(false)
    }
  }

  async function connectDriver(event: FormEvent<HTMLFormElement>, worker: DeliveryWorker) {
    event.preventDefault()
    if (!supabaseClient || actionWorkerId || !canManageBusiness(role)) return
    setActionWorkerId(worker.id)
    setError(null)
    setNotice(null)
    try {
      const { error: linkError } = await supabaseClient.rpc('link_delivery_worker_account', {
        p_business_id: businessId,
        p_worker_id: worker.id,
        p_email: linkEmail.trim().toLowerCase(),
      })
      if (linkError) {
        setError(linkError.message.toLowerCase().includes('already has business access')
          ? 'Este e-mail já tem acesso à gestão. Use outro e-mail para o entregador.'
          : 'Não foi possível conectar. Confira se o entregador já criou a conta e confirmou o e-mail.')
        return
      }
      setLinkWorkerId(null)
      setLinkEmail('')
      setNotice(`Painel conectado para ${worker.name}.`)
      await loadWorkers()
    } catch {
      setError('Não foi possível conectar. Confira se o entregador já criou a conta e confirmou o e-mail.')
    } finally {
      setActionWorkerId(null)
    }
  }

  async function setWorkerActive(worker: DeliveryWorker) {
    if (!supabaseClient || actionWorkerId || !canManageBusiness(role)) return
    setActionWorkerId(worker.id)
    setError(null)
    setNotice(null)
    try {
      const { error: updateError } = await supabaseClient.from('delivery_workers')
        .update({ is_active: !worker.is_active })
        .eq('business_id', businessId)
        .eq('id', worker.id)
      if (updateError) {
        setError('Não foi possível atualizar o cadastro da equipe.')
        return
      }
      setNotice(worker.is_active ? 'Membro da equipe desativado; o histórico foi mantido.' : 'Membro da equipe reativado.')
      await loadWorkers()
    } catch {
      setError('Não foi possível atualizar o cadastro da equipe.')
    } finally {
      setActionWorkerId(null)
    }
  }

  async function saveSalary(worker: DeliveryWorker, event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || actionWorkerId || !canManageBusiness(role)) return
    const amountCents = salaryEditAmount.trim() ? parseBrazilianCurrency(salaryEditAmount) : null
    const dueDay = salaryEditDueDay ? Number(salaryEditDueDay) : null
    if (salaryEditAmount.trim() && (amountCents === null || !Number.isSafeInteger(amountCents) || amountCents <= 0)) {
      setError('Informe um salário mensal válido ou deixe o campo vazio para remover o salário.')
      return
    }
    if (amountCents !== null && (!Number.isInteger(dueDay) || dueDay === null || dueDay < 1 || dueDay > 31)) {
      setError('Informe um dia de pagamento entre 1 e 31.')
      return
    }
    setActionWorkerId(worker.id)
    setError(null)
    setNotice(null)
    try {
      const { error: updateError } = await supabaseClient.from('delivery_workers').update({
        monthly_salary_cents: amountCents,
        salary_due_day: amountCents === null ? null : dueDay,
      }).eq('business_id', businessId).eq('id', worker.id)
      if (updateError) {
        setError('Não foi possível salvar o salário mensal.')
        return
      }
      setSalaryEditWorkerId(null)
      setNotice(amountCents === null
        ? `Salário mensal removido de ${worker.name}; competências já abertas continuam no histórico.`
        : `Salário de ${worker.name} atualizado a partir do próximo mês. Competências atuais e anteriores mantêm o valor original.`)
      await loadWorkers()
    } catch {
      setError('Não foi possível salvar o salário mensal.')
    } finally {
      setActionWorkerId(null)
    }
  }

  async function recordSalaryPayment(item: SalaryItem) {
    const key = `${item.worker_id}:${item.period_start}`
    if (!supabaseClient || payingSalaryKey || !canManageBusiness(role)) return
    setPayingSalaryKey(key)
    setError(null)
    setNotice(null)
    try {
      const { error: paymentError } = await supabaseClient.rpc('record_team_salary_payment', {
        p_business_id: businessId,
        p_worker_id: item.worker_id,
        p_period_start: item.period_start,
        p_paid_on: today,
        p_request_id: newRequestId(),
      })
      if (paymentError) {
        setError('Não foi possível registrar o salário como pago. Confira a conexão e atualize a equipe.')
        return
      }
      setConfirmSalaryItem(null)
      setNotice(`Pagamento de salário de ${item.name} registrado nas saídas pagas.`)
      await loadWorkers()
    } catch {
      setError('Não foi possível confirmar o pagamento. Atualize a equipe antes de tentar novamente.')
    } finally {
      setPayingSalaryKey(null)
    }
  }

  async function unlinkDriver(worker: DeliveryWorker) {
    if (!supabaseClient || actionWorkerId || !canManageBusiness(role)) return
    setActionWorkerId(worker.id)
    setError(null)
    try {
      const { error: unlinkError } = await supabaseClient.rpc('unlink_delivery_worker_account', {
        p_business_id: businessId,
        p_worker_id: worker.id,
      })
      if (unlinkError) {
        setError('Não foi possível remover o acesso ao painel. Tente novamente.')
        return
      }
      setNotice(`O acesso ao painel de ${worker.name} foi removido; o cadastro e o histórico foram mantidos.`)
      await loadWorkers()
    } catch {
      setError('Não foi possível remover o acesso ao painel. Tente novamente.')
    } finally {
      setActionWorkerId(null)
      setConfirmUnlinkWorkerId(null)
    }
  }

  const activeCount = workers.filter((worker) => worker.is_active).length

  return (
    <div className="page-stack team-page">
      <header className="page-heading">
        <div><p className="eyebrow">EQUIPE</p><h1>Equipe</h1><p className="page-description">Cadastre funcionários e entregadores e acompanhe salários e acessos.</p></div>
        {canManageBusiness(role) && <div className="team-heading-actions"><Link className="button button-secondary" to="/entregador/visualizar"><Icon name="truck" /> Visualizar painel</Link><button className="button button-primary" onClick={() => { setShowForm((open) => !open); setAccountWorkerId(null); setMemberType('delivery_driver'); setName(''); setPhone(''); setMonthlySalary(''); setSalaryDueDay(''); setEmail(''); setPassword(''); setError(null); setNotice(null) }} type="button"><Icon name="plus" /> Novo membro</button></div>}
      </header>

      {notice && <p className="form-message form-message-success" role="status">{notice}</p>}
      {error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => void loadWorkers()} type="button">Tentar novamente</button></div>}

      {!canManageBusiness(role) ? <section className="surface-panel team-state"><h2>Acesso da equipe</h2><p>A gestão da equipe é feita pela pessoa proprietária ou pela gestão da empresa.</p></section> : <>
        {showForm && <form className="surface-panel record-form" onSubmit={(event) => void createWorker(event)}>
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">CADASTRO DA EQUIPE</p><h2>{accountWorkerId ? `Criar acesso para ${workers.find((worker) => worker.id === accountWorkerId)?.name ?? 'entregador'}` : 'Novo membro da equipe'}</h2></div><button className="text-button" disabled={saving} onClick={() => { setShowForm(false); setAccountWorkerId(null); setPassword('') }} type="button">Fechar</button></div>
          {!accountWorkerId && <label className="record-field"><span className="field-label">Cargo</span><select className="text-input" onChange={(event) => setMemberType(event.target.value as 'delivery_driver' | 'employee')} value={memberType}><option value="delivery_driver">Entregador</option><option value="employee">Funcionário</option></select></label>}
          <p className="section-footnote">Funcionários ficam no cadastro e na folha. Entregadores também podem receber acesso ao painel de entregas.</p>
          <div className="record-form-grid">
            {!accountWorkerId && <label className="record-field"><span className="field-label">Nome</span><input autoComplete="name" className="text-input" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} /></label>}
            {!accountWorkerId && <label className="record-field"><span className="field-label">Telefone <span className="field-optional">opcional</span></span><input autoComplete="tel" className="text-input" maxLength={64} onChange={(event) => setPhone(event.target.value)} type="tel" value={phone} /></label>}
            {!accountWorkerId && <label className="record-field"><span className="field-label">Salário mensal <span className="field-optional">opcional</span></span><input className="text-input" inputMode="decimal" onChange={(event) => setMonthlySalary(event.target.value)} placeholder="0,00" value={monthlySalary} /><span className="section-footnote">Só entra nas saídas pagas quando você confirmar o pagamento.</span></label>}
            {!accountWorkerId && monthlySalary.trim() !== '' && <label className="record-field"><span className="field-label">Dia de pagar o salário</span><input className="text-input" inputMode="numeric" max="31" min="1" onChange={(event) => setSalaryDueDay(event.target.value)} required type="number" value={salaryDueDay} /></label>}
            {(accountWorkerId || memberType === 'delivery_driver') && <label className="record-field"><span className="field-label">E-mail de acesso</span><input autoComplete="email" autoCapitalize="none" className="text-input" maxLength={320} onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label>}
            {(accountWorkerId || memberType === 'delivery_driver') && <label className="record-field"><span className="field-label">Senha inicial</span><input autoComplete="new-password" className="text-input" minLength={8} maxLength={128} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>}
          </div>
          {(accountWorkerId || memberType === 'delivery_driver') && <p className="section-footnote">A senha inicial não será enviada por e-mail. Compartilhe-a diretamente com o entregador.</p>}
          <div className="record-form-actions"><button className="button button-primary" disabled={saving} type="submit">{saving ? 'Salvando…' : memberType === 'employee' && !accountWorkerId ? 'Cadastrar funcionário' : 'Cadastrar e criar acesso'}</button></div>
        </form>}

        <section className="surface-panel record-panel" aria-labelledby="team-members-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">PESSOAS</p><h2 id="team-members-title">Equipe cadastrada</h2></div><span className="neutral-status">{loading ? 'Carregando…' : `${activeCount} ativos`}</span></div>
          {loading ? <p className="inline-state" aria-live="polite">Carregando equipe…</p> : workers.length === 0 ? <p className="inline-state">Nenhum membro cadastrado.</p> : <ul className="worker-list team-worker-list">{workers.map((worker) => <li className={worker.is_active ? '' : 'record-inactive'} key={worker.id}>
            <span><strong>{worker.name}</strong><small>{worker.member_type === 'delivery_driver' ? 'Entregador' : 'Funcionário'} · {worker.phone || 'Telefone não informado'} · {worker.is_active ? 'Ativo' : 'Inativo'}{worker.member_type === 'delivery_driver' ? ` · ${worker.user_id ? 'Acesso ao painel ativo' : 'Sem acesso ao painel'}` : ''}{worker.monthly_salary_cents ? ` · Salário ${formatBRLExact(String(worker.monthly_salary_cents))}/mês, vence dia ${worker.salary_due_day}` : ''}</small></span>
            <div className="record-form-actions">
              {canManageBusiness(role) && <button className="text-button" onClick={() => { setSalaryEditWorkerId(salaryEditWorkerId === worker.id ? null : worker.id); setSalaryEditAmount(worker.monthly_salary_cents ? (Number(worker.monthly_salary_cents) / 100).toFixed(2).replace('.', ',') : ''); setSalaryEditDueDay(worker.salary_due_day?.toString() ?? ''); setError(null) }} type="button">{salaryEditWorkerId === worker.id ? 'Fechar salário' : 'Editar salário'}</button>}
              {canManageBusiness(role) && worker.member_type === 'delivery_driver' && worker.is_active && !worker.user_id && <><button className="text-button" onClick={() => { setAccountWorkerId(worker.id); setMemberType('delivery_driver'); setName(worker.name); setPhone(worker.phone ?? ''); setEmail(''); setPassword(''); setShowForm(true); setError(null); setNotice(null) }} type="button">Criar acesso</button><button className="text-button" onClick={() => { setLinkWorkerId(linkWorkerId === worker.id ? null : worker.id); setLinkEmail(''); setError(null) }} type="button">{linkWorkerId === worker.id ? 'Fechar' : 'Conectar conta existente'}</button></>}
              {canManageBusiness(role) && worker.member_type === 'delivery_driver' && worker.user_id && <button className="text-button" onClick={() => setConfirmUnlinkWorkerId(confirmUnlinkWorkerId === worker.id ? null : worker.id)} type="button">{confirmUnlinkWorkerId === worker.id ? 'Cancelar' : 'Remover acesso'}</button>}
              {canManageBusiness(role) && worker.member_type === 'delivery_driver' && worker.user_id && <Link className="text-button" to="/entregador/visualizar">Prévia do painel</Link>}
              <button className="text-button" disabled={actionWorkerId !== null} onClick={() => void setWorkerActive(worker)} type="button">{actionWorkerId === worker.id ? 'Salvando…' : worker.is_active ? 'Desativar' : 'Reativar'}</button>
            </div>
            {salaryEditWorkerId === worker.id && <form className="worker-access-form record-form-grid" onSubmit={(event) => void saveSalary(worker, event)}>
              <label className="record-field"><span className="field-label">Salário mensal</span><input className="text-input" inputMode="decimal" onChange={(event) => setSalaryEditAmount(event.target.value)} placeholder="0,00" value={salaryEditAmount} /></label>
              <label className="record-field"><span className="field-label">Dia de pagar</span><input className="text-input" inputMode="numeric" max="31" min="1" onChange={(event) => setSalaryEditDueDay(event.target.value)} required={salaryEditAmount.trim() !== ''} type="number" value={salaryEditDueDay} /></label>
              <button className="button button-secondary" disabled={actionWorkerId !== null} type="submit">{actionWorkerId === worker.id ? 'Salvando…' : 'Salvar salário'}</button>
            </form>}
            {linkWorkerId === worker.id && <form className="worker-access-form" onSubmit={(event) => void connectDriver(event, worker)}>
              <label className="record-field"><span className="field-label">E-mail da conta</span><input autoComplete="off" className="text-input" onChange={(event) => setLinkEmail(event.target.value)} required type="email" value={linkEmail} /></label>
              <p className="section-footnote">Use esta opção se o entregador já tem uma conta criada neste sistema.</p>
              <button className="button button-secondary" disabled={actionWorkerId !== null} type="submit">{actionWorkerId === worker.id ? 'Conectando…' : 'Conectar conta existente'}</button>
            </form>}
            {confirmUnlinkWorkerId === worker.id && <div className="worker-access-form" role="group" aria-label={`Remover o painel de ${worker.name}`}>
              <p className="section-footnote">O entregador perderá acesso ao painel; o cadastro e o histórico de entregas permanecem.</p>
              <button className="button button-secondary" disabled={actionWorkerId !== null} onClick={() => void unlinkDriver(worker)} type="button">{actionWorkerId === worker.id ? 'Removendo…' : 'Confirmar remoção'}</button>
            </div>}
          </li>)}</ul>}
          <div className="team-driver-signup"><span>Entregadores podem entrar pelo mesmo endereço do sistema e veem apenas o painel de entregas. Funcionários gerais ficam no cadastro e na folha.</span></div>
        </section>

        <section className="surface-panel record-panel" id="pagamentos-equipe" aria-labelledby="team-payroll-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">SALÁRIOS</p><h2 id="team-payroll-title">Salários da equipe</h2></div><span className="neutral-status">{salaryStatus ? `${salaryStatus.overdue_count} atrasados · ${salaryStatus.due_today_count} hoje` : 'Carregando…'}</span></div>
          <p className="section-footnote">Ao confirmar um salário como pago, ele entra nas despesas. O sistema não faz transferências.</p>
          {loading ? <p className="inline-state" aria-live="polite">Carregando salários…</p> : !salaryStatus || salaryStatus.items.length === 0 ? <p className="inline-state">Nenhum salário para este mês. Cadastre o valor e o dia de pagamento na equipe.</p> : <ul className="worker-list team-worker-list">{salaryStatus.items.map((item) => {
            const itemKey = `${item.worker_id}:${item.period_start}`
            const isPaid = item.paid_on !== null
            const isOverdue = !isPaid && item.due_on < today
            return <li key={itemKey}>
              <span><strong>{item.name} · {item.period_start.slice(5, 7)}/{item.period_start.slice(0, 4)}</strong><small>{formatBRLExact(item.amount_cents)} · vence {formatBusinessDate(item.due_on)} · {isPaid ? `Pago em ${formatBusinessDate(item.paid_on!)}` : isOverdue ? 'Atrasado' : item.due_on === today ? 'Vence hoje' : 'A vencer'}</small></span>
              {!isPaid && <div className="record-form-actions">{confirmSalaryItem && `${confirmSalaryItem.worker_id}:${confirmSalaryItem.period_start}` === itemKey ? <><span className="section-footnote">Confirma que esse salário já foi pago?</span><button className="button button-primary" disabled={payingSalaryKey !== null} onClick={() => void recordSalaryPayment(item)} type="button">{payingSalaryKey === itemKey ? 'Registrando…' : 'Confirmar pagamento'}</button><button className="text-button" disabled={payingSalaryKey !== null} onClick={() => setConfirmSalaryItem(null)} type="button">Cancelar</button></> : <button className="text-button" onClick={() => setConfirmSalaryItem(item)} type="button">Registrar como pago</button>}</div>}
            </li>
          })}</ul>}
        </section>

        <section className="surface-panel record-panel team-help-panel" aria-labelledby="team-orders-title">
          <div><p className="eyebrow">ATRIBUIÇÃO DE PEDIDOS</p><h2 id="team-orders-title">A equipe trabalha junto com as entregas</h2><p>Depois do cadastro, escolha o entregador ao organizar cada entrega.</p></div>
          <Link className="button button-secondary" to="/entregas">Abrir entregas</Link>
        </section>
      </>}
    </div>
  )
}
