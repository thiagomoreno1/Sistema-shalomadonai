import { createContext, useContext } from 'react'

export type BusinessMemberRole = 'owner' | 'manager' | 'staff'

export type BusinessContextValue = {
  id: string
  name: string
  timezone: string
  currency: string
  role: BusinessMemberRole
}

export const BusinessContext = createContext<BusinessContextValue | null>(null)

export function canManageBusiness(role: BusinessMemberRole) {
  return role === 'owner' || role === 'manager'
}

export function businessMemberRoleLabel(role: BusinessMemberRole) {
  if (role === 'owner') return 'Proprietário'
  if (role === 'manager') return 'Gestão'
  return 'Equipe'
}

export function useBusiness() {
  const business = useContext(BusinessContext)
  if (!business) throw new Error('useBusiness precisa estar dentro de BusinessProvider.')
  return business
}
