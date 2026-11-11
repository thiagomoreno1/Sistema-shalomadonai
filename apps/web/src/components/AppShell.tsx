import { useLayoutEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { canManageBusiness, useBusiness } from '../business/BusinessContext'
import { supabaseClient } from '../lib/supabase'
import { clearDemoPreview, isDemoPreviewEnabled } from '../lib/demoPreview'
import { Icon, type IconName } from './Icon'
import { ThemeToggle } from './ThemeToggle'
import { prefetchRoute } from '../lib/prefetchRoute'
import { useProfileAvatarUrl } from '../lib/useProfileAvatarUrl'

type NavItem = { to: string; label: string; icon: IconName }

const primaryItems: NavItem[] = [
  { to: '/', label: 'Início', icon: 'home' },
  { to: '/financeiro', label: 'Dashboard', icon: 'coin' },
  { to: '/atendimento', label: 'Atendimento', icon: 'phone' },
  { to: '/pedidos', label: 'Pedidos', icon: 'bag' },
]

const desktopItems: NavItem[] = [
  { to: '/', label: 'Início', icon: 'home' },
  { to: '/financeiro', label: 'Dashboard', icon: 'coin' },
  { to: '/clientes', label: 'Clientes', icon: 'people' },
  { to: '/atendimento', label: 'Atendimento', icon: 'phone' },
  { to: '/whatsapp', label: 'WhatsApp', icon: 'message' },
  { to: '/pedidos', label: 'Pedidos', icon: 'bag' },
  { to: '/catalogo', label: 'Catálogo', icon: 'tag' },
  { to: '/estoque', label: 'Estoque', icon: 'box' },
  { to: '/entregas', label: 'Entregas', icon: 'truck' },
  { to: '/equipe', label: 'Equipe', icon: 'people' },
  { to: '/relatorios', label: 'Relatórios', icon: 'reports' },
]

const routeLabels: Record<string, string> = {
  '/': 'Início',
  '/clientes': 'Clientes',
  '/atendimento': 'Atendimento',
  '/whatsapp': 'WhatsApp',
  '/pedidos': 'Pedidos',
  '/catalogo': 'Catálogo',
  '/estoque': 'Estoque',
  '/entregas': 'Entregas',
  '/equipe': 'Equipe',
  '/financeiro': 'Dashboard',
  '/financeiro/receber': 'Falta receber',
  '/financeiro/saidas': 'Despesas pagas',
  '/relatorios': 'Relatórios',
  '/mais': 'Mais',
  '/configuracoes': 'Configurações',
}

function getRouteLabel(pathname: string) {
  if (pathname.startsWith('/clientes/')) return 'Cliente'
  if (pathname.startsWith('/whatsapp/')) return 'WhatsApp'
  return routeLabels[pathname] ?? 'Operação'
}

export function AppShell() {
  const { session } = useAuth()
  const { role } = useBusiness()
  const navigate = useNavigate()
  const location = useLocation()
  const navigationType = useNavigationType()
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const demoPreview = canManageBusiness(role) && isDemoPreviewEnabled()
  const profileName = session?.user.user_metadata?.display_name
  const displayName = typeof profileName === 'string' && profileName.trim()
    ? profileName.trim()
    : session?.user.email ?? 'Equipe de gestão'
  const avatarPath = session?.user.user_metadata?.avatar_path
  const avatarUrl = useProfileAvatarUrl(typeof avatarPath === 'string' ? avatarPath : null)

  useLayoutEffect(() => {
    if (navigationType !== 'POP') {
      window.scrollTo(0, 0)
      document.getElementById('main-content')?.focus({ preventScroll: true })
    }
  }, [location.pathname, navigationType])

  function exitDemoPreview() {
    clearDemoPreview()
    navigate('/', { replace: true })
  }

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
            <span className="account-avatar" aria-hidden="true">{avatarUrl ? <img alt="" src={avatarUrl} /> : displayName.slice(0, 1).toUpperCase()}</span>
            <span className="account-copy"><strong>{displayName}</strong><small>{session?.user.email ?? 'Conta autenticada'}</small></span>
          </div>
        </div>
      </aside>

      <div className="app-column">
        <header className="topbar">
          <div className="topbar-greeting">
            <img className="mobile-mark" src="/shalom-adonai-logo.png" alt="" />
          <span><strong>Shalom Adonai</strong><small className="topbar-email">{getRouteLabel(location.pathname)}{displayName ? ` · ${displayName}` : ''}</small></span>
          </div>
          <div className="topbar-actions">
            <ThemeToggle />
            <button className="signout-button" disabled={signingOut} onClick={handleSignOut} type="button">
              {signingOut ? 'Saindo…' : 'Sair'}
            </button>
          </div>
        </header>

        {signOutError && <p className="global-message" role="alert">{signOutError}</p>}

        {demoPreview && <div className="demo-mode-banner" role="status">
          <Icon name="chart" />
          <p><strong>Modo demonstração.</strong> Dados fictícios, somente visualização; nada será salvo.</p>
          <button className="demo-mode-exit" onClick={exitDemoPreview} type="button">Sair da prévia</button>
        </div>}

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
      onPointerEnter={() => prefetchRoute(item.to)}
      onFocus={() => prefetchRoute(item.to)}
      onTouchStart={() => prefetchRoute(item.to)}
    >
      <Icon name={item.icon} />
      <span>{item.label}</span>
    </NavLink>
  )
}
