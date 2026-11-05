import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Icon } from '../components/Icon'
import { supabaseClient } from '../lib/supabase'
import './DeliveryDriverPortalPage.css'

type DriverContext = {
  business_id: string
  worker_id: string
  worker_name: string
  business_name: string
  is_active: boolean
}

type DeliveryItem = { name: string; quantity: string | number; unit: string | null }
type DriverDelivery = {
  delivery_id: string
  order_id: string
  status: 'awaiting_separation' | 'ready' | 'dispatched' | 'delivered' | 'attempted' | 'rescheduled' | 'returned'
  scheduled_on: string | null
  time_window: string | null
  dispatched_at: string | null
  delivered_at: string | null
  customer_name: string
  customer_phone: string | null
  delivery_address: string | null
  order_created_at: string
  items: DeliveryItem[]
}

type Confirmation = { deliveryId: string; status: 'dispatched' | 'delivered' }

function newRequestId() { return crypto.randomUUID() }

function formatDate(value: string | null) {
  if (!value) return 'Sem data agendada'
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`))
}

function formatTimestamp(value: string | null) {
  if (!value) return null
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value))
}

function statusLabel(status: DriverDelivery['status']) {
  switch (status) {
    case 'awaiting_separation': return 'Aguardando separação'
    case 'ready': return 'Pronto para sair'
    case 'dispatched': return 'Em rota'
    case 'delivered': return 'Entregue'
    case 'attempted': return 'Entrega não concluída'
    case 'rescheduled': return 'Reagendada'
    case 'returned': return 'Devolvida'
  }
}

function phoneHref(value: string) { return `tel:${value.replace(/[^+\d]/g, '')}` }

function dateOffset(days: number) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

const demoContext: DriverContext = {
  business_id: 'demo-business',
  worker_id: 'demo-driver',
  worker_name: 'Carlos · demonstração',
  business_name: 'Shalom Adonai',
  is_active: true,
}

const demoDeliveries: DriverDelivery[] = [
  {
    delivery_id: 'demo-ready', order_id: 'demo-order-ready', status: 'ready',
    scheduled_on: dateOffset(0), time_window: '14h–16h', dispatched_at: null, delivered_at: null,
    customer_name: 'Marina Souza · exemplo', customer_phone: '(21) 90000-0001',
    delivery_address: 'Rua de Demonstração, 123 · Centro, Niterói/RJ', order_created_at: new Date().toISOString(),
    items: [{ name: 'Kit de limpeza', quantity: 1, unit: 'un' }, { name: 'Sabão líquido', quantity: 2, unit: 'un' }],
  },
  {
    delivery_id: 'demo-dispatched', order_id: 'demo-order-dispatched', status: 'dispatched',
    scheduled_on: dateOffset(0), time_window: '16h–18h', dispatched_at: new Date().toISOString(), delivered_at: null,
    customer_name: 'Rafael Lima · exemplo', customer_phone: '(21) 90000-0002',
    delivery_address: 'Avenida de Exemplo, 45 · Icaraí, Niterói/RJ', order_created_at: new Date().toISOString(),
    items: [{ name: 'Amaciante concentrado', quantity: 3, unit: 'un' }],
  },
  {
    delivery_id: 'demo-delivered', order_id: 'demo-order-delivered', status: 'delivered',
    scheduled_on: dateOffset(-1), time_window: '10h–12h', dispatched_at: new Date().toISOString(), delivered_at: new Date().toISOString(),
    customer_name: 'Joana Martins · exemplo', customer_phone: '(21) 90000-0003',
    delivery_address: 'Rua das Amostras, 80 · Santa Rosa, Niterói/RJ', order_created_at: new Date().toISOString(),
    items: [{ name: 'Cesta doméstica', quantity: 1, unit: 'un' }],
  },
]

export function DeliveryDriverPortalPage({ preview = false }: { preview?: boolean }) {
  const { session } = useAuth()
  const navigate = useNavigate()
  const [context, setContext] = useState<DriverContext | null>(null)
  const [deliveries, setDeliveries] = useState<DriverDelivery[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [accountError, setAccountError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'active' | 'completed'>('active')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [savingDeliveryId, setSavingDeliveryId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const requestIdsRef = useRef(new Map<string, string>())
  const confirmationRef = useRef<HTMLDivElement>(null)
  const focusReturnRef = useRef<HTMLElement | null>(null)
  const noticeRef = useRef<HTMLParagraphElement>(null)
  const confirmationWasOpenRef = useRef(false)

  const loadPortal = useCallback(async (showLoading = true) => {
    if (preview) {
      setContext(demoContext)
      setDeliveries(demoDeliveries)
      setError(null)
      setLoading(false)
      return
    }
    if (!supabaseClient) {
      setError('A conexão do painel não está configurada.')
      setLoading(false)
      return
    }
    if (showLoading) setLoading(true)
    setError(null)
    try {
      const contextResult = await supabaseClient.rpc('get_my_delivery_worker_context')
      if (contextResult.error) {
        setError('Não foi possível confirmar seu acesso. Tente atualizar o painel.')
        return
      }
      const contextRow = (Array.isArray(contextResult.data) ? contextResult.data[0] : contextResult.data) as DriverContext | null
      if (!contextRow) {
        setContext(null)
        setDeliveries([])
        return
      }
      setContext(contextRow)
      if (!contextRow.is_active) {
        setDeliveries([])
        return
      }
      const queueResult = await supabaseClient.rpc('get_my_delivery_driver_queue')
      if (queueResult.error) {
        setError('Não foi possível carregar suas entregas. Tente atualizar o painel.')
        return
      }
      setDeliveries((queueResult.data ?? []) as DriverDelivery[])
    } catch {
      setError('Não foi possível carregar suas entregas. Tente atualizar o painel.')
    } finally {
      setLoading(false)
    }
  }, [preview])

  useEffect(() => { void loadPortal() }, [loadPortal])

  useEffect(() => {
    if (confirmation) {
      confirmationRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    } else if (confirmationWasOpenRef.current && !notice) {
      focusReturnRef.current?.focus()
    }
    confirmationWasOpenRef.current = Boolean(confirmation)
  }, [confirmation, notice])

  useEffect(() => {
    if (notice) noticeRef.current?.focus()
  }, [notice])

  const activeDeliveries = useMemo(() => deliveries.filter((delivery) => !['delivered', 'returned'].includes(delivery.status)), [deliveries])
  const completedDeliveries = useMemo(() => deliveries.filter((delivery) => ['delivered', 'returned'].includes(delivery.status)), [deliveries])
  const visibleDeliveries = filter === 'active' ? activeDeliveries : completedDeliveries

  async function confirmStatusChange() {
    if (preview || !supabaseClient || !confirmation || savingDeliveryId) return
    const requestKey = `${confirmation.deliveryId}:${confirmation.status}`
    const requestId = requestIdsRef.current.get(requestKey) ?? newRequestId()
    requestIdsRef.current.set(requestKey, requestId)
    setSavingDeliveryId(confirmation.deliveryId)
    setActionError(null)
    setNotice(null)
    try {
      const { error: transitionError } = await supabaseClient.rpc('transition_my_delivery', {
        p_delivery_id: confirmation.deliveryId,
        p_status: confirmation.status,
        p_note: null,
        p_request_id: requestId,
      })
      if (transitionError) {
        setActionError('Não foi possível confirmar a atualização. Confira o status e tente novamente.')
        return
      }
      requestIdsRef.current.delete(requestKey)
      setConfirmation(null)
      setNotice(confirmation.status === 'dispatched' ? 'Saída para entrega confirmada.' : 'Entrega confirmada com sucesso.')
      await loadPortal(false)
    } catch {
      setActionError('Não foi possível confirmar a atualização. Confira o status e tente novamente.')
    } finally {
      setSavingDeliveryId(null)
    }
  }

  async function signOut() {
    if (!supabaseClient) return
    setAccountError(null)
    try {
      const { error: signOutError } = await supabaseClient.auth.signOut()
      if (signOutError) {
        setAccountError('Não foi possível sair da conta. Tente novamente.')
        return
      }
      navigate('/entrar', { replace: true })
    } catch {
      setAccountError('Não foi possível sair da conta. Tente novamente.')
    }
  }

  return (
    <main className="driver-portal-screen">
      <header className="driver-portal-header">
        <div className="driver-portal-brand">
          <img className="brand-image" src="/shalom-adonai-logo.png" alt="" />
          <span><strong>{context?.business_name ?? 'Shalom Adonai'}</strong><small>Painel do entregador</small></span>
        </div>
        <div className="driver-portal-account">
          <span>{context?.worker_name ?? session?.user.email}</span>
          {preview ? <Link className="signout-button" to="/equipe">Voltar</Link> : <button className="signout-button" onClick={() => void signOut()} type="button">Sair</button>}
        </div>
      </header>

      <div className="driver-portal-content">
        {preview && <div className="driver-portal-preview-banner" role="status"><Icon name="shield" /><span><strong>Prévia do painel</strong> Dados fictícios; nenhuma entrega ou alteração será salva.</span></div>}
        <div className="driver-portal-heading">
          <div><p className="eyebrow">ENTREGAS ATRIBUÍDAS</p><h1>Minhas entregas</h1><p>Endereços, itens e atualizações dos seus pedidos.</p></div>
          <button className="button button-secondary" disabled={loading} onClick={() => void loadPortal()} type="button">{loading ? 'Atualizando…' : 'Atualizar'}</button>
        </div>

        {notice && <p className="form-message form-message-success" ref={noticeRef} role="status" tabIndex={-1}>{notice}</p>}
        {accountError && <p className="form-message form-message-error" role="alert">{accountError}</p>}
        {error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => void loadPortal()} type="button">Tentar novamente</button></div>}

        {!loading && !error && !context && <section className="driver-portal-message surface-panel"><span className="empty-icon"><Icon name="shield" /></span><h2>Seu acesso ainda não foi vinculado</h2><p>Peça à gestão para conectar este e-mail ao seu cadastro de entregador. Depois, suas entregas atribuídas aparecerão aqui.</p></section>}
        {!loading && !error && context && !context.is_active && <section className="driver-portal-message surface-panel"><span className="empty-icon"><Icon name="shield" /></span><h2>Acesso pausado</h2><p>Fale com a gestão da operação para reativar seu cadastro de entregador.</p></section>}

        {loading && <p className="inline-state" role="status">Carregando suas entregas…</p>}
        {!loading && !error && context?.is_active && <>
          <div className="driver-portal-tabs" role="group" aria-label="Filtrar entregas">
            <button aria-pressed={filter === 'active'} className={filter === 'active' ? 'is-selected' : ''} onClick={() => setFilter('active')} type="button">Em andamento <span>{activeDeliveries.length}</span></button>
            <button aria-pressed={filter === 'completed'} className={filter === 'completed' ? 'is-selected' : ''} onClick={() => setFilter('completed')} type="button">Histórico <span>{completedDeliveries.length}</span></button>
          </div>
          {visibleDeliveries.length === 0
            ? <section className="driver-portal-message surface-panel"><span className="empty-icon"><Icon name={filter === 'active' ? 'truck' : 'check'} /></span><h2>{filter === 'active' ? 'Nenhuma entrega pendente' : 'Nenhuma entrega no histórico recente'}</h2><p>{filter === 'active' ? 'Quando a gestão atribuir um pedido a você, ele aparecerá nesta lista.' : 'As entregas concluídas recentemente aparecerão aqui.'}</p></section>
            : <ul className="driver-delivery-list">{visibleDeliveries.map((delivery) => {
              const awaitingConfirmation = confirmation?.deliveryId === delivery.delivery_id
              const deliveredAt = formatTimestamp(delivery.delivered_at)
              const dispatchedAt = formatTimestamp(delivery.dispatched_at)
              const mapsUrl = !preview && delivery.delivery_address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(delivery.delivery_address)}` : null
              return <li className="driver-delivery-card surface-panel" key={delivery.delivery_id}>
                <div className="driver-delivery-heading">
                  <div><p className="eyebrow">{formatDate(delivery.scheduled_on)}{delivery.time_window ? ` · ${delivery.time_window}` : ''}</p><p className="driver-delivery-order-reference">Pedido registrado em {formatTimestamp(delivery.order_created_at)}</p><h2>{delivery.customer_name}</h2></div>
                  <span className={`driver-delivery-status is-${delivery.status}`}>{statusLabel(delivery.status)}</span>
                </div>
                {delivery.delivery_address && <div className="driver-delivery-address"><strong>Endereço</strong><p>{delivery.delivery_address}</p>{mapsUrl && <a className="quiet-link" href={mapsUrl} rel="noreferrer" target="_blank">Abrir no mapa <Icon name="arrow" /></a>}</div>}
                {!delivery.delivery_address?.trim() && <p className="driver-delivery-missing-address" role="alert">Endereço não informado. Fale com a gestão antes de sair.</p>}
                {delivery.customer_phone && (preview
                  ? <span className="driver-delivery-phone is-preview-contact"><Icon name="phone" /> Contato de exemplo</span>
                  : <a className="driver-delivery-phone" href={phoneHref(delivery.customer_phone)}><Icon name="phone" /> Ligar para {delivery.customer_name}</a>)}
                <div className="driver-delivery-items"><strong>Itens do pedido</strong><ul>{delivery.items.map((item, index) => <li key={`${delivery.delivery_id}-${index}`}><span>{item.name}</span><span>{item.quantity}{item.unit ? ` ${item.unit}` : ''}</span></li>)}</ul></div>
                {delivery.status === 'awaiting_separation' && <p className="driver-delivery-note">A loja ainda está separando este pedido. A opção de saída aparecerá quando estiver pronto.</p>}
                {delivery.status === 'dispatched' && dispatchedAt && <p className="driver-delivery-note">Saiu para entrega em {dispatchedAt}.</p>}
                {delivery.status === 'delivered' && deliveredAt && <p className="driver-delivery-note">Entrega confirmada em {deliveredAt}.</p>}
                {delivery.status === 'ready' && <button className="button button-primary driver-delivery-action" disabled={preview || Boolean(savingDeliveryId) || !delivery.delivery_address?.trim()} onClick={(event) => { focusReturnRef.current = event.currentTarget; setNotice(null); setConfirmation({ deliveryId: delivery.delivery_id, status: 'dispatched' }); setActionError(null) }} type="button"><Icon name="truck" /> Confirmar saída para entrega</button>}
                {delivery.status === 'dispatched' && <button className="button button-primary driver-delivery-action" disabled={preview || Boolean(savingDeliveryId)} onClick={(event) => { focusReturnRef.current = event.currentTarget; setNotice(null); setConfirmation({ deliveryId: delivery.delivery_id, status: 'delivered' }); setActionError(null) }} type="button"><Icon name="check" /> Confirmar entrega</button>}
                {preview && ['ready', 'dispatched'].includes(delivery.status) && <p className="section-footnote">As confirmações ficam disponíveis no acesso real do entregador.</p>}
                {awaitingConfirmation && <div className="driver-delivery-confirmation" ref={confirmationRef} role="group" aria-label="Confirmar atualização">
                  <p>{confirmation.status === 'dispatched' ? 'Confirma que este pedido saiu para entrega?' : 'Confirma que este pedido foi entregue ao cliente?'}</p>
                  <button className="button button-primary" disabled={savingDeliveryId === delivery.delivery_id} onClick={() => void confirmStatusChange()} type="button">{savingDeliveryId === delivery.delivery_id ? 'Salvando…' : 'Sim, confirmar'}</button>
                  <button className="text-button" disabled={Boolean(savingDeliveryId)} onClick={() => setConfirmation(null)} type="button">Voltar</button>
                </div>}
                {awaitingConfirmation && actionError && <p className="form-message form-message-error" role="alert">{actionError}</p>}
              </li>
            })}</ul>}
        </>}
      </div>
    </main>
  )
}
