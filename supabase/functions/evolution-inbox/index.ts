import { withSupabase } from '@supabase/server'

const PAGE_SIZE = 25
const MESSAGE_HISTORY_LIMIT = 150
const OLDER_MESSAGE_PAGE_SIZE = 50
const LEGACY_CHAT_PAGE_SIZE = 50
const LEGACY_SYNC_COOLDOWN_MS = 60_000
const MAX_MEDIA_BYTES = 10 * 1024 * 1024
const MAX_OUTBOUND_MEDIA_BYTES = 2 * 1024 * 1024
const MAX_REQUEST_BYTES = 3_000_000
const MAX_EVOLUTION_JSON_BYTES = 4_000_000
const OUTBOUND_MEDIA_TYPES: Record<string, 'image' | 'audio' | 'video' | 'document'> = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image',
  'audio/aac': 'audio', 'audio/mpeg': 'audio', 'audio/mp4': 'audio', 'audio/ogg': 'audio', 'audio/wav': 'audio', 'audio/webm': 'audio',
  'video/mp4': 'video',
  'application/pdf': 'document',
}
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
}
const recentLegacySync = new Map<string, { at: number; result: JsonRecord }>()

type JsonRecord = Record<string, unknown>
type EvolutionConfig = {
  baseUrl: URL
  apiKey: string
  instanceName: string
  businessId: string | null
  webhookUrl: string | null
  webhookSecret: string | null
}

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= maximumLength ? normalized : null
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isGroupJid(value: unknown): boolean {
  return typeof value === 'string' && /@g\.us$/i.test(value)
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS })
}

function parseConfiguration(source: JsonRecord): EvolutionConfig | null {
  const baseUrlValue = text(source.evolution_api_url, 2048) ?? ''
  const apiKey = text(source.evolution_api_key, 4096) ?? ''
  const instanceName = text(source.evolution_instance_name, 120) ?? ''
  const businessId = text(source.evolution_business_id, 64)
  const webhookUrl = text(source.evolution_webhook_url, 2048)
  const webhookSecret = text(source.evolution_webhook_secret, 4096)
  if (!baseUrlValue || !apiKey || !instanceName || !isUuid(businessId) || !webhookUrl || !webhookSecret) return null
  try {
    const baseUrl = new URL(baseUrlValue)
    const localHost = baseUrl.hostname === 'localhost'
      || baseUrl.hostname === '127.0.0.1'
      || baseUrl.hostname === 'host.docker.internal'
      || baseUrl.hostname === 'evolution-api'
      || baseUrl.hostname.endsWith('.local')
      || baseUrl.hostname.endsWith('.internal')
    if ((baseUrl.protocol !== 'https:' && !(localHost && baseUrl.protocol === 'http:'))
      || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) return null
    return { baseUrl, apiKey, instanceName, businessId, webhookUrl, webhookSecret }
  } catch {
    return null
  }
}

async function loadConfiguration(admin: { rpc: (name: string) => PromiseLike<{ data: unknown; error: unknown }> }): Promise<EvolutionConfig | null> {
  const environment = parseConfiguration({
    evolution_api_url: Deno.env.get('EVOLUTION_API_URL'),
    evolution_api_key: Deno.env.get('EVOLUTION_API_KEY'),
    evolution_instance_name: Deno.env.get('EVOLUTION_INSTANCE_NAME'),
    evolution_business_id: Deno.env.get('EVOLUTION_BUSINESS_ID'),
    evolution_webhook_url: Deno.env.get('EVOLUTION_WEBHOOK_URL'),
    evolution_webhook_secret: Deno.env.get('EVOLUTION_WEBHOOK_SECRET'),
  })
  if (environment) return environment
  try {
    const { data, error } = await admin.rpc('get_evolution_runtime_config')
    if (error || !isRecord(data)) return null
    return parseConfiguration(data)
  } catch {
    return null
  }
}

function evolutionUrl(config: EvolutionConfig, path: string): URL {
  return new URL(path.replace(/^\//, ''), `${config.baseUrl.toString().replace(/\/$/, '')}/`)
}

async function readBoundedEvolutionResponse(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new RequestError(502, 'evolution_response_too_large')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new RequestError(502, 'evolution_response_too_large')
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

async function evolutionRequest(config: EvolutionConfig, path: string, init?: RequestInit, maximumResponseBytes = MAX_EVOLUTION_JSON_BYTES): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set('apikey', config.apiKey)
  headers.set('Accept', 'application/json')
  if (init?.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(evolutionUrl(config, path), {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new RequestError(response.status === 401 || response.status === 403 ? 502 : 503, 'evolution_request_failed')
  }
  if (response.status === 204) return null
  const raw = await readBoundedEvolutionResponse(response, maximumResponseBytes)
  if (!raw) return null
  try { return JSON.parse(raw) as unknown } catch { return raw }
}

async function setEvolutionWebhook(config: EvolutionConfig): Promise<void> {
  if (!config.webhookUrl || !config.webhookSecret) throw new RequestError(503, 'webhook_not_configured')
  let parsedUrl: URL
  try { parsedUrl = new URL(config.webhookUrl) } catch { throw new RequestError(503, 'webhook_url_invalid') }
  const localWebhookHost = parsedUrl.hostname === 'kong'
    || parsedUrl.hostname === '127.0.0.1'
    || parsedUrl.hostname === 'localhost'
    || /^supabase_kong_[a-z0-9_]+$/.test(parsedUrl.hostname)
  const validWebhookPath = parsedUrl.pathname === '/functions/v1/evolution-webhook'
  const safeWebhookUrl = !parsedUrl.username && !parsedUrl.password && !parsedUrl.search && !parsedUrl.hash
  if (!validWebhookPath || !safeWebhookUrl || (parsedUrl.protocol !== 'https:' && !localWebhookHost)) {
    throw new RequestError(503, 'webhook_url_invalid')
  }
  await evolutionRequest(config, `/webhook/set/${encodeURIComponent(config.instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({ webhook: {
      enabled: true,
      url: config.webhookUrl,
      headers: { Authorization: `Bearer ${config.webhookSecret}` },
      events: ['MESSAGES_SET', 'MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'SEND_MESSAGE', 'CONTACTS_SET', 'CONTACTS_UPSERT', 'CONTACTS_UPDATE', 'CHATS_SET', 'CHATS_UPSERT', 'CHATS_UPDATE', 'GROUPS_UPSERT', 'GROUP_UPDATE', 'CALL', 'CONNECTION_UPDATE'],
      byEvents: false,
      base64: false,
    } }),
  })
}

async function syncLegacyChats(admin: any, config: EvolutionConfig, businessId: string, providerPage: number): Promise<JsonRecord> {
  const cacheKey = `${businessId}:${config.instanceName}:${providerPage}`
  const cached = recentLegacySync.get(cacheKey)
  if (cached && Date.now() - cached.at < LEGACY_SYNC_COOLDOWN_MS) {
    return { ...cached.result, status: 'recently_synced' }
  }

  let chatRecords: JsonRecord[]
  let contactRecords: JsonRecord[] = []
  let chatPages = 0
  try {
    const [chatResult, contactResult] = await Promise.all([
      evolutionRequest(config, `/chat/findChats/${encodeURIComponent(config.instanceName)}`, {
        method: 'POST', body: JSON.stringify({
          where: {}, page: providerPage, offset: LEGACY_CHAT_PAGE_SIZE,
          // Baileys versions that expose raw take/skip still get a hard page cap.
          take: LEGACY_CHAT_PAGE_SIZE, skip: (providerPage - 1) * LEGACY_CHAT_PAGE_SIZE,
        }),
      }),
      evolutionRequest(config, `/chat/findContacts/${encodeURIComponent(config.instanceName)}`, {
        method: 'POST', body: JSON.stringify({
          where: {}, page: 1, offset: LEGACY_CHAT_PAGE_SIZE,
          take: LEGACY_CHAT_PAGE_SIZE, skip: 0,
        }),
      }).catch(() => null),
    ])
    chatRecords = recordsFromEvolution(chatResult, ['chats', 'records', 'data']).slice(0, LEGACY_CHAT_PAGE_SIZE)
    contactRecords = recordsFromEvolution(contactResult, ['contacts', 'records', 'data']).slice(0, LEGACY_CHAT_PAGE_SIZE)
    const chatPageInfo = isRecord(chatResult) && isRecord(chatResult.chats) ? chatResult.chats : isRecord(chatResult) ? chatResult : {}
    chatPages = Number(chatPageInfo.pages ?? chatPageInfo.totalPages) || 0
  } catch {
    return {
      status: 'unavailable', synced_conversations: 0, imported_messages: 0,
      has_more: false, provider_page: providerPage,
      notice: 'Não foi possível consultar conversas antigas na Evolution. As conversas já sincronizadas continuam disponíveis.',
    }
  }

  const namesByJid = new Map<string, string>()
  for (const contact of contactRecords) {
    const jid = text(contact.remoteJid ?? contact.id ?? contact.wuid, 256)
    if (!jid || isGroupJid(jid)) continue
    const name = savedContactName(contact)
    if (name) namesByJid.set(jid, name)
  }

  let syncedConversations = 0
  let importedMessages = 0
  for (const chat of chatRecords) {
    const jid = text(chat.remoteJid ?? chat.jid ?? chat.id, 256)
    if (!jid) continue
    const group = isGroupJid(jid)
    const jidAlt = text(chat.remoteJidAlt ?? chat.remoteJidLid ?? chat.phoneNumberJid, 256)
    const savedName = group
      ? evolutionName(chat, true)
      // Prefer the chat label, which can reflect the local WhatsApp contact
      // name, over the contact's remote profile pushName.
      : text(chat.name, 160) ?? namesByJid.get(jid) ?? text(chat.notify, 160) ?? text(chat.verifiedName, 160)
    const fallbackName = group ? null : text(chat.pushName, 160)
    const name = savedName ?? fallbackName
    const phone = group ? null : phoneFromWhatsAppJid(jidAlt ?? jid)
    const activity = providerTimestamp(chat.lastMessageRecvTimestamp ?? chat.conversationTimestamp ?? chat.updatedAt)
    const unread = typeof chat.unreadCount === 'number' && Number.isInteger(chat.unreadCount) ? Math.max(0, chat.unreadCount)
      : typeof chat.unreadMessages === 'number' && Number.isInteger(chat.unreadMessages) ? Math.max(0, chat.unreadMessages) : 0
    const { data: existing, error: lookupError } = await admin.from('whatsapp_conversations')
      .select('id, contact_name, last_activity_at')
      .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('remote_jid', jid).maybeSingle()
    if (lookupError) throw new RequestError(500, 'history_sync_failed')
    let conversationId = typeof existing?.id === 'string' ? existing.id : null
    if (conversationId) {
      const update: JsonRecord = {}
      if (savedName) update.contact_name = savedName
      else if (!text(existing.contact_name, 160) && fallbackName) update.contact_name = fallbackName
      if (group) update.contact_phone = null
      else if (phone) update.contact_phone = phone
      if (jidAlt) update.remote_jid_alt = jidAlt
      if (!existing.last_activity_at || activity > String(existing.last_activity_at)) update.last_activity_at = activity
      if (unread > 0) update.unread_count = unread
      if (Object.keys(update).length) {
        const { error } = await admin.from('whatsapp_conversations').update(update)
          .eq('business_id', businessId).eq('id', conversationId)
        if (error) throw new RequestError(500, 'history_sync_failed')
      }
    } else {
      const { data, error } = await admin.from('whatsapp_conversations').upsert({
        business_id: businessId,
        instance_name: config.instanceName,
        remote_jid: jid,
        remote_jid_alt: jidAlt,
        contact_name: name ?? (group ? null : text(chat.pushName, 160)),
        contact_phone: phone,
        last_activity_at: activity,
        unread_count: unread,
      }, { onConflict: 'business_id,instance_name,remote_jid', ignoreDuplicates: true }).select('id').maybeSingle()
      if (error) throw new RequestError(500, 'history_sync_failed')
      conversationId = typeof data?.id === 'string' ? data.id : null
      if (!conversationId) {
        const { data: raced } = await admin.from('whatsapp_conversations').select('id')
          .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('remote_jid', jid).maybeSingle()
        conversationId = typeof raced?.id === 'string' ? raced.id : null
      }
    }
    if (!conversationId) continue
    syncedConversations += 1

    if (!group) await resolvePhoneMatchForInbox(admin, businessId, phone, conversationId)

    if (group) {
      const { error } = await admin.from('whatsapp_conversation_contexts').delete()
        .eq('business_id', businessId).eq('conversation_id', conversationId).eq('match_method', 'phone')
      if (error) throw new RequestError(500, 'history_sync_failed')
    }

    const lastMessage = providerMessagePayload(chat.lastMessage ?? chat.last_message)
    if (lastMessage && lastMessage.remote_jid === jid) {
      const { error } = await admin.from('whatsapp_messages').upsert({
        business_id: businessId,
        conversation_id: conversationId,
        instance_name: config.instanceName,
        provider_message_id: lastMessage.id,
        direction: lastMessage.direction,
        message_kind: lastMessage.message_kind,
        content: lastMessage.content,
        delivery_status: lastMessage.delivery_status,
        count_as_unread: false,
        media_metadata: lastMessage.media_metadata,
        provider_timestamp: lastMessage.provider_timestamp,
      }, { onConflict: 'business_id,instance_name,provider_message_id', ignoreDuplicates: true })
      if (error) throw new RequestError(500, 'history_sync_failed')
      importedMessages += 1
    }
  }

  // Contacts not present in the first chat page can still provide the saved
  // contact label for existing conversations. Never use these rows for groups.
  for (const [jid, name] of namesByJid) {
    const { error } = await admin.from('whatsapp_conversations').update({ contact_name: name })
      .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('remote_jid', jid).is('contact_name', null)
    if (error) throw new RequestError(500, 'history_sync_failed')
  }

  const result = {
    status: chatRecords.length === 0 && providerPage === 1 ? 'empty' : 'available',
    synced_conversations: syncedConversations,
    imported_messages: importedMessages,
    page_size: LEGACY_CHAT_PAGE_SIZE,
    provider_page: providerPage,
    has_more: chatPages > 0 ? providerPage < chatPages : chatRecords.length >= LEGACY_CHAT_PAGE_SIZE,
    ...(chatRecords.length === 0 && providerPage === 1
      ? { notice: 'A Evolution não retornou conversas salvas para importar. Confira a sincronização de histórico na instância.' }
      : {}),
  }
  recentLegacySync.set(cacheKey, { at: Date.now(), result })
  return result
}

function evolutionInstanceName(entry: unknown): string | null {
  if (!isRecord(entry)) return null
  const instance = isRecord(entry.instance) ? entry.instance : entry
  return text(instance.instanceName ?? instance.name, 120)
}

function conversationResponse(row: JsonRecord, lastMessage: JsonRecord | null) {
  const remoteJid = text(row.remote_jid, 256)
  const remoteJidAlt = text(row.remote_jid_alt, 256)
  const canReply = Boolean(remoteJid && !remoteJid.startsWith('unknown-call:')
    && (!remoteJid.includes('@lid') || (remoteJidAlt && phoneFromWhatsAppJid(remoteJidAlt))))
  return {
    id: row.id,
    inbox_id: row.instance_name,
    is_group: isGroupJid(remoteJid),
    status: row.status,
    can_reply: canReply,
    unread_count: Number(row.unread_count) || 0,
    contact: { name: row.contact_name ?? null, phone: isGroupJid(remoteJid) ? null : row.contact_phone ?? null },
    last_activity_at: row.last_activity_at,
    last_message: lastMessage ? normalizedMessage(lastMessage) : null,
    messages: [],
  }
}

function phoneFromWhatsAppJid(value: string): string | null {
  if (value.toLowerCase().includes('@lid') || isGroupJid(value)) return null
  const digits = value.split('@', 1)[0].split(':', 1)[0].replace(/\D/g, '')
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return `+${digits}`
  return null
}

function normalizedMessage(row: JsonRecord) {
  const kind = text(row.message_kind, 32) ?? 'unknown'
  const mediaMetadata = isRecord(row.media_metadata) ? row.media_metadata : {}
  const fileSize = typeof mediaMetadata.file_size === 'number' ? mediaMetadata.file_size : null
  const mimeType = text(mediaMetadata.mime_type, 160)
  const fileType = kind === 'image' ? 'image' : kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : kind === 'document' || kind === 'sticker' ? 'file' : null
  return {
    id: row.id,
    content: row.deleted_at ? null : row.content ?? null,
    created_at: row.provider_timestamp,
    message_type: row.direction === 'incoming' ? 'incoming' : row.direction === 'outgoing' ? 'outgoing' : 'activity',
    status: row.delivery_status ?? null,
    private: false,
    sender: {
      name: row.direction === 'incoming' ? text(mediaMetadata.sender_name, 160) : null,
    },
    attachments: fileType ? [{
      id: row.id,
      file_type: fileType,
      extension: mimeType?.split('/')[1]?.split(';')[0] ?? null,
      file_size: fileSize,
      width: null,
      height: null,
      mime_type: mimeType,
      message_kind: kind,
    }] : [],
    message_kind: kind,
    deleted: Boolean(row.deleted_at),
  }
}

function attachMessageReactions(messages: JsonRecord[], reactionRows: JsonRecord[]): JsonRecord[] {
  const reactionsByTarget = new Map<string, Map<string, string>>()
  for (const reaction of reactionRows) {
    const metadata = isRecord(reaction.media_metadata) ? reaction.media_metadata : {}
    const targetId = text(metadata.reaction_to_message_id, 256)
    if (!targetId) continue
    const actor = reaction.direction === 'outgoing'
      ? 'self'
      : text(metadata.participant_jid, 256) ?? 'contact'
    let reactions = reactionsByTarget.get(targetId)
    if (!reactions) {
      reactions = new Map()
      reactionsByTarget.set(targetId, reactions)
    }
    // The caller orders newest first; the first event per sender wins.
    if (reactions.has(actor)) continue
    reactions.set(actor, typeof reaction.content === 'string' ? reaction.content.trim() : '')
  }
  return messages.filter((row) => row.message_kind !== 'reaction').map((row) => {
    const byActor = reactionsByTarget.get(String(row.provider_message_id))
    const counts = new Map<string, { emoji: string; count: number; from_me: boolean }>()
    for (const [actor, emoji] of byActor ?? []) {
      if (!emoji) continue
      const current = counts.get(emoji)
      if (current) {
        current.count += 1
        current.from_me ||= actor === 'self'
      } else counts.set(emoji, { emoji, count: 1, from_me: actor === 'self' })
    }
    const normalized = normalizedMessage(row)
    return { ...normalized, reactions: [...counts.values()] }
  })
}

function recordsFromEvolution(value: unknown, keys: string[]): JsonRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (!isRecord(value)) return []
  for (const key of keys) {
    if (Array.isArray(value[key])) return (value[key] as unknown[]).filter(isRecord)
    if (isRecord(value[key])) {
      const nested = recordsFromEvolution(value[key], keys)
      if (nested.length) return nested
    }
  }
  if (isRecord(value.data)) return recordsFromEvolution(value.data, keys)
  if (isRecord(value.result)) return recordsFromEvolution(value.result, keys)
  return []
}

function evolutionName(row: JsonRecord, group: boolean): string | null {
  const candidates = group
    ? [row.subject, row.name, row.verifiedName]
    : [row.name, row.notify, row.verifiedName, row.pushName]
  for (const candidate of candidates) {
    const value = text(candidate, 160)
    if (value) return value
  }
  return null
}

function savedContactName(row: JsonRecord): string | null {
  for (const candidate of [row.name, row.notify, row.verifiedName]) {
    const value = text(candidate, 160)
    if (value) return value
  }
  return null
}

async function resolvePhoneMatchForInbox(admin: any, businessId: string, phone: string | null, conversationId: string) {
  if (!phone) return
  const { data: matchRows, error: matchError } = await admin.rpc('resolve_whatsapp_customer_phone_match', {
    p_business_id: businessId,
    p_phone: phone,
  })
  if (matchError) throw new RequestError(500, 'history_sync_failed')
  const match = Array.isArray(matchRows) ? matchRows[0] as JsonRecord | undefined : undefined
  const customerId = text(match?.matched_customer_id, 64)
  const { data: context, error: contextError } = await admin.from('whatsapp_conversation_contexts')
    .select('customer_id, order_id, match_method')
    .eq('business_id', businessId).eq('conversation_id', conversationId).maybeSingle()
  if (contextError) throw new RequestError(500, 'history_sync_failed')
  if (context?.match_method === 'manual' || context?.order_id) return
  if (!customerId || Number(match?.matches_count) !== 1) {
    if (context?.match_method === 'phone') {
      const { error } = await admin.from('whatsapp_conversation_contexts').delete()
        .eq('business_id', businessId).eq('conversation_id', conversationId).eq('match_method', 'phone')
      if (error) throw new RequestError(500, 'history_sync_failed')
    }
    return
  }
  if (context?.customer_id === customerId && context?.match_method === 'phone') return
  const { error } = await admin.from('whatsapp_conversation_contexts').upsert({
    business_id: businessId,
    conversation_id: conversationId,
    customer_id: customerId,
    order_id: null,
    match_method: 'phone',
    updated_by: null,
  }, { onConflict: 'business_id,conversation_id' })
  if (error) throw new RequestError(500, 'history_sync_failed')
}

function providerMessageRecord(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null
  if (isRecord(value.key) && isRecord(value.message)) return value
  if (isRecord(value.lastMessage)) return providerMessageRecord(value.lastMessage)
  if (isRecord(value.message) && isRecord(value.message.key)) return value.message
  return null
}

function providerMessagePayload(value: unknown): JsonRecord | null {
  const record = providerMessageRecord(value)
  if (!record) return null
  const key = isRecord(record.key) ? record.key : {}
  const messageId = text(key.id, 256)
  const remoteJid = text(key.remoteJid, 256)
  if (!messageId || !remoteJid) return null
  const sourceMessage = isRecord(record.message) ? record.message : {}
  const nested = isRecord(sourceMessage.ephemeralMessage) && isRecord(sourceMessage.ephemeralMessage.message)
    ? sourceMessage.ephemeralMessage.message
    : isRecord(sourceMessage.viewOnceMessageV2) && isRecord(sourceMessage.viewOnceMessageV2.message)
      ? sourceMessage.viewOnceMessageV2.message
      : sourceMessage
  const kindByKey: Record<string, string> = {
    imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', documentMessage: 'document',
    stickerMessage: 'sticker', locationMessage: 'location', liveLocationMessage: 'location',
    contactMessage: 'contact', contactsArrayMessage: 'contact', buttonsMessage: 'interactive',
    listMessage: 'interactive', templateMessage: 'interactive', reactionMessage: 'reaction',
  }
  const contentKey = Object.keys(nested).find((keyName) => kindByKey[keyName] !== undefined)
  const kind = contentKey ? kindByKey[contentKey] : 'text'
  const contentObject = contentKey && isRecord(nested[contentKey]) ? nested[contentKey] as JsonRecord : {}
  const content = text(nested.conversation, 65_535)
    ?? text(isRecord(nested.extendedTextMessage) ? nested.extendedTextMessage.text : null, 65_535)
    ?? text(contentObject.caption, 65_535)
    ?? text(contentObject.text, 65_535)
    ?? text(contentObject.selectedDisplayText, 65_535)
  const group = isGroupJid(remoteJid)
  const metadata: JsonRecord = {}
  const mimeType = text(contentObject.mimetype, 160)
  const fileName = text(contentObject.fileName, 255)
  const fileLength = Number(contentObject.fileLength)
  if (mimeType) metadata.mime_type = mimeType
  if (fileName) metadata.file_name = fileName
  if (Number.isSafeInteger(fileLength) && fileLength >= 0) metadata.file_size = fileLength
  const senderName = text(record.pushName, 160)
  const participant = text(key.participant ?? key.participantAlt, 256)
  if (group && senderName) metadata.sender_name = senderName
  if (participant) metadata.participant_jid = participant
  if (kind === 'reaction' && isRecord(contentObject.key)) {
    const reactionTarget = text(contentObject.key.id, 256)
    if (reactionTarget) metadata.reaction_to_message_id = reactionTarget
  }
  return {
    id: messageId,
    remote_jid: remoteJid,
    remote_jid_alt: text(key.remoteJidAlt, 256),
    contact_name: group ? null : senderName,
    contact_phone: group ? null : phoneFromWhatsAppJid(text(key.remoteJidAlt, 256) ?? remoteJid),
    direction: key.fromMe === true ? 'outgoing' : 'incoming',
    message_kind: kind,
    content,
    delivery_status: key.fromMe === true ? 'sent' : null,
    media_metadata: metadata,
    provider_timestamp: providerTimestamp(record.messageTimestamp ?? record.messageTimestampMs),
  }
}

function providerTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 100_000_000_000 ? value * 1000 : value)
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return providerTimestamp(numeric)
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return new Date().toISOString()
}

function callStateLabel(value: unknown): string {
  const normalized = (text(value, 64) ?? '').toLowerCase()
  if (normalized === 'offer') return 'Ligação recebida'
  if (normalized === 'ringing') return 'Chamando'
  if (normalized === 'terminate' || normalized === 'terminated') return 'Ligação encerrada'
  if (normalized === 'reject' || normalized === 'rejected') return 'Ligação recusada'
  if (normalized === 'accept' || normalized === 'accepted') return 'Ligação atendida'
  return normalized ? `Evento de chamada · ${normalized}` : 'Registro de chamada'
}

function base64Bytes(value: string): Uint8Array {
  const encoded = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function outboundFileName(value: unknown): string | null {
  const supplied = text(value, 255)
  if (!supplied) return null
  const safe = supplied.replace(/[\\/:\u0000-\u001f\u007f]/g, '_').replace(/\s+/g, ' ').trim()
  return safe && safe !== '.' && safe !== '..' ? safe : null
}

async function readBoundedRequestBody(request: Request, maximumBytes: number): Promise<string | null> {
  const declaredLength = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maximumBytes) {
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

async function mediaResponse(admin: any, config: EvolutionConfig, businessId: string, conversationId: string, messageId: string) {
  const { data: message, error: messageError } = await admin.from('whatsapp_messages')
    .select('id, instance_name, provider_message_id, direction, message_kind, media_metadata, deleted_at')
    .eq('business_id', businessId)
    .eq('conversation_id', conversationId)
    .eq('id', messageId)
    .maybeSingle()
  if (messageError) throw new RequestError(500, 'media_lookup_failed')
  if (!message || !['image', 'audio', 'video', 'document', 'sticker'].includes(message.message_kind) || message.deleted_at) {
    throw new RequestError(404, 'media_not_found')
  }
  const key = {
    id: message.provider_message_id,
    remoteJid: (await admin.from('whatsapp_conversations').select('remote_jid').eq('business_id', businessId).eq('id', conversationId).single()).data?.remote_jid,
    fromMe: message.direction === 'outgoing',
  }
  const result = await evolutionRequest(config, `/chat/getBase64FromMediaMessage/${encodeURIComponent(config.instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({ message: { key }, convertToMp4: false }),
  }, 15 * 1024 * 1024)
  const resultRecord = isRecord(result) ? result : {}
  const payload = isRecord(resultRecord.data) ? resultRecord.data : resultRecord
  const base64 = text(payload.base64, MAX_MEDIA_BYTES * 2)
  if (!base64) throw new RequestError(502, 'media_unavailable')
  const bytes = base64Bytes(base64)
  if (!bytes.length || bytes.byteLength > MAX_MEDIA_BYTES) throw new RequestError(413, 'media_too_large')
  const metadata = isRecord(message.media_metadata) ? message.media_metadata : {}
  const sourceMimeType = text(payload.mimetype ?? payload.mimeType ?? metadata.mime_type, 160) ?? 'application/octet-stream'
  const mimeType = sourceMimeType.split(';', 1)[0].trim().toLowerCase()
  const disposition = ['image', 'audio', 'video', 'sticker'].includes(message.message_kind) ? 'inline' : 'attachment'
  const safeMimeType = /^(?:image\/(?:jpeg|png|webp|gif)|audio\/(?:ogg|mpeg|mp4|wav|webm|aac|3gpp)|video\/mp4|application\/pdf)$/i.test(mimeType)
    ? mimeType
    : 'application/octet-stream'
  const responseBytes = new Uint8Array(bytes.byteLength)
  responseBytes.set(bytes)
  return new Response(responseBytes.buffer, {
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Original-Content-Type',
      'Content-Type': safeMimeType,
      'Content-Disposition': `${disposition}; filename="whatsapp-media-${message.id}"`,
      'X-Original-Content-Type': safeMimeType,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function historyRecords(value: unknown): JsonRecord[] {
  if (!isRecord(value)) return recordsFromEvolution(value, ['messages', 'records', 'data'])
  const messages = isRecord(value.messages) ? value.messages : null
  if (messages) return recordsFromEvolution(messages, ['records', 'messages', 'data'])
  return recordsFromEvolution(value, ['records', 'messages', 'data'])
}

function isSingleReaction(value: string): boolean {
  if (!value || Array.from(value).length > 16 || /\s|[\u0000-\u001f\u007f]/u.test(value)) return false
  try {
    return /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\p{Emoji_Component}|\u200d|\ufe0f|\u20e3)+$/u.test(value)
  } catch {
    return false
  }
}

async function olderMessagesResponse(admin: any, config: EvolutionConfig, businessId: string, conversation: JsonRecord, beforeMessageId: string) {
  const { data: cursor, error: cursorError } = await admin.from('whatsapp_messages')
    .select('provider_message_id, provider_timestamp, instance_name')
    .eq('business_id', businessId).eq('conversation_id', conversation.id).eq('id', beforeMessageId).maybeSingle()
  if (cursorError) throw new RequestError(500, 'history_cursor_lookup_failed')
  if (!cursor) throw new RequestError(404, 'history_cursor_not_found')
  const remoteJid = text(conversation.remote_jid, 256)
  const cursorTime = providerTimestamp(cursor.provider_timestamp)
  let providerRecords: JsonRecord[] = []
  let providerPages = 0
  let providerAvailable = true
  try {
    const result = await evolutionRequest(config, `/chat/findMessages/${encodeURIComponent(config.instanceName)}`, {
      method: 'POST',
      body: JSON.stringify({
        where: {
          key: { remoteJid },
          messageTimestamp: { gte: '2000-01-01T00:00:00.000Z', lte: cursorTime },
        },
        offset: OLDER_MESSAGE_PAGE_SIZE + 1,
        page: 1,
      }),
    })
    providerRecords = historyRecords(result)
    const root = isRecord(result) ? result : {}
    const messagePage = isRecord(root.messages) ? root.messages : root
    providerPages = Number(messagePage.pages ?? messagePage.totalPages) || 0
  } catch {
    providerAvailable = false
  }

  const cursorProviderId = text(cursor.provider_message_id, 256)
  const candidates = providerRecords
    .map(providerMessagePayload)
    .filter((row): row is JsonRecord => Boolean(row && row.remote_jid === remoteJid
      && (String(row.provider_timestamp) < cursorTime
        || (String(row.provider_timestamp) === cursorTime && String(row.id) < (cursorProviderId ?? '')))))
    .sort((left, right) => String(right.provider_timestamp).localeCompare(String(left.provider_timestamp))
      || String(right.id).localeCompare(String(left.id)))
  const page = candidates.slice(0, OLDER_MESSAGE_PAGE_SIZE)
  const providerHasMore = candidates.length > OLDER_MESSAGE_PAGE_SIZE || providerPages > 1

  if (page.length) {
    const rows = page.map((message) => ({
      business_id: businessId,
      conversation_id: conversation.id,
      instance_name: config.instanceName,
      provider_message_id: message.id,
      direction: message.direction,
      message_kind: message.message_kind,
      content: message.content,
      delivery_status: message.delivery_status,
      count_as_unread: false,
      media_metadata: message.media_metadata,
      provider_timestamp: message.provider_timestamp,
    }))
    const { error } = await admin.from('whatsapp_messages').upsert(rows, {
      onConflict: 'business_id,instance_name,provider_message_id', ignoreDuplicates: true,
    })
    if (error) throw new RequestError(500, 'history_import_failed')
    const providerIds = page.map((message) => String(message.id))
    const { data: imported, error: importedError } = await admin.from('whatsapp_messages')
      .select('id, provider_message_id, direction, message_kind, content, delivery_status, media_metadata, provider_timestamp, deleted_at')
      .eq('business_id', businessId).eq('conversation_id', conversation.id).in('provider_message_id', providerIds)
      .order('provider_timestamp', { ascending: true })
    if (importedError) throw new RequestError(500, 'history_import_failed')
    const { data: reactions, error: reactionError } = await admin.from('whatsapp_messages')
      .select('direction, content, media_metadata, provider_timestamp, id')
      .eq('business_id', businessId).eq('conversation_id', conversation.id).eq('message_kind', 'reaction')
      .order('provider_timestamp', { ascending: false }).order('id', { ascending: false }).limit(500)
    if (reactionError) throw new RequestError(500, 'history_import_failed')
    return json({ messages: attachMessageReactions(imported ?? [], reactions ?? []), meta: { has_more: providerHasMore, history_available: true } })
  }

  // Keep previously imported pages navigable if the provider has since pruned
  // or disabled its own message database.
  const { data: localRows, error: localError } = await admin.from('whatsapp_messages')
    .select('id, provider_message_id, direction, message_kind, content, delivery_status, media_metadata, provider_timestamp, deleted_at')
    .eq('business_id', businessId).eq('conversation_id', conversation.id)
    .lt('provider_timestamp', cursorTime)
    .order('provider_timestamp', { ascending: false }).limit(OLDER_MESSAGE_PAGE_SIZE + 1)
  if (localError) throw new RequestError(500, 'message_history_failed')
  const { data: reactionRows, error: reactionError } = await admin.from('whatsapp_messages')
    .select('direction, content, media_metadata, provider_timestamp, id')
    .eq('business_id', businessId).eq('conversation_id', conversation.id).eq('message_kind', 'reaction')
    .order('provider_timestamp', { ascending: false }).order('id', { ascending: false }).limit(500)
  if (reactionError) throw new RequestError(500, 'message_history_failed')
  const hasMore = providerHasMore || (localRows?.length ?? 0) > OLDER_MESSAGE_PAGE_SIZE
  const older = (localRows ?? []).slice(0, OLDER_MESSAGE_PAGE_SIZE).reverse()
  if (older.length === 0 && !providerAvailable) throw new RequestError(503, 'history_unavailable')
  return json({ messages: attachMessageReactions(older, reactionRows ?? []), meta: {
    has_more: hasMore,
    history_available: older.length > 0,
    ...(older.length === 0 ? { notice: providerAvailable
      ? 'A Evolution não encontrou mensagens anteriores para esta conversa.'
      : 'A Evolution não está acessível para carregar o histórico anterior.' } : {}),
  } })
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (request, context) => {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

    let raw: string | null
    try { raw = await readBoundedRequestBody(request, MAX_REQUEST_BYTES) } catch { return json({ error: 'invalid_request' }, 400) }
    if (raw === null) return json({ error: 'request_too_large' }, 413)
    let body: JsonRecord
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed)) return json({ error: 'invalid_request' }, 400)
      body = parsed
    } catch {
      return json({ error: 'invalid_request' }, 400)
    }

    const action = text(body.action, 40)
    const businessId = body.business_id
    const userId = text(context.userClaims?.id, 64)
    if (!userId || !isUuid(businessId)) return json({ error: 'invalid_request' }, 400)
    if (!['status', 'list', 'calls', 'conversation', 'older_messages', 'react', 'mark_read', 'send', 'send_media', 'set_status', 'attachment', 'configure_webhook', 'connect', 'disconnect'].includes(action ?? '')) {
      return json({ error: 'invalid_action' }, 400)
    }

    try {
      const { data: membership, error: membershipError } = await context.supabase
        .from('business_memberships')
        .select('role')
        .eq('business_id', businessId)
        .eq('user_id', userId)
        .maybeSingle()
      if (membershipError) return json({ error: 'access_check_failed' }, 500)
      if (!membership || !['owner', 'staff'].includes(membership.role)) return json({ error: 'forbidden' }, 403)

      const admin = context.supabaseAdmin
      const config = await loadConfiguration(admin)
      if (config?.businessId && config.businessId !== businessId) return json({ error: 'forbidden' }, 403)
      if (action === 'status') {
        if (!config) return json({ configured: false, connected: false, connection_state: 'not_configured' })
        try {
          const instances = await evolutionRequest(config, '/instance/fetchInstances')
          const instanceExists = Array.isArray(instances) && instances.some((entry) => evolutionInstanceName(entry) === config.instanceName)
          if (!instanceExists) return json({ configured: true, connected: false, instance_exists: false, connection_state: 'not_created' })
          const result = await evolutionRequest(config, `/instance/connectionState/${encodeURIComponent(config.instanceName)}`)
          const stateRecord = isRecord(result) && isRecord(result.instance) ? result.instance : isRecord(result) ? result : {}
          const state = text(stateRecord.state ?? stateRecord.connectionStatus, 64) ?? 'unknown'
          return json({ configured: true, connected: state.toLowerCase() === 'open', instance_exists: true, connection_state: state })
        } catch {
          return json({ configured: true, connected: false, connection_state: 'unavailable' })
        }
      }
      if (!config) return json({ error: 'evolution_not_configured' }, 503)

      if (action === 'configure_webhook') {
        if (membership.role !== 'owner') return json({ error: 'forbidden' }, 403)
        await setEvolutionWebhook(config)
        return json({ configured: true })
      }

      if (action === 'connect') {
        if (membership.role !== 'owner') return json({ error: 'forbidden' }, 403)
        const instanceList = await evolutionRequest(config, '/instance/fetchInstances')
        const instanceExists = Array.isArray(instanceList) && instanceList.some((entry) => evolutionInstanceName(entry) === config.instanceName)
        if (!instanceExists) {
          await evolutionRequest(config, '/instance/create', {
            method: 'POST',
            body: JSON.stringify({
              instanceName: config.instanceName,
              integration: 'WHATSAPP-BAILEYS',
              qrcode: false,
              syncFullHistory: true,
            }),
          })
        }
        try { await setEvolutionWebhook(config) } catch {
          return json({ error: 'webhook_setup_failed', instance_exists: true, connection_state: 'close' })
        }
        let result: unknown
        try { result = await evolutionRequest(config, `/instance/connect/${encodeURIComponent(config.instanceName)}`, undefined, 1_600_000) } catch {
          return json({ error: 'qrcode_unavailable', instance_exists: true, connection_state: 'close' })
        }
        const outer = isRecord(result) ? result : {}
        const instance = isRecord(outer.instance) ? outer.instance : {}
        const state = text(instance.state ?? outer.state ?? instance.connectionStatus, 64)?.toLowerCase()
        if (state === 'open') return json({ connected: true, instance_exists: true, connection_state: 'open' })
        const qr = isRecord(outer.qrcode) ? outer.qrcode : outer
        const imageValue = text(qr.base64 ?? qr.qrcode, 1_500_000)
        if (!imageValue) return json({ error: 'qrcode_unavailable', instance_exists: true, connection_state: 'connecting' })
        if (!imageValue.startsWith('data:image/') && !/^[A-Za-z0-9+/]+={0,2}$/.test(imageValue)) {
          return json({ error: 'qrcode_unavailable', instance_exists: true, connection_state: 'connecting' })
        }
        const qrImage = imageValue.startsWith('data:image/') ? imageValue : `data:image/png;base64,${imageValue}`
        return json({ connected: false, instance_exists: true, connection_state: 'connecting', qr_image: qrImage })
      }

      if (action === 'disconnect') {
        if (membership.role !== 'owner') return json({ error: 'forbidden' }, 403)
        await evolutionRequest(config, `/instance/logout/${encodeURIComponent(config.instanceName)}`, { method: 'DELETE' })
        return json({ connected: false, instance_exists: true, connection_state: 'close' })
      }

      if (action === 'list') {
        const status = body.status
        if (status !== 'open' && status !== 'resolved' && status !== 'all') return json({ error: 'invalid_status' }, 400)
        const page = typeof body.page === 'number' && Number.isInteger(body.page) ? body.page : 1
        if (page < 1 || page > 1000) return json({ error: 'invalid_page' }, 400)
        const query = body.query === undefined ? '' : (text(body.query, 120) ?? '')
        if (body.query !== undefined && body.query !== '' && !query) return json({ error: 'invalid_query' }, 400)
        const providerChatPage = Math.ceil((page * PAGE_SIZE) / LEGACY_CHAT_PAGE_SIZE)
        const historySync = await syncLegacyChats(admin, config, businessId, providerChatPage)
        let selection = admin.from('whatsapp_conversations')
          .select('id, instance_name, remote_jid, remote_jid_alt, contact_name, contact_phone, status, unread_count, last_activity_at', { count: 'exact' })
          .eq('business_id', businessId)
        if (status !== 'all') selection = selection.eq('status', status)
        if (query) {
          const safeQuery = query.replace(/[(),%_*\\]/g, ' ').trim()
          if (safeQuery) selection = selection.or(`contact_name.ilike.%${safeQuery}%,contact_phone.ilike.%${safeQuery}%,remote_jid.ilike.%${safeQuery}%`)
        }
        const offset = (page - 1) * PAGE_SIZE
        const { data: rows, count, error } = await selection.order('last_activity_at', { ascending: false }).range(offset, offset + PAGE_SIZE - 1)
        if (error) throw new RequestError(500, 'conversation_list_failed')
        const ids = (rows ?? []).map((row: JsonRecord) => row.id)
    let lastMessages: JsonRecord[] = []
        if (ids.length) {
          const { data: messages, error: messagesError } = await admin.from('whatsapp_messages')
            .select('id, provider_message_id, conversation_id, direction, message_kind, content, delivery_status, media_metadata, provider_timestamp, deleted_at')
            .eq('business_id', businessId)
            .in('conversation_id', ids)
            .order('provider_timestamp', { ascending: false })
            .limit(ids.length * 4)
          if (messagesError) throw new RequestError(500, 'message_list_failed')
          lastMessages = messages ?? []
        }
        const latestByConversation = new Map<string, JsonRecord>()
        for (const message of lastMessages) {
          if (message.message_kind !== 'reaction' && !latestByConversation.has(String(message.conversation_id))) {
            latestByConversation.set(String(message.conversation_id), message)
          }
        }
        const conversations = (rows ?? []).map((row: JsonRecord) => conversationResponse(row, latestByConversation.get(String(row.id)) ?? null))
        return json({ conversations, meta: {
          page,
          has_more: offset + conversations.length < (count ?? 0) || historySync.has_more === true,
          history_sync: historySync,
        } })
      }

      if (action === 'calls') {
        const { data: callRows, error } = await admin.from('whatsapp_call_events')
          .select('id, conversation_id, caller_phone, call_state, is_video, occurred_at, provider_call_id')
          .eq('business_id', businessId)
          .order('occurred_at', { ascending: false })
          .limit(100)
        if (error) throw new RequestError(500, 'call_list_failed')
        const conversationIds = [...new Set((callRows ?? []).map((row: JsonRecord) => String(row.conversation_id)))]
        let conversationMap = new Map<string, JsonRecord>()
        if (conversationIds.length) {
          const { data: rows, error: conversationError } = await admin.from('whatsapp_conversations')
            .select('id, contact_name, contact_phone, status')
            .eq('business_id', businessId)
            .in('id', conversationIds)
          if (conversationError) throw new RequestError(500, 'call_conversation_lookup_failed')
          conversationMap = new Map((rows ?? []).map((row: JsonRecord) => [String(row.id), row]))
        }
        const linksByConversation = new Map<string, JsonRecord>()
        const customerIds = new Set<string>()
        if (conversationIds.length) {
          const { data: links, error: linksError } = await admin.from('whatsapp_conversation_contexts')
            .select('conversation_id, customer_id')
            .eq('business_id', businessId)
            .in('conversation_id', conversationIds)
          if (linksError) throw new RequestError(500, 'call_customer_lookup_failed')
          for (const link of links ?? []) {
            linksByConversation.set(String(link.conversation_id), link)
            if (typeof link.customer_id === 'string') customerIds.add(link.customer_id)
          }
        }
        const customerNames = new Map<string, string>()
        if (customerIds.size) {
          const { data: customerRows, error: customerError } = await admin.from('customers')
            .select('id, name')
            .eq('business_id', businessId)
            .in('id', [...customerIds])
          if (customerError) throw new RequestError(500, 'call_customer_lookup_failed')
          for (const customer of customerRows ?? []) customerNames.set(String(customer.id), String(customer.name))
        }
        const groupedCalls = new Map<string, JsonRecord[]>()
        for (const row of callRows ?? []) {
          const key = typeof row.provider_call_id === 'string' && row.provider_call_id
            ? `provider:${row.provider_call_id}`
            : `event:${row.id}`
          groupedCalls.set(key, [...(groupedCalls.get(key) ?? []), row])
        }
        const calls = [...groupedCalls.values()].map((rows) => {
          const row = rows[0]
          const conversation = conversationMap.get(String(row.conversation_id))
          const context = linksByConversation.get(String(row.conversation_id))
          const customerName = typeof context?.customer_id === 'string' ? customerNames.get(context.customer_id) ?? null : null
          const latest = rows.reduce((current, item) => String(item.occurred_at) > String(current.occurred_at) ? item : current, row)
          const uniqueStates = [...new Set(rows.map((item) => text(item.call_state, 64)).filter((value): value is string => Boolean(value)))]
          return {
            id: typeof row.provider_call_id === 'string' && row.provider_call_id ? row.provider_call_id : row.id,
            conversation_id: row.conversation_id,
            contact: { name: conversation?.contact_name ?? null, phone: row.caller_phone ?? conversation?.contact_phone ?? null },
            customer_name: customerName,
            status: latest.call_state,
            status_label: callStateLabel(latest.call_state),
            is_video: row.is_video ?? null,
            occurred_at: latest.occurred_at,
            event_count: rows.length,
            states: uniqueStates,
          }
        })
        return json({ calls })
      }

      const conversationId = body.conversationId
      if (!isUuid(conversationId)) return json({ error: 'invalid_conversation_id' }, 400)
      const { data: conversation, error: conversationError } = await admin.from('whatsapp_conversations')
        .select('id, business_id, instance_name, remote_jid, remote_jid_alt, contact_name, contact_phone, status, unread_count, last_activity_at')
        .eq('business_id', businessId)
        .eq('id', conversationId)
        .maybeSingle()
      if (conversationError) throw new RequestError(500, 'conversation_lookup_failed')
      if (!conversation) return json({ error: 'conversation_not_found' }, 404)

      if (action === 'attachment') {
        const messageId = body.messageId
        if (!isUuid(messageId)) return json({ error: 'invalid_media_reference' }, 400)
        return await mediaResponse(admin, config, businessId, conversationId, messageId)
      }

      if (action === 'older_messages') {
        const beforeMessageId = body.beforeMessageId
        if (!isUuid(beforeMessageId)) return json({ error: 'invalid_history_cursor' }, 400)
        return await olderMessagesResponse(admin, config, businessId, conversation as JsonRecord, beforeMessageId)
      }

      if (action === 'react') {
        const messageId = body.messageId
        if (!isUuid(messageId)) return json({ error: 'invalid_reaction_target' }, 400)
        if (typeof body.emoji !== 'string') return json({ error: 'invalid_reaction' }, 400)
        const emoji = body.emoji.normalize('NFC')
        if (emoji !== '' && !isSingleReaction(emoji)) return json({ error: 'invalid_reaction' }, 400)
        const { data: target, error: targetError } = await admin.from('whatsapp_messages')
          .select('provider_message_id, direction, message_kind, media_metadata, deleted_at')
          .eq('business_id', businessId).eq('conversation_id', conversationId).eq('id', messageId).maybeSingle()
        if (targetError) throw new RequestError(500, 'reaction_target_lookup_failed')
        if (!target || target.deleted_at) return json({ error: 'reaction_target_not_found' }, 404)
        if (conversation.remote_jid.startsWith('unknown-call:')) return json({ error: 'reaction_target_not_supported' }, 409)
        const metadata = isRecord(target.media_metadata) ? target.media_metadata : {}
        const key: JsonRecord = {
          remoteJid: conversation.remote_jid,
          fromMe: target.direction === 'outgoing',
          id: target.provider_message_id,
        }
        const participant = text(metadata.participant_jid, 256)
        if (participant) key.participant = participant
        await evolutionRequest(config, `/message/sendReaction/${encodeURIComponent(config.instanceName)}`, {
          method: 'POST',
          body: JSON.stringify({ key, reaction: emoji }),
        })
        return json({ sent: true })
      }

      if (action === 'mark_read') {
        const { error } = await admin.from('whatsapp_conversations').update({ unread_count: 0 })
          .eq('business_id', businessId).eq('id', conversationId)
        if (error) throw new RequestError(500, 'mark_read_failed')
      } else if (action === 'set_status') {
        const status = body.status
        if (status !== 'open' && status !== 'resolved') return json({ error: 'invalid_status' }, 400)
        const { error } = await admin.from('whatsapp_conversations').update({ status })
          .eq('business_id', businessId).eq('id', conversationId)
        if (error) throw new RequestError(500, 'status_update_failed')
      } else if (action === 'send') {
        const content = text(body.content, 4000)
        if (!content) return json({ error: 'invalid_message' }, 400)
        if (conversation.remote_jid.startsWith('unknown-call:')
          || (conversation.remote_jid.includes('@lid')
            && (!conversation.remote_jid_alt || !phoneFromWhatsAppJid(conversation.remote_jid_alt)))) {
          return json({ error: 'contact_not_replyable' }, 409)
        }
        const replyAddress = conversation.remote_jid.includes('@lid') ? conversation.remote_jid_alt : conversation.remote_jid
        const number = replyAddress.includes('@') ? replyAddress : replyAddress.replace(/[^0-9]/g, '')
        const result = await evolutionRequest(config, `/message/sendText/${encodeURIComponent(config.instanceName)}`, {
          method: 'POST',
          body: JSON.stringify({ number, text: content }),
        })
        const response = isRecord(result) ? result : {}
        const key = isRecord(response.key) ? response.key : isRecord(response.message) && isRecord(response.message.key) ? response.message.key : {}
        const providerMessageId = text(key.id, 256) ?? `sent-${crypto.randomUUID()}`
        const providerTimestamp = new Date().toISOString()
        const { error: insertError } = await admin.from('whatsapp_messages').upsert({
          business_id: businessId,
          conversation_id: conversationId,
          instance_name: config.instanceName,
          provider_message_id: providerMessageId,
          direction: 'outgoing',
          message_kind: 'text',
          content,
          delivery_status: 'pending',
          media_metadata: {},
          provider_timestamp: providerTimestamp,
        }, { onConflict: 'business_id,instance_name,provider_message_id', ignoreDuplicates: true })
        if (insertError) throw new RequestError(500, 'message_persist_failed')
        return json({ sent: true })
      } else if (action === 'send_media') {
        const mediaBase64 = text(body.mediaBase64, MAX_REQUEST_BYTES)
        const mimeType = (text(body.mimeType, 160) ?? '').toLowerCase().split(';', 1)[0].trim()
        const mediaKind = OUTBOUND_MEDIA_TYPES[mimeType]
        const fileName = outboundFileName(body.fileName)
        const caption = body.caption === undefined ? '' : (text(body.caption, 1024) ?? '')
        if (!mediaBase64 || !fileName || !mediaKind || mediaBase64.length > 2_900_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(mediaBase64)) {
          return json({ error: 'invalid_media' }, 400)
        }
        let bytes: Uint8Array
        try { bytes = base64Bytes(mediaBase64) } catch { return json({ error: 'invalid_media' }, 400) }
        if (bytes.length < 1 || bytes.length > MAX_OUTBOUND_MEDIA_BYTES) return json({ error: 'media_too_large' }, 413)
        if (conversation.remote_jid.startsWith('unknown-call:')
          || (conversation.remote_jid.includes('@lid')
            && (!conversation.remote_jid_alt || !phoneFromWhatsAppJid(conversation.remote_jid_alt)))) {
          return json({ error: 'contact_not_replyable' }, 409)
        }
        const replyAddress = conversation.remote_jid.includes('@lid') ? conversation.remote_jid_alt : conversation.remote_jid
        const number = replyAddress.includes('@') ? replyAddress : replyAddress.replace(/[^0-9]/g, '')
        const mediaBody: JsonRecord = {
          number,
          mediatype: mediaKind,
          mimetype: mimeType,
          media: mediaBase64,
          caption,
          fileName,
        }
        // Evolution v2.3.7 expects the lower-case alias for image uploads.
        if (mediaKind === 'image') mediaBody.filename = fileName
        const result = await evolutionRequest(config, `/message/sendMedia/${encodeURIComponent(config.instanceName)}`, {
          method: 'POST',
          body: JSON.stringify(mediaBody),
        })
        const response = isRecord(result) ? result : {}
        const key = isRecord(response.key) ? response.key : isRecord(response.message) && isRecord(response.message.key) ? response.message.key : {}
        const providerMessageId = text(key.id, 256) ?? `sent-${crypto.randomUUID()}`
        const { error: insertError } = await admin.from('whatsapp_messages').upsert({
          business_id: businessId,
          conversation_id: conversationId,
          instance_name: config.instanceName,
          provider_message_id: providerMessageId,
          direction: 'outgoing',
          message_kind: mediaKind,
          content: caption || null,
          delivery_status: 'pending',
          media_metadata: { mime_type: mimeType, file_name: fileName, file_size: bytes.length },
          provider_timestamp: new Date().toISOString(),
        }, { onConflict: 'business_id,instance_name,provider_message_id', ignoreDuplicates: true })
        if (insertError) throw new RequestError(500, 'message_persist_failed')
        return json({ sent: true })
      }

      const { data: freshConversation, error: freshError } = await admin.from('whatsapp_conversations')
        .select('id, instance_name, remote_jid, remote_jid_alt, contact_name, contact_phone, status, unread_count, last_activity_at')
        .eq('business_id', businessId).eq('id', conversationId).single()
      if (freshError) throw new RequestError(500, 'conversation_refresh_failed')
      const { data: messageRows, error: messageError } = await admin.from('whatsapp_messages')
        .select('id, provider_message_id, direction, message_kind, content, delivery_status, media_metadata, provider_timestamp, deleted_at')
        .eq('business_id', businessId).eq('conversation_id', conversationId)
        .order('provider_timestamp', { ascending: false }).limit(MESSAGE_HISTORY_LIMIT + 1)
      if (messageError) throw new RequestError(500, 'message_history_failed')
      const hasLocalMore = (messageRows?.length ?? 0) > MESSAGE_HISTORY_LIMIT
      const initialRows = (messageRows ?? []).slice(0, MESSAGE_HISTORY_LIMIT).reverse()
      const { data: reactionRows, error: reactionError } = await admin.from('whatsapp_messages')
        .select('direction, content, media_metadata, provider_timestamp, id')
        .eq('business_id', businessId).eq('conversation_id', conversationId).eq('message_kind', 'reaction')
        .order('provider_timestamp', { ascending: false }).order('id', { ascending: false }).limit(500)
      if (reactionError) throw new RequestError(500, 'message_history_failed')
      const messages = attachMessageReactions(initialRows, reactionRows ?? [])
      const { data: callRows, error: callsError } = await admin.from('whatsapp_call_events')
        .select('id, call_state, is_video, occurred_at')
        .eq('business_id', businessId).eq('conversation_id', conversationId)
        .order('occurred_at', { ascending: true }).limit(100)
      if (callsError) throw new RequestError(500, 'call_history_failed')
      const calls = (callRows ?? []).map((row: JsonRecord) => ({
        id: row.id,
        event_type: 'call',
        status: row.call_state,
        status_label: callStateLabel(row.call_state),
        is_video: row.is_video ?? null,
        occurred_at: row.occurred_at,
      }))
      return json({ conversation: {
        ...conversationResponse(freshConversation as JsonRecord, null),
        last_message: messages.at(-1) ?? null,
        messages,
        calls,
      }, meta: { has_more: hasLocalMore || messages.length > 0 } })
    } catch (error) {
      if (error instanceof RequestError) return json({ error: error.code }, error.status)
      // Provider error bodies may include credentials; keep them out of application logs.
      console.error('Evolution inbox request failed.')
      return json({ error: 'evolution_unavailable' }, 503)
    }
  }),
}
