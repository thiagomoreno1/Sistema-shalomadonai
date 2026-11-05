import { useId } from 'react'
import { Link } from 'react-router-dom'
import { formatBRLExact, formatBusinessDate } from '../lib/formatters'
import { Icon } from './Icon'

export type DashboardTrendPeriod = 'week' | 'last_7' | 'month' | 'last_30' | 'year'

export type DashboardTrendDay = {
  business_date: string
  order_count: bigint
  receipts_cents: bigint
  paid_outflows_cents: bigint
}

type DashboardTrendsProps = {
  days: DashboardTrendDay[]
  startOn: string
  endOn: string
  period: DashboardTrendPeriod
  periodLabel: string
  grossSalesCents: bigint | null
  netSalesCents: bigint | null
  salesLoading: boolean
  salesError: boolean
  loading: boolean
  error: boolean
  embedded?: boolean
  onRetry: () => void
  onRetrySales: () => void
}

type ChartSeries = {
  key: 'order_count' | 'receipts_cents' | 'paid_outflows_cents'
  label: string
  className: string
}

const moneySeries: ChartSeries[] = [
  { key: 'receipts_cents', label: 'Pagamentos recebidos', className: 'is-receipt' },
  { key: 'paid_outflows_cents', label: 'Gastos pagos', className: 'is-outflow' },
]
const orderSeries: ChartSeries[] = [{ key: 'order_count', label: 'Pedidos registrados', className: 'is-order' }]
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
    }
    month.order_count += day.order_count
    month.receipts_cents += day.receipts_cents
    month.paid_outflows_cents += day.paid_outflows_cents
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

function salesBarWidth(value: bigint, maximum: bigint) {
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
  const largestValue = days.reduce((maximum, day) => series.reduce((current, item) => day[item.key] > current ? day[item.key] : current, maximum), 0n)
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
                className={`dashboard-chart-day${series.every((item) => day[item.key] === 0n) ? ' is-zero' : ''}`}
                key={day.business_date}
                title={`${chartDateLabel(day.business_date, monthly)} — ${series.map((item) => `${item.label}: ${formatValue(day[item.key])}`).join('; ')}`}
              >
                {series.map((item) => <span className={`dashboard-chart-bar ${item.className}`} key={item.key} style={{ height: `${barHeight(day[item.key], maximum)}%` }} />)}
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

function ChartState({ loading, onRetry, errorMessage = 'Não foi possível carregar este período.' }: { loading: boolean; onRetry: () => void; errorMessage?: string }) {
  return (
    <div className="dashboard-chart-state" role="status">
      <Icon name={loading ? 'clock' : 'chart'} />
      <p>{loading ? 'Carregando o período…' : errorMessage}</p>
      {!loading && <button className="text-button" onClick={onRetry} type="button">Tentar novamente</button>}
    </div>
  )
}

export function DashboardTrends({ days, startOn, endOn, period, periodLabel, grossSalesCents, netSalesCents, salesLoading, salesError, loading, error, embedded = false, onRetry, onRetrySales }: DashboardTrendsProps) {
  const headingId = useId()
  const salesHeadingId = useId()
  const moneyHeadingId = useId()
  const ordersHeadingId = useId()
  const ready = !loading && !error && days.length > 0
  const monthly = period === 'year'
  const chartDays = monthly ? groupTrendDaysByMonth(days) : days
  const receipts = days.reduce((total, day) => total + day.receipts_cents, 0n)
  const outflows = days.reduce((total, day) => total + day.paid_outflows_cents, 0n)
  const orders = days.reduce((total, day) => total + day.order_count, 0n)
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
          <div className="dashboard-trend-heading"><h3 id={salesHeadingId}>Faturamento do período</h3><span>Bruto x líquido</span></div>
          {salesLoading ? <ChartState loading onRetry={onRetrySales} errorMessage="Não foi possível carregar o faturamento deste período." /> : salesError || grossSalesCents === null || netSalesCents === null ? <ChartState loading={false} onRetry={onRetrySales} errorMessage="Não foi possível carregar o faturamento deste período." /> : <>
            <div className="dashboard-sales-comparison" role="img" aria-label={`Faturamento de ${dateRange}: ${formatBRLExact(grossSalesCents)} bruto e ${formatBRLExact(netSalesCents)} líquido. Descontos: ${formatBRLExact(grossSalesCents - netSalesCents)}.`}>
              <div className="dashboard-sales-row">
                <span>Faturamento bruto</span>
                <div className="dashboard-sales-track"><span className="is-gross" style={{ width: `${salesBarWidth(grossSalesCents, grossSalesCents > netSalesCents ? grossSalesCents : netSalesCents)}%` }} /></div>
                <strong>{formatBRLExact(grossSalesCents)}</strong>
              </div>
              <div className="dashboard-sales-row">
                <span>Faturamento líquido</span>
                <div className="dashboard-sales-track"><span className="is-net" style={{ width: `${salesBarWidth(netSalesCents, grossSalesCents > netSalesCents ? grossSalesCents : netSalesCents)}%` }} /></div>
                <strong>{formatBRLExact(netSalesCents)}</strong>
              </div>
            </div>
            <p className="dashboard-trend-insight">Descontos nos pedidos: <strong>{formatBRLExact(grossSalesCents - netSalesCents)}</strong></p>
            {grossSalesCents === 0n && netSalesCents === 0n && <p className="dashboard-trend-empty-copy">Vendas concluídas por entrega ou retirada aparecerão aqui.</p>}
          </>}
          <figcaption className="dashboard-trend-footer"><p>Venda contada na entrega concluída ou retirada pelo cliente.</p><Link className="quiet-link" to="/relatorios">Ver relatórios <Icon name="arrow" /></Link></figcaption>
        </figure>

        <figure className="surface-panel dashboard-trend-panel" aria-labelledby={moneyHeadingId}>
          <div className="dashboard-trend-heading"><h3 id={moneyHeadingId}>Pagamentos recebidos e gastos</h3><span>R$ por {timeUnit}</span></div>
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

        <figure className="surface-panel dashboard-trend-panel" aria-labelledby={ordersHeadingId}>
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
        </figure>
      </div>

      {ready && <details className="dashboard-trend-details">
        <summary>Ver detalhamento diário <span>{days.length} dias · {periodLabel}</span></summary>
        <div className="dashboard-trend-table-wrap" role="region" aria-label="Valores diários dos gráficos" tabIndex={0}>
          <table className="dashboard-trend-table">
            <caption>Valores diários de {dateRange}, no horário de São Paulo. Dias sem registros aparecem com zero.</caption>
            <thead><tr><th scope="col">Data</th><th scope="col">Pedidos criados</th><th scope="col">Pagamentos recebidos</th><th scope="col">Gastos pagos</th></tr></thead>
            <tbody>{days.map((day) => <tr key={day.business_date}><th scope="row">{formatBusinessDate(day.business_date)}</th><td>{integerFormatter.format(day.order_count)}</td><td>{formatBRLExact(day.receipts_cents)}</td><td>{formatBRLExact(day.paid_outflows_cents)}</td></tr>)}</tbody>
          </table>
        </div>
      </details>}
    </section>
  )
}
