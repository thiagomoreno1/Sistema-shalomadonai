import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { AuthContext } from './AuthContext'
import { isSupabaseConfigured, supabaseClient } from '../lib/supabase'
const recoveryStorageKey = 'shalom-adonai-password-recovery'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(isSupabaseConfigured)
  const [session, setSession] = useState<Session | null>(null)
  const [recovery, setRecovery] = useState(() => window.sessionStorage.getItem(recoveryStorageKey) === 'pending')
  const [sessionError, setSessionError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabaseClient) return

    let active = true
    let authEventSeen = false

    const {
      data: { subscription },
    } = supabaseClient.auth.onAuthStateChange((event, nextSession) => {
      authEventSeen = true
      if (!active) return

      setSession(nextSession)
      setLoading(false)
      setSessionError(null)

      if (event === 'PASSWORD_RECOVERY') {
        window.sessionStorage.setItem(recoveryStorageKey, 'pending')
        setRecovery(true)
      }
      if (event === 'SIGNED_OUT') {
        window.sessionStorage.removeItem(recoveryStorageKey)
        setRecovery(false)
      }
    })

    void supabaseClient.auth.getSession().then(({ data, error }) => {
      if (!active || authEventSeen) return
      setSession(data.session)
      setLoading(false)
      if (error) setSessionError('Não foi possível confirmar a sessão. Recarregue a página e tente novamente.')
    }).catch(() => {
      if (!active || authEventSeen) return
      setSession(null)
      setLoading(false)
      setSessionError('Não foi possível confirmar a sessão. Recarregue a página e tente novamente.')
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  const completeRecovery = useCallback(() => {
    window.sessionStorage.removeItem(recoveryStorageKey)
    setRecovery(false)
  }, [])
  const value = useMemo(
    () => ({
      configured: isSupabaseConfigured,
      loading,
      session,
      recovery,
      sessionError,
      completeRecovery,
    }),
    [loading, session, recovery, sessionError, completeRecovery],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
