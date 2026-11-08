import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { supabaseClient } from '../lib/supabase'

type InboxStatus = 'open' | 'resolved' | 'all'
type ContactListSegment = 'customers' | 'conversations' | 'hidden'
type ContactClassification = 'unclassified' | 'customer' | 'personal'

function conversationScopeKey(status: InboxStatus, search: string, segment: ContactListSegment): string {
  return JSON.stringify([status, search, segment])
}
type Attachment = {
  id: string
  file_type: string | null
  extension: string | null
  file_size: number | null
  width: number | null
  height: number | null
}
type Message = {
  id: string
  content: string | null
  created_at: string | null
  message_type: 'incoming' | 'outgoing' | 'activity'
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'played' | 'failed' | 'deleted' | null
  private: boolean
  sender: { name: string | null; phone?: string | null }
  attachments: Attachment[]
  message_kind: string | null
  reactions?: { emoji: string; count: number; from_me: boolean }[]
}
type Conversation = {
  id: string
  inbox_id: string
  status: string
  can_reply: boolean
  is_group?: boolean
  display_name_override: string | null
  contact_classification: ContactClassification
  hidden_from_inbox: boolean
  unread_count: number
  contact: { name: string | null; phone: string | null }
  last_activity_at: string | null
  last_message: Message | null
  messages: Message[]
  calls?: CallEvent[]
}
type Customer = { id: string; name: string; phone: string | null; whatsapp_phone: string | null }
type Order = { id: string; created_at: string; status: 'open' | 'cancelled'; total_cents: number }
type ConversationLink = { conversation_id: string; customer_id: string | null; order_id: string | null; match_method: 'phone' | 'manual' }
type CallEvent = { id: string; conversation_id: string; contact: { name: string | null; phone: string | null }; display_name_override?: string | null; contact_classification?: ContactClassification; hidden_from_inbox?: boolean; customer_name?: string | null; status: string | null; status_label: string; is_video: boolean | null; occurred_at: string; event_count?: number; states?: string[] }
type ConversationListResponse = { conversations?: Conversation[]; meta?: { page?: number; has_more?: boolean; history_sync?: { status?: string; notice?: string } } }
type ConversationDetailResponse = { conversation?: Conversation; meta?: { has_more?: boolean } }
type MessageStatusesResponse = { statuses?: { id: string; status: Message['status'] }[] }
type OlderMessagesResponse = { messages?: Message[]; meta?: { has_more?: boolean; notice?: string } }
type CallListResponse = { calls?: CallEvent[] }

const EMPTY_CONVERSATIONS: Conversation[] = []
const COMMON_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

function uniqueConversations(rows: Conversation[]): Conversation[] {
  const uniqueById = new Map<string, Conversation>()
  for (const conversation of rows) {
    const previous = uniqueById.get(conversation.id)
    const activity = Date.parse(conversation.last_activity_at ?? '') || 0
    const previousActivity = Date.parse(previous?.last_activity_at ?? '') || 0
    if (!previous || activity >= previousActivity) uniqueById.set(conversation.id, conversation)
  }
  return [...uniqueById.values()].sort((left, right) => {
    const activityDifference = (Date.parse(right.last_activity_at ?? '') || 0) - (Date.parse(left.last_activity_at ?? '') || 0)
    return activityDifference || left.id.localeCompare(right.id)
  })
}

function digitsOnly(value: string | null | undefined) {
  return (value ?? '').replace(/\D/g, '')
}

function canonicalBrazilPhone(value: string | null | undefined) {
  const digits = digitsOnly(value)
  if (digits.length === 10 || digits.length === 11) return `55${digits}`
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return digits
  return ''
}

function messageKindLabel(value: string | null | undefined) {
  if (value === 'image') return 'Imagem recebida'
  if (value === 'audio') return 'Áudio recebido'
  if (value === 'video') return 'Vídeo recebido'
  if (value === 'document') return 'Documento recebido'
  if (value === 'sticker') return 'Figurinha recebida'
  if (value === 'location') return 'Localização recebida'
  if (value === 'contact') return 'Contato compartilhado'
  if (value === 'interactive') return 'Mensagem interativa'
  if (value === 'reaction') return 'Reação'
  return 'Mensagem sem texto'
}

function attachmentName(attachment: Attachment) {
  const extension = attachment.extension && /^[a-z0-9]{1,16}$/i.test(attachment.extension)
    ? `.${attachment.extension}`
    : ''
  return `whatsapp-anexo-${attachment.id}${extension}`
}

function timestampLabel(value: string | null | undefined) {
  if (!value) return 'Agora'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

function statusLabel(value: string | null | undefined) {
  if (value === 'resolved') return 'Resolvida'
  if (value === 'pending') return 'Pendente'
  if (value === 'snoozed') return 'Adiada'
  if (value === 'open') return 'Aberta'
  return value ? `Status: ${value}` : 'Status indisponível'
}

function connectionStateLabel(value: string | null | undefined) {
  const normalized = (value ?? '').toLowerCase()
  if (normalized === 'open' || normalized === 'connected') return 'Conectado'
  if (normalized === 'connecting' || normalized === 'connecting...') return 'Conectando'
  if (normalized === 'close' || normalized === 'closed' || normalized === 'disconnected') return 'Desconectado'
  if (normalized === 'not_created') return 'Instância ainda não criada'
  if (normalized === 'not_configured') return 'Não configurado'
  if (normalized === 'unavailable') return 'API indisponível'
  return value ? `Estado: ${value}` : 'Estado indisponível'
}

function isWhatsAppConnected(value: string | null | undefined) {
  const normalized = (value ?? '').toLowerCase()
  return normalized === 'open' || normalized === 'connected'
}

function messageDeliveryLabel(value: Message['status']) {
  if (value === 'pending') return 'Aguardando envio'
  if (value === 'sent') return 'Enviada'
  if (value === 'delivered') return 'Entregue'
  if (value === 'read') return 'Lida'
  if (value === 'played') return 'Reproduzida'
  if (value === 'failed') return 'Não enviada'
  if (value === 'deleted') return 'Mensagem apagada'
  return null
}

function MessageDeliveryIndicator({ status }: { status: Message['status'] }) {
  const label = messageDeliveryLabel(status)
  if (!label) return null

  return <span aria-label={label} className={`whatsapp-message-delivery is-${status}`} role="img" title={label}>
    <svg aria-hidden="true" viewBox={status === 'pending' || status === 'failed' ? '0 0 16 16' : '0 0 20 14'}>
      {status === 'pending' && <>
        <circle cx="8" cy="8" r="6.1" />
        <path d="M8 4.4v3.9l2.6 1.5" />
      </>}
      {status === 'failed' && <>
        <circle cx="8" cy="8" r="6.1" />
        <path d="M8 4.7v4.1M8 11.2v.1" />
      </>}
      {status === 'sent' && <path d="m3 7.5 3.1 3.1L13 3.7" />}
      {(status === 'delivered' || status === 'read' || status === 'played') && <>
        <path d="m1.5 7.4 3.1 3.1 6.8-6.9" />
        <path d="m7.2 7.4 3.1 3.1 6.8-6.9" />
      </>}
      {status === 'deleted' && <path d="M5 5l6 6M11 5l-6 6" />}
    </svg>
  </span>
}

function conversationDisplayName(conversation: Conversation | null | undefined, loading = false) {
  if (!conversation) return loading ? 'Carregando contato…' : 'Conversa'
  const savedLabel = conversation.contact.name?.trim()
  if (savedLabel && !/^contato sem (?:nome|identificação|identificacao)|grupo sem (?:nome|identificação|identificacao)$/i.test(savedLabel)) return savedLabel
  if (!conversation.is_group && conversation.contact.phone) return conversation.contact.phone
  const stableId = conversation.id.replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase() || 'ID'
  return `${conversation.is_group ? 'Grupo' : 'Contato'} #${stableId}`
}

function conversationContactSubtitle(conversation: Conversation) {
  if (conversation.is_group) return 'Grupo do WhatsApp'
  return conversation.contact.phone || 'Telefone não informado'
}

function isProviderIdentifier(value: string | null | undefined) {
  return Boolean(value && /@(lid|g\.us|s\.whatsapp\.net|c\.us|broadcast|newsletter)\b/i.test(value))
}

function conversationMessagePreview(conversation: Conversation) {
  const content = conversation.last_message?.content?.trim()
  if (isProviderIdentifier(content)) return 'Mensagem recebida'
  if (content) return content
  const message = conversation.last_message
  if (message?.attachments.length) {
    const labels: Record<string, string> = { image: 'Imagem', audio: 'Áudio', video: 'Vídeo', sticker: 'Figurinha' }
    const kind = message.attachments[0]?.file_type
    return labels[kind ?? ''] ?? `${message.attachments.length} anexo(s)`
  }
  if (message?.message_kind) {
    const labels: Record<string, string> = {
      image: 'Imagem', audio: 'Áudio', video: 'Vídeo', sticker: 'Figurinha', document: 'Documento',
      location: 'Localização', contact: 'Contato compartilhado', interactive: 'Mensagem interativa',
      reaction: 'Reação', text: 'Mensagem recebida',
    }
    return labels[message.message_kind] ?? 'Mensagem recebida'
  }
  return message ? 'Mensagem recebida' : 'Sem mensagens recentes'
}

function senderDisplayName(sender: Message['sender'], fallback: string) {
  const name = sender.name?.trim()
  if (name && !isProviderIdentifier(name)) {
    const digits = name.replace(/\D/g, '')
    const phoneLike = /^[+\d\s().-]+$/.test(name) && digits.length >= 8 && digits.length <= 15
    if (!phoneLike && (!sender.phone || digits !== sender.phone.replace(/\D/g, ''))) return name
  }
  return sender.phone || fallback
}

function contactClassificationLabel(value: ContactClassification | undefined) {
  if (value === 'customer') return 'Cliente'
  if (value === 'personal') return 'Pessoal'
  return 'Sem categoria'
}

function orderLabel(order: Order) {
  const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'America/Sao_Paulo' }).format(new Date(order.created_at))
  const total = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(order.total_cents / 100)
  return `${date} · ${total} · ${order.status === 'open' ? 'ativo' : 'cancelado'}`
}

async function invokeInbox<T>(body: Record<string, unknown>) {
  if (!supabaseClient) throw new Error('A conexão segura com o Supabase não está disponível.')
  const { data, error } = await supabaseClient.functions.invoke('evolution-inbox', { body })
  if (error) throw error
  return data as T
}

const contactAvatarCache = new Map<string, { url: string; at: number }>()
const contactAvatarRequests = new Map<string, Promise<string | null>>()
const contactAvatarFailures = new Map<string, number>()
const MAX_CONTACT_AVATARS = 80

function cachedContactAvatar(key: string): string | null {
  const cached = contactAvatarCache.get(key)
  if (!cached) return null
  if (Date.now() - cached.at > 15 * 60_000) {
    URL.revokeObjectURL(cached.url)
    contactAvatarCache.delete(key)
    return null
  }
  return cached.url
}

async function loadContactAvatar(businessId: string, conversationId: string): Promise<string | null> {
  const cacheKey = `${businessId}:${conversationId}`
  const cached = cachedContactAvatar(cacheKey)
  if (cached) return cached
  if ((contactAvatarFailures.get(cacheKey) ?? 0) > Date.now()) return null
  const pending = contactAvatarRequests.get(cacheKey)
  if (pending) return pending
  const request = (async () => {
    if (!supabaseClient) return null
    const { data, error, response } = await supabaseClient.functions.invoke<Blob>('evolution-inbox', {
      body: { action: 'avatar', business_id: businessId, conversationId },
    })
    if (error || !(data instanceof Blob) || data.size < 1 || data.size > 2 * 1024 * 1024) {
      contactAvatarFailures.set(cacheKey, Date.now() + 5 * 60_000)
      return null
    }
    const mimeType = response?.headers.get('X-Original-Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) {
      contactAvatarFailures.set(cacheKey, Date.now() + 5 * 60_000)
      return null
    }
    const url = URL.createObjectURL(new Blob([data], { type: mimeType }))
    contactAvatarCache.set(cacheKey, { url, at: Date.now() })
    contactAvatarFailures.delete(cacheKey)
    while (contactAvatarCache.size > MAX_CONTACT_AVATARS) {
      const oldestKey = contactAvatarCache.keys().next().value
      if (!oldestKey) break
      const oldest = contactAvatarCache.get(oldestKey)
      if (oldest) URL.revokeObjectURL(oldest.url)
      contactAvatarCache.delete(oldestKey)
    }
    return url
  })().catch(() => {
    contactAvatarFailures.set(cacheKey, Date.now() + 5 * 60_000)
    return null
  }).finally(() => contactAvatarRequests.delete(cacheKey))
  contactAvatarRequests.set(cacheKey, request)
  return request
}

function WhatsAppAvatar({ businessId, conversation }: { businessId: string; conversation: Conversation | null }) {
  const [photo, setPhoto] = useState(() => ({
    conversationId: conversation?.id ?? null,
    url: conversation ? cachedContactAvatar(`${businessId}:${conversation.id}`) : null,
  }))
  const [photoUnavailable, setPhotoUnavailable] = useState(false)
  const avatarRef = useRef<HTMLSpanElement>(null)
  const isGroup = conversation?.is_group === true
  const label = conversation?.contact.name || conversation?.contact.phone || ''
  const photoUrl = photo.conversationId === conversation?.id ? photo.url : null

  useEffect(() => {
    setPhotoUnavailable(false)
    if (!conversation) {
      setPhoto({ conversationId: null, url: null })
      return
    }
    const key = `${businessId}:${conversation.id}`
    const cached = cachedContactAvatar(key)
    setPhoto({ conversationId: conversation.id, url: cached })
    if (!supabaseClient) return
    if (cached) {
      return
    }
    let active = true
    let observer: IntersectionObserver | null = null
    const fetchPhoto = () => {
      void loadContactAvatar(businessId, conversation.id).then((url) => {
        if (!active) return
        if (url) setPhoto({ conversationId: conversation.id, url })
        else setPhotoUnavailable(true)
      })
    }
    const element = avatarRef.current
    if (element && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer?.disconnect()
          fetchPhoto()
        }
      }, { rootMargin: '120px' })
      observer.observe(element)
    } else fetchPhoto()
    return () => {
      active = false
      observer?.disconnect()
    }
  }, [businessId, conversation?.id, isGroup])

  const initials = label.slice(0, 1).toLocaleUpperCase('pt-BR') || '?'
  return <span aria-hidden="true" className={`whatsapp-contact-avatar${isGroup ? ' is-group' : ''}`} ref={avatarRef} title={label || (isGroup ? 'Grupo' : 'Contato')}>
    {photoUrl && !photoUnavailable ? <img alt="" loading="lazy" onError={() => setPhotoUnavailable(true)} src={photoUrl} /> : isGroup ? '👥' : initials}
  </span>
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const separator = result.indexOf(',')
      if (separator < 0) reject(new Error('invalid_file'))
      else resolve(result.slice(separator + 1))
    }
    reader.onerror = () => reject(new Error('file_read_failed'))
    reader.readAsDataURL(file)
  })
}

const SAFE_INLINE_ATTACHMENT_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/aac', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/3gpp',
  'video/mp4', 'video/webm', 'video/3gpp',
])

function attachmentSizeLabel(bytes: number | null) {
  if (!bytes || bytes < 1) return ''
  const size = bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return ` · ${size}`
}

function attachmentKindLabel(attachment: Attachment) {
  if (attachment.file_type === 'sticker') return 'Figurinha'
  if (attachment.file_type === 'image') return 'Imagem'
  if (attachment.file_type === 'audio') return 'Áudio'
  if (attachment.file_type === 'video') return 'Vídeo'
  return 'Arquivo'
}

function isAttachmentSizeError(error: unknown) {
  if (!error || typeof error !== 'object' || !('context' in error)) return false
  const context = error.context
  return context instanceof Response && context.status === 413
}

function MessageAttachment({ attachment, businessId, conversationId, messageId, sticker = false }: {
  attachment: Attachment
  businessId: string
  conversationId: string
  messageId: string
  sticker?: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [sizeRejected, setSizeRejected] = useState(false)
  const [file, setFile] = useState<{ url: string; mimeType: string } | null>(null)
  const mounted = useRef(false)
  const objectUrl = useRef<string | null>(null)
  const attachmentContainer = useRef<HTMLDivElement>(null)
  const previewRegion = useRef<HTMLDivElement>(null)
  const loadButton = useRef<HTMLButtonElement>(null)
  const autoLoading = useRef(false)
  const autoLoadAttempted = useRef(false)
  const focusAfterRequest = useRef(false)
  const playbackActive = useRef(false)
  const previewVisible = useRef(false)
  const isSticker = sticker || attachment.file_type === 'sticker'
  const tooLarge = sizeRejected || (attachment.file_size !== null && attachment.file_size > 25 * 1024 * 1024)
  const name = attachmentName(attachment)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    }
  }, [])

  useEffect(() => {
    if (file && focusAfterRequest.current) previewRegion.current?.focus()
    if (error && focusAfterRequest.current) loadButton.current?.focus()
    if (file || error) focusAfterRequest.current = false
  }, [error, file])

  useEffect(() => {
    const isInlineMedia = sticker || ['image', 'sticker', 'audio', 'video'].includes(attachment.file_type ?? '')
    const container = attachmentContainer.current
    if (!isInlineMedia || !container || file || error || tooLarge || autoLoadAttempted.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        autoLoadAttempted.current = true
        autoLoading.current = true
        loadButton.current?.click()
        autoLoading.current = false
        observer.disconnect()
      }
    }, { rootMargin: '90px' })
    observer.observe(container)
    return () => observer.disconnect()
  }, [attachment.file_type, error, file, sticker, tooLarge])

  useEffect(() => {
    const isInlineMedia = sticker || ['image', 'sticker', 'audio', 'video'].includes(attachment.file_type ?? '')
    const region = previewRegion.current
    if (!file || !isInlineMedia || !region || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        previewVisible.current = entry.isIntersecting
        if (entry.isIntersecting || playbackActive.current || region.contains(document.activeElement)) continue
        if (objectUrl.current === file.url) {
          URL.revokeObjectURL(file.url)
          objectUrl.current = null
          autoLoadAttempted.current = false
          setFile(null)
        }
      }
    }, { rootMargin: '180px' })
    observer.observe(region)
    return () => observer.disconnect()
  }, [attachment.file_type, file, sticker])

  async function loadAttachment() {
    if (!supabaseClient || loading || file || tooLarge) return
    focusAfterRequest.current = !autoLoading.current
    setLoading(true)
    setError(false)
    try {
      const { data, error: requestError, response } = await supabaseClient.functions.invoke<Blob>('evolution-inbox', {
        body: {
          action: 'attachment', business_id: businessId, conversationId, messageId, attachmentId: attachment.id,
        },
      })
      if (requestError) throw requestError
      if (!(data instanceof Blob) || data.size < 1 || data.size > 25 * 1024 * 1024) throw new Error('invalid_attachment')
      const declaredType = response?.headers.get('X-Original-Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
      const mimeType = SAFE_INLINE_ATTACHMENT_TYPES.has(declaredType) ? declaredType : 'application/octet-stream'
      const safeBlob = new Blob([data], { type: mimeType })
      const url = URL.createObjectURL(safeBlob)
      if (!mounted.current) {
        URL.revokeObjectURL(url)
        return
      }
      objectUrl.current = url
      setFile({ url, mimeType })
    } catch (requestError) {
      if (mounted.current) {
        if (isAttachmentSizeError(requestError)) setSizeRejected(true)
        else setError(true)
      }
    } finally {
      if (mounted.current) setLoading(false)
    }
  }

  function handlePreviewError() {
    focusAfterRequest.current = true
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = null
    playbackActive.current = false
    setFile(null)
    setError(true)
  }

  function handlePlaybackEnd() {
    playbackActive.current = false
    if (!previewVisible.current && objectUrl.current === file?.url) {
      URL.revokeObjectURL(file.url)
      objectUrl.current = null
      autoLoadAttempted.current = false
      setFile(null)
    }
  }

  const label = `${isSticker ? 'Figurinha' : attachmentKindLabel(attachment)}${attachmentSizeLabel(attachment.file_size)}`
  if (!file) return (
    <div aria-busy={loading} className={`whatsapp-attachment${isSticker ? ' is-sticker' : ''}`} ref={attachmentContainer}>
      {tooLarge && <p className="whatsapp-attachment-error" role="alert">Este anexo excede o limite de 25 MiB.</p>}
      {!tooLarge && <button aria-label={loading ? `Carregando ${label.toLocaleLowerCase('pt-BR')}` : error ? `Tentar abrir ${label.toLocaleLowerCase('pt-BR')} novamente` : `Abrir ${label.toLocaleLowerCase('pt-BR')}`} className="whatsapp-attachment-load" disabled={loading} onClick={() => void loadAttachment()} ref={loadButton} type="button">
        <Icon name="file" />
        <span>{error ? 'Não foi possível abrir · tentar novamente' : `Abrir ${label}`}</span>
      </button>}
      {loading && <span aria-live="polite" className="whatsapp-attachment-status" role="status">Carregando anexo…</span>}
      {error && <span className="whatsapp-attachment-error" role="alert">O arquivo não abriu. Você pode tentar carregar novamente.</span>}
    </div>
  )

  return (
    <div aria-busy={loading} aria-label={`${label} carregado`} className={`whatsapp-attachment-preview-region${isSticker ? ' is-sticker' : ''}`} ref={previewRegion} role="group" tabIndex={-1}>
      {file.mimeType.startsWith('image/') && <a aria-label={`Abrir ${label} em tamanho maior`} className="whatsapp-image-link" href={file.url} rel="noreferrer" target="_blank"><img className="whatsapp-attachment-preview" alt={label} loading="lazy" onError={handlePreviewError} src={file.url} /></a>}
      {file.mimeType.startsWith('audio/') && <audio aria-label={label} className="whatsapp-attachment-audio" controls onEnded={handlePlaybackEnd} onError={handlePreviewError} onPause={handlePlaybackEnd} onPlay={() => { playbackActive.current = true }} preload="metadata" src={file.url}>{`Seu navegador não reproduz ${label.toLocaleLowerCase('pt-BR')}.`}</audio>}
      {file.mimeType.startsWith('video/') && <video aria-label={label} className="whatsapp-attachment-video" controls onEnded={handlePlaybackEnd} onError={handlePreviewError} onPause={handlePlaybackEnd} onPlay={() => { playbackActive.current = true }} playsInline preload="metadata" src={file.url}>{`Seu navegador não reproduz ${label.toLocaleLowerCase('pt-BR')}.`}</video>}
      {file.mimeType === 'application/octet-stream' && <a className="whatsapp-attachment-document" download={name} href={file.url}>Baixar arquivo</a>}
    </div>
  )
}

export function WhatsAppInboxPage() {
  const { id: businessId, role } = useBusiness()
  const [searchParams, setSearchParams] = useSearchParams()
  const [connectionChecking, setConnectionChecking] = useState(true)
  const [configured, setConfigured] = useState(false)
  const [connectionState, setConnectionState] = useState('')
  const [instanceExists, setInstanceExists] = useState(false)
  const [pairingLoading, setPairingLoading] = useState(false)
  const [pairingPhone, setPairingPhone] = useState('')
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [pairingError, setPairingError] = useState<string | null>(null)
  const [qrImage, setQrImage] = useState<string | null>(null)
  const [webhookSaving, setWebhookSaving] = useState(false)
  const [webhookFeedback, setWebhookFeedback] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [status, setStatus] = useState<InboxStatus>('open')
  const [segment, setSegment] = useState<ContactListSegment>('conversations')
  const [view, setView] = useState<'conversations' | 'calls'>(() => searchParams.get('view') === 'calls' ? 'calls' : 'conversations')
  const [calls, setCalls] = useState<CallEvent[]>([])
  const [callsLoading, setCallsLoading] = useState(false)
  const [callsError, setCallsError] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>(EMPTY_CONVERSATIONS)
  const [loadedListScope, setLoadedListScope] = useState<string | null>(null)
  const [listPage, setListPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [listLoading, setListLoading] = useState(false)
  const [listRefreshing, setListRefreshing] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [historySyncNotice, setHistorySyncNotice] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false)
  const [olderMessagesError, setOlderMessagesError] = useState<string | null>(null)
  const [olderMessagesNotice, setOlderMessagesNotice] = useState<string | null>(null)
  const [messageDraft, setMessageDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [mediaSending, setMediaSending] = useState(false)
  const mediaPicker = useRef<HTMLInputElement>(null)
  const [statusSaving, setStatusSaving] = useState(false)
  const [reactionSavingMessageId, setReactionSavingMessageId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [links, setLinks] = useState<Record<string, ConversationLink>>({})
  const [linkLoading, setLinkLoading] = useState(false)
  const [linkSaving, setLinkSaving] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [linkMessage, setLinkMessage] = useState<string | null>(null)
  const [displayNameDraft, setDisplayNameDraft] = useState('')
  const [contactPreferencesSaving, setContactPreferencesSaving] = useState(false)
  const [contactPreferencesError, setContactPreferencesError] = useState<string | null>(null)
  const [contactPreferencesMessage, setContactPreferencesMessage] = useState<string | null>(null)
  const [contactListFeedback, setContactListFeedback] = useState<string | null>(null)
  const detailRequest = useRef(0)
  const messageHistoryRef = useRef<HTMLDivElement>(null)
  const refreshScopeInFlight = useRef<{ scope: string; requestId: number } | null>(null)
  const listRequest = useRef(0)
  const activeListScope = useRef(conversationScopeKey(status, search, segment))
  const currentListScope = conversationScopeKey(status, search, segment)
  const businessContextLoaded = useRef(false)

  const changeView = useCallback((nextView: 'conversations' | 'calls') => {
    setView(nextView)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (nextView === 'calls') next.set('view', 'calls')
      else next.delete('view')
      return next
    }, { replace: true })
  }, [setSearchParams])

  const loadBusinessContext = useCallback(async () => {
    if (!configured || !supabaseClient) return
    if (!businessContextLoaded.current) setLinkLoading(true)
    try {
      const [customersResult, linksResult] = await Promise.all([
        supabaseClient.from('customers').select('id, name, phone, whatsapp_phone').eq('business_id', businessId).eq('is_active', true).order('name', { ascending: true }),
        supabaseClient.from('whatsapp_conversation_contexts').select('conversation_id, customer_id, order_id, match_method').eq('business_id', businessId),
      ])
      if (customersResult.error || linksResult.error) {
        setLinkError('Não foi possível carregar os vínculos com clientes e pedidos.')
      } else {
        setCustomers((customersResult.data ?? []) as Customer[])
        setLinks(Object.fromEntries(((linksResult.data ?? []) as ConversationLink[]).map((link) => [link.conversation_id, link])))
        setLinkError(null)
      }
    } catch {
      setLinkError('Não foi possível carregar os vínculos com clientes e pedidos.')
    } finally {
      businessContextLoaded.current = true
      setLinkLoading(false)
    }
  }, [businessId, configured])

  const loadConversations = useCallback(async (page = 1, append = false) => {
    if (!configured) return
    const requestScope = conversationScopeKey(status, search, segment)
    if (requestScope !== activeListScope.current) return
    const requestId = ++listRequest.current
    setListLoading(true)
    setListError(null)
    try {
      const result = await invokeInbox<ConversationListResponse>({
        action: 'list', business_id: businessId, status, segment, page, query: search || undefined,
      })
      if (requestId !== listRequest.current || requestScope !== activeListScope.current) return
      const next = result.conversations ?? []
      setConversations((current) => uniqueConversations(append ? [...current, ...next] : next))
      setLoadedListScope(requestScope)
      setListPage(page)
      setHasMore(result.meta?.has_more ?? next.length >= 25)
      setHistorySyncNotice(result.meta?.history_sync?.notice ?? null)
    } catch {
      if (requestId === listRequest.current && requestScope === activeListScope.current) {
        setListError('Não foi possível carregar as conversas. Tente novamente.')
      }
    } finally {
      if (requestId === listRequest.current) setListLoading(false)
    }
  }, [businessId, configured, search, segment, status])

  const refreshLoadedConversations = useCallback(async () => {
    if (!configured) return
    const requestScope = conversationScopeKey(status, search, segment)
    if (requestScope !== activeListScope.current) return
    if (refreshScopeInFlight.current?.scope === requestScope) return
    const requestId = ++listRequest.current
    refreshScopeInFlight.current = { scope: requestScope, requestId }
    setListLoading(true)
    setListRefreshing(true)
    setListError(null)
    try {
      const combined: Conversation[] = []
      let currentPage = 1
      let morePages = false
      const finalPage = Math.max(1, listPage)
      while (currentPage <= finalPage) {
        const result = await invokeInbox<ConversationListResponse>({
          action: 'list', business_id: businessId, status, segment, page: currentPage, query: search || undefined,
        })
        if (requestId !== listRequest.current || requestScope !== activeListScope.current) return
        const pageRows = result.conversations ?? []
        combined.push(...pageRows)
        morePages = result.meta?.has_more ?? pageRows.length >= 25
        setHistorySyncNotice(result.meta?.history_sync?.notice ?? null)
        if (currentPage >= finalPage || !morePages) break
        currentPage += 1
      }
      if (requestId !== listRequest.current || requestScope !== activeListScope.current) return
      const refreshedConversations = uniqueConversations(combined)
      setConversations(refreshedConversations)
      setLoadedListScope(requestScope)
      setListPage(currentPage)
      setHasMore(morePages)
      if (selectedId && refreshedConversations.some((conversation) => conversation.id === selectedId)) {
        const result = await invokeInbox<{ conversation?: Conversation }>({
          action: 'conversation', business_id: businessId, conversationId: selectedId,
        })
        if (requestId !== listRequest.current || requestScope !== activeListScope.current) return
        setSelectedConversation(result.conversation ?? null)
      } else {
        setSelectedConversation(null)
      }
    } catch {
      if (requestId === listRequest.current && requestScope === activeListScope.current) {
        setListError('Não foi possível atualizar as conversas. Tente novamente.')
      }
    } finally {
      if (refreshScopeInFlight.current?.requestId === requestId) refreshScopeInFlight.current = null
      if (requestId === listRequest.current) {
        setListLoading(false)
        setListRefreshing(false)
      }
    }
  }, [businessId, configured, listPage, search, segment, selectedId, status])

  useEffect(() => {
    let active = true
    async function checkConnection() {
      setConnectionChecking(true)
      setConnectionError(null)
      try {
        const result = await invokeInbox<{ configured?: boolean; connection_state?: string; instance_exists?: boolean }>({ action: 'status', business_id: businessId })
        if (active) {
          setConfigured(result.configured === true)
          setConnectionState(result.connection_state ?? '')
          setInstanceExists(result.instance_exists === true)
        }
      } catch {
        if (active) {
          setConfigured(false)
          setConnectionError('Não foi possível verificar a conexão com o servidor.')
        }
      } finally {
        if (active) setConnectionChecking(false)
      }
    }
    void checkConnection()
    return () => { active = false }
  }, [businessId])

  useEffect(() => {
    if (!configured || (!qrImage && !pairingCode)) return
    const interval = window.setInterval(() => {
      void invokeInbox<{ configured?: boolean; connection_state?: string; instance_exists?: boolean }>({ action: 'status', business_id: businessId })
        .then((result) => {
          setConnectionState(result.connection_state ?? '')
          setInstanceExists(result.instance_exists === true)
          if (isWhatsAppConnected(result.connection_state)) {
            setQrImage(null)
            setPairingCode(null)
            setPairingError(null)
            void refreshLoadedConversations()
          }
        })
        .catch(() => undefined)
    }, 4000)
    return () => window.clearInterval(interval)
  }, [businessId, configured, pairingCode, qrImage, refreshLoadedConversations])

  useEffect(() => { if (configured) void loadConversations() }, [configured, loadConversations])
  useEffect(() => { setView(searchParams.get('view') === 'calls' ? 'calls' : 'conversations') }, [searchParams])
  const loadCalls = useCallback(async () => {
    if (!configured) return
    setCallsLoading(true)
    setCallsError(null)
    try {
      const result = await invokeInbox<CallListResponse>({ action: 'calls', business_id: businessId })
      setCalls(result.calls ?? [])
    } catch {
      setCallsError('Não foi possível carregar o registro de chamadas.')
    } finally {
      setCallsLoading(false)
    }
  }, [businessId, configured])
  useEffect(() => { if (configured && view === 'calls') void loadCalls() }, [configured, loadCalls, view])
  useEffect(() => {
    if (!configured || view !== 'calls') return
    const interval = window.setInterval(() => { void loadCalls() }, 30_000)
    return () => window.clearInterval(interval)
  }, [configured, loadCalls, view])

  useEffect(() => {
    if (!configured) return
    const interval = window.setInterval(() => {
      void refreshLoadedConversations()
      void loadBusinessContext()
    }, 30_000)
    return () => window.clearInterval(interval)
  }, [configured, loadBusinessContext, refreshLoadedConversations])

  useEffect(() => { void loadBusinessContext() }, [loadBusinessContext])

  useEffect(() => {
    if (detailLoading || selectedConversation?.id !== selectedId) return
    const historyElement = messageHistoryRef.current
    if (historyElement) historyElement.scrollTop = historyElement.scrollHeight
  }, [detailLoading, selectedConversation?.id, selectedId])

  useEffect(() => {
    if (!selectedId || !configured) {
      setSelectedConversation(null)
      setHistoryHasMore(false)
      setOlderMessagesError(null)
      setOlderMessagesNotice(null)
      return
    }
    let active = true
    const request = ++detailRequest.current
    async function loadConversation() {
      setSelectedConversation(null)
      setDetailLoading(true)
      setDetailError(null)
      setHistoryHasMore(false)
      setOlderMessagesError(null)
      setOlderMessagesNotice(null)
      try {
        const result = await invokeInbox<ConversationDetailResponse>({ action: 'conversation', business_id: businessId, conversationId: selectedId })
        let conversation = result.conversation ?? null
        if (active && detailRequest.current === request) setHistoryHasMore(result.meta?.has_more === true)
        if (active && detailRequest.current === request && conversation && conversation.unread_count > 0) {
          try {
            const readResult = await invokeInbox<{ conversation?: Conversation }>({ action: 'mark_read', business_id: businessId, conversationId: selectedId })
            conversation = readResult.conversation ?? { ...conversation, unread_count: 0 }
            setConversations((current) => current.map((item) => item.id === selectedId ? { ...item, unread_count: 0 } : item))
          } catch {
            setActionError('A conversa abriu, mas não foi possível atualizar o estado de leitura.')
          }
        }
        if (active && detailRequest.current === request) setSelectedConversation(conversation)
      } catch {
        if (active && detailRequest.current === request) setDetailError('Não foi possível abrir esta conversa. Atualize a lista e tente novamente.')
      } finally {
        if (active && detailRequest.current === request) setDetailLoading(false)
      }
    }
    void loadConversation()
    setMessageDraft('')
    setActionError(null)
    setLinkError(null)
    setLinkMessage(null)
    return () => { active = false }
  }, [businessId, configured, selectedId])

  useEffect(() => {
    if (!selectedId || !configured) return
    let active = true
    const refreshMessageStatuses = async () => {
      try {
        const result = await invokeInbox<MessageStatusesResponse>({
          action: 'message_statuses', business_id: businessId, conversationId: selectedId,
        })
        if (!active || !result.statuses?.length) return
        const statuses = new Map(result.statuses.map((item) => [item.id, item.status]))
        setSelectedConversation((current) => {
          if (!current || current.id !== selectedId) return current
          let changed = false
          const messages = current.messages.map((message) => {
            const status = statuses.get(message.id)
            if (status === undefined || status === message.status) return message
            changed = true
            return { ...message, status }
          })
          const lastMessage = current.last_message ? (() => {
            const status = statuses.get(current.last_message.id)
            if (status === undefined || status === current.last_message.status) return current.last_message
            changed = true
            return { ...current.last_message, status }
          })() : current.last_message
          return changed ? { ...current, messages, last_message: lastMessage } : current
        })
      } catch {
        // Keep the conversation usable if the small status refresh is temporarily unavailable.
      }
    }
    void refreshMessageStatuses()
    const interval = window.setInterval(() => { void refreshMessageStatuses() }, 5000)
    return () => { active = false; window.clearInterval(interval) }
  }, [businessId, configured, selectedId])

  const selectedLink = selectedId ? links[selectedId] : undefined
  const currentConversation = selectedConversation?.id === selectedId
    ? selectedConversation
    : null

  useEffect(() => {
    setDisplayNameDraft(currentConversation?.display_name_override ?? '')
    setContactPreferencesError(null)
    setContactPreferencesMessage(null)
  }, [currentConversation?.display_name_override, selectedId])

  async function handleLoadOlderMessages() {
    if (!currentConversation || !historyHasMore || olderMessagesLoading) return
    const beforeMessageId = currentConversation.messages[0]?.id
    if (!beforeMessageId) {
      setHistoryHasMore(false)
      return
    }
    setOlderMessagesLoading(true)
    setOlderMessagesError(null)
    const historyElement = messageHistoryRef.current
    const previousScrollHeight = historyElement?.scrollHeight ?? 0
    try {
      const result = await invokeInbox<OlderMessagesResponse>({
        action: 'older_messages',
        business_id: businessId,
        conversationId: currentConversation.id,
        beforeMessageId,
      })
      const olderMessages = result.messages ?? []
      setOlderMessagesNotice(result.meta?.notice ?? (olderMessages.length === 0 ? 'Não há mensagens anteriores disponíveis nesta conversa.' : null))
      setSelectedConversation((current) => {
        if (!current || current.id !== currentConversation.id) return current
        const knownIds = new Set(current.messages.map((message) => message.id))
        const combined = [...olderMessages.filter((message) => !knownIds.has(message.id)), ...current.messages]
        combined.sort((left, right) => (left.created_at ?? '').localeCompare(right.created_at ?? '') || left.id.localeCompare(right.id))
        return { ...current, messages: combined }
      })
      setHistoryHasMore(result.meta?.has_more === true && olderMessages.length > 0)
      window.requestAnimationFrame(() => {
        if (historyElement) historyElement.scrollTop += historyElement.scrollHeight - previousScrollHeight
      })
    } catch {
      setOlderMessagesError('Não foi possível carregar mensagens anteriores. Tente novamente.')
      setOlderMessagesNotice(null)
    } finally {
      setOlderMessagesLoading(false)
    }
  }

  async function handleReactToMessage(messageId: string, emoji: string) {
    if (!currentConversation?.can_reply || reactionSavingMessageId) return
    const targetMessage = currentConversation.messages.find((message) => message.id === messageId)
    if (!targetMessage || targetMessage.private || targetMessage.message_type === 'activity') return
    setReactionSavingMessageId(messageId)
    setActionError(null)
    try {
      await invokeInbox({ action: 'react', business_id: businessId, conversationId: currentConversation.id, messageId, emoji })
      setSelectedConversation((current) => {
        if (!current || current.id !== currentConversation.id) return current
        return {
          ...current,
          messages: current.messages.map((message) => {
            if (message.id !== messageId) return message
            const reactions = [...(message.reactions ?? [])]
            const ownIndex = reactions.findIndex((reaction) => reaction.from_me)
            if (ownIndex >= 0) {
              const ownReaction = reactions[ownIndex]
              if (ownReaction.emoji === emoji) return message
              reactions.splice(ownIndex, 1, { ...ownReaction, count: ownReaction.count - 1, from_me: false })
              if (reactions[ownIndex].count <= 0) reactions.splice(ownIndex, 1)
            }
            if (emoji) {
              const nextIndex = reactions.findIndex((reaction) => reaction.emoji === emoji)
              if (nextIndex >= 0) reactions[nextIndex] = { ...reactions[nextIndex], count: reactions[nextIndex].count + 1, from_me: true }
              else reactions.push({ emoji, count: 1, from_me: true })
            }
            return { ...message, reactions }
          }),
        }
      })
    } catch {
      setActionError('Não foi possível reagir à mensagem. Confira a conexão e tente novamente.')
    } finally {
      setReactionSavingMessageId(null)
    }
  }
  const [customerDraft, setCustomerDraft] = useState('')
  const [orderDraft, setOrderDraft] = useState('')
  const conversationContextNeedsSave = customerDraft !== (selectedLink?.customer_id ?? '')
    || orderDraft !== (selectedLink?.order_id ?? '')

  useEffect(() => {
    setCustomerDraft(selectedLink?.customer_id ?? '')
    setOrderDraft(selectedLink?.order_id ?? '')
  }, [selectedId, selectedLink?.customer_id, selectedLink?.order_id])

  useEffect(() => {
    let active = true
    async function loadOrders() {
      setOrders([])
      if (!customerDraft || !supabaseClient) return
      const { data, error } = await supabaseClient.from('orders')
        .select('id, created_at, status, total_cents')
        .eq('business_id', businessId)
        .eq('customer_id', customerDraft)
        .order('created_at', { ascending: false })
        .limit(50)
      if (active && !error) setOrders((data ?? []) as Order[])
    }
    void loadOrders()
    return () => { active = false }
  }, [businessId, customerDraft])

  const phoneMatches = useMemo(() => {
    const phone = canonicalBrazilPhone(currentConversation?.contact.phone)
    if (!phone) return []
    return customers.filter((customer) => [customer.whatsapp_phone, customer.phone]
      .some((value) => canonicalBrazilPhone(value) === phone))
  }, [customers, currentConversation?.contact.phone])

  useEffect(() => {
    if (selectedLink?.match_method === 'manual' || selectedLink?.customer_id || phoneMatches.length !== 1) return
    setCustomerDraft(phoneMatches[0].id)
  }, [phoneMatches, selectedLink?.customer_id, selectedLink?.match_method])

  const conversationTimeline = useMemo(() => {
    if (!currentConversation) return []
    return [
      ...currentConversation.messages.map((message) => ({ kind: 'message' as const, sortAt: message.created_at ?? '', message })),
      ...(currentConversation.calls ?? []).map((call) => ({ kind: 'call' as const, sortAt: call.occurred_at, call })),
    ].sort((left, right) => left.sortAt.localeCompare(right.sortAt))
  }, [currentConversation])

  function changeStatusFilter(nextStatus: InboxStatus) {
    const nextScope = conversationScopeKey(nextStatus, search, segment)
    if (nextScope === activeListScope.current) return
    activeListScope.current = nextScope
    refreshScopeInFlight.current = null
    listRequest.current += 1
    setConversations([])
    setLoadedListScope(null)
    setListRefreshing(false)
    setListPage(1)
    setHasMore(false)
    setListError(null)
    setSelectedId(null)
    setStatus(nextStatus)
  }

  function changeContactSegment(nextSegment: ContactListSegment) {
    const nextScope = conversationScopeKey(status, search, nextSegment)
    if (nextScope === activeListScope.current) return
    activeListScope.current = nextScope
    refreshScopeInFlight.current = null
    listRequest.current += 1
    setConversations([])
    setLoadedListScope(null)
    setListRefreshing(false)
    setListPage(1)
    setHasMore(false)
    setListError(null)
    setSelectedId(null)
    setSelectedConversation(null)
    setSegment(nextSegment)
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextSearch = searchInput.trim()
    const nextScope = conversationScopeKey(status, nextSearch, segment)
    if (nextScope === activeListScope.current) {
      await refreshLoadedConversations()
      return
    }
    activeListScope.current = nextScope
    refreshScopeInFlight.current = null
    listRequest.current += 1
    setConversations([])
    setLoadedListScope(null)
    setListRefreshing(false)
    setListPage(1)
    setHasMore(false)
    setListError(null)
    setSelectedId(null)
    setSearch(nextSearch)
  }

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!currentConversation || !messageDraft.trim() || !currentConversation.can_reply) return
    setSending(true)
    setActionError(null)
    try {
      await invokeInbox({ action: 'send', business_id: businessId, conversationId: currentConversation.id, content: messageDraft.trim() })
      setMessageDraft('')
      await refreshLoadedConversations()
    } catch {
      setActionError('A mensagem não foi enviada. Confira a conexão e tente novamente.')
    } finally {
      setSending(false)
    }
  }

  async function handleSendMedia(file: File | undefined) {
    if (!file || !currentConversation || !currentConversation.can_reply || mediaSending) return
    const supportedTypes = new Set([
      'image/jpeg', 'image/png', 'image/webp', 'audio/aac', 'audio/mpeg', 'audio/mp4',
      'audio/ogg', 'audio/wav', 'audio/webm', 'video/mp4', 'application/pdf',
    ])
    if (!supportedTypes.has(file.type.toLowerCase())) {
      setActionError('Tipo de arquivo não suportado. Use imagem, áudio, vídeo MP4 ou PDF.')
      return
    }
    if (file.size < 1 || file.size > 2 * 1024 * 1024) {
      setActionError('O arquivo precisa ter até 2 MiB.')
      return
    }
    setMediaSending(true)
    setActionError(null)
    try {
      const mediaBase64 = await fileToBase64(file)
      await invokeInbox({
        action: 'send_media', business_id: businessId, conversationId: currentConversation.id,
        mediaBase64, mimeType: file.type, fileName: file.name, caption: messageDraft.trim(),
      })
      setMessageDraft('')
      await refreshLoadedConversations()
    } catch {
      setActionError('O arquivo não foi enviado. Confira a conexão e tente novamente.')
    } finally {
      setMediaSending(false)
      if (mediaPicker.current) mediaPicker.current.value = ''
    }
  }

  async function handleStatusChange(nextStatus: 'open' | 'resolved') {
    if (!currentConversation) return
    setStatusSaving(true)
    setActionError(null)
    try {
      const result = await invokeInbox<{ conversation?: Conversation }>({ action: 'set_status', business_id: businessId, conversationId: currentConversation.id, status: nextStatus })
      setSelectedConversation(result.conversation ?? { ...currentConversation, status: nextStatus })
      await refreshLoadedConversations()
    } catch {
      setActionError('Não foi possível atualizar o status desta conversa.')
    } finally {
      setStatusSaving(false)
    }
  }

  async function handleContactPreferences(
    preferences: Partial<Pick<Conversation, 'display_name_override' | 'contact_classification' | 'hidden_from_inbox'>>,
    nextSegment?: ContactListSegment,
    successMessage = 'Contato atualizado.',
  ) {
    if (role !== 'owner' || !currentConversation || contactPreferencesSaving) return
    setContactPreferencesSaving(true)
    setContactPreferencesError(null)
    setContactPreferencesMessage(null)
    try {
      await invokeInbox({
        action: 'update_contact_preferences',
        business_id: businessId,
        conversationId: currentConversation.id,
        ...preferences,
      })
      if (nextSegment) {
        setSelectedId(null)
        setSelectedConversation(null)
        changeContactSegment(nextSegment)
        setContactListFeedback(successMessage)
      } else {
        await refreshLoadedConversations()
      }
      setContactPreferencesMessage(successMessage)
    } catch {
      setContactPreferencesError('Não foi possível salvar as alterações deste contato. Tente novamente.')
    } finally {
      setContactPreferencesSaving(false)
    }
  }

  async function handleSaveDisplayName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!currentConversation) return
    await handleContactPreferences({ display_name_override: displayNameDraft.trim() }, undefined, 'Nome salvo neste sistema.')
  }

  function segmentForRestoredConversation(conversation: Conversation): ContactListSegment {
    return conversation.contact_classification === 'customer' ? 'customers' : 'conversations'
  }

  async function handleConfigureWebhook() {
    if (role !== 'owner' || webhookSaving) return
    setWebhookSaving(true)
    setWebhookFeedback(null)
    try {
      await invokeInbox({ action: 'configure_webhook', business_id: businessId })
      setWebhookFeedback('Configuração enviada. Envie uma mensagem de teste para confirmar o recebimento.')
    } catch {
      setWebhookFeedback('Não foi possível configurar o recebimento. Confira a URL e os secrets do servidor.')
    } finally {
      setWebhookSaving(false)
    }
  }

  async function handleCheckConnection() {
    setConnectionChecking(true)
    setConnectionError(null)
    try {
      const result = await invokeInbox<{ configured?: boolean; connection_state?: string; instance_exists?: boolean }>({ action: 'status', business_id: businessId })
      setConfigured(result.configured === true)
      setConnectionState(result.connection_state ?? '')
      setInstanceExists(result.instance_exists === true)
    } catch {
      setConnectionError('Não foi possível consultar a Evolution. Confira se o computador e o túnel estão ligados.')
      setConnectionState('unavailable')
    } finally {
      setConnectionChecking(false)
    }
  }

  async function handleConnectWhatsApp(method: 'qr' | 'phone' = 'qr') {
    if (role !== 'owner' || pairingLoading) return
    setPairingLoading(true)
    setPairingError(null)
    setQrImage(null)
    setPairingCode(null)
    try {
      const result = await invokeInbox<{ qr_image?: string; pairing_code?: string; connection_state?: string; instance_exists?: boolean; connected?: boolean; error?: string }>({
        action: 'connect', business_id: businessId,
        pairing_method: method,
        ...(method === 'phone' ? { phone_number: pairingPhone } : {}),
      })
      if (result.instance_exists) setInstanceExists(true)
      if (result.connected) {
        setQrImage(null)
        setConnectionState(result.connection_state ?? 'open')
        setPairingError(null)
        setWebhookFeedback('WhatsApp já está conectado. As conversas serão atualizadas agora.')
        await refreshLoadedConversations()
        return
      }
      if (result.error === 'webhook_setup_failed') {
        setPairingError('A instância foi criada, mas o webhook não ficou pronto. Tente novamente; o telefone ainda não foi pareado.')
        return
      }
      if (result.error === 'invalid_pairing_phone') {
        setPairingError('Informe o número completo com DDI, por exemplo +55 21 99999-9999.')
        return
      }
      if (method === 'phone' && result.pairing_code) {
        setPairingCode(result.pairing_code)
        setConnectionState(result.connection_state ?? 'connecting')
        setInstanceExists(true)
        setWebhookFeedback('Código de pareamento pronto. Digite-o no WhatsApp do número informado.')
        return
      }
      if (method === 'phone') {
        setPairingError('A Evolution não forneceu o código de pareamento. Confira o número e tente novamente; o QR continua disponível como alternativa.')
        return
      }
      if (result.error === 'qrcode_unavailable' || !result.qr_image) {
        setPairingError('A instância e o webhook estão prontos, mas a Evolution ainda não forneceu o QR. Tente novamente em alguns segundos; nada será pareado sem escanear o código.')
        return
      }
      setQrImage(result.qr_image)
      setConnectionState(result.connection_state ?? 'connecting')
      setInstanceExists(true)
      setWebhookFeedback('Evolution pronta. Escaneie o QR Code com o WhatsApp para concluir a conexão.')
    } catch {
      setPairingError(method === 'phone'
        ? 'Não foi possível falar com a Evolution. Confira o número e tente novamente; você também pode conectar pelo QR Code.'
        : 'Não foi possível falar com a Evolution. A instância pode ter sido criada; tente novamente.')
    } finally {
      setPairingLoading(false)
    }
  }

  async function handleDisconnectWhatsApp() {
    if (role !== 'owner' || disconnecting || !window.confirm('Desconectar o número atual? O histórico continuará salvo e você poderá parear outro número.')) return
    setDisconnecting(true)
    setPairingError(null)
    setWebhookFeedback(null)
    try {
      const result = await invokeInbox<{ connection_state?: string }>({ action: 'disconnect', business_id: businessId })
      setQrImage(null)
      setPairingCode(null)
      setConnectionState(result.connection_state ?? 'close')
      setWebhookFeedback('Número desconectado. Conecte outro número pelo QR Code ou por código de pareamento.')
    } catch {
      setPairingError('Não foi possível desconectar o número. Confira se a Evolution está acessível e tente novamente.')
    } finally {
      setDisconnecting(false)
    }
  }

  async function handleSaveLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const client = supabaseClient
    if (!client || !currentConversation || role !== 'owner') return
    setLinkSaving(true)
    setLinkError(null)
    setLinkMessage(null)
    const { data: authData, error: authError } = await client.auth.getUser()
    if (authError || !authData.user) {
      setLinkSaving(false)
      setLinkError('Sua sessão expirou. Entre novamente para salvar o vínculo.')
      return
    }
    const row = {
      business_id: businessId,
      conversation_id: currentConversation.id,
      customer_id: customerDraft || null,
      order_id: orderDraft || null,
      match_method: !selectedLink?.customer_id && phoneMatches.length === 1 && customerDraft === phoneMatches[0].id ? 'phone' as const : 'manual' as const,
      updated_by: authData.user.id,
    }
    const result = await client.from('whatsapp_conversation_contexts')
      .upsert(row, { onConflict: 'business_id,conversation_id' })
      .select('conversation_id, customer_id, order_id, match_method')
      .single()
    setLinkSaving(false)
    if (result.error || !result.data) {
      setLinkError('Não foi possível salvar o vínculo. Confira a seleção e tente novamente.')
      return
    }
    const saved = result.data as ConversationLink
    setLinks((current) => ({ ...current, [saved.conversation_id]: saved }))
    setLinkMessage('Vínculo salvo para esta conversa.')
  }

  const showConversationListLoading = !listError && (
    loadedListScope !== currentListScope || listLoading && conversations.length === 0
  )
  const showConversationListEmpty = loadedListScope === currentListScope
    && !listLoading && !listError && conversations.length === 0
  const showConversationListRefreshing = listRefreshing
    && loadedListScope === currentListScope && conversations.length > 0

  const connectedScreen = connectionChecking ? (
    <section className="surface-panel whatsapp-connection-state" role="status"><span className="empty-icon"><Icon name="clock" /></span><h2>Verificando a conexão segura…</h2><p>O Shalom consulta a Evolution API no servidor.</p></section>
  ) : !configured ? (
    <section className="surface-panel whatsapp-connection-state" aria-labelledby="whatsapp-pending-title">
      <span className="empty-icon"><Icon name="message" /></span>
      <p className="eyebrow">{connectionError ? 'CONEXÃO INDISPONÍVEL' : 'ETAPA 1 · CAIXA DE ENTRADA'}</p>
      <h2 id="whatsapp-pending-title">{connectionError ? 'Não foi possível verificar a integração' : 'A caixa está pronta; falta configurar a Evolution API'}</h2>
      <p>{connectionError ?? 'Esta tela reúne conversas e chamadas recebidas pela Evolution API. Configure os secrets do servidor e conecte um número de teste para começar.'}</p>
      <ol className="whatsapp-setup-steps">
        <li><span>1</span><div><strong>Configurar a conexão segura</strong><small>Endereço e chave da Evolution ficam nos secrets do servidor, nunca no navegador.</small></div><span className="neutral-status">Pendente</span></li>
        <li><span>2</span><div><strong>Configurar o webhook</strong><small>O Supabase precisa receber eventos por uma rede local compartilhada ou endpoint HTTPS seguro.</small></div><span className="neutral-status">Pendente</span></li>
        <li><span>3</span><div><strong>Conectar um número de teste</strong><small>Depois, validar mensagens, chamadas, arquivos e identificação por telefone.</small></div><span className="neutral-status">Pendente</span></li>
      </ol>
      {connectionError && <button className="button button-secondary" onClick={() => { setConnectionChecking(true); setConnectionError(null); void invokeInbox<{ configured?: boolean; connection_state?: string; instance_exists?: boolean }>({ action: 'status', business_id: businessId }).then((result) => { setConfigured(result.configured === true); setConnectionState(result.connection_state ?? ''); setInstanceExists(result.instance_exists === true) }).catch(() => setConnectionError('Não foi possível verificar a conexão com o servidor.')).finally(() => setConnectionChecking(false)) }} type="button">Tentar novamente</button>}
      <Link className="quiet-link" to="/configuracoes">Ver preparação da conexão <Icon name="arrow" /></Link>
    </section>
  ) : (
    <section className="whatsapp-inbox" aria-label="Caixa de entrada WhatsApp">
      <div className="surface-panel whatsapp-connection-banner">
        <span className={`whatsapp-connection-dot${isWhatsAppConnected(connectionState) ? ' is-connected' : ''}`} aria-hidden="true" />
        <div><strong>Evolution API</strong><span role="status">{connectionStateLabel(connectionState)}</span></div>
        {webhookFeedback && <span className="whatsapp-webhook-feedback" role="status">{webhookFeedback}</span>}
        {connectionState.toLowerCase() === 'unavailable' && <span className="whatsapp-webhook-feedback" role="alert">Ligue a Evolution e tente verificar novamente.</span>}
        {role === 'owner' && connectionState.toLowerCase() === 'unavailable' && <button className="button button-secondary" disabled={connectionChecking} onClick={() => void handleCheckConnection()} type="button">{connectionChecking ? 'Verificando…' : 'Verificar conexão'}</button>}
        {role === 'owner' && !isWhatsAppConnected(connectionState) && connectionState.toLowerCase() !== 'unavailable' && <button className="button button-primary" disabled={pairingLoading} onClick={() => void handleConnectWhatsApp()} type="button">{pairingLoading ? 'Preparando…' : instanceExists ? 'Conectar número' : 'Criar e conectar WhatsApp'}</button>}
        {role === 'owner' && isWhatsAppConnected(connectionState) && <button className="button button-secondary" disabled={disconnecting} onClick={() => void handleDisconnectWhatsApp()} type="button">{disconnecting ? 'Desconectando…' : 'Desconectar / trocar número'}</button>}
        {role === 'owner' && instanceExists && <button className="button button-secondary" disabled={webhookSaving} onClick={() => void handleConfigureWebhook()} type="button">{webhookSaving ? 'Configurando…' : 'Reconfigurar recebimento'}</button>}
      </div>
      {pairingError && <div className="inline-state inline-state-error" role="alert">{pairingError}</div>}
      {role === 'owner' && !isWhatsAppConnected(connectionState) && connectionState.toLowerCase() !== 'unavailable' && <details className="surface-panel whatsapp-phone-pairing">
        <summary>Conectar usando número e código</summary>
        <p>Informe o número com DDI. Depois, no WhatsApp desse celular, abra <strong>Aparelhos conectados</strong> e escolha <strong>Conectar com número de telefone</strong>.</p>
        <form onSubmit={(event) => { event.preventDefault(); void handleConnectWhatsApp('phone') }}>
          <label htmlFor="whatsapp-pairing-phone">Número do WhatsApp com DDI</label>
          <input autoComplete="tel" id="whatsapp-pairing-phone" inputMode="tel" onChange={(event) => setPairingPhone(event.target.value)} placeholder="+55 21 99999-9999" required type="tel" value={pairingPhone} />
          <button className="button button-secondary" disabled={pairingLoading || !pairingPhone.trim()} type="submit">{pairingLoading ? 'Gerando código…' : 'Gerar código de pareamento'}</button>
        </form>
        {pairingCode && <div className="whatsapp-pairing-code" role="status"><span>Código de pareamento</span><strong>{pairingCode}</strong><small>Digite este código no WhatsApp do número informado. A conexão será confirmada automaticamente.</small></div>}
      </details>}
      {qrImage && <section className="surface-panel whatsapp-qr-panel" aria-labelledby="whatsapp-qr-title" aria-live="polite">
        <div><p className="eyebrow">PAREAMENTO EXPLÍCITO</p><h2 id="whatsapp-qr-title">Escaneie com o WhatsApp</h2><p>Abra esta página em outro dispositivo. No telefone com o número que deseja usar, abra <strong>Aparelhos conectados</strong> e escaneie o código. Para trocar de número depois, desconecte o atual nesta tela e repita o pareamento.</p></div>
        <img alt="QR Code temporário para conectar o WhatsApp" src={qrImage} />
        <button className="button button-secondary" disabled={pairingLoading} onClick={() => void handleConnectWhatsApp()} type="button">Atualizar QR Code</button>
      </section>}
      <aside className={`surface-panel whatsapp-conversation-panel${selectedId ? ' is-mobile-hidden' : ''}`} aria-label="Lista de conversas">
        <div className="whatsapp-list-heading">
          <div><p className="eyebrow">EVOLUTION API · WHATSAPP</p><h2>{view === 'calls' ? 'Chamadas' : 'Conversas'}</h2></div>
          <button aria-label={view === 'calls' ? 'Atualizar chamadas' : 'Atualizar conversas'} className="icon-button" disabled={view === 'calls' ? callsLoading : listLoading} onClick={() => view === 'calls' ? void loadCalls() : void refreshLoadedConversations()} type="button"><Icon name="clock" /></button>
        </div>
        <div className="whatsapp-inbox-kind-tabs" aria-label="Tipo de atendimento" role="group">
          <button aria-pressed={view === 'conversations'} onClick={() => changeView('conversations')} type="button">Conversas</button>
          <button aria-pressed={view === 'calls'} onClick={() => changeView('calls')} type="button">Chamadas</button>
        </div>
        {view === 'calls' ? (
          <>
            {callsError && <div className="inline-state inline-state-error" role="alert"><p>{callsError}</p><button className="text-button" onClick={() => void loadCalls()} type="button">Tentar novamente</button></div>}
            {callsLoading && <p className="inline-state" role="status">Carregando chamadas…</p>}
            {!callsLoading && !callsError && calls.length === 0 && <div className="whatsapp-list-empty"><Icon name="message" /><strong>Nenhuma chamada registrada</strong><span>Chamadas recebidas pela Evolution aparecerão aqui quando o evento estiver disponível.</span></div>}
            <ul className="whatsapp-conversation-list">
              {calls.map((call) => <li key={call.id}><button className="whatsapp-conversation-item" onClick={() => { setContactListFeedback(null); setSelectedConversation(null); setSelectedId(call.conversation_id) }} type="button">
                <span className="whatsapp-contact-avatar" aria-hidden="true">{call.is_video ? 'V' : '☎'}</span>
                <span className="whatsapp-conversation-copy"><strong>{call.contact.name || call.customer_name || 'Contato sem identificação'}</strong><small>{call.contact.phone || 'Telefone não informado'} · {call.status_label}{call.is_video ? ' · vídeo' : ''}{(call.event_count ?? 1) > 1 ? ` · ${call.event_count} eventos` : ''}</small><small>{contactClassificationLabel(call.contact_classification)}</small></span>
                <span className="whatsapp-conversation-meta"><time>{timestampLabel(call.occurred_at)}</time>{call.hidden_from_inbox && <span>Oculta</span>}</span>
              </button></li>)}
            </ul>
            <p className="whatsapp-call-note">Eventos agrupados pelo identificador enviado pela Evolution. O Shalom não grava áudio nem atende chamadas pelo navegador.</p>
          </>
        ) : <>
        <form className="whatsapp-search" onSubmit={(event) => void handleSearch(event)} role="search">
          <Icon name="search" />
          <input aria-label="Buscar no conteúdo das mensagens" onChange={(event) => setSearchInput(event.target.value)} placeholder="Buscar mensagem" value={searchInput} />
          <button className="text-button" type="submit">Buscar</button>
        </form>
        <div className="whatsapp-status-tabs whatsapp-contact-segment-tabs" aria-label="Filtrar contatos" role="group">
          {([
            ['conversations', 'Conversas'], ['customers', 'Clientes'], ['hidden', 'Ocultas'],
          ] as const).map(([item, label]) => <button aria-pressed={segment === item} key={item} onClick={() => { setContactListFeedback(null); changeContactSegment(item) }} type="button">{label}</button>)}
        </div>
        {contactListFeedback && <p className="whatsapp-contact-feedback" role="status">{contactListFeedback}</p>}
        <div className="whatsapp-status-tabs" aria-label="Filtrar conversas por status">
          {(['open', 'resolved', 'all'] as const).map((item) => <button aria-pressed={status === item} key={item} onClick={() => changeStatusFilter(item)} type="button">{item === 'open' ? 'Abertas' : item === 'resolved' ? 'Resolvidas' : 'Todas'}</button>)}
        </div>
        {listError && <div className="inline-state inline-state-error" role="alert"><p>{listError}</p><button className="text-button" onClick={() => void refreshLoadedConversations()} type="button">Tentar novamente</button></div>}
        {historySyncNotice && <p className="whatsapp-history-sync-notice" role="status">{historySyncNotice}</p>}
        {showConversationListLoading && <p className="inline-state" role="status">Carregando conversas…</p>}
        {showConversationListRefreshing && <p className="inline-state" role="status">Atualizando conversas…</p>}
        {showConversationListEmpty && <div className="whatsapp-list-empty"><Icon name="message" /><strong>Nenhuma conversa nesta lista</strong><span>As conversas recebidas pelo canal conectado aparecerão aqui.</span></div>}
        {loadedListScope === currentListScope && conversations.length > 0 && (
          <ul className="whatsapp-conversation-list">
            {conversations.map((conversation) => <li key={conversation.id}>
              <button aria-current={selectedId === conversation.id ? 'true' : undefined} className={`whatsapp-conversation-item${selectedId === conversation.id ? ' is-selected' : ''}${conversation.unread_count > 0 ? ' has-unread' : ''}`} onClick={() => { setContactListFeedback(null); setSelectedConversation(null); setSelectedId(conversation.id) }} type="button">
                <WhatsAppAvatar businessId={businessId} conversation={conversation} />
                <span className="whatsapp-conversation-copy"><strong>{conversationDisplayName(conversation)}</strong>{!conversation.is_group && <small>{conversationContactSubtitle(conversation)}</small>}<small>{conversation.is_group && <span className="whatsapp-group-label">Grupo · </span>}{conversation.is_group && conversation.last_message?.message_type === 'incoming' && <>{senderDisplayName(conversation.last_message.sender, 'Participante')}: </>}{conversationMessagePreview(conversation)}</small></span>
                <span className="whatsapp-conversation-meta"><span className="whatsapp-conversation-meta-top"><time>{timestampLabel(conversation.last_activity_at)}</time>{conversation.unread_count > 0 && <span aria-label={`${conversation.unread_count} mensagens não lidas`} className="whatsapp-unread-count">{conversation.unread_count > 99 ? '99+' : conversation.unread_count}</span>}</span>{conversation.contact_classification !== 'unclassified' && <span className="whatsapp-linked-mark">{contactClassificationLabel(conversation.contact_classification)}</span>}{links[conversation.id]?.customer_id && <span className="whatsapp-linked-mark">Cliente vinculado</span>}</span>
              </button>
            </li>)}
          </ul>
        )}
        {hasMore && <button className="button button-secondary whatsapp-load-more" disabled={listLoading} onClick={() => void loadConversations(listPage + 1, true)} type="button">{listLoading ? 'Carregando…' : 'Carregar mais conversas'}</button>}
        </>}
      </aside>

      <section className={`surface-panel whatsapp-chat-panel${selectedId ? ' is-mobile-visible' : ''}`} aria-label="Conversa selecionada">
        {!selectedId ? <div className="whatsapp-chat-empty"><Icon name="message" /><h2>Selecione uma conversa</h2><p>O histórico e as ações aparecem aqui.</p></div> : <>
          <header className="whatsapp-chat-heading">
            <button className="text-button whatsapp-back-button" onClick={() => setSelectedId(null)} type="button">← Conversas</button>
            <div className="whatsapp-chat-contact"><WhatsAppAvatar businessId={businessId} conversation={currentConversation} /><div><h2>{conversationDisplayName(currentConversation, detailLoading)}</h2><span>{currentConversation ? conversationContactSubtitle(currentConversation) : 'Contato carregando'}</span></div></div>
            <div className="whatsapp-chat-actions">
              <span className={`whatsapp-status-pill${currentConversation?.status === 'open' ? '' : ' is-resolved'}`}>{statusLabel(currentConversation?.status)}</span>
              <button className="button button-secondary" disabled={statusSaving || !currentConversation || !['open', 'resolved'].includes(currentConversation.status)} onClick={() => void handleStatusChange(currentConversation?.status === 'resolved' ? 'open' : 'resolved')} type="button">{statusSaving ? 'Salvando…' : currentConversation?.status === 'resolved' ? 'Reabrir' : 'Resolver'}</button>
            </div>
          </header>

          <details className="whatsapp-context-disclosure" key={`contact-preferences-${selectedId}`}>
            <summary><span><strong>Identificação e lista</strong><small>Nome e classificação deste contato</small></span><span className="whatsapp-context-status">{contactClassificationLabel(currentConversation?.contact_classification)}</span></summary>
            <form className="whatsapp-context-panel" onSubmit={(event) => void handleSaveDisplayName(event)}>
              {contactPreferencesError && <p className="form-message form-message-error" role="alert">{contactPreferencesError}</p>}
              {contactPreferencesMessage && <p className="form-message form-message-success" role="status">{contactPreferencesMessage}</p>}
              <label className="whatsapp-context-field"><span>Nome neste sistema</span><input autoComplete="off" className="text-input" disabled={!currentConversation || role !== 'owner' || contactPreferencesSaving} maxLength={160} onChange={(event) => setDisplayNameDraft(event.target.value)} placeholder={currentConversation?.is_group ? 'Nome do grupo' : 'Nome salvo para esta conversa'} value={displayNameDraft} /></label>
              {role === 'owner' ? <button className="button button-secondary" disabled={!currentConversation || contactPreferencesSaving || displayNameDraft.trim() === (currentConversation?.display_name_override ?? '')} type="submit">{contactPreferencesSaving ? 'Salvando…' : 'Salvar nome'}</button> : <p className="section-footnote">Somente a gestão pode alterar o nome e a classificação.</p>}
              <p className="whatsapp-match-hint">O nome fica salvo no Shalom e tem prioridade sobre o nome recebido da Evolution. O telefone, quando confiável, aparece separado. A classificação não cria nem altera cadastro de cliente.</p>
              {role === 'owner' && currentConversation && <>
                {!currentConversation.hidden_from_inbox && currentConversation.contact_classification !== 'customer' && <button className="button button-secondary" disabled={contactPreferencesSaving} onClick={() => void handleContactPreferences({ contact_classification: 'customer', hidden_from_inbox: false }, 'customers', 'Contato movido para Clientes.')} type="button">Marcar como cliente</button>}
                {!currentConversation.hidden_from_inbox && currentConversation.contact_classification === 'customer' && <button className="button button-secondary" disabled={contactPreferencesSaving} onClick={() => void handleContactPreferences({ contact_classification: 'unclassified', hidden_from_inbox: false }, 'conversations', 'Contato movido para Conversas.')} type="button">Mover para conversas</button>}
                {!currentConversation.hidden_from_inbox && <button className="button button-secondary" disabled={contactPreferencesSaving} onClick={() => void handleContactPreferences({ contact_classification: 'personal', hidden_from_inbox: true }, 'hidden', 'Conversa ocultada; o histórico continua salvo.')} type="button">Marcar como pessoal e ocultar</button>}
                {currentConversation.hidden_from_inbox && <button className="button button-secondary" disabled={contactPreferencesSaving} onClick={() => void handleContactPreferences({ hidden_from_inbox: false }, segmentForRestoredConversation(currentConversation), 'Conversa restaurada.')} type="button">Restaurar conversa</button>}
              </>}
              <p className="section-footnote whatsapp-match-hint">Ocultar só tira a conversa das listas ativas do Shalom. Nenhuma mensagem é apagada, e você pode restaurá-la pela aba Ocultas.</p>
            </form>
          </details>

          {detailError && <div className="inline-state inline-state-error" role="alert">{detailError}</div>}
          <div className="whatsapp-message-history" aria-live="polite" aria-label="Histórico de mensagens" ref={messageHistoryRef}>
            {detailLoading && <p className="inline-state" role="status">Carregando histórico…</p>}
            {(historyHasMore || olderMessagesLoading || olderMessagesError || olderMessagesNotice) && <div className="whatsapp-older-messages">
              {historyHasMore && <button className="button button-secondary" disabled={olderMessagesLoading} onClick={() => void handleLoadOlderMessages()} type="button">{olderMessagesLoading ? 'Buscando mensagens…' : 'Buscar mensagens anteriores'}</button>}
              {olderMessagesError && <><p role="alert">{olderMessagesError}</p><button className="text-button" disabled={olderMessagesLoading} onClick={() => void handleLoadOlderMessages()} type="button">Tentar novamente</button></>}
              {olderMessagesNotice && <p role="status">{olderMessagesNotice}</p>}
            </div>}
            {!detailLoading && conversationTimeline.map((event) => event.kind === 'call'
              ? <article className="whatsapp-call-event" key={`call-${event.call.id}`}>
                  <span className="whatsapp-call-event-icon" aria-hidden="true">{event.call.is_video ? 'V' : '☎'}</span>
                  <div><strong>{event.call.status_label}{event.call.is_video ? ' · vídeo' : ''}</strong><time>{timestampLabel(event.call.occurred_at)}</time></div>
                  <small>Registro do provedor</small>
                </article>
              : <article className={`whatsapp-message${event.message.message_type === 'outgoing' ? ' is-outgoing' : ''}${event.message.private ? ' is-private' : ''}`} key={`message-${event.message.id}`}>
                  {event.message.private && <span className="whatsapp-message-label">Nota interna</span>}
                  {event.message.content && <p>{event.message.content}</p>}
                  {!event.message.content && event.message.attachments.length === 0 && <p className="whatsapp-message-attachment">{event.message.message_type === 'activity' ? 'Atualização da conversa' : messageKindLabel(event.message.message_kind)}</p>}
                  {event.message.attachments.map((attachment) => <MessageAttachment attachment={attachment} businessId={businessId} conversationId={currentConversation?.id ?? ''} key={attachment.id} messageId={event.message.id} sticker={event.message.message_kind === 'sticker'} />)}
                  {event.message.reactions && event.message.reactions.length > 0 && <div aria-label="Reações da mensagem" className="whatsapp-message-reactions">{event.message.reactions.map((reaction) => <button aria-label={`${reaction.count} ${reaction.emoji}${reaction.from_me ? ', sua reação. Remover reação' : ''}`} aria-pressed={reaction.from_me} className={`whatsapp-reaction-chip${reaction.from_me ? ' is-mine' : ''}`} disabled={!currentConversation?.can_reply || reactionSavingMessageId === event.message.id} key={reaction.emoji} onClick={() => void handleReactToMessage(event.message.id, reaction.from_me ? '' : reaction.emoji)} type="button"><span aria-hidden="true">{reaction.emoji}</span><span>{reaction.count}</span></button>)}</div>}
                  <footer><span>{event.message.message_type === 'outgoing' ? 'Você' : senderDisplayName(event.message.sender, currentConversation?.is_group ? 'Participante' : conversationDisplayName(currentConversation))}</span><time>{timestampLabel(event.message.created_at)}</time>{event.message.message_type === 'outgoing' && !event.message.private && <MessageDeliveryIndicator status={event.message.status} />}{currentConversation?.can_reply && !event.message.private && event.message.message_type !== 'activity' && <details className="whatsapp-reaction-picker"><summary aria-label="Adicionar reação" title="Adicionar reação">☺</summary><div aria-label="Escolha uma reação" role="group">{COMMON_REACTIONS.map((emoji) => <button aria-label={`Reagir com ${emoji}`} disabled={reactionSavingMessageId === event.message.id} key={emoji} onClick={(clickEvent) => { clickEvent.currentTarget.closest('details')?.removeAttribute('open'); void handleReactToMessage(event.message.id, emoji) }} type="button">{emoji}</button>)}</div></details>}</footer>
                </article>)}
            {!detailLoading && conversationTimeline.length === 0 && <p className="whatsapp-chat-empty-history">Ainda não há mensagens ou chamadas nesta conversa.</p>}
          </div>

          {actionError && <p className="form-message form-message-error whatsapp-action-error" role="alert">{actionError}</p>}
          <form className="whatsapp-compose" onSubmit={(event) => void handleSend(event)}>
            {currentConversation && !currentConversation.can_reply && <p className="section-footnote">O canal não permite responder a esta conversa neste momento.</p>}
            <label className="visually-hidden" htmlFor="whatsapp-message-draft">Mensagem</label>
            <textarea disabled={!currentConversation?.can_reply || mediaSending} id="whatsapp-message-draft" maxLength={4000} onChange={(event) => setMessageDraft(event.target.value)} placeholder="Escreva uma mensagem…" value={messageDraft} />
            <div className="whatsapp-compose-tools"><span>{mediaSending ? 'Enviando arquivo…' : `${messageDraft.length}/4000`}</span><button className="button button-secondary whatsapp-attach-button" disabled={mediaSending || sending || !currentConversation?.can_reply} onClick={() => mediaPicker.current?.click()} type="button">Anexar arquivo</button><input accept="image/jpeg,image/png,image/webp,audio/aac,audio/mpeg,audio/mp4,audio/ogg,audio/wav,audio/webm,video/mp4,application/pdf" aria-label="Escolher imagem, áudio compatível, vídeo MP4 ou PDF de até 2 MiB" className="visually-hidden" onChange={(event) => void handleSendMedia(event.target.files?.[0])} ref={mediaPicker} type="file" /><button className="button button-primary" disabled={sending || mediaSending || !messageDraft.trim() || !currentConversation?.can_reply} type="submit">{sending ? 'Enviando…' : 'Enviar'}</button></div>
          </form>

          <details className="whatsapp-context-disclosure" key={selectedId}>
            <summary><span><strong>Contexto Shalom</strong><small>Associação opcional de cliente e pedido</small></span><span className="whatsapp-context-status">{selectedLink?.match_method === 'phone' ? 'Telefone reconhecido' : selectedLink?.customer_id ? 'Cliente vinculado' : 'Sem vínculo'}</span></summary>
            <form className="whatsapp-context-panel" onSubmit={(event) => void handleSaveLink(event)}>
            {linkError && <p className="form-message form-message-error" role="alert">{linkError}</p>}
            {linkMessage && <p className="form-message form-message-success" role="status">{linkMessage}</p>}
            {selectedLink?.match_method === 'phone' && selectedLink.customer_id && <p className="whatsapp-match-hint">Cliente identificado automaticamente por um telefone único. Você pode trocar o cadastro se precisar.</p>}
            {currentConversation && !currentConversation.contact.phone && <p className="whatsapp-match-hint">O WhatsApp não enviou um número para este contato. Vincule o cadastro manualmente para identificar esta pessoa.</p>}
            {!selectedLink?.customer_id && phoneMatches.length === 1 && customerDraft === phoneMatches[0].id && <p className="whatsapp-match-hint">Telefone único reconhecido. Salve o vínculo para manter este cliente nesta conversa.</p>}
            {phoneMatches.length > 0 && !customerDraft && <p className="whatsapp-match-hint">{phoneMatches.length === 1 ? `Telefone correspondente ao cadastro de ${phoneMatches[0].name}.` : `${phoneMatches.length} cadastros usam este telefone; escolha o cliente correto.`} {phoneMatches.length > 1 ? 'A associação precisa de escolha manual.' : 'Confira o cadastro antes de salvar.'}</p>}
            <label className="whatsapp-context-field"><span>Cliente</span><select disabled={!currentConversation || linkLoading || role !== 'owner'} onChange={(event) => { setCustomerDraft(event.target.value); setOrderDraft('') }} value={customerDraft}><option value="">Sem cliente associado</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
            {role === 'owner' && <Link className="quiet-link whatsapp-register-customer" to="/clientes">Cadastrar cliente</Link>}
            <label className="whatsapp-context-field"><span>Pedido relacionado</span><select disabled={!currentConversation || !customerDraft || role !== 'owner'} onChange={(event) => setOrderDraft(event.target.value)} value={orderDraft}><option value="">Sem pedido associado</option>{orders.map((order) => <option key={order.id} value={order.id}>{orderLabel(order)}</option>)}</select></label>
            {role === 'owner' ? <button className="button button-secondary" disabled={!currentConversation || linkSaving || linkLoading} type="submit">{linkSaving ? 'Salvando…' : 'Salvar vínculo'}</button> : <p className="section-footnote">Somente a gestão pode alterar vínculos de atendimento.</p>}
            {customerDraft && role === 'owner'
              ? conversationContextNeedsSave
                ? <p className="section-footnote whatsapp-match-hint">Salve o vínculo do cliente acima para manter a associação nesta conversa. Depois, você poderá criar o rascunho do pedido.</p>
                : <><Link className="button button-primary" to={`/pedidos/novo?cliente=${encodeURIComponent(customerDraft)}`}>Criar rascunho de pedido</Link><p className="section-footnote whatsapp-match-hint">O cliente e os dados do pedido anterior podem ser reaproveitados. O pedido só será salvo quando você revisar e confirmar no formulário.</p></>
              : <p className="section-footnote whatsapp-match-hint">{role === 'owner' ? 'Vincule um cliente acima para preparar um pedido sem sair desta conversa.' : 'Somente a gestão pode criar pedidos.'}</p>}
            </form>
          </details>
        </>}
      </section>
    </section>
  )

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">ATENDIMENTO</p>
          <h1>WhatsApp</h1>
          <p className="page-description">Conversas e registros de chamadas recebidos pela Evolution API.</p>
        </div>
        <span className="module-heading-icon"><Icon name="message" /></span>
      </header>
      {connectedScreen}
    </div>
  )
}
