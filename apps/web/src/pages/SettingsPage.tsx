import { useAuth } from '../auth/AuthContext'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'

const pendingItems = [
  { name: 'WhatsApp', detail: 'Conta e número a confirmar' },
  { name: 'Movimentos bancários', detail: 'Banco e método de importação a confirmar' },
  { name: 'Documentos fiscais', detail: 'Dados da empresa e orientação contábil a confirmar' },
]

export function SettingsPage() {
  const { session } = useAuth()
  const business = useBusiness()

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">SISTEMA</p>
          <h1>Configurações</h1>
          <p className="page-description">Acesso do proprietário e status de configuração.</p>
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

      <section className="surface-panel settings-panel" aria-labelledby="connections-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">INTEGRAÇÕES</p>
            <h2 id="connections-title">Aguardando definição</h2>
          </div>
        </div>
        <ul className="settings-connection-list">
          {pendingItems.map((item) => (
            <li key={item.name}>
              <span className="status-indicator" aria-hidden="true" />
              <span><strong>{item.name}</strong><small>{item.detail}</small></span>
              <span className="neutral-status">Pendente</span>
            </li>
          ))}
        </ul>
        <p className="section-footnote">As conexões só serão marcadas como ativas depois de um teste real com a conta ou arquivo aprovado.</p>
      </section>
    </div>
  )
}
