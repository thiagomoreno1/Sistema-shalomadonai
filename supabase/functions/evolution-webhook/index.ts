import { withSupabase, type SupabaseContext } from '@supabase/server'

const MAX_BODY_BYTES = 1_000_000

type JsonRecord = Record<string, unknown>
type AdminClient = SupabaseContext['supabaseAdmin']
type WebhookConfiguration = { secret: string; instanceName: string; businessId: string }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, maximumLength = 256): string | null {
  if (typeof value !== 'string') return null
  const valueTrimmed = value.trim()
  return valueTrimmed.length > 0 && valueTrimmed.length <= maximumLength ? valueTrimmed : null
}

function eventRows(value: unknown, collectionKey: string): unknown[] {
  if (Array.isArray(value)) return value
  if (isRecord(value) && Array.isArray(value[collectionKey])) return value[collectionKey] as unknown[]
  return [value]
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function loadWebhookConfiguration(admin: AdminClient): Promise<WebhookConfiguration | null> {
  const fromEnvironment = {
    secret: Deno.env.get('EVOLUTION_WEBHOOK_SECRET')?.trim() ?? '',
    instanceName: Deno.env.get('EVOLUTION_INSTANCE_NAME')?.trim() ?? '',
    businessId: Deno.env.get('EVOLUTION_BUSINESS_ID')?.trim() ?? '',
  }
  if (fromEnvironment.secret && fromEnvironment.instanceName
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fromEnvironment.businessId)) return fromEnvironment
  try {
    const { data, error } = await admin.rpc('get_evolution_runtime_config')
    if (error || !isRecord(data)) return null
    const secret = stringValue(data.evolution_webhook_secret, 4096)
    const instanceName = stringValue(data.evolution_instance_name, 120)
    const businessId = stringValue(data.evolution_business_id, 64)
    if (!secret || !instanceName || !businessId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(businessId)) return null
    return { secret, instanceName, businessId }
  } catch {
    return null
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  let difference = leftBytes.length ^ rightBytes.length
  const maximum = Math.max(leftBytes.length, rightBytes.length)
  for (let index = 0; index < maximum; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  }
  return difference === 0
}

function normalizedEvent(value: unknown): string {
  return (stringValue(value, 80) ?? '').replace(/[.\-\s]/g, '_').toUpperCase()
}

function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, '')
}

function phoneFromJid(value: string | null): string | null {
  if (!value || value.toLowerCase().includes('@lid') || isGroupJid(value)) return null
  const localPart = value.split('@', 1)[0].split(':', 1)[0]
  const digits = digitsOnly(localPart)
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`
  return null
}

function isGroupJid(value: string | null): boolean {
  return Boolean(value && /@g\.us$/i.test(value))
}

function isDirectWhatsAppJid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[a-z0-9._:-]{1,128}@(s\.whatsapp\.net|lid)$/i.test(value)
}

async function registerConversationJidAliases(
  admin: AdminClient,
  businessId: string,
  instanceName: string,
  conversationId: string,
  ...values: (string | null)[]
) {
  const aliases = [...new Set(values.filter(isDirectWhatsAppJid))]
  if (!aliases.length) return
  const { error } = await admin.rpc('register_whatsapp_conversation_jid_aliases', {
    p_business_id: businessId,
    p_instance_name: instanceName,
    p_conversation_id: conversationId,
    p_remote_jids: aliases,
  })
  if (error?.code === 'P0001') throw new Error('conversation_identity_ambiguous')
  if (error) throw new Error('conversation_alias_save_failed')
}

async function safeAlternateJid(
  admin: AdminClient,
  businessId: string,
  instanceName: string,
  conversationId: string | null,
  canonicalJid: string,
  ...candidates: (string | null)[]
): Promise<string | null> {
  for (const candidate of candidates) {
    if (!isDirectWhatsAppJid(candidate) || candidate.toLowerCase() === canonicalJid.toLowerCase()) continue
    const normalized = candidate.toLowerCase()
    const { data: alias, error: aliasError } = await admin.from('whatsapp_conversation_jid_aliases')
      .select('conversation_id')
      .eq('business_id', businessId).eq('instance_name', instanceName).eq('remote_jid', normalized).maybeSingle()
    if (aliasError) throw new Error('conversation_alias_lookup_failed')
    if (alias && alias.conversation_id !== conversationId) continue
    const { data: rows, error } = await admin.from('whatsapp_conversations')
      .select('id')
      .eq('business_id', businessId).eq('instance_name', instanceName)
      .or(`remote_jid.eq.${normalized},remote_jid_alt.eq.${normalized}`)
      .limit(2)
    if (error) throw new Error('conversation_alias_lookup_failed')
    if ((rows ?? []).some((row: JsonRecord) => row.id !== conversationId)) continue
    return candidate
  }
  return null
}

async function findConversationByJidOrAlias(
  admin: AdminClient,
  businessId: string,
  instanceName: string,
  remoteJid: string,
  remoteJidAlt: string | null,
) {
  const selection = () => admin.from('whatsapp_conversations')
    .select('id, remote_jid, remote_jid_alt, contact_phone, contact_name, group_subject')
    .eq('business_id', businessId).eq('instance_name', instanceName)
  const { data: exact, error: exactError } = await selection().eq('remote_jid', remoteJid).maybeSingle()
  if (exactError) throw new Error('conversation_lookup_failed')
  if (exact?.id || isGroupJid(remoteJid)) return exact

  const aliases = [...new Set([remoteJid, remoteJidAlt].filter(isDirectWhatsAppJid).map((value) => value.toLowerCase()))]
  if (!aliases.length) return null
  const primaryJid = isDirectWhatsAppJid(remoteJid) ? remoteJid.toLowerCase() : null
  const { data: aliasRows, error: aliasError } = await admin.from('whatsapp_conversation_jid_aliases')
    .select('remote_jid, conversation_id')
    .eq('business_id', businessId).eq('instance_name', instanceName).in('remote_jid', aliases).limit(3)
  if (aliasError) throw new Error('conversation_alias_lookup_failed')
  const primaryAlias = (aliasRows ?? []).find((row: JsonRecord) => row.remote_jid === primaryJid)
  if (primaryAlias) {
    const { data, error } = await selection().eq('id', String(primaryAlias.conversation_id)).maybeSingle()
    if (error) throw new Error('conversation_alias_lookup_failed')
    if (data) return data
  }
  if (primaryJid) {
    const { data: primaryAlternateRows, error } = await selection().eq('remote_jid_alt', primaryJid).limit(2)
    if (error) throw new Error('conversation_alias_lookup_failed')
    if ((primaryAlternateRows ?? []).length === 1) return primaryAlternateRows[0]
    if ((primaryAlternateRows ?? []).length > 1) throw new Error('conversation_identity_ambiguous')
  }
  const prioritizedAlias = (aliasRows ?? []).length === 1 ? aliasRows[0] : null
  if (prioritizedAlias) {
    const { data, error } = await selection().eq('id', String(prioritizedAlias.conversation_id)).maybeSingle()
    if (error) throw new Error('conversation_alias_lookup_failed')
    if (data) return data
  }
  const aliasedConversationIds = [...new Set((aliasRows ?? []).map((row: JsonRecord) => String(row.conversation_id)))]
  const { data, error } = await selection()
    .or(`remote_jid.in.(${aliases.join(',')}),remote_jid_alt.in.(${aliases.join(',')})`)
    .limit(4)
  if (error) throw new Error('conversation_alias_lookup_failed')
  const primaryMatches = (data ?? []).filter((row: JsonRecord) =>
    String(row.remote_jid).toLowerCase() === primaryJid
      || String(row.remote_jid_alt ?? '').toLowerCase() === primaryJid)
  if (primaryMatches.length === 1) return primaryMatches[0]
  if (primaryMatches.length > 1 || aliasedConversationIds.length > 1 || (data ?? []).length > 1) {
    throw new Error('conversation_identity_ambiguous')
  }
  return data?.[0] ?? null
}

function evolutionContactName(row: JsonRecord, isGroup: boolean): string | null {
  const candidates = isGroup
    ? [row.subject, row.groupSubject, row.group_subject]
    : [row.name, row.pushName, row.verifiedName]
  for (const candidate of candidates) {
    const name = stringValue(candidate, 160)
    if (name) return name
  }
  return null
}

function isoTimestamp(value: unknown, fallback = new Date().toISOString()): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 100_000_000_000 ? value * 1000 : value)
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return isoTimestamp(numeric, fallback)
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return fallback
}

async function readBoundedBody(request: Request): Promise<string | null> {
  const declaredLength = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return null
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

function messagePayload(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null
  const key = isRecord(value.key) ? value.key : null
  const messageId = stringValue(key?.id, 256)
  const remoteJid = stringValue(key?.remoteJid, 256)
  const remoteJidAlt = stringValue(key?.remoteJidAlt, 256)
  if (!messageId || !remoteJid) return null

  const message = isRecord(value.message) ? value.message : {}
  const nested = isRecord(message.ephemeralMessage) && isRecord(message.ephemeralMessage.message)
    ? message.ephemeralMessage.message
    : isRecord(message.viewOnceMessageV2) && isRecord(message.viewOnceMessageV2.message)
      ? message.viewOnceMessageV2.message
      : message
  const kindByKey: Record<string, string> = {
    imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', documentMessage: 'document',
    stickerMessage: 'sticker', locationMessage: 'location', liveLocationMessage: 'location',
    contactMessage: 'contact', contactsArrayMessage: 'contact', buttonsMessage: 'interactive',
    listMessage: 'interactive', templateMessage: 'interactive', reactionMessage: 'reaction',
  }
  const contentRecord = Object.keys(nested).find((keyName) => kindByKey[keyName] !== undefined)
  const kind = contentRecord ? kindByKey[contentRecord] : 'text'
  const contentObject = contentRecord && isRecord(nested[contentRecord]) ? nested[contentRecord] as JsonRecord : {}
  const content = stringValue(nested.conversation, 65_535)
    ?? stringValue(isRecord(nested.extendedTextMessage) ? nested.extendedTextMessage.text : null, 65_535)
    ?? stringValue(contentObject.caption, 65_535)
    ?? stringValue(contentObject.text, 65_535)
    ?? stringValue(contentObject.selectedDisplayText, 65_535)
  const mediaMetadata: JsonRecord = {}
  const mimeType = stringValue(contentObject.mimetype, 160)
  const fileName = stringValue(contentObject.fileName, 255)
  const fileLength = typeof contentObject.fileLength === 'number' && Number.isSafeInteger(contentObject.fileLength)
    ? contentObject.fileLength
    : null
  if (mimeType) mediaMetadata.mime_type = mimeType
  if (fileName) mediaMetadata.file_name = fileName
  if (fileLength !== null && fileLength >= 0) mediaMetadata.file_size = fileLength

  const fromMe = key?.fromMe === true
  const isGroup = isGroupJid(remoteJid)
  const senderName = stringValue(value.pushName, 160)
  const participantJid = stringValue(key?.participant ?? key?.participantLid ?? key?.participantAlt, 256)
  const participantAltJid = stringValue(key?.participantAlt ?? key?.participantPn ?? key?.senderPn, 256)
  if (isGroup && senderName) mediaMetadata.sender_name = senderName
  if (participantJid) mediaMetadata.participant_jid = participantJid
  if (participantAltJid) mediaMetadata.participant_alt_jid = participantAltJid
  if (kind === 'reaction') {
    const targetKey = isRecord(contentObject.key) ? contentObject.key : null
    const targetMessageId = stringValue(targetKey?.id, 256)
    if (targetMessageId) mediaMetadata.reaction_to_message_id = targetMessageId
  }
  const deliveryStatus = stringValue(value.status, 24)?.toLowerCase()
  const validStatus = ['pending', 'sent', 'delivered', 'read', 'played', 'failed', 'deleted'].includes(deliveryStatus ?? '')
    ? deliveryStatus
    : fromMe ? 'pending' : null

  return {
    id: messageId,
    remote_jid: remoteJid,
    remote_jid_alt: remoteJidAlt,
    // CONTACTS_* events and the contact directory provide the saved label first.
    // Keep pushName only as a fallback when Evolution has no saved-contact match.
    contact_name: !isGroup && !fromMe ? senderName : null,
    contact_phone: isGroup ? null : phoneFromJid(remoteJidAlt) ?? phoneFromJid(remoteJid),
    direction: fromMe ? 'outgoing' : 'incoming',
    message_kind: kind,
    content,
    delivery_status: validStatus,
    media_metadata: mediaMetadata,
    provider_timestamp: isoTimestamp(value.messageTimestamp ?? value.messageTimestampMs),
  }
}

async function hashKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function resolvePhoneMatch(admin: AdminClient, businessId: string, phone: string | null, conversationId: string) {
  if (!phone) return
  const { data: matchRows, error: matchError } = await admin.rpc('resolve_whatsapp_customer_phone_match', {
    p_business_id: businessId,
    p_phone: phone,
  })
  if (matchError) throw new Error('phone_match_failed')
  const match = Array.isArray(matchRows) ? matchRows[0] as JsonRecord | undefined : undefined
  const customerId = stringValue(match?.matched_customer_id, 64)
  const { data: context, error: contextError } = await admin
    .from('whatsapp_conversation_contexts')
    .select('customer_id, order_id, match_method')
    .eq('business_id', businessId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (contextError) throw new Error('context_lookup_failed')
  if (context?.match_method === 'manual' || context?.order_id) return
  if (!customerId || Number(match?.matches_count) !== 1) {
    if (context?.match_method === 'phone') {
      const { error: deleteError } = await admin.from('whatsapp_conversation_contexts')
        .delete().eq('business_id', businessId).eq('conversation_id', conversationId)
      if (deleteError) throw new Error('stale_phone_match_clear_failed')
    }
    return
  }
  if (context?.customer_id === customerId && context?.match_method === 'phone') return

  const { error: upsertError } = await admin.from('whatsapp_conversation_contexts').upsert({
    business_id: businessId,
    conversation_id: conversationId,
    customer_id: customerId,
    order_id: null,
    match_method: 'phone',
    updated_by: null,
  }, { onConflict: 'business_id,conversation_id' })
  if (upsertError) throw new Error('context_save_failed')
}

async function upsertConversation(
  admin: AdminClient,
  businessId: string,
  instanceName: string,
  remoteJid: string,
  remoteJidAlt: string | null,
  name: string | null,
  phone: string | null,
  activityAt: string,
  unreadCount?: number,
  authoritativeName = false,
) {
  const isGroup = isGroupJid(remoteJid)
  const safePhone = isGroup ? null : phone
  const existing = await findConversationByJidOrAlias(admin, businessId, instanceName, remoteJid, remoteJidAlt)

  if (existing?.id) {
    const update: JsonRecord = {}
    if (isGroup) {
      update.contact_name = null
      if (authoritativeName && name) update.group_subject = name
    } else if (name && (authoritativeName || !stringValue(existing.contact_name, 160))) {
      update.contact_name = name
    }
    if (isGroup) update.contact_phone = null
    else if (safePhone) update.contact_phone = safePhone
    const resolvedAltJid = await safeAlternateJid(
      admin, businessId, instanceName, existing.id as string, existing.remote_jid,
      remoteJidAlt, remoteJid, stringValue(existing.remote_jid_alt, 256),
    )
    update.remote_jid_alt = resolvedAltJid
    const existingPhone = stringValue(existing.contact_phone, 64)
    const existingJidAlt = stringValue(existing.remote_jid_alt, 256)
    const matchingPhone = isGroup ? null : safePhone
      ?? phoneFromJid(remoteJidAlt ?? existingJidAlt)
      ?? existingPhone
    if (matchingPhone && !safePhone) update.contact_phone = matchingPhone
    if (Object.keys(update).length) {
      const { error } = await admin.from('whatsapp_conversations').update(update)
        .eq('business_id', businessId).eq('id', existing.id)
      if (error) throw new Error('conversation_update_failed')
    }
    if (isGroup) {
      const { error: staleMatchError } = await admin.from('whatsapp_conversation_contexts')
        .delete().eq('business_id', businessId).eq('conversation_id', existing.id).eq('match_method', 'phone')
      if (staleMatchError) throw new Error('group_phone_match_clear_failed')
    } else {
      await resolvePhoneMatch(admin, businessId, matchingPhone, existing.id)
      await registerConversationJidAliases(admin, businessId, instanceName, existing.id as string, remoteJid, remoteJidAlt)
    }
    return existing.id as string
  }

  const safeAltJid = isGroup ? null : await safeAlternateJid(admin, businessId, instanceName, null, remoteJid, remoteJidAlt)
  const row: JsonRecord = {
    business_id: businessId,
    instance_name: instanceName,
    remote_jid: remoteJid,
    remote_jid_alt: safeAltJid,
    contact_name: isGroup ? null : name,
    group_subject: isGroup ? name : null,
    contact_phone: safePhone,
    last_activity_at: activityAt,
  }
  if (unreadCount !== undefined) row.unread_count = unreadCount

  const { data, error } = await admin.from('whatsapp_conversations')
    .upsert(row, { onConflict: 'business_id,instance_name,remote_jid', ignoreDuplicates: true })
    .select('id')
    .maybeSingle()
  if (error) throw new Error('conversation_save_failed')
  let conversationId = data?.id as string | undefined
  if (!conversationId) {
    const { data: raced, error: raceLookupError } = await admin.from('whatsapp_conversations')
      .select('id').eq('business_id', businessId).eq('instance_name', instanceName).eq('remote_jid', remoteJid).maybeSingle()
    if (raceLookupError || !raced?.id) throw new Error('conversation_save_failed')
    conversationId = raced.id as string
  }
  if (isGroup) {
    const { error: staleMatchError } = await admin.from('whatsapp_conversation_contexts')
      .delete().eq('business_id', businessId).eq('conversation_id', conversationId).eq('match_method', 'phone')
    if (staleMatchError) throw new Error('group_phone_match_clear_failed')
  } else {
    await resolvePhoneMatch(admin, businessId, safePhone, conversationId)
    await registerConversationJidAliases(admin, businessId, instanceName, conversationId, remoteJid, remoteJidAlt)
  }
  return conversationId
}

async function processMessageEvent(
  admin: AdminClient,
  businessId: string,
  instanceName: string,
  value: unknown,
  countAsUnread = true,
) {
  const payload = messagePayload(value)
  if (!payload) return
  const conversationId = await upsertConversation(
    admin,
    businessId,
    instanceName,
    payload.remote_jid as string,
    payload.remote_jid_alt as string | null,
    payload.contact_name as string | null,
    payload.contact_phone as string | null,
    payload.provider_timestamp as string,
  )
  const { error } = await admin.from('whatsapp_messages').upsert({
    business_id: businessId,
    conversation_id: conversationId,
    instance_name: instanceName,
    provider_message_id: payload.id,
    direction: payload.direction,
    message_kind: payload.message_kind,
    content: payload.content,
    delivery_status: payload.delivery_status,
    count_as_unread: countAsUnread,
    media_metadata: payload.media_metadata,
    provider_timestamp: payload.provider_timestamp,
  }, { onConflict: 'business_id,instance_name,provider_message_id', ignoreDuplicates: true })
  if (error) throw new Error('message_save_failed')
}

function statusValue(value: unknown): string | null {
  const raw = typeof value === 'number' ? value : stringValue(value, 24)?.toUpperCase()
  if (raw === 0 || raw === 'ERROR' || raw === 'FAILED') return 'failed'
  if (raw === 1 || raw === 'PENDING') return 'pending'
  if (raw === 2 || raw === 'SERVER_ACK' || raw === 'SENT') return 'sent'
  if (raw === 3 || raw === 'DELIVERY_ACK' || raw === 'DELIVERED') return 'delivered'
  if (raw === 4 || raw === 'READ') return 'read'
  if (raw === 5 || raw === 'PLAYED') return 'played'
  if (raw === 'DELETED') return 'deleted'
  return null
}

async function processMessageStatus(admin: AdminClient, businessId: string, instanceName: string, value: unknown) {
  const rows = eventRows(value, 'messages')
  for (const row of rows) {
    if (!isRecord(row)) continue
    const key = isRecord(row.key) ? row.key : row
    const messageId = stringValue(key.id, 256)
    if (!messageId) continue
    const update = isRecord(row.update) ? row.update : row
    const deliveryStatus = statusValue(update.status)
    if (!deliveryStatus) continue
    const { error } = await admin.from('whatsapp_messages')
      .update({ delivery_status: deliveryStatus, ...(deliveryStatus === 'deleted' ? { deleted_at: new Date().toISOString() } : {}) })
      .eq('business_id', businessId)
      .eq('instance_name', instanceName)
      .eq('provider_message_id', messageId)
    if (error) throw new Error('message_status_save_failed')
  }
}

async function processMessageDelete(admin: AdminClient, businessId: string, instanceName: string, value: unknown) {
  const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.keys) ? value.keys : [value]
  for (const row of rows) {
    const key = isRecord(row) && isRecord(row.key) ? row.key : row
    if (!isRecord(key)) continue
    const messageId = stringValue(key.id, 256)
    if (!messageId) continue
    const { error } = await admin.from('whatsapp_messages')
      .update({ delivery_status: 'deleted', deleted_at: new Date().toISOString(), content: null })
      .eq('business_id', businessId)
      .eq('instance_name', instanceName)
      .eq('provider_message_id', messageId)
    if (error) throw new Error('message_delete_save_failed')
  }
}

async function processCallEvent(admin: AdminClient, businessId: string, instanceName: string, value: unknown) {
  const callData = isRecord(value) && isRecord(value.packet) ? value.packet : value
  if (!isRecord(callData)) return
  const packetAttrs = isRecord(callData.attrs) ? callData.attrs : {}
  const children = Array.isArray(callData.content) ? callData.content.filter(isRecord) : []
  const callChild = children.find((child) => isRecord(child.attrs)
    && ['offer', 'terminate', 'reject', 'accept', 'ringing'].includes(stringValue(child.tag, 32)?.toLowerCase() ?? ''))
    ?? children[0]
  const childAttrs = callChild && isRecord(callChild.attrs) ? callChild.attrs : {}
  const callerJid = stringValue(packetAttrs.from ?? callData.from ?? callData.remoteJid, 256)
  const callerJidAlt = stringValue(childAttrs.caller_pn ?? childAttrs.callerPn
    ?? packetAttrs.caller_pn ?? callData.remoteJidAlt ?? callData.fromAlt, 256)
  const providerCallId = stringValue(childAttrs['call-id'] ?? packetAttrs['call-id']
    ?? callData.id ?? callData.callId, 256)
  const callState = stringValue(callChild?.tag ?? packetAttrs.state ?? callData.status ?? callData.state ?? callData.event, 64)
  const timestampValue = packetAttrs.t ?? childAttrs.t ?? callData.date ?? callData.timestamp ?? callData.messageTimestamp
  const occurredAt = isoTimestamp(timestampValue)
  const videoValue = callChild?.tag === 'video' ? true
    : callData.isVideo ?? callData.is_video ?? childAttrs.video ?? packetAttrs.video
  const isVideo = typeof videoValue === 'boolean' ? videoValue
    : typeof videoValue === 'string' && ['true', '1', 'video'].includes(videoValue.toLowerCase()) ? true
      : typeof videoValue === 'string' && ['false', '0', 'audio'].includes(videoValue.toLowerCase()) ? false
        : null
  const stableIdentity = providerCallId
    ? `${providerCallId}|${callState ?? ''}`
    : [callerJid ?? '', callState ?? '', stringValue(timestampValue, 128) ?? JSON.stringify(callData)].join('|')
  const eventKey = await hashKey(stableIdentity)
  const remoteJid = callerJid ?? callerJidAlt ?? `unknown-call:${eventKey}`
  const callerPhone = phoneFromJid(callerJidAlt) ?? phoneFromJid(callerJid)
  const conversationId = await upsertConversation(
    admin,
    businessId,
    instanceName,
    remoteJid,
    callerJidAlt,
    null,
    callerPhone,
    occurredAt,
  )
  const { error } = await admin.from('whatsapp_call_events').upsert({
    business_id: businessId,
    conversation_id: conversationId,
    instance_name: instanceName,
    provider_event_key: eventKey,
    provider_call_id: providerCallId,
    caller_jid: callerJid ?? callerJidAlt,
    caller_phone: callerPhone,
    event_name: 'CALL',
    call_state: callState,
    is_video: isVideo,
    occurred_at: occurredAt,
  }, { onConflict: 'business_id,instance_name,provider_event_key', ignoreDuplicates: true })
  if (error) throw new Error('call_event_save_failed')
}

async function processChatOrContactEvent(
  admin: AdminClient,
  businessId: string,
  instanceName: string,
  event: string,
  value: unknown,
) {
  const collectionKey = event.startsWith('CONTACTS_') ? 'contacts'
    : event.startsWith('GROUP') ? 'groups' : 'chats'
  const rows = eventRows(value, collectionKey)
  for (const row of rows) {
    if (!isRecord(row)) continue
    const isGroupEvent = event === 'GROUPS_UPSERT' || event === 'GROUP_UPDATE' || event === 'GROUPS_UPDATE'
    const jid = stringValue(row.remoteJid ?? row.groupJid ?? row.jid ?? row.id ?? row.wuid, 256)
    const jidAlt = stringValue(row.remoteJidAlt ?? row.phoneNumberJid, 256)
    if (!jid) continue
    const isContactEvent = event.startsWith('CONTACTS_')
    const isChatEvent = event.startsWith('CHATS_') || isGroupEvent
    const isGroup = isGroupEvent || isGroupJid(jid)
    const hasProviderSavedName = isGroup
      ? Boolean(stringValue(row.subject ?? row.groupSubject ?? row.group_subject, 160))
      : isContactEvent && Boolean(stringValue(row.name ?? row.pushName ?? row.verifiedName, 160))
    const name = isGroup
      ? evolutionContactName(row, true)
      : isContactEvent && hasProviderSavedName ? evolutionContactName(row, false) : null
    const phone = isGroup ? null : phoneFromJid(jidAlt) ?? phoneFromJid(jid)
    if (isChatEvent) {
      const unread = typeof row.unreadCount === 'number' ? row.unreadCount
        : typeof row.unreadMessages === 'number' ? row.unreadMessages : undefined
      const timestamp = row.lastMessageRecvTimestamp ?? row.conversationTimestamp
      await upsertConversation(admin, businessId, instanceName, jid, jidAlt, name, phone, isoTimestamp(timestamp), unread, hasProviderSavedName)
      continue
    }
    if (!isContactEvent) continue
    if (isGroup) continue
    const update: JsonRecord = {}
    if (Object.prototype.hasOwnProperty.call(row, 'name')
      || Object.prototype.hasOwnProperty.call(row, 'pushName')
      || Object.prototype.hasOwnProperty.call(row, 'verifiedName')) update.contact_name = name
    if (phone) update.contact_phone = phone
    const matchedConversation = await findConversationByJidOrAlias(admin, businessId, instanceName, jid, jidAlt)
    if (!matchedConversation) continue
    const resolvedAltJid = await safeAlternateJid(
      admin, businessId, instanceName, matchedConversation.id, matchedConversation.remote_jid,
      jidAlt, jid, stringValue(matchedConversation.remote_jid_alt, 256),
    )
    update.remote_jid_alt = resolvedAltJid
    if (Object.keys(update).length) {
      const { error } = await admin.from('whatsapp_conversations').update(update)
        .eq('business_id', businessId).eq('id', matchedConversation.id)
      if (error) throw new Error('contact_update_save_failed')
    }
    await registerConversationJidAliases(admin, businessId, instanceName, matchedConversation.id, jid, jidAlt)
    if (phone) {
      await resolvePhoneMatch(admin, businessId, phone, matchedConversation.id)
    }
  }
}

export default {
  fetch: withSupabase({ auth: 'none' }, async (request, context) => {
  if (request.method === 'OPTIONS') return new Response('ok')
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const configuration = await loadWebhookConfiguration(context.supabaseAdmin)
  if (!configuration) {
    return json({ error: 'webhook_not_configured' }, 503)
  }

  const authorization = request.headers.get('Authorization') ?? ''
  const bearer = authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? ''
  if (!bearer || !constantTimeEqual(bearer, configuration.secret)) return json({ error: 'unauthorized' }, 401)
  let rawBody: string | null
  try {
    rawBody = await readBoundedBody(request)
  } catch {
    return json({ error: 'invalid_payload' }, 400)
  }
  if (rawBody === null) return json({ error: 'payload_too_large' }, 413)

  let body: JsonRecord
  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (!isRecord(parsed)) return json({ error: 'invalid_payload' }, 400)
    body = parsed
  } catch {
    return json({ error: 'invalid_payload' }, 400)
  }

  if (stringValue(body.instance, 120) !== configuration.instanceName) return json({ error: 'instance_mismatch' }, 403)
  const event = normalizedEvent(body.event)
  if (!event) return json({ error: 'invalid_event' }, 400)
  const admin = context.supabaseAdmin
  const businessId = configuration.businessId
  const payload = body.data

  try {
    if (event === 'MESSAGES_UPSERT' || event === 'MESSAGES_SET' || event === 'SEND_MESSAGE') {
      const messages = eventRows(payload, 'messages')
      for (const message of messages) {
        await processMessageEvent(admin, businessId, configuration.instanceName, message, event !== 'MESSAGES_SET')
      }
    } else if (event === 'MESSAGES_UPDATE') {
      await processMessageStatus(admin, businessId, configuration.instanceName, payload)
    } else if (event === 'MESSAGES_DELETE') {
      await processMessageDelete(admin, businessId, configuration.instanceName, payload)
    } else if (event === 'CALL') {
      for (const call of eventRows(payload, 'calls')) {
        await processCallEvent(admin, businessId, configuration.instanceName, call)
      }
    } else if (event === 'CHATS_SET' || event === 'CHATS_UPSERT' || event === 'CHATS_UPDATE'
      || event === 'GROUPS_UPSERT' || event === 'GROUP_UPDATE' || event === 'GROUPS_UPDATE'
      || event === 'CONTACTS_SET' || event === 'CONTACTS_UPSERT' || event === 'CONTACTS_UPDATE') {
      await processChatOrContactEvent(admin, businessId, configuration.instanceName, event, payload)
    }
    return json({ received: true })
  } catch {
    // Never log the raw webhook body; it contains customer conversations and phone numbers.
    console.error('Evolution webhook event could not be persisted.')
    return json({ error: 'event_persistence_failed' }, 500)
  }
  }),
}
