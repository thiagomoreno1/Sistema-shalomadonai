import { Link } from 'react-router-dom'
import { Icon, type IconName } from '../components/Icon'

type ModulePageProps = {
  title: string
  description: string
  icon: IconName
  nextStep: string
}

export function ModulePage({ title, description, icon, nextStep }: ModulePageProps) {
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">OPERAÇÃO</p>
          <h1>{title}</h1>
          <p className="page-description">{description}</p>
        </div>
        <span className="module-heading-icon"><Icon name={icon} /></span>
      </header>

      <section className="module-empty-panel" aria-labelledby="module-empty-title">
        <span className="empty-icon"><Icon name={icon} /></span>
        <p className="eyebrow">MÓDULO EM CONFIGURAÇÃO</p>
        <h2 id="module-empty-title">Ainda não há registros</h2>
        <p>{nextStep}</p>
      </section>
    </div>
  )
}

const secondaryModules: Array<{ to: string; title: string; description: string; icon: IconName }> = [
  { to: '/catalogo', title: 'Catálogo', description: 'Produtos, cestas e combos', icon: 'box' },
  { to: '/estoque', title: 'Estoque', description: 'Saldos e movimentações', icon: 'box' },
  { to: '/entregas', title: 'Entregas', description: 'Separação e acompanhamento', icon: 'truck' },
  { to: '/financeiro', title: 'Financeiro', description: 'Contas a receber e saídas pagas informadas', icon: 'coin' },
  { to: '/relatorios', title: 'Relatórios', description: 'Visões diárias e mensais', icon: 'chart' },
  { to: '/configuracoes', title: 'Configurações', description: 'Conta e conexões', icon: 'settings' },
]

export function MorePage() {
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">NAVEGAÇÃO</p>
          <h1>Mais ferramentas</h1>
          <p className="page-description">Acesse os outros módulos da operação.</p>
        </div>
      </header>
      <div className="module-link-list">
        {secondaryModules.map((module) => (
          <Link className="module-link" to={module.to} key={module.to}>
            <span className="module-link-icon"><Icon name={module.icon} /></span>
            <span><strong>{module.title}</strong><small>{module.description}</small></span>
            <Icon className="quick-link-arrow" name="arrow" />
          </Link>
        ))}
      </div>
    </div>
  )
}
