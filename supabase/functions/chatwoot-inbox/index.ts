import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type MessageType = 'incoming' | 'outgoing' | 'activity'

type NormalizedAttachment = {
  id: string
  file_type: string | null
  extension: string | null
  file_size: number | null
  width: number | null
  height: number | null
}

type NormalizedMessage = {
  id: string
  content: string | null
  created_at: string | null
  message_type: MessageType
  private: boolean
  sender: { name: string | null }
  attachments: NormalizedAttachment[]
}

type NormalizedConversation = {
  id: string
  inbox_id: string
  status: string
  can_reply: boolean
  contact: { name: string | null; phone: string | null }
  last_activity_at: string | null
  last_message: NormalizedMessage | null
  messages: NormalizedMessage[]
}

type ChatwootConfiguration = {
  baseUrl: URL
  accountId: string
  inboxId: string
  apiToken: string
  attachmentAllowedHosts: Set<string>
}

const CHATWOOT_CONVERSATIONS_PER_PAGE = 25
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_ATTACHMENT_REDIRECTS = 5
const INLINE_MEDIA_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'audio/aac',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/3gpp',
  'video/mp4',
  'video/webm',
  'video/3gpp',
])

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
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

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numericId(value: unknown): string | null {
  const id = typeof value === 'number' ? String(value) : stringValue(value)
  return id && /^[0-9]{1,32}$/.test(id) ? id : null
}

function nonNegativeInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function attachmentRows(value: Record<string, unknown>): unknown[] {
  if (Array.isArray(value.attachments) && value.attachments.length > 0) return value.attachments
  return isRecord(value.attachment) ? [value.attachment] : []
}

function normalizedAttachment(value: unknown): NormalizedAttachment | null {
  if (!isRecord(value)) return null
  const id = numericId(value.id)
  if (!id) return null

  const fileType = stringValue(value.file_type)?.toLowerCase() ?? null
  const extension = stringValue(value.extension)?.toLowerCase() ?? null
  return {
    id,
    file_type: fileType && /^[a-z0-9_-]{1,32}$/.test(fileType) ? fileType : null,
    extension: extension && /^[a-z0-9]{1,16}$/.test(extension) ? extension : null,
    file_size: nonNegativeInteger(value.file_size),
    width: nonNegativeInteger(value.width),
    height: nonNegativeInteger(value.height),
  }
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 100_000_000_000 ? value * 1000 : value
    const date = new Date(milliseconds)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return isoTimestamp(numeric)
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  return null
}

function normalizedMessage(value: unknown): NormalizedMessage | null {
  if (!isRecord(value)) return null

  const messageType = value.message_type
  let type: MessageType = 'activity'
  if (messageType === 0 || messageType === 'incoming') type = 'incoming'
  if (messageType === 1 || messageType === 'outgoing') type = 'outgoing'
  if (messageType === 2 || messageType === 'activity') type = 'activity'

  const sender = isRecord(value.sender) ? value.sender : null
  const messageId = numericId(value.id)
  if (!messageId) return null
  const attachments = attachmentRows(value)
    .map(normalizedAttachment)
    .filter((attachment): attachment is NormalizedAttachment => attachment !== null)

  return {
    id: messageId,
    content: stringValue(value.processed_message_content) ?? stringValue(value.content),
    created_at: isoTimestamp(value.created_at),
    message_type: type,
    private: value.private === true,
    sender: { name: sender ? stringValue(sender.name) : null },
    attachments,
  }
}

function normalizedConversation(value: unknown): NormalizedConversation | null {
  if (!isRecord(value)) return null

  const id = numericId(value.id)
  const inboxId = numericId(value.inbox_id)
  if (!id || !inboxId) return null

  const meta = isRecord(value.meta) ? value.meta : null
  const sender = meta && isRecord(meta.sender) ? meta.sender : null
  const directContact = isRecord(value.contact) ? value.contact : null
  const rawMessages = Array.isArray(value.messages) ? value.messages : []
  const messages = rawMessages
    .map(normalizedMessage)
    .filter((message): message is NormalizedMessage => message !== null)
    .sort((left, right) => (left.created_at ?? '').localeCompare(right.created_at ?? ''))

  const lastNonActivity = normalizedMessage(value.last_non_activity_message)
  const lastMessage = lastNonActivity ?? [...messages].reverse().find((message) => message.message_type !== 'activity') ?? null

  return {
    id,
    inbox_id: inboxId,
    status: stringValue(value.status) ?? 'open',
    can_reply: value.can_reply === true,
    contact: {
      name: (sender ? stringValue(sender.name) : null) ?? (directContact ? stringValue(directContact.name) : null),
      phone:
        (sender ? stringValue(sender.phone_number) : null) ??
        (directContact ? stringValue(directContact.phone_number) : null),
    },
    last_activity_at: isoTimestamp(value.last_activity_at ?? value.timestamp),
    last_message: lastMessage,
    messages,
  }
}

function loadConfiguration(): ChatwootConfiguration | null {
  const baseUrlValue = Deno.env.get('CHATWOOT_BASE_URL')?.trim()
  const accountId = Deno.env.get('CHATWOOT_ACCOUNT_ID')?.trim() ?? ''
  const inboxId = Deno.env.get('CHATWOOT_INBOX_ID')?.trim() ?? ''
  const apiToken = Deno.env.get('CHATWOOT_API_TOKEN')?.trim() ?? ''
  if (!baseUrlValue || !/^[0-9]{1,32}$/.test(accountId) || !/^[0-9]{1,32}$/.test(inboxId) || !apiToken) {
    return null
  }

  try {
    const baseUrl = new URL(baseUrlValue)
    const localHttpHost = baseUrl.hostname === 'localhost' || baseUrl.hostname === '127.0.0.1'
    if (
      (baseUrl.protocol !== 'https:' && !(localHttpHost && baseUrl.protocol === 'http:')) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash ||
      baseUrl.pathname !== '/'
    ) {
      return null
    }

    const attachmentAllowedHosts = new Set([baseUrl.hostname.toLowerCase()])
    for (const item of Deno.env.get('CHATWOOT_ATTACHMENT_ALLOWED_HOSTS')?.split(',') ?? []) {
      const hostname = item.trim().toLowerCase()
      if (/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
        attachmentAllowedHosts.add(hostname)
      }
    }

    return { baseUrl, accountId, inboxId, apiToken, attachmentAllowedHosts }
  } catch {
    return null
  }
}

function supabaseApiKey(): string | null {
  const legacyKey = Deno.env.get('SUPABASE_ANON_KEY')?.trim()
  if (legacyKey) return legacyKey

  const keyMap = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')
  if (keyMap) {
    try {
      const parsed = JSON.parse(keyMap) as Record<string, unknown>
      const defaultKey = stringValue(parsed.default)
      if (defaultKey) return defaultKey
      const firstKey = Object.values(parsed).find((value) => typeof value === 'string')
      if (typeof firstKey === 'string') return firstKey
    } catch {
      return null
    }
  }

  return Deno.env.get('SUPABASE_PUBLISHABLE_KEY')?.trim() || null
}

function apiUrl(config: ChatwootConfiguration, path: string): URL {
  return new URL(`/api/v1/accounts/${config.accountId}${path}`, config.baseUrl)
}

async function chatwootRequest(
  config: ChatwootConfiguration,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${config.apiToken}`)
  if (init?.body) headers.set('Content-Type', 'application/json')

  const response = await fetch(apiUrl(config, path), {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers,
  })

  if (!response.ok) {
    throw new RequestError(502, response.status === 401 || response.status === 403 ? 'chatwoot_auth_failed' : 'chatwoot_request_failed')
  }

  if (response.status === 204) return null
  return await response.json()
}

function responseConversation(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (isRecord(value.payload)) return value.payload
  if (isRecord(value.data)) {
    if (isRecord(value.data.payload)) return value.data.payload
    return value.data
  }
  return value
}

function conversationRows(value: unknown): unknown[] {
  const response = isRecord(value) && isRecord(value.data) ? value.data : value
  return isRecord(response) && Array.isArray(response.payload) ? response.payload : []
}

async function getConversation(
  config: ChatwootConfiguration,
  conversationId: string,
): Promise<NormalizedConversation> {
  return (await getConversationPayload(config, conversationId)).normalized
}

async function getConversationPayload(
  config: ChatwootConfiguration,
  conversationId: string,
): Promise<{ raw: Record<string, unknown>; normalized: NormalizedConversation }> {
  const result = await chatwootRequest(config, `/conversations/${conversationId}`)
  const raw = responseConversation(result)
  const normalized = normalizedConversation(raw)
  if (!isRecord(raw) || !normalized || normalized.id !== conversationId || normalized.inbox_id !== config.inboxId) {
    throw new RequestError(404, 'conversation_not_found')
  }
  return { raw, normalized }
}

function attachmentUrl(config: ChatwootConfiguration, value: unknown): URL {
  const rawUrl = isRecord(value) ? stringValue(value.data_url) : null
  if (!rawUrl || rawUrl.length > 4096) throw new RequestError(404, 'attachment_not_found')

  try {
    const url = new URL(rawUrl)
    const blobPathPrefix = '/rails/active_storage/blobs/redirect/'
    if (
      url.protocol !== 'https:' ||
      url.origin !== config.baseUrl.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith(blobPathPrefix) ||
      url.pathname.length <= blobPathPrefix.length
    ) {
      throw new RequestError(404, 'attachment_not_found')
    }
    return url
  } catch (error) {
    if (error instanceof RequestError) throw error
    throw new RequestError(404, 'attachment_not_found')
  }
}

function safeRedirectUrl(value: string, currentUrl: URL, config: ChatwootConfiguration): URL | null {
  try {
    const target = new URL(value, currentUrl)
    const hostname = target.hostname.toLowerCase()
    const isConfiguredOrigin = target.origin === config.baseUrl.origin
    const isAllowedHost = config.attachmentAllowedHosts.has(hostname)
    const isLocalName = hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    const isIpLiteral = hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(hostname)

    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.hash ||
      isLocalName ||
      (!isConfiguredOrigin && (!isAllowedHost || target.port !== '' || isIpLiteral))
    ) {
      return null
    }
    return target
  } catch {
    return null
  }
}

async function fetchAttachment(url: URL, config: ChatwootConfiguration): Promise<Response> {
  const signal = AbortSignal.timeout(30_000)

  for (let redirectCount = 0; redirectCount <= MAX_ATTACHMENT_REDIRECTS; redirectCount += 1) {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { Accept: '*/*' },
    })

    if (![301, 302, 303, 307, 308].includes(response.status)) return response

    const location = response.headers.get('Location')
    try {
      await response.body?.cancel()
    } catch {
      // The redirect body is discarded; it is not needed for the proxy response.
    }

    if (!location || redirectCount === MAX_ATTACHMENT_REDIRECTS) {
      throw new RequestError(502, 'attachment_unavailable')
    }

    const redirectedUrl = safeRedirectUrl(location, url, config)
    if (!redirectedUrl) throw new RequestError(502, 'attachment_unavailable')
    url = redirectedUrl
  }

  throw new RequestError(502, 'attachment_unavailable')
}

async function attachmentResponse(providerResponse: Response, attachmentId: string, extension: string | null): Promise<Response> {
  if (!providerResponse.ok || !providerResponse.body) {
    void providerResponse.body?.cancel().catch(() => undefined)
    throw new RequestError(502, 'attachment_unavailable')
  }

  const declaredLength = providerResponse.headers.get('Content-Length')
  if (declaredLength && /^[0-9]+$/.test(declaredLength) && Number(declaredLength) > MAX_ATTACHMENT_BYTES) {
    void providerResponse.body.cancel().catch(() => undefined)
    throw new RequestError(413, 'attachment_too_large')
  }

  const rawContentType = providerResponse.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase()
  const originalContentType = rawContentType && INLINE_MEDIA_TYPES.has(rawContentType)
    ? rawContentType
    : null
  const disposition = originalContentType ? 'inline' : 'attachment'
  const filename = `chatwoot-attachment-${attachmentId}${extension ? `.${extension}` : ''}`
  const reader = providerResponse.body.getReader()
  const chunks: Uint8Array[] = []
  let transferredBytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      transferredBytes += result.value.byteLength
      if (transferredBytes > MAX_ATTACHMENT_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new RequestError(413, 'attachment_too_large')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }

  return new Response(new Blob(chunks, { type: originalContentType ?? 'application/octet-stream' }), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Original-Content-Type',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `${disposition}; filename="${filename}"`,
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'none',
      ...(originalContentType ? { 'X-Original-Content-Type': originalContentType } : {}),
    },
  })
}

function requiredText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= maximumLength ? trimmed : null
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authorization = request.headers.get('Authorization')
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i)
  const token = bearerMatch?.[1]
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim()
  const key = supabaseApiKey()
  if (!token || !supabaseUrl || !key) return json({ error: 'unauthorized' }, 401)

  let body: Record<string, unknown>
  try {
    const parsed: unknown = await request.json()
    if (!isRecord(parsed)) return json({ error: 'invalid_request' }, 400)
    body = parsed
  } catch {
    return json({ error: 'invalid_request' }, 400)
  }

  const action = body.action
  const businessId = body.business_id
  if (!isUuid(businessId)) return json({ error: 'invalid_business_id' }, 400)
  if (!['status', 'list', 'conversation', 'send', 'set_status', 'attachment'].includes(String(action))) {
    return json({ error: 'invalid_action' }, 400)
  }

  const supabase = createClient(supabaseUrl, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

  try {
    const { data: userData, error: userError } = await supabase.auth.getUser(token)
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
    if (action === 'status') return json({ configured: config !== null })
    if (!config) return json({ error: 'chatwoot_not_configured' }, 503)

    if (action === 'list') {
      const status = body.status
      if (status !== 'open' && status !== 'resolved' && status !== 'all') {
        return json({ error: 'invalid_status' }, 400)
      }
      const page = typeof body.page === 'number' && Number.isInteger(body.page) ? body.page : 1
      if (page < 1 || page > 1000) return json({ error: 'invalid_page' }, 400)
      const query = body.query === undefined ? null : requiredText(body.query, 120)
      if (body.query !== undefined && body.query !== '' && !query) return json({ error: 'invalid_query' }, 400)

      const fetchPage = async (targetPage: number) => {
        const params = new URLSearchParams({ status, page: String(targetPage), inbox_id: config.inboxId })
        if (query) params.set('q', query)
        return conversationRows(await chatwootRequest(config, `/conversations?${params.toString()}`))
      }

      const rows = await fetchPage(page)
      const conversations = rows
        .map(normalizedConversation)
        .filter((conversation): conversation is NormalizedConversation =>
          conversation !== null && conversation.inbox_id === config.inboxId,
        )
        .map((conversation) => ({ ...conversation, messages: [] }))

      let hasMore = false
      if (page < 1000 && rows.length >= CHATWOOT_CONVERSATIONS_PER_PAGE) {
        const nextRows = await fetchPage(page + 1)
        hasMore = nextRows.some((row) =>
          isRecord(row) && numericId(row.inbox_id) === config.inboxId,
        )
      }

      return json({ conversations, meta: { page, has_more: hasMore } })
    }

    const conversationId = numericId(body.conversationId)
    if (!conversationId) return json({ error: 'invalid_conversation_id' }, 400)

    if (action === 'attachment') {
      const messageId = numericId(body.messageId)
      const attachmentId = numericId(body.attachmentId)
      if (!messageId || !attachmentId) return json({ error: 'invalid_attachment_reference' }, 400)

      const { raw } = await getConversationPayload(config, conversationId)
      const rawMessages = Array.isArray(raw.messages) ? raw.messages : []
      const message = rawMessages.find((row) => isRecord(row) && numericId(row.id) === messageId)
      if (!isRecord(message)) throw new RequestError(404, 'attachment_not_found')

      const attachment = attachmentRows(message).find((row) =>
        isRecord(row) && numericId(row.id) === attachmentId,
      )
      if (!isRecord(attachment)) throw new RequestError(404, 'attachment_not_found')

      const parentMessageId = numericId(attachment.message_id)
      if (parentMessageId && parentMessageId !== messageId) {
        throw new RequestError(404, 'attachment_not_found')
      }
      const declaredFileSize = nonNegativeInteger(attachment.file_size)
      if (declaredFileSize !== null && declaredFileSize > MAX_ATTACHMENT_BYTES) {
        throw new RequestError(413, 'attachment_too_large')
      }

      const providerResponse = await fetchAttachment(attachmentUrl(config, attachment), config)
      const metadata = normalizedAttachment(attachment)
      return await attachmentResponse(providerResponse, attachmentId, metadata?.extension ?? null)
    }

    if (action === 'conversation') {
      return json({ conversation: await getConversation(config, conversationId) })
    }

    if (action === 'send') {
      const content = requiredText(body.content, 4000)
      if (!content) return json({ error: 'invalid_message' }, 400)
      const conversation = await getConversation(config, conversationId)
      if (!conversation.can_reply) return json({ error: 'conversation_cannot_reply' }, 409)

      const result = await chatwootRequest(config, `/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content, message_type: 'outgoing', private: false, content_type: 'text' }),
      })
      const message = normalizedMessage(responseConversation(result))
      if (!message) return json({ error: 'invalid_chatwoot_response' }, 502)
      return json({ message })
    }

    if (action === 'set_status') {
      const status = body.status
      if (status !== 'open' && status !== 'resolved') return json({ error: 'invalid_status' }, 400)
      await getConversation(config, conversationId)
      await chatwootRequest(config, `/conversations/${conversationId}/toggle_status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      })
      return json({ conversation: await getConversation(config, conversationId) })
    }

    return json({ error: 'invalid_action' }, 400)
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.code }, error.status)
    console.error('Chatwoot inbox request failed.')
    return json({ error: 'chatwoot_unavailable' }, 502)
  }
})
