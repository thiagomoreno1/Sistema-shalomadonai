import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { AppShell } from '../components/AppShell'
import { LoadingScreen, SetupPage } from '../pages/SetupPage'

const DashboardPage = lazy(async () => ({ default: (await import('../pages/DashboardPage')).DashboardPage }))
const ModulePage = lazy(async () => ({ default: (await import('../pages/ModulePage')).ModulePage }))
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
          <Route element={session ? <AppShell /> : <Navigate replace to="/entrar" />}>
            <Route index element={<DashboardPage />} />
            <Route path="clientes" element={<ModulePage title="Clientes" description="Cadastros, contatos e histórico de relacionamento." icon="people" nextStep="Os cadastros de clientes serão habilitados nesta etapa da implantação." />} />
            <Route path="atendimento" element={<ModulePage title="Atendimento" description="Registro de chamadas, conversas e próximos retornos." icon="phone" nextStep="O registro de chamadas e a fila de retornos serão habilitados nesta etapa da implantação." />} />
            <Route path="pedidos" element={<ModulePage title="Pedidos" description="Vendas, pagamentos e acompanhamento da entrega." icon="bag" nextStep="A criação de pedidos e seus pagamentos será habilitada nesta etapa da implantação." />} />
            <Route path="catalogo" element={<ModulePage title="Catálogo" description="Produtos, cestas básicas, combos e eletrodomésticos." icon="box" nextStep="O catálogo de produtos e a composição dos combos serão cadastrados após a confirmação das regras de estoque." />} />
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
