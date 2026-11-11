import { useId } from 'react'
import { Link } from 'react-router-dom'
import { formatBRLExact, formatBusinessDate } from '../lib/formatters'
import type { DashboardRevenueTrendDay } from '../lib/dashboardRevenueTrends'
import { Icon } from './Icon'

export type DashboardTrendPeriod = 'today' | 'week' | 'last_7' | 'month' | 'last_30' | 'year'

export type DashboardTrendDay = {
  business_date: string
  order_count: bigint
  receipts_cents: bigint
  paid_outflows_cents: bigint
  gross_sales_cents?: bigint
  cost_is_unknown?: boolean
}

type DashboardTrendsProps = {
  days: DashboardTrendDay[]
  startOn: string
  endOn: string
  period: DashboardTrendPeriod
  periodLabel: string
  revenueDays: DashboardRevenueTrendDay[]
  revenueLoading: boolean
  revenueError: boolean
  loading: boolean
  error: boolean
  embedded?: boolean
  onRetry: () => void
  onRetryRevenue: () => void
}

type ChartSeries = {
  key: 'order_count' | 'receipts_cents' | 'paid_outflows_cents' | 'gross_sales_cents'
  label: string
  className: string
}

const moneySeries: ChartSeries[] = [
  { key: 'receipts_cents', label: 'Pagamentos recebidos', className: 'is-receipt' },
  { key: 'paid_outflows_cents', label: 'Despesas e entregas pagas', className: 'is-outflow' },
]
const orderSeries: ChartSeries[] = [{ key: 'order_count', label: 'Vendas concluídas', className: 'is-order' }]
const integerFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })
const percentageFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })
const moneyAxisFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 })
const shortDateFormatter = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })
const monthFormatter = new Intl.DateTimeFormat('pt-BR', { month: 'short', timeZone: 'America/Sao_Paulo' })

function shortDate(value: string) {
  return shortDateFormatter.format(new Date(`${value}T12:00:00-03:00`))
}

function chartDateLabel(value: string, monthly: boolean) {
  return monthly ? monthFormatter.format(new Date(`${value}T12:00:00-03:00`)).replace('.', '') : shortDate(value)
}

function groupTrendDaysByMonth(days: DashboardTrendDay[]) {
  const months = new Map<string, DashboardTrendDay>()
  for (const day of days) {
    const monthOn = `${day.business_date.slice(0, 7)}-01`
    const month = months.get(monthOn) ?? {
      business_date: monthOn,
      order_count: 0n,
      receipts_cents: 0n,
      paid_outflows_cents: 0n,
      gross_sales_cents: 0n,
      cost_is_unknown: false,
    }
    month.order_count += day.order_count
    month.receipts_cents += day.receipts_cents
    if (month.cost_is_unknown || day.cost_is_unknown === true) {
      month.cost_is_unknown = true
      month.paid_outflows_cents = 0n
    } else {
      month.paid_outflows_cents += day.paid_outflows_cents
    }
    month.gross_sales_cents = (month.gross_sales_cents ?? 0n) + (day.gross_sales_cents ?? 0n)
    months.set(monthOn, month)
  }
  return [...months.values()]
}

function chartMaximum(value: bigint) {
  if (value === 0n) return 0n
  const magnitude = 10n ** BigInt(value.toString().length - 1)
  return ([2n, 4n, 6n, 8n, 10n].find((step) => step * magnitude >= value) ?? 10n) * magnitude
}

function barHeight(value: bigint, maximum: bigint) {
  return maximum === 0n ? 0 : Number(value * 10_000n / maximum) / 100
}

function DailyBars({ days, series, label, emptyMessage, formatValue, formatAxisValue = formatValue, monthly = false }: {
  days: DashboardTrendDay[]
  series: ChartSeries[]
  label: string
  emptyMessage: string
  formatValue: (value: bigint) => string
  formatAxisValue?: (value: bigint) => string
  monthly?: boolean
}) {
  const valueFor = (day: DashboardTrendDay, key: ChartSeries['key']) => day[key] ?? 0n
  const largestValue = days.reduce((maximum, day) => series.reduce((current, item) => valueFor(day, item.key) > current ? valueFor(day, item.key) : current, maximum), 0n)
  const maximum = chartMaximum(largestValue)
  const labelDays = monthly || days.length <= 7 ? days : [days[0], days[Math.floor((days.length - 1) / 2)], days[days.length - 1]]

  if (maximum === 0n) return <div className="dashboard-chart-empty-state" role="status"><Icon name="chart" /><p>{emptyMessage}</p></div>

  return (
    <div className={`dashboard-chart${days.length > 7 ? ' is-long-period' : ''}${monthly ? ' is-monthly' : ''}`} role="img" aria-label={label}>
      <div className="dashboard-chart-axis" aria-hidden="true">
        <span title={formatValue(maximum)}>{maximum > 0n ? formatAxisValue(maximum) : ''}</span>
        <span title={formatValue(maximum / 2n)}>{maximum > 0n ? formatAxisValue(maximum / 2n) : ''}</span>
        <span>{formatAxisValue(0n)}</span>
      </div>
      <div className="dashboard-chart-body" aria-hidden="true">
        <div className="dashboard-chart-plot">
          <div className="dashboard-chart-guides"><span /><span /><span /></div>
          <div className="dashboard-chart-days">
            {days.map((day) => (
              <div
                className={`dashboard-chart-day${series.every((item) => valueFor(day, item.key) === 0n) ? ' is-zero' : ''}`}
                key={day.business_date}
                title={`${chartDateLabel(day.business_date, monthly)} — ${series.map((item) => `${item.label}: ${item.key === 'paid_outflows_cents' && day.cost_is_unknown ? 'indisponível' : formatValue(valueFor(day, item.key))}`).join('; ')}`}
              >
                {series.map((item) => item.key === 'paid_outflows_cents' && day.cost_is_unknown
                  ? <span className="dashboard-chart-unavailable" key={item.key} title="Custo dos produtos vendidos indisponível" />
                  : <span className={`dashboard-chart-bar ${item.className}`} key={item.key} style={{ height: `${barHeight(valueFor(day, item.key), maximum)}%` }} />)}
              </div>
            ))}
          </div>
          {maximum === 0n && <p className="dashboard-chart-empty-label">{emptyMessage}</p>}
        </div>
        <div className={`dashboard-chart-dates${days.length > 7 ? ' is-long-period' : ''}${monthly ? ' is-monthly' : ''}`} style={{ gridTemplateColumns: `repeat(${labelDays.length}, minmax(0, 1fr))` }}>
          {labelDays.map((day) => <span key={day.business_date}>{chartDateLabel(day.business_date, monthly)}</span>)}
        </div>
      </div>
    </div>
  )
}

function RevenueLineChart({ days, monthly, dateRange }: { days: DashboardTrendDay[]; monthly: boolean; dateRange: string }) {
  const gradientId = useId().replaceAll(':', '')
  const chartWidth = 820
  const chartHeight = 190
  const plotLeft = 64
  const plotRight = chartWidth - 8
  const plotTop = 12
  const plotBottom = chartHeight - 10
  const series = [
    { key: 'gross_sales_cents' as const, label: 'Faturamento bruto', className: 'is-gross-sale' },
    { key: 'receipts_cents' as const, label: 'Faturamento líquido', className: 'is-sale' },
    { key: 'paid_outflows_cents' as const, label: 'Custo dos produtos vendidos', className: 'is-cost' },
  ]
  const maximum = days.reduce((largest, day) => series.reduce((current, item) => {
    if (item.key === 'paid_outflows_cents' && day.cost_is_unknown) return current
    const value = day[item.key] ?? 0n
    return value > current ? value : current
  }, largest), 0n)
  const labelDays = monthly || days.length <= 7 ? days : [days[0], days[Math.floor((days.length - 1) / 2)], days[days.length - 1]]
  const x = (index: number) => days.length <= 1 ? (plotLeft + plotRight) / 2 : plotLeft + (plotRight - plotLeft) * index / (days.length - 1)
  const y = (value: bigint) => maximum === 0n ? plotBottom : plotBottom - (Number(value * 10_000n / maximum) / 10_000) * (plotBottom - plotTop)
  const pathFor = (key: typeof series[number]['key']) => {
    let started = false
    return days.map((day, index) => {
      if (key === 'paid_outflows_cents' && day.cost_is_unknown) {
        started = false
        return ''
      }
      const command = started ? 'L' : 'M'
      started = true
      return `${command}${x(index).toFixed(1)},${y(day[key] ?? 0n).toFixed(1)}`
    }).filter(Boolean).join(' ')
  }
  const netAreaPath = days.length === 0 ? '' : [
    `M${x(0).toFixed(1)},${plotBottom}`,
    ...days.map((day, index) => `L${x(index).toFixed(1)},${y(day.receipts_cents).toFixed(1)}`),
    `L${x(days.length - 1).toFixed(1)},${plotBottom}Z`,
  ].join(' ')

  if (maximum === 0n || days.length === 0) return <div className="dashboard-chart-empty-state" role="status"><Icon name="chart" /><p>Nenhuma venda concluída neste período.</p></div>

  return (
    <div className="dashboard-revenue-chart" role="img" aria-label={`Faturamento bruto, faturamento líquido e custo dos produtos vendidos por ${monthly ? 'mês' : 'dia'}, de ${dateRange}.`}>
      <svg aria-hidden="true" className="dashboard-revenue-chart-svg" preserveAspectRatio="none" viewBox={`0 0 ${chartWidth} ${chartHeight}`}>
        <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0.01" /></linearGradient></defs>
        <path className="dashboard-revenue-chart-area" d={netAreaPath} fill={`url(#${gradientId})`} />
        {[0, 0.5, 1].map((ratio) => {
          const value = maximum - maximum * BigInt(Math.round(ratio * 2)) / 2n
          const label = moneyAxisFormatter.format(Number(value) / 100)
          const yPosition = plotTop + (plotBottom - plotTop) * ratio
          return <g key={ratio}><line className="dashboard-revenue-chart-guide" x1={plotLeft} x2={plotRight} y1={yPosition} y2={yPosition} /><text className="dashboard-revenue-chart-axis-label" textAnchor="end" x={plotLeft - 8} y={yPosition + 4}>{label}</text></g>
        })}
        {series.map((item) => <path className={`dashboard-revenue-chart-line ${item.className}`} d={pathFor(item.key)} key={item.key} />)}
        {days.map((day, index) => <g key={day.business_date}>
          {series.map((item) => item.key === 'paid_outflows_cents' && day.cost_is_unknown ? null : <circle className={`dashboard-revenue-chart-point ${item.className}`} cx={x(index)} cy={y(day[item.key] ?? 0n)} key={item.key} r="3"><title>{`${chartDateLabel(day.business_date, monthly)} · ${item.label}: ${formatBRLExact(day[item.key] ?? 0n)}`}</title></circle>)}
        </g>)}
      </svg>
      <div className={`dashboard-chart-dates dashboard-revenue-chart-dates${days.length > 7 ? ' is-long-period' : ''}${monthly ? ' is-monthly' : ''}`} style={{ gridTemplateColumns: `repeat(${labelDays.length}, minmax(0, 1fr))` }}>
        {labelDays.map((day) => <span key={day.business_date}>{chartDateLabel(day.business_date, monthly)}</span>)}
      </div>
    </div>
  )
}

function RevenueCompositionPanel({ days, loading, error, onRetry, dateRange }: {
  days: DashboardRevenueTrendDay[]
  loading: boolean
  error: boolean
  onRetry: () => void
  dateRange: string
}) {
  const netSales = days.reduce((total, day) => total + day.net_sales_cents, 0n)
  const costIsComplete = days.every((day) => day.item_cost_cents !== null)
  const profitIsComplete = days.every((day) => day.gross_profit_cents !== null)
  const productCost = costIsComplete ? days.reduce((total, day) => total + (day.item_cost_cents ?? 0n), 0n) : null
  const grossProfit = profitIsComplete ? days.reduce((total, day) => total + (day.gross_profit_cents ?? 0n), 0n) : null
  const missingCostCount = days.reduce((total, day) => total + day.missing_cost_line_count, 0)
  const returnedOrderCount = days.reduce((total, day) => total + day.returned_order_count, 0)
  const costPercentage = productCost !== null && netSales > 0n ? Number(productCost * 10_000n / netSales) / 100 : 0
  const netPercentage = 100 - costPercentage
  const headingId = useId()

  return (
    <figure className="surface-panel dashboard-trend-panel dashboard-composition-panel" aria-labelledby={headingId}>
      <div className="dashboard-trend-heading"><h3 id={headingId}>Como o valor da venda se divide</h3><span>Após descontos</span></div>
      {loading ? <div className="dashboard-composition-state" role="status"><Icon name="clock" /><p>Carregando valores…</p></div> : error ? <div className="dashboard-composition-state" role="alert"><Icon name="chart" /><p>Não foi possível carregar os valores.</p><button className="text-button" onClick={onRetry} type="button">Tentar novamente</button></div> : missingCostCount > 0 || returnedOrderCount > 0 || productCost === null || grossProfit === null ? <div className="dashboard-composition-state" role="status"><Icon name="chart" /><p>{missingCostCount > 0 ? `Falta informar o custo de ${missingCostCount} item(ns). ` : ''}{returnedOrderCount > 0 ? `${returnedOrderCount} pedido(s) têm devolução sem ajuste financeiro. ` : ''}Informe os custos para ver quanto sobrou.</p></div> : netSales === 0n ? <div className="dashboard-composition-state" role="status"><Icon name="chart" /><p>Nenhuma venda concluída neste período.</p></div> : grossProfit < 0n ? <div className="dashboard-composition-state" role="status"><Icon name="chart" /><p>O custo dos produtos passou o valor da venda em {formatBRLExact(-grossProfit)}. Este gráfico não mostra valores abaixo de zero.</p></div> : <>
        <p className="dashboard-composition-range">{dateRange}</p>
        <div className="dashboard-composition-layout">
          <div className="dashboard-composition-donut" role="img" aria-label={`Composição do faturamento líquido em ${dateRange}: custo dos produtos vendidos ${formatBRLExact(productCost)} (${percentageFormatter.format(costPercentage)} por cento); lucro bruto ${formatBRLExact(grossProfit)} (${percentageFormatter.format(netPercentage)} por cento).`} style={{ background: `conic-gradient(var(--muted) 0 ${costPercentage}%, var(--accent) ${costPercentage}% 100%)` }}>
            <div><span>Valor da venda</span><strong>100%</strong><span>depois dos descontos</span></div>
          </div>
          <ul className="dashboard-composition-legend">
            <li><span className="dashboard-composition-key is-cost" aria-hidden="true" /><span><strong>Custo dos produtos</strong><small>{percentageFormatter.format(costPercentage)}% do valor da venda</small></span></li>
            <li><span className="dashboard-composition-key is-net" aria-hidden="true" /><span><strong>Sobra antes das despesas</strong><small>{percentageFormatter.format(netPercentage)}% do valor da venda</small></span></li>
          </ul>
        </div>
      </>}
      <figcaption className="dashboard-composition-caption">Valor da venda = custo dos produtos + sobra antes das despesas.</figcaption>
    </figure>
  )
}

function ChartState({ loading, onRetry, errorMessage = 'Não foi possível carregar este período.' }: { loading: boolean; onRetry: () => void; errorMessage?: string }) {
  return (
    <div className={`dashboard-chart-state${loading ? ' is-loading' : ' is-error'}`} role="status">
      <Icon name={loading ? 'clock' : 'chart'} />
      <p>{loading ? 'Carregando o período…' : errorMessage}</p>
      {!loading && <button className="text-button" onClick={onRetry} type="button">Tentar novamente</button>}
    </div>
  )
}

export function DashboardTrends({ days, revenueDays, startOn, endOn, period, periodLabel, revenueLoading, revenueError, loading, error, embedded = false, onRetry, onRetryRevenue }: DashboardTrendsProps) {
  const headingId = useId()
  const salesHeadingId = useId()
  const moneyHeadingId = useId()
  const ordersHeadingId = useId()
  const ready = !loading && !error && days.length > 0
  const monthly = period === 'year'
  const chartDays = monthly ? groupTrendDaysByMonth(days) : days
  const revenueChartDays = monthly ? groupTrendDaysByMonth(revenueDays.map((day) => ({
    business_date: day.business_date,
    order_count: day.completed_order_count,
    receipts_cents: day.net_sales_cents,
    paid_outflows_cents: day.item_cost_cents ?? 0n,
    gross_sales_cents: day.gross_sales_cents,
    cost_is_unknown: day.item_cost_cents === null,
  }))) : revenueDays.map((day) => ({
    business_date: day.business_date,
    order_count: day.completed_order_count,
    receipts_cents: day.net_sales_cents,
    paid_outflows_cents: day.item_cost_cents ?? 0n,
    gross_sales_cents: day.gross_sales_cents,
    cost_is_unknown: day.item_cost_cents === null,
  }))
  const receipts = days.reduce((total, day) => total + day.receipts_cents, 0n)
  const outflows = days.reduce((total, day) => total + day.paid_outflows_cents, 0n)
  const missingCostCount = revenueDays.reduce((total, day) => total + day.missing_cost_line_count, 0)
  const returnedOrderCount = revenueDays.reduce((total, day) => total + day.returned_order_count, 0)
  const dateRange = `${formatBusinessDate(startOn)} a ${formatBusinessDate(endOn)}`
  const chartGranularity = monthly ? 'por mês' : 'por dia'
  const selectedPeriod = period === 'today' ? 'hoje' : periodLabel.toLocaleLowerCase('pt-BR')
  const chartPeriodDescription = period === 'today' ? 'hoje' : `${chartGranularity}, no período de ${dateRange}`
  const revenueUnitLabel = period === 'today' ? 'R$ hoje' : `R$ ${chartGranularity} · ${selectedPeriod}`
  const orderUnitLabel = period === 'today' ? 'Pedidos hoje' : `Pedidos ${chartGranularity} · ${selectedPeriod}`

  return (
    <section className="dashboard-trends" aria-labelledby={headingId}>
      {embedded ? <h2 className="visually-hidden" id={headingId}>Gráficos financeiros</h2> : <div className="section-heading dashboard-trends-heading">
        <div>
          <p className="eyebrow">GRÁFICOS</p>
          <h2 id={headingId}>Acompanhe o período</h2>
          <p className="dashboard-trends-range">{periodLabel} · {dateRange} · horário de São Paulo</p>
        </div>
      </div>}

      <div className={`dashboard-trends-grid${embedded ? ' is-financial-embedded' : ' is-dashboard-overview'}`} aria-busy={loading}>
        <figure className="surface-panel dashboard-trend-panel" aria-labelledby={salesHeadingId}>
          <div className="dashboard-trend-heading"><h3 id={salesHeadingId}>Vendas e custo</h3><span>{revenueUnitLabel}</span></div>
          {revenueLoading ? <ChartState loading onRetry={onRetryRevenue} errorMessage="Não foi possível carregar as vendas deste período." /> : revenueError ? <ChartState loading={false} onRetry={onRetryRevenue} errorMessage="Não foi possível carregar as vendas deste período." /> : <>
            <ul className="dashboard-revenue-legend" aria-label="Legenda do gráfico de vendas e custo">
              <li><span className="dashboard-chart-key is-gross-sale" aria-hidden="true" />Total cobrado</li>
              <li><span className="dashboard-chart-key is-sale" aria-hidden="true" />Total após descontos</li>
              <li><span className="dashboard-chart-key is-cost" aria-hidden="true" />Custo dos produtos</li>
            </ul>
            <RevenueLineChart days={revenueChartDays} monthly={monthly} dateRange={dateRange} />
            {(missingCostCount > 0 || returnedOrderCount > 0) && <p className="dashboard-trend-warning" role="status">{missingCostCount > 0 ? `Falta informar o custo de ${missingCostCount} item(ns). ` : ''}{returnedOrderCount > 0 ? `${returnedOrderCount} pedido(s) têm devolução sem ajuste financeiro.` : ''} O lucro bruto ficará indisponível até os dados serem conferidos.</p>}
            <details className="dashboard-trend-details dashboard-revenue-details">
              <summary>Ver valores por dia <span>{revenueDays.length} dias</span></summary>
              <div className="dashboard-trend-table-wrap" role="region" aria-label="Vendas e custos diários" tabIndex={0}>
                <table className="dashboard-trend-table">
                  <caption>Valores das vendas concluídas ou retiradas em {dateRange}.</caption>
                  <thead><tr><th scope="col">Data</th><th scope="col">Total cobrado</th><th scope="col">Descontos</th><th scope="col">Valor da venda</th><th scope="col">Custo dos produtos</th><th scope="col">Sobra antes das despesas</th></tr></thead>
                  <tbody>{revenueDays.map((day) => <tr key={day.business_date}><th scope="row">{formatBusinessDate(day.business_date)}</th><td>{formatBRLExact(day.gross_sales_cents)}</td><td>{formatBRLExact(day.discount_cents)}</td><td>{formatBRLExact(day.net_sales_cents)}</td><td>{day.item_cost_cents === null ? 'Indisponível' : formatBRLExact(day.item_cost_cents)}</td><td>{day.gross_profit_cents === null ? 'Indisponível' : formatBRLExact(day.gross_profit_cents)}</td></tr>)}</tbody>
                </table>
              </div>
            </details>
          </>}
          <figcaption className="dashboard-trend-footer"><p>O total cobrado inclui a entrega. Combos usam o custo cadastrado no Catálogo.</p><Link className="quiet-link" to="/relatorios/financeiro">Ver relatório <Icon name="arrow" /></Link></figcaption>
        </figure>

        <RevenueCompositionPanel days={revenueDays} error={revenueError} loading={revenueLoading} onRetry={onRetryRevenue} dateRange={dateRange} />

        <figure className="surface-panel dashboard-trend-panel" aria-labelledby={ordersHeadingId}>
          <div className="dashboard-trend-heading"><h3 id={ordersHeadingId}>Vendas concluídas</h3><span>{orderUnitLabel}</span></div>
          {!revenueLoading && !revenueError ? <>
            <div className="dashboard-order-total"><strong>{integerFormatter.format(revenueChartDays.reduce((total, day) => total + day.order_count, 0n))}</strong><span>concluídas no período</span></div>
            <DailyBars
              days={revenueChartDays}
              series={orderSeries}
              label={`Vendas concluídas ${chartPeriodDescription}.`}
              emptyMessage="Nenhuma venda concluída neste período"
              formatValue={(value) => integerFormatter.format(value)}
              monthly={monthly}
            />
          </> : <ChartState loading={revenueLoading} onRetry={onRetryRevenue} errorMessage="Não foi possível carregar as vendas deste período." />}
          <figcaption className="dashboard-trend-footer"><p>Pedidos cancelados ficam fora deste gráfico.</p><Link className="quiet-link" to="/pedidos">Abrir pedidos <Icon name="arrow" /></Link></figcaption>
        </figure>

        <details className="surface-panel dashboard-trend-panel dashboard-cash-panel">
          <summary className="dashboard-cash-summary"><span><strong id={moneyHeadingId}>Pagamentos e despesas</strong><small>Opcional · valores informados pela equipe</small></span><span>Ver detalhes <span aria-hidden="true">＋</span></span></summary>
          <div className="dashboard-cash-content">
          <div className="dashboard-trend-heading"><span>{revenueUnitLabel}</span><Link className="quiet-link" to="/financeiro">Abrir Dashboard <Icon name="arrow" /></Link></div>
          {ready ? <>
            <dl className="dashboard-trend-totals">
              <div><dt><span className="dashboard-chart-key is-receipt" aria-hidden="true" />Pagamentos recebidos</dt><dd>{formatBRLExact(receipts)}</dd></div>
              <div><dt><span className="dashboard-chart-key is-outflow" aria-hidden="true" />Despesas e entregas pagas</dt><dd>{formatBRLExact(outflows)}</dd></div>
            </dl>
            <DailyBars
              days={chartDays}
              series={moneySeries}
              label={`Pagamentos recebidos e despesas e entregas pagas ${chartPeriodDescription}. Totais: ${formatBRLExact(receipts)} recebidos e ${formatBRLExact(outflows)} pagos. O detalhamento diário está na tabela abaixo.`}
              emptyMessage="Nenhum pagamento ou despesa neste período"
              formatValue={formatBRLExact}
              formatAxisValue={(value) => moneyAxisFormatter.format(Number(value) / 100)}
              monthly={monthly}
            />
            <p className="dashboard-trend-insight">Pagamentos recebidos menos saídas pagas: <strong>{formatBRLExact(receipts - outflows)}</strong></p>
            <p className="dashboard-trend-empty-copy">Registros opcionais do financeiro; não representam o saldo bancário.</p>
          </> : <ChartState loading={loading} onRetry={onRetry} />}
          </div>
        </details>
      </div>

      {ready && <details className="dashboard-trend-details">
        <summary>Ver detalhamento diário <span>{days.length} dias · {periodLabel}</span></summary>
        <div className="dashboard-trend-table-wrap" role="region" aria-label="Valores diários dos gráficos" tabIndex={0}>
          <table className="dashboard-trend-table">
            <caption>Valores diários de {dateRange}, no horário de São Paulo. Dias sem registros aparecem com zero.</caption>
            <thead><tr><th scope="col">Data</th>{!embedded && <th scope="col">Pedidos criados</th>}<th scope="col">Pagamentos recebidos</th><th scope="col">Despesas e entregas pagas</th></tr></thead>
            <tbody>{days.map((day) => <tr key={day.business_date}><th scope="row">{formatBusinessDate(day.business_date)}</th>{!embedded && <td>{integerFormatter.format(day.order_count)}</td>}<td>{formatBRLExact(day.receipts_cents)}</td><td>{formatBRLExact(day.paid_outflows_cents)}</td></tr>)}</tbody>
          </table>
        </div>
      </details>}
    </section>
  )
}
