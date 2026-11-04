const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
}

const MAX_BODY_BYTES = 64 * 1024

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  let difference = leftBytes.length ^ rightBytes.length
  const length = Math.max(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  }
  return difference === 0
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isEventEnvelope(value: unknown): boolean {
  if (!isRecord(value)) return false
  const validWebhookId = typeof value.webhook_id === 'string' &&
    (/^[a-f0-9]{32}$/i.test(value.webhook_id) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.webhook_id))
  const validType = typeof value.webhook_type === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/i.test(value.webhook_type)
  const validCode = typeof value.webhook_code === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,95}$/.test(value.webhook_code)
  const validProcess = value.process_type === undefined || value.process_type === null ||
    (typeof value.process_type === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,95}$/.test(value.process_type))
  const validData = value.data === null || isRecord(value.data)
  return validWebhookId && validType && validCode && validProcess && isUuid(value.link_id) && validData
}

async function readBoundedBody(request: Request): Promise<string | null> {
  const contentLength = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return null
  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(body)
}

export async function handler(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const expectedToken = Deno.env.get('BELVO_SANDBOX_WEBHOOK_TOKEN')?.trim() ?? ''
  if (expectedToken.length < 32) return json({ error: 'webhook_not_configured' }, 503)

  const authorization = request.headers.get('Authorization') ?? ''
  const suppliedToken = authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? ''
  if (!constantTimeEqual(suppliedToken, expectedToken)) return json({ error: 'unauthorized' }, 401)

  let rawBody: string | null
  try {
    rawBody = await readBoundedBody(request)
  } catch {
    return json({ error: 'invalid_event' }, 400)
  }
  if (rawBody === null) return json({ error: 'event_too_large' }, 413)

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return json({ error: 'invalid_event' }, 400)
  }
  if (!isEventEnvelope(payload)) return json({ error: 'invalid_event' }, 400)

  return json({ received: true }, 202)
}

if (import.meta.main) Deno.serve(handler)
