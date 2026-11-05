import { NavLink } from 'react-router-dom'

export function FinanceNavigation({ active }: { active: 'receivables' | 'outflows' | 'banking' | 'reports' }) {
  return (
    <nav aria-label="Seções financeiras" className="finance-subnav">
      <NavLink aria-current={active === 'receivables' ? 'page' : undefined} className={active === 'receivables' ? 'is-active' : undefined} end to="/financeiro">Pagamentos a receber</NavLink>
      <NavLink aria-current={active === 'outflows' ? 'page' : undefined} className={active === 'outflows' ? 'is-active' : undefined} to="/financeiro/saidas">Gastos pagos</NavLink>
      <NavLink aria-current={active === 'reports' ? 'page' : undefined} className={active === 'reports' ? 'is-active' : undefined} to="/relatorios">Relatórios</NavLink>
    </nav>
  )
}
