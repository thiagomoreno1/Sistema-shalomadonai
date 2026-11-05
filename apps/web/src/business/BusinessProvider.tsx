import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { BusinessContext, type BusinessContextValue } from './BusinessContext'
import { useAuth } from '../auth/AuthContext'
import { LoadingScreen } from '../pages/SetupPage'
import { supabaseClient } from '../lib/supabase'
import { Icon } from '../components/Icon'

type BusinessLoadState = {
  business: BusinessContextValue | null
  loading: boolean
  issue: 'missing' | 'ambiguous' | 'unavailable' | 'driver' | null
}

export function BusinessProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<BusinessLoadState>({ business: null, loading: true, issue: null })

  useEffect(() => {
    const userId = session?.user.id
    let active = true
    let checking = false
    let resolved = false

    async function loadBusiness(silent = false) {
      if (checking) return
      checking = true
      if (!supabaseClient || !userId) {
        if (active) setState({ business: null, loading: false, issue: 'unavailable' })
        checking = false
        return
      }

      if (!silent && !resolved) setState({ business: null, loading: true, issue: null })
      try {
        const { data: memberships, error: membershipError } = await supabaseClient
          .from('business_memberships')
          .select('business_id, role')
          .eq('user_id', userId)
          .limit(2)

        if (membershipError) throw membershipError
        if (!memberships?.length) {
          const driverContext = await supabaseClient.rpc('get_my_delivery_worker_context')
          const assignedDriver = !driverContext.error
            && Boolean((Array.isArray(driverContext.data) ? driverContext.data[0] : driverContext.data))
          resolved = true
          if (active) setState({ business: null, loading: false, issue: assignedDriver ? 'driver' : 'missing' })
          return
        }
        if (memberships.length > 1) {
          resolved = true
          if (active) setState({ business: null, loading: false, issue: 'ambiguous' })
          return
        }

        const { data: business, error: businessError } = await supabaseClient
          .from('businesses')
          .select('id, name, timezone, currency')
          .eq('id', memberships[0].business_id)
          .single()

        if (businessError || !business) throw businessError
        resolved = true
        if (active) {
          setState({
            business: {
              id: business.id,
              name: business.name,
              timezone: business.timezone,
              currency: business.currency,
              role: memberships[0].role,
            },
            loading: false,
            issue: null,
          })
        }
      } catch {
        if (active) setState({ business: null, loading: false, issue: 'unavailable' })
      } finally {
        checking = false
      }
    }

    void loadBusiness()
    const revalidate = () => {
      if (document.visibilityState === 'visible') void loadBusiness(true)
    }
    const intervalId = window.setInterval(revalidate, 30_000)
    document.addEventListener('visibilitychange', revalidate)
    window.addEventListener('focus', revalidate)
    return () => {
      active = false
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', revalidate)
      window.removeEventListener('focus', revalidate)
    }
  }, [session?.user.id, attempt])

  if (state.loading) return <LoadingScreen label="Carregando a empresa" />
  if (!state.business) {
    return (
      <BusinessUnavailable
        issue={state.issue ?? 'unavailable'}
        onRetry={() => setAttempt((current) => current + 1)}
        userId={session?.user.id ?? ''}
      />
    )
  }

  return <BusinessContext.Provider value={state.business}>{children}</BusinessContext.Provider>
}

function BusinessUnavailable({ issue, onRetry, userId }: { issue: 'missing' | 'ambiguous' | 'unavailable' | 'driver'; onRetry: () => void; userId: string }) {
  const navigate = useNavigate()
  const [requestingAccess, setRequestingAccess] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [hasPendingRequest, setHasPendingRequest] = useState<boolean | null>(null)

  useEffect(() => {
    let active = true
    async function loadRequestStatus() {
      if (!supabaseClient || issue !== 'missing' || !userId) return
      const { data, error } = await supabaseClient
        .from('business_access_requests')
        .select('id')
        .eq('user_id', userId)
        .limit(1)
      if (active) setHasPendingRequest(!error && Boolean(data?.length))
    }
    void loadRequestStatus()
    return () => { active = false }
  }, [issue, userId])

  async function requestBusinessAccess() {
    if (!supabaseClient) return
    setRequestingAccess(true)
    setRequestError(null)
    const { error } = await supabaseClient.rpc('request_business_access')
    setRequestingAccess(false)
    if (error) {
      setRequestError('Não foi possível enviar o pedido. Tente novamente mais tarde.')
      return
    }
    setHasPendingRequest(true)
  }

  async function handleSignOut() {
    try {
      await supabaseClient?.auth.signOut()
    } catch {
      // The route still returns to sign-in; the server session can be retried there.
    } finally {
      navigate('/entrar', { replace: true })
    }
  }

  if (issue === 'driver') return <Navigate replace to="/entregador" />

  return (
    <main className="setup-screen">
      <section className="setup-card" aria-labelledby="business-setup-title">
        <img className="brand-image" src="/shalom-adonai-logo.png" alt="" />
        <p className="eyebrow">Shalom Adonai · Operação</p>
        <h1 id="business-setup-title">{issue === 'missing' ? hasPendingRequest ? 'Pedido aguardando aprovação' : 'Acesso à empresa pendente' : issue === 'ambiguous' ? 'Esta conta está vinculada a mais de uma empresa' : 'Não foi possível confirmar o acesso'}</h1>
        <p className="setup-copy">
          {issue === 'missing'
            ? 'Esta conta ainda não tem acesso à empresa. Se você acabou de criar uma conta, a gestão precisa aprovar seu pedido antes de liberar os dados.'
            : issue === 'ambiguous'
              ? 'A seleção entre empresas ainda não está disponível. Ajuste o acesso para deixar somente a empresa correta vinculada.'
              : 'Não foi possível confirmar se esta conta ainda tem acesso à empresa. Os dados operacionais estão ocultos por segurança; verifique a conexão e tente novamente.'}
        </p>
        <div className="setup-note">
          <Icon name="shield" />
          <span>{issue === 'missing' ? 'Os dados operacionais só aparecem depois que a gestão aprova o acesso desta conta.' : issue === 'ambiguous' ? 'Os dados operacionais permanecem bloqueados até a associação com uma única empresa ser corrigida.' : 'Os dados operacionais foram ocultados até que o acesso possa ser confirmado.'}</span>
        </div>
        {issue === 'missing' && hasPendingRequest === null && (
          <p className="settings-team-empty" role="status">Verificando seu pedido de acesso…</p>
        )}
        {issue === 'missing' && hasPendingRequest && (
          <p className="form-message form-message-success" role="status">Seu pedido já está com a gestão. Aguarde a aprovação para acessar os dados.</p>
        )}
        {issue === 'missing' && hasPendingRequest === false && (
          <>
            <button className="button button-primary" disabled={requestingAccess} onClick={() => void requestBusinessAccess()} type="button">
              {requestingAccess ? 'Enviando pedido…' : 'Enviar ou reenviar pedido de acesso'}
            </button>
            {requestError && <p className="form-message form-message-error" role="alert">{requestError}</p>}
          </>
        )}
        <button className="button button-primary" onClick={onRetry} type="button">Tentar novamente</button>
        <button className="text-button" onClick={() => void handleSignOut()} type="button">Sair da conta</button>
      </section>
    </main>
  )
}
