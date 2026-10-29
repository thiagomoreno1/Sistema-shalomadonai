import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { businessLocalDateTimeToIso, businessToday, formatBRLExact, formatBusinessDate } from '../lib/formatters'
import { supabaseClient } from '../lib/supabase'

type PeriodMode = 'today' | 'month' | 'custom'
type OrderRow = {
  id: string
  customer_name_snapshot: string
  subtotal_cents: number | string
  delivery_fee_cents: number | string
  discount_cents: number | string
  total_cents: number | string
  status: 'open' | 'cancelled'
  created_at: string
  cancelled_at: string | null
}
type PaymentRow = {
  id: string
  order_id: string
  amount_cents: number | string
  received_at: string
  payment_method: string | null
  customer_name: string
}
type InstallmentRow = {
  id: string
  order_id: string
  installment_number: number
  amount_cents: number | string
  due_on: string
}
type AllocationRow = { id: string; installment_id: string; amount_cents: number | string }
type Summary = {
  start_on: string
  end_on: string
  as_of_on: string
  sales: {
    record_count: number
    active_order_count: number
    active_subtotal_cents: string
    active_delivery_fee_cents: string
    active_discount_cents: string
    active_total_cents: string
    cancelled_order_count: number
    cancelled_total_cents: string
  }
  receipts: { record_count: number; amount_cents: string }
  receivables: { installment_count: number; open_balance_cents: string; overdue_balance_cents: string }
}
type ReceivableRow = InstallmentRow & { customer_name: string; balance_cents: bigint }
type QueryResponse = { data: unknown[] | null; error: unknown; count?: number | null }

async function loadAllPages<T>(loadPage: (from: number, to: number) => PromiseLike<QueryResponse>) {
  const rows: T[] = []
  let from = 0
  let expectedCount: number | null = null
  for (;;) {
    const { data, error, count } = await loadPage(from, from + 999)
    if (error) return { data: null, error }
    const page = (data ?? []) as T[]
    if (expectedCount === null && count != null) expectedCount = count
    rows.push(...page)
    if (page.length === 0) {
      if (expectedCount !== null && rows.length < expectedCount) return { data: null, error: new Error('A paginated report query ended before all rows were read.') }
      return { data: rows, error: null }
    }
    from += page.length
    if (expectedCount !== null && rows.length >= expectedCount) return { data: rows, error: null }
    if (expectedCount === null && page.length < 1000) return { data: rows, error: null }
  }
}

function cents(value: number | string) {
  return BigInt(value)
}

function nextBusinessDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

function timestampRange(startOn: string, endOn: string) {
  const startAt = businessLocalDateTimeToIso(`${startOn}T00:00`)
  const endAt = businessLocalDateTimeToIso(`${nextBusinessDate(endOn)}T00:00`)
  if (!startAt || !endAt) throw new Error('O período informado não contém datas válidas.')
  return { startAt, endAt }
}

function reportDate(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value))
}

function csvCell(value: string) {
  let index = 0
  while (index < value.length) {
    const code = value.charCodeAt(index)
    const character = value[index] ?? ''
    if (code <= 32 || code === 0xfeff || /\s/u.test(character)) index += 1
    else break
  }
  const firstSignificantCharacter = value[index] ?? ''
  const hasFormulaPrefix = ['=', '+', '-', '@'].includes(firstSignificantCharacter)
  const startsWithControlCharacter = value.length > 0 && value.charCodeAt(0) <= 31
  const safe = hasFormulaPrefix || startsWithControlCharacter ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}

function csvMoney(value: string | bigint) {
  const amount = BigInt(value)
  const sign = amount < 0n ? '-' : ''
  const absolute = amount < 0n ? -amount : amount
  return `${sign}${absolute / 100n},${(absolute % 100n).toString().padStart(2, '0')}`
}

function statusLabel(order: OrderRow) {
  if (order.status === 'cancelled') return order.cancelled_at ? `Cancelado em ${reportDate(order.cancelled_at)}` : 'Cancelado'
  return 'Ativo'
}

export function ReportsPage() {
  const { id: businessId } = useBusiness()
  const today = useMemo(() => businessToday(), [])
  const firstDayOfMonth = `${today.slice(0, 7)}-01`
  const [periodMode, setPeriodMode] = useState<PeriodMode>('month')
  const [customStart, setCustomStart] = useState(firstDayOfMonth)
  const [customEnd, setCustomEnd] = useState(today)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [receivables, setReceivables] = useState<ReceivableRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reconciliationWarning, setReconciliationWarning] = useState(false)
  const reportRequestId = useRef(0)

  const { startOn, endOn } = useMemo(() => {
    if (periodMode === 'today') return { startOn: today, endOn: today }
    if (periodMode === 'month') return { startOn: firstDayOfMonth, endOn: today }
    return { startOn: customStart, endOn: customEnd }
  }, [customEnd, customStart, firstDayOfMonth, periodMode, today])
  const rangeError = useMemo(() => {
    if (periodMode !== 'custom') return null
    if (!customStart || !customEnd) return 'Informe as duas datas do intervalo.'
    if (customEnd < customStart) return 'A data final deve ser igual ou posterior à data inicial.'
    return null
  }, [customEnd, customStart, periodMode])

  const loadReport = useCallback(async () => {
    const requestId = reportRequestId.current + 1
    reportRequestId.current = requestId
    const client = supabaseClient
    if (!client) {
      setError('A conexão da empresa não está disponível.')
      setLoading(false)
      return
    }
    if (rangeError || !startOn || !endOn || endOn < startOn) {
      setError(null)
      setSummary(null)
      setOrders([])
      setPayments([])
      setReceivables([])
      setReconciliationWarning(false)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const { startAt, endAt } = timestampRange(startOn, endOn)
      const [orderResult, paymentResult, installmentResult] = await Promise.all([
        loadAllPages<OrderRow>((from, to) => client.from('orders')
          .select('id, customer_name_snapshot, subtotal_cents, delivery_fee_cents, discount_cents, total_cents, status, created_at, cancelled_at', { count: 'exact' })
          .eq('business_id', businessId)
          .gte('created_at', startAt)
          .lt('created_at', endAt)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to)),
        loadAllPages<PaymentRow>((from, to) => client.from('order_payments')
          .select('id, order_id, amount_cents, received_at, payment_method', { count: 'exact' })
          .eq('business_id', businessId)
          .gte('received_at', startAt)
          .lt('received_at', endAt)
          .order('received_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to)),
        loadAllPages<InstallmentRow>((from, to) => client.from('order_installments')
          .select('id, order_id, installment_number, amount_cents, due_on', { count: 'exact' })
          .eq('business_id', businessId)
          .gte('due_on', startOn)
          .lte('due_on', endOn)
          .order('due_on', { ascending: true })
          .order('order_id', { ascending: true })
          .order('installment_number', { ascending: true })
          .range(from, to)),
      ])

      if (reportRequestId.current !== requestId) return
      if (orderResult.error || paymentResult.error || installmentResult.error) {
        throw new Error('Não foi possível carregar todos os dados deste período. Tente novamente.')
      }

      const loadedOrders = orderResult.data ?? []
      const loadedPayments = paymentResult.data ?? []
      const loadedInstallments = installmentResult.data ?? []
      const referencedOrderIds = Array.from(new Set([
        ...loadedPayments.map((payment) => payment.order_id),
        ...loadedInstallments.map((installment) => installment.order_id),
      ]))
      const relatedOrders: Array<Pick<OrderRow, 'id' | 'customer_name_snapshot' | 'status'>> = []
      for (let start = 0; start < referencedOrderIds.length; start += 100) {
        if (reportRequestId.current !== requestId) return
        const batch = referencedOrderIds.slice(start, start + 100)
        const { data, error: relatedOrderError } = await client.from('orders')
          .select('id, customer_name_snapshot, status')
          .eq('business_id', businessId)
          .in('id', batch)
        if (relatedOrderError) throw relatedOrderError
        relatedOrders.push(...(data ?? []))
      }
      const orderById = new Map(relatedOrders.map((order) => [order.id, order]))
      const installmentIds = loadedInstallments.map((installment) => installment.id)
      const allocations: AllocationRow[] = []
      for (let start = 0; start < installmentIds.length; start += 100) {
        if (reportRequestId.current !== requestId) return
        const batch = installmentIds.slice(start, start + 100)
        const allocationResult = await loadAllPages<AllocationRow>((from, to) => client.from('order_payment_allocations')
          .select('id, installment_id, amount_cents', { count: 'exact' })
          .eq('business_id', businessId)
          .in('installment_id', batch)
          .order('installment_id', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to))
        if (allocationResult.error) throw allocationResult.error
        allocations.push(...(allocationResult.data ?? []))
      }
      if (reportRequestId.current !== requestId) return
      const summaryResult = await client.rpc('get_financial_report_summary', {
        p_business_id: businessId,
        p_start_on: startOn,
        p_end_on: endOn,
      })
      if (summaryResult.error || !summaryResult.data) throw new Error('Não foi possível calcular o resumo deste período.')

      const paidByInstallment = new Map<string, bigint>()
      for (const allocation of allocations) {
        paidByInstallment.set(allocation.installment_id, (paidByInstallment.get(allocation.installment_id) ?? 0n) + cents(allocation.amount_cents))
      }
      const outstanding = loadedInstallments.flatMap((installment) => {
        const order = orderById.get(installment.order_id)
        const balance = cents(installment.amount_cents) - (paidByInstallment.get(installment.id) ?? 0n)
        if (!order || order.status !== 'open' || balance <= 0n) return []
        return [{ ...installment, customer_name: order.customer_name_snapshot, balance_cents: balance }]
      })
      const paymentsWithCustomer = loadedPayments.map((payment) => ({
        ...payment,
        customer_name: orderById.get(payment.order_id)?.customer_name_snapshot ?? 'Pedido não disponível',
      }))
      const reportSummary = summaryResult.data as Summary
      const activeOrders = loadedOrders.filter((order) => order.status === 'open')
      const cancelledOrders = loadedOrders.filter((order) => order.status === 'cancelled')
      const sum = (values: Array<number | string>) => values.reduce((total, value) => total + cents(value), 0n)
      const listOpenBalance = outstanding.reduce((total, item) => total + item.balance_cents, 0n)
      const listOverdueBalance = outstanding
        .filter((item) => item.due_on < reportSummary.as_of_on)
        .reduce((total, item) => total + item.balance_cents, 0n)
      const summaryMismatch =
        reportSummary.sales.record_count !== loadedOrders.length ||
        reportSummary.sales.active_order_count !== activeOrders.length ||
        reportSummary.sales.cancelled_order_count !== cancelledOrders.length ||
        BigInt(reportSummary.sales.active_subtotal_cents) !== sum(activeOrders.map((order) => order.subtotal_cents)) ||
        BigInt(reportSummary.sales.active_delivery_fee_cents) !== sum(activeOrders.map((order) => order.delivery_fee_cents)) ||
        BigInt(reportSummary.sales.active_discount_cents) !== sum(activeOrders.map((order) => order.discount_cents)) ||
        BigInt(reportSummary.sales.active_total_cents) !== sum(activeOrders.map((order) => order.total_cents)) ||
        BigInt(reportSummary.sales.cancelled_total_cents) !== sum(cancelledOrders.map((order) => order.total_cents)) ||
        reportSummary.receipts.record_count !== loadedPayments.length ||
        BigInt(reportSummary.receipts.amount_cents) !== sum(loadedPayments.map((payment) => payment.amount_cents)) ||
        reportSummary.receivables.installment_count !== outstanding.length ||
        BigInt(reportSummary.receivables.open_balance_cents) !== listOpenBalance ||
        BigInt(reportSummary.receivables.overdue_balance_cents) !== listOverdueBalance

      if (reportRequestId.current !== requestId) return
      setSummary(reportSummary)
      setOrders(loadedOrders)
      setPayments(paymentsWithCustomer)
      setReceivables(outstanding)
      setReconciliationWarning(summaryMismatch)
    } catch {
      if (reportRequestId.current !== requestId) return
      setError('Não foi possível carregar todos os dados deste período. Tente novamente.')
      setSummary(null)
      setOrders([])
      setPayments([])
      setReceivables([])
      setReconciliationWarning(false)
    } finally {
      if (reportRequestId.current === requestId) setLoading(false)
    }
  }, [businessId, endOn, rangeError, startOn])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void loadReport()
    return () => { reportRequestId.current += 1 }
  }, [loadReport])

  const reportMatchesPeriod = Boolean(summary && summary.start_on === startOn && summary.end_on === endOn)
  const reportCanBeUsed = reportMatchesPeriod && !loading && !error && !reconciliationWarning

  function exportCsv() {
    if (!summary) return
    const rows: string[][] = [
      ['Relatório financeiro', `${formatBusinessDate(summary.start_on)} a ${formatBusinessDate(summary.end_on)}`],
      ['Escopo', 'Este arquivo contém pedidos, recebimentos informados manualmente e vencimentos em aberto. Não inclui lançamentos financeiros de compras, despesas, custos de entrega, reembolsos ou movimentos bancários. Não calcula fluxo de caixa líquido, conciliação bancária ou resultado gerencial.'],
      ['Nota sobre recebimentos', 'Os recebimentos são informados manualmente pelo proprietário; o sistema não processa nem verifica pagamentos ou créditos bancários.'],
      ['Pedidos ativos no período', String(summary.sales.active_order_count)],
      ['Subtotal de produtos (R$)', csvMoney(summary.sales.active_subtotal_cents)],
      ['Taxas de entrega cobradas (R$)', csvMoney(summary.sales.active_delivery_fee_cents)],
      ['Descontos informados (R$)', csvMoney(summary.sales.active_discount_cents)],
      ['Total de pedidos ativos (R$)', csvMoney(summary.sales.active_total_cents)],
      ['Pedidos criados no período atualmente cancelados', String(summary.sales.cancelled_order_count)],
      ['Total originalmente registrado nesses pedidos atualmente cancelados (R$)', csvMoney(summary.sales.cancelled_total_cents)],
      ['Recebimentos informados no período (R$)', csvMoney(summary.receipts.amount_cents)],
      [`Saldos em vencimentos do período, apurados em ${formatBusinessDate(summary.as_of_on)} (R$)`, csvMoney(summary.receivables.open_balance_cents)],
      [`Parte vencida desse saldo em ${formatBusinessDate(summary.as_of_on)} (R$)`, csvMoney(summary.receivables.overdue_balance_cents)],
      [],
      ['Pedidos', 'Data do pedido', 'Cliente', 'Produtos (R$)', 'Taxa cobrada (R$)', 'Desconto (R$)', 'Total original (R$)', 'Situação'],
      ...orders.map((order) => [order.id, reportDate(order.created_at), order.customer_name_snapshot, csvMoney(String(order.subtotal_cents)), csvMoney(String(order.delivery_fee_cents)), csvMoney(String(order.discount_cents)), csvMoney(String(order.total_cents)), statusLabel(order)]),
      [],
      ['Recebimentos informados', 'Data do recebimento', 'Cliente', 'Forma informada', 'Valor (R$)'],
      ...payments.map((payment) => [payment.order_id, reportDate(payment.received_at), payment.customer_name, payment.payment_method ?? '', csvMoney(String(payment.amount_cents))]),
      [],
      ['Vencimentos ainda em aberto', 'Vencimento', 'Cliente', 'Parcela', 'Valor original (R$)', 'Saldo apurado hoje (R$)', 'Situação'],
      ...receivables.map((item) => [item.order_id, formatBusinessDate(item.due_on), item.customer_name, String(item.installment_number), csvMoney(String(item.amount_cents)), csvMoney(item.balance_cents), item.due_on < (summary.as_of_on ?? today) ? 'Vencido' : 'Em aberto']),
    ]
    const content = `\uFEFF${rows.map((row) => row.map(csvCell).join(';')).join('\r\n')}`
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `relatorio-financeiro-${summary.start_on}-${summary.end_on}.csv`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="page-stack report-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">FINANCEIRO · CONSULTA</p>
          <h1>Relatórios</h1>
          <p className="page-description">Valores separados pela data de cada registro. Sem integração bancária.</p>
        </div>
        <div className="record-heading-actions report-actions">
          <button className="button button-secondary" disabled={!reportCanBeUsed} onClick={exportCsv} type="button">Exportar CSV</button>
          <button className="button button-secondary" disabled={!reportCanBeUsed} onClick={() => window.print()} type="button">Imprimir</button>
        </div>
      </header>
      <p className="report-print-range">Período: {reportMatchesPeriod && summary ? `${formatBusinessDate(summary.start_on)} a ${formatBusinessDate(summary.end_on)}` : startOn && endOn ? `${formatBusinessDate(startOn)} a ${formatBusinessDate(endOn)}` : 'Datas pendentes'} · Saldos a receber apurados em {formatBusinessDate(summary?.as_of_on ?? today)}</p>

      <section className="surface-panel record-panel report-period-panel" aria-label="Período do relatório">
        <div className="report-period-controls">
          <label className="record-field"><span className="field-label">Período</span><select className="text-input" onChange={(event) => setPeriodMode(event.target.value as PeriodMode)} value={periodMode}><option value="today">Hoje</option><option value="month">Este mês até hoje</option><option value="custom">Intervalo personalizado</option></select></label>
          {periodMode === 'custom' && <>
            <label className="record-field"><span className="field-label">De</span><input aria-describedby={rangeError ? 'report-period-error' : undefined} aria-invalid={Boolean(rangeError)} className="text-input" max={customEnd || undefined} onChange={(event) => setCustomStart(event.target.value)} type="date" value={customStart} /></label>
            <label className="record-field"><span className="field-label">Até</span><input aria-describedby={rangeError ? 'report-period-error' : undefined} aria-invalid={Boolean(rangeError)} className="text-input" min={customStart || undefined} onChange={(event) => setCustomEnd(event.target.value)} type="date" value={customEnd} /></label>
          </>}
          {rangeError && <p className="form-message form-message-error report-period-error" id="report-period-error" role="alert">{rangeError}</p>}
          <p className="section-footnote">Período atual: {startOn && endOn ? `${formatBusinessDate(startOn)} a ${formatBusinessDate(endOn)}` : 'datas inválidas'}. Saldos a receber consideram apenas vencimentos do intervalo e são apurados na data de hoje ({formatBusinessDate(summary?.as_of_on ?? today)}).</p>
        </div>
      </section>

      {error && <div className="inline-state inline-state-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => void loadReport()} type="button">Tentar novamente</button></div>}
      {(loading || (summary !== null && !reportMatchesPeriod)) && <p className="inline-state" aria-live="polite">Carregando lançamentos do período…</p>}

      {!loading && reportMatchesPeriod && summary && !error && <>
        {reconciliationWarning && <div className="form-message form-message-warning report-reconciliation-warning" role="alert"><span>O resumo e os lançamentos detalhados não coincidem neste carregamento. Confira novamente antes de usar estes valores.</span><button className="text-button" disabled={loading} onClick={() => void loadReport()} type="button">Reconciliar novamente</button></div>}
        {!reconciliationWarning && <>
        <section className="report-summary-grid" aria-label="Resumo do período">
          <article className="surface-panel report-summary-card"><span>Pedidos ativos criados</span><strong>{formatBRLExact(summary.sales.active_total_cents)}</strong><small>{summary.sales.active_order_count} pedidos · inclui desconto e taxa informada</small></article>
          <article className="surface-panel report-summary-card"><span>Recebimentos informados</span><strong>{formatBRLExact(summary.receipts.amount_cents)}</strong><small>{summary.receipts.record_count} registros · não processados pelo sistema</small></article>
          <article className="surface-panel report-summary-card"><span>Saldo em vencimentos do período</span><strong>{formatBRLExact(summary.receivables.open_balance_cents)}</strong><small>Saldo atual · {summary.receivables.installment_count} parcelas em aberto</small></article>
          <article className="surface-panel report-summary-card"><span>Vencido hoje nesse período</span><strong>{formatBRLExact(summary.receivables.overdue_balance_cents)}</strong><small>Em aberto com vencimento anterior a hoje</small></article>
        </section>

        <section className="surface-panel report-definition-panel" aria-labelledby="report-result-title">
          <div><p className="eyebrow">RESULTADO GERENCIAL</p><h2 id="report-result-title">Cálculo pendente de validação</h2><p>A fórmula, a cobertura do custo dos produtos e o tratamento de descontos, entrega e compras ainda precisam ser confirmados. O fluxo de caixa e as vendas registradas não são apresentados como lucro.</p><p className="report-scope-note">Escopo atual: ainda não há lançamentos financeiros de compras, despesas ou custos de entrega. As entradas abaixo são recebimentos informados manualmente; não representam fluxo líquido, saldo bancário ou conciliação.</p></div>
          <Link className="quiet-link report-related-link" to="/financeiro">Abrir contas a receber</Link>
        </section>

        <section className="surface-panel record-panel report-section" aria-labelledby="report-sales-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">DATA DO PEDIDO</p><h2 id="report-sales-title">Pedidos criados no período</h2></div><span className="neutral-status">{orders.length}</span></div>
          <div className="report-breakdown" aria-label="Composição dos pedidos ativos">
            <span>Produtos <strong>{formatBRLExact(summary.sales.active_subtotal_cents)}</strong></span>
            <span>Taxa cobrada <strong>{formatBRLExact(summary.sales.active_delivery_fee_cents)}</strong></span>
            <span>Descontos <strong>{formatBRLExact(summary.sales.active_discount_cents)}</strong></span>
            <span>Atualmente cancelados entre os pedidos criados no período <strong>{summary.sales.cancelled_order_count} · {formatBRLExact(summary.sales.cancelled_total_cents)}</strong></span>
          </div>
          <p className="section-footnote">A lista usa a data de criação do pedido e mostra a situação atual. Um cancelamento posterior pode alterar os totais ativos de um período anterior; a data do cancelamento aparece em cada linha.</p>
          {orders.length === 0 ? <p className="inline-state">Nenhum pedido criado no período.</p> : <div aria-label="Tabela de pedidos do período" className="report-table-wrap" role="region" tabIndex={0}><table className="report-table"><thead><tr><th>Data</th><th>Pedido / cliente</th><th>Produtos</th><th>Taxa</th><th>Desconto</th><th>Total original</th><th>Situação atual</th></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td>{reportDate(order.created_at)}</td><td><Link className="report-order-link" to={`/pedidos/${order.id}`}>{order.customer_name_snapshot}</Link></td><td>{formatBRLExact(String(order.subtotal_cents))}</td><td>{formatBRLExact(String(order.delivery_fee_cents))}</td><td>{formatBRLExact(String(order.discount_cents))}</td><td>{formatBRLExact(String(order.total_cents))}</td><td>{statusLabel(order)}</td></tr>)}</tbody></table></div>}
        </section>

        <section className="surface-panel record-panel report-section" aria-labelledby="report-receipts-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">DATA DO RECEBIMENTO</p><h2 id="report-receipts-title">Recebimentos informados</h2></div><span className="neutral-status">{payments.length}</span></div>
          {payments.length === 0 ? <p className="inline-state">Nenhum recebimento informado no período.</p> : <div aria-label="Tabela de recebimentos informados" className="report-table-wrap" role="region" tabIndex={0}><table className="report-table"><thead><tr><th>Data</th><th>Pedido</th><th>Cliente</th><th>Forma informada</th><th>Valor</th></tr></thead><tbody>{payments.map((payment) => <tr key={payment.id}><td>{reportDate(payment.received_at)}</td><td><Link className="report-order-link" to={`/pedidos/${payment.order_id}`}>Abrir pedido</Link></td><td>{payment.customer_name}</td><td>{payment.payment_method || 'Não informada'}</td><td>{formatBRLExact(String(payment.amount_cents))}</td></tr>)}</tbody></table></div>}
        </section>

        <section className="surface-panel record-panel report-section" aria-labelledby="report-receivables-title">
          <div className="section-heading section-heading-compact"><div><p className="eyebrow">DATA DO VENCIMENTO</p><h2 id="report-receivables-title">Parcelas ainda em aberto no período</h2></div><span className="neutral-status">{receivables.length}</span></div>
          {receivables.length === 0 ? <p className="inline-state">Nenhum saldo em aberto nos vencimentos deste período.</p> : <div aria-label="Tabela de vencimentos em aberto" className="report-table-wrap" role="region" tabIndex={0}><table className="report-table"><thead><tr><th>Vencimento</th><th>Cliente / pedido</th><th>Parcela</th><th>Valor original</th><th>Saldo hoje</th><th>Situação hoje</th></tr></thead><tbody>{receivables.map((item) => <tr key={item.id}><td>{formatBusinessDate(item.due_on)}</td><td><Link className="report-order-link" to={`/pedidos/${item.order_id}`}>{item.customer_name}</Link></td><td>{item.installment_number}</td><td>{formatBRLExact(String(item.amount_cents))}</td><td>{formatBRLExact(item.balance_cents.toString())}</td><td>{item.due_on < (summary.as_of_on ?? today) ? 'Vencido' : 'Em aberto'}</td></tr>)}</tbody></table></div>}
          <p className="section-footnote">Saldo calculado hoje em pedidos ativos, após alocações de recebimentos informadas. A soma da lista é conferida com o resumo do banco.</p>
        </section>
        </>}
      </>}
    </div>
  )
}
