import { createContext, useContext } from 'react'
import type { Session } from '@supabase/supabase-js'

export type AuthContextValue = {
  configured: boolean
  loading: boolean
  session: Session | null
  recovery: boolean
  sessionError: string | null
  completeRecovery: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth precisa estar dentro de AuthProvider.')
  return value
}
