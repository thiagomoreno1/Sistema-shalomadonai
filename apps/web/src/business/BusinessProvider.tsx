import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { BusinessContext, type BusinessContextValue } from './BusinessContext'
import { useAuth } from '../auth/AuthContext'
import { LoadingScreen } from '../pages/SetupPage'
import { supabaseClient } from '../lib/supabase'
import { Icon } from '../components/Icon'

type BusinessLoadState = {
  business: BusinessContextValue | null
  loading: boolean
  issue: 'missing' | 'ambiguous' | 'unavailable' | null
}

export function BusinessProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<BusinessLoadState>({ business: null, loading: true, issue: null })

  useEffect(() => {
    const userId = session?.user.id
    let active = true

    async function loadBusiness() {
      if (!supabaseClient || !userId) {
        setState({ business: null, loading: false, issue: 'unavailable' })
        return
      }

      setState({ business: null, loading: true, issue: null })
      try {
        const { data: memberships, error: membershipError } = await supabaseClient
          .from('business_memberships')
          .select('business_id')
          .eq('user_id', userId)
          .eq('role', 'owner')
          .limit(2)

        if (membershipError) throw membershipError
        if (!memberships?.length) {
          if (active) setState({ business: null, loading: false, issue: 'missing' })
          return
        }
        if (memberships.length > 1) {
          if (active) setState({ business: null, loading: false, issue: 'ambiguous' })
          return
        }

        const { data: business, error: businessError } = await supabaseClient
          .from('businesses')
          .select('id, name, timezone, currency')
          .eq('id', memberships[0].business_id)
          .single()

        if (businessError || !business) throw businessError
        if (active) {
          setState({
            business: {
              id: business.id,
              name: business.name,
              timezone: business.timezone,
              currency: business.currency,
            },
            loading: false,
            issue: null,
          })
        }
      } catch {
        if (active) setState({ business: null, loading: false, issue: 'unavailable' })
      }
    }

    void loadBusiness()
    return () => { active = false }
  }, [session?.user.id, attempt])

  if (state.loading) return <LoadingScreen label="Carregando a empresa" />
  if (!state.business) {
    return (
      <BusinessUnavailable
        issue={state.issue ?? 'unavailable'}
        onRetry={() => setAttempt((current) => current + 1)}
      />
    )
  }

  return <BusinessContext.Provider value={state.business}>{children}</BusinessContext.Provider>
}

function BusinessUnavailable({ issue, onRetry }: { issue: 'missing' | 'ambiguous' | 'unavailable'; onRetry: () => void }) {
  const navigate = useNavigate()

  async function handleSignOut() {
    try {
      await supabaseClient?.auth.signOut()
    } catch {
      // The route still returns to sign-in; the server session can be retried there.
    } finally {
      navigate('/entrar', { replace: true })
    }
  }

  return (
    <main className="setup-screen">
      <section className="setup-card" aria-labelledby="business-setup-title">
        <img className="brand-image" src="/shalom-adonai-logo.png" alt="" />
        <p className="eyebrow">Shalom Adonai · Operação</p>
        <h1 id="business-setup-title">A empresa ainda não está conectada</h1>
        <p className="setup-copy">
          {issue === 'missing'
            ? 'Esta conta ainda não está vinculada ao cadastro da empresa. Conclua a configuração inicial do negócio antes de usar os registros.'
            : issue === 'ambiguous'
              ? 'Esta conta está vinculada a mais de uma empresa, mas a seleção entre empresas ainda não está disponível. Ajuste o acesso para deixar somente a empresa correta vinculada.'
              : 'Não foi possível carregar os dados da empresa. Verifique a conexão e tente novamente.'}
        </p>
        <div className="setup-note">
          <Icon name="shield" />
          <span>Os dados operacionais só aparecem depois que a conta autorizada encontra a empresa vinculada.</span>
        </div>
        <button className="button button-primary" onClick={onRetry} type="button">Tentar novamente</button>
        <button className="text-button" onClick={() => void handleSignOut()} type="button">Sair da conta</button>
      </section>
    </main>
  )
}
