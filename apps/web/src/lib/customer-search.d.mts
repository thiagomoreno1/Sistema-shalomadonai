export type SearchableCustomer = {
  id: string
  name: string
  phone?: string | null
  whatsapp_phone?: string | null
}

export function normalizePhoneSearch(value: string): string
export function toInternationalPhone(callingCode: string, nationalNumber: string): string
export function searchCustomers<T extends SearchableCustomer>(customers: T[], query: string, limit?: number): T[]
