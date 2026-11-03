import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { ACCENT_COLORS, useTheme } from '../theme/ThemeProvider'
import { supabaseClient } from '../lib/supabase'

type AccessRequest = {
  id: string
  user_id: string
  email: string
  created_at: string
}

export function SettingsPage() {
  const { session } = useAuth()
  const business = useBusiness()
  const { accent, setAccent, theme } = useTheme()
  const [accessRequests, setAccessRequests] = useState<AccessRequest[]>([])
  const [requestsLoading, setRequestsLoading] = useState(true)
  const [requestActionId, setRequestActionId] = useState<string | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [requestMessage, setRequestMessage] = useState<string | null>(null)

  const loadAccessRequests = useCallback(async () => {
    if (!supabaseClient || business.role !== 'owner') return
    setRequestsLoading(true)
    setRequestError(null)
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

  useEffect(() => { void loadAccessRequests() }, [loadAccessRequests])

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

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">SISTEMA</p>
          <h1>Configurações</h1>
          <p className="page-description">Conta da equipe de gestão e preparação gradual das integrações.</p>
        </div>
        <span className="module-heading-icon"><Icon name="settings" /></span>
      </header>

      <section className="surface-panel settings-panel" aria-labelledby="account-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CONTA</p>
            <h2 id="account-title">Equipe de gestão</h2>
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
            {requestError && <p className="form-message form-message-error" role="alert">{requestError}</p>}
            {requestMessage && <p className="form-message form-message-success" role="status">{requestMessage}</p>}
            {requestsLoading ? (
              <p className="settings-team-empty" role="status">Carregando pedidos…</p>
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

      <section className="surface-panel settings-panel" aria-labelledby="appearance-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">APARÊNCIA</p>
            <h2 id="appearance-title">Cor de destaque</h2>
          </div>
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

      <section className="surface-panel settings-panel settings-integration-panel" aria-labelledby="connections-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">INTEGRAÇÕES</p>
            <h2 id="connections-title">Preparação gradual</h2>
          </div>
          <span className="neutral-status">Nenhuma conexão ativa</span>
        </div>
        <div className="settings-integration-grid">
          <article className="settings-integration-card" aria-labelledby="whatsapp-title">
            <div className="settings-integration-heading">
              <h3 id="whatsapp-title">Caixa de entrada WhatsApp</h3>
              <span className="neutral-status">Não conectada</span>
            </div>
            <p className="settings-integration-copy">A caixa de entrada do Shalom usará o Chatwoot para listar e responder conversas. Se a infraestrutura ficar na Contabo, ela hospedará o Chatwoot; a conexão continuará protegida pelo servidor.</p>
            <dl className="settings-detail-list settings-integration-details">
              <div><dt>Provedor de atendimento</dt><dd>Chatwoot · preparação em andamento</dd></div>
              <div><dt>Infraestrutura</dt><dd>Contabo, se escolhida para hospedagem; versão própria 4.19+</dd></div>
              <div><dt>Número WhatsApp Business</dt><dd>Não informado</dd></div>
              <div><dt>Credenciais</dt><dd>Não configuradas nos secrets do servidor</dd></div>
            </dl>
            <p className="settings-integration-note">Nenhuma mensagem é enviada ou recebida até concluir a conexão e validar o canal real.</p>
          </article>

          <article className="settings-integration-card" aria-labelledby="bank-title">
            <div className="settings-integration-heading">
              <h3 id="bank-title">Movimentação bancária</h3>
              <span className="neutral-status">Planejado</span>
            </div>
            <p className="settings-integration-copy">Open Finance é a abordagem planejada para trazer os movimentos ao sistema.</p>
            <dl className="settings-detail-list settings-integration-details">
              <div><dt>Conexão Open Finance</dt><dd>Não iniciada</dd></div>
              <div><dt>Teste de conexão</dt><dd>Não realizado</dd></div>
            </dl>
            <p className="settings-integration-note"><Link to="/financeiro/bancos">Abrir conciliação bancária</Link></p>
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
        <p className="section-footnote">As integrações só serão marcadas como ativas após configuração e teste real com a conta ou serviço aprovado.</p>
      </section>

      <section className="surface-panel settings-panel" aria-labelledby="records-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">DADOS DA OPERAÇÃO</p>
            <h2 id="records-title">Preenchimento progressivo</h2>
          </div>
        </div>
        <p className="settings-records-note">Clientes, produtos, estoque, pedidos e financeiro serão preenchidos progressivamente pelos módulos existentes do sistema.</p>
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
