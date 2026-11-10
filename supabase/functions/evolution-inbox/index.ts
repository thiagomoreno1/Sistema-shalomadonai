import { withSupabase } from '@supabase/server'

const PAGE_SIZE = 25
const MESSAGE_HISTORY_LIMIT = 150
const OLDER_MESSAGE_PAGE_SIZE = 50
const LEGACY_CHAT_PAGE_SIZE = 25
const CONTACT_DIRECTORY_PAGE_SIZE = 50
const CONTACT_NAME_MAX_PAGES = 20
// The provider fills its chat/message tables asynchronously after pairing.
// Refresh this cache before the inbox's 30s poll so an empty/partial first
// response does not hide conversations that arrive during history sync.
const LEGACY_SYNC_COOLDOWN_MS = 15_000
const CONTACT_NAMES_COOLDOWN_MS = 60_000
const CONTACT_IDENTITY_RECONCILE_COOLDOWN_MS = 30_000
const MAX_MEDIA_BYTES = 25 * 1024 * 1024
const MAX_PROFILE_PICTURE_BYTES = 2 * 1024 * 1024
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
const EVOLUTION_WEBHOOK_EVENTS = ['MESSAGES_SET', 'MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'SEND_MESSAGE',
  'CONTACTS_SET', 'CONTACTS_UPSERT', 'CONTACTS_UPDATE', 'CHATS_SET', 'CHATS_UPSERT', 'CHATS_UPDATE',
  'GROUPS_UPSERT', 'GROUP_UPDATE', 'GROUPS_UPDATE', 'CALL', 'CONNECTION_UPDATE']
const recentLegacySync = new Map<string, { at: number; result: JsonRecord }>()
const recentIdentityReconcile = new Map<string, { at: number; merged: number }>()
type ContactProfile = { name: string | null; pictureUrl: string | null; phone?: string | null }
type ContactDirectory = Map<string, ContactProfile>
const recentContactNames = new Map<string, {
  at: number
  directory: ContactDirectory
  contacts: JsonRecord[]
  identitiesPersisted: boolean
}>()
const recentGroupMetadata = new Map<string, { at: number; subject: string | null; pictureUrl: string | null }>()
const recentGroupMetadataLookups = new Map<string, number>()
const recentGroupDirectory = new Map<string, { at: number; directory: Map<string, GroupMetadata> }>()
const recentWebhookReconciliation = new Map<string, { at: number; result: WebhookReconciliation }>()

type JsonRecord = Record<string, unknown>
type EvolutionConfig = {
  baseUrl: URL
  apiKey: string
  instanceName: string
  businessId: string
  webhookUrl: string
  webhookSecret: string
  connectionStatus: 'pending' | 'active' | null
}

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, readonly upstreamStatus?: number) { super(code) }
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

function isDirectWhatsAppJid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[a-z0-9._:-]{1,128}@(s\.whatsapp\.net|lid)$/i.test(value)
}

function jidNameKeys(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return []
  const normalized = value.trim().toLowerCase()
  const legacyPhoneJid = normalized.match(/^([0-9]{8,15})(?::[0-9]{1,5})?@(c[.]us|whatsapp[.]net)$/)
  if (legacyPhoneJid) return [...new Set([normalized, ...phoneDirectoryKeys(legacyPhoneJid[1])])]
  const lidJid = normalized.match(/^([a-z0-9._-]{1,128})(?::[0-9]{1,5})?@lid$/)
  if (lidJid) return [...new Set([normalized, `${lidJid[1]}@lid`])]
  if (/^[a-z0-9._:-]{1,128}@(s\.whatsapp\.net|lid)$/i.test(normalized)) {
    const phone = phoneFromWhatsAppJid(normalized)
    return phone ? [...new Set([normalized, ...phoneDirectoryKeys(phone)])] : [normalized]
  }
  if (normalized.includes('@')) return []
  return phoneDirectoryKeys(normalized)
}

function canonicalLidJid(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.trim().toLowerCase().match(/^([a-z0-9._-]{1,128})(?::[0-9]{1,5})?@lid$/)
  return match ? `${match[1]}@lid` : null
}

function messageDeliveryStatus(value: unknown): string | null {
  const label = typeof value === 'string' ? text(value, 24)?.toUpperCase() : null
  const numeric = typeof value === 'number' ? value : label && /^\d+$/.test(label) ? Number(label) : null
  if (numeric === 0 || label === 'ERROR' || label === 'FAILED') return 'failed'
  if (numeric === 1 || label === 'PENDING') return 'pending'
  if (numeric === 2 || label === 'SERVER_ACK' || label === 'SENT') return 'sent'
  if (numeric === 3 || label === 'DELIVERY_ACK' || label === 'DELIVERED') return 'delivered'
  if (numeric === 4 || label === 'READ') return 'read'
  if (numeric === 5 || label === 'PLAYED') return 'played'
  if (label === 'DELETED') return 'deleted'
  return null
}

async function applyMessageDeliveryStatus(
  admin: any,
  businessId: string,
  instanceName: string,
  providerMessageId: string,
  deliveryStatus: string,
) {
  const { error } = await admin.rpc('apply_whatsapp_delivery_status_event', {
    p_business_id: businessId,
    p_instance_name: instanceName,
    p_provider_message_id: providerMessageId,
    p_delivery_status: deliveryStatus,
  })
  if (error) throw new RequestError(500, 'message_status_update_failed')
}

function phoneDirectoryKeys(value: string): string[] {
  const digits = digitsOnly(value)
  if (digits.length < 8 || digits.length > 15) return []
  const keys = [`phone:${digits}`]
  if (digits.length === 10 || digits.length === 11) keys.push(`phone:55${digits}`)
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) keys.push(`phone:${digits.slice(2)}`)
  return keys
}

function savedContactPicture(row: JsonRecord): string | null {
  const value = row.profilePicUrl ?? row.profilePictureUrl ?? row.profile_picture_url
    ?? row.pictureUrl ?? row.picture_url ?? row.picture
  return typeof value === 'string' ? text(value, 4096)
    : isRecord(value) ? text(value.url ?? value.profilePicUrl ?? value.pictureUrl, 4096) : null
}

function phoneJidsFromContact(values: unknown[]): string[] {
  return [...new Set(values.flatMap((value) => typeof value === 'string'
    && /@(?:s\.whatsapp\.net|c\.us|whatsapp\.net)$/i.test(value.trim())
    ? [phoneJidFromContactValue(value)].filter((jid): jid is string => Boolean(jid))
    : []))]
}

function phoneJidFromContactValue(value: unknown): string | null {
  const raw = typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  const jid = raw.toLowerCase().match(/^([0-9]{8,15})(?::[0-9]{1,5})?@(?:s\.whatsapp\.net|c\.us|whatsapp\.net)$/)
  if (jid) {
    const digits = jid[1].length === 10 || jid[1].length === 11 ? `55${jid[1]}` : jid[1]
    return `${digits}@s.whatsapp.net`
  }
  if (!/^\+?[0-9\s().-]+$/.test(raw)) return null
  let digits = raw.replace(/\D/g, '')
  if (raw.trim().startsWith('+')) {
    return digits.length >= 8 && digits.length <= 15 ? `${digits}@s.whatsapp.net` : null
  }
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`
  return digits.length >= 12 && digits.length <= 15 ? `${digits}@s.whatsapp.net` : null
}

function sameDirectWhatsAppJid(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left.trim().toLowerCase() === right.trim().toLowerCase()) return true
  const leftPhone = phoneJidFromContactValue(left)
  const rightPhone = phoneJidFromContactValue(right)
  return Boolean(leftPhone && rightPhone && leftPhone === rightPhone)
}

function contactIdentityAnalysis(contacts: JsonRecord[]): { pairs: JsonRecord[]; ambiguousLids: string[] } {
  const candidates = new Map<string, Map<string, string | null>>()
  const ambiguousLids = new Set<string>()
  for (const contact of contacts) {
    if (contact.isGroup === true || contact.is_group === true) continue
    const identifiers = [
      contact.remoteJid, contact.remote_jid, contact.id, contact.wuid, contact.jid,
      contact.contactId, contact.contact_id, contact.remoteJidAlt, contact.remote_jid_alt,
      contact.remoteJidLid, contact.remote_jid_lid, contact.phoneNumberJid, contact.phone_number_jid,
      contact.phoneJid, contact.phone_jid, contact.pnJid, contact.pn_jid, contact.lid,
      contact.lidJid, contact.lid_jid,
    ].filter((value): value is string => typeof value === 'string')
    if (identifiers.some((value) => value.trim().toLowerCase().endsWith('@g.us'))) continue
    const lidJids = [...new Set(identifiers.map(canonicalLidJid)
      .filter((value): value is string => Boolean(value)))]
    const phoneValues = [contact.phoneNumber, contact.phone_number, contact.phone, contact.number, contact.pn]
    const phoneJids = [...new Set([
      ...phoneJidsFromContact(identifiers),
      ...phoneValues.map(phoneJidFromContactValue).filter((value): value is string => Boolean(value)),
    ])]
    if (phoneJids.length !== 1) {
      if (phoneJids.length > 1) for (const lidJid of lidJids) ambiguousLids.add(lidJid)
      continue
    }
    const phoneJid = phoneJids[0]
    const name = savedContactName(contact)
    for (const lidJid of lidJids) {
      const byPhone = candidates.get(lidJid) ?? new Map<string, string | null>()
      byPhone.set(phoneJid, name ?? byPhone.get(phoneJid) ?? null)
      candidates.set(lidJid, byPhone)
      if (byPhone.size > 1) ambiguousLids.add(lidJid)
    }
  }
  const pairs = [...candidates.entries()]
    .filter(([lidJid, phones]) => phones.size === 1 && !ambiguousLids.has(lidJid))
    .map(([lid_jid, phones]) => {
      const [phone_jid, contact_name] = [...phones.entries()][0]
      return { lid_jid, phone_jid, contact_name }
    })
  return { pairs, ambiguousLids: [...ambiguousLids] }
}

async function persistContactIdentityPairs(
  admin: any,
  businessId: string,
  instanceName: string,
  contacts: JsonRecord[],
) {
  const { pairs, ambiguousLids } = contactIdentityAnalysis(contacts)
  if (pairs.length) recentIdentityReconcile.delete(`${businessId}:${instanceName}`)
  const conflictedLids = new Set(ambiguousLids)
  if (pairs.length) {
    const rows = pairs.map((pair) => ({
      business_id: businessId,
      instance_name: instanceName,
      lid_jid: pair.lid_jid,
      phone_jid: pair.phone_jid,
      contact_name: pair.contact_name,
    }))
    const { error } = await admin.from('whatsapp_contact_jid_mappings')
      .upsert(rows, { onConflict: 'business_id,instance_name,lid_jid', ignoreDuplicates: true })
    if (error) throw new RequestError(500, 'contact_identity_sync_failed')
    const { data: stored, error: lookupError } = await admin.from('whatsapp_contact_jid_mappings')
      .select('lid_jid, phone_jid, contact_name')
      .eq('business_id', businessId).eq('instance_name', instanceName)
      .in('lid_jid', pairs.map((pair) => String(pair.lid_jid)))
    if (lookupError) throw new RequestError(500, 'contact_identity_sync_failed')
    const storedByLid = new Map<string, JsonRecord>((stored ?? []).map((row: JsonRecord) => [String(row.lid_jid), row]))
    for (const pair of pairs) {
      if (String(storedByLid.get(String(pair.lid_jid))?.phone_jid ?? '') !== String(pair.phone_jid)) {
        conflictedLids.add(String(pair.lid_jid))
      }
    }
    const namesToWrite = pairs.filter((pair) => {
      const storedRow = storedByLid.get(String(pair.lid_jid))
      const name = displayableContactName(pair.contact_name, null)
      return name && String(storedRow?.phone_jid ?? '') === String(pair.phone_jid)
        && name !== displayableContactName(storedRow?.contact_name, null)
    })
    for (let start = 0; start < namesToWrite.length; start += 25) {
      const nameWrites = await Promise.all(namesToWrite.slice(start, start + 25).map(async (pair) => {
        const { error: nameError } = await admin.from('whatsapp_contact_jid_mappings')
          .update({ contact_name: pair.contact_name, updated_at: new Date().toISOString() })
          .eq('business_id', businessId).eq('instance_name', instanceName)
          .eq('lid_jid', pair.lid_jid).eq('phone_jid', pair.phone_jid)
        return !nameError
      }))
      if (nameWrites.some((saved) => !saved)) throw new RequestError(500, 'contact_identity_name_sync_failed')
    }
  }
  const conflicted = [...conflictedLids]
  for (let start = 0; start < conflicted.length; start += 100) {
    const { error: conflictError } = await admin.from('whatsapp_contact_jid_mappings')
      .update({ identity_conflict: true, updated_at: new Date().toISOString() })
      .eq('business_id', businessId).eq('instance_name', instanceName)
      .in('lid_jid', conflicted.slice(start, start + 100))
    if (conflictError) throw new RequestError(500, 'contact_identity_sync_failed')
  }
}

async function verifiedProviderAlternateJid(
  admin: any,
  businessId: string,
  instanceName: string,
  primaryJid: string,
  alternateJid: string | null,
): Promise<string | null> {
  if (!alternateJid) return null
  const { pairs } = contactIdentityAnalysis([{ remoteJid: primaryJid, remoteJidAlt: alternateJid }])
  const pair = pairs[0]
  if (!pair) return alternateJid
  await persistContactIdentityPairs(admin, businessId, instanceName, [{ remoteJid: primaryJid, remoteJidAlt: alternateJid }])
  const { data, error } = await admin.from('whatsapp_contact_jid_mappings')
    .select('phone_jid, identity_conflict')
    .eq('business_id', businessId).eq('instance_name', instanceName).eq('lid_jid', pair.lid_jid)
    .maybeSingle()
  if (error) throw new RequestError(500, 'contact_identity_lookup_failed')
  return data?.identity_conflict === false && data.phone_jid === pair.phone_jid ? alternateJid : null
}

async function mappedContactPhoneJid(admin: any, businessId: string, instanceName: string, lidJid: string): Promise<string | null> {
  const canonicalLid = canonicalLidJid(lidJid)
  if (!canonicalLid) return null
  const { data, error } = await admin.from('whatsapp_contact_jid_mappings')
    .select('phone_jid')
    .eq('business_id', businessId).eq('instance_name', instanceName)
    .eq('lid_jid', canonicalLid).eq('identity_conflict', false)
    .maybeSingle()
  if (error) throw new RequestError(500, 'contact_identity_lookup_failed')
  const phoneJid = text(data?.phone_jid, 256)
  return phoneJid && /^[0-9]{8,15}@s\.whatsapp\.net$/i.test(phoneJid) ? phoneJid.toLowerCase() : null
}

async function isConflictedContactLid(admin: any, businessId: string, instanceName: string, jid: string): Promise<boolean> {
  const canonicalLid = canonicalLidJid(jid)
  if (!canonicalLid) return false
  const { data, error } = await admin.from('whatsapp_contact_jid_mappings')
    .select('identity_conflict')
    .eq('business_id', businessId).eq('instance_name', instanceName).eq('lid_jid', canonicalLid)
    .maybeSingle()
  if (error) throw new RequestError(500, 'contact_identity_lookup_failed')
  return data?.identity_conflict === true
}

function contactDirectoryIndex(contacts: JsonRecord[]): ContactDirectory {
  const names = new Map<string, ContactProfile>()
  for (const contact of contacts) {
    if (contact.isGroup === true || contact.is_group === true) continue
    const name = savedContactName(contact)
    const pictureUrl = savedContactPicture(contact)
    const phone = phoneFromWhatsAppJid(phoneJidFromContactValue(contact.contact_phone ?? contact.phone ?? contact.phoneNumber
      ?? contact.phone_number ?? contact.number ?? contact.pn) ?? '')
      ?? phoneFromWhatsAppJid(text(contact.remoteJidAlt ?? contact.remote_jid_alt ?? contact.remoteJidLid
        ?? contact.remote_jid_lid ?? contact.phoneNumberJid ?? contact.phone_number_jid, 256) ?? '')
      ?? phoneFromWhatsAppJid(text(contact.remoteJid ?? contact.remote_jid ?? contact.id ?? contact.wuid ?? contact.jid, 256) ?? '')
    if (!name && !pictureUrl && !phone) continue
    const identifiers = [
      contact.remoteJid, contact.remote_jid, contact.id, contact.wuid, contact.jid,
      contact.contactId, contact.contact_id, contact.remoteJidAlt, contact.remote_jid_alt,
      contact.remoteJidLid, contact.remote_jid_lid, contact.phoneNumberJid, contact.phone_number_jid,
      contact.phoneJid, contact.phone_jid, contact.pnJid, contact.pn_jid, contact.lid,
      contact.lidJid, contact.lid_jid,
    ]
    for (const identifier of identifiers) {
      for (const key of jidNameKeys(identifier)) {
        const current = names.get(key)
        names.set(key, {
          name: name ?? current?.name ?? null,
          pictureUrl: pictureUrl ?? current?.pictureUrl ?? null,
          phone: phone ?? current?.phone ?? null,
        })
      }
    }
    for (const phone of [contact.phoneNumber, contact.phone_number, contact.phone, contact.number, contact.pn]) {
      const normalizedPhone = typeof phone === 'number' && Number.isSafeInteger(phone) && phone > 0
        ? String(phone)
        : typeof phone === 'string' ? phone : null
      if (!normalizedPhone) continue
      for (const key of phoneDirectoryKeys(normalizedPhone)) {
        const current = names.get(key)
        names.set(key, {
          name: name ?? current?.name ?? null,
          pictureUrl: pictureUrl ?? current?.pictureUrl ?? null,
          phone: normalizedPhone ?? current?.phone ?? null,
        })
      }
    }
  }
  return names
}

function mergeContactDirectories(...directories: ContactDirectory[]): ContactDirectory {
  const merged: ContactDirectory = new Map()
  for (const directory of directories) {
    for (const [key, profile] of directory) {
      const current = merged.get(key)
      merged.set(key, {
        name: current?.name ?? profile.name,
        pictureUrl: current?.pictureUrl ?? profile.pictureUrl,
        phone: current?.phone ?? profile.phone,
      })
    }
  }
  return merged
}

function mergeProviderContactRows(contacts: JsonRecord[]): JsonRecord[] {
  const merged = new Map<string, JsonRecord>()
  for (const [index, contact] of contacts.entries()) {
    const jid = text(contact.remoteJid ?? contact.remote_jid ?? contact.id ?? contact.wuid ?? contact.jid, 256)
    const key = jid?.toLowerCase() ?? `row:${index}`
    const current = merged.get(key)
    if (!current) {
      merged.set(key, contact)
      continue
    }
    const combined = { ...current }
    for (const [field, value] of Object.entries(contact)) {
      // Provider pages and cached records can repeat the same JID. Keep prior
      // known values when a later event is partial, but let every fresh,
      // non-empty value replace stale cached metadata.
      if (value !== null && value !== undefined && value !== '') combined[field] = value
    }
    merged.set(key, combined)
  }
  return [...merged.values()]
}

function directoryRowsFromProvider(contacts: JsonRecord[], businessId: string, instanceName: string): JsonRecord[] {
  const writes = new Map<string, JsonRecord>()
  for (const contact of contacts) {
    const identifiers = [
      contact.remoteJid, contact.remote_jid, contact.groupJid, contact.group_jid, contact.id,
      contact.wuid, contact.jid, contact.contactId, contact.contact_id,
      contact.remoteJidAlt, contact.remote_jid_alt, contact.remoteJidLid, contact.remote_jid_lid,
      contact.phoneNumberJid, contact.phone_number_jid, contact.phoneJid, contact.phone_jid,
      contact.pnJid, contact.pn_jid, contact.lid, contact.lidJid, contact.lid_jid,
      contact.phoneNumber, contact.phone_number, contact.phone, contact.number, contact.pn,
    ]
    const directJids = [...new Set(identifiers.flatMap((value) => {
      if (typeof value === 'string' && (isDirectWhatsAppJid(value) || isGroupJid(value))) return [value.trim().toLowerCase()]
      const phoneJid = phoneJidFromContactValue(value)
      return phoneJid ? [phoneJid] : []
    }))]
    const isGroup = contact.isGroup === true || contact.is_group === true || directJids.some(isGroupJid)
    if (!directJids.length) continue
    const phoneJid = directJids.find((jid) => jid.endsWith('@s.whatsapp.net')) ?? null
    const lidJid = directJids.find((jid) => jid.endsWith('@lid')) ?? null
    const name = isGroup ? groupMetadataFromEvolution(contact).subject : savedContactName(contact)
    const phone = !isGroup && phoneJid ? phoneFromWhatsAppJid(phoneJid) : null
    for (const remoteJid of directJids) {
      if (!name && !phone) continue
      const key = `${businessId}:${instanceName}:${remoteJid}`
      const current = writes.get(key)
      writes.set(key, {
        ...(current ?? {}),
        business_id: businessId,
        instance_name: instanceName,
        remote_jid: remoteJid,
        remote_jid_alt: (remoteJid === lidJid ? phoneJid : remoteJid === phoneJid ? lidJid : null)
          ?? current?.remote_jid_alt ?? null,
        contact_name: isGroup ? null : name ?? current?.contact_name ?? null,
        contact_phone: isGroup ? null : phone ?? current?.contact_phone ?? null,
        group_subject: isGroup ? name ?? current?.group_subject ?? null : current?.group_subject ?? null,
      })
    }
  }
  return [...writes.values()]
}

async function persistContactDirectoryRows(admin: any, rows: JsonRecord[], businessId: string, instanceName: string): Promise<number> {
  for (let start = 0; start < rows.length; start += 100) {
    const batch = rows.slice(start, start + 100)
    const { data: existing, error: lookupError } = await admin.from('whatsapp_contact_directory')
      .select('remote_jid, remote_jid_alt, contact_name, contact_phone, group_subject')
      .eq('business_id', businessId).eq('instance_name', instanceName)
      .in('remote_jid', batch.map((row) => String(row.remote_jid)))
    if (lookupError) throw new RequestError(500, 'contact_directory_lookup_failed')
    const existingByJid = new Map<string, JsonRecord>((existing ?? []).map((row: JsonRecord) => [String(row.remote_jid), row]))
    const merged = batch.map((row) => {
      const old = existingByJid.get(String(row.remote_jid))
      return {
        ...row,
        remote_jid_alt: row.remote_jid_alt ?? old?.remote_jid_alt ?? null,
        contact_name: row.contact_name ?? old?.contact_name ?? null,
        contact_phone: row.contact_phone ?? old?.contact_phone ?? null,
        group_subject: row.group_subject ?? old?.group_subject ?? null,
        updated_at: new Date().toISOString(),
      }
    })
    const { error } = await admin.from('whatsapp_contact_directory')
      .upsert(merged, { onConflict: 'business_id,instance_name,remote_jid' })
    if (error) throw new RequestError(500, 'contact_directory_save_failed')
  }
  return rows.length
}

async function loadPersistedContactDirectory(admin: any, businessId: string, instanceName: string): Promise<ContactDirectory> {
  const records: JsonRecord[] = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin.from('whatsapp_contact_directory')
      .select('remote_jid, remote_jid_alt, contact_name, contact_phone')
      .eq('business_id', businessId).eq('instance_name', instanceName)
      .order('remote_jid', { ascending: true }).range(offset, offset + 999)
    if (error) throw new RequestError(500, 'contact_directory_lookup_failed')
    records.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return contactDirectoryIndex(records.map((row) => ({
    ...row,
    name: row.contact_name,
    contact_phone: row.contact_phone,
  })))
}

function savedNameForJids(names: ContactDirectory, ...values: unknown[]): string | null {
  for (const value of values) {
    for (const key of jidNameKeys(value)) {
      const name = names.get(key)?.name
      if (name) return name
    }
  }
  return null
}

function savedPictureForJids(names: ContactDirectory, ...values: unknown[]): string | null {
  for (const value of values) {
    for (const key of jidNameKeys(value)) {
      const pictureUrl = names.get(key)?.pictureUrl
      if (pictureUrl) return pictureUrl
    }
  }
  return null
}

function savedPhoneForJids(names: ContactDirectory, ...values: unknown[]): string | null {
  for (const value of values) {
    for (const key of jidNameKeys(value)) {
      const phone = names.get(key)?.phone
      if (phone) return phone
    }
  }
  return null
}

async function loadSavedContactDirectory(
  config: EvolutionConfig,
  firstPageRecords?: JsonRecord[],
  firstPageResponse?: unknown,
  admin?: any,
  businessId?: string,
): Promise<ContactDirectory> {
  const cacheKey = `${config.businessId}:${config.instanceName}`
  const cached = recentContactNames.get(cacheKey)
  const freshContacts = firstPageRecords?.length ? firstPageRecords : []
  const cacheFresh = Boolean(cached && Date.now() - cached.at < CONTACT_NAMES_COOLDOWN_MS)
  let providerFetchedFresh = freshContacts.length > 0
    || (firstPageRecords !== undefined && firstPageResponse !== undefined && firstPageResponse !== null)
  let freshProviderContacts: JsonRecord[] = [...freshContacts]
  try {
    let allContacts: JsonRecord[] = cacheFresh && cached ? cached.contacts : []
    if (freshContacts.length) allContacts = [...allContacts, ...freshContacts]
    if (!cacheFresh || freshContacts.length || !cached) {
      let result: unknown = firstPageResponse ?? null
      let firstPage = firstPageRecords?.slice(0, CONTACT_DIRECTORY_PAGE_SIZE) ?? []
      if (!firstPageRecords) {
        result = await evolutionRequest(config, `/chat/findContacts/${encodeURIComponent(config.instanceName)}`, {
          method: 'POST',
          body: JSON.stringify({ where: {}, page: 1, offset: CONTACT_DIRECTORY_PAGE_SIZE, take: CONTACT_DIRECTORY_PAGE_SIZE, skip: 0 }),
          signal: AbortSignal.timeout(5_000),
        })
        firstPage = recordsFromEvolution(result, ['contacts', 'records', 'data']).slice(0, CONTACT_DIRECTORY_PAGE_SIZE)
        providerFetchedFresh = true
      }
      const contactPageInfo = isRecord(result) && isRecord(result.contacts)
        ? result.contacts
        : isRecord(result) && isRecord(result.data) && isRecord(result.data.contacts)
          ? result.data.contacts
          : isRecord(result) ? result : {}
      const advertisedPages = Number(contactPageInfo.pages ?? contactPageInfo.totalPages)
      const pageLimit = Number.isFinite(advertisedPages) && advertisedPages > 0
        ? Math.min(CONTACT_NAME_MAX_PAGES, Math.floor(advertisedPages))
        : firstPage.length >= CONTACT_DIRECTORY_PAGE_SIZE ? CONTACT_NAME_MAX_PAGES : 1
      const contactPages = [firstPage]
      for (let startPage = 2; startPage <= pageLimit; startPage += 8) {
        const pageNumbers = Array.from({ length: Math.min(8, pageLimit - startPage + 1) }, (_, index) => startPage + index)
        const pages = await Promise.all(pageNumbers.map(async (page) => {
          try {
            const pageResult = await evolutionRequest(config, `/chat/findContacts/${encodeURIComponent(config.instanceName)}`, {
              method: 'POST',
              body: JSON.stringify({
                where: {}, page, offset: CONTACT_DIRECTORY_PAGE_SIZE,
                take: CONTACT_DIRECTORY_PAGE_SIZE, skip: (page - 1) * CONTACT_DIRECTORY_PAGE_SIZE,
              }),
              signal: AbortSignal.timeout(5_000),
            })
            return recordsFromEvolution(pageResult, ['contacts', 'records', 'data']).slice(0, CONTACT_DIRECTORY_PAGE_SIZE)
          } catch {
            return []
          }
        }))
        contactPages.push(...pages)
        if (pages.every((page) => page.length === 0)) break
      }
      freshProviderContacts = contactPages.flat()
      allContacts = mergeProviderContactRows([...allContacts, ...freshProviderContacts])
    }
    if (admin && businessId && providerFetchedFresh && freshProviderContacts.length) {
      await persistContactIdentityPairs(admin, businessId, config.instanceName, freshProviderContacts)
      await persistContactDirectoryRows(admin,
        directoryRowsFromProvider(freshProviderContacts, businessId, config.instanceName), businessId, config.instanceName)
      console.info('Evolution contact directory sync', {
        provider_rows: freshProviderContacts.length,
        named_rows: freshProviderContacts.filter((row) => Boolean(savedContactName(row))).length,
        phone_rows: freshProviderContacts.filter((row) => Boolean(
          phoneJidFromContactValue(row.contact_phone ?? row.phone ?? row.phoneNumber ?? row.phone_number ?? row.number ?? row.pn)
          ?? phoneJidFromContactValue(row.remoteJid ?? row.remote_jid ?? row.id ?? row.wuid ?? row.jid),
        )).length,
        lid_rows: freshProviderContacts.filter((row) => [row.remoteJid, row.remote_jid, row.id, row.wuid, row.jid]
          .some((value) => typeof value === 'string' && value.toLowerCase().endsWith('@lid'))).length,
      })
    }
    const providerDirectory = contactDirectoryIndex(allContacts)
    const persistedDirectory = admin && businessId
      ? await loadPersistedContactDirectory(admin, businessId, config.instanceName)
      : new Map<string, ContactProfile>()
    const cachedDirectory = cached?.directory ?? new Map()
    // The persisted instance directory includes current webhook changes and
    // provider rows just written above, so it must beat process-local cache.
    const directory = mergeContactDirectories(persistedDirectory, providerDirectory, cachedDirectory)
    recentContactNames.set(cacheKey, {
      at: providerFetchedFresh ? Date.now() : cached?.at ?? Date.now(),
      directory, contacts: allContacts, identitiesPersisted: Boolean(admin && businessId),
    })
    return directory
  } catch (error) {
    if (error instanceof RequestError && error.code === 'contact_identity_sync_failed') throw error
    return new Map()
  }
}

async function loadSavedContactNames(config: EvolutionConfig, admin?: any, businessId?: string): Promise<ContactDirectory> {
  return loadSavedContactDirectory(config, undefined, undefined, admin, businessId)
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
  const rawConnectionStatus = text(source.evolution_connection_status, 16)
  const connectionStatus = rawConnectionStatus === 'pending' || rawConnectionStatus === 'active'
    ? rawConnectionStatus : null
  if (!baseUrlValue || !apiKey || !isUuid(businessId) || !webhookUrl || !webhookSecret) return null
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
    return { baseUrl, apiKey, instanceName, businessId, webhookUrl, webhookSecret, connectionStatus }
  } catch {
    return null
  }
}

async function loadConfiguration(
  admin: { rpc: (name: string, args?: JsonRecord) => PromiseLike<{ data: unknown; error: unknown }> },
  businessId: string,
): Promise<EvolutionConfig | null> {
  try {
    const { data, error } = await admin.rpc('get_evolution_runtime_config', { p_business_id: businessId })
    if (error || !isRecord(data)) return null
    return parseConfiguration({
      ...data,
      evolution_api_url: Deno.env.get('EVOLUTION_API_URL') || data.evolution_api_url,
      evolution_api_key: Deno.env.get('EVOLUTION_API_KEY') || data.evolution_api_key,
      evolution_webhook_url: Deno.env.get('EVOLUTION_WEBHOOK_URL') || data.evolution_webhook_url,
      evolution_webhook_secret: Deno.env.get('EVOLUTION_WEBHOOK_SECRET') || data.evolution_webhook_secret,
      // The active instance is selected by the database registry, never by a
      // fixed deployment environment variable.
      evolution_instance_name: data.evolution_instance_name,
      evolution_business_id: data.evolution_business_id ?? businessId,
    })
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
    redirect: 'error',
    signal: init?.signal ?? AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new RequestError(response.status === 401 || response.status === 403 ? 502 : 503, 'evolution_request_failed', response.status)
  }
  if (response.status === 204) return null
  const raw = await readBoundedEvolutionResponse(response, maximumResponseBytes)
  if (!raw) return null
  try { return JSON.parse(raw) as unknown } catch { return raw }
}

async function setEvolutionWebhook(config: EvolutionConfig): Promise<{ accepted: boolean; verified: boolean }> {
  if (!config.webhookUrl || !config.webhookSecret) throw new RequestError(503, 'webhook_not_configured')
  const webhookToken = await instanceWebhookToken(config.webhookSecret, config.instanceName)
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
  const webhookPath = `/webhook/find/${encodeURIComponent(config.instanceName)}`
  const current = await evolutionRequest(config, webhookPath, { method: 'GET', signal: AbortSignal.timeout(5_000) }).catch(() => null)
  if (webhookSettingsState(current, config.webhookUrl, webhookToken, EVOLUTION_WEBHOOK_EVENTS) === 'match') {
    return { accepted: true, verified: true }
  }

  const send = async (events: string[]) => evolutionRequest(config, `/webhook/set/${encodeURIComponent(config.instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({ webhook: {
      enabled: true,
      url: config.webhookUrl,
      headers: { Authorization: `Bearer ${webhookToken}` },
      events,
      byEvents: false,
      base64: false,
    } }),
  })
  try {
    await send(EVOLUTION_WEBHOOK_EVENTS)
  } catch (error) {
    const status = error instanceof RequestError ? error.upstreamStatus : undefined
    if (status !== 400 && status !== 422) throw error
    // Older Evolution builds reject GROUPS_UPDATE although their webhook
    // stream still uses GROUP_UPDATE/GROUPS_UPSERT. Retry the compatible set.
    await send(EVOLUTION_WEBHOOK_EVENTS.filter((event) => event !== 'GROUPS_UPDATE'))
  }
  const updated = await evolutionRequest(config, webhookPath, { method: 'GET', signal: AbortSignal.timeout(5_000) }).catch(() => null)
  const updatedState = webhookSettingsState(updated, config.webhookUrl, webhookToken, EVOLUTION_WEBHOOK_EVENTS)
  if (updatedState === 'mismatch') {
    throw new RequestError(503, 'webhook_verification_failed')
  }
  // Some Evolution versions accept /webhook/set but do not expose /webhook/find
  // or redact headers from its response. A successful POST is enough to let
  // pairing continue; report verification separately instead of blocking it.
  return { accepted: true, verified: updatedState === 'match' }
}

type WebhookReconciliation = { ready: boolean; repaired: boolean; verified: boolean }

function webhookSettingsState(
  value: unknown,
  expectedUrl: string,
  expectedToken: string,
  expectedEvents: string[],
): 'match' | 'mismatch' | 'unverified' | 'unknown' {
  const queue: JsonRecord[] = isRecord(value) ? [value] : Array.isArray(value) ? value.filter(isRecord) : []
  const visited = new Set<JsonRecord>()
  let differentUrlFound = false
  while (queue.length && visited.size < 32) {
    const row = queue.shift()!
    if (visited.has(row)) continue
    visited.add(row)
    const url = text(row.url ?? row.webhookUrl ?? row.webhook_url, 2048)
    if (url && url !== expectedUrl) differentUrlFound = true
    if (url === expectedUrl) {
      const enabledValue = row.enabled
      const enabled = enabledValue === true || enabledValue === 'true' || enabledValue === 1
      if (enabledValue !== undefined && !enabled) return 'mismatch'
      const rawEventsValue = row.events ?? row.webhookEvents ?? row.webhook_events
      const rawEvents = Array.isArray(rawEventsValue) ? rawEventsValue : []
      const events = new Set(rawEvents.map((event) => String(event).replace(/[.\-\s]/g, '_').toUpperCase()))
      const required = expectedEvents.filter((event) => event !== 'GROUPS_UPDATE')
      const hasGroupUpdates = events.has('GROUP_UPDATE') || events.has('GROUPS_UPDATE')
      const requiredPresent = required.every((event) => event === 'GROUP_UPDATE' || events.has(event))
      const groupVariantsPresent = hasGroupUpdates && events.has('GROUPS_UPSERT')
      if (Array.isArray(rawEventsValue) && (!requiredPresent || !groupVariantsPresent)) return 'mismatch'
      const headers = isRecord(row.headers) ? row.headers : isRecord(row.header) ? row.header : {}
      const authorization = text(headers.Authorization ?? headers.authorization, 4096)
      if (authorization && authorization.replace(/^Bearer\s+/i, '') !== expectedToken) return 'mismatch'
      if (enabled && Array.isArray(rawEventsValue) && requiredPresent && groupVariantsPresent) {
        // The documented Evolution /webhook/find response omits headers on
        // some builds. URL/events can still be confirmed; auth remains
        // unverified instead of forcing a POST on every inbox refresh.
        return authorization ? 'match' : 'unverified'
      }
      return 'unknown'
    }
    for (const key of ['webhook', 'data', 'result', 'webhookConfig', 'webhook_config', 'webhookByEvents']) {
      const nested = row[key]
      if (isRecord(nested)) queue.push(nested)
      else if (Array.isArray(nested)) queue.push(...nested.filter(isRecord))
    }
  }
  return differentUrlFound ? 'mismatch' : 'unknown'
}

async function reconcileEvolutionWebhook(config: EvolutionConfig, force = false): Promise<WebhookReconciliation> {
  const cacheKey = `${config.businessId}:${config.instanceName}`
  const cached = recentWebhookReconciliation.get(cacheKey)
  if (!force && cached && Date.now() - cached.at < 30_000) return cached.result
  try {
    const before = await evolutionRequest(config, `/webhook/find/${encodeURIComponent(config.instanceName)}`, {
      method: 'GET', signal: AbortSignal.timeout(5_000),
    }).catch(() => null)
    const webhookToken = await instanceWebhookToken(config.webhookSecret, config.instanceName)
    const beforeState = webhookSettingsState(before, config.webhookUrl, webhookToken, EVOLUTION_WEBHOOK_EVENTS)
    const setup = beforeState === 'match' || beforeState === 'unverified'
      ? { accepted: true, verified: beforeState === 'match' }
      : await setEvolutionWebhook(config)
    const result = {
      ready: setup.accepted,
      repaired: beforeState !== 'match' && beforeState !== 'unverified' && setup.accepted,
      verified: setup.verified,
    }
    recentWebhookReconciliation.set(cacheKey, { at: Date.now(), result })
    if (result.repaired) console.info('Evolution webhook reconfigured for active instance.', { repaired: true, verified: result.verified })
    return result
  } catch (error) {
    logWebhookSetupFailure('configure_webhook', error)
    const result = { ready: false, repaired: false, verified: false }
    recentWebhookReconciliation.set(cacheKey, { at: Date.now(), result })
    return result
  }
}

function logWebhookSetupFailure(stage: 'configure_webhook' | 'connect', error: unknown): void {
  const requestError = error instanceof RequestError ? error : null
  console.error('Evolution webhook setup failed', {
    stage,
    code: requestError?.code ?? 'unexpected_error',
    ...(requestError?.upstreamStatus !== undefined ? { upstream_status: requestError.upstreamStatus } : {}),
  })
}

async function instanceWebhookToken(masterSecret: string, instanceName: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(masterSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`shalom/evolution-webhook/v1:${instanceName}`),
  )
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function syncLegacyChats(admin: any, config: EvolutionConfig, businessId: string, providerPage: number): Promise<JsonRecord> {
  const cacheKey = `${businessId}:${config.instanceName}:${providerPage}`
  const cached = recentLegacySync.get(cacheKey)
  if (cached && Date.now() - cached.at < LEGACY_SYNC_COOLDOWN_MS) {
    await reconcileKnownContactIdentities(admin, businessId, config.instanceName)
    return { ...cached.result, status: 'recently_synced' }
  }

  let chatRecords: JsonRecord[]
  let contactRecords: JsonRecord[] = []
  let contactResponse: unknown = null
  let chatPages = 0
  try {
    const [chatResult, contactsResult] = await Promise.all([
      evolutionRequest(config, `/chat/findChats/${encodeURIComponent(config.instanceName)}`, {
        method: 'POST', body: JSON.stringify({
          where: {}, page: providerPage, offset: LEGACY_CHAT_PAGE_SIZE,
          // Baileys versions that expose raw take/skip still get a hard page cap.
          take: LEGACY_CHAT_PAGE_SIZE, skip: (providerPage - 1) * LEGACY_CHAT_PAGE_SIZE,
        }),
      }),
      evolutionRequest(config, `/chat/findContacts/${encodeURIComponent(config.instanceName)}`, {
        method: 'POST', body: JSON.stringify({
          where: {}, page: 1, offset: CONTACT_DIRECTORY_PAGE_SIZE,
          take: CONTACT_DIRECTORY_PAGE_SIZE, skip: 0,
        }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => null),
    ])
    contactResponse = contactsResult
    chatRecords = recordsFromEvolution(chatResult, ['chats', 'records', 'data']).slice(0, LEGACY_CHAT_PAGE_SIZE)
    contactRecords = recordsFromEvolution(contactsResult, ['contacts', 'records', 'data']).slice(0, CONTACT_DIRECTORY_PAGE_SIZE)
    const chatPageInfo = isRecord(chatResult) && isRecord(chatResult.chats) ? chatResult.chats : isRecord(chatResult) ? chatResult : {}
    chatPages = Number(chatPageInfo.pages ?? chatPageInfo.totalPages) || 0
  } catch {
    return {
      status: 'unavailable', synced_conversations: 0, imported_messages: 0,
      has_more: false, provider_page: providerPage,
      notice: 'Não foi possível consultar conversas antigas na Evolution. As conversas já sincronizadas continuam disponíveis.',
    }
  }

  const contactDirectory = await loadSavedContactDirectory(
    config,
    contactResponse ? contactRecords : undefined,
    contactResponse ?? undefined,
    admin,
    businessId,
  )
  const namesByJid = contactDirectory
  const groupDirectory = await loadGroupDirectory(config, admin, businessId)

  const groupMetadataByJid = new Map<string, GroupMetadata>()
  const unresolvedGroups = chatRecords.filter((chat) => {
    const jid = text(chat.remoteJid ?? chat.jid ?? chat.id, 256)
    return Boolean(jid && isGroupJid(jid) && !evolutionName(chat, true))
  })
  for (let index = 0; index < unresolvedGroups.length; index += 8) {
    const batch = unresolvedGroups.slice(index, index + 8)
    const metadata = await Promise.all(batch.map(async (chat) => {
      const jid = text(chat.remoteJid ?? chat.jid ?? chat.id, 256)!
      return [jid, await loadGroupMetadata(config, jid, 'subject', admin, businessId)] as const
    }))
    for (const [jid, value] of metadata) groupMetadataByJid.set(jid, value)
  }

  let syncedConversations = 0
  let importedMessages = 0
  for (const chat of chatRecords) {
    const jid = text(chat.remoteJid ?? chat.jid ?? chat.id, 256)
    if (!jid) continue
    const group = isGroupJid(jid)
    const lastMessage = providerMessagePayload(chat.lastMessage ?? chat.last_message)
    let rawJidAlt = text(chat.remoteJidAlt ?? chat.remoteJidLid ?? chat.phoneNumberJid, 256)
    // Evolution v2.3.7 stores the LID ↔ phone pair on the last message key,
    // even when /findChats omits it from the chat record itself.
    if (!group && !rawJidAlt && lastMessage) {
      const messageJid = text(lastMessage.remote_jid, 256)
      const messageJidAlt = text(lastMessage.remote_jid_alt, 256)
      if (sameDirectWhatsAppJid(messageJid, jid)) rawJidAlt = messageJidAlt
      else if (sameDirectWhatsAppJid(messageJidAlt, jid)) rawJidAlt = messageJid
    }
    if (!rawJidAlt && jid.toLowerCase().endsWith('@lid')) {
      rawJidAlt = await mappedContactPhoneJid(admin, businessId, config.instanceName, jid)
    }
    let jidAlt = group ? null : await verifiedProviderAlternateJid(admin, businessId, config.instanceName, jid, rawJidAlt)
    const identityLids = [jid, rawJidAlt].filter((value): value is string => Boolean(value && value.toLowerCase().endsWith('@lid')))
    let identityLinked = true
    for (const lidJid of identityLids) {
      if (await isConflictedContactLid(admin, businessId, config.instanceName, lidJid)) identityLinked = false
    }
    if (!identityLinked) jidAlt = null
    const directoryName = group ? null : savedNameForJids(namesByJid, jid, jidAlt)
    const savedName = group
      ? groupMetadataFromEvolution(chat).subject ?? groupMetadataByJid.get(jid)?.subject ?? groupDirectory.get(jid.toLowerCase())?.subject ?? null
      : directoryName ?? evolutionName(chat, false)
        ?? (lastMessage?.direction === 'incoming' ? text(lastMessage.contact_name, 160) : null)
    const name = savedName
    const directoryPhone = group ? null : displayPhone(savedPhoneForJids(namesByJid, jid, jidAlt))
    const phone = group ? null : identityLinked
      ? phoneFromWhatsAppJid(jidAlt ?? '') ?? phoneFromWhatsAppJid(jid) ?? directoryPhone
      : phoneFromWhatsAppJid(jid) ?? directoryPhone
    const activity = providerTimestamp(chat.lastMessageRecvTimestamp ?? chat.conversationTimestamp ?? chat.updatedAt)
    const hasReportedUnreadCount = (typeof chat.unreadCount === 'number' && Number.isInteger(chat.unreadCount))
      || (typeof chat.unreadMessages === 'number' && Number.isInteger(chat.unreadMessages))
    const unread = typeof chat.unreadCount === 'number' && Number.isInteger(chat.unreadCount) ? Math.max(0, chat.unreadCount)
      : typeof chat.unreadMessages === 'number' && Number.isInteger(chat.unreadMessages) ? Math.max(0, chat.unreadMessages) : 0
    const existing = await findConversationByJidOrAlias(admin, businessId, config.instanceName, jid, jidAlt)
    let conversationId = typeof existing?.id === 'string' ? existing.id : null
    let aliasJidAlt: string | null = null
    if (conversationId) {
      const update: JsonRecord = {}
      if (group) {
        update.contact_name = null
        if (savedName) update.group_subject = savedName
      } else if (directoryName || (savedName && !displayableContactName(existing.contact_name, phone))) {
        update.contact_name = directoryName ?? savedName
      }
      if (group) update.contact_phone = null
      else if (phone) update.contact_phone = phone
      const resolvedAltJid = group || !identityLinked ? null : await safeAlternateJid(
        admin, businessId, config.instanceName, conversationId, existing.remote_jid,
        jidAlt, jid, text(existing.remote_jid_alt, 256),
      )
      aliasJidAlt = resolvedAltJid
      update.remote_jid_alt = resolvedAltJid
      if (!existing.last_activity_at || activity > String(existing.last_activity_at)) update.last_activity_at = activity
      if (hasReportedUnreadCount) update.unread_count = unread
      if (Object.keys(update).length) {
        const { error } = await admin.from('whatsapp_conversations').update(update)
          .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('id', conversationId)
        if (error) throw new RequestError(500, 'history_sync_failed')
      }
      if (hasReportedUnreadCount && unread === 0) {
        const { error } = await admin.from('whatsapp_messages').update({ count_as_unread: false })
          .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('conversation_id', conversationId)
          .eq('direction', 'incoming').eq('count_as_unread', true)
        if (error) throw new RequestError(500, 'history_sync_failed')
      }
    } else {
      const safeAltJid = group || !identityLinked ? null : await safeAlternateJid(admin, businessId, config.instanceName, null, jid, jidAlt)
      aliasJidAlt = safeAltJid
      const { data, error } = await admin.from('whatsapp_conversations').upsert({
        business_id: businessId,
        instance_name: config.instanceName,
        remote_jid: jid,
        remote_jid_alt: safeAltJid,
        contact_name: group ? null : name,
        group_subject: group ? savedName : null,
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
    if (!group) await registerConversationJidAliases(admin, businessId, config.instanceName, conversationId, jid, identityLinked ? aliasJidAlt : null)
    syncedConversations += 1

    if (!group && phone) await resolvePhoneMatchForInbox(admin, businessId, phone, conversationId)

    if (group) {
      const { error } = await admin.from('whatsapp_conversation_contexts').delete()
        .eq('business_id', businessId).eq('conversation_id', conversationId).eq('match_method', 'phone')
      if (error) throw new RequestError(500, 'history_sync_failed')
    }

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
      if (typeof lastMessage.delivery_status === 'string') {
        await applyMessageDeliveryStatus(admin, businessId, config.instanceName, String(lastMessage.id), lastMessage.delivery_status)
      }
      importedMessages += 1
    }
  }
  await reconcileKnownContactIdentities(admin, businessId, config.instanceName)

  const result = {
    status: chatRecords.length === 0 && providerPage === 1 ? 'empty' : 'available',
    synced_conversations: syncedConversations,
    imported_messages: importedMessages,
    directory_contacts_seen: contactRecords.length,
    directory_contacts_named: contactRecords.filter((row) => Boolean(savedContactName(row))).length,
    directory_groups_seen: groupDirectory.size,
    conversations_missing_contact_name: chatRecords.filter((chat) => {
      const jid = text(chat.remoteJid ?? chat.jid ?? chat.id, 256)
      return Boolean(jid && !isGroupJid(jid) && !savedContactName(chat) && !savedNameForJids(namesByJid, jid))
    }).length,
    conversations_missing_group_subject: chatRecords.filter((chat) => {
      const jid = text(chat.remoteJid ?? chat.jid ?? chat.id, 256)
      return Boolean(jid && isGroupJid(jid)
        && !evolutionName(chat, true) && !groupMetadataByJid.get(jid)?.subject && !groupDirectory.get(jid.toLowerCase())?.subject)
    }).length,
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

function conversationResponse(
  row: JsonRecord,
  lastMessage: JsonRecord | null,
  savedContactNames?: ContactDirectory,
  groupDirectory?: Map<string, GroupMetadata>,
) {
  const remoteJid = text(row.remote_jid, 256)
  const remoteJidAlt = text(row.remote_jid_alt, 256)
  const isGroup = isGroupJid(remoteJid)
  const groupMetadata = remoteJid ? groupDirectory?.get(remoteJid.toLowerCase()) : null
  const canReply = Boolean(remoteJid && !remoteJid.startsWith('unknown-call:')
    && (!remoteJid.includes('@lid') || (remoteJidAlt && phoneFromWhatsAppJid(remoteJidAlt))))
  const phone = isGroup ? null : displayPhone(row.contact_phone)
    ?? displayPhone(savedPhoneForJids(savedContactNames ?? new Map(), remoteJid, remoteJidAlt))
    ?? phoneFromWhatsAppJid(remoteJidAlt ?? '')
    ?? phoneFromWhatsAppJid(remoteJid ?? '')
  const fallbackName = stableConversationLabel(row, isGroup)
  const savedName = isGroup ? null : savedNameForJids(savedContactNames ?? new Map(), remoteJid, remoteJidAlt)
  const name = isGroup
    ? displayableContactName(row.display_name_override, null)
      ?? displayableContactName(groupMetadata?.subject, null)
      ?? displayableContactName(row.group_subject, null)
      ?? fallbackName
    : displayableContactName(row.display_name_override, phone)
      ?? displayableContactName(savedName, phone)
      ?? displayableContactName(row.contact_name, phone)
      ?? (phone ? null : fallbackName)
  return {
    id: row.id,
    inbox_id: row.instance_name,
    is_group: isGroup,
    status: row.status,
    can_reply: canReply,
    unread_count: Number(row.unread_count) || 0,
    contact: {
      name,
      phone,
    },
    display_name_override: text(row.display_name_override, 160),
    contact_classification: contactClassification(row.contact_classification),
    hidden_from_inbox: row.hidden_from_inbox === true,
    last_activity_at: row.last_activity_at,
    last_message: lastMessage ? normalizedMessage(lastMessage, savedContactNames) : null,
    messages: [],
  }
}

function stableConversationLabel(row: JsonRecord, isGroup: boolean): string {
  const stableId = text(row.id, 64)?.replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase()
  return `${isGroup ? 'Grupo' : 'Contato'} #${stableId || 'ID'}`
}

function digitsOnly(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '')
}

function phoneFromWhatsAppJid(value: string): string | null {
  if (value.toLowerCase().includes('@lid') || isGroupJid(value)) return null
  const digits = value.split('@', 1)[0].split(':', 1)[0].replace(/\D/g, '')
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`
  return null
}

function normalizePairingPhone(value: unknown): string | null {
  const candidate = text(value, 40)
  if (!candidate || !/^\+?[\d\s().-]+$/.test(candidate)) return null
  const digits = candidate.replace(/\D/g, '')
  if (digits.length < 8 || digits.length > 15) return null
  if (!candidate.trim().startsWith('+') && (digits.length === 10 || digits.length === 11)) return `55${digits}`
  return digits
}

async function evolutionConnectionState(config: EvolutionConfig): Promise<string | null> {
  const result = await evolutionRequest(config, `/instance/connectionState/${encodeURIComponent(config.instanceName)}`)
  const instance = isRecord(result) && isRecord(result.instance) ? result.instance : isRecord(result) ? result : {}
  return text(instance.state ?? instance.connectionStatus ?? instance.connection_state ?? instance.status, 64)?.toLowerCase() ?? null
}

async function waitForEvolutionConnectionState(config: EvolutionConfig, wanted: 'close' | 'open'): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = await evolutionConnectionState(config)
    if (state === wanted || (wanted === 'close' && state === 'closed')) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

function displayPhone(value: unknown): string | null {
  const candidate = text(value, 64)
  if (!candidate || !/^[+\d\s().-]+$/.test(candidate)) return null
  return phoneFromWhatsAppJid(candidate)
}

function displayableContactName(value: unknown, phone: string | null): string | null {
  const name = text(value, 160)
  if (!name || /@(lid|g\.us|s\.whatsapp\.net|c\.us|broadcast|newsletter)\b/i.test(name)) return null
  if (/^(?:contato|grupo) (?:sem nome|sem identificação|sem identificacao)$/i.test(name)) return null
  const phoneDigits = phone?.replace(/\D/g, '') ?? ''
  const nameDigits = name.replace(/\D/g, '')
  const phoneLike = /^[+\d\s().-]+$/.test(name) && nameDigits.length >= 8 && nameDigits.length <= 15
  if (phoneLike || (phoneDigits.length >= 8 && nameDigits === phoneDigits)) return null
  return name
}

function contactClassification(value: unknown): 'unclassified' | 'customer' | 'personal' {
  return value === 'customer' || value === 'personal' ? value : 'unclassified'
}

function normalizedMessage(row: JsonRecord, savedContactNames?: ContactDirectory) {
  const kind = text(row.message_kind, 32) ?? 'unknown'
  const mediaMetadata = isRecord(row.media_metadata) ? row.media_metadata : {}
  const fileSize = typeof mediaMetadata.file_size === 'number' ? mediaMetadata.file_size : null
  const mimeType = text(mediaMetadata.mime_type, 160)
  const savedSenderName = savedContactNames
    ? savedNameForJids(savedContactNames, mediaMetadata.participant_jid, mediaMetadata.participant_alt_jid)
    : null
  const fileType = kind === 'image' ? 'image' : kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : kind === 'document' || kind === 'sticker' ? 'file' : null
  return {
    id: row.id,
    content: row.deleted_at ? null : row.content ?? null,
    created_at: row.provider_timestamp,
    message_type: row.direction === 'incoming' ? 'incoming' : row.direction === 'outgoing' ? 'outgoing' : 'activity',
    status: row.delivery_status ?? null,
    private: false,
    sender: {
      name: row.direction === 'incoming' ? savedSenderName ?? text(mediaMetadata.sender_name, 160) : null,
      phone: row.direction === 'incoming'
        ? phoneFromWhatsAppJid(text(mediaMetadata.participant_alt_jid, 256) ?? '')
          ?? phoneFromWhatsAppJid(text(mediaMetadata.participant_jid, 256) ?? '')
        : null,
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

function attachMessageReactions(messages: JsonRecord[], reactionRows: JsonRecord[], savedContactNames?: ContactDirectory): JsonRecord[] {
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
    const normalized = normalizedMessage(row, savedContactNames)
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

function groupRecordsFromEvolution(value: unknown): JsonRecord[] {
  const rows = recordsFromEvolution(value, ['groups', 'records', 'data', 'result'])
  if (rows.length) return rows

  const queue: JsonRecord[] = isRecord(value) ? [value] : []
  const visited = new Set<JsonRecord>()
  const groups: JsonRecord[] = []
  while (queue.length && visited.size < 24) {
    const row = queue.shift()!
    if (visited.has(row)) continue
    visited.add(row)
    const jid = text(row.id ?? row.groupJid ?? row.group_jid ?? row.remoteJid ?? row.remote_jid ?? row.jid, 256)
    if (jid && isGroupJid(jid)) {
      groups.push(row)
      continue
    }
    for (const [key, nested] of Object.entries(row)) {
      if (isGroupJid(key) && isRecord(nested)) {
        groups.push({ ...nested, id: nested.id ?? key })
      } else if (['groups', 'records', 'data', 'result', 'items'].includes(key.toLowerCase())) {
        if (isRecord(nested)) queue.push(nested)
        else if (Array.isArray(nested)) queue.push(...nested.filter(isRecord))
      }
    }
  }
  return groups
}

function evolutionName(row: JsonRecord, group: boolean): string | null {
  if (group) return groupMetadataFromEvolution(row).subject
  const candidates = group
    ? []
    : [row.name, row.contactName, row.shortName, row.short_name, row.displayName, row.display_name,
      row.notify, row.notifyName, row.pushName, row.pushname, row.verifiedName]
  for (const candidate of candidates) {
    const value = displayableContactName(candidate, null)
    if (value) return value
  }
  return null
}

function savedContactName(row: JsonRecord): string | null {
  // Prefer the local address-book label, then provider aliases and profile name.
  // Evolution/Baileys versions expose these fields with different names.
  const candidates = [row.name, row.contactName, row.shortName, row.short_name, row.displayName,
    row.display_name, row.notify, row.notifyName, row.pushName, row.pushname, row.verifiedName]
  for (const candidate of candidates) {
    const value = displayableContactName(candidate, null)
    if (value) return value
  }
  return null
}

type GroupMetadata = { subject: string | null; pictureUrl: string | null }

function groupMetadataFromEvolution(value: unknown): GroupMetadata {
  const queue: JsonRecord[] = Array.isArray(value) ? value.filter(isRecord) : isRecord(value) ? [value] : []
  const visited = new Set<JsonRecord>()
  let subject: string | null = null
  let pictureUrl: string | null = null
  const nestedKeys = ['data', 'group', 'groupInfo', 'groupMetadata', 'metadata', 'result', 'attrs']
  while (queue.length && visited.size < 24) {
    const row = queue.shift()!
    if (visited.has(row)) continue
    visited.add(row)
    subject ??= displayableContactName(row.subject ?? row.groupSubject ?? row.group_subject
      ?? row.groupName ?? row.group_name, null)
    const pictureValue = row.pictureUrl ?? row.profilePictureUrl ?? row.profilePicUrl
      ?? row.profile_picture_url ?? row.picture_url ?? row.picture
    pictureUrl ??= typeof pictureValue === 'string' ? text(pictureValue, 4096)
      : isRecord(pictureValue) ? text(pictureValue.url ?? pictureValue.pictureUrl, 4096) : null
    for (const key of nestedKeys) {
      if (isRecord(row[key])) queue.push(row[key] as JsonRecord)
      else if (Array.isArray(row[key])) queue.push(...(row[key] as unknown[]).filter(isRecord))
    }
  }
  return { subject, pictureUrl }
}

async function loadGroupDirectory(config: EvolutionConfig, admin?: any, businessId?: string): Promise<Map<string, GroupMetadata>> {
  const cacheKey = `${config.businessId}:${config.instanceName}`
  const cached = recentGroupDirectory.get(cacheKey)
  const cacheFresh = Boolean(cached && Date.now() - cached.at < 5 * 60_000)
  let providerFetchedFresh = false
  let directory = cacheFresh && cached
    ? new Map(cached.directory)
    : new Map<string, GroupMetadata>()
  if (!cacheFresh) {
    try {
      const response = await evolutionRequest(config,
        `/group/fetchAllGroups/${encodeURIComponent(config.instanceName)}?getParticipants=false`,
        { method: 'GET', signal: AbortSignal.timeout(8_000) })
      const groups = groupRecordsFromEvolution(response)
      providerFetchedFresh = true
      for (const group of groups) {
        const jid = text(group.id ?? group.groupJid ?? group.group_jid ?? group.remoteJid
          ?? group.remote_jid ?? group.jid, 256)
        if (!jid || !isGroupJid(jid)) continue
        directory.set(jid.toLowerCase(), groupMetadataFromEvolution(group))
      }
      const directoryRows = directoryRowsFromProvider(groups, businessId ?? config.businessId, config.instanceName)
      if (admin && businessId && groups.length) {
        await persistContactDirectoryRows(admin, directoryRows, businessId, config.instanceName)
      }
      console.info('Evolution group directory sync', {
        response_kind: Array.isArray(response) ? 'array' : isRecord(response) ? 'object' : typeof response,
        top_level_fields: isRecord(response) ? Object.keys(response).filter((key) => /^[a-zA-Z_]{1,32}$/.test(key)).slice(0, 16) : [],
        provider_rows: groups.length,
        rows_with_group_jid: groups.filter((group) => [group.id, group.groupJid, group.group_jid, group.remoteJid, group.remote_jid, group.jid]
          .some((value) => typeof value === 'string' && isGroupJid(value))).length,
        rows_with_subject: groups.filter((group) => Boolean(evolutionName(group, true))).length,
        directory_rows: directoryRows.length,
      })
    } catch (error) {
      console.warn('Evolution group directory sync failed', {
        reason: error instanceof RequestError ? error.code : 'provider_request_failed',
        ...(error instanceof RequestError && error.upstreamStatus !== undefined ? { upstream_status: error.upstreamStatus } : {}),
      })
      // Persisted webhook subjects still provide a useful fallback.
    }
  }
  if (admin && businessId) {
    const { data, error } = await admin.from('whatsapp_contact_directory')
      .select('remote_jid, group_subject')
      .eq('business_id', businessId).eq('instance_name', config.instanceName)
      .not('group_subject', 'is', null)
    if (error) throw new RequestError(500, 'group_directory_lookup_failed')
    for (const row of data ?? []) {
      const jid = text(row.remote_jid, 256)
      const subject = displayableContactName(row.group_subject, null)
      if (!jid || !isGroupJid(jid) || !subject) continue
      const current = directory.get(jid.toLowerCase())
      directory.set(jid.toLowerCase(), {
        subject: providerFetchedFresh ? current?.subject ?? subject : subject ?? current?.subject ?? null,
        pictureUrl: current?.pictureUrl ?? null,
      })
    }
  }
  recentGroupDirectory.set(cacheKey, {
    at: providerFetchedFresh || !cacheFresh ? Date.now() : cached?.at ?? Date.now(),
    directory,
  })
  return directory
}

async function loadGroupMetadata(
  config: EvolutionConfig,
  remoteJid: string,
  required: 'subject' | 'picture' = 'subject',
  admin?: any,
  businessId?: string,
): Promise<GroupMetadata> {
  const cacheKey = `${config.businessId}:${config.instanceName}:${remoteJid.toLowerCase()}`
  const cached = recentGroupMetadata.get(cacheKey)
  const cacheIsFresh = Boolean(cached && Date.now() - cached.at < 5 * 60_000)
  const fromDirectory = (await loadGroupDirectory(config, admin, businessId)).get(remoteJid.toLowerCase())
  const current: GroupMetadata = {
    subject: fromDirectory?.subject ?? (cacheIsFresh ? cached?.subject : null) ?? null,
    pictureUrl: fromDirectory?.pictureUrl ?? (cacheIsFresh ? cached?.pictureUrl : null) ?? null,
  }
  const hasRequiredMetadata = required === 'subject' ? current.subject : current.pictureUrl
  if (hasRequiredMetadata) return current

  const lookupKey = `${cacheKey}:${required}`
  const lastAttempt = recentGroupMetadataLookups.get(lookupKey) ?? 0
  if (Date.now() - lastAttempt < 5 * 60_000) return current
  recentGroupMetadataLookups.set(lookupKey, Date.now())

  try {
    const response = await evolutionRequest(config,
      `/group/findGroupInfoByJid/${encodeURIComponent(config.instanceName)}?groupJid=${encodeURIComponent(remoteJid)}`,
      { method: 'GET', signal: AbortSignal.timeout(4_000) })
    const fetched = groupMetadataFromEvolution(response)
    console.info('Evolution group metadata lookup', {
      subject_available: Boolean(fetched.subject),
      picture_available: Boolean(fetched.pictureUrl),
      response_kind: Array.isArray(response) ? 'array' : isRecord(response) ? 'object' : typeof response,
      top_level_fields: isRecord(response) ? Object.keys(response).filter((key) => /^[a-zA-Z_]{1,32}$/.test(key)).slice(0, 16) : [],
    })
    const metadata = {
      subject: fetched.subject ?? current.subject,
      pictureUrl: fetched.pictureUrl ?? current.pictureUrl,
    }
    recentGroupMetadata.set(cacheKey, { at: Date.now(), ...metadata })
    if (admin && businessId && metadata.subject) {
      await persistContactDirectoryRows(admin, [{
        business_id: businessId,
        instance_name: config.instanceName,
        remote_jid: remoteJid.toLowerCase(),
        remote_jid_alt: null,
        contact_name: null,
        contact_phone: null,
        group_subject: metadata.subject,
      }], businessId, config.instanceName)
    }
    return metadata
  } catch (error) {
    console.warn('Evolution group metadata lookup failed', {
      reason: error instanceof RequestError ? error.code : 'provider_request_failed',
      ...(error instanceof RequestError && error.upstreamStatus !== undefined ? { upstream_status: error.upstreamStatus } : {}),
    })
    // A missing group subject/photo must not prevent the inbox from loading.
    recentGroupMetadata.set(cacheKey, { at: Date.now(), ...current })
    return current
  }
}

function groupMetadataWasRecentlyChecked(config: EvolutionConfig, remoteJid: string, required: 'subject' | 'picture' = 'subject'): boolean {
  const lookupKey = `${config.businessId}:${config.instanceName}:${remoteJid.toLowerCase()}:${required}`
  const lastAttempt = recentGroupMetadataLookups.get(lookupKey) ?? 0
  return Date.now() - lastAttempt < 5 * 60_000
}

async function reconcileKnownContactIdentities(admin: any, businessId: string, instanceName: string): Promise<number> {
  const cacheKey = `${businessId}:${instanceName}`
  const cached = recentIdentityReconcile.get(cacheKey)
  if (cached && Date.now() - cached.at < CONTACT_IDENTITY_RECONCILE_COOLDOWN_MS) return cached.merged

  const mappings: JsonRecord[] = []
  const mappingPageSize = 500
  for (let offset = 0; ; offset += mappingPageSize) {
    const { data, error } = await admin.from('whatsapp_contact_jid_mappings')
      .select('lid_jid, phone_jid')
      .eq('business_id', businessId).eq('instance_name', instanceName)
      .eq('identity_conflict', false)
      .order('lid_jid', { ascending: true })
      .range(offset, offset + mappingPageSize - 1)
    if (error) throw new RequestError(500, 'contact_identity_lookup_failed')
    mappings.push(...(data ?? []))
    if (!data || data.length < mappingPageSize) break
  }
  if (!mappings?.length) {
    recentIdentityReconcile.set(cacheKey, { at: Date.now(), merged: 0 })
    return 0
  }

  const identityJids = [...new Set(mappings.flatMap((row: JsonRecord) => [
    String(row.lid_jid).toLowerCase(), String(row.phone_jid).toLowerCase(),
  ]))]
  const conversationByJid = new Map<string, string>()
  for (let start = 0; start < identityJids.length; start += 50) {
    const batch = identityJids.slice(start, start + 50)
    const { data: aliases, error } = await admin.from('whatsapp_conversation_jid_aliases')
      .select('remote_jid, conversation_id')
      .eq('business_id', businessId).eq('instance_name', instanceName)
      .in('remote_jid', batch)
    if (error) throw new RequestError(500, 'contact_identity_lookup_failed')
    for (const alias of aliases ?? []) conversationByJid.set(String(alias.remote_jid), String(alias.conversation_id))
  }

  let merged = 0
  for (const mapping of mappings as JsonRecord[]) {
    const lidJid = String(mapping.lid_jid).toLowerCase()
    const phoneJid = String(mapping.phone_jid).toLowerCase()
    const sourceId = conversationByJid.get(lidJid)
    const targetId = conversationByJid.get(phoneJid)
    if (sourceId && targetId && sourceId !== targetId) {
      const { data, error } = await admin.rpc('merge_whatsapp_conversations_by_identity', {
        p_business_id: businessId,
        p_instance_name: instanceName,
        p_lid_jid: lidJid,
        p_phone_jid: phoneJid,
      })
      if (error) {
        const code = typeof error.code === 'string' ? error.code : ''
        if (code !== '22023' && code !== '23505') {
          console.error(`WhatsApp identity merge failed. code=${/^[0-9A-Z]{5}$/.test(code) ? code : 'unknown'}`)
          throw new RequestError(500, 'contact_identity_merge_failed')
        }
        // These SQLSTATEs mean the two histories have an explicit integrity
        // conflict (for example, duplicate provider IDs or manual links). Keep
        // both conversations intact, but surface unexpected failures for retry.
        console.warn(`WhatsApp identity merge skipped due to integrity conflict. code=${code}`)
      } else if (data) {
        conversationByJid.set(lidJid, String(data))
        conversationByJid.set(phoneJid, String(data))
        merged += 1
      }
    }
  }
  for (let start = 0; start < mappings.length; start += mappingPageSize) {
    const { error: callPhoneError } = await admin.rpc('backfill_whatsapp_call_identity_phones', {
      p_business_id: businessId,
      p_instance_name: instanceName,
      p_identities: mappings.slice(start, start + mappingPageSize),
    })
    if (callPhoneError) throw new RequestError(500, 'contact_identity_call_update_failed')
  }
  recentIdentityReconcile.set(cacheKey, { at: Date.now(), merged })
  return merged
}

async function findConversationByJidOrAlias(
  admin: any,
  businessId: string,
  instanceName: string,
  remoteJid: string,
  remoteJidAlt: string | null,
) {
  const selection = () => admin.from('whatsapp_conversations')
    .select('id, remote_jid, remote_jid_alt, contact_phone, contact_name, group_subject, last_activity_at')
    .eq('business_id', businessId).eq('instance_name', instanceName)
  const { data: exact, error: exactError } = await selection().eq('remote_jid', remoteJid).maybeSingle()
  if (exactError) throw new RequestError(500, 'history_sync_failed')
  if (exact?.id || isGroupJid(remoteJid)) return exact

  const candidateAliases = [...new Set([remoteJid, remoteJidAlt].filter(isDirectWhatsAppJid).map((value) => value.toLowerCase()))]
  const lidAliases = candidateAliases.filter((value) => value.endsWith('@lid'))
  const conflictedAliases = new Set<string>()
  if (lidAliases.length) {
    const { data: mappings, error } = await admin.from('whatsapp_contact_jid_mappings')
      .select('lid_jid')
      .eq('business_id', businessId).eq('instance_name', instanceName)
      .eq('identity_conflict', true).in('lid_jid', lidAliases)
    if (error) throw new RequestError(500, 'history_sync_failed')
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
  if (aliasError) throw new RequestError(500, 'history_sync_failed')
  const primaryAlias = (aliasRows ?? []).find((row: JsonRecord) => row.remote_jid === primaryJid)
  if (primaryAlias) {
    const { data, error } = await selection().eq('id', String(primaryAlias.conversation_id)).maybeSingle()
    if (error) throw new RequestError(500, 'history_sync_failed')
    if (data) return data
  }
  if (primaryJid) {
    const { data: primaryAlternateRows, error } = await selection().eq('remote_jid_alt', primaryJid).limit(2)
    if (error) throw new RequestError(500, 'history_sync_failed')
    if ((primaryAlternateRows ?? []).length === 1) return primaryAlternateRows[0]
    if ((primaryAlternateRows ?? []).length > 1) throw new RequestError(409, 'conversation_identity_ambiguous')
  }
  const prioritizedAlias = (aliasRows ?? []).length === 1 ? aliasRows[0] : null
  if (prioritizedAlias) {
    const { data, error } = await selection().eq('id', String(prioritizedAlias.conversation_id)).maybeSingle()
    if (error) throw new RequestError(500, 'history_sync_failed')
    if (data) return data
  }
  const aliasedConversationIds = [...new Set((aliasRows ?? []).map((row: JsonRecord) => String(row.conversation_id)))]
  const candidates = aliases.join(',')
  const { data, error } = await selection()
    .or(`remote_jid.in.(${candidates}),remote_jid_alt.in.(${candidates})`)
    .limit(4)
  if (error) throw new RequestError(500, 'history_sync_failed')
  const primaryMatches = (data ?? []).filter((row: JsonRecord) =>
    String(row.remote_jid).toLowerCase() === primaryJid
      || String(row.remote_jid_alt ?? '').toLowerCase() === primaryJid)
  if (primaryMatches.length === 1) return primaryMatches[0]
  if (primaryMatches.length > 1 || aliasedConversationIds.length > 1 || (data ?? []).length > 1) {
    throw new RequestError(409, 'conversation_identity_ambiguous')
  }
  return data?.[0] ?? null
}

async function safeAlternateJid(
  admin: any,
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
    if (aliasError) throw new RequestError(500, 'history_sync_failed')
    if (alias && alias.conversation_id !== conversationId) continue
    const { data: rows, error } = await admin.from('whatsapp_conversations')
      .select('id')
      .eq('business_id', businessId).eq('instance_name', instanceName)
      .or(`remote_jid.eq.${normalized},remote_jid_alt.eq.${normalized}`)
      .limit(2)
    if (error) throw new RequestError(500, 'history_sync_failed')
    if ((rows ?? []).some((row: JsonRecord) => row.id !== conversationId)) continue
    return candidate
  }
  return null
}

async function registerConversationJidAliases(
  admin: any,
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
  if (error?.code === 'P0001') throw new RequestError(409, 'conversation_identity_ambiguous')
  if (error) throw new RequestError(500, 'history_sync_failed')
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
  metadata.provider_remote_jid = remoteJid
  const providerRemoteJidAlt = text(key.remoteJidAlt, 256)
  if (providerRemoteJidAlt) metadata.provider_remote_jid_alt = providerRemoteJidAlt
  const senderName = displayableContactName(record.pushName, null)
  const fromMe = key.fromMe === true
  const participant = text(key.participant ?? key.participantAlt, 256)
  const participantAlt = text(key.participantAlt, 256)
  if (group && senderName) metadata.sender_name = senderName
  if (participant) metadata.participant_jid = participant
  if (participantAlt) metadata.participant_alt_jid = participantAlt
  if (kind === 'reaction' && isRecord(contentObject.key)) {
    const reactionTarget = text(contentObject.key.id, 256)
    if (reactionTarget) metadata.reaction_to_message_id = reactionTarget
  }
  return {
    id: messageId,
    remote_jid: remoteJid,
    remote_jid_alt: text(key.remoteJidAlt, 256),
    // Prefer directory names in the inbox; keep an incoming profile name as fallback.
    contact_name: !group && !fromMe ? senderName : null,
    contact_phone: group ? null : phoneFromWhatsAppJid(text(key.remoteJidAlt, 256) ?? remoteJid),
    direction: fromMe ? 'outgoing' : 'incoming',
    message_kind: kind,
    content,
    delivery_status: messageDeliveryStatus(record.status ?? key.status)
      ?? (fromMe ? 'sent' : null),
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

async function readBoundedImage(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROFILE_PICTURE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new RequestError(413, 'profile_picture_too_large')
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_PROFILE_PICTURE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new RequestError(413, 'profile_picture_too_large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function profilePictureResponse(config: EvolutionConfig, conversation: JsonRecord, admin?: any, businessId?: string) {
  const remoteJid = text(conversation.remote_jid, 256)
  if (!remoteJid) throw new RequestError(404, 'profile_picture_unavailable')
  const isGroup = isGroupJid(remoteJid)
  let pictureUrl: string | null = null
  if (isGroup) {
    const metadata = await loadGroupMetadata(config, remoteJid, 'picture', admin, businessId)
    pictureUrl = metadata.pictureUrl
  } else {
    const contactDirectory = await loadSavedContactNames(config, admin, businessId)
    pictureUrl = savedPictureForJids(
      contactDirectory,
      remoteJid,
      conversation.remote_jid_alt,
      conversation.contact_phone,
    )
    if (pictureUrl) {
      try { return await profilePictureImageResponse(pictureUrl) } catch {
        // Directory URLs can expire; use Evolution's live lookup when a phone JID is available.
      }
    }
    const jid = text(conversation.remote_jid_alt, 256) && /@s\.whatsapp\.net$/i.test(String(conversation.remote_jid_alt))
      ? String(conversation.remote_jid_alt)
      : remoteJid
    const number = digitsOnly(
      text(conversation.contact_phone, 64)
        ?? (/@s\.whatsapp\.net$/i.test(jid) ? jid.split('@', 1)[0].split(':', 1)[0] : ''),
    )
    if (number.length < 7 || number.length > 20) throw new RequestError(404, 'profile_picture_unavailable')
    const result = await evolutionRequest(config, `/chat/fetchProfilePictureUrl/${encodeURIComponent(config.instanceName)}`, {
      method: 'POST',
      body: JSON.stringify({ number }),
    })
    pictureUrl = groupMetadataFromEvolution(result).pictureUrl
  }
  if (!pictureUrl) throw new RequestError(404, 'profile_picture_unavailable')
  return profilePictureImageResponse(pictureUrl)
}

async function profilePictureImageResponse(pictureUrl: string): Promise<Response> {
  let imageUrl: URL
  try { imageUrl = new URL(pictureUrl) } catch { throw new RequestError(502, 'profile_picture_unavailable') }
  const allowedHost = imageUrl.hostname.toLowerCase().endsWith('.whatsapp.net')
    || imageUrl.hostname.toLowerCase().endsWith('.fbcdn.net')
  if (imageUrl.protocol !== 'https:' || !allowedHost || imageUrl.username || imageUrl.password || imageUrl.port) {
    throw new RequestError(502, 'profile_picture_unavailable')
  }

  let imageResponse: Response
  try {
    imageResponse = await fetch(imageUrl, {
      headers: { Accept: 'image/jpeg,image/png,image/webp' },
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    })
  } catch {
    throw new RequestError(404, 'profile_picture_unavailable')
  }
  if (!imageResponse.ok) {
    await imageResponse.body?.cancel().catch(() => undefined)
    throw new RequestError(404, 'profile_picture_unavailable')
  }
  const sourceMimeType = imageResponse.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() ?? ''
  if (!/^image\/(?:jpeg|png|webp|gif)$/i.test(sourceMimeType)) {
    await imageResponse.body?.cancel().catch(() => undefined)
    throw new RequestError(415, 'profile_picture_unsupported')
  }
  const bytes = await readBoundedImage(imageResponse)
  if (!bytes.length) throw new RequestError(404, 'profile_picture_unavailable')
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Response(copy.buffer, {
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Expose-Headers': 'X-Original-Content-Type',
      'Cache-Control': 'private, max-age=300',
      'Content-Type': 'application/octet-stream',
      'X-Original-Content-Type': sourceMimeType,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

async function mediaResponse(admin: any, config: EvolutionConfig, businessId: string, conversationId: string, messageId: string) {
  const { data: message, error: messageError } = await admin.from('whatsapp_messages')
    .select('id, instance_name, provider_message_id, direction, message_kind, media_metadata, deleted_at')
    .eq('business_id', businessId)
    .eq('instance_name', config.instanceName)
    .eq('conversation_id', conversationId)
    .eq('id', messageId)
    .maybeSingle()
  if (messageError) throw new RequestError(500, 'media_lookup_failed')
  if (!message || !['image', 'audio', 'video', 'document', 'sticker'].includes(message.message_kind) || message.deleted_at) {
    throw new RequestError(404, 'media_not_found')
  }
  const { data: conversation, error: conversationLookupError } = await admin.from('whatsapp_conversations')
    .select('remote_jid, remote_jid_alt')
    .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('id', conversationId).maybeSingle()
  if (conversationLookupError) throw new RequestError(500, 'media_lookup_failed')
  if (!conversation) throw new RequestError(404, 'media_not_found')
  const metadata = isRecord(message.media_metadata) ? message.media_metadata : {}
  const participant = text(metadata.participant_jid, 256)
  const participantAlt = text(metadata.participant_alt_jid, 256)
  const preferredRemoteJid = text(metadata.provider_remote_jid, 256)
  const remoteJidCandidates = [...new Set([preferredRemoteJid, conversation.remote_jid, conversation.remote_jid_alt]
    .filter((value): value is string => typeof value === 'string' && value.length > 0))].slice(0, 2)
  const alternateJidCandidates = [...new Set([text(metadata.provider_remote_jid_alt, 256), conversation.remote_jid_alt, conversation.remote_jid]
    .filter((value): value is string => typeof value === 'string' && value.length > 0))]
  let mediaPayload: JsonRecord | null = null
  let mediaRequestError: unknown = null
  for (const remoteJid of remoteJidCandidates) {
    const key: JsonRecord = { id: message.provider_message_id, remoteJid, fromMe: message.direction === 'outgoing' }
    const remoteJidAlt = alternateJidCandidates.find((candidate) => candidate !== remoteJid)
    if (remoteJidAlt) key.remoteJidAlt = remoteJidAlt
    if (participant) key.participant = participant
    if (participantAlt) key.participantAlt = participantAlt
    try {
      const result = await evolutionRequest(config, `/chat/getBase64FromMediaMessage/${encodeURIComponent(config.instanceName)}`, {
        method: 'POST',
        body: JSON.stringify({ message: { key }, convertToMp4: message.message_kind === 'video' }),
        signal: AbortSignal.timeout(30_000),
      }, 36 * 1024 * 1024)
      const resultRecord = isRecord(result) ? result : {}
      const payload = isRecord(resultRecord.data) ? resultRecord.data : resultRecord
      if (text(payload.base64, MAX_MEDIA_BYTES * 2)) {
        mediaPayload = payload
        break
      }
      mediaRequestError = new RequestError(502, 'media_unavailable')
    } catch (error) {
      if (!(error instanceof RequestError) || error.code !== 'evolution_request_failed'
        || ![400, 404, 422].includes(error.upstreamStatus ?? 0)) throw error
      mediaRequestError = error
    }
  }
  if (!mediaPayload) throw mediaRequestError ?? new RequestError(502, 'media_unavailable')
  const payload = mediaPayload
  const base64 = text(payload.base64, MAX_MEDIA_BYTES * 2)
  if (!base64) throw new RequestError(502, 'media_unavailable')
  const bytes = base64Bytes(base64)
  if (!bytes.length || bytes.byteLength > MAX_MEDIA_BYTES) throw new RequestError(413, 'media_too_large')
  const sourceMimeType = text(payload.mimetype ?? payload.mimeType ?? metadata.mime_type, 160) ?? 'application/octet-stream'
  const mimeType = sourceMimeType.split(';', 1)[0].trim().toLowerCase()
  const disposition = ['image', 'audio', 'video', 'sticker'].includes(message.message_kind) ? 'inline' : 'attachment'
  const safeMimeType = /^(?:image\/(?:jpeg|png|webp|gif)|audio\/(?:ogg|mpeg|mp4|wav|webm|aac|3gpp)|video\/(?:mp4|webm|3gpp)|application\/pdf)$/i.test(mimeType)
    ? mimeType
    : 'application/octet-stream'
  const responseBytes = new Uint8Array(bytes.byteLength)
  responseBytes.set(bytes)
  return new Response(responseBytes.buffer, {
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Original-Content-Type',
      // supabase-js only returns Blob for octet-stream/pdf; the real media type
      // is carried separately and restored by the authenticated web client.
      'Content-Type': 'application/octet-stream',
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

async function olderMessagesResponse(admin: any, config: EvolutionConfig, businessId: string, conversation: JsonRecord, beforeMessageId: string, savedContactNames?: ContactDirectory) {
  const { data: cursor, error: cursorError } = await admin.from('whatsapp_messages')
    .select('provider_message_id, provider_timestamp, instance_name')
    .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('conversation_id', conversation.id).eq('id', beforeMessageId).maybeSingle()
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
      .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('conversation_id', conversation.id).in('provider_message_id', providerIds)
      .order('provider_timestamp', { ascending: true })
    if (importedError) throw new RequestError(500, 'history_import_failed')
    const { data: reactions, error: reactionError } = await admin.from('whatsapp_messages')
      .select('direction, content, media_metadata, provider_timestamp, id')
      .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('conversation_id', conversation.id).eq('message_kind', 'reaction')
      .order('provider_timestamp', { ascending: false }).order('id', { ascending: false }).limit(500)
    if (reactionError) throw new RequestError(500, 'history_import_failed')
    return json({ messages: attachMessageReactions(imported ?? [], reactions ?? [], savedContactNames), meta: { has_more: providerHasMore, history_available: true } })
  }

  // Keep previously imported pages navigable if the provider has since pruned
  // or disabled its own message database.
  const { data: localRows, error: localError } = await admin.from('whatsapp_messages')
    .select('id, provider_message_id, direction, message_kind, content, delivery_status, media_metadata, provider_timestamp, deleted_at')
    .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('conversation_id', conversation.id)
    .lt('provider_timestamp', cursorTime)
    .order('provider_timestamp', { ascending: false }).limit(OLDER_MESSAGE_PAGE_SIZE + 1)
  if (localError) throw new RequestError(500, 'message_history_failed')
  const { data: reactionRows, error: reactionError } = await admin.from('whatsapp_messages')
    .select('direction, content, media_metadata, provider_timestamp, id')
    .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('conversation_id', conversation.id).eq('message_kind', 'reaction')
    .order('provider_timestamp', { ascending: false }).order('id', { ascending: false }).limit(500)
  if (reactionError) throw new RequestError(500, 'message_history_failed')
  const hasMore = providerHasMore || (localRows?.length ?? 0) > OLDER_MESSAGE_PAGE_SIZE
  const older = (localRows ?? []).slice(0, OLDER_MESSAGE_PAGE_SIZE).reverse()
  if (older.length === 0 && !providerAvailable) throw new RequestError(503, 'history_unavailable')
  return json({ messages: attachMessageReactions(older, reactionRows ?? [], savedContactNames), meta: {
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
    if (!['status', 'list', 'calls', 'conversation', 'message_statuses', 'older_messages', 'react', 'mark_read', 'send', 'send_media', 'set_status', 'update_contact_preferences', 'attachment', 'avatar', 'configure_webhook', 'connect', 'disconnect'].includes(action ?? '')) {
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
      if (!membership || !['owner', 'manager', 'staff'].includes(membership.role)) return json({ error: 'forbidden' }, 403)
      const canManageBusiness = membership.role === 'owner' || membership.role === 'manager'

      const admin = context.supabaseAdmin
      let config = await loadConfiguration(admin, businessId)
      if (config?.businessId && config.businessId !== businessId) return json({ error: 'forbidden' }, 403)
      if (action === 'status') {
        const statusConfig = config
        if (!statusConfig) return json({ configured: false, connected: false, connection_selected: false, connection_status: null, connection_state: 'not_configured' })
        if (!statusConfig.instanceName) return json({ configured: true, connected: false, connection_selected: false, connection_status: null, instance_exists: false, connection_state: 'not_created' })
        try {
          const instances = await evolutionRequest(statusConfig, '/instance/fetchInstances')
          const instanceExists = Array.isArray(instances) && instances.some((entry) => evolutionInstanceName(entry) === statusConfig.instanceName)
          if (!instanceExists) return json({ configured: true, connected: false, connection_selected: true, connection_status: statusConfig.connectionStatus, instance_exists: false, connection_state: 'not_created' })
          const result = await evolutionRequest(statusConfig, `/instance/connectionState/${encodeURIComponent(statusConfig.instanceName)}`)
          const stateRecord = isRecord(result) && isRecord(result.instance) ? result.instance : isRecord(result) ? result : {}
          const providerState = text(stateRecord.state ?? stateRecord.connectionStatus ?? stateRecord.connection_state ?? stateRecord.status, 64)?.trim() ?? ''
          const normalizedState = providerState.toLowerCase()
          const connected = normalizedState === 'open' || normalizedState === 'connected' || (!normalizedState && stateRecord.connected === true)
          const state = connected && !normalizedState ? 'open' : providerState || 'unknown'
          if (connected) {
            const { data: activated, error: activationError } = await admin.rpc('activate_evolution_connection', {
              p_business_id: businessId,
              p_instance_name: statusConfig.instanceName,
            })
            if (activationError || activated !== true) return json({ configured: true, connected: false, connection_selected: false, connection_status: null, instance_exists: false, connection_state: 'not_created' })
          }
          const webhook = await reconcileEvolutionWebhook(statusConfig)
          return json({ configured: true, connected, connection_selected: true, connection_status: connected ? 'active' : statusConfig.connectionStatus, instance_exists: true, connection_state: state, webhook_ready: webhook.ready, webhook_repaired: webhook.repaired })
        } catch {
          return json({ configured: true, connected: false, connection_selected: true, connection_status: statusConfig.connectionStatus, connection_state: 'unavailable' })
        }
      }
      if (!config) return json({ error: 'evolution_not_configured' }, 503)

      if (action === 'configure_webhook') {
        if (!canManageBusiness) return json({ error: 'forbidden' }, 403)
        if (!config.instanceName) return json({ error: 'whatsapp_connection_not_started' }, 409)
        let webhook: { accepted: boolean; verified: boolean }
        try {
          webhook = await setEvolutionWebhook(config)
        } catch (error) {
          logWebhookSetupFailure('configure_webhook', error)
          throw error
        }
        return json({ configured: webhook.accepted, verified: webhook.verified })
      }

      if (action === 'connect') {
        if (!canManageBusiness) return json({ error: 'forbidden' }, 403)
        let connectionConfig = config
        if (!connectionConfig) return json({ error: 'evolution_not_configured' }, 503)
        const pairingMethod = body.pairing_method === 'phone' ? 'phone' : 'qr'
        const pairingPhone = pairingMethod === 'phone' ? normalizePairingPhone(body.phone_number) : null
        if (pairingMethod === 'phone' && !pairingPhone) return json({ error: 'invalid_pairing_phone' }, 400)
        const { data: instanceName, error: startError } = await admin.rpc('start_evolution_connection', { p_business_id: businessId })
        const selectedInstance = text(instanceName, 120)
        if (startError?.message?.includes('connection_must_be_archived_first')) {
          return json({ error: 'connection_must_be_archived_first' }, 409)
        }
        if (startError || !selectedInstance) return json({ error: 'whatsapp_connection_setup_failed' }, 500)
        connectionConfig = { ...connectionConfig, instanceName: selectedInstance, connectionStatus: 'pending' }
        const instanceList = await evolutionRequest(connectionConfig, '/instance/fetchInstances')
        const instanceExists = Array.isArray(instanceList) && instanceList.some((entry) => evolutionInstanceName(entry) === connectionConfig.instanceName)
        if (!instanceExists) {
          await evolutionRequest(connectionConfig, '/instance/create', {
            method: 'POST',
            body: JSON.stringify({
              instanceName: connectionConfig.instanceName,
              integration: 'WHATSAPP-BAILEYS',
              qrcode: false,
              syncFullHistory: true,
            }),
          })
        }
        try { await setEvolutionWebhook(connectionConfig) } catch (error) {
          logWebhookSetupFailure('connect', error)
          return json({ error: 'webhook_setup_failed', connection_selected: true, connection_status: 'pending', instance_exists: true, connection_state: 'close' })
        }
        if (pairingMethod === 'phone') {
          const providerState = await evolutionConnectionState(connectionConfig).catch(() => null)
          if (providerState === 'connecting') {
            // Recheck immediately before logout: the phone may have completed
            // pairing after the first state read. Never log out a new session.
            const stateBeforeReset = await evolutionConnectionState(connectionConfig).catch(() => null)
            if (stateBeforeReset === 'connecting') {
              try {
                await evolutionRequest(connectionConfig, `/instance/logout/${encodeURIComponent(connectionConfig.instanceName)}`, { method: 'DELETE' })
              } catch {
                return json({ error: 'pairing_restart_failed', connection_selected: true, connection_status: 'pending', instance_exists: true, connection_state: 'connecting' })
              }
              const stopped = await waitForEvolutionConnectionState(connectionConfig, 'close').catch(() => false)
              if (!stopped) {
                const stateAfterReset = await evolutionConnectionState(connectionConfig).catch(() => null)
                if (stateAfterReset !== 'open') {
                  return json({ error: 'pairing_restart_failed', connection_selected: true, connection_status: 'pending', instance_exists: true, connection_state: 'connecting' })
                }
              }
            } else if (stateBeforeReset !== 'open' && stateBeforeReset !== 'close' && stateBeforeReset !== 'closed') {
              return json({ error: 'pairing_restart_failed', connection_selected: true, connection_status: 'pending', instance_exists: true, connection_state: 'connecting' })
            }
          } else if (providerState !== 'open' && providerState !== 'close' && providerState !== 'closed') {
            return json({ error: 'pairing_restart_failed', connection_selected: true, connection_status: 'pending', instance_exists: true, connection_state: 'connecting' })
          }
        }
        let result: unknown
        const connectPath = `/instance/connect/${encodeURIComponent(connectionConfig.instanceName)}${pairingPhone ? `?number=${encodeURIComponent(pairingPhone)}` : ''}`
        try { result = await evolutionRequest(connectionConfig, connectPath, undefined, 1_600_000) } catch {
          return json({ error: pairingMethod === 'phone' ? 'pairing_code_unavailable' : 'qrcode_unavailable', connection_selected: true, connection_status: 'pending', instance_exists: true, connection_state: 'close' })
        }
        const outer = isRecord(result) ? result : {}
        const instance = isRecord(outer.instance) ? outer.instance : {}
        const state = text(instance.state ?? outer.state ?? instance.connectionStatus, 64)?.toLowerCase()
        if (state === 'open') {
          const { data: activated, error: activationError } = await admin.rpc('activate_evolution_connection', {
            p_business_id: businessId,
            p_instance_name: connectionConfig.instanceName,
          })
          if (activationError || activated !== true) return json({ error: 'connection_archived_during_pairing', connection_selected: false, connection_status: null, instance_exists: false, connection_state: 'not_created' }, 409)
          return json({ connected: true, connection_selected: true, connection_status: 'active', instance_exists: true, connection_state: 'open' })
        }
        const { data: currentRuntime, error: currentRuntimeError } = await admin.rpc('get_evolution_runtime_config', { p_business_id: businessId })
        if (currentRuntimeError || !isRecord(currentRuntime)) {
          return json({ error: 'connection_status_unavailable', connection_selected: true, connection_status: 'pending', instance_exists: true, connection_state: 'connecting' }, 503)
        }
        if (text(currentRuntime.evolution_instance_name, 120) !== connectionConfig.instanceName
          || currentRuntime.evolution_connection_status !== 'pending') {
          return json({ error: 'connection_archived_during_pairing', connection_selected: false, connection_status: null, instance_exists: false, connection_state: 'not_created' }, 409)
        }
        const qr = isRecord(outer.qrcode) ? outer.qrcode : outer
        if (pairingMethod === 'phone') {
          const pairingCode = text(qr.pairingCode ?? qr.pairing_code ?? outer.pairingCode ?? outer.pairing_code, 64)
          if (!pairingCode || !/^[A-Z0-9-]{6,24}$/i.test(pairingCode)) {
            return json({ error: 'pairing_code_unavailable', connection_selected: true, connection_status: 'pending', instance_exists: true, connection_state: 'connecting' })
          }
          return json({ connected: false, connection_selected: true, connection_status: 'pending', instance_exists: true, connection_state: 'connecting', pairing_code: pairingCode })
        }
        const imageValue = text(qr.base64 ?? qr.qrcode, 1_500_000)
        if (!imageValue) return json({ error: 'qrcode_unavailable', connection_selected: true, connection_status: 'pending', instance_exists: true, connection_state: 'connecting' })
        if (!imageValue.startsWith('data:image/') && !/^[A-Za-z0-9+/]+={0,2}$/.test(imageValue)) {
          return json({ error: 'qrcode_unavailable', connection_selected: true, connection_status: 'pending', instance_exists: true, connection_state: 'connecting' })
        }
        const qrImage = imageValue.startsWith('data:image/') ? imageValue : `data:image/png;base64,${imageValue}`
        return json({ connected: false, connection_selected: true, connection_status: 'pending', instance_exists: true, connection_state: 'connecting', qr_image: qrImage })
      }

      if (action === 'disconnect') {
        if (!canManageBusiness) return json({ error: 'forbidden' }, 403)
        if (!config.instanceName) return json({ connected: false, connection_selected: false, instance_exists: false, connection_state: 'not_created' })
        let providerLogoutFailed = false
        try {
          const instances = await evolutionRequest(config, '/instance/fetchInstances')
          const instanceExists = Array.isArray(instances) && instances.some((entry) => evolutionInstanceName(entry) === config.instanceName)
          if (instanceExists) {
            await evolutionRequest(config, `/instance/logout/${encodeURIComponent(config.instanceName)}`, { method: 'DELETE' })
          }
        } catch {
          // Archiving is the isolation boundary. If Evolution is unavailable,
          // still archive it so a replacement number cannot reuse its inbox.
          providerLogoutFailed = true
        }
        const { data: archived, error: archiveError } = await admin.rpc('archive_evolution_connection', {
          p_business_id: businessId,
          p_instance_name: config.instanceName,
        })
        if (archiveError || archived !== true) return json({ error: 'whatsapp_connection_archive_failed' }, 500)
        return json({ connected: false, connection_selected: false, connection_status: null, provider_logout_failed: providerLogoutFailed, instance_exists: false, connection_state: 'not_created' })
      }

      if (!config.instanceName) return json({ error: 'whatsapp_connection_not_started' }, 409)

      if (action === 'list') {
        const status = body.status
        if (status !== 'open' && status !== 'resolved' && status !== 'all') return json({ error: 'invalid_status' }, 400)
        const segment = body.segment === undefined ? 'conversations' : body.segment
        if (segment !== 'customers' && segment !== 'conversations' && segment !== 'hidden') return json({ error: 'invalid_segment' }, 400)
        const page = typeof body.page === 'number' && Number.isInteger(body.page) ? body.page : 1
        if (page < 1 || page > 1000) return json({ error: 'invalid_page' }, 400)
        const query = body.query === undefined ? '' : (text(body.query, 120) ?? '')
        if (body.query !== undefined && body.query !== '' && !query) return json({ error: 'invalid_query' }, 400)
        const webhookHealth = await reconcileEvolutionWebhook(config)
        const providerChatPage = Math.ceil((page * PAGE_SIZE) / LEGACY_CHAT_PAGE_SIZE)
        const historySync = await syncLegacyChats(admin, config, businessId, providerChatPage)
        let selection = admin.from('whatsapp_conversations')
          .select('id, instance_name, remote_jid, remote_jid_alt, contact_name, group_subject, contact_phone, display_name_override, contact_classification, hidden_from_inbox, status, unread_count, last_activity_at', { count: 'exact' })
          .eq('business_id', businessId).eq('instance_name', config.instanceName)
        if (segment === 'customers') selection = selection.eq('hidden_from_inbox', false).eq('contact_classification', 'customer')
        else if (segment === 'conversations') selection = selection.eq('hidden_from_inbox', false).neq('contact_classification', 'customer')
        else selection = selection.eq('hidden_from_inbox', true)
        if (status !== 'all') selection = selection.eq('status', status)
        if (query) {
          const safeQuery = query.replace(/[(),%_*\\]/g, ' ').trim()
          if (safeQuery) selection = selection.or(`display_name_override.ilike.%${safeQuery}%,contact_name.ilike.%${safeQuery}%,group_subject.ilike.%${safeQuery}%,contact_phone.ilike.%${safeQuery}%,remote_jid.ilike.%${safeQuery}%`)
        }
        const offset = (page - 1) * PAGE_SIZE
        const { data: rows, count, error } = await selection
          .order('last_activity_at', { ascending: false })
          .order('id', { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1)
        if (error) throw new RequestError(500, 'conversation_list_failed')
        const ids = (rows ?? []).map((row: JsonRecord) => row.id)
        let lastMessages: JsonRecord[] = []
        if (ids.length) {
          for (let index = 0; index < ids.length; index += 8) {
            const batch = await Promise.all(ids.slice(index, index + 8).map(async (id) => {
              const { data: message, error: messageError } = await admin.from('whatsapp_messages')
                .select('id, provider_message_id, conversation_id, direction, message_kind, content, delivery_status, media_metadata, provider_timestamp, deleted_at')
                .eq('business_id', businessId)
                .eq('instance_name', config.instanceName)
                .eq('conversation_id', id)
                .neq('message_kind', 'reaction')
                .is('deleted_at', null)
                .order('provider_timestamp', { ascending: false })
                .order('id', { ascending: false })
                .limit(1)
                .maybeSingle()
              if (messageError) throw new RequestError(500, 'message_list_failed')
              return message
            }))
            for (const message of batch) {
              if (message !== null) lastMessages.push(message)
            }
          }
        }
        const latestByConversation = new Map<string, JsonRecord>()
        for (const message of lastMessages) {
          if (message.message_kind !== 'reaction' && !latestByConversation.has(String(message.conversation_id))) {
            latestByConversation.set(String(message.conversation_id), message)
          }
        }
        const savedNames = await loadSavedContactNames(config, admin, businessId)
        const groupDirectory = await loadGroupDirectory(config, admin, businessId)
        const groupsNeedingLookup = (rows ?? []).filter((row: JsonRecord) => {
          const jid = text(row.remote_jid, 256)
          const existingMetadata = jid ? groupDirectory.get(jid.toLowerCase()) : null
          return Boolean(jid && isGroupJid(jid)
            && !displayableContactName(row.display_name_override, null)
            && !displayableContactName(existingMetadata?.subject, null)
            && !displayableContactName(row.group_subject, null)
            && !groupMetadataWasRecentlyChecked(config, jid, 'subject'))
        }).slice(0, 8)
        const groupLookups = await Promise.all(groupsNeedingLookup.map(async (row: JsonRecord) => {
          const jid = text(row.remote_jid, 256)!
          return { row, jid, metadata: await loadGroupMetadata(config, jid, 'subject', admin, businessId) }
        }))
        for (const { row, jid, metadata } of groupLookups) {
          groupDirectory.set(jid.toLowerCase(), metadata)
        }
        const identityBackfills = (rows ?? []).map((row: JsonRecord) => {
          const jid = text(row.remote_jid, 256)
          if (!jid) return null
          if (isGroupJid(jid)) {
            const groupSubject = displayableContactName(groupDirectory.get(jid.toLowerCase())?.subject, null)
            return groupSubject && !displayableContactName(row.group_subject, null)
              ? { id: String(row.id), update: { group_subject: groupSubject, contact_name: null } }
              : null
          }
          const savedName = displayableContactName(
            savedNameForJids(savedNames, row.remote_jid, row.remote_jid_alt),
            displayPhone(row.contact_phone) ?? phoneFromWhatsAppJid(String(row.remote_jid_alt ?? row.remote_jid ?? '')),
          )
          const savedPhone = savedPhoneForJids(savedNames, row.remote_jid_alt, row.remote_jid)
          const update: JsonRecord = {}
          if (savedName && savedName !== row.contact_name) update.contact_name = savedName
          if (savedPhone && !displayPhone(row.contact_phone)) update.contact_phone = savedPhone
          return Object.keys(update).length ? { id: String(row.id), update } : null
        }).filter((entry): entry is { id: string; update: JsonRecord } => Boolean(entry))
        if (identityBackfills.length) {
          const persisted = await Promise.all(identityBackfills.map(async ({ id, update }) => {
            const { error: identityError } = await admin.from('whatsapp_conversations').update(update)
              .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('id', id)
            return !identityError
          }))
          if (persisted.some((saved) => !saved)) console.warn('Some WhatsApp identity labels could not be persisted.')
        }
        const conversations = (rows ?? []).map((row: JsonRecord) => conversationResponse(
          row,
          latestByConversation.get(String(row.id)) ?? null,
          savedNames,
          groupDirectory,
        ))
        return json({ conversations, meta: {
          page,
          has_more: offset + conversations.length < (count ?? 0) || historySync.has_more === true,
          history_sync: historySync,
          webhook_ready: webhookHealth.ready,
          webhook_repaired: webhookHealth.repaired,
        } })
      }

      if (action === 'calls') {
        const { data: callRows, error } = await admin.from('whatsapp_call_events')
          .select('id, conversation_id, caller_jid, caller_phone, call_state, is_video, occurred_at, provider_call_id')
          .eq('business_id', businessId).eq('instance_name', config.instanceName)
          .order('occurred_at', { ascending: false })
          .limit(100)
        if (error) throw new RequestError(500, 'call_list_failed')
        const conversationIds = [...new Set((callRows ?? []).map((row: JsonRecord) => String(row.conversation_id)))]
        let conversationMap = new Map<string, JsonRecord>()
        if (conversationIds.length) {
        const { data: rows, error: conversationError } = await admin.from('whatsapp_conversations')
            .select('id, remote_jid, remote_jid_alt, contact_name, contact_phone, display_name_override, contact_classification, hidden_from_inbox, status')
            .eq('business_id', businessId).eq('instance_name', config.instanceName)
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
        const savedNames = await loadSavedContactNames(config, admin, businessId)
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
          const callerPhone = displayPhone(row.caller_phone) ?? displayPhone(conversation?.contact_phone)
            ?? savedPhoneForJids(savedNames, row.caller_jid, conversation?.remote_jid_alt, conversation?.remote_jid)
            ?? phoneFromWhatsAppJid(String(conversation?.remote_jid_alt ?? conversation?.remote_jid ?? ''))
            ?? phoneFromWhatsAppJid(String(row.caller_jid ?? ''))
          return {
            id: typeof row.provider_call_id === 'string' && row.provider_call_id ? row.provider_call_id : row.id,
            conversation_id: row.conversation_id,
            contact_classification: contactClassification(conversation?.contact_classification),
            hidden_from_inbox: conversation?.hidden_from_inbox === true,
            display_name_override: displayableContactName(conversation?.display_name_override,
              displayPhone(conversation?.contact_phone)),
            contact: {
              name: displayableContactName(conversation?.display_name_override,
                callerPhone)
                ?? displayableContactName(savedNameForJids(savedNames, conversation?.remote_jid, conversation?.remote_jid_alt, row.caller_jid),
                  callerPhone)
                ?? displayableContactName(conversation?.contact_name,
                  callerPhone),
              phone: callerPhone,
            },
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
        .select('id, business_id, instance_name, remote_jid, remote_jid_alt, contact_name, group_subject, contact_phone, display_name_override, contact_classification, hidden_from_inbox, contact_preferences_updated_at, status, unread_count, last_activity_at')
        .eq('business_id', businessId)
        .eq('instance_name', config.instanceName)
        .eq('id', conversationId)
        .maybeSingle()
      if (conversationError) throw new RequestError(500, 'conversation_lookup_failed')
      if (!conversation) return json({ error: 'conversation_not_found' }, 404)

      if (action === 'message_statuses') {
        const { data: statusRows, error: statusError } = await admin.from('whatsapp_messages')
          .select('id, delivery_status')
          .eq('business_id', businessId).eq('instance_name', config.instanceName)
          .eq('conversation_id', conversationId).eq('direction', 'outgoing')
          .order('provider_timestamp', { ascending: false }).limit(MESSAGE_HISTORY_LIMIT)
        if (statusError) throw new RequestError(500, 'message_status_list_failed')
        return json({ statuses: (statusRows ?? []).map((row: JsonRecord) => ({
          id: row.id,
          status: messageDeliveryStatus(row.delivery_status),
        })) })
      }

      if (action === 'update_contact_preferences') {
        if (!canManageBusiness) return json({ error: 'forbidden' }, 403)
        const hasDisplayName = Object.prototype.hasOwnProperty.call(body, 'display_name_override')
        const hasClassification = Object.prototype.hasOwnProperty.call(body, 'contact_classification')
        const hasHidden = Object.prototype.hasOwnProperty.call(body, 'hidden_from_inbox')
        if (!hasDisplayName && !hasClassification && !hasHidden) return json({ error: 'no_preferences_to_update' }, 400)
        const update: JsonRecord = { contact_preferences_updated_at: new Date().toISOString() }
        if (hasDisplayName) {
          if (typeof body.display_name_override !== 'string') return json({ error: 'invalid_display_name' }, 400)
          const displayName = body.display_name_override.trim()
          if (displayName.length > 160) return json({ error: 'invalid_display_name' }, 400)
          update.display_name_override = displayName || null
        }
        if (hasClassification) {
          if (body.contact_classification !== 'unclassified' && body.contact_classification !== 'customer' && body.contact_classification !== 'personal') {
            return json({ error: 'invalid_contact_classification' }, 400)
          }
          update.contact_classification = body.contact_classification
        }
        if (hasHidden) {
          if (typeof body.hidden_from_inbox !== 'boolean') return json({ error: 'invalid_hidden_state' }, 400)
          update.hidden_from_inbox = body.hidden_from_inbox
        }
        const { error: updateError } = await admin.from('whatsapp_conversations').update(update)
          .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('id', conversationId)
        if (updateError) throw new RequestError(500, 'contact_preferences_update_failed')
        return json({ saved: true, preferences: {
          display_name_override: hasDisplayName ? update.display_name_override : conversation.display_name_override,
          contact_classification: hasClassification ? update.contact_classification : conversation.contact_classification,
          hidden_from_inbox: hasHidden ? update.hidden_from_inbox : conversation.hidden_from_inbox,
        } })
      }

      if (action === 'avatar') {
        return await profilePictureResponse(config, conversation as JsonRecord, admin, businessId)
      }

      if (action === 'attachment') {
        const messageId = body.messageId
        if (!isUuid(messageId)) return json({ error: 'invalid_media_reference' }, 400)
        return await mediaResponse(admin, config, businessId, conversationId, messageId)
      }

      if (action === 'older_messages') {
        const beforeMessageId = body.beforeMessageId
        if (!isUuid(beforeMessageId)) return json({ error: 'invalid_history_cursor' }, 400)
        const names = await loadSavedContactNames(config, admin, businessId)
        return await olderMessagesResponse(admin, config, businessId, conversation as JsonRecord, beforeMessageId, names)
      }

      if (action === 'react') {
        const messageId = body.messageId
        if (!isUuid(messageId)) return json({ error: 'invalid_reaction_target' }, 400)
        if (typeof body.emoji !== 'string') return json({ error: 'invalid_reaction' }, 400)
        const emoji = body.emoji.normalize('NFC')
        if (emoji !== '' && !isSingleReaction(emoji)) return json({ error: 'invalid_reaction' }, 400)
        const { data: target, error: targetError } = await admin.from('whatsapp_messages')
          .select('provider_message_id, direction, message_kind, media_metadata, deleted_at')
          .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('conversation_id', conversationId).eq('id', messageId).maybeSingle()
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
        let incomingRows: JsonRecord[] = []
        for (let offset = 0; offset < 10_000; offset += 500) {
          const { data: unreadRows, error: incomingError } = await admin.from('whatsapp_messages')
            .select('provider_message_id, media_metadata')
            .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('conversation_id', conversationId)
            .eq('direction', 'incoming').eq('count_as_unread', true).is('deleted_at', null).not('provider_message_id', 'is', null)
            .order('provider_timestamp', { ascending: false }).order('id', { ascending: false })
            .range(offset, offset + 499)
          if (incomingError) throw new RequestError(500, 'mark_read_failed')
          incomingRows.push(...(unreadRows ?? []))
          if ((unreadRows?.length ?? 0) < 500) break
        }
        if (incomingRows.length === 0 && Number(conversation.unread_count) > 0) {
          const { data: recentRows, error: recentError } = await admin.from('whatsapp_messages')
            .select('provider_message_id, media_metadata')
            .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('conversation_id', conversationId)
            .eq('direction', 'incoming').is('deleted_at', null).not('provider_message_id', 'is', null)
            .order('provider_timestamp', { ascending: false }).order('id', { ascending: false })
            .limit(MESSAGE_HISTORY_LIMIT)
          if (recentError) throw new RequestError(500, 'mark_read_failed')
          incomingRows = recentRows ?? []
        }
        const readMessages = incomingRows.flatMap((row: JsonRecord) => {
          const id = text(row.provider_message_id, 256)
          if (!id) return []
          const metadata = isRecord(row.media_metadata) ? row.media_metadata : {}
          const remoteJid = text(metadata.provider_remote_jid, 256) ?? conversation.remote_jid
          const key: JsonRecord = { id, fromMe: false, remoteJid }
          const remoteJidAlt = text(metadata.provider_remote_jid_alt, 256)
          const participant = text(metadata.participant_jid, 256)
          const participantAlt = text(metadata.participant_alt_jid, 256)
          if (remoteJidAlt) key.remoteJidAlt = remoteJidAlt
          if (participant) key.participant = participant
          if (participantAlt) key.participantAlt = participantAlt
          return [key]
        })
        if (readMessages.length) {
          for (let index = 0; index < readMessages.length; index += 100) {
            await evolutionRequest(config, `/chat/markMessageAsRead/${encodeURIComponent(config.instanceName)}`, {
              method: 'POST',
              body: JSON.stringify({ readMessages: readMessages.slice(index, index + 100) }),
            })
          }
        }
        const { error: messageReadError } = await admin.from('whatsapp_messages').update({ count_as_unread: false })
          .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('conversation_id', conversationId)
          .eq('direction', 'incoming').eq('count_as_unread', true)
        if (messageReadError) throw new RequestError(500, 'mark_read_failed')
        const { error: conversationReadError } = await admin.from('whatsapp_conversations').update({ unread_count: 0 })
          .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('id', conversationId)
        if (conversationReadError) throw new RequestError(500, 'mark_read_failed')
      } else if (action === 'set_status') {
        const status = body.status
        if (status !== 'open' && status !== 'resolved') return json({ error: 'invalid_status' }, 400)
        const { error } = await admin.from('whatsapp_conversations').update({ status })
          .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('id', conversationId)
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
          delivery_status: 'sent',
          media_metadata: {},
          provider_timestamp: providerTimestamp,
        }, { onConflict: 'business_id,instance_name,provider_message_id', ignoreDuplicates: true })
        if (insertError) throw new RequestError(500, 'message_persist_failed')
        await applyMessageDeliveryStatus(admin, businessId, config.instanceName, providerMessageId, 'sent')
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
          delivery_status: 'sent',
          media_metadata: { mime_type: mimeType, file_name: fileName, file_size: bytes.length },
          provider_timestamp: new Date().toISOString(),
        }, { onConflict: 'business_id,instance_name,provider_message_id', ignoreDuplicates: true })
        if (insertError) throw new RequestError(500, 'message_persist_failed')
        await applyMessageDeliveryStatus(admin, businessId, config.instanceName, providerMessageId, 'sent')
        return json({ sent: true })
      }

      const { data: freshConversation, error: freshError } = await admin.from('whatsapp_conversations')
        .select('id, instance_name, remote_jid, remote_jid_alt, contact_name, group_subject, contact_phone, display_name_override, contact_classification, hidden_from_inbox, status, unread_count, last_activity_at')
        .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('id', conversationId).single()
      if (freshError) throw new RequestError(500, 'conversation_refresh_failed')
      const { data: messageRows, error: messageError } = await admin.from('whatsapp_messages')
        .select('id, provider_message_id, direction, message_kind, content, delivery_status, media_metadata, provider_timestamp, deleted_at')
        .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('conversation_id', conversationId)
        .order('provider_timestamp', { ascending: false }).limit(MESSAGE_HISTORY_LIMIT + 1)
      if (messageError) throw new RequestError(500, 'message_history_failed')
      const hasLocalMore = (messageRows?.length ?? 0) > MESSAGE_HISTORY_LIMIT
      const initialRows = (messageRows ?? []).slice(0, MESSAGE_HISTORY_LIMIT).reverse()
      const { data: reactionRows, error: reactionError } = await admin.from('whatsapp_messages')
        .select('direction, content, media_metadata, provider_timestamp, id')
        .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('conversation_id', conversationId).eq('message_kind', 'reaction')
        .order('provider_timestamp', { ascending: false }).order('id', { ascending: false }).limit(500)
      if (reactionError) throw new RequestError(500, 'message_history_failed')
      const savedNames = await loadSavedContactNames(config, admin, businessId)
      const groupDirectory = await loadGroupDirectory(config, admin, businessId)
      const messages = attachMessageReactions(initialRows, reactionRows ?? [], savedNames)
      const { data: callRows, error: callsError } = await admin.from('whatsapp_call_events')
        .select('id, call_state, is_video, occurred_at')
        .eq('business_id', businessId).eq('instance_name', config.instanceName).eq('conversation_id', conversationId)
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
        ...conversationResponse(freshConversation as JsonRecord, null, savedNames, groupDirectory),
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
