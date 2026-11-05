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
    if (cleanName.length < 2 || cleanName.length > 120 || cleanPhone.length > 64) {
      setError('Confira o nome e o telefone do entregador.')
      return
    }
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const { error: insertError } = await supabaseClient.from('delivery_workers').insert({
        business_id: businessId,
        name: cleanName,
        phone: cleanPhone || null,
      })
      if (insertError) {
        setError('Não foi possível cadastrar o entregador. Tente novamente.')
        return
      }
      setName('')
      setPhone('')
      setShowForm(false)
      setNotice('Entregador cadastrado. Agora você pode conectar o painel dele.')
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
        setError('Não foi possível conectar. Confira se o entregador já criou a conta e confirmou o e-mail.')
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

  async function copySignupLink() {
    const signupUrl = new URL('/criar-conta-entregador', window.location.origin).toString()
    try {
      await navigator.clipboard.writeText(signupUrl)
      setNotice('Link de cadastro copiado. Envie ao entregador para ele criar a própria conta.')
    } catch {
      setNotice(`Envie este link ao entregador: ${signupUrl}`)
    }
  }

  const activeCount = workers.filter((worker) => worker.is_active).length

  return (
    <div className="page-stack team-page">
      <header className="page-heading">
        <div><p className="eyebrow">GESTÃO DE ACESSOS</p><h1>Equipe</h1><p className="page-description">Cadastre entregadores e conecte cada pessoa ao próprio painel.</p></div>
        {role === 'owner' && <button className="button button-primary" onClick={() => { setShowForm((open) => !open); setError(null); setNotice(null) }} type="button"><Icon name="plus" /> Novo entregador</button>}
      </header>

      {notice && <p className="form-message form-message-success" role="status">{notice}</p>}
      {error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => void loadWorkers()} type="button">Tentar novamente</button></div>}

      {role !== 'owner' ? <section className="surface-panel team-state"><h2>Acesso da equipe</h2><p>A gestão da equipe é feita pela pessoa proprietária da empresa.</p></section> : <>
        {showForm && <form className="surface-panel record-form" onSubmit={(event) => void createWorker(event)}>
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">CADASTRO</p><h2>Novo entregador</h2></div><button className="text-button" disabled={saving} onClick={() => setShowForm(false)} type="button">Fechar</button></div>
          <p className="section-footnote">Cadastre os dados básicos. A conta e a senha são criadas pelo próprio entregador no link de cadastro.</p>
          <div className="record-form-grid">
            <label className="record-field"><span className="field-label">Nome</span><input autoComplete="name" className="text-input" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} /></label>
            <label className="record-field"><span className="field-label">Telefone <span className="field-optional">opcional</span></span><input autoComplete="tel" className="text-input" maxLength={64} onChange={(event) => setPhone(event.target.value)} type="tel" value={phone} /></label>
          </div>
          <div className="record-form-actions"><button className="button button-primary" disabled={saving} type="submit">{saving ? 'Salvando…' : 'Salvar entregador'}</button></div>
        </form>}

        <section className="surface-panel record-panel" aria-labelledby="team-drivers-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">ENTREGAS</p><h2 id="team-drivers-title">Entregadores</h2></div><span className="neutral-status">{loading ? 'Carregando…' : `${activeCount} ativos`}</span></div>
          {loading ? <p className="inline-state" aria-live="polite">Carregando equipe…</p> : workers.length === 0 ? <p className="inline-state">Nenhum entregador cadastrado.</p> : <ul className="worker-list team-worker-list">{workers.map((worker) => <li className={worker.is_active ? '' : 'record-inactive'} key={worker.id}>
            <span><strong>{worker.name}</strong><small>{worker.phone || 'Telefone não informado'} · {worker.is_active ? 'Ativo' : 'Inativo'} · {worker.user_id ? 'Painel conectado' : 'Painel não conectado'}</small></span>
            <div className="record-form-actions">
              {role === 'owner' && worker.is_active && !worker.user_id && <button className="text-button" onClick={() => { setLinkWorkerId(linkWorkerId === worker.id ? null : worker.id); setLinkEmail(''); setError(null) }} type="button">{linkWorkerId === worker.id ? 'Fechar' : 'Conectar painel'}</button>}
              {role === 'owner' && worker.user_id && <button className="text-button" onClick={() => setConfirmUnlinkWorkerId(confirmUnlinkWorkerId === worker.id ? null : worker.id)} type="button">{confirmUnlinkWorkerId === worker.id ? 'Cancelar' : 'Remover acesso'}</button>}
              <button className="text-button" disabled={actionWorkerId !== null} onClick={() => void setWorkerActive(worker)} type="button">{actionWorkerId === worker.id ? 'Salvando…' : worker.is_active ? 'Desativar' : 'Reativar'}</button>
            </div>
            {linkWorkerId === worker.id && <form className="worker-access-form" onSubmit={(event) => void connectDriver(event, worker)}>
              <label className="record-field"><span className="field-label">E-mail da conta do entregador</span><input autoComplete="off" className="text-input" onChange={(event) => setLinkEmail(event.target.value)} required type="email" value={linkEmail} /></label>
              <p className="section-footnote">A conta precisa ter sido criada pelo entregador. Não use a conta da gestão.</p>
              <button className="button button-secondary" disabled={actionWorkerId !== null} type="submit">{actionWorkerId === worker.id ? 'Conectando…' : 'Conectar ao painel'}</button>
            </form>}
            {confirmUnlinkWorkerId === worker.id && <div className="worker-access-form" role="group" aria-label={`Remover o painel de ${worker.name}`}>
              <p className="section-footnote">O entregador perderá acesso ao painel; o cadastro e o histórico de entregas permanecem.</p>
              <button className="button button-secondary" disabled={actionWorkerId !== null} onClick={() => void unlinkDriver(worker)} type="button">{actionWorkerId === worker.id ? 'Removendo…' : 'Confirmar remoção'}</button>
            </div>}
          </li>)}</ul>}
          <div className="team-driver-signup"><span>Envie o link para o entregador criar a própria conta.</span><button className="text-button" onClick={() => void copySignupLink()} type="button">Copiar link de cadastro</button></div>
        </section>

        <section className="surface-panel record-panel team-help-panel" aria-labelledby="team-orders-title">
          <div><p className="eyebrow">ATRIBUIÇÃO DE PEDIDOS</p><h2 id="team-orders-title">A equipe trabalha junto com as entregas</h2><p>Depois do cadastro, escolha o entregador ao organizar cada entrega.</p></div>
          <Link className="button button-secondary" to="/entregas">Abrir entregas</Link>
        </section>
      </>}
    </div>
  )
}
