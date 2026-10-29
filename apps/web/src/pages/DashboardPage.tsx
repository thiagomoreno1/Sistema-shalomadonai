import { Link } from 'react-router-dom'
import { Icon } from '../components/Icon'

const businessDate = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'full',
  timeZone: 'America/Sao_Paulo',
}).format(new Date())

const indicators = [
  { label: 'Vendas registradas', note: 'Sem lançamentos ainda' },
  { label: 'Valores recebidos', note: 'Sem recebimentos ainda' },
  { label: 'A receber', note: 'Sem contas cadastradas' },
  { label: 'Despesas', note: 'Sem despesas cadastradas' },
]

const integrations = [
  { label: 'WhatsApp', state: 'Conexão pendente' },
  { label: 'Banco', state: 'Método pendente' },
  { label: 'Fiscal', state: 'Dados pendentes' },
]

export function DashboardPage() {
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{businessDate}</p>
          <h1>Visão geral</h1>
          <p className="page-description">O que precisa de atenção hoje?</p>
        </div>
        <span className="period-badge">Operação</span>
      </header>

      <section className="attention-panel" aria-labelledby="attention-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">PRÓXIMAS AÇÕES</p>
            <h2 id="attention-title">Precisa de atenção</h2>
          </div>
          <span className="neutral-status">Aguardando registros</span>
        </div>
        <div className="empty-state">
          <span className="empty-icon"><Icon name="check" /></span>
          <div>
            <h3>Nenhum acompanhamento registrado</h3>
            <p>Chamadas, retornos, cobranças e entregas aparecerão aqui quando forem cadastrados no sistema.</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="finance-title">
        <div className="section-heading section-heading-compact">
          <div>
            <p className="eyebrow">MOVIMENTAÇÃO</p>
            <h2 id="finance-title">Resumo financeiro</h2>
          </div>
          <Link className="quiet-link" to="/financeiro">Ver financeiro <Icon name="arrow" /></Link>
        </div>
        <div className="indicator-grid">
          {indicators.map((indicator) => (
            <article className="indicator-card" key={indicator.label}>
              <p>{indicator.label}</p>
              <strong aria-label="Sem dados">—</strong>
              <span>{indicator.note}</span>
            </article>
          ))}
        </div>
        <p className="section-footnote">Os valores serão preenchidos a partir dos registros do sistema. Resultado e lucro só serão exibidos após validação da fórmula com a empresa.</p>
      </section>

      <div className="dashboard-columns">
        <section className="surface-panel" aria-labelledby="integrations-title">
          <div className="section-heading section-heading-compact">
            <div>
              <p className="eyebrow">CONFIGURAÇÃO</p>
              <h2 id="integrations-title">Conexões</h2>
            </div>
            <Link className="quiet-link" to="/configuracoes">Ver status <Icon name="arrow" /></Link>
          </div>
          <ul className="status-list">
            {integrations.map((item) => (
              <li key={item.label}>
                <span className="status-indicator" aria-hidden="true" />
                <span className="status-name">{item.label}</span>
                <span className="status-copy">{item.state}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="surface-panel stock-panel" aria-labelledby="stock-title">
          <div className="section-heading section-heading-compact">
            <div>
              <p className="eyebrow">ESTOQUE</p>
              <h2 id="stock-title">Nível de atenção</h2>
            </div>
            <Icon className="section-icon" name="box" />
          </div>
          <div className="small-empty-state">
            <p>Cadastre os produtos e os limites mínimos para acompanhar o estoque.</p>
            <Link className="quiet-link" to="/estoque">Abrir estoque <Icon name="arrow" /></Link>
          </div>
        </section>
      </div>

      <section className="quick-links" aria-label="Atalhos">
        <Link className="quick-link" to="/atendimento"><Icon name="phone" /><span><strong>Atendimento</strong><small>Chamadas e retornos</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
        <Link className="quick-link" to="/pedidos"><Icon name="bag" /><span><strong>Pedidos</strong><small>Vendas e entregas</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
        <Link className="quick-link" to="/clientes"><Icon name="people" /><span><strong>Clientes</strong><small>Cadastros e histórico</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
      </section>
    </div>
  )
}
