import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { formatBRLExact, formatBusinessDate } from '../lib/formatters'
import { useBusinessToday } from '../lib/useBusinessToday'
import { supabaseClient } from '../lib/supabase'

type FinancialSummary = {
  sales: { active_order_count: number; active_total_cents: string }
  receipts: { record_count: number; amount_cents: string }
  receivables: { installment_count: number; open_balance_cents: string }
  outflows: { record_count: number; total_cents: string }
  cash_movement: { net_recorded_cents: string }
  managerial_result: { available: boolean; result_cents: string | null; missing_cost_line_count: number; returned_order_count: number; completed_order_count: number }
}

const integrations = [
  { label: 'WhatsApp', state: 'Conexão pendente' },
  { label: 'Banco', state: 'Método pendente' },
  { label: 'Fiscal', state: 'Dados pendentes' },
]

export function DashboardPage() {
  const { id: businessId } = useBusiness()
  const today = useBusinessToday()
  const businessDate = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeZone: 'America/Sao_Paulo' }).format(new Date(`${today}T12:00:00Z`))
  const [followUps, setFollowUps] = useState<Array<{ id: string; title: string; due_on: string; customer_id: string | null; customerName: string | null }>>([])
  const [followUpsLoading, setFollowUpsLoading] = useState(true)
  const [followUpsError, setFollowUpsError] = useState(false)
  const [financeSummary, setFinanceSummary] = useState<FinancialSummary | null>(null)
  const [financeLoading, setFinanceLoading] = useState(true)
  const [financeError, setFinanceError] = useState(false)

  const loadFinanceSummary = useCallback(async () => {
    if (!supabaseClient) {
      setFinanceError(true)
      setFinanceLoading(false)
      return
    }
    setFinanceLoading(true)
    try {
      const { data, error } = await supabaseClient.rpc('get_financial_report_summary', {
        p_business_id: businessId,
        p_start_on: today,
        p_end_on: today,
      })
      if (error || !data) throw error
      setFinanceSummary(data as FinancialSummary)
      setFinanceError(false)
    } catch {
      setFinanceError(true)
      setFinanceSummary(null)
    } finally {
      setFinanceLoading(false)
    }
  }, [businessId, today])

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
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadFinanceSummary() }, [loadFinanceSummary])

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
        {financeLoading && <p className="inline-state" aria-live="polite">Carregando movimentação registrada hoje…</p>}
        {!financeLoading && financeError && <div className="empty-state"><span className="empty-icon"><Icon name="coin" /></span><div><h3>Não foi possível carregar o financeiro de hoje</h3><button className="text-button" onClick={() => void loadFinanceSummary()} type="button">Tentar novamente</button></div></div>}
        {!financeLoading && !financeError && financeSummary && <div className="indicator-grid">
          <article className="indicator-card"><p>Pedidos ativos criados hoje</p><strong>{formatBRLExact(financeSummary.sales.active_total_cents)}</strong><span>{financeSummary.sales.active_order_count} pedidos · cancelados separados</span></article>
          <article className="indicator-card"><p>Recebimentos informados hoje</p><strong>{formatBRLExact(financeSummary.receipts.amount_cents)}</strong><span>{financeSummary.receipts.record_count} registros manuais</span></article>
          <article className="indicator-card"><p>Vencimentos em aberto hoje</p><strong>{formatBRLExact(financeSummary.receivables.open_balance_cents)}</strong><span>{financeSummary.receivables.installment_count} parcelas com vencimento hoje</span></article>
          <article className="indicator-card"><p>Saídas pagas hoje</p><strong>{formatBRLExact(financeSummary.outflows.total_cents)}</strong><span>{financeSummary.outflows.record_count} registros manuais</span></article>
          <article className="indicator-card"><p>Movimento líquido registrado</p><strong>{formatBRLExact(financeSummary.cash_movement.net_recorded_cents)}</strong><span>Recebimentos informados menos saídas pagas</span></article>
          <article className="indicator-card indicator-pending-card"><p>Resultado gerencial de hoje</p><strong>{financeSummary.managerial_result.available && financeSummary.managerial_result.result_cents !== null ? formatBRLExact(financeSummary.managerial_result.result_cents) : 'Indisponível'}</strong><span>{financeSummary.managerial_result.available ? `${financeSummary.managerial_result.completed_order_count} pedidos entregues ou retirados` : `${financeSummary.managerial_result.missing_cost_line_count} itens sem custo · ${financeSummary.managerial_result.returned_order_count} pedidos com devolução`}</span></article>
        </div>}
        <p className="section-footnote">O movimento líquido usa recebimentos e pagamentos informados manualmente; não é saldo bancário. O resultado segue a fórmula aprovada e usa a data de entrega ou retirada; custos de despesas e entregas usam a data paga.</p>
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
