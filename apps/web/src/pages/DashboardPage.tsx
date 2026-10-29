import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { businessToday, formatBusinessDate } from '../lib/formatters'
import { supabaseClient } from '../lib/supabase'

const businessDate = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'full',
  timeZone: 'America/Sao_Paulo',
}).format(new Date())

const indicators = [
  { label: 'Vendas registradas', note: 'Sem lançamentos ainda' },
  { label: 'Valores recebidos', note: 'Sem recebimentos ainda' },
  { label: 'A receber', note: 'Sem contas cadastradas' },
  { label: 'Despesas', note: 'Sem despesas cadastradas' },
]

const integrations = [
  { label: 'WhatsApp', state: 'Conexão pendente' },
  { label: 'Banco', state: 'Método pendente' },
  { label: 'Fiscal', state: 'Dados pendentes' },
]

export function DashboardPage() {
  const { id: businessId } = useBusiness()
  const [followUps, setFollowUps] = useState<Array<{ id: string; title: string; due_on: string; customer_id: string | null; customerName: string | null }>>([])
  const [followUpsLoading, setFollowUpsLoading] = useState(true)
  const [followUpsError, setFollowUpsError] = useState(false)
  const [today] = useState(businessToday)

  const loadFollowUps = useCallback(async () => {
    if (!supabaseClient) {
      setFollowUpsLoading(false)
      return
    }
    try {
      const { data, error } = await supabaseClient.from('follow_up_tasks')
        .select('id, title, due_on, customer_id')
        .eq('business_id', businessId).eq('status', 'pending')
        .order('due_on', { ascending: true }).limit(4)
      if (error) {
        setFollowUpsError(true)
        return
      }
      const rows = data ?? []
      const customerIds = Array.from(new Set(rows.flatMap((row) => row.customer_id ? [row.customer_id] : [])))
      let names = new Map<string, string>()
      if (customerIds.length > 0) {
        const { data: customers, error: customerError } = await supabaseClient.from('customers').select('id, name')
          .eq('business_id', businessId).in('id', customerIds)
        if (customerError) throw customerError
        names = new Map((customers ?? []).map((customer) => [customer.id, customer.name]))
      }
      setFollowUps(rows.map((row) => ({ ...row, customerName: row.customer_id ? names.get(row.customer_id) ?? null : null })))
      setFollowUpsError(false)
    } catch {
      setFollowUpsError(true)
    } finally {
      setFollowUpsLoading(false)
    }
  }, [businessId])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadFollowUps() }, [loadFollowUps])

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{businessDate}</p>
          <h1>Visão geral</h1>
          <p className="page-description">O que precisa de atenção hoje?</p>
        </div>
        <span className="period-badge">Operação</span>
      </header>

      <section className="attention-panel" aria-labelledby="attention-title">
        <div className="section-heading">
          <div><p className="eyebrow">PRÓXIMAS AÇÕES</p><h2 id="attention-title">Retornos pendentes</h2></div>
          <Link className="quiet-link" to="/atendimento">Abrir fila <Icon name="arrow" /></Link>
        </div>
        {followUpsLoading && <p className="inline-state" aria-live="polite">Carregando retornos…</p>}
        {!followUpsLoading && followUpsError && <div className="empty-state"><span className="empty-icon"><Icon name="clock" /></span><div><h3>Não foi possível carregar os retornos</h3><button className="text-button" onClick={() => { setFollowUpsLoading(true); void loadFollowUps() }} type="button">Tentar novamente</button></div></div>}
        {!followUpsLoading && !followUpsError && followUps.length === 0 && <div className="empty-state"><span className="empty-icon"><Icon name="check" /></span><div><h3>Nenhum retorno pendente</h3><p>Os próximos passos registrados nos clientes aparecerão aqui.</p></div></div>}
        {!followUpsLoading && !followUpsError && followUps.length > 0 && (
          <ul className="dashboard-follow-ups">
            {followUps.map((task) => <li key={task.id}><span><strong>{task.title}</strong><small>{task.customerName ?? 'Sem cliente vinculado'}</small></span><span className={task.due_on < today ? 'dashboard-task-date is-overdue' : 'dashboard-task-date'}>{task.due_on < today ? 'Atrasado' : formatBusinessDate(task.due_on)}</span></li>)}
          </ul>
        )}
      </section>

      <section aria-labelledby="finance-title">
        <div className="section-heading section-heading-compact">
          <div>
            <p className="eyebrow">MOVIMENTAÇÃO</p>
            <h2 id="finance-title">Resumo financeiro</h2>
          </div>
          <Link className="quiet-link" to="/financeiro">Ver financeiro <Icon name="arrow" /></Link>
        </div>
        <div className="indicator-grid">
          {indicators.map((indicator) => (
            <article className="indicator-card" key={indicator.label}>
              <p>{indicator.label}</p>
              <strong aria-label="Sem dados">—</strong>
              <span>{indicator.note}</span>
            </article>
          ))}
        </div>
        <p className="section-footnote">Os valores serão preenchidos a partir dos registros do sistema. Resultado e lucro só serão exibidos após validação da fórmula com a empresa.</p>
      </section>

      <div className="dashboard-columns">
        <section className="surface-panel" aria-labelledby="integrations-title">
          <div className="section-heading section-heading-compact">
            <div>
              <p className="eyebrow">CONFIGURAÇÃO</p>
              <h2 id="integrations-title">Conexões</h2>
            </div>
            <Link className="quiet-link" to="/configuracoes">Ver status <Icon name="arrow" /></Link>
          </div>
          <ul className="status-list">
            {integrations.map((item) => (
              <li key={item.label}>
                <span className="status-indicator" aria-hidden="true" />
                <span className="status-name">{item.label}</span>
                <span className="status-copy">{item.state}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="surface-panel stock-panel" aria-labelledby="stock-title">
          <div className="section-heading section-heading-compact">
            <div>
              <p className="eyebrow">ESTOQUE</p>
              <h2 id="stock-title">Nível de atenção</h2>
            </div>
            <Icon className="section-icon" name="box" />
          </div>
          <div className="small-empty-state">
            <p>Cadastre os produtos e os limites mínimos para acompanhar o estoque.</p>
            <Link className="quiet-link" to="/estoque">Abrir estoque <Icon name="arrow" /></Link>
          </div>
        </section>
      </div>

      <section className="quick-links" aria-label="Atalhos">
        <Link className="quick-link" to="/atendimento"><Icon name="phone" /><span><strong>Atendimento</strong><small>Chamadas e retornos</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
        <Link className="quick-link" to="/pedidos"><Icon name="bag" /><span><strong>Pedidos</strong><small>Vendas e entregas</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
        <Link className="quick-link" to="/clientes"><Icon name="people" /><span><strong>Clientes</strong><small>Cadastros e histórico</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
        <Link className="quick-link" to="/catalogo"><Icon name="box" /><span><strong>Catálogo</strong><small>Produtos e categorias</small></span><Icon className="quick-link-arrow" name="arrow" /></Link>
      </section>
    </div>
  )
}
