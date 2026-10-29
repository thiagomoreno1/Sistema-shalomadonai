import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'

export function SettingsPage() {
  const { session } = useAuth()
  const business = useBusiness()

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">SISTEMA</p>
          <h1>Configurações</h1>
          <p className="page-description">Acesso do proprietário e preparação gradual das integrações.</p>
        </div>
        <span className="module-heading-icon"><Icon name="settings" /></span>
      </header>

      <section className="surface-panel settings-panel" aria-labelledby="account-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CONTA</p>
            <h2 id="account-title">Acesso do proprietário</h2>
          </div>
          <span className="connected-status"><span className="connected-dot" /> Sessão ativa</span>
        </div>
        <dl className="settings-detail-list">
          <div><dt>Empresa</dt><dd>{business.name}</dd></div>
          <div><dt>E-mail</dt><dd>{session?.user.email ?? 'Conta autenticada'}</dd></div>
          <div><dt>Moeda</dt><dd>Real brasileiro (BRL)</dd></div>
          <div><dt>Fuso horário</dt><dd>America/Sao_Paulo</dd></div>
        </dl>
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
            <p className="settings-integration-copy">Área reservada para configurar a conta de atendimento.</p>
            <dl className="settings-detail-list settings-integration-details">
              <div><dt>Número de telefone</dt><dd>Não informado</dd></div>
              <div><dt>Segredo da conta</dt><dd>Não cadastrado</dd></div>
            </dl>
            <p className="settings-integration-note">Nenhum telefone ou segredo de conta foi inserido.</p>
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
