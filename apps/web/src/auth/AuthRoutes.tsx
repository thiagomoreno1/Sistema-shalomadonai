import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { AppShell } from '../components/AppShell'
import { BusinessProvider } from '../business/BusinessProvider'
import { LoadingScreen, SetupPage } from '../pages/SetupPage'

const DashboardPage = lazy(async () => ({ default: (await import('../pages/DashboardPage')).DashboardPage }))
const ModulePage = lazy(async () => ({ default: (await import('../pages/ModulePage')).ModulePage }))
const CustomersPage = lazy(async () => ({ default: (await import('../pages/CustomersPage')).CustomersPage }))
const CustomerDetailPage = lazy(async () => ({ default: (await import('../pages/CustomerDetailPage')).CustomerDetailPage }))
const ProductsPage = lazy(async () => ({ default: (await import('../pages/ProductsPage')).ProductsPage }))
const FollowUpsPage = lazy(async () => ({ default: (await import('../pages/FollowUpsPage')).FollowUpsPage }))
const MorePage = lazy(async () => ({ default: (await import('../pages/ModulePage')).MorePage }))
const SettingsPage = lazy(async () => ({ default: (await import('../pages/SettingsPage')).SettingsPage }))
const SignInPage = lazy(async () => ({ default: (await import('../pages/SignInPage')).SignInPage }))
const PasswordRecoveryPage = lazy(async () => ({ default: (await import('../pages/SignInPage')).PasswordRecoveryPage }))

export function AuthRoutes() {
  const { configured, loading, session, sessionError } = useAuth()

  if (!configured) return <SetupPage />
  if (loading) return <LoadingScreen />

  return (
    <>
      {sessionError && <p className="session-warning" role="alert">{sessionError}</p>}
      <Suspense fallback={<LoadingScreen label="Abrindo a operação" />}>
        <Routes>
          <Route path="/redefinir-senha" element={<PasswordRecoveryPage />} />
          <Route path="/entrar" element={session ? <Navigate replace to="/" /> : <SignInPage />} />
          <Route element={session ? <BusinessProvider><AppShell /></BusinessProvider> : <Navigate replace to="/entrar" />}>
            <Route index element={<DashboardPage />} />
            <Route path="clientes" element={<CustomersPage />} />
            <Route path="clientes/:customerId" element={<CustomerDetailPage />} />
            <Route path="atendimento" element={<FollowUpsPage />} />
            <Route path="pedidos" element={<ModulePage title="Pedidos" description="Vendas, pagamentos e acompanhamento da entrega." icon="bag" nextStep="A criação de pedidos e seus pagamentos será habilitada nesta etapa da implantação." />} />
            <Route path="catalogo" element={<ProductsPage />} />
            <Route path="estoque" element={<ModulePage title="Estoque" description="Saldos e movimentações de produtos." icon="box" nextStep="O controle de estoque será habilitado após confirmar unidades, quantidades iniciais e limites mínimos." />} />
            <Route path="entregas" element={<ModulePage title="Entregas" description="Separação, despacho e acompanhamento das entregas." icon="truck" nextStep="As entregas serão ligadas aos pedidos, sem criar contas para entregadores." />} />
            <Route path="financeiro" element={<ModulePage title="Financeiro" description="Recebimentos, contas a receber, despesas e caixa." icon="coin" nextStep="O financeiro será habilitado após confirmar os registros iniciais e a fórmula de resultado gerencial." />} />
            <Route path="relatorios" element={<ModulePage title="Relatórios" description="Acompanhamento diário e mensal da operação." icon="chart" nextStep="Os relatórios serão habilitados junto aos módulos que fornecem seus dados." />} />
            <Route path="mais" element={<MorePage />} />
            <Route path="configuracoes" element={<SettingsPage />} />
            <Route path="*" element={<Navigate replace to="/" />} />
          </Route>
          <Route path="*" element={<Navigate replace to={session ? '/' : '/entrar'} />} />
        </Routes>
      </Suspense>
    </>
  )
}
