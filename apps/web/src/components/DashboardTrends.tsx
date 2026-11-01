import { useId } from 'react'
import { Link } from 'react-router-dom'
import { formatBRLExact, formatBusinessDate } from '../lib/formatters'
import { Icon } from './Icon'

export type DashboardTrendPeriod = 7 | 30

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
  loading: boolean
  error: boolean
  onPeriodChange: (period: DashboardTrendPeriod) => void
  onRetry: () => void
}

type ChartSeries = {
  key: 'order_count' | 'receipts_cents' | 'paid_outflows_cents'
  label: string
  className: string
}

const moneySeries: ChartSeries[] = [
  { key: 'receipts_cents', label: 'Recebimentos informados', className: 'is-receipt' },
  { key: 'paid_outflows_cents', label: 'Saídas pagas', className: 'is-outflow' },
]
const orderSeries: ChartSeries[] = [{ key: 'order_count', label: 'Pedidos registrados', className: 'is-order' }]
const integerFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })
const moneyAxisFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 })
const shortDateFormatter = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })

function shortDate(value: string) {
  return shortDateFormatter.format(new Date(`${value}T12:00:00-03:00`))
}

function chartMaximum(value: bigint) {
  if (value === 0n) return 0n
  const magnitude = 10n ** BigInt(value.toString().length - 1)
  return ([2n, 4n, 6n, 8n, 10n].find((step) => step * magnitude >= value) ?? 10n) * magnitude
}

function barHeight(value: bigint, maximum: bigint) {
  return maximum === 0n ? 0 : Number(value * 10_000n / maximum) / 100
}

function DailyBars({ days, series, label, emptyMessage, formatValue, formatAxisValue = formatValue }: {
  days: DashboardTrendDay[]
  series: ChartSeries[]
  label: string
  emptyMessage: string
  formatValue: (value: bigint) => string
  formatAxisValue?: (value: bigint) => string
}) {
  const largestValue = days.reduce((maximum, day) => series.reduce((current, item) => day[item.key] > current ? day[item.key] : current, maximum), 0n)
  const maximum = chartMaximum(largestValue)
  const labelDays = days.length === 7 ? days : [days[0], days[Math.floor((days.length - 1) / 2)], days[days.length - 1]]

  return (
    <div className={`dashboard-chart${days.length > 7 ? ' is-long-period' : ''}`} role="img" aria-label={label}>
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
                title={`${formatBusinessDate(day.business_date)} — ${series.map((item) => `${item.label}: ${formatValue(day[item.key])}`).join('; ')}`}
              >
                {series.map((item) => <span className={`dashboard-chart-bar ${item.className}`} key={item.key} style={{ height: `${barHeight(day[item.key], maximum)}%` }} />)}
              </div>
            ))}
          </div>
          {maximum === 0n && <p className="dashboard-chart-empty-label">{emptyMessage}</p>}
        </div>
        <div className={`dashboard-chart-dates${days.length > 7 ? ' is-long-period' : ''}`}>
          {labelDays.map((day) => <span key={day.business_date}>{shortDate(day.business_date)}</span>)}
        </div>
      </div>
    </div>
  )
}

function ChartState({ loading, onRetry }: { loading: boolean; onRetry: () => void }) {
  return (
    <div className="dashboard-chart-state" role="status">
      <Icon name={loading ? 'clock' : 'chart'} />
      <p>{loading ? 'Carregando o período…' : 'Não foi possível carregar este período.'}</p>
      {!loading && <button className="text-button" onClick={onRetry} type="button">Tentar novamente</button>}
    </div>
  )
}

export function DashboardTrends({ days, startOn, endOn, period, loading, error, onPeriodChange, onRetry }: DashboardTrendsProps) {
  const headingId = useId()
  const moneyHeadingId = useId()
  const ordersHeadingId = useId()
  const ready = !loading && !error && days.length > 0
  const receipts = days.reduce((total, day) => total + day.receipts_cents, 0n)
  const outflows = days.reduce((total, day) => total + day.paid_outflows_cents, 0n)
  const orders = days.reduce((total, day) => total + day.order_count, 0n)
  const busiestDay = days.reduce<DashboardTrendDay | null>((busiest, day) => !busiest || day.order_count > busiest.order_count ? day : busiest, null)
  const peakDayCount = busiestDay ? days.filter((day) => day.order_count === busiestDay.order_count).length : 0
  const dateRange = `${formatBusinessDate(startOn)} a ${formatBusinessDate(endOn)}`

  return (
    <section className="dashboard-trends" aria-labelledby={headingId}>
      <div className="section-heading dashboard-trends-heading">
        <div>
          <p className="eyebrow">ACOMPANHAMENTO</p>
          <h2 id={headingId}>Ritmo da operação</h2>
          <p className="dashboard-trends-range">{dateRange} · horário de São Paulo</p>
        </div>
        <div className="dashboard-period-control" role="group" aria-label="Período dos gráficos">
          {([7, 30] as const).map((value) => <button aria-pressed={period === value} key={value} onClick={() => onPeriodChange(value)} type="button">{value} dias</button>)}
        </div>
      </div>

      <div className="dashboard-trends-grid" aria-busy={loading}>
        <figure className="surface-panel dashboard-trend-panel" aria-labelledby={moneyHeadingId}>
          <div className="dashboard-trend-heading"><h3 id={moneyHeadingId}>Movimento registrado</h3><span>R$ por dia</span></div>
          {ready ? <>
            <dl className="dashboard-trend-totals">
              <div><dt><span className="dashboard-chart-key is-receipt" aria-hidden="true" />Recebimentos informados</dt><dd>{formatBRLExact(receipts)}</dd></div>
              <div><dt><span className="dashboard-chart-key is-outflow" aria-hidden="true" />Saídas pagas</dt><dd>{formatBRLExact(outflows)}</dd></div>
            </dl>
            <DailyBars
              days={days}
              series={moneySeries}
              label={`Recebimentos informados e saídas pagas por dia, de ${dateRange}. Totais: ${formatBRLExact(receipts)} em recebimentos e ${formatBRLExact(outflows)} em saídas. Os valores de cada dia estão na tabela abaixo.`}
              emptyMessage="Nenhuma movimentação neste período"
              formatValue={formatBRLExact}
              formatAxisValue={(value) => moneyAxisFormatter.format(Number(value) / 100)}
            />
            <p className="dashboard-trend-insight">Diferença registrada: <strong>{formatBRLExact(receipts - outflows)}</strong></p>
            {receipts === 0n && outflows === 0n && <p className="dashboard-trend-empty-copy">Registre recebimentos e saídas pagas para acompanhar o movimento ao longo dos dias.</p>}
          </> : <ChartState loading={loading} onRetry={onRetry} />}
          <figcaption className="dashboard-trend-footer"><p>Lançamentos manuais; não representa saldo bancário.</p><Link className="quiet-link" to="/financeiro">Abrir financeiro <Icon name="arrow" /></Link></figcaption>
        </figure>

        <figure className="surface-panel dashboard-trend-panel" aria-labelledby={ordersHeadingId}>
          <div className="dashboard-trend-heading"><h3 id={ordersHeadingId}>Pedidos registrados</h3><span>Pedidos por dia</span></div>
          {ready ? <>
            <div className="dashboard-order-total"><strong>{integerFormatter.format(orders)}</strong><span>{orders === 1n ? 'pedido no período' : 'pedidos no período'}</span></div>
            <DailyBars
              days={days}
              series={orderSeries}
              label={`Pedidos registrados por dia, de ${dateRange}. Total: ${integerFormatter.format(orders)} pedidos. Os valores de cada dia estão na tabela abaixo.`}
              emptyMessage="Nenhum pedido neste período"
              formatValue={(value) => integerFormatter.format(value)}
            />
            {busiestDay && orders > 0n && <p className="dashboard-trend-insight">{peakDayCount === 1 ? <>Maior volume em <strong>{shortDate(busiestDay.business_date)}</strong>: </> : <>Maior volume diário, em {peakDayCount} dias: </>}<strong>{integerFormatter.format(busiestDay.order_count)}</strong> {busiestDay.order_count === 1n ? 'pedido' : 'pedidos'}.</p>}
            {orders === 0n && <p className="dashboard-trend-empty-copy">Os próximos pedidos registrados formarão este histórico de volume diário.</p>}
          </> : <ChartState loading={loading} onRetry={onRetry} />}
          <figcaption className="dashboard-trend-footer"><p>Pela data de criação, inclusive pedidos cancelados depois.</p><Link className="quiet-link" to="/pedidos">Abrir pedidos <Icon name="arrow" /></Link></figcaption>
        </figure>
      </div>

      {ready && <details className="dashboard-trend-details">
        <summary>Ver valores por dia <span>{period} dias</span></summary>
        <div className="dashboard-trend-table-wrap" role="region" aria-label="Valores diários dos gráficos" tabIndex={0}>
          <table className="dashboard-trend-table">
            <caption>Valores diários de {dateRange}, no horário de São Paulo. Dias sem registros aparecem com zero.</caption>
            <thead><tr><th scope="col">Data</th><th scope="col">Pedidos registrados</th><th scope="col">Recebimentos informados</th><th scope="col">Saídas pagas</th></tr></thead>
            <tbody>{days.map((day) => <tr key={day.business_date}><th scope="row">{formatBusinessDate(day.business_date)}</th><td>{integerFormatter.format(day.order_count)}</td><td>{formatBRLExact(day.receipts_cents)}</td><td>{formatBRLExact(day.paid_outflows_cents)}</td></tr>)}</tbody>
          </table>
        </div>
      </details>}
    </section>
  )
}
