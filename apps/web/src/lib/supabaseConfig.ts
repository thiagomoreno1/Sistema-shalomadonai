export function isValidSupabaseUrl(value: string) {
  try {
    const url = new URL(value)
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    return (
      (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback)) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

function isLegacyAnonKey(value: string) {
  const parts = value.split('.')
  if (
    parts.length !== 3 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part) || part.length % 4 === 1)
  ) return false

  try {
    const headerPayload = parts[0].replace(/-/g, '+').replace(/_/g, '/')
    const headerJson = atob(headerPayload.padEnd(Math.ceil(headerPayload.length / 4) * 4, '='))
    const decodedHeader: unknown = JSON.parse(headerJson)
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const payloadJson = atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))
    const decodedSignature = atob(parts[2].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[2].length / 4) * 4, '='))
    const claims: unknown = JSON.parse(payloadJson)
    return (
      decodedSignature.length > 0 &&
      typeof decodedHeader === 'object' &&
      decodedHeader !== null &&
      'alg' in decodedHeader &&
      decodedHeader.alg === 'HS256' &&
      typeof claims === 'object' &&
      claims !== null &&
      'role' in claims &&
      claims.role === 'anon'
    )
  } catch {
    return false
  }
}

export function isPublishableKey(value: string) {
  if (/^sb_secret_/i.test(value)) return false

  const publishableMatch = /^sb_publishable_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{8})$/.test(value)
  return publishableMatch || isLegacyAnonKey(value)
}

export function getSupabaseConfigurationError(url: string, key: string) {
  if (!url) return 'Defina VITE_SUPABASE_URL no arquivo de ambiente da aplicação.'
  if (!isValidSupabaseUrl(url)) {
    return 'VITE_SUPABASE_URL precisa ser uma URL válida do projeto. Use HTTPS fora do ambiente local.'
  }
  if (!key) return 'Defina VITE_SUPABASE_PUBLISHABLE_KEY com a chave publicável do projeto.'
  if (!isPublishableKey(key)) {
    return 'Use uma chave publicável sb_publishable_ ou a chave legada anon. Chaves secret e service_role não podem ser usadas no navegador.'
  }
  return null
}
