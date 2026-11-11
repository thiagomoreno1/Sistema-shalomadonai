import { NavLink } from 'react-router-dom'

export function ReportsNavigation({ active }: { active: 'general' | 'financial' }) {
  return (
    <nav aria-label="Relatórios" className="finance-subnav">
      <NavLink aria-current={active === 'general' ? 'page' : undefined} className={active === 'general' ? 'is-active' : undefined} end to="/relatorios">Resumo geral</NavLink>
      <NavLink aria-current={active === 'financial' ? 'page' : undefined} className={active === 'financial' ? 'is-active' : undefined} to="/relatorios/financeiro">Relatório financeiro</NavLink>
    </nav>
  )
}
