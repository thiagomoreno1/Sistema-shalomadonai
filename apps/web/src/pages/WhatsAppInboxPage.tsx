import { Link } from 'react-router-dom'
import { Icon } from '../components/Icon'

export function WhatsAppInboxPage() {
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">ATENDIMENTO</p>
          <h1>WhatsApp</h1>
          <p className="page-description">Caixa de entrada reservada para conversar com clientes dentro do sistema.</p>
        </div>
        <span className="module-heading-icon"><Icon name="message" /></span>
      </header>

      <section className="module-empty-panel" aria-labelledby="whatsapp-empty-title">
        <span className="empty-icon"><Icon name="message" /></span>
        <p className="eyebrow">CONEXÃO PENDENTE</p>
        <h2 id="whatsapp-empty-title">A caixa de entrada ainda não está conectada</h2>
        <p>O número e a conta do WhatsApp Business não foram configurados. Nenhuma mensagem está sendo recebida ou enviada por este sistema.</p>
        <p><Link className="button button-secondary" to="/configuracoes">Ver preparação da conexão</Link></p>
      </section>
    </div>
  )
}
