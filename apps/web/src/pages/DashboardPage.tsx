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

type DashboardPriorities = {
  as_of_on: string
  follow_ups: { pending_count: number; items: Array<{ id: string; title: string; due_on: string; priority: 'low' | 'normal' | 'high'; customer_id: string | null; customer_name: string | null }> }
  receivables: {
    overdue_count: number
    overdue_balance_cents: string
    due_today_count: number
    due_today_balance_cents: string
    items: Array<{ installment_id: string; order_id: string; installment_number: number; due_on: string; customer_name: string; balance_cents: string; overdue: boolean }>
  }
  deliveries: {
    pending_count: number
    items: Array<{ delivery_id: string; order_id: string; customer_name: string; status: 'awaiting_separation' | 'ready' | 'dispatched' | 'attempted' | 'rescheduled'; scheduled_on: string | null; time_window: string | null; delivery_worker_name: string | null }>
  }
  inventory: {
    tracked_product_count: number
    without_minimum_count: number
    attention_count: number
    items: Array<{ product_id: string; product_name: string; inventory_unit: string; minimum_stock: number | null; quantity_on_hand: number }>
  }
}

const integrations = [
  { label: 'WhatsApp', state: 'Conexão pendente' },
  { label: 'Banco', state: 'Open Finance não conectado' },
  { label: 'Fiscal', state: 'Dados pendentes' },
]

const deliveryStatusLabels: Record<DashboardPriorities['deliveries']['items'][number]['status'], string> = {
  awaiting_separation: 'Aguardando separação',
  ready: 'Pronta para despacho',
  dispatched: 'Em rota',
  attempted: 'Tentativa sem sucesso',
  rescheduled: 'Reagendada',
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(value)
}

export function DashboardPage() {
  const { id: businessId } = useBusiness()
  const today = useBusinessToday()
  const businessDate = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeZone: 'America/Sao_Paulo' }).format(new Date(`${today}T12:00:00Z`))
  const [priorities, setPriorities] = useState<DashboardPriorities | null>(null)
  const [prioritiesLoading, setPrioritiesLoading] = useState(true)
  const [prioritiesError, setPrioritiesError] = useState(false)
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

  const loadPriorities = useCallback(async () => {
    if (!supabaseClient) {
      setPrioritiesError(true)
      setPrioritiesLoading(false)
      return
    }
    setPrioritiesLoading(true)
    try {
      const { data, error } = await supabaseClient.rpc('get_dashboard_priorities', {
        p_business_id: businessId,
        p_today: today,
      })
      if (error || !data) throw error
      setPriorities(data as DashboardPriorities)
      setPrioritiesError(false)
    } catch {
      setPriorities(null)
      setPrioritiesError(true)
    } finally {
      setPrioritiesLoading(false)
    }
  }, [businessId, today])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadPriorities() }, [loadPriorities])
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
          <div><p className="eyebrow">PRÓXIMAS AÇÕES</p><h2 id="attention-title">Atenção de hoje</h2></div>
          <Link className="quiet-link" to="/atendimento">Abrir atendimento <Icon name="arrow" /></Link>
        </div>
        {prioritiesLoading && <p className="inline-state" aria-live="polite">Carregando prioridades…</p>}
        {!prioritiesLoading && prioritiesError && <div className="empty-state"><span className="empty-icon"><Icon name="clock" /></span><div><h3>Não foi possível carregar as prioridades</h3><button className="text-button" onClick={() => void loadPriorities()} type="button">Tentar novamente</button></div></div>}
        {!prioritiesLoading && !prioritiesError && priorities && <div className="dashboard-priority-grid">
          <section className="dashboard-priority-block" aria-labelledby="dashboard-followups-title">
            <div className="dashboard-priority-heading"><h3 id="dashboard-followups-title">Retornos atrasados ou de hoje</h3><span>{priorities.follow_ups.pending_count}</span></div>
            {priorities.follow_ups.items.length === 0 ? <p className="dashboard-priority-empty">Nenhum retorno vencido ou com prazo para hoje.</p> : <ul className="dashboard-priority-list">
              {priorities.follow_ups.items.map((task) => <li key={task.id}>
                <Link to="/atendimento"><strong>{task.title}</strong><small>{task.customer_name ?? 'Sem cliente vinculado'}</small></Link>
                <span className={task.due_on < today ? 'dashboard-task-date is-overdue' : 'dashboard-task-date'}>{task.due_on < today ? 'Atrasado' : task.due_on === today ? 'Hoje' : formatBusinessDate(task.due_on)}</span>
              </li>)}
            </ul>}
            {priorities.follow_ups.pending_count > priorities.follow_ups.items.length && <p className="section-footnote">Mostrando {priorities.follow_ups.items.length} de {priorities.follow_ups.pending_count} retornos com prazo até hoje.</p>}
            <Link className="quiet-link" to="/atendimento">Ver retornos <Icon name="arrow" /></Link>
          </section>

          <section className="dashboard-priority-block" aria-labelledby="dashboard-receivables-title">
            <div className="dashboard-priority-heading"><h3 id="dashboard-receivables-title">Contas a receber</h3><Link className="quiet-link" to="/financeiro">Abrir <Icon name="arrow" /></Link></div>
            <dl className="dashboard-receivable-totals">
              <div><dt>Vencidas · {priorities.receivables.overdue_count}</dt><dd>{formatBRLExact(priorities.receivables.overdue_balance_cents)}</dd></div>
              <div><dt>Vencem hoje · {priorities.receivables.due_today_count}</dt><dd>{formatBRLExact(priorities.receivables.due_today_balance_cents)}</dd></div>
            </dl>
            {priorities.receivables.items.length > 0 && <ul className="dashboard-priority-list dashboard-receivable-list">
              {priorities.receivables.items.map((item) => <li key={item.installment_id}>
                <Link to={`/pedidos/${item.order_id}`}><strong>{item.customer_name}</strong><small>Vencimento {item.installment_number} · {item.overdue ? 'Atrasado' : 'Hoje'}</small></Link>
                <span className="dashboard-task-date">{formatBRLExact(item.balance_cents)}</span>
              </li>)}
            </ul>}
            {priorities.receivables.items.length > 0 && <p className="section-footnote">A lista mostra até quatro vencimentos prioritários; os totais incluem todos os saldos devidos.</p>}
            {priorities.receivables.items.length === 0 && <p className="dashboard-priority-empty">Nenhum saldo vencido ou com vencimento hoje.</p>}
          </section>

          <section className="dashboard-priority-block" aria-labelledby="dashboard-deliveries-title">
            <div className="dashboard-priority-heading"><div className="dashboard-priority-title"><h3 id="dashboard-deliveries-title">Entregas para tratar hoje</h3><span>{priorities.deliveries.pending_count}</span></div><Link className="quiet-link" to="/entregas">Abrir fila <Icon name="arrow" /></Link></div>
            {priorities.deliveries.items.length === 0 ? <p className="dashboard-priority-empty">Nenhuma entrega precisa de atualização.</p> : <ul className="dashboard-priority-list">
              {priorities.deliveries.items.map((delivery) => <li key={delivery.delivery_id}>
                <Link to={`/pedidos/${delivery.order_id}`}><strong>{delivery.customer_name}</strong><small>{deliveryStatusLabels[delivery.status]}{delivery.delivery_worker_name ? ` · ${delivery.delivery_worker_name}` : ''}</small></Link>
                <span className="dashboard-task-date">{delivery.scheduled_on === null ? 'Sem data' : delivery.scheduled_on < today ? 'Data vencida' : delivery.scheduled_on === today ? 'Hoje' : formatBusinessDate(delivery.scheduled_on)}</span>
              </li>)}
            </ul>}
            {priorities.deliveries.pending_count > priorities.deliveries.items.length && <p className="section-footnote">Mostrando {priorities.deliveries.items.length} de {priorities.deliveries.pending_count} entregas que precisam de atenção.</p>}
          </section>
        </div>}
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
            {prioritiesLoading || prioritiesError ? <Icon className="section-icon" name="box" /> : <span className="dashboard-stock-count" aria-label={`${priorities?.inventory.attention_count ?? 0} produtos em atenção`}>{priorities?.inventory.attention_count ?? 0}</span>}
          </div>
          {prioritiesLoading && <p className="inline-state" aria-live="polite">Carregando saldos…</p>}
          {!prioritiesLoading && prioritiesError && <div className="small-empty-state"><p>As informações de estoque fazem parte da atualização geral do painel. Use “Tentar novamente” acima.</p></div>}
          {!prioritiesLoading && !prioritiesError && priorities && priorities.inventory.tracked_product_count === 0 && <div className="small-empty-state"><p>Nenhum produto está configurado para controle de estoque.</p><Link className="quiet-link" to="/catalogo">Configurar produtos <Icon name="arrow" /></Link></div>}
          {!prioritiesLoading && !prioritiesError && priorities && priorities.inventory.tracked_product_count > 0 && priorities.inventory.attention_count === 0 && <div className="small-empty-state"><p>Nenhum saldo está negativo ou abaixo do mínimo definido.{priorities.inventory.without_minimum_count > 0 ? ` ${priorities.inventory.without_minimum_count} produto(s) ainda sem mínimo definido.` : ''}</p><Link className="quiet-link" to="/estoque">Abrir estoque <Icon name="arrow" /></Link></div>}
          {!prioritiesLoading && !prioritiesError && priorities && priorities.inventory.attention_count > 0 && <>
            <ul className="dashboard-stock-list">{priorities.inventory.items.map((item) => <li key={item.product_id}><span><strong>{item.product_name}</strong><small>{item.minimum_stock === null ? 'Saldo negativo · sem mínimo definido' : `${item.quantity_on_hand < 0 ? 'Saldo negativo · ' : ''}Mínimo ${formatQuantity(item.minimum_stock)} ${item.inventory_unit}`}</small></span><span className="dashboard-stock-quantity">{formatQuantity(item.quantity_on_hand)} {item.inventory_unit}</span></li>)}</ul>
            {priorities.inventory.attention_count > priorities.inventory.items.length && <p className="section-footnote">Mostrando {priorities.inventory.items.length} de {priorities.inventory.attention_count} produtos em atenção.</p>}
            {priorities.inventory.without_minimum_count > 0 && <p className="section-footnote">{priorities.inventory.without_minimum_count} produto(s) controlado(s) ainda sem mínimo definido.</p>}
            <Link className="quiet-link" to="/estoque">Ver produtos em atenção <Icon name="arrow" /></Link>
          </>}
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
