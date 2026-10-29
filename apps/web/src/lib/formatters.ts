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

export function businessLocalDateTimeToIso(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null

  const [, yearText, monthText, dayText, hourText, minuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const desiredWallTime = Date.UTC(year, month - 1, day, hour, minute)
  const dateCheck = new Date(desiredWallTime)
  if (dateCheck.getUTCFullYear() !== year || dateCheck.getUTCMonth() !== month - 1 || dateCheck.getUTCDate() !== day || hour > 23 || minute > 59) return null

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  let candidate = desiredWallTime
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]))
    const representedWallTime = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))
    const correction = desiredWallTime - representedWallTime
    if (correction === 0) return new Date(candidate).toISOString()
    candidate += correction
  }
  return null
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
