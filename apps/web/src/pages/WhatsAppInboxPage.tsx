import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { supabaseClient } from '../lib/supabase'

type InboxStatus = 'open' | 'resolved' | 'all'

function conversationScopeKey(status: InboxStatus, search: string): string {
  return JSON.stringify([status, search])
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
  status: 'sent' | 'delivered' | 'read' | 'failed' | null
  private: boolean
  sender: { name: string | null }
  attachments: Attachment[]
}
type Conversation = {
  id: string
  inbox_id: string
  status: string
  can_reply: boolean
  unread_count: number
  contact: { name: string | null; phone: string | null }
  last_activity_at: string | null
  last_message: Message | null
  messages: Message[]
}
type Customer = { id: string; name: string; phone: string | null; whatsapp_phone: string | null }
type Order = { id: string; created_at: string; status: 'open' | 'cancelled'; total_cents: number }
type ConversationLink = { conversation_id: string; inbox_id: string; customer_id: string | null; order_id: string | null }
type ConversationListResponse = { conversations?: Conversation[]; meta?: { page?: number; has_more?: boolean } }

const EMPTY_CONVERSATIONS: Conversation[] = []

function digitsOnly(value: string | null | undefined) {
  return (value ?? '').replace(/\D/g, '')
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

function messageDeliveryLabel(value: Message['status']) {
  if (value === 'sent') return 'Enviada'
  if (value === 'delivered') return 'Entregue'
  if (value === 'read') return 'Lida'
  if (value === 'failed') return 'Falhou'
  return null
}

function orderLabel(order: Order) {
  const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'America/Sao_Paulo' }).format(new Date(order.created_at))
  const total = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(order.total_cents / 100)
  return `${date} · ${total} · ${order.status === 'open' ? 'ativo' : 'cancelado'}`
}

async function invokeInbox<T>(body: Record<string, unknown>) {
  if (!supabaseClient) throw new Error('A conexão segura com o Supabase não está disponível.')
  const { data, error } = await supabaseClient.functions.invoke('chatwoot-inbox', { body })
  if (error) throw error
  return data as T
}

const SAFE_INLINE_ATTACHMENT_TYPES = new Set([
  'image/jpeg', 'image/png',
  'audio/aac', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/3gpp',
  'video/mp4', 'video/webm', 'video/3gpp',
])

function attachmentName(attachment: Attachment) {
  const extension = attachment.extension && /^[a-z0-9]{1,16}$/i.test(attachment.extension)
    ? `.${attachment.extension}`
    : ''
  return `whatsapp-anexo-${attachment.id}${extension}`
}

function attachmentSizeLabel(bytes: number | null) {
  if (!bytes || bytes < 1) return ''
  const size = bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return ` · ${size}`
}

function attachmentKindLabel(attachment: Attachment) {
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

function MessageAttachment({ attachment, businessId, conversationId, messageId }: {
  attachment: Attachment
  businessId: string
  conversationId: string
  messageId: string
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [sizeRejected, setSizeRejected] = useState(false)
  const [file, setFile] = useState<{ url: string; mimeType: string } | null>(null)
  const mounted = useRef(false)
  const objectUrl = useRef<string | null>(null)
  const previewRegion = useRef<HTMLDivElement>(null)
  const loadButton = useRef<HTMLButtonElement>(null)
  const name = attachmentName(attachment)
  const tooLarge = sizeRejected || (attachment.file_size !== null && attachment.file_size > 25 * 1024 * 1024)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    }
  }, [])

  useEffect(() => {
    if (file) previewRegion.current?.focus()
    if (error) loadButton.current?.focus()
  }, [error, file])

  async function loadAttachment() {
    if (!supabaseClient || loading || file || tooLarge) return
    setLoading(true)
    setError(false)
    try {
      const { data, error: requestError, response } = await supabaseClient.functions.invoke<Blob>('chatwoot-inbox', {
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
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = null
    setFile(null)
    setError(true)
  }

  function closePreview() {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = null
    setFile(null)
    setError(false)
    window.requestAnimationFrame(() => loadButton.current?.focus())
  }

  const label = `${attachmentKindLabel(attachment)}${attachmentSizeLabel(attachment.file_size)}`
  if (!file) return (
    <div className="whatsapp-attachment">
      {tooLarge && <p className="whatsapp-attachment-error" role="alert">Este anexo excede o limite de 25 MiB.</p>}
      {!tooLarge && <button className="whatsapp-attachment-load" disabled={loading} onClick={() => void loadAttachment()} ref={loadButton} type="button">
        <Icon name="file" />
        <span>{error ? 'Não foi possível abrir · tentar novamente' : `Abrir ${label}`}</span>
      </button>}
      {loading && <span className="whatsapp-attachment-status" role="status">Carregando anexo…</span>}
      {error && <span className="whatsapp-attachment-error" role="alert">O arquivo não abriu. Você pode tentar carregar novamente.</span>}
    </div>
  )

  return (
    <div aria-label={`${label} carregado`} className="whatsapp-attachment-preview-region" ref={previewRegion} role="group" tabIndex={-1}>
      {file.mimeType.startsWith('image/') && <img className="whatsapp-attachment-preview" alt={label} loading="lazy" onError={handlePreviewError} src={file.url} />}
      {file.mimeType.startsWith('audio/') && <audio aria-label={label} className="whatsapp-attachment-audio" controls onError={handlePreviewError} preload="metadata" src={file.url}>{`Seu navegador não reproduz ${label.toLocaleLowerCase('pt-BR')}.`}</audio>}
      {file.mimeType.startsWith('video/') && <video aria-label={label} className="whatsapp-attachment-video" controls onError={handlePreviewError} playsInline preload="metadata" src={file.url}>{`Seu navegador não reproduz ${label.toLocaleLowerCase('pt-BR')}.`}</video>}
      <div className="whatsapp-attachment-actions">
        <a className="whatsapp-attachment-download" download={name} href={file.url}>Baixar {label.toLocaleLowerCase('pt-BR')}</a>
        <button className="whatsapp-attachment-close" onClick={closePreview} type="button">Fechar anexo</button>
      </div>
    </div>
  )
}

export function WhatsAppInboxPage() {
  const { id: businessId, role } = useBusiness()
  const [connectionChecking, setConnectionChecking] = useState(true)
  const [configured, setConfigured] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [status, setStatus] = useState<InboxStatus>('open')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>(EMPTY_CONVERSATIONS)
  const [loadedListScope, setLoadedListScope] = useState<string | null>(null)
  const [listPage, setListPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [listLoading, setListLoading] = useState(false)
  const [listRefreshing, setListRefreshing] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [messageDraft, setMessageDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [statusSaving, setStatusSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [links, setLinks] = useState<Record<string, ConversationLink>>({})
  const [linkLoading, setLinkLoading] = useState(false)
  const [linkSaving, setLinkSaving] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [linkMessage, setLinkMessage] = useState<string | null>(null)
  const detailRequest = useRef(0)
  const refreshScopeInFlight = useRef<{ scope: string; requestId: number } | null>(null)
  const listRequest = useRef(0)
  const activeListScope = useRef(conversationScopeKey(status, search))
  const currentListScope = conversationScopeKey(status, search)

  const loadConversations = useCallback(async (page = 1, append = false) => {
    if (!configured) return
    const requestScope = conversationScopeKey(status, search)
    if (requestScope !== activeListScope.current) return
    const requestId = ++listRequest.current
    setListLoading(true)
    setListError(null)
    try {
      const result = await invokeInbox<ConversationListResponse>({
        action: 'list', business_id: businessId, status, page, query: search || undefined,
      })
      if (requestId !== listRequest.current || requestScope !== activeListScope.current) return
      const next = result.conversations ?? []
      setConversations((current) => append ? [...current, ...next] : next)
      setLoadedListScope(requestScope)
      setListPage(page)
      setHasMore(result.meta?.has_more ?? next.length >= 25)
    } catch {
      if (requestId === listRequest.current && requestScope === activeListScope.current) {
        setListError('Não foi possível carregar as conversas. Tente novamente.')
      }
    } finally {
      if (requestId === listRequest.current) setListLoading(false)
    }
  }, [businessId, configured, search, status])

  const refreshLoadedConversations = useCallback(async () => {
    if (!configured) return
    const requestScope = conversationScopeKey(status, search)
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
          action: 'list', business_id: businessId, status, page: currentPage, query: search || undefined,
        })
        if (requestId !== listRequest.current || requestScope !== activeListScope.current) return
        const pageRows = result.conversations ?? []
        combined.push(...pageRows)
        morePages = result.meta?.has_more ?? pageRows.length >= 25
        if (currentPage >= finalPage || !morePages) break
        currentPage += 1
      }
      if (requestId !== listRequest.current || requestScope !== activeListScope.current) return
      setConversations(combined)
      setLoadedListScope(requestScope)
      setListPage(currentPage)
      setHasMore(morePages)
      if (selectedId && combined.some((conversation) => conversation.id === selectedId)) {
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
  }, [businessId, configured, listPage, search, selectedId, status])

  useEffect(() => {
    let active = true
    async function checkConnection() {
      setConnectionChecking(true)
      setConnectionError(null)
      try {
        const result = await invokeInbox<{ configured?: boolean }>({ action: 'status', business_id: businessId })
        if (active) setConfigured(result.configured === true)
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

  useEffect(() => { if (configured) void loadConversations() }, [configured, loadConversations])

  useEffect(() => {
    if (!configured) return
    const interval = window.setInterval(() => { void refreshLoadedConversations() }, 30_000)
    return () => window.clearInterval(interval)
  }, [configured, refreshLoadedConversations])

  useEffect(() => {
    setSelectedId((selected) => selected && conversations.some((item) => item.id === selected) ? selected : null)
  }, [conversations])

  useEffect(() => {
    let active = true
    async function loadBusinessContext() {
      if (!configured || !supabaseClient) return
      setLinkLoading(true)
      const [customersResult, linksResult] = await Promise.all([
        supabaseClient.from('customers').select('id, name, phone, whatsapp_phone').eq('business_id', businessId).eq('is_active', true).order('name', { ascending: true }),
        supabaseClient.from('whatsapp_conversation_links').select('conversation_id, inbox_id, customer_id, order_id').eq('business_id', businessId),
      ])
      if (!active) return
      if (customersResult.error || linksResult.error) {
        setLinkError('Não foi possível carregar os vínculos com clientes e pedidos.')
      } else {
        setCustomers((customersResult.data ?? []) as Customer[])
        setLinks(Object.fromEntries(((linksResult.data ?? []) as ConversationLink[]).map((link) => [link.conversation_id, link])))
        setLinkError(null)
      }
      setLinkLoading(false)
    }
    void loadBusinessContext()
    return () => { active = false }
  }, [businessId, configured])

  useEffect(() => {
    if (!selectedId || !configured) {
      setSelectedConversation(null)
      return
    }
    let active = true
    const request = ++detailRequest.current
    async function loadConversation() {
      setSelectedConversation(null)
      setDetailLoading(true)
      setDetailError(null)
      try {
        const result = await invokeInbox<{ conversation?: Conversation }>({ action: 'conversation', business_id: businessId, conversationId: selectedId })
        let conversation = result.conversation ?? null
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

  const selectedLink = selectedId ? links[selectedId] : undefined
  const currentConversation = selectedConversation?.id === selectedId && conversations.some((item) => item.id === selectedId)
    ? selectedConversation
    : null
  const [customerDraft, setCustomerDraft] = useState('')
  const [orderDraft, setOrderDraft] = useState('')

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
    const phone = digitsOnly(currentConversation?.contact.phone)
    if (phone.length < 8) return []
    return customers.filter((customer) => [customer.whatsapp_phone, customer.phone].some((value) => {
      const candidate = digitsOnly(value)
      return candidate.length >= 8 && (candidate.endsWith(phone) || phone.endsWith(candidate))
    }))
  }, [customers, currentConversation?.contact.phone])

  function changeStatusFilter(nextStatus: InboxStatus) {
    const nextScope = conversationScopeKey(nextStatus, search)
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

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextSearch = searchInput.trim()
    const nextScope = conversationScopeKey(status, nextSearch)
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

  async function handleSaveLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const client = supabaseClient
    if (!client || !currentConversation || role !== 'owner') return
    setLinkSaving(true)
    setLinkError(null)
    setLinkMessage(null)
    const row = {
      business_id: businessId,
      conversation_id: currentConversation.id,
      inbox_id: currentConversation.inbox_id,
      customer_id: customerDraft || null,
      order_id: orderDraft || null,
    }
    const updateLink = () => client.from('whatsapp_conversation_links')
      .update({ inbox_id: row.inbox_id, customer_id: row.customer_id, order_id: row.order_id })
      .eq('business_id', row.business_id)
      .eq('conversation_id', row.conversation_id)
      .select('conversation_id, inbox_id, customer_id, order_id')
      .single()
    let result = selectedLink
      ? await updateLink()
      : await client.from('whatsapp_conversation_links')
        .insert(row)
        .select('conversation_id, inbox_id, customer_id, order_id')
        .single()
    if (!selectedLink && result.error?.code === '23505') result = await updateLink()
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
    <section className="surface-panel whatsapp-connection-state" role="status"><span className="empty-icon"><Icon name="clock" /></span><h2>Verificando a conexão segura…</h2><p>O sistema consulta a configuração do Chatwoot no servidor.</p></section>
  ) : !configured ? (
    <section className="surface-panel whatsapp-connection-state" aria-labelledby="whatsapp-pending-title">
      <span className="empty-icon"><Icon name="message" /></span>
      <p className="eyebrow">{connectionError ? 'CONEXÃO INDISPONÍVEL' : 'ETAPA 1 · CAIXA DE ENTRADA'}</p>
      <h2 id="whatsapp-pending-title">{connectionError ? 'Não foi possível verificar a integração' : 'A caixa de entrada está preparada; falta conectar o Chatwoot'}</h2>
      <p>{connectionError ?? 'Esta tela vai reunir as conversas do WhatsApp dentro do Shalom e permitir associá-las a clientes e pedidos. Nenhuma conversa foi simulada; nenhuma mensagem é enviada enquanto o Chatwoot e a conta WhatsApp Business não estiverem configurados.'}</p>
      <ol className="whatsapp-setup-steps">
        <li><span>1</span><div><strong>Configurar a conexão segura</strong><small>Endereço, conta e token do Chatwoot ficam nos secrets da função Supabase, nunca no navegador.</small></div><span className="neutral-status">Pendente</span></li>
        <li><span>2</span><div><strong>Conectar o canal WhatsApp</strong><small>Depende da conta WhatsApp Business, do número e da configuração aprovada na Meta.</small></div><span className="neutral-status">Pendente</span></li>
        <li><span>3</span><div><strong>Validar mensagens reais</strong><small>Depois da conexão, confirmar recebimento, resposta, status e vínculo com cadastro e pedido.</small></div><span className="neutral-status">Pendente</span></li>
      </ol>
      {connectionError && <button className="button button-secondary" onClick={() => { setConnectionChecking(true); setConnectionError(null); void invokeInbox<{ configured?: boolean }>({ action: 'status', business_id: businessId }).then((result) => setConfigured(result.configured === true)).catch(() => setConnectionError('Não foi possível verificar a conexão com o servidor.')).finally(() => setConnectionChecking(false)) }} type="button">Tentar novamente</button>}
      <Link className="quiet-link" to="/configuracoes">Ver preparação da conexão <Icon name="arrow" /></Link>
    </section>
  ) : (
    <section className="whatsapp-inbox" aria-label="Caixa de entrada WhatsApp">
      <aside className={`surface-panel whatsapp-conversation-panel${selectedId ? ' is-mobile-hidden' : ''}`} aria-label="Lista de conversas">
        <div className="whatsapp-list-heading">
          <div><p className="eyebrow">CHATWOOT · WHATSAPP</p><h2>Conversas</h2></div>
          <button aria-label="Atualizar conversas" className="icon-button" disabled={listLoading} onClick={() => void refreshLoadedConversations()} type="button"><Icon name="clock" /></button>
        </div>
        <form className="whatsapp-search" onSubmit={(event) => void handleSearch(event)} role="search">
          <Icon name="search" />
          <input aria-label="Buscar no conteúdo das mensagens" onChange={(event) => setSearchInput(event.target.value)} placeholder="Buscar mensagem" value={searchInput} />
          <button className="text-button" type="submit">Buscar</button>
        </form>
        <div className="whatsapp-status-tabs" aria-label="Filtrar conversas por status">
          {(['open', 'resolved', 'all'] as const).map((item) => <button aria-pressed={status === item} key={item} onClick={() => changeStatusFilter(item)} type="button">{item === 'open' ? 'Abertas' : item === 'resolved' ? 'Resolvidas' : 'Todas'}</button>)}
        </div>
        {listError && <div className="inline-state inline-state-error" role="alert"><p>{listError}</p><button className="text-button" onClick={() => void refreshLoadedConversations()} type="button">Tentar novamente</button></div>}
        {showConversationListLoading && <p className="inline-state" role="status">Carregando conversas…</p>}
        {showConversationListRefreshing && <p className="inline-state" role="status">Atualizando conversas…</p>}
        {showConversationListEmpty && <div className="whatsapp-list-empty"><Icon name="message" /><strong>Nenhuma conversa nesta lista</strong><span>As conversas recebidas pelo canal conectado aparecerão aqui.</span></div>}
        {loadedListScope === currentListScope && conversations.length > 0 && (
          <ul className="whatsapp-conversation-list">
            {conversations.map((conversation) => <li key={conversation.id}>
              <button aria-current={selectedId === conversation.id ? 'true' : undefined} className={`whatsapp-conversation-item${selectedId === conversation.id ? ' is-selected' : ''}${conversation.unread_count > 0 ? ' has-unread' : ''}`} onClick={() => { setSelectedConversation(null); setSelectedId(conversation.id) }} type="button">
                <span className="whatsapp-contact-avatar">{(conversation.contact.name || conversation.contact.phone || '?').slice(0, 1).toLocaleUpperCase('pt-BR')}</span>
                <span className="whatsapp-conversation-copy"><strong>{conversation.contact.name || conversation.contact.phone || 'Contato sem nome'}</strong><small>{conversation.last_message?.content || (conversation.last_message?.attachments.length ? `${conversation.last_message.attachments.length} anexo(s)` : 'Sem mensagem de texto')}</small></span>
                <span className="whatsapp-conversation-meta"><span className="whatsapp-conversation-meta-top"><time>{timestampLabel(conversation.last_activity_at)}</time>{conversation.unread_count > 0 && <span aria-label={`${conversation.unread_count} mensagens não lidas`} className="whatsapp-unread-count">{conversation.unread_count > 99 ? '99+' : conversation.unread_count}</span>}</span>{links[conversation.id]?.customer_id && <span className="whatsapp-linked-mark">Cliente vinculado</span>}</span>
              </button>
            </li>)}
          </ul>
        )}
        {hasMore && <button className="button button-secondary whatsapp-load-more" disabled={listLoading} onClick={() => void loadConversations(listPage + 1, true)} type="button">{listLoading ? 'Carregando…' : 'Carregar mais conversas'}</button>}
      </aside>

      <section className={`surface-panel whatsapp-chat-panel${selectedId ? ' is-mobile-visible' : ''}`} aria-label="Conversa selecionada">
        {!selectedId ? <div className="whatsapp-chat-empty"><Icon name="message" /><h2>Selecione uma conversa</h2><p>O histórico e as ações aparecem aqui.</p></div> : <>
          <header className="whatsapp-chat-heading">
            <button className="text-button whatsapp-back-button" onClick={() => setSelectedId(null)} type="button">← Conversas</button>
            <div className="whatsapp-chat-contact"><span className="whatsapp-contact-avatar">{(currentConversation?.contact.name || '?').slice(0, 1).toLocaleUpperCase('pt-BR')}</span><div><h2>{currentConversation?.contact.name || (detailLoading ? 'Carregando contato…' : 'Contato')}</h2><span>{currentConversation?.contact.phone || 'Telefone indisponível'}</span></div></div>
            <div className="whatsapp-chat-actions">
              <span className={`whatsapp-status-pill${currentConversation?.status === 'open' ? '' : ' is-resolved'}`}>{statusLabel(currentConversation?.status)}</span>
              <button className="button button-secondary" disabled={statusSaving || !currentConversation || !['open', 'resolved'].includes(currentConversation.status)} onClick={() => void handleStatusChange(currentConversation?.status === 'resolved' ? 'open' : 'resolved')} type="button">{statusSaving ? 'Salvando…' : currentConversation?.status === 'resolved' ? 'Reabrir' : 'Resolver'}</button>
            </div>
          </header>

          {detailError && <div className="inline-state inline-state-error" role="alert">{detailError}</div>}
          <div className="whatsapp-message-history" aria-live="polite" aria-label="Histórico de mensagens">
            {detailLoading && <p className="inline-state" role="status">Carregando histórico…</p>}
            {!detailLoading && currentConversation?.messages.map((message) => <article className={`whatsapp-message${message.message_type === 'outgoing' ? ' is-outgoing' : ''}${message.private ? ' is-private' : ''}`} key={message.id}>
              {message.private && <span className="whatsapp-message-label">Nota interna</span>}
              {message.content && <p>{message.content}</p>}
              {!message.content && message.attachments.length === 0 && <p className="whatsapp-message-attachment">{message.message_type === 'activity' ? 'Atualização da conversa' : 'Mensagem sem texto'}</p>}
              {message.attachments.map((attachment) => <MessageAttachment attachment={attachment} businessId={businessId} conversationId={currentConversation.id} key={attachment.id} messageId={message.id} />)}
              <footer><span>{message.message_type === 'outgoing' ? 'Equipe' : message.sender.name || currentConversation?.contact.name || 'Cliente'}</span><time>{timestampLabel(message.created_at)}</time>{message.message_type === 'outgoing' && !message.private && message.status && <span className={`whatsapp-message-delivery is-${message.status}`}>{messageDeliveryLabel(message.status)}</span>}</footer>
            </article>)}
            {!detailLoading && currentConversation?.messages.length === 0 && <p className="whatsapp-chat-empty-history">Ainda não há mensagens nesta conversa.</p>}
          </div>

          {actionError && <p className="form-message form-message-error whatsapp-action-error" role="alert">{actionError}</p>}
          <form className="whatsapp-compose" onSubmit={(event) => void handleSend(event)}>
            {currentConversation && !currentConversation.can_reply && <p className="section-footnote">O canal não permite responder a esta conversa neste momento.</p>}
            <label className="visually-hidden" htmlFor="whatsapp-message-draft">Mensagem</label>
            <textarea disabled={!currentConversation?.can_reply} id="whatsapp-message-draft" maxLength={4000} onChange={(event) => setMessageDraft(event.target.value)} placeholder="Escreva uma mensagem…" value={messageDraft} />
            <div><span>{messageDraft.length}/4000</span><button className="button button-primary" disabled={sending || !messageDraft.trim() || !currentConversation?.can_reply} type="submit">{sending ? 'Enviando…' : 'Enviar'}</button></div>
          </form>

          <form className="whatsapp-context-panel" onSubmit={(event) => void handleSaveLink(event)}>
            <div className="whatsapp-context-heading"><div><p className="eyebrow">CONTEXTO SHALOM</p><h3>Cliente e pedido</h3></div><span className="neutral-status">Vínculo manual</span></div>
            {linkError && <p className="form-message form-message-error" role="alert">{linkError}</p>}
            {linkMessage && <p className="form-message form-message-success" role="status">{linkMessage}</p>}
            {phoneMatches.length > 0 && !customerDraft && <p className="whatsapp-match-hint">{phoneMatches.length === 1 ? `Telefone correspondente ao cadastro de ${phoneMatches[0].name}.` : `${phoneMatches.length} cadastros usam este telefone; escolha o cliente correto.`} A associação só será salva após sua confirmação.</p>}
            <label className="whatsapp-context-field"><span>Cliente</span><select disabled={!currentConversation || linkLoading || role !== 'owner'} onChange={(event) => { setCustomerDraft(event.target.value); setOrderDraft('') }} value={customerDraft}><option value="">Sem cliente associado</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
            <label className="whatsapp-context-field"><span>Pedido relacionado</span><select disabled={!currentConversation || !customerDraft || role !== 'owner'} onChange={(event) => setOrderDraft(event.target.value)} value={orderDraft}><option value="">Sem pedido associado</option>{orders.map((order) => <option key={order.id} value={order.id}>{orderLabel(order)}</option>)}</select></label>
            {role === 'owner' ? <button className="button button-secondary" disabled={!currentConversation || linkSaving || linkLoading} type="submit">{linkSaving ? 'Salvando…' : 'Salvar vínculo'}</button> : <p className="section-footnote">Somente a gestão pode alterar vínculos de atendimento.</p>}
          </form>
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
          <p className="page-description">Conversas do Chatwoot com contexto de clientes e pedidos do Shalom.</p>
        </div>
        <span className="module-heading-icon"><Icon name="message" /></span>
      </header>
      {connectedScreen}
    </div>
  )
}
