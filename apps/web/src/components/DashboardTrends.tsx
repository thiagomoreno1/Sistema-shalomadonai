import { useId } from 'react'
import { Link } from 'react-router-dom'
import { formatBRLExact, formatBusinessDate } from '../lib/formatters'
import type { DashboardRevenueTrendDay } from '../lib/dashboardRevenueTrends'
import { Icon } from './Icon'

export type DashboardTrendPeriod = 'week' | 'last_7' | 'month' | 'last_30' | 'year'

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
  { key: 'paid_outflows_cents', label: 'Gastos pagos', className: 'is-outflow' },
]
const orderSeries: ChartSeries[] = [{ key: 'order_count', label: 'Pedidos registrados', className: 'is-order' }]
const revenueSeries: ChartSeries[] = [
  { key: 'gross_sales_cents', label: 'Faturamento bruto', className: 'is-gross-sale' },
  { key: 'receipts_cents', label: 'Vendas após descontos', className: 'is-sale' },
  { key: 'paid_outflows_cents', label: 'Custo dos produtos', className: 'is-cost' },
]
const integerFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })
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
                  ? <span className="dashboard-chart-unavailable" key={item.key} title="Custo dos produtos indisponível" />
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

type ProfitPoint = { business_date: string; value: bigint | null }

function groupProfitByMonth(days: DashboardRevenueTrendDay[]): ProfitPoint[] {
  const months = new Map<string, ProfitPoint>()
  for (const day of days) {
    const businessDate = `${day.business_date.slice(0, 7)}-01`
    const month = months.get(businessDate)
    if (!month) {
      months.set(businessDate, { business_date: businessDate, value: day.gross_profit_cents })
    } else if (month.value !== null && day.gross_profit_cents !== null) {
      month.value += day.gross_profit_cents
    } else {
      month.value = null
    }
  }
  return [...months.values()]
}

function DailyProfitBars({ days, monthly, dateRange }: { days: DashboardRevenueTrendDay[]; monthly: boolean; dateRange: string }) {
  const points: ProfitPoint[] = monthly ? groupProfitByMonth(days) : days.map((day) => ({ business_date: day.business_date, value: day.gross_profit_cents }))
  const maximum = points.reduce((largest, point) => {
    if (point.value === null) return largest
    const absolute = point.value < 0n ? -point.value : point.value
    return absolute > largest ? absolute : largest
  }, 0n)
  const hasKnownPoint = points.some((point) => point.value !== null)
  const hasUnknownPoint = points.some((point) => point.value === null)
  const labelPoints = monthly || points.length <= 7 ? points : [points[0], points[Math.floor((points.length - 1) / 2)], points[points.length - 1]]
  const barHeightPercent = (value: bigint) => maximum === 0n ? 0 : Number((value < 0n ? -value : value) * 5_000n / maximum) / 100

  return (
    <div className={`dashboard-chart dashboard-profit-chart${points.length > 7 ? ' is-long-period' : ''}${monthly ? ' is-monthly' : ''}`} role="img" aria-label={`Faturamento líquido por ${monthly ? 'mês' : 'dia'}, de ${dateRange}. O valor é calculado após descontos e custo dos produtos; pode haver prejuízo.`}>
      <div className="dashboard-chart-axis" aria-hidden="true">
        <span>{maximum > 0n ? moneyAxisFormatter.format(Number(maximum) / 100) : ''}</span>
        <span>R$ 0</span>
        <span>{maximum > 0n ? `−${moneyAxisFormatter.format(Number(maximum) / 100)}` : ''}</span>
      </div>
      <div className="dashboard-chart-body">
        <div className="dashboard-chart-plot dashboard-profit-plot" aria-hidden="true">
          <div className="dashboard-chart-guides"><span /><span /><span /></div>
          <div className="dashboard-profit-days">
            {points.map((point) => point.value === null
              ? <span className="dashboard-profit-day is-unavailable" key={point.business_date} title={`${chartDateLabel(point.business_date, monthly)} — faturamento líquido indisponível`} />
              : <span className="dashboard-profit-day" key={point.business_date} title={`${chartDateLabel(point.business_date, monthly)} — ${formatBRLExact(point.value)}`}>
                {point.value !== 0n && <span className={`dashboard-profit-bar${point.value < 0n ? ' is-negative' : ' is-positive'}`} style={{ height: `${barHeightPercent(point.value)}%` }} />}
              </span>)}
          </div>
          <span className="dashboard-profit-zero-line" />
          {maximum === 0n && <p className="dashboard-chart-empty-label">{hasUnknownPoint ? 'Há dias sem custo confirmado' : hasKnownPoint ? 'Sem lucro ou prejuízo no período' : 'Faturamento líquido indisponível'}</p>}
        </div>
        <div className={`dashboard-chart-dates${points.length > 7 ? ' is-long-period' : ''}${monthly ? ' is-monthly' : ''}`} style={{ gridTemplateColumns: `repeat(${labelPoints.length}, minmax(0, 1fr))` }}>
          {labelPoints.map((point) => <span key={point.business_date}>{chartDateLabel(point.business_date, monthly)}</span>)}
        </div>
      </div>
    </div>
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
  const orders = days.reduce((total, day) => total + day.order_count, 0n)
  const revenueTotal = revenueDays.reduce((total, day) => total + day.net_sales_cents, 0n)
  const grossSalesTotal = revenueDays.reduce((total, day) => total + day.gross_sales_cents, 0n)
  const discountTotal = revenueDays.reduce((total, day) => total + day.discount_cents, 0n)
  const costIsComplete = revenueDays.every((day) => day.item_cost_cents !== null)
  const profitIsComplete = revenueDays.every((day) => day.gross_profit_cents !== null)
  const productCostTotal = costIsComplete ? revenueDays.reduce((total, day) => total + (day.item_cost_cents ?? 0n), 0n) : null
  const grossProfitTotal = profitIsComplete ? revenueDays.reduce((total, day) => total + (day.gross_profit_cents ?? 0n), 0n) : null
  const missingCostCount = revenueDays.reduce((total, day) => total + day.missing_cost_line_count, 0)
  const returnedOrderCount = revenueDays.reduce((total, day) => total + day.returned_order_count, 0)
  const busiestDay = days.reduce<DashboardTrendDay | null>((busiest, day) => !busiest || day.order_count > busiest.order_count ? day : busiest, null)
  const peakDayCount = busiestDay ? days.filter((day) => day.order_count === busiestDay.order_count).length : 0
  const dateRange = `${formatBusinessDate(startOn)} a ${formatBusinessDate(endOn)}`
  const timeUnit = monthly ? 'mês' : 'dia'

  return (
    <section className="dashboard-trends" aria-labelledby={headingId}>
      {embedded ? <h2 className="visually-hidden" id={headingId}>Gráficos financeiros</h2> : <div className="section-heading dashboard-trends-heading">
        <div>
          <p className="eyebrow">GRÁFICOS</p>
          <h2 id={headingId}>Acompanhe o período</h2>
          <p className="dashboard-trends-range">{periodLabel} · {dateRange} · horário de São Paulo</p>
        </div>
      </div>}

      <div className="dashboard-trends-grid" aria-busy={loading}>
        <figure className="surface-panel dashboard-trend-panel" aria-labelledby={salesHeadingId}>
          <div className="dashboard-trend-heading"><h3 id={salesHeadingId}>Faturamento e custo</h3><span>R$ por {timeUnit}</span></div>
          {revenueLoading ? <ChartState loading onRetry={onRetryRevenue} errorMessage="Não foi possível carregar as vendas deste período." /> : revenueError ? <ChartState loading={false} onRetry={onRetryRevenue} errorMessage="Não foi possível carregar as vendas deste período." /> : <>
            <dl className="dashboard-trend-totals revenue-trend-totals">
              <div><dt><span className="dashboard-chart-key is-gross-sale" aria-hidden="true" />Faturamento bruto</dt><dd>{formatBRLExact(grossSalesTotal)}</dd></div>
              <div><dt><span className="dashboard-chart-key is-sale" aria-hidden="true" />Vendas após descontos</dt><dd>{formatBRLExact(revenueTotal)}</dd></div>
              <div><dt>Descontos</dt><dd>{formatBRLExact(discountTotal)}</dd></div>
              <div><dt><span className="dashboard-chart-key is-cost" aria-hidden="true" />Custo dos produtos</dt><dd>{productCostTotal === null ? 'Indisponível' : formatBRLExact(productCostTotal)}</dd></div>
              <div className="is-profit"><dt>Faturamento líquido</dt><dd>{grossProfitTotal === null ? 'Indisponível' : formatBRLExact(grossProfitTotal)}</dd></div>
            </dl>
            <DailyBars
              days={revenueChartDays}
              series={revenueSeries}
              label={`Faturamento bruto, vendas após descontos e custo dos produtos, por ${timeUnit}, de ${dateRange}. Faturamento líquido após o custo: ${grossProfitTotal === null ? 'indisponível' : formatBRLExact(grossProfitTotal)}.`}
              emptyMessage="Nenhuma venda concluída neste período"
              formatValue={formatBRLExact}
              formatAxisValue={(value) => moneyAxisFormatter.format(Number(value) / 100)}
              monthly={monthly}
            />
            {(missingCostCount > 0 || returnedOrderCount > 0) && <p className="dashboard-trend-warning" role="status">{missingCostCount > 0 ? `Falta informar o custo de ${missingCostCount} item(ns). ` : ''}{returnedOrderCount > 0 ? `${returnedOrderCount} pedido(s) têm devolução sem ajuste financeiro.` : ''} O faturamento líquido ficará indisponível até os dados serem conferidos.</p>}
            <h4 className="dashboard-profit-heading">Faturamento líquido por dia</h4>
            <DailyProfitBars days={revenueDays} monthly={monthly} dateRange={dateRange} />
            <details className="dashboard-trend-details dashboard-revenue-details">
              <summary>Ver vendas e custos por dia <span>{revenueDays.length} dias</span></summary>
              <div className="dashboard-trend-table-wrap" role="region" aria-label="Vendas e custos diários" tabIndex={0}>
                <table className="dashboard-trend-table">
                  <caption>Faturamento pelas entregas concluídas ou retiradas em {dateRange}.</caption>
                  <thead><tr><th scope="col">Data</th><th scope="col">Faturamento bruto</th><th scope="col">Descontos</th><th scope="col">Vendas após descontos</th><th scope="col">Custo dos produtos</th><th scope="col">Faturamento líquido</th></tr></thead>
                  <tbody>{revenueDays.map((day) => <tr key={day.business_date}><th scope="row">{formatBusinessDate(day.business_date)}</th><td>{formatBRLExact(day.gross_sales_cents)}</td><td>{formatBRLExact(day.discount_cents)}</td><td>{formatBRLExact(day.net_sales_cents)}</td><td>{day.item_cost_cents === null ? 'Indisponível' : formatBRLExact(day.item_cost_cents)}</td><td>{day.gross_profit_cents === null ? 'Indisponível' : formatBRLExact(day.gross_profit_cents)}</td></tr>)}</tbody>
                </table>
              </div>
            </details>
          </>}
          <figcaption className="dashboard-trend-footer"><p>O bruto inclui taxa de entrega; combo usa o custo do catálogo.</p><Link className="quiet-link" to="/relatorios">Ver relatórios <Icon name="arrow" /></Link></figcaption>
        </figure>

        <figure className="surface-panel dashboard-trend-panel" aria-labelledby={moneyHeadingId}>
          <div className="dashboard-trend-heading"><h3 id={moneyHeadingId}>Caixa informado</h3><span>R$ por {timeUnit}</span></div>
          {ready ? <>
            <dl className="dashboard-trend-totals">
              <div><dt><span className="dashboard-chart-key is-receipt" aria-hidden="true" />Pagamentos recebidos</dt><dd>{formatBRLExact(receipts)}</dd></div>
              <div><dt><span className="dashboard-chart-key is-outflow" aria-hidden="true" />Gastos pagos</dt><dd>{formatBRLExact(outflows)}</dd></div>
            </dl>
            <DailyBars
              days={chartDays}
              series={moneySeries}
              label={`Pagamentos recebidos e gastos pagos por ${timeUnit}, de ${dateRange}. Totais: ${formatBRLExact(receipts)} recebidos e ${formatBRLExact(outflows)} pagos. O detalhamento diário está na tabela abaixo.`}
              emptyMessage="Nenhuma movimentação neste período"
              formatValue={formatBRLExact}
              formatAxisValue={(value) => moneyAxisFormatter.format(Number(value) / 100)}
              monthly={monthly}
            />
            <p className="dashboard-trend-insight">Entradas menos gastos: <strong>{formatBRLExact(receipts - outflows)}</strong></p>
            {receipts === 0n && outflows === 0n && <p className="dashboard-trend-empty-copy">Registre pagamentos recebidos e gastos pagos para acompanhar o dinheiro ao longo do período.</p>}
          </> : <ChartState loading={loading} onRetry={onRetry} />}
          <figcaption className="dashboard-trend-footer"><p>Valores registrados manualmente; não são o saldo bancário.</p><Link className="quiet-link" to="/financeiro">Abrir financeiro <Icon name="arrow" /></Link></figcaption>
        </figure>

        {!embedded && <figure className="surface-panel dashboard-trend-panel" aria-labelledby={ordersHeadingId}>
          <div className="dashboard-trend-heading"><h3 id={ordersHeadingId}>Pedidos registrados</h3><span>Pedidos por {timeUnit}</span></div>
          {ready ? <>
            <div className="dashboard-order-total"><strong>{integerFormatter.format(orders)}</strong><span>{orders === 1n ? 'pedido no período' : 'pedidos no período'}</span></div>
            <DailyBars
              days={chartDays}
              series={orderSeries}
              label={`Pedidos registrados por ${timeUnit}, de ${dateRange}. Total: ${integerFormatter.format(orders)} pedidos. O detalhamento diário está na tabela abaixo.`}
              emptyMessage="Nenhum pedido neste período"
              formatValue={(value) => integerFormatter.format(value)}
              monthly={monthly}
            />
            {busiestDay && orders > 0n && <p className="dashboard-trend-insight">{peakDayCount === 1 ? <>Maior volume em <strong>{shortDate(busiestDay.business_date)}</strong>: </> : <>Maior volume diário, em {peakDayCount} dias: </>}<strong>{integerFormatter.format(busiestDay.order_count)}</strong> {busiestDay.order_count === 1n ? 'pedido' : 'pedidos'}.</p>}
            {orders === 0n && <p className="dashboard-trend-empty-copy">Os próximos pedidos registrados formarão este histórico de volume diário.</p>}
          </> : <ChartState loading={loading} onRetry={onRetry} />}
          <figcaption className="dashboard-trend-footer"><p>Pela data de criação, inclusive pedidos cancelados depois.</p><Link className="quiet-link" to="/pedidos">Abrir pedidos <Icon name="arrow" /></Link></figcaption>
        </figure>}
      </div>

      {ready && <details className="dashboard-trend-details">
        <summary>Ver detalhamento diário <span>{days.length} dias · {periodLabel}</span></summary>
        <div className="dashboard-trend-table-wrap" role="region" aria-label="Valores diários dos gráficos" tabIndex={0}>
          <table className="dashboard-trend-table">
            <caption>Valores diários de {dateRange}, no horário de São Paulo. Dias sem registros aparecem com zero.</caption>
            <thead><tr><th scope="col">Data</th>{!embedded && <th scope="col">Pedidos criados</th>}<th scope="col">Pagamentos recebidos</th><th scope="col">Gastos pagos</th></tr></thead>
            <tbody>{days.map((day) => <tr key={day.business_date}><th scope="row">{formatBusinessDate(day.business_date)}</th>{!embedded && <td>{integerFormatter.format(day.order_count)}</td>}<td>{formatBRLExact(day.receipts_cents)}</td><td>{formatBRLExact(day.paid_outflows_cents)}</td></tr>)}</tbody>
          </table>
        </div>
      </details>}
    </section>
  )
}
