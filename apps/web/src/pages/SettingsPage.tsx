import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { ProfileSettingsPanel } from '../components/ProfileSettingsPanel'
import { ACCENT_COLORS, useTheme } from '../theme/ThemeProvider'
import { supabaseClient } from '../lib/supabase'

type AccessRequest = {
  id: string
  user_id: string
  email: string
  created_at: string
}

type BusinessMember = {
  member_user_id: string
  member_email: string | null
  member_role: 'owner' | 'staff'
  member_created_at: string
}

export function SettingsPage() {
  const { session } = useAuth()
  const business = useBusiness()
  const { accent, setAccent, theme, toggleTheme } = useTheme()
  const [accessRequests, setAccessRequests] = useState<AccessRequest[]>([])
  const [requestsLoading, setRequestsLoading] = useState(true)
  const [requestActionId, setRequestActionId] = useState<string | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [requestMessage, setRequestMessage] = useState<string | null>(null)
  const [members, setMembers] = useState<BusinessMember[]>([])
  const [membersLoading, setMembersLoading] = useState(true)
  const [memberManagementPending, setMemberManagementPending] = useState(false)
  const [membersError, setMembersError] = useState<string | null>(null)
  const [membersMessage, setMembersMessage] = useState<string | null>(null)
  const membersMessageRef = useRef<HTMLParagraphElement>(null)
  const [pendingRemoval, setPendingRemoval] = useState<{ userId: string; email: string; requestId: string } | null>(null)
  const [removalError, setRemovalError] = useState<string | null>(null)
  const [removalSaving, setRemovalSaving] = useState(false)
  const removalConfirmRef = useRef<HTMLButtonElement>(null)
  const memberActionRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  useEffect(() => {
    if (pendingRemoval) removalConfirmRef.current?.focus()
  }, [pendingRemoval])

  useEffect(() => {
    if (membersMessage) membersMessageRef.current?.focus()
  }, [membersMessage])

  const loadAccessRequests = useCallback(async () => {
    if (!supabaseClient || business.role !== 'owner') return
    const { data, error } = await supabaseClient
      .from('business_access_requests')
      .select('id, user_id, email, created_at')
      .eq('business_id', business.id)
      .order('created_at', { ascending: true })
    if (error) {
      setRequestError('Não foi possível carregar os pedidos de acesso.')
    } else {
      setAccessRequests((data ?? []) as AccessRequest[])
    }
    setRequestsLoading(false)
  }, [business.id, business.role])

  const loadMembers = useCallback(async () => {
    if (!supabaseClient || business.role !== 'owner') {
      return
    }
    const { data, error } = await supabaseClient.rpc('list_business_members', { p_business_id: business.id })
    if (error) {
      if (isMissingRpc(error)) {
        setMemberManagementPending(true)
        setMembersError(null)
      } else setMembersError('Não foi possível carregar as pessoas com acesso. Tente novamente.')
    } else {
      setMemberManagementPending(false)
      setMembers((data ?? []) as BusinessMember[])
    }
    setMembersLoading(false)
  }, [business.id, business.role])

  useEffect(() => {
    if (!supabaseClient || business.role !== 'owner') return
    let active = true
    supabaseClient
      .from('business_access_requests')
      .select('id, user_id, email, created_at')
      .eq('business_id', business.id)
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (!active) return
        if (error) setRequestError('Não foi possível carregar os pedidos de acesso.')
        else setAccessRequests((data ?? []) as AccessRequest[])
        setRequestsLoading(false)
      })
    return () => { active = false }
  }, [business.id, business.role])

  useEffect(() => {
    if (!supabaseClient || business.role !== 'owner') return
    let active = true
    supabaseClient.rpc('list_business_members', { p_business_id: business.id }).then(({ data, error }) => {
      if (!active) return
      if (error) {
        if (isMissingRpc(error)) {
          setMemberManagementPending(true)
          setMembersError(null)
        } else setMembersError('Não foi possível carregar as pessoas com acesso. Tente novamente.')
      } else {
        setMemberManagementPending(false)
        setMembers((data ?? []) as BusinessMember[])
      }
      setMembersLoading(false)
    })
    return () => { active = false }
  }, [business.id, business.role])

  function retryAccessRequests() {
    setRequestsLoading(true)
    setRequestError(null)
    void loadAccessRequests()
  }

  function retryMembers() {
    setMembersLoading(true)
    setMembersError(null)
    void loadMembers()
  }

  async function approveAccessRequest(request: AccessRequest) {
    if (!supabaseClient) return
    if (!window.confirm(`Aprovar ${request.email} para acessar os dados da empresa?`)) return
    setRequestActionId(request.id)
    setRequestError(null)
    setRequestMessage(null)
    const { error } = await supabaseClient.rpc('approve_business_access_request', {
      p_business_id: business.id,
      p_user_id: request.user_id,
    })
    setRequestActionId(null)
    if (error) {
      setRequestError('Não foi possível aprovar este pedido. Atualize a lista e tente novamente.')
      return
    }
    setRequestMessage(`Acesso liberado para ${request.email}.`)
    setAccessRequests((current) => current.filter((item) => item.id !== request.id))
    setMembers((current) => current.some((member) => member.member_user_id === request.user_id) ? current : [
      ...current,
      { member_user_id: request.user_id, member_email: request.email, member_role: 'staff', member_created_at: new Date().toISOString() },
    ])
    void loadMembers()
  }

  async function rejectAccessRequest(request: AccessRequest) {
    if (!supabaseClient) return
    setRequestActionId(request.id)
    setRequestError(null)
    setRequestMessage(null)
    const { error } = await supabaseClient
      .from('business_access_requests')
      .delete()
      .eq('business_id', business.id)
      .eq('id', request.id)
    setRequestActionId(null)
    if (error) {
      setRequestError('Não foi possível remover este pedido. Atualize a lista e tente novamente.')
      return
    }
    setRequestMessage('Pedido recusado. A pessoa poderá solicitar novamente pela tela de acesso.')
    setAccessRequests((current) => current.filter((item) => item.id !== request.id))
  }

  function requestMemberRemoval(member: BusinessMember) {
    if (member.member_role !== 'staff' || !member.member_email) return
    setMembersMessage(null)
    setRemovalError(null)
    setPendingRemoval({ userId: member.member_user_id, email: member.member_email ?? 'esta conta', requestId: crypto.randomUUID() })
  }

  function cancelMemberRemoval(userId: string) {
    setPendingRemoval(null)
    setRemovalError(null)
    window.requestAnimationFrame(() => memberActionRefs.current[userId]?.focus())
  }

  async function confirmMemberRemoval() {
    if (!supabaseClient || !pendingRemoval || removalSaving) return
    setRemovalSaving(true)
    setRemovalError(null)
    const { error } = await supabaseClient.rpc('revoke_business_staff_access', {
      p_business_id: business.id,
      p_user_id: pendingRemoval.userId,
      p_request_id: pendingRemoval.requestId,
    })
    if (error) {
      if (isMissingRpc(error)) {
        setMemberManagementPending(true)
        setPendingRemoval(null)
        setRemovalSaving(false)
        setRemovalError(null)
        return
      }
      const { data: currentMembers, error: refreshError } = await supabaseClient.rpc('list_business_members', { p_business_id: business.id })
      if (!refreshError) {
        const refreshedMembers = (currentMembers ?? []) as BusinessMember[]
        setMemberManagementPending(false)
        setMembers(refreshedMembers)
        if (!refreshedMembers.some((member) => member.member_user_id === pendingRemoval.userId)) {
          setMembersMessage(`O acesso de ${pendingRemoval.email} foi removido. A pessoa poderá solicitar novamente.`)
          setPendingRemoval(null)
          setRemovalSaving(false)
          return
        }
      }
      setRemovalSaving(false)
      setRemovalError('Não foi possível confirmar a remoção. Tente novamente; o mesmo pedido será reutilizado com segurança.')
      return
    }
    setRemovalSaving(false)
    setMembers((current) => current.filter((member) => member.member_user_id !== pendingRemoval.userId))
    setMembersMessage(`O acesso de ${pendingRemoval.email} foi removido. A pessoa poderá solicitar novamente.`)
    setPendingRemoval(null)
    setRemovalError(null)
  }

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">SISTEMA</p>
          <h1>Configurações</h1>
          <p className="page-description">Seu perfil, senha, aparência, equipe e conexões.</p>
        </div>
        <span className="module-heading-icon"><Icon name="settings" /></span>
      </header>

      <ProfileSettingsPanel />

      <section className="surface-panel settings-panel" aria-labelledby="account-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CONTA</p>
            <h2 id="account-title">Conta da empresa</h2>
          </div>
          <span className="connected-status"><span className="connected-dot" /> Sessão ativa</span>
        </div>
        <dl className="settings-detail-list">
          <div><dt>Empresa</dt><dd>{business.name}</dd></div>
          <div><dt>E-mail</dt><dd>{session?.user.email ?? 'Conta autenticada'}</dd></div>
          <div><dt>Perfil</dt><dd>{business.role === 'owner' ? 'Proprietário' : 'Equipe'}</dd></div>
          <div><dt>Moeda</dt><dd>Real brasileiro (BRL)</dd></div>
          <div><dt>Fuso horário</dt><dd>America/Sao_Paulo</dd></div>
        </dl>
      </section>

      <section className="surface-panel settings-panel" aria-labelledby="access-requests-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ACESSO À EMPRESA</p>
            <h2 id="access-requests-title">Pedidos de acesso</h2>
          </div>
          {business.role === 'owner' && <span className="neutral-status">{requestsLoading ? 'Carregando…' : `${accessRequests.length} pendentes`}</span>}
        </div>
        {business.role === 'owner' ? (
          <>
            <p className="settings-appearance-description">Novas contas só acessam os dados da empresa depois que você aprovar o pedido.</p>
            {requestError && accessRequests.length > 0 && <p className="form-message form-message-error" role="alert">{requestError}</p>}
            {requestMessage && <p className="form-message form-message-success" role="status">{requestMessage}</p>}
            {requestsLoading ? (
              <p className="settings-team-empty" role="status">Carregando pedidos…</p>
            ) : requestError && accessRequests.length === 0 ? (
              <div className="settings-team-feedback"><p className="form-message form-message-error" role="alert">{requestError}</p><button className="button button-secondary" disabled={requestsLoading} onClick={retryAccessRequests} type="button">Tentar novamente</button></div>
            ) : accessRequests.length ? (
              <ul className="settings-access-requests">
                {accessRequests.map((request) => (
                  <li key={request.id}>
                    <div className="settings-access-request-main">
                      <strong>{request.email}</strong>
                      <small>Solicitado em {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(new Date(request.created_at))}</small>
                    </div>
                    <div className="settings-access-request-actions">
                      <button className="button button-secondary" disabled={requestActionId !== null} onClick={() => void rejectAccessRequest(request)} type="button">
                        Recusar
                      </button>
                      <button className="button button-primary" disabled={requestActionId !== null} onClick={() => void approveAccessRequest(request)} type="button">
                        {requestActionId === request.id ? 'Salvando…' : 'Aprovar'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="settings-team-empty">Nenhum pedido aguardando aprovação.</p>
            )}
            <p className="section-footnote">Como a confirmação por e-mail está desligada, confirme a identidade da pessoa por outro canal antes de aprovar.</p>
          </>
        ) : (
          <p className="settings-team-empty">A aprovação de novos acessos é feita pela pessoa proprietária da empresa.</p>
        )}
      </section>

      {business.role === 'owner' && <section className="surface-panel settings-panel" aria-labelledby="team-members-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">EQUIPE AUTORIZADA</p>
            <h2 id="team-members-title">Pessoas com acesso</h2>
          </div>
          <span className="neutral-status">{membersLoading ? 'Carregando…' : memberManagementPending ? 'Atualização pendente' : `${members.length} pessoas`}</span>
        </div>
        <p className="settings-appearance-description">O proprietário mantém o acesso de gestão. Você pode remover o acesso de integrantes da equipe quando necessário.</p>
        {memberManagementPending && <p className="settings-team-empty" role="status">A configuração do banco para gerenciar a equipe ainda está pendente. A lista completa e a remoção de acessos ficarão disponíveis quando a migration de gestão da equipe for aplicada.</p>}
        {membersError && <div className="settings-team-feedback"><p className="form-message form-message-error" role="alert">{membersError}</p><button className="button button-secondary" disabled={membersLoading} onClick={retryMembers} type="button">Tentar novamente</button></div>}
        {membersMessage && <p className="form-message form-message-success settings-team-success" ref={membersMessageRef} role="status" tabIndex={-1}>{membersMessage}</p>}
        {membersLoading ? (
          <p className="settings-team-empty" role="status">Carregando acessos…</p>
        ) : members.length ? (
          <ul className="settings-team-members">
            {members.map((member) => {
              const memberEmail = member.member_email ?? `Conta ${member.member_user_id.slice(0, 8)} · e-mail indisponível`
              const isPendingRemoval = pendingRemoval?.userId === member.member_user_id
              return <li key={member.member_user_id}>
                <div className="settings-access-request-main">
                  <strong>{memberEmail}</strong>
                  <small>{member.member_role === 'owner' ? 'Proprietário' : 'Equipe'} · Acesso desde {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(new Date(member.member_created_at))}</small>
                </div>
                {member.member_role === 'owner' ? <span className="neutral-status">Acesso principal</span> : memberManagementPending ? (
                  <span className="settings-team-member-note">Remoção disponível após atualizar o banco.</span>
                ) : member.member_email ? (
                  <div className="settings-team-member-actions">
                    <button className="button button-secondary" disabled={removalSaving || membersLoading || Boolean(membersError) || Boolean(removalError)} onClick={() => isPendingRemoval ? cancelMemberRemoval(member.member_user_id) : requestMemberRemoval(member)} ref={(element) => { memberActionRefs.current[member.member_user_id] = element }} type="button">
                      {isPendingRemoval ? 'Fechar confirmação' : 'Remover acesso'}
                    </button>
                  </div>
                ) : <span className="settings-team-member-note">Remoção indisponível sem e-mail para o histórico.</span>}
                {isPendingRemoval && pendingRemoval && <div className="settings-member-confirmation" role="group" aria-label={`Confirmar remoção do acesso de ${pendingRemoval.email}`}>
                  <p>Remover o acesso de <strong>{pendingRemoval.email}</strong>? A pessoa perderá o acesso à empresa e poderá enviar um novo pedido para a gestão.</p>
                  {removalError && <p className="form-message form-message-error" role="alert">{removalError}</p>}
                  <div className="settings-access-request-actions">
                    <button className="button button-primary" disabled={removalSaving} onClick={() => void confirmMemberRemoval()} ref={removalConfirmRef} type="button">{removalSaving ? 'Removendo…' : removalError ? 'Tentar novamente' : 'Confirmar remoção'}</button>
                    <button className="text-button" disabled={removalSaving} onClick={() => cancelMemberRemoval(member.member_user_id)} type="button">Manter acesso</button>
                  </div>
                </div>}
              </li>
            })}
          </ul>
        ) : !membersError && !memberManagementPending ? (
          <p className="settings-team-empty">Nenhum integrante da equipe tem acesso no momento.</p>
        ) : null}
      </section>}

      <section className="surface-panel settings-panel settings-team-entry" aria-labelledby="team-entry-title">
        <div className="section-heading">
          <div><p className="eyebrow">ENTREGAS</p><h2 id="team-entry-title">Equipe de entregadores</h2></div>
          <span className="neutral-status">Cadastro e painel</span>
        </div>
        <p className="settings-appearance-description">Cadastre entregadores, conecte cada conta ao painel e desative acessos quando necessário.</p>
        <div className="settings-records-shortcuts">
          <Link to="/equipe">Gerenciar equipe</Link>
          <Link to="/entregas">Ver entregas</Link>
        </div>
      </section>

      <section className="surface-panel settings-panel" aria-labelledby="appearance-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">APARÊNCIA</p>
            <h2 id="appearance-title">Tema e cor</h2>
          </div>
          <button className="button button-secondary settings-theme-action" onClick={toggleTheme} type="button">Ativar tema {theme === 'dark' ? 'claro' : 'escuro'}</button>
        </div>
        <p className="settings-appearance-description">Escolha a cor usada em botões, links e destaques. A preferência fica salva neste dispositivo.</p>
        <div className="accent-options" role="group" aria-label="Escolha a cor de destaque">
          {ACCENT_COLORS.map((color) => (
            <button
              aria-pressed={accent === color.id}
              className={`accent-option${accent === color.id ? ' is-selected' : ''}`}
              key={color.id}
              onClick={() => setAccent(color.id)}
              type="button"
            >
              <span aria-hidden="true" className="accent-option-swatch" style={{ '--swatch-color': theme === 'dark' ? color.dark : color.light } as CSSProperties} />
              <span>{color.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="surface-panel settings-panel" aria-labelledby="automations-title">
        <div className="section-heading">
          <div><p className="eyebrow">AUTOMAÇÃO</p><h2 id="automations-title">Regras da operação</h2></div>
          <span className="neutral-status">1 ativa</span>
        </div>
        <ul className="settings-automation-list">
          <li><span><strong>Baixa de estoque</strong><small>Automática no despacho ou na retirada confirmada.</small></span><span className="connected-status"><span className="connected-dot" /> Ativa</span></li>
          <li><span><strong>Mensagens pelo WhatsApp</strong><small>Aguardando a conexão do canal.</small></span><span className="neutral-status">Pendente</span></li>
          <li><span><strong>Avisos e lembretes</strong><small>Regras serão definidas antes de ativar.</small></span><span className="neutral-status">Não configurado</span></li>
        </ul>
      </section>

      <section className="surface-panel settings-panel settings-integration-panel" aria-labelledby="connections-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">INTEGRAÇÕES</p>
            <h2 id="connections-title">Conexões externas</h2>
          </div>
          <span className="neutral-status">Nenhuma conexão ativa</span>
        </div>
        <div className="settings-integration-grid">
          <article className="settings-integration-card" aria-labelledby="whatsapp-title">
            <div className="settings-integration-heading">
              <h3 id="whatsapp-title">Caixa de entrada WhatsApp</h3>
              <span className="neutral-status">Não conectada</span>
            </div>
            <p className="settings-integration-copy">O Shalom usa a Evolution API diretamente para receber mensagens, anexos e registros de chamadas.</p>
            <dl className="settings-detail-list settings-integration-details">
              <div><dt>Integração</dt><dd>Evolution API · conexão em preparação</dd></div>
              <div><dt>Servidor</dt><dd>Local · acesso protegido</dd></div>
              <div><dt>Número WhatsApp Business</dt><dd>Não informado</dd></div>
              <div><dt>Credenciais</dt><dd>Ainda não configuradas nos secrets do servidor</dd></div>
            </dl>
            <p className="settings-integration-note">A conexão só será considerada ativa após validar o webhook e trocar mensagens com um número de teste.</p>
          </article>

          <article className="settings-integration-card" aria-labelledby="fiscal-title">
            <div className="settings-integration-heading">
              <h3 id="fiscal-title">Configuração fiscal</h3>
              <span className="neutral-status">Pendente</span>
            </div>
            <p className="settings-integration-copy">Os demais dados fiscais serão definidos com orientação contábil.</p>
            <dl className="settings-detail-list settings-integration-details">
              <div><dt>Local da empresa</dt><dd>Niterói/RJ</dd></div>
              <div><dt>Regime tributário</dt><dd>Pendente de orientação contábil</dd></div>
              <div><dt>Tipos de documento</dt><dd>Pendente de orientação contábil</dd></div>
              <div><dt>Provedor fiscal</dt><dd>Pendente de orientação contábil</dd></div>
            </dl>
          </article>
        </div>
        <p className="section-footnote">Conexões aparecem como ativas após configuração e teste.</p>
      </section>

      <section className="surface-panel settings-panel" aria-labelledby="records-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">DADOS DA OPERAÇÃO</p>
            <h2 id="records-title">Preenchimento progressivo</h2>
          </div>
        </div>
        <p className="settings-records-note">Cadastre os dados nos próprios módulos.</p>
        <nav className="settings-records-shortcuts" aria-label="Atalhos para cadastrar dados">
          <Link to="/clientes">Clientes</Link>
          <Link to="/catalogo">Produtos</Link>
          <Link to="/estoque">Estoque</Link>
          <Link to="/pedidos">Pedidos</Link>
          <Link to="/financeiro">Financeiro</Link>
        </nav>
      </section>
    </div>
  )
}

function isMissingRpc(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'PGRST202'
}
