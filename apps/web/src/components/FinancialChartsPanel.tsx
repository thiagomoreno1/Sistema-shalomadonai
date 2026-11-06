import { useCallback, useEffect, useRef, useState } from 'react'
import { useBusiness } from '../business/BusinessContext'
import { DashboardTrends, type DashboardTrendDay, type DashboardTrendPeriod } from './DashboardTrends'
import { DashboardProductRevenue } from './DashboardProductRevenue'
import { formatBusinessDate } from '../lib/formatters'
import { isDemoPreviewEnabled } from '../lib/demoPreview'
import { createDemoRevenueTrendDays, loadDashboardRevenueTrendDays, type DashboardRevenueTrendDay } from '../lib/dashboardRevenueTrends'
import { supabaseClient } from '../lib/supabase'
import { useBusinessToday } from '../lib/useBusinessToday'

const periodOptions: Array<{ value: DashboardTrendPeriod; label: string }> = [
  { value: 'week', label: 'Esta semana' },
  { value: 'last_7', label: 'Últimos 7 dias' },
  { value: 'month', label: 'Este mês' },
  { value: 'last_30', label: 'Últimos 30 dias' },
  { value: 'year', label: 'Este ano' },
]

type TrendChunk = { startOn: string; endOn: string; dayCount: number }

function shiftCalendarDate(value: string, offset: number) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function getDateRange(today: string, period: DashboardTrendPeriod) {
  const date = new Date(`${today}T12:00:00Z`)
  const weekday = date.getUTCDay()
  const startOn = period === 'week'
    ? shiftCalendarDate(today, -((weekday + 6) % 7))
    : period === 'last_7'
      ? shiftCalendarDate(today, -6)
      : period === 'month'
        ? `${today.slice(0, 7)}-01`
        : period === 'last_30'
          ? shiftCalendarDate(today, -29)
          : `${today.slice(0, 4)}-01-01`
  const dayCount = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${startOn}T00:00:00Z`)) / 86_400_000) + 1
  return { startOn, dayCount, label: periodOptions.find((option) => option.value === period)?.label ?? 'Últimos 7 dias' }
}

function getDateChunks(startOn: string, dayCount: number): TrendChunk[] {
  const chunks: TrendChunk[] = []
  for (let offset = 0; offset < dayCount; offset += 30) {
    const count = Math.min(30, dayCount - offset)
    const chunkStartOn = shiftCalendarDate(startOn, offset)
    chunks.push({ startOn: chunkStartOn, endOn: shiftCalendarDate(chunkStartOn, count - 1), dayCount: count })
  }
  return chunks
}

function readDays(value: unknown, startOn: string, dayCount: number): DashboardTrendDay[] {
  if (!Array.isArray(value) || value.length !== dayCount) throw new Error('Incomplete daily series.')
  return value.map((row: unknown, index) => {
    if (typeof row !== 'object' || row === null) throw new Error('Invalid daily series.')
    const item = row as Record<string, unknown>
    const expectedDate = shiftCalendarDate(startOn, index)
    const readInteger = (raw: unknown) => {
      if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw)
      if (typeof raw === 'string' && /^\d+$/.test(raw)) return BigInt(raw)
      throw new Error('Invalid daily aggregate.')
    }
    if (item.business_date !== expectedDate) throw new Error('Unexpected daily series date.')
    return {
      business_date: expectedDate,
      order_count: readInteger(item.order_count),
      receipts_cents: readInteger(item.receipts_cents),
      paid_outflows_cents: readInteger(item.paid_outflows_cents),
    }
  })
}

function demoDays(startOn: string, dayCount: number): DashboardTrendDay[] {
  const orders = [0, 1, 2, 1, 3, 2, 4]
  const receipts = [0, 125000, 86000, 250000, 0, 340000, 422000]
  const outflows = [45000, 0, 95000, 145000, 62000, 88000, 73000]
  return Array.from({ length: dayCount }, (_, index) => {
    const sample = index % orders.length
    return {
      business_date: shiftCalendarDate(startOn, index),
      order_count: BigInt(orders[sample]),
      receipts_cents: BigInt(receipts[sample]),
      paid_outflows_cents: BigInt(outflows[sample]),
    }
  })
}

export function FinancialChartsPanel() {
  const { id: businessId, role } = useBusiness()
  const today = useBusinessToday()
  const demoPreview = role === 'owner' && isDemoPreviewEnabled()
  const [period, setPeriod] = useState<DashboardTrendPeriod>('last_7')
  const { startOn, dayCount, label } = getDateRange(today, period)
  const scopeKey = `${businessId}:${role}:${startOn}:${today}`
  const trendRequestId = useRef(0)
  const revenueRequestId = useRef(0)
  const [trendState, setTrendState] = useState<{ scopeKey: string; loading: boolean; error: boolean; days: DashboardTrendDay[] }>({ scopeKey: '', loading: true, error: false, days: [] })
  const [revenueState, setRevenueState] = useState<{ scopeKey: string; loading: boolean; error: boolean; days: DashboardRevenueTrendDay[] }>({ scopeKey: '', loading: true, error: false, days: [] })
  const trends = trendState.scopeKey === scopeKey ? trendState : { loading: true, error: false, days: [] }
  const revenue = revenueState.scopeKey === scopeKey ? revenueState : { loading: true, error: false, days: [] }

  const loadTrends = useCallback(async () => {
    const requestId = ++trendRequestId.current
    try {
      if (demoPreview) {
        await Promise.resolve()
        if (requestId === trendRequestId.current) setTrendState({ scopeKey, loading: false, error: false, days: demoDays(startOn, dayCount) })
        return
      }
      const client = supabaseClient
      if (!client) throw new Error('Supabase is not configured.')
      const results = await Promise.all(getDateChunks(startOn, dayCount).map(async (chunk) => {
        const { data, error } = await client.rpc('get_dashboard_daily_trends', {
          p_business_id: businessId,
          p_start_on: chunk.startOn,
          p_end_on: chunk.endOn,
        })
        if (error) throw error
        return readDays(data, chunk.startOn, chunk.dayCount)
      }))
      const days = results.flat()
      if (days.length !== dayCount) throw new Error('Incomplete daily series.')
      if (requestId === trendRequestId.current) setTrendState({ scopeKey, loading: false, error: false, days })
    } catch {
      if (requestId === trendRequestId.current) setTrendState({ scopeKey, loading: false, error: true, days: [] })
    }
  }, [businessId, dayCount, demoPreview, scopeKey, startOn])

  const loadRevenue = useCallback(async () => {
    const requestId = ++revenueRequestId.current
    try {
      if (demoPreview) {
        await Promise.resolve()
        const days = createDemoRevenueTrendDays(startOn, dayCount)
        if (requestId === revenueRequestId.current) setRevenueState({ scopeKey, loading: false, error: false, days })
        return
      }
      const client = supabaseClient
      if (!client) throw new Error('Supabase is not configured.')
      const days = await loadDashboardRevenueTrendDays(startOn, dayCount, async (chunkStart, chunkEnd) => {
        const { data, error } = await client.rpc('get_dashboard_revenue_trends', {
          p_business_id: businessId,
          p_start_on: chunkStart,
          p_end_on: chunkEnd,
        })
        return { data, error }
      })
      if (requestId === revenueRequestId.current) setRevenueState({ scopeKey, loading: false, error: false, days })
    } catch {
      if (requestId === revenueRequestId.current) setRevenueState({ scopeKey, loading: false, error: true, days: [] })
    }
  }, [businessId, dayCount, demoPreview, scopeKey, startOn])

  useEffect(() => {
    const scheduledRequestId = trendRequestId.current
    queueMicrotask(() => { if (trendRequestId.current === scheduledRequestId) void loadTrends() })
    return () => {
      trendRequestId.current += 1
    }
  }, [loadTrends])
  useEffect(() => {
    const scheduledRequestId = revenueRequestId.current
    queueMicrotask(() => { if (revenueRequestId.current === scheduledRequestId) void loadRevenue() })
    return () => {
      revenueRequestId.current += 1
    }
  }, [loadRevenue])

  return (
    <section className="financial-charts-section" aria-labelledby="financial-charts-title">
      <header className="section-heading financial-charts-heading">
        <div>
          <p className="eyebrow">FINANCEIRO</p>
          <h2 id="financial-charts-title">Gráficos do período</h2>
        </div>
        <label className="financial-charts-period" htmlFor="financial-charts-period-select">
          <span>Período</span>
          <select className="text-input" id="financial-charts-period-select" onChange={(event) => setPeriod(event.target.value as DashboardTrendPeriod)} value={period}>
            {periodOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </header>
      <p className="financial-charts-range">{formatBusinessDate(startOn)} a {formatBusinessDate(today)}</p>
      <DashboardTrends
        days={trends.days}
        embedded
        endOn={today}
        error={trends.error}
        loading={trends.loading}
        revenueDays={revenue.days}
        revenueError={revenue.error}
        revenueLoading={revenue.loading}
        onRetry={() => void loadTrends()}
        onRetryRevenue={() => void loadRevenue()}
        period={period}
        periodLabel={label}
        startOn={startOn}
      />
      <DashboardProductRevenue endOn={today} startOn={startOn} />
    </section>
  )
}
