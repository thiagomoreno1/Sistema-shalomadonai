import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { supabaseClient } from '../lib/supabase'

type DeliveryWorker = { id: string; name: string; phone: string | null; is_active: boolean; user_id: string | null }

export function TeamPage() {
  const { id: businessId, role } = useBusiness()
  const [workers, setWorkers] = useState<DeliveryWorker[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [accountWorkerId, setAccountWorkerId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [linkWorkerId, setLinkWorkerId] = useState<string | null>(null)
  const [linkEmail, setLinkEmail] = useState('')
  const [actionWorkerId, setActionWorkerId] = useState<string | null>(null)
  const [confirmUnlinkWorkerId, setConfirmUnlinkWorkerId] = useState<string | null>(null)

  const loadWorkers = useCallback(async () => {
    if (!supabaseClient || role !== 'owner') {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const { data, error: loadError } = await supabaseClient
        .from('delivery_workers')
        .select('id, name, phone, is_active, user_id')
        .eq('business_id', businessId)
        .order('is_active', { ascending: false })
        .order('name', { ascending: true })
      if (loadError) setError('Não foi possível carregar a equipe de entregas.')
      else setWorkers((data ?? []) as DeliveryWorker[])
    } catch {
      setError('Não foi possível carregar a equipe de entregas.')
    } finally {
      setLoading(false)
    }
  }, [businessId, role])

  useEffect(() => { void loadWorkers() }, [loadWorkers])

  async function createWorker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || saving || role !== 'owner') return
    const cleanName = name.trim()
    const cleanPhone = phone.trim()
    const cleanEmail = email.trim().toLowerCase()
    if ((!accountWorkerId && (cleanName.length < 2 || cleanName.length > 120)) || cleanPhone.length > 64 || !cleanEmail || password.length < 8 || password.length > 128) {
      setError('Confira o nome, o e-mail e a senha. A senha precisa ter pelo menos 8 caracteres.')
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
        }).select('id').single()
        if (insertError || !workerData?.id) {
          setError('Não foi possível cadastrar o entregador. Tente novamente.')
          return
        }
        workerId = workerData.id
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
    if (!supabaseClient || actionWorkerId || role !== 'owner') return
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
    if (!supabaseClient || actionWorkerId || role !== 'owner') return
    setActionWorkerId(worker.id)
    setError(null)
    setNotice(null)
    try {
      const { error: updateError } = await supabaseClient.from('delivery_workers')
        .update({ is_active: !worker.is_active })
        .eq('business_id', businessId)
        .eq('id', worker.id)
      if (updateError) {
        setError('Não foi possível atualizar o entregador.')
        return
      }
      setNotice(worker.is_active ? 'Entregador desativado; o histórico foi mantido.' : 'Entregador reativado.')
      await loadWorkers()
    } catch {
      setError('Não foi possível atualizar o entregador.')
    } finally {
      setActionWorkerId(null)
    }
  }

  async function unlinkDriver(worker: DeliveryWorker) {
    if (!supabaseClient || actionWorkerId || role !== 'owner') return
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
        <div><p className="eyebrow">GESTÃO DE ACESSOS</p><h1>Equipe</h1><p className="page-description">Crie o acesso do entregador aqui. Depois, ele entra pelo mesmo login e vê apenas as entregas atribuídas.</p></div>
        {role === 'owner' && <div className="team-heading-actions"><Link className="button button-secondary" to="/entregador/visualizar"><Icon name="truck" /> Visualizar painel</Link><button className="button button-primary" onClick={() => { setShowForm((open) => !open); setAccountWorkerId(null); setName(''); setPhone(''); setEmail(''); setPassword(''); setError(null); setNotice(null) }} type="button"><Icon name="plus" /> Novo entregador</button></div>}
      </header>

      {notice && <p className="form-message form-message-success" role="status">{notice}</p>}
      {error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => void loadWorkers()} type="button">Tentar novamente</button></div>}

      {role !== 'owner' ? <section className="surface-panel team-state"><h2>Acesso da equipe</h2><p>A gestão da equipe é feita pela pessoa proprietária da empresa.</p></section> : <>
        {showForm && <form className="surface-panel record-form" onSubmit={(event) => void createWorker(event)}>
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">ACESSO DO ENTREGADOR</p><h2>{accountWorkerId ? `Criar acesso para ${workers.find((worker) => worker.id === accountWorkerId)?.name ?? 'entregador'}` : 'Novo entregador'}</h2></div><button className="text-button" disabled={saving} onClick={() => { setShowForm(false); setAccountWorkerId(null); setPassword('') }} type="button">Fechar</button></div>
          <p className="section-footnote">O acesso fica ligado a este cadastro. O entregador usa o mesmo endereço de login da gestão.</p>
          <div className="record-form-grid">
            {!accountWorkerId && <label className="record-field"><span className="field-label">Nome</span><input autoComplete="name" className="text-input" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} /></label>}
            {!accountWorkerId && <label className="record-field"><span className="field-label">Telefone <span className="field-optional">opcional</span></span><input autoComplete="tel" className="text-input" maxLength={64} onChange={(event) => setPhone(event.target.value)} type="tel" value={phone} /></label>}
            <label className="record-field"><span className="field-label">E-mail de acesso</span><input autoComplete="email" autoCapitalize="none" className="text-input" maxLength={320} onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label>
            <label className="record-field"><span className="field-label">Senha inicial</span><input autoComplete="new-password" className="text-input" minLength={8} maxLength={128} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
          </div>
          <p className="section-footnote">A senha inicial não será enviada por e-mail. Compartilhe-a diretamente com o entregador.</p>
          <div className="record-form-actions"><button className="button button-primary" disabled={saving} type="submit">{saving ? 'Criando acesso…' : 'Cadastrar e criar acesso'}</button></div>
        </form>}

        <section className="surface-panel record-panel" aria-labelledby="team-drivers-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">ENTREGAS</p><h2 id="team-drivers-title">Entregadores</h2></div><span className="neutral-status">{loading ? 'Carregando…' : `${activeCount} ativos`}</span></div>
          {loading ? <p className="inline-state" aria-live="polite">Carregando equipe…</p> : workers.length === 0 ? <p className="inline-state">Nenhum entregador cadastrado.</p> : <ul className="worker-list team-worker-list">{workers.map((worker) => <li className={worker.is_active ? '' : 'record-inactive'} key={worker.id}>
            <span><strong>{worker.name}</strong><small>{worker.phone || 'Telefone não informado'} · {worker.is_active ? 'Ativo' : 'Inativo'} · {worker.user_id ? 'Acesso ativo' : 'Sem acesso ao painel'}</small></span>
            <div className="record-form-actions">
              {role === 'owner' && worker.is_active && !worker.user_id && <><button className="text-button" onClick={() => { setAccountWorkerId(worker.id); setName(worker.name); setPhone(worker.phone ?? ''); setEmail(''); setPassword(''); setShowForm(true); setError(null); setNotice(null) }} type="button">Criar acesso</button><button className="text-button" onClick={() => { setLinkWorkerId(linkWorkerId === worker.id ? null : worker.id); setLinkEmail(''); setError(null) }} type="button">{linkWorkerId === worker.id ? 'Fechar' : 'Vincular conta existente'}</button></>}
              {role === 'owner' && worker.user_id && <button className="text-button" onClick={() => setConfirmUnlinkWorkerId(confirmUnlinkWorkerId === worker.id ? null : worker.id)} type="button">{confirmUnlinkWorkerId === worker.id ? 'Cancelar' : 'Remover acesso'}</button>}
              {role === 'owner' && worker.user_id && <Link className="text-button" to="/entregador/visualizar">Prévia do painel</Link>}
              <button className="text-button" disabled={actionWorkerId !== null} onClick={() => void setWorkerActive(worker)} type="button">{actionWorkerId === worker.id ? 'Salvando…' : worker.is_active ? 'Desativar' : 'Reativar'}</button>
            </div>
            {linkWorkerId === worker.id && <form className="worker-access-form" onSubmit={(event) => void connectDriver(event, worker)}>
              <label className="record-field"><span className="field-label">E-mail da conta do entregador</span><input autoComplete="off" className="text-input" onChange={(event) => setLinkEmail(event.target.value)} required type="email" value={linkEmail} /></label>
              <p className="section-footnote">Use esta opção se o entregador já tem uma conta criada neste sistema.</p>
              <button className="button button-secondary" disabled={actionWorkerId !== null} type="submit">{actionWorkerId === worker.id ? 'Vinculando…' : 'Vincular conta existente'}</button>
            </form>}
            {confirmUnlinkWorkerId === worker.id && <div className="worker-access-form" role="group" aria-label={`Remover o painel de ${worker.name}`}>
              <p className="section-footnote">O entregador perderá acesso ao painel; o cadastro e o histórico de entregas permanecem.</p>
              <button className="button button-secondary" disabled={actionWorkerId !== null} onClick={() => void unlinkDriver(worker)} type="button">{actionWorkerId === worker.id ? 'Removendo…' : 'Confirmar remoção'}</button>
            </div>}
          </li>)}</ul>}
          <div className="team-driver-signup"><span>O entregador entra pelo mesmo endereço do sistema. A conta dele abre somente o painel de entregas.</span></div>
        </section>

        <section className="surface-panel record-panel team-help-panel" aria-labelledby="team-orders-title">
          <div><p className="eyebrow">ATRIBUIÇÃO DE PEDIDOS</p><h2 id="team-orders-title">A equipe trabalha junto com as entregas</h2><p>Depois do cadastro, escolha o entregador ao organizar cada entrega.</p></div>
          <Link className="button button-secondary" to="/entregas">Abrir entregas</Link>
        </section>
      </>}
    </div>
  )
}
