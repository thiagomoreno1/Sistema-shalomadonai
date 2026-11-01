export function normalizePhoneSearch(value) {
  return value.replace(/\D/g, '')
}

export function toInternationalPhone(callingCode, nationalNumber) {
  const rawValue = nationalNumber.trim()
  const digits = normalizePhoneSearch(rawValue)
  if (rawValue.startsWith('+')) return digits ? `+${digits}` : ''
  if (rawValue.startsWith('00')) return digits.length > 2 ? `+${digits.slice(2)}` : ''
  return digits && callingCode ? `+${callingCode}${digits}` : ''
}

export function searchCustomers(customers, query, limit = 8) {
  const needle = query.trim().toLocaleLowerCase('pt-BR')
  if (!needle) return customers.slice(0, limit)
  const digits = normalizePhoneSearch(query)
  return customers.filter((customer) => {
    const textMatch = [customer.name, customer.phone ?? '', customer.whatsapp_phone ?? '']
      .some((value) => value.toLocaleLowerCase('pt-BR').includes(needle))
    const phoneMatch = digits.length > 0 && [customer.phone, customer.whatsapp_phone]
      .some((value) => normalizePhoneSearch(value ?? '').includes(digits))
    return textMatch || phoneMatch
  }).slice(0, limit)
}
