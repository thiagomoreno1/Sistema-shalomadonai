import { createContext, useContext } from 'react'

export type BusinessContextValue = {
  id: string
  name: string
  timezone: string
  currency: string
}

export const BusinessContext = createContext<BusinessContextValue | null>(null)

export function useBusiness() {
  const business = useContext(BusinessContext)
  if (!business) throw new Error('useBusiness precisa estar dentro de BusinessProvider.')
  return business
}
