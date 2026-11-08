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

function displayableContactName(value: unknown): string | null {
  const name = stringValue(value, 160)
  if (!name || /^(?:contato|grupo) (?:sem nome|sem identificação|sem identificacao)$/i.test(name)
    || /@(lid|g[.]us|s[.]whatsapp[.]net|c[.]us|broadcast|newsletter)\b/i.test(name)) return null
  const digits = name.replace(/\D/g, '')
  if (/^[+\d\s().-]+$/.test(name) && digits.length >= 8 && digits.length <= 15) return null
  return name
}

async function withWebhookStage<T>(event: string, stage: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const errorType = error instanceof Error ? error.name.toLowerCase().replace(/[^a-z0-9_-]/g, '') : 'unknown'
    console.error(`Evolution webhook stage failed safely. event=${event} stage=${stage} error_type=${errorType || 'unknown'}`)
    throw error
  }
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

function canonicalPhoneJid(value: unknown): string | null {
  if (!isDirectWhatsAppJid(value) || !value.toLowerCase().endsWith('@s.whatsapp.net')) return null
  const localPart = value.split('@', 1)[0].split(':', 1)[0]
  let digits = digitsOnly(localPart)
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`
  return digits.length >= 8 && digits.length <= 15 ? `${digits}@s.whatsapp.net` : null
}

function phoneJidFromProviderValue(value: unknown): string | null {
  const jid = canonicalPhoneJid(value)
  if (jid) return jid
  const raw = typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  const legacyJid = raw.toLowerCase().match(/^([0-9]{8,15})(?::[0-9]{1,5})?@(?:c\.us|whatsapp\.net)$/)
  if (legacyJid) {
    const digits = legacyJid[1].length === 10 || legacyJid[1].length === 11 ? `55${legacyJid[1]}` : legacyJid[1]
    return `${digits}@s.whatsapp.net`
  }
  if (!/^\+?[0-9\s().-]+$/.test(raw)) return null
  let digits = digitsOnly(raw)
  if (raw.startsWith('+')) {
    return digits.length >= 8 && digits.length <= 15 ? `${digits}@s.whatsapp.net` : null
  }
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`
  return digits.length >= 12 && digits.length <= 15 ? `${digits}@s.whatsapp.net` : null
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

function contactIdentityPair(values: unknown[]): { lidJid: string; phoneJid: string } | null {
  const jids = [...new Set(values.filter(isDirectWhatsAppJid).map((value) => value.toLowerCase()))]
  const lids = [...new Set(jids.filter((value) => value.endsWith('@lid')))]
  const phones = [...new Set(values.map(phoneJidFromProviderValue).filter((value): value is string => Boolean(value)))]
  return lids.length === 1 && phones.length === 1 ? { lidJid: lids[0], phoneJid: phones[0] } : null
}

function hasContactIdentityCandidates(values: unknown[]): boolean {
  return values.some((value) => isDirectWhatsAppJid(value) && value.toLowerCase().endsWith('@lid'))
    && values.some((value) => Boolean(phoneJidFromProviderValue(value)))
}

async function saveContactIdentityMapping(
  admin: AdminClient,
  businessId: string,
  instanceName: string,
  values: unknown[],
  contactName: string | null = null,
  authoritativeName = false,
) {
  const pair = contactIdentityPair(values)
  if (!pair) return null
  const { error } = await admin.from('whatsapp_contact_jid_mappings').upsert({
    business_id: businessId,
    instance_name: instanceName,
    lid_jid: pair.lidJid,
    phone_jid: pair.phoneJid,
    contact_name: contactName,
  }, { onConflict: 'business_id,instance_name,lid_jid', ignoreDuplicates: true })
  if (error) throw new Error('contact_identity_save_failed')
  const { data, error: lookupError } = await admin.from('whatsapp_contact_jid_mappings')
    .select('lid_jid, phone_jid, contact_name, identity_conflict')
    .eq('business_id', businessId).eq('instance_name', instanceName).eq('lid_jid', pair.lidJid)
    .maybeSingle()
  if (lookupError) throw new Error('contact_identity_lookup_failed')
  if (data?.phone_jid !== pair.phoneJid || data.identity_conflict === true) {
    const { error: conflictError } = await admin.from('whatsapp_contact_jid_mappings')
      .update({ identity_conflict: true, updated_at: new Date().toISOString() })
      .eq('business_id', businessId).eq('instance_name', instanceName).eq('lid_jid', pair.lidJid)
    if (conflictError) throw new Error('contact_identity_conflict_save_failed')
    return null
  }
  const savedName = displayableContactName(data.contact_name)
  if (contactName && (!savedName || authoritativeName)) {
    const { error: nameError } = await admin.from('whatsapp_contact_jid_mappings')
      .update({ contact_name: contactName, updated_at: new Date().toISOString() })
      .eq('business_id', businessId).eq('instance_name', instanceName)
      .eq('lid_jid', pair.lidJid).eq('phone_jid', pair.phoneJid)
    if (nameError) throw new Error('contact_identity_name_save_failed')
  }
  return { ...pair, contactName: authoritativeName ? contactName : savedName ?? contactName }
}

async function mappedPhoneIdentity(admin: AdminClient, businessId: string, instanceName: string, lidJid: string) {
  const { data, error } = await admin.from('whatsapp_contact_jid_mappings')
    .select('phone_jid, contact_name, identity_conflict')
    .eq('business_id', businessId).eq('instance_name', instanceName).eq('lid_jid', lidJid.toLowerCase())
    .maybeSingle()
  if (error) throw new Error('contact_identity_lookup_failed')
  const phoneJid = stringValue(data?.phone_jid, 256)
  if (data?.identity_conflict === true || !phoneJid || !phoneJid.endsWith('@s.whatsapp.net') || !phoneFromJid(phoneJid)) return null
  return { lidJid: lidJid.toLowerCase(), phoneJid, contactName: stringValue(data?.contact_name, 160) }
}

async function isConflictedContactLid(admin: AdminClient, businessId: string, instanceName: string, jid: string): Promise<boolean> {
  if (!jid.toLowerCase().endsWith('@lid')) return false
  const { data, error } = await admin.from('whatsapp_contact_jid_mappings')
    .select('identity_conflict')
    .eq('business_id', businessId).eq('instance_name', instanceName).eq('lid_jid', jid.toLowerCase())
    .maybeSingle()
  if (error) throw new Error('contact_identity_lookup_failed')
  return data?.identity_conflict === true
}

async function mergeKnownContactIdentity(
  admin: AdminClient,
  businessId: string,
  instanceName: string,
  lidJid: string,
  phoneJid: string,
) {
  const { error } = await admin.rpc('merge_whatsapp_conversations_by_identity', {
    p_business_id: businessId,
    p_instance_name: instanceName,
    p_lid_jid: lidJid.toLowerCase(),
    p_phone_jid: phoneJid.toLowerCase(),
  })
  if (!error) return true
  if (['22023', '23505', '42501', 'P0001', 'P0002'].includes(String(error.code))) return false
  throw new Error('contact_identity_merge_failed')
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
    if (await isConflictedContactLid(admin, businessId, instanceName, normalized)) continue
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

  const candidateAliases = [...new Set([remoteJid, remoteJidAlt].filter(isDirectWhatsAppJid).map((value) => value.toLowerCase()))]
  const lidAliases = candidateAliases.filter((value) => value.endsWith('@lid'))
  const conflictedAliases = new Set<string>()
  if (lidAliases.length) {
    const { data: mappings, error } = await admin.from('whatsapp_contact_jid_mappings')
      .select('lid_jid')
      .eq('business_id', businessId).eq('instance_name', instanceName)
      .eq('identity_conflict', true).in('lid_jid', lidAliases)
    if (error) throw new Error('contact_identity_lookup_failed')
    for (const row of mappings ?? []) conflictedAliases.add(String(row.lid_jid).toLowerCase())
  }
  const aliases = candidateAliases.filter((value) => !conflictedAliases.has(value))
  if (!aliases.length) return null
  const primaryJid = isDirectWhatsAppJid(remoteJid) && !conflictedAliases.has(remoteJid.toLowerCase())
    ? remoteJid.toLowerCase()
    : null
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
    ? [row.subject, row.groupSubject, row.group_subject, row.groupName, row.group_name]
    : [row.name, row.contactName, row.shortName, row.short_name, row.displayName, row.display_name,
      row.notify, row.notifyName, row.pushName, row.pushname, row.verifiedName]
  for (const candidate of candidates) {
    const name = displayableContactName(candidate)
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
  mediaMetadata.provider_remote_jid = remoteJid
  if (remoteJidAlt) mediaMetadata.provider_remote_jid_alt = remoteJidAlt

  const fromMe = key?.fromMe === true
  const isGroup = isGroupJid(remoteJid)
  const senderName = displayableContactName(value.pushName)
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
  const validStatus = statusValue(value.status ?? key?.status)

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
    delivery_status: validStatus ?? (fromMe ? 'sent' : null),
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
  allowAlternateIdentity = true,
) {
  const isGroup = isGroupJid(remoteJid)
  const safePhone = isGroup ? null : allowAlternateIdentity ? phone : phoneFromJid(remoteJid)
  const existing = await findConversationByJidOrAlias(admin, businessId, instanceName, remoteJid, remoteJidAlt)

  if (existing?.id) {
    const update: JsonRecord = {}
    if (unreadCount !== undefined) update.unread_count = Math.max(0, Math.floor(unreadCount))
    if (isGroup) {
      update.contact_name = null
      if (authoritativeName && name) update.group_subject = name
    } else if (name && (authoritativeName || !displayableContactName(existing.contact_name))) {
      update.contact_name = name
    }
    if (isGroup) update.contact_phone = null
    else if (!allowAlternateIdentity) update.contact_phone = safePhone
    else if (safePhone) update.contact_phone = safePhone
    const resolvedAltJid = allowAlternateIdentity ? await safeAlternateJid(
      admin, businessId, instanceName, existing.id as string, existing.remote_jid,
      remoteJidAlt, remoteJid, stringValue(existing.remote_jid_alt, 256),
    ) : null
    update.remote_jid_alt = resolvedAltJid
    const existingPhone = stringValue(existing.contact_phone, 64)
    const existingJidAlt = stringValue(existing.remote_jid_alt, 256)
    const matchingPhone = isGroup ? null : allowAlternateIdentity
      ? safePhone ?? phoneFromJid(remoteJidAlt ?? existingJidAlt) ?? existingPhone
      : safePhone
    if (allowAlternateIdentity && matchingPhone && !safePhone) update.contact_phone = matchingPhone
    if (Object.keys(update).length) {
      const { error } = await admin.from('whatsapp_conversations').update(update)
        .eq('business_id', businessId).eq('id', existing.id)
      if (error) throw new Error('conversation_update_failed')
    }
    if (unreadCount !== undefined && unreadCount <= 0) {
      const { error } = await admin.from('whatsapp_messages').update({ count_as_unread: false })
        .eq('business_id', businessId).eq('instance_name', instanceName).eq('conversation_id', existing.id)
        .eq('direction', 'incoming').eq('count_as_unread', true)
      if (error) throw new Error('conversation_read_state_update_failed')
    }
    if (isGroup) {
      const { error: staleMatchError } = await admin.from('whatsapp_conversation_contexts')
        .delete().eq('business_id', businessId).eq('conversation_id', existing.id).eq('match_method', 'phone')
      if (staleMatchError) throw new Error('group_phone_match_clear_failed')
    } else if (allowAlternateIdentity) {
      await resolvePhoneMatch(admin, businessId, matchingPhone, existing.id)
      await registerConversationJidAliases(admin, businessId, instanceName, existing.id as string, remoteJid, remoteJidAlt)
    } else {
      if (safePhone) await resolvePhoneMatch(admin, businessId, safePhone, existing.id as string)
      else {
        const { error: staleMatchError } = await admin.from('whatsapp_conversation_contexts')
          .delete().eq('business_id', businessId).eq('conversation_id', existing.id).eq('match_method', 'phone')
        if (staleMatchError) throw new Error('stale_phone_match_clear_failed')
      }
      await registerConversationJidAliases(admin, businessId, instanceName, existing.id as string, remoteJid)
    }
    return existing.id as string
  }

  const safeAltJid = isGroup || !allowAlternateIdentity
    ? null
    : await safeAlternateJid(admin, businessId, instanceName, null, remoteJid, remoteJidAlt)
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
  } else if (allowAlternateIdentity) {
    await resolvePhoneMatch(admin, businessId, safePhone, conversationId)
    await registerConversationJidAliases(admin, businessId, instanceName, conversationId, remoteJid, remoteJidAlt)
  } else {
    if (safePhone) await resolvePhoneMatch(admin, businessId, safePhone, conversationId)
    await registerConversationJidAliases(admin, businessId, instanceName, conversationId, remoteJid)
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
  const identityValues = [payload.remote_jid, payload.remote_jid_alt]
  const hasIdentityPair = hasContactIdentityCandidates(identityValues)
  const messageLid = identityValues.find((value) => isDirectWhatsAppJid(value) && value.toLowerCase().endsWith('@lid'))
  const identityConflict = typeof messageLid === 'string'
    ? await isConflictedContactLid(admin, businessId, instanceName, messageLid)
    : false
  const explicitIdentity = await saveContactIdentityMapping(
    admin, businessId, instanceName,
    identityValues,
    payload.contact_name as string | null,
  )
  const mappedIdentity = explicitIdentity ?? (!identityConflict && typeof messageLid === 'string'
    ? await mappedPhoneIdentity(admin, businessId, instanceName, messageLid)
    : null)
  let identityLinked = hasIdentityPair || typeof messageLid === 'string'
    ? Boolean(mappedIdentity)
    : !identityConflict
  if (mappedIdentity) identityLinked = await mergeKnownContactIdentity(
    admin, businessId, instanceName, mappedIdentity.lidJid, mappedIdentity.phoneJid,
  )
  const remoteJid = identityLinked && mappedIdentity ? mappedIdentity.phoneJid : payload.remote_jid as string
  const remoteJidAlt = identityLinked && mappedIdentity ? mappedIdentity.lidJid
    : identityLinked ? payload.remote_jid_alt as string | null : null
  const payloadContactName = payload.contact_name as string | null
  const contactName = identityLinked ? payloadContactName ?? mappedIdentity?.contactName ?? null : payloadContactName
  const contactPhone = identityLinked
    ? phoneFromJid(mappedIdentity?.phoneJid ?? '') ?? (payload.contact_phone as string | null)
    : phoneFromJid(remoteJid)
  const conversationId = await upsertConversation(
    admin,
    businessId,
    instanceName,
    remoteJid,
    remoteJidAlt,
    contactName,
    contactPhone,
    payload.provider_timestamp as string,
    undefined,
    false,
    identityLinked,
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
  if (typeof payload.delivery_status === 'string') {
    const { error: deliveryError } = await admin.rpc('apply_whatsapp_delivery_status_event', {
      p_business_id: businessId,
      p_instance_name: instanceName,
      p_provider_message_id: String(payload.id),
      p_delivery_status: payload.delivery_status,
    })
    if (deliveryError) throw new Error('message_status_save_failed')
  }
}

function statusValue(value: unknown): string | null {
  if (isRecord(value)) {
    return statusValue(value.status ?? value.messageStatus ?? value.message_status ?? value.ack ?? value.state ?? value.value)
  }
  const text = typeof value === 'number' ? null : stringValue(value, 24)?.toUpperCase()
  const numeric = typeof value === 'number' ? value : text && /^\d+$/.test(text) ? Number(text) : null
  if (numeric === 0 || text === 'ERROR' || text === 'FAILED') return 'failed'
  if (numeric === 1 || text === 'PENDING') return 'pending'
  if (numeric === 2 || text === 'SERVER_ACK' || text === 'SENT') return 'sent'
  if (numeric === 3 || text === 'DELIVERY_ACK' || text === 'DELIVERED') return 'delivered'
  if (numeric === 4 || text === 'READ') return 'read'
  if (numeric === 5 || text === 'PLAYED') return 'played'
  if (text === 'DELETED') return 'deleted'
  return null
}

async function processMessageStatus(admin: AdminClient, businessId: string, instanceName: string, value: unknown) {
  const rows = Array.isArray(value) ? value
    : isRecord(value) && Array.isArray(value.messages) ? value.messages
      : isRecord(value) && Array.isArray(value.keys) ? value.keys
        : isRecord(value) && Array.isArray(value.updates) ? value.updates
          : [value]
  for (const row of rows) {
    if (!isRecord(row)) continue
    const key = isRecord(row.key) ? row.key
      : isRecord(row.messageKey) ? row.messageKey
        : isRecord(row.message_key) ? row.message_key
          : isRecord(row.message) && isRecord(row.message.key) ? row.message.key : row
    const messageId = stringValue(key.id ?? key.messageId ?? key.message_id
      ?? row.keyId ?? row.key_id ?? row.messageId ?? row.message_id ?? row.id, 256)
    if (!messageId) continue
    const update = isRecord(row.update) ? row.update
      : isRecord(row.messageUpdate) ? row.messageUpdate
        : isRecord(row.message_update) ? row.message_update : row
    const deliveryStatus = statusValue(update.status ?? update.messageStatus ?? update.message_status
      ?? update.ack ?? update.receipt ?? row.status ?? row.messageStatus ?? row.message_status ?? row.ack ?? row.receipt)
    if (!deliveryStatus) continue
    const { error } = await admin.rpc('apply_whatsapp_delivery_status_event', {
      p_business_id: businessId,
      p_instance_name: instanceName,
      p_provider_message_id: messageId,
      p_delivery_status: deliveryStatus,
    })
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
  const callIdentityValues = [
    callerJid, callerJidAlt,
    childAttrs.caller_pn, childAttrs.callerPn, childAttrs.phoneNumberJid, childAttrs.phone_number_jid,
    childAttrs.remoteJid, childAttrs.remoteJidAlt, childAttrs.remoteJidLid,
    packetAttrs.caller_pn, packetAttrs.callerPn, packetAttrs.phoneNumberJid, packetAttrs.phone_number_jid,
    packetAttrs.remoteJid, packetAttrs.remoteJidAlt, packetAttrs.remoteJidLid,
    callData.callerPn, callData.phoneNumberJid, callData.phone_number_jid,
    callData.remoteJidLid, callData.lidJid, callData.wuid,
  ]
  const explicitIdentity = await saveContactIdentityMapping(admin, businessId, instanceName, callIdentityValues)
  const callerLid = callIdentityValues.find((value) => isDirectWhatsAppJid(value) && value.toLowerCase().endsWith('@lid'))
  const directPhoneJid = callIdentityValues.map(phoneJidFromProviderValue).find((value): value is string => Boolean(value))
  const callerLidString = typeof callerLid === 'string' ? callerLid : null
  const rejectedIdentity = Boolean(callerLid && directPhoneJid && !explicitIdentity)
    || (callerLidString ? await isConflictedContactLid(admin, businessId, instanceName, callerLidString) : false)
  const mappedIdentity = explicitIdentity ?? (!rejectedIdentity && typeof callerLid === 'string'
    ? await mappedPhoneIdentity(admin, businessId, instanceName, callerLid)
    : null)
  const identityLid = explicitIdentity?.lidJid ?? (mappedIdentity && typeof callerLid === 'string' ? callerLid.toLowerCase() : null)
  const identityPhoneJid = explicitIdentity?.phoneJid ?? mappedIdentity?.phoneJid
    ?? (typeof callerLid === 'string' && typeof directPhoneJid === 'string' ? directPhoneJid.toLowerCase() : null)
  const identityLinked = identityLid && identityPhoneJid
    ? await mergeKnownContactIdentity(admin, businessId, instanceName, identityLid, identityPhoneJid)
    : !rejectedIdentity && typeof callerLid !== 'string'
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
  const remoteJid = identityLinked ? identityPhoneJid ?? callerJid ?? callerJidAlt ?? `unknown-call:${eventKey}`
    : callerJid ?? callerJidAlt ?? `unknown-call:${eventKey}`
  const remoteJidAlt = identityLinked ? identityLid ?? callerJidAlt : null
  const callerPhone = identityLinked
    ? phoneFromJid(identityPhoneJid) ?? phoneFromJid(callerJidAlt) ?? phoneFromJid(callerJid)
    : phoneFromJid(remoteJid)
  const callerName = mappedIdentity?.contactName ?? null
  const conversationId = await upsertConversation(
    admin,
    businessId,
    instanceName,
    remoteJid,
    remoteJidAlt,
    callerName,
    callerPhone,
    occurredAt,
    undefined,
    false,
    identityLinked,
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
    const jid = stringValue(row.remoteJid ?? row.remote_jid ?? row.groupJid ?? row.group_jid
      ?? row.jid ?? row.id ?? row.contactId ?? row.contact_id ?? row.wuid ?? row.phoneNumberJid ?? row.phone_jid, 256)
    const jidAlt = stringValue(row.remoteJidAlt ?? row.remote_jid_alt ?? row.remoteJidLid
      ?? row.remote_jid_lid ?? row.phoneNumberJid ?? row.phone_number_jid ?? row.phoneJid ?? row.phone_jid, 256)
    if (!jid) continue
    const isContactEvent = event.startsWith('CONTACTS_')
    const isChatEvent = event.startsWith('CHATS_') || isGroupEvent
    const isGroup = isGroupEvent || isGroupJid(jid)
    const name = isGroup ? evolutionContactName(row, true)
      : isContactEvent ? evolutionContactName(row, false) : null
    const hasProviderSavedName = Boolean(name)
    const identity = isGroup ? null : await saveContactIdentityMapping(admin, businessId, instanceName, [
      jid, jidAlt, row.remoteJidLid, row.remote_jid_lid, row.phoneNumberJid, row.phone_number_jid,
      row.phoneJid, row.phone_jid, row.pnJid, row.pn_jid, row.lid, row.lidJid, row.lid_jid,
      row.wuid, row.id, row.contactId, row.contact_id, row.phoneNumber, row.phone_number,
      row.phone, row.number, row.pn,
    ], name, true)
    const identityValues = [
      jid, jidAlt, row.remoteJidLid, row.remote_jid_lid, row.phoneNumberJid, row.phone_number_jid,
      row.phoneJid, row.phone_jid, row.pnJid, row.pn_jid, row.lid, row.lidJid, row.lid_jid,
      row.wuid, row.id, row.contactId, row.contact_id, row.phoneNumber, row.phone_number,
      row.phone, row.number, row.pn,
    ]
    const hasIdentityPair = !isGroup && hasContactIdentityCandidates(identityValues)
    const contactLid = identityValues.find((value) => isDirectWhatsAppJid(value) && value.toLowerCase().endsWith('@lid'))
    const identityConflict = !isGroup && typeof contactLid === 'string'
      ? await isConflictedContactLid(admin, businessId, instanceName, contactLid)
      : false
    const mappedIdentity = identity ?? (!identityConflict && typeof contactLid === 'string'
      ? await mappedPhoneIdentity(admin, businessId, instanceName, contactLid)
      : null)
    let identityLinked = hasIdentityPair || typeof contactLid === 'string'
      ? Boolean(mappedIdentity)
      : !identityConflict
    if (mappedIdentity) identityLinked = await mergeKnownContactIdentity(
      admin, businessId, instanceName, mappedIdentity.lidJid, mappedIdentity.phoneJid,
    )
    const conversationJid = identityLinked && mappedIdentity ? mappedIdentity.phoneJid : jid
    const conversationJidAlt = identityLinked && mappedIdentity ? mappedIdentity.lidJid
      : identityLinked ? jidAlt : null
    const conversationName = identityLinked ? name ?? mappedIdentity?.contactName ?? null : name
    const phone = isGroup ? null : identityLinked
      ? phoneFromJid(mappedIdentity?.phoneJid ?? '')
        ?? phoneFromJid(phoneJidFromProviderValue(jidAlt) ?? '')
        ?? phoneFromJid(phoneJidFromProviderValue(jid) ?? '')
      : phoneFromJid(phoneJidFromProviderValue(jid) ?? '')
    if (isChatEvent) {
      const unread = typeof row.unreadCount === 'number' ? row.unreadCount
        : typeof row.unreadMessages === 'number' ? row.unreadMessages : undefined
      const timestamp = row.lastMessageRecvTimestamp ?? row.conversationTimestamp
      await upsertConversation(admin, businessId, instanceName, conversationJid, conversationJidAlt, conversationName, phone, isoTimestamp(timestamp), unread, hasProviderSavedName, identityLinked)
      continue
    }
    if (!isContactEvent) continue
    if (isGroup) continue
    const update: JsonRecord = {}
    // CONTACTS_UPDATE can be partial and send an empty name. Keep the last
    // known label until the provider supplies a non-empty replacement.
    if (name) update.contact_name = name
    if (phone) update.contact_phone = phone
    const matchedConversation = await findConversationByJidOrAlias(admin, businessId, instanceName, conversationJid, conversationJidAlt)
    if (!matchedConversation) continue
    const resolvedAltJid = await safeAlternateJid(
      admin, businessId, instanceName, matchedConversation.id, matchedConversation.remote_jid,
      identityLinked ? conversationJidAlt : null, conversationJid, stringValue(matchedConversation.remote_jid_alt, 256),
    )
    update.remote_jid_alt = resolvedAltJid
    if (Object.keys(update).length) {
      const { error } = await admin.from('whatsapp_conversations').update(update)
        .eq('business_id', businessId).eq('id', matchedConversation.id)
      if (error) throw new Error('contact_update_save_failed')
    }
    await registerConversationJidAliases(admin, businessId, instanceName, matchedConversation.id, conversationJid, identityLinked ? conversationJidAlt : null)
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
      await withWebhookStage(event, 'message_status', () =>
        processMessageStatus(admin, businessId, configuration.instanceName, payload))
    } else if (event === 'MESSAGES_DELETE') {
      await processMessageDelete(admin, businessId, configuration.instanceName, payload)
    } else if (event === 'CALL') {
      for (const call of eventRows(payload, 'calls')) {
        await processCallEvent(admin, businessId, configuration.instanceName, call)
      }
    } else if (event === 'CHATS_SET' || event === 'CHATS_UPSERT' || event === 'CHATS_UPDATE'
      || event === 'GROUPS_UPSERT' || event === 'GROUP_UPDATE' || event === 'GROUPS_UPDATE'
      || event === 'CONTACTS_SET' || event === 'CONTACTS_UPSERT' || event === 'CONTACTS_UPDATE') {
      await withWebhookStage(event, 'chat_or_contact', () =>
        processChatOrContactEvent(admin, businessId, configuration.instanceName, event, payload))
    }
    return json({ received: true })
  } catch (error) {
    // Never log the raw webhook body; it contains customer conversations and phone numbers.
    const errorRecord = isRecord(error) ? error : {}
    const safeCode = stringValue(errorRecord.code, 32)
      ?? (error instanceof Error && /^[a-z0-9_:-]{1,80}$/i.test(error.message) ? error.message : 'unclassified_error')
    console.error(`Evolution webhook event could not be persisted. event=${event} code=${safeCode}`)
    return json({ error: 'event_persistence_failed' }, 500)
  }
  }),
}
