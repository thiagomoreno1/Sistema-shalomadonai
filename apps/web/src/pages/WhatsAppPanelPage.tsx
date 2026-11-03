import { Link } from 'react-router-dom'
import { Icon } from '../components/Icon'

const dashboardUrl = import.meta.env.VITE_CHATWOOT_DASHBOARD_URL?.trim() ?? ''
const dashboardConfigError = import.meta.env.VITE_CHATWOOT_DASHBOARD_CONFIG_ERROR?.trim() ?? ''

export function WhatsAppPanelPage() {
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">ATENDIMENTO</p>
          <h1>WhatsApp</h1>
          <p className="page-description">Painel de conversas do Chatwoot dentro do Shalom Adonai.</p>
        </div>
        <span className="module-heading-icon"><Icon name="message" /></span>
      </header>

      {dashboardConfigError ? (
        <section className="surface-panel whatsapp-connection-state" aria-labelledby="chatwoot-config-error" role="alert">
          <span className="empty-icon"><Icon name="message" /></span>
          <p className="eyebrow">CONFIGURAÇÃO INVÁLIDA</p>
          <h2 id="chatwoot-config-error">Não foi possível abrir o painel do Chatwoot</h2>
          <p>A URL pública configurada para o painel está inválida. Corrija a configuração de publicação e carregue o Shalom novamente.</p>
          <Link className="quiet-link" to="/configuracoes">Ver preparação da conexão <Icon name="arrow" /></Link>
        </section>
      ) : !dashboardUrl ? (
        <section className="surface-panel whatsapp-connection-state" aria-labelledby="chatwoot-pending-title">
          <span className="empty-icon"><Icon name="message" /></span>
          <p className="eyebrow">ETAPA 1 · PAINEL CHATWOOT</p>
          <h2 id="chatwoot-pending-title">O painel será exibido aqui após a implantação do Chatwoot</h2>
          <p>Ainda faltam a instância, o domínio e a URL da caixa. Nenhuma conversa de demonstração foi criada.</p>
          <ol className="whatsapp-setup-steps">
            <li><span>1</span><div><strong>Hospedar o Chatwoot</strong><small>Usaremos a VPS Contabo e um endereço HTTPS próprio.</small></div><span className="neutral-status">Pendente</span></li>
            <li><span>2</span><div><strong>Permitir o painel dentro do Shalom</strong><small>O Caddy da hospedagem Chatwoot aceitará somente a origem configurada para o aplicativo.</small></div><span className="neutral-status">Pendente</span></li>
            <li><span>3</span><div><strong>Entrar na conta Chatwoot</strong><small>O acesso ao Chatwoot terá uma sessão própria; o login do Shalom não entra automaticamente.</small></div><span className="neutral-status">Pendente</span></li>
          </ol>
          <Link className="quiet-link" to="/configuracoes">Ver preparação da conexão <Icon name="arrow" /></Link>
          <Link className="quiet-link" to="/whatsapp/caixa-shalom">Abrir a caixa nativa do Shalom <Icon name="arrow" /></Link>
        </section>
      ) : (
        <section className="surface-panel chatwoot-embed-panel" aria-label="Painel de atendimento Chatwoot">
          <div className="chatwoot-embed-toolbar">
            <p className="section-footnote">Entre com seu usuário do Chatwoot. A sessão é separada do Shalom; os vínculos com clientes e pedidos ficam na caixa nativa.</p>
            <div className="chatwoot-embed-actions">
              <Link className="quiet-link" to="/whatsapp/caixa-shalom">Caixa nativa do Shalom</Link>
              <a className="button button-secondary" href={dashboardUrl} rel="noopener noreferrer" target="_blank">Abrir em nova guia</a>
            </div>
          </div>
          <iframe
            className="chatwoot-embed-frame"
            referrerPolicy="no-referrer"
            src={dashboardUrl}
            title="Painel de atendimento Chatwoot"
          />
          <p className="section-footnote">Se o painel não carregar neste navegador, abra-o em uma nova guia.</p>
        </section>
      )}
    </div>
  )
}
