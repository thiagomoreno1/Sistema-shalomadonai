import { Link } from 'react-router-dom'
import { Icon, type IconName } from '../components/Icon'
import { prefetchRoute } from '../lib/prefetchRoute'

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

const secondaryModules: Array<{ group: string; to: string; title: string; description: string; icon: IconName }> = [
  { group: 'Vendas', to: '/clientes', title: 'Clientes', description: 'Cadastros e histórico', icon: 'people' },
  { group: 'Vendas', to: '/catalogo', title: 'Catálogo', description: 'Produtos e combos', icon: 'tag' },
  { group: 'Operação', to: '/estoque', title: 'Estoque', description: 'Saldos e movimentações', icon: 'box' },
  { group: 'Operação', to: '/entregas', title: 'Entregas', description: 'Separação e acompanhamento', icon: 'truck' },
  { group: 'Operação', to: '/equipe', title: 'Equipe', description: 'Acessos e pagamentos', icon: 'people' },
  { group: 'Operação', to: '/whatsapp', title: 'WhatsApp', description: 'Conversas e chamadas', icon: 'message' },
  { group: 'Gestão', to: '/financeiro', title: 'Dashboard', description: 'Faturamento e gráficos', icon: 'coin' },
  { group: 'Gestão', to: '/relatorios', title: 'Relatórios', description: 'Resumo da operação', icon: 'reports' },
  { group: 'Gestão', to: '/configuracoes', title: 'Configurações', description: 'Conta e preferências', icon: 'settings' },
]

const secondaryModuleGroups = [...new Set(secondaryModules.map((module) => module.group))]

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
      {secondaryModuleGroups.map((group) => (
        <section aria-labelledby={`more-group-${group.toLowerCase()}`} className="more-module-group" key={group}>
          <div className="section-heading section-heading-compact"><h2 id={`more-group-${group.toLowerCase()}`}>{group}</h2></div>
          <div className="module-link-list">
            {secondaryModules.filter((module) => module.group === group).map((module) => (
              <Link className="module-link" onPointerEnter={() => prefetchRoute(module.to)} onFocus={() => prefetchRoute(module.to)} onTouchStart={() => prefetchRoute(module.to)} to={module.to} key={module.to}>
                <span className="module-link-icon"><Icon name={module.icon} /></span>
                <span><strong>{module.title}</strong><small>{module.description}</small></span>
                <Icon className="quick-link-arrow" name="arrow" />
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
