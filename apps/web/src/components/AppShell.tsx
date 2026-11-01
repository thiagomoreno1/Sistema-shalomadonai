import { useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { supabaseClient } from '../lib/supabase'
import { Icon, type IconName } from './Icon'
import { ThemeToggle } from './ThemeToggle'

type NavItem = { to: string; label: string; icon: IconName }

const primaryItems: NavItem[] = [
  { to: '/', label: 'Início', icon: 'home' },
  { to: '/atendimento', label: 'Atendimento', icon: 'phone' },
  { to: '/pedidos', label: 'Pedidos', icon: 'bag' },
  { to: '/clientes', label: 'Clientes', icon: 'people' },
]

const desktopItems: NavItem[] = [
  { to: '/', label: 'Início', icon: 'home' },
  { to: '/clientes', label: 'Clientes', icon: 'people' },
  { to: '/atendimento', label: 'Atendimento', icon: 'phone' },
  { to: '/whatsapp', label: 'WhatsApp', icon: 'message' },
  { to: '/pedidos', label: 'Pedidos', icon: 'bag' },
  { to: '/catalogo', label: 'Catálogo', icon: 'box' },
  { to: '/estoque', label: 'Estoque', icon: 'box' },
  { to: '/entregas', label: 'Entregas', icon: 'truck' },
  { to: '/financeiro', label: 'Financeiro', icon: 'coin' },
  { to: '/relatorios', label: 'Relatórios', icon: 'chart' },
]

const routeLabels: Record<string, string> = {
  '/': 'Visão geral',
  '/clientes': 'Clientes',
  '/atendimento': 'Atendimento',
  '/whatsapp': 'WhatsApp',
  '/pedidos': 'Pedidos',
  '/catalogo': 'Catálogo',
  '/estoque': 'Estoque',
  '/entregas': 'Entregas',
  '/financeiro': 'Financeiro',
  '/financeiro/saidas': 'Saídas pagas',
  '/financeiro/bancos': 'Conciliação bancária',
  '/relatorios': 'Relatórios',
  '/mais': 'Mais ferramentas',
  '/configuracoes': 'Configurações',
}

function getRouteLabel(pathname: string) {
  if (pathname.startsWith('/clientes/')) return 'Cliente'
  return routeLabels[pathname] ?? 'Operação'
}

export function AppShell() {
  const { session } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  async function handleSignOut() {
    if (!supabaseClient) return
    setSigningOut(true)
    setSignOutError(null)
    try {
      const { error } = await supabaseClient.auth.signOut()
      if (error) {
        setSignOutError('Não foi possível encerrar a sessão. Tente novamente.')
        return
      }
      navigate('/entrar', { replace: true })
    } catch {
      setSignOutError('Não foi possível encerrar a sessão. Tente novamente.')
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Pular para o conteúdo</a>
      <aside className="desktop-sidebar" aria-label="Navegação principal">
        <div className="brand-lockup sidebar-brand">
          <img className="brand-image" src="/shalom-adonai-logo.png" alt="" />
          <span><strong>Shalom Adonai</strong><small>Operação</small></span>
        </div>
        <p className="sidebar-caption">OPERAÇÃO</p>
        <nav className="sidebar-nav">
          {desktopItems.map((item) => <NavigationLink item={item} key={item.to} />)}
        </nav>
        <div className="sidebar-bottom">
          <NavigationLink item={{ to: '/configuracoes', label: 'Configurações', icon: 'settings' }} />
          <div className="sidebar-account">
            <span className="account-avatar" aria-hidden="true">{session?.user.email?.slice(0, 1).toUpperCase() ?? 'S'}</span>
            <span className="account-copy"><strong>Equipe de gestão</strong><small>{session?.user.email ?? 'Conta autenticada'}</small></span>
          </div>
        </div>
      </aside>

      <div className="app-column">
        <header className="topbar">
          <div className="topbar-greeting">
            <img className="mobile-mark" src="/shalom-adonai-logo.png" alt="" />
            <span><strong>Shalom Adonai</strong><small className="topbar-email">{getRouteLabel(location.pathname)}{session?.user.email ? ` · ${session.user.email}` : ''}</small></span>
          </div>
          <div className="topbar-actions">
            <ThemeToggle />
            <button className="signout-button" disabled={signingOut} onClick={handleSignOut} type="button">
              {signingOut ? 'Saindo…' : 'Sair'}
            </button>
          </div>
        </header>

        {signOutError && <p className="global-message" role="alert">{signOutError}</p>}

        <main className="main-content" id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>

      <nav className="mobile-bottom-nav" aria-label="Navegação principal">
        {primaryItems.map((item) => <NavigationLink item={item} key={item.to} compact />)}
        <NavigationLink item={{ to: '/mais', label: 'Mais', icon: 'menu' }} compact />
      </nav>
    </div>
  )
}

function NavigationLink({ item, compact = false }: { item: NavItem; compact?: boolean }) {
  return (
    <NavLink
      aria-label={compact ? item.label : undefined}
      className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}${compact ? ' nav-link-compact' : ''}`}
      end={item.to === '/'}
      to={item.to}
    >
      <Icon name={item.icon} />
      <span>{item.label}</span>
    </NavLink>
  )
}
