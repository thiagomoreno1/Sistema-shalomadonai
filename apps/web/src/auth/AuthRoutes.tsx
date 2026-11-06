import { lazy, Suspense } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { AppShell } from '../components/AppShell'
import { BusinessProvider } from '../business/BusinessProvider'
import { useBusiness } from '../business/BusinessContext'
import { isDemoPreviewEnabled } from '../lib/demoPreview'
import { LoadingScreen, SetupPage } from '../pages/SetupPage'

const DashboardPage = lazy(async () => ({ default: (await import('../pages/DashboardPage')).DashboardPage }))
const DashboardDesignReferencesPage = lazy(async () => ({ default: (await import('../pages/DashboardDesignReferencesPage')).DashboardDesignReferencesPage }))
const CustomersPage = lazy(async () => ({ default: (await import('../pages/CustomersPage')).CustomersPage }))
const CustomerDetailPage = lazy(async () => ({ default: (await import('../pages/CustomerDetailPage')).CustomerDetailPage }))
const ProductsPage = lazy(async () => ({ default: (await import('../pages/ProductsPage')).ProductsPage }))
const OrdersPage = lazy(async () => ({ default: (await import('../pages/OrdersPage')).OrdersPage }))
const NewOrderPage = lazy(async () => ({ default: (await import('../pages/NewOrderPage')).NewOrderPage }))
const OrderDetailPage = lazy(async () => ({ default: (await import('../pages/OrderDetailPage')).OrderDetailPage }))
const ReceivablesPage = lazy(async () => ({ default: (await import('../pages/ReceivablesPage')).ReceivablesPage }))
const FinancialOutflowsPage = lazy(async () => ({ default: (await import('../pages/FinancialOutflowsPage')).FinancialOutflowsPage }))
const ReportsPage = lazy(async () => ({ default: (await import('../pages/ReportsPage')).ReportsPage }))
const FinancialReportsPage = lazy(async () => ({ default: (await import('../pages/FinancialReportsPage')).FinancialReportsPage }))
const InventoryPage = lazy(async () => ({ default: (await import('../pages/InventoryPage')).InventoryPage }))
const DeliveriesPage = lazy(async () => ({ default: (await import('../pages/DeliveriesPage')).DeliveriesPage }))
const TeamPage = lazy(async () => ({ default: (await import('../pages/TeamPage')).TeamPage }))
const FollowUpsPage = lazy(async () => ({ default: (await import('../pages/FollowUpsPage')).FollowUpsPage }))
const WhatsAppInboxPage = lazy(async () => ({ default: (await import('../pages/WhatsAppInboxPage')).WhatsAppInboxPage }))
const MorePage = lazy(async () => ({ default: (await import('../pages/ModulePage')).MorePage }))
const SettingsPage = lazy(async () => ({ default: (await import('../pages/SettingsPage')).SettingsPage }))
const SignInPage = lazy(async () => ({ default: (await import('../pages/SignInPage')).SignInPage }))
const SignUpPage = lazy(async () => ({ default: (await import('../pages/SignUpPage')).SignUpPage }))
const DeliveryDriverPortalPage = lazy(async () => ({ default: (await import('../pages/DeliveryDriverPortalPage')).DeliveryDriverPortalPage }))
const PasswordRecoveryPage = lazy(async () => ({ default: (await import('../pages/SignInPage')).PasswordRecoveryPage }))
const DemoPreviewPage = lazy(async () => ({ default: (await import('../pages/DemoPreviewPage')).DemoPreviewPage }))

function DemoPreviewRoute() {
  const { pathname } = useLocation()
  const { role } = useBusiness()
  if (role === 'owner' && isDemoPreviewEnabled() && pathname !== '/') return <DemoPreviewPage />
  return <Outlet />
}

function DeliveryDriverPreviewRoute() {
  const { role } = useBusiness()
  if (role !== 'owner') return <Navigate replace to="/" />
  return <DeliveryDriverPortalPage preview />
}

export function AuthRoutes() {
  const { configured, loading, session, sessionError } = useAuth()
  const { search } = useLocation()
  const nextPath = new URLSearchParams(search).get('next')
  const signedInDestination = nextPath === '/entregador/visualizar' ? nextPath : '/'

  if (!configured) return <SetupPage />
  if (loading) return <LoadingScreen />

  return (
    <>
      {sessionError && <p className="session-warning" role="alert">{sessionError}</p>}
      <Suspense fallback={<LoadingScreen label="Abrindo a operação" />}>
        <Routes>
          <Route path="/redefinir-senha" element={<PasswordRecoveryPage />} />
          <Route path="/criar-conta" element={<SignUpPage />} />
          <Route path="/criar-conta-entregador" element={<Navigate replace to="/entrar" />} />
          <Route path="/referencias-central" element={<DashboardDesignReferencesPage />} />
          <Route path="/entrar" element={session ? <Navigate replace to={signedInDestination} /> : <SignInPage />} />
          <Route path="/entregador/visualizar" element={session ? <BusinessProvider><DeliveryDriverPreviewRoute /></BusinessProvider> : <Navigate replace to="/entrar?next=%2Fentregador%2Fvisualizar" />} />
          <Route path="/entregador" element={session ? <DeliveryDriverPortalPage /> : <Navigate replace to="/entrar?next=%2Fentregador" />} />
          <Route element={session ? <BusinessProvider><AppShell /></BusinessProvider> : <Navigate replace to="/entrar" />}>
            <Route path="financeiro/bancos" element={<Navigate replace to="/financeiro" />} />
            <Route element={<DemoPreviewRoute />}>
              <Route index element={<DashboardPage />} />
              <Route path="clientes" element={<CustomersPage />} />
              <Route path="clientes/:customerId" element={<CustomerDetailPage />} />
              <Route path="atendimento" element={<FollowUpsPage />} />
              <Route path="whatsapp" element={<WhatsAppInboxPage />} />
              <Route path="whatsapp/caixa-shalom" element={<WhatsAppInboxPage />} />
              <Route path="pedidos" element={<OrdersPage />} />
              <Route path="pedidos/novo" element={<NewOrderPage />} />
              <Route path="pedidos/:orderId" element={<OrderDetailPage />} />
              <Route path="catalogo" element={<ProductsPage />} />
              <Route path="estoque" element={<InventoryPage />} />
              <Route path="entregas" element={<DeliveriesPage />} />
              <Route path="equipe" element={<TeamPage />} />
              <Route path="financeiro" element={<ReceivablesPage />} />
              <Route path="financeiro/saidas" element={<FinancialOutflowsPage />} />
              <Route path="relatorios" element={<ReportsPage />} />
              <Route path="relatorios/financeiro" element={<FinancialReportsPage />} />
              <Route path="mais" element={<MorePage />} />
              <Route path="configuracoes" element={<SettingsPage />} />
              <Route path="*" element={<Navigate replace to="/" />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate replace to={session ? '/' : '/entrar'} />} />
        </Routes>
      </Suspense>
    </>
  )
}
