import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from './Icon'
import { supabaseClient } from '../lib/supabase'

type CallEvent = {
  id: string
  conversation_id: string
  contact: { name: string | null; phone: string | null }
  customer_name: string | null
  status_label: string
  is_video: boolean | null
  occurred_at: string
  event_count: number
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value))
}

export function WhatsAppCallEventsCard() {
  const { id: businessId } = useBusiness()
  const [calls, setCalls] = useState<CallEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [configured, setConfigured] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadCalls = useCallback(async () => {
    if (!supabaseClient) {
      setConfigured(false)
      setLoading(false)
      return
    }
    setError(null)
    try {
      const statusResult = await supabaseClient.functions.invoke<{ configured?: boolean }>('evolution-inbox', {
        body: { action: 'status', business_id: businessId },
      })
      if (statusResult.error) throw statusResult.error
      const isConfigured = statusResult.data?.configured === true
      setConfigured(isConfigured)
      if (!isConfigured) {
        setCalls([])
        return
      }
      const result = await supabaseClient.functions.invoke<{ calls?: CallEvent[] }>('evolution-inbox', {
        body: { action: 'calls', business_id: businessId },
      })
      if (result.error) throw result.error
      setCalls((result.data?.calls ?? []).slice(0, 5))
    } catch {
      setError('Não foi possível carregar as chamadas do WhatsApp.')
    } finally {
      setLoading(false)
    }
  }, [businessId])

  useEffect(() => { void loadCalls() }, [loadCalls])
  useEffect(() => {
    const interval = window.setInterval(() => { void loadCalls() }, 30_000)
    return () => window.clearInterval(interval)
  }, [loadCalls])

  return (
    <section className="surface-panel record-panel" aria-labelledby="whatsapp-calls-title">
      <div className="section-heading section-heading-compact">
        <div><p className="eyebrow">EVOLUTION API</p><h2 id="whatsapp-calls-title">Chamadas do WhatsApp</h2></div>
        <Link className="quiet-link" to="/whatsapp?view=calls">Abrir registro completo <Icon name="arrow" /></Link>
      </div>
      {loading && <p className="inline-state" role="status">Carregando chamadas…</p>}
      {!loading && !error && !configured && <p className="inline-state">O registro aparecerá aqui depois de conectar a Evolution API.</p>}
      {!loading && error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => { setLoading(true); void loadCalls() }} type="button">Tentar novamente</button></div>}
      {!loading && configured && !error && calls.length === 0 && <p className="inline-state">Nenhum evento de chamada recebido ainda.</p>}
      {calls.length > 0 && <ul className="timeline-list">{calls.map((call) => <li key={call.id}><span className="timeline-dot" /><div><strong>{call.customer_name || call.contact.name || call.contact.phone || 'Contato sem identificação'}</strong><p>{call.contact.phone || 'Telefone indisponível'} · {call.status_label}{call.is_video ? ' · vídeo' : ''}{call.event_count > 1 ? ` · ${call.event_count} eventos` : ''}</p><p>{timeLabel(call.occurred_at)}</p></div></li>)}</ul>}
      <p className="section-footnote">A Evolution envia eventos, não gravação ou áudio da ligação.</p>
    </section>
  )
}
