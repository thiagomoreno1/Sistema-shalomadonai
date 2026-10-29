export function businessToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function currentTimestamp() {
  return new Date().toISOString()
}

export function formatBusinessDate(value: string) {
  const date = new Date(`${value}T12:00:00-03:00`)
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'medium',
    timeZone: 'America/Sao_Paulo',
  }).format(date)
}

export function formatBRL(cents: number | null) {
  if (cents === null) return 'Preço pendente'
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100)
}

export function parseBrazilianCurrency(value: string) {
  const trimmed = value.trim().replace(/\s/g, '').replace(/^R\$/i, '')
  if (!trimmed) return null

  const normalized = trimmed.includes(',')
    ? trimmed.replace(/\./g, '').replace(',', '.')
    : trimmed
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return Number.NaN

  const amount = Number(normalized)
  if (!Number.isFinite(amount) || amount > Number.MAX_SAFE_INTEGER / 100) return Number.NaN
  return Math.round(amount * 100)
}
