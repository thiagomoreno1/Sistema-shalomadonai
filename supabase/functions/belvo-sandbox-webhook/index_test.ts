import { handler } from './index.ts'

const webhookToken = 'local-test-token-with-at-least-thirty-two-characters'
const webhookUrl = 'http://localhost/functions/v1/belvo-sandbox-webhook'
const validEnvelope = {
  webhook_id: '0123456789abcdef0123456789abcdef',
  webhook_type: 'LINK',
  webhook_code: 'LINK_CREATED',
  link_id: '11111111-1111-4111-8111-111111111111',
  data: {},
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function responseFor(request: Request): Promise<Response> {
  return await handler(request)
}

Deno.test('Belvo sandbox webhook enforces its local request contract without external calls', async () => {
  const previousToken = Deno.env.get('BELVO_SANDBOX_WEBHOOK_TOKEN')
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (..._args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
    fetchCalls += 1
    return Promise.reject(new Error('unexpected external request'))
  }

  try {
    Deno.env.delete('BELVO_SANDBOX_WEBHOOK_TOKEN')
    const preflight = await responseFor(new Request(webhookUrl, { method: 'OPTIONS' }))
    assertEquals(preflight.status, 200, 'preflight status')

    const wrongMethod = await responseFor(new Request(webhookUrl, { method: 'GET' }))
    assertEquals(wrongMethod.status, 405, 'unsupported method status')

    const unconfigured = await responseFor(new Request(webhookUrl, {
      method: 'POST',
      body: JSON.stringify(validEnvelope),
    }))
    assertEquals(unconfigured.status, 503, 'missing secret status')

    Deno.env.set('BELVO_SANDBOX_WEBHOOK_TOKEN', webhookToken)
    const unauthorized = await responseFor(new Request(webhookUrl, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
      body: JSON.stringify(validEnvelope),
    }))
    assertEquals(unauthorized.status, 401, 'invalid bearer status')

    const invalidJson = await responseFor(new Request(webhookUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${webhookToken}` },
      body: '{',
    }))
    assertEquals(invalidJson.status, 400, 'malformed JSON status')

    const invalidEnvelope = await responseFor(new Request(webhookUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${webhookToken}` },
      body: JSON.stringify({ ...validEnvelope, link_id: 'invalid' }),
    }))
    assertEquals(invalidEnvelope.status, 400, 'invalid event schema status')

    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1))
        controller.close()
      },
    })
    const oversized = await responseFor(new Request(webhookUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${webhookToken}` },
      body: oversizedBody,
      duplex: 'half',
    } as RequestInit))
    assertEquals(oversized.status, 413, 'oversized event status')

    const accepted = await responseFor(new Request(webhookUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${webhookToken}` },
      body: JSON.stringify(validEnvelope),
    }))
    assertEquals(accepted.status, 202, 'valid event status')
    const acceptedBody = await accepted.json()
    assertEquals(JSON.stringify(acceptedBody), JSON.stringify({ received: true }), 'response does not echo the event')
    assert(fetchCalls === 0, 'webhook must not make outbound requests')
  } finally {
    globalThis.fetch = originalFetch
    if (previousToken === undefined) Deno.env.delete('BELVO_SANDBOX_WEBHOOK_TOKEN')
    else Deno.env.set('BELVO_SANDBOX_WEBHOOK_TOKEN', previousToken)
  }
})
