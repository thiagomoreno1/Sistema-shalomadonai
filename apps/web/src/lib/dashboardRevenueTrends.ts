export type DashboardRevenueTrendDay = {
  business_date: string
  completed_order_count: bigint
  gross_sales_cents: bigint
  discount_cents: bigint
  net_sales_cents: bigint
  item_cost_cents: bigint | null
  gross_profit_cents: bigint | null
  missing_cost_line_count: number
  returned_order_count: number
}

function shiftCalendarDate(value: string, offset: number) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function readInteger(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  throw new Error('Invalid dashboard revenue value.')
}

function readCount(value: unknown) {
  const count = readInteger(value)
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Dashboard revenue count is too large.')
  return Number(count)
}

function readOptionalInteger(value: unknown) {
  return value === null ? null : readInteger(value)
}

function readSignedInteger(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  throw new Error('Invalid dashboard profit value.')
}

function readChunk(value: unknown, startOn: string, dayCount: number): DashboardRevenueTrendDay[] {
  if (!Array.isArray(value) || value.length !== dayCount) throw new Error('Incomplete dashboard revenue series.')
  return value.map((row: unknown, index) => {
    if (typeof row !== 'object' || row === null) throw new Error('Invalid dashboard revenue series.')
    const item = row as Record<string, unknown>
    const expectedDate = shiftCalendarDate(startOn, index)
    if (item.business_date !== expectedDate) throw new Error('Unexpected dashboard revenue date.')
    return {
      business_date: expectedDate,
      completed_order_count: readInteger(item.completed_order_count),
      gross_sales_cents: readInteger(item.gross_sales_cents),
      discount_cents: readInteger(item.discount_cents),
      net_sales_cents: readInteger(item.net_sales_cents),
      item_cost_cents: readOptionalInteger(item.item_cost_cents),
      gross_profit_cents: item.gross_profit_cents === null ? null : readSignedInteger(item.gross_profit_cents),
      missing_cost_line_count: readCount(item.missing_cost_line_count),
      returned_order_count: readCount(item.returned_order_count),
    }
  })
}

export async function loadDashboardRevenueTrendDays(
  startOn: string,
  dayCount: number,
  fetchChunk: (start: string, end: string) => Promise<{ data: unknown; error: unknown | null }>,
) {
  const chunks: Array<{ start: string; end: string; dayCount: number }> = []
  for (let offset = 0; offset < dayCount; offset += 30) {
    const chunkCount = Math.min(30, dayCount - offset)
    const start = shiftCalendarDate(startOn, offset)
    chunks.push({ start, end: shiftCalendarDate(start, chunkCount - 1), dayCount: chunkCount })
  }
  const rows = await Promise.all(chunks.map(async (chunk) => {
    const { data, error } = await fetchChunk(chunk.start, chunk.end)
    if (error) throw error
    return readChunk(data, chunk.start, chunk.dayCount)
  }))
  const days = rows.flat()
  if (days.length !== dayCount) throw new Error('Incomplete dashboard revenue series.')
  return days
}

export function createDemoRevenueTrendDays(startOn: string, dayCount: number): DashboardRevenueTrendDay[] {
  const sales = [0, 32500, 64800, 42000, 98200, 51200, 76400]
  const costs = [0, 17200, 34900, 22500, 51500, 26800, 38400]
  const orderCounts = [0, 1, 2, 1, 3, 1, 2]
  return Array.from({ length: dayCount }, (_, index) => {
    const sample = index % sales.length
    return {
      business_date: shiftCalendarDate(startOn, index),
      completed_order_count: BigInt(orderCounts[sample]),
      gross_sales_cents: BigInt(sales[sample] + (sample === 4 ? 5000 : 0)),
      discount_cents: BigInt(sample === 4 ? 5000 : 0),
      net_sales_cents: BigInt(sales[sample]),
      item_cost_cents: BigInt(costs[sample]),
      gross_profit_cents: BigInt(sales[sample] - costs[sample]),
      missing_cost_line_count: 0,
      returned_order_count: 0,
    }
  })
}
