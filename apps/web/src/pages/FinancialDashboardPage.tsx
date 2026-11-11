import { Link } from 'react-router-dom'
import { canManageBusiness, useBusiness } from '../business/BusinessContext'
import { FinanceNavigation } from '../components/FinanceNavigation'
import { FinancialChartsPanel } from '../components/FinancialChartsPanel'

export function FinancialDashboardPage() {
  const { role } = useBusiness()
  const canViewDashboard = canManageBusiness(role)

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">FINANCEIRO</p>
          <h1>Dashboard</h1>
          <p className="page-description">Veja quanto vendeu, quanto gastou e o que sobrou.</p>
        </div>
        <Link className="button button-secondary" to="/relatorios/financeiro">Ver relatório</Link>
      </header>
      <FinanceNavigation active="dashboard" />
      {canViewDashboard
        ? <FinancialChartsPanel />
        : <section className="surface-panel inline-state" role="status">Seu perfil não tem acesso ao dashboard financeiro.</section>}
    </div>
  )
}
