import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
}

const BELVO_SANDBOX_API = 'https://sandbox.belvo.com/api'
const BELVO_WIDGET_URL = 'https://widget.belvo.io/'
const BELVO_SANDBOX_INSTITUTION = 'ofmockbank_br_retail'
const BELVO_SCOPES = 'read_institutions,write_links,read_consents,write_consents,write_consent_callback,delete_consents'
const BELVO_FETCH_RESOURCES = ['ACCOUNTS']
const BELVO_PERMISSIONS = ['REGISTER', 'ACCOUNTS', 'CREDIT_CARDS', 'CREDIT_OPERATIONS']
const TEST_PURPOSE = 'Teste interno com dados fictícios do sandbox Belvo, sem decisões financeiras reais.'
const TOKEN_TTL_SECONDS = 600

const CONFIG_KEYS = [
  'BELVO_SANDBOX_SECRET_ID',
  'BELVO_SANDBOX_SECRET_PASSWORD',
  'BELVO_SANDBOX_TERMS_URL',
  'BELVO_SANDBOX_APP_ORIGIN',
  'BELVO_SANDBOX_WEBHOOK_TOKEN',
] as const

type BelvoConfiguration = {
  secretId: string
  secretPassword: string
  termsUrl: string
  appOrigin: URL | null
  webhookToken: string
  missingConfig: string[]
}

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const result = value.trim()
  if (!result || result.length > maxLength || /[\u0000-\u001f\u007f]/.test(result)) return null
  return result
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function httpsUrl(value: string | undefined): URL | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

function appOrigin(value: string | undefined): URL | null {
  const url = httpsUrl(value)
  if (!url || url.pathname !== '/' || url.search || url.hash) return null
  return url
}

function loadConfiguration(): BelvoConfiguration {
  const secretId = Deno.env.get('BELVO_SANDBOX_SECRET_ID')?.trim() ?? ''
  const secretPassword = Deno.env.get('BELVO_SANDBOX_SECRET_PASSWORD')?.trim() ?? ''
  const termsValue = Deno.env.get('BELVO_SANDBOX_TERMS_URL')?.trim() ?? ''
  const originValue = Deno.env.get('BELVO_SANDBOX_APP_ORIGIN')?.trim() ?? ''
  const webhookToken = Deno.env.get('BELVO_SANDBOX_WEBHOOK_TOKEN')?.trim() ?? ''
  const terms = httpsUrl(termsValue)
  const origin = appOrigin(originValue)
  const missingConfig: string[] = []

  if (!secretId) missingConfig.push(CONFIG_KEYS[0])
  if (!secretPassword) missingConfig.push(CONFIG_KEYS[1])
  if (!terms) missingConfig.push(CONFIG_KEYS[2])
  if (!origin) missingConfig.push(CONFIG_KEYS[3])
  if (webhookToken.length < 32) missingConfig.push(CONFIG_KEYS[4])

  return {
    secretId,
    secretPassword,
    termsUrl: terms?.toString() ?? '',
    appOrigin: origin,
    webhookToken,
    missingConfig,
  }
}

function supabaseApiKey(): string | null {
  const legacyKey = Deno.env.get('SUPABASE_ANON_KEY')?.trim()
  if (legacyKey) return legacyKey

  const keyMap = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')
  if (keyMap) {
    try {
      const parsed = JSON.parse(keyMap) as Record<string, unknown>
      if (typeof parsed.default === 'string' && parsed.default.trim()) return parsed.default.trim()
      const firstKey = Object.values(parsed).find((value) => typeof value === 'string' && value.trim())
      if (typeof firstKey === 'string') return firstKey.trim()
    } catch {
      return null
    }
  }

  return Deno.env.get('SUPABASE_PUBLISHABLE_KEY')?.trim() || null
}

function callbackUrl(origin: URL, event: 'success' | 'exit' | 'event'): string {
  const url = new URL('/financeiro/bancos', origin)
  url.searchParams.set('belvo_callback', event)
  return url.toString()
}

function digitsOnlyCpf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const digits = value.replace(/\D/g, '')
  return digits.length === 11 ? digits : null
}

function widgetResponseUrl(accessToken: string): string {
  const url = new URL(BELVO_WIDGET_URL)
  url.searchParams.set('access_token', accessToken)
  url.searchParams.set('locale', 'pt')
  url.searchParams.set('integration_type', 'openfinance')
  url.searchParams.set('institution_types', 'retail')
  url.searchParams.set('institutions', 'ofmockbank_br_retail')
  url.searchParams.set('country_codes', 'BR')
  url.searchParams.set('resources', BELVO_FETCH_RESOURCES.join(','))
  return url.toString()
}

function credentialsReady(config: BelvoConfiguration): boolean {
  return Boolean(config.secretId && config.secretPassword && config.termsUrl && config.appOrigin && config.webhookToken.length >= 32)
}

async function belvoGetLink(
  config: BelvoConfiguration,
  linkId: string,
): Promise<{ verified: boolean; status: string; institution: string | null }> {
  const authorization = `Basic ${btoa(`${config.secretId}:${config.secretPassword}`)}`
  const response = await fetch(`${BELVO_SANDBOX_API}/links/${encodeURIComponent(linkId)}/`, {
    method: 'GET',
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: authorization, Accept: 'application/json' },
  })
  if (!response.ok) throw new RequestError(502, 'belvo_link_verification_failed')

  let providerResponse: unknown
  try {
    providerResponse = await response.json()
  } catch {
    throw new RequestError(502, 'invalid_belvo_response')
  }
  if (!isRecord(providerResponse)) throw new RequestError(502, 'invalid_belvo_response')

  const rawStatus = providerResponse.status
  const allowedStatuses = new Set(['valid', 'invalid', 'unconfirmed', 'token_required'])
  if (typeof rawStatus !== 'string' || !allowedStatuses.has(rawStatus)) {
    throw new RequestError(502, 'invalid_belvo_response')
  }

  const rawInstitution = providerResponse.institution
  const institution = typeof rawInstitution === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/i.test(rawInstitution)
    ? rawInstitution
    : null
  if (institution !== BELVO_SANDBOX_INSTITUTION) throw new RequestError(403, 'sandbox_institution_mismatch')
  return { verified: rawStatus === 'valid', status: rawStatus, institution }
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authorization = request.headers.get('Authorization')
  const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1]
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim()
  const apiKey = supabaseApiKey()
  if (!bearer || !supabaseUrl || !apiKey) return json({ error: 'unauthorized' }, 401)

  let body: Record<string, unknown>
  try {
    const rawBody = await request.text()
    if (rawBody.length > 64 * 1024) return json({ error: 'request_too_large' }, 413)
    const parsed: unknown = JSON.parse(rawBody)
    if (!isRecord(parsed)) return json({ error: 'invalid_request' }, 400)
    body = parsed
  } catch {
    return json({ error: 'invalid_request' }, 400)
  }

  const action = body.action
  const businessId = body.business_id
  if (!['status', 'create_widget_token', 'verify_link'].includes(String(action))) {
    return json({ error: 'invalid_action' }, 400)
  }
  if (!isUuid(businessId)) return json({ error: 'invalid_business_id' }, 400)

  const supabase = createClient(supabaseUrl, apiKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  })

  try {
    const { data: userData, error: userError } = await supabase.auth.getUser(bearer)
    if (userError || !userData.user) return json({ error: 'unauthorized' }, 401)

    const { data: membership, error: membershipError } = await supabase
      .from('business_memberships')
      .select('role')
      .eq('business_id', businessId)
      .eq('user_id', userData.user.id)
      .maybeSingle()
    if (membershipError) return json({ error: 'access_check_failed' }, 500)
    if (!membership || membership.role !== 'owner') return json({ error: 'forbidden' }, 403)

    const config = loadConfiguration()
    if (action === 'status') {
      return json({ ready: config.missingConfig.length === 0, environment: 'sandbox', missing_config: config.missingConfig })
    }

    if (!credentialsReady(config)) return json({ error: 'belvo_sandbox_not_configured' }, 503)

    if (action === 'verify_link') {
      if (!isUuid(body.link_id)) return json({ error: 'invalid_link_id' }, 400)
      return json(await belvoGetLink(config, body.link_id))
    }

    const fullName = nonEmptyString(body.full_name, 120)
    const cpf = digitsOnlyCpf(body.cpf)
    if (!fullName || !cpf) return json({ error: 'invalid_identification_info' }, 400)

    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', businessId)
      .maybeSingle()
    if (businessError || !business || typeof business.name !== 'string' || !business.name.trim()) {
      return json({ error: 'business_not_found' }, businessError ? 500 : 404)
    }

    const origin = config.appOrigin
    if (!origin) return json({ error: 'belvo_sandbox_not_configured' }, 503)
    const callbacks = {
      success: callbackUrl(origin, 'success'),
      exit: callbackUrl(origin, 'exit'),
      event: callbackUrl(origin, 'event'),
    }
    const logoUrl = new URL('/shalom-adonai-logo.png', origin).toString()
    const payload = {
      id: config.secretId,
      password: config.secretPassword,
      scopes: BELVO_SCOPES,
      fetch_resources: BELVO_FETCH_RESOURCES,
      stale_in: '1d',
      widget: {
        purpose: TEST_PURPOSE,
        openfinance_feature: 'consent_link_creation',
        callback_urls: callbacks,
        branding: {
          company_icon: logoUrl,
          company_logo: logoUrl,
          company_name: business.name.trim().slice(0, 100),
          company_terms_url: config.termsUrl,
        },
        consent: {
          terms_and_conditions_url: config.termsUrl,
          permissions: BELVO_PERMISSIONS,
          identification_info: [{ type: 'CPF', number: cpf, name: fullName }],
        },
      },
    }

    const response = await fetch(`${BELVO_SANDBOX_API}/token/`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) return json({ error: 'belvo_token_creation_failed' }, 502)

    let providerResponse: unknown
    try {
      providerResponse = await response.json()
    } catch {
      return json({ error: 'invalid_belvo_response' }, 502)
    }
    if (!isRecord(providerResponse) || typeof providerResponse.access !== 'string' || !providerResponse.access.trim()) {
      return json({ error: 'invalid_belvo_response' }, 502)
    }

    const accessToken = providerResponse.access.trim()
    return json({
      widget_url: widgetResponseUrl(accessToken),
      expires_in_seconds: TOKEN_TTL_SECONDS,
    })
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status)
    return json({ error: 'belvo_unavailable' }, 502)
  }
})
