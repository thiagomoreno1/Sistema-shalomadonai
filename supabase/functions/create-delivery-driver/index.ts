import { createClient } from 'npm:@supabase/supabase-js@2.118.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
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

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function publishableKey(): string | null {
  const legacyKey = Deno.env.get('SUPABASE_ANON_KEY')?.trim()
  if (legacyKey) return legacyKey

  for (const keyMap of [Deno.env.get('SUPABASE_PUBLISHABLE_KEYS'), Deno.env.get('SUPABASE_PUBLISHABLE_KEY')]) {
    if (!keyMap) continue
    try {
      const parsed = JSON.parse(keyMap) as Record<string, unknown>
      if (typeof parsed.default === 'string' && parsed.default.trim()) return parsed.default.trim()
      const firstKey = Object.values(parsed).find((value) => typeof value === 'string' && value.trim())
      if (typeof firstKey === 'string') return firstKey.trim()
    } catch {
      if (keyMap.trim()) return keyMap.trim()
    }
  }
  return null
}

function secretKey(): string | null {
  const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys) as Record<string, unknown>
      if (typeof parsed.default === 'string' && parsed.default.trim()) return parsed.default.trim()
    } catch {
      return null
    }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() || null
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authorization = request.headers.get('Authorization')
  const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1]
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim()
  const publicKey = publishableKey()
  const privateKey = secretKey()
  if (!bearer || !supabaseUrl || !publicKey) return json({ error: 'unauthorized' }, 401)
  if (!privateKey) return json({ error: 'account_service_unavailable' }, 503)

  let body: Record<string, unknown>
  try {
    const rawBody = await request.text()
    if (rawBody.length > 16 * 1024) return json({ error: 'request_too_large' }, 413)
    const parsed: unknown = JSON.parse(rawBody)
    if (!isRecord(parsed)) return json({ error: 'invalid_request' }, 400)
    body = parsed
  } catch {
    return json({ error: 'invalid_request' }, 400)
  }

  const businessId = body.business_id
  const workerId = body.worker_id
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!isUuid(businessId) || !isUuid(workerId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    return json({ error: 'invalid_account_details' }, 400)
  }
  if (password.length < 8 || password.length > 128) return json({ error: 'invalid_password' }, 400)

  const userClient = createClient(supabaseUrl, publicKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  })

  const { data: userData, error: userError } = await userClient.auth.getUser(bearer)
  if (userError || !userData.user) return json({ error: 'unauthorized' }, 401)
  const actor = userData.user

  const { data: membership, error: membershipError } = await userClient
    .from('business_memberships')
    .select('role')
    .eq('business_id', businessId)
    .eq('user_id', actor.id)
    .maybeSingle()
  if (membershipError) return json({ error: 'access_check_failed' }, 500)
  if (membership?.role !== 'owner') return json({ error: 'forbidden' }, 403)

  const { data: worker, error: workerError } = await userClient
    .from('delivery_workers')
    .select('id, name, is_active, user_id')
    .eq('business_id', businessId)
    .eq('id', workerId)
    .maybeSingle()
  if (workerError) return json({ error: 'worker_lookup_failed' }, 500)
  if (!worker) return json({ error: 'worker_not_found' }, 404)
  if (!worker.is_active) return json({ error: 'worker_inactive' }, 409)
  if (worker.user_id) return json({ error: 'worker_already_linked' }, 409)

  // The secret key is only used on this server. New Supabase secret keys must
  // be sent as `apikey`, without an Authorization bearer value.
  const adminClient = createClient(supabaseUrl, privateKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers)
        headers.set('apikey', privateKey)
        if (privateKey.startsWith('sb_secret_')) headers.delete('Authorization')
        return fetch(input, { ...init, headers })
      },
    },
  })

  const { data: createdUser, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: worker.name,
      account_type: 'delivery_driver',
    },
  })

  if (createError || !createdUser.user) {
    const code = createError?.code?.toLowerCase() ?? ''
    const message = createError?.message.toLowerCase() ?? ''
    if (code.includes('already') || code === 'email_exists' || message.includes('already registered') || message.includes('already exists')) {
      return json({ error: 'email_already_exists' }, 409)
    }
    if (code.includes('password') || message.includes('password')) return json({ error: 'invalid_password' }, 400)
    return json({ error: 'account_creation_failed' }, 400)
  }

  const { data: linkedWorkerId, error: linkError } = await userClient.rpc('link_delivery_worker_account', {
    p_business_id: businessId,
    p_worker_id: workerId,
    p_email: email,
  })

  if (linkError || linkedWorkerId !== workerId) {
    if (linkError?.message.toLowerCase().includes('already has business access')) {
      return json({ error: 'email_has_management_access' }, 409)
    }
    // Keep the confirmed identity intact if another owner-approved membership
    // won the database lock. The UI can then offer the existing-account flow;
    // deleting here could cascade-delete that newly approved membership.
    return json({ error: 'account_created_unlinked' }, 409)
  }

  return json({ worker_id: linkedWorkerId })
})
