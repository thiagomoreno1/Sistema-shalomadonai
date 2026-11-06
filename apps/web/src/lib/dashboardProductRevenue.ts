export type DashboardProductRevenue = {
  productId: string
  productName: string
  inventoryUnit: string | null
  quantityMilli: bigint
  grossCents: bigint
  discountCents: bigint
  costCents: bigint | null
  netCents: bigint | null
  missingCostLineCount: number
  returnPendingCount: number
}

export type DashboardProductRevenueSummary = {
  products: DashboardProductRevenue[]
  orderCount: number
  grossSalesCents: bigint
  discountCents: bigint
  netSalesCents: bigint
  deliveryFeeGrossCents: bigint
  deliveryFeeDiscountCents: bigint
  itemCostCents: bigint | null
  netBillingCents: bigint | null
  missingCostLineCount: number
  returnedOrderCount: number
}

function shiftCalendarDate(value: string, offset: number) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function readInteger(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  throw new Error('Invalid product revenue value.')
}

function readCount(value: unknown) {
  const count = readInteger(value)
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Product revenue count is too large.')
  return Number(count)
}

function readNullableInteger(value: unknown) {
  return value === null ? null : readInteger(value)
}

function readSignedInteger(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  throw new Error('Invalid signed product revenue value.')
}

function readNullableSignedInteger(value: unknown) {
  return value === null ? null : readSignedInteger(value)
}

function readSummary(value: unknown): DashboardProductRevenueSummary {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid product revenue summary.')
  const row = value as Record<string, unknown>
  if (!Array.isArray(row.products)) throw new Error('Invalid product revenue list.')
  const products = row.products.map((value): DashboardProductRevenue => {
    if (typeof value !== 'object' || value === null) throw new Error('Invalid product revenue item.')
    const product = value as Record<string, unknown>
    if (typeof product.product_id !== 'string' || typeof product.product_name !== 'string') throw new Error('Invalid product identity.')
    if (product.inventory_unit !== null && typeof product.inventory_unit !== 'string') throw new Error('Invalid product unit.')
    return {
      productId: product.product_id,
      productName: product.product_name,
      inventoryUnit: product.inventory_unit,
      quantityMilli: readInteger(product.quantity_milli),
      grossCents: readInteger(product.gross_cents),
      discountCents: readInteger(product.discount_cents),
      costCents: readNullableInteger(product.cost_cents),
      netCents: readNullableSignedInteger(product.net_cents),
      missingCostLineCount: readCount(product.missing_cost_line_count),
      returnPendingCount: readCount(product.return_pending_count),
    }
  })
  return {
    products,
    orderCount: readCount(row.order_count),
    grossSalesCents: readInteger(row.gross_sales_cents),
    discountCents: readInteger(row.discount_cents),
    netSalesCents: readInteger(row.net_sales_cents),
    deliveryFeeGrossCents: readInteger(row.delivery_fee_gross_cents),
    deliveryFeeDiscountCents: readInteger(row.delivery_fee_discount_cents),
    itemCostCents: readNullableInteger(row.item_cost_cents),
    netBillingCents: readNullableSignedInteger(row.net_billing_cents),
    missingCostLineCount: readCount(row.missing_cost_line_count),
    returnedOrderCount: readCount(row.returned_order_count),
  }
}

function emptySummary(): DashboardProductRevenueSummary {
  return {
    products: [], orderCount: 0, grossSalesCents: 0n, discountCents: 0n, netSalesCents: 0n,
    deliveryFeeGrossCents: 0n, deliveryFeeDiscountCents: 0n, itemCostCents: 0n, netBillingCents: 0n,
    missingCostLineCount: 0, returnedOrderCount: 0,
  }
}

function addNullable(left: bigint | null, right: bigint | null) {
  return left === null || right === null ? null : left + right
}

export async function loadDashboardProductRevenue(
  startOn: string,
  dayCount: number,
  fetchChunk: (start: string, end: string) => Promise<{ data: unknown; error: unknown | null }>,
) {
  const chunks: Array<{ start: string; end: string }> = []
  for (let offset = 0; offset < dayCount; offset += 30) {
    const count = Math.min(30, dayCount - offset)
    const start = shiftCalendarDate(startOn, offset)
    chunks.push({ start, end: shiftCalendarDate(start, count - 1) })
  }
  const summaries = await Promise.all(chunks.map(async ({ start, end }) => {
    const { data, error } = await fetchChunk(start, end)
    if (error) throw error
    return readSummary(data)
  }))
  const combined = emptySummary()
  const products = new Map<string, DashboardProductRevenue>()
  const displayNameGross = new Map<string, bigint>()
  for (const summary of summaries) {
    combined.orderCount += summary.orderCount
    combined.grossSalesCents += summary.grossSalesCents
    combined.discountCents += summary.discountCents
    combined.netSalesCents += summary.netSalesCents
    combined.deliveryFeeGrossCents += summary.deliveryFeeGrossCents
    combined.deliveryFeeDiscountCents += summary.deliveryFeeDiscountCents
    combined.itemCostCents = addNullable(combined.itemCostCents, summary.itemCostCents)
    combined.netBillingCents = addNullable(combined.netBillingCents, summary.netBillingCents)
    combined.missingCostLineCount += summary.missingCostLineCount
    combined.returnedOrderCount += summary.returnedOrderCount
    for (const product of summary.products) {
      const key = product.productId
      const previous = products.get(key)
      if (!previous) {
        products.set(key, { ...product })
        displayNameGross.set(key, product.grossCents)
        continue
      }
      if (product.grossCents > (displayNameGross.get(key) ?? -1n)) {
        previous.productName = product.productName
        displayNameGross.set(key, product.grossCents)
      }
      previous.quantityMilli += product.quantityMilli
      if (previous.inventoryUnit !== product.inventoryUnit) previous.inventoryUnit = null
      previous.grossCents += product.grossCents
      previous.discountCents += product.discountCents
      previous.costCents = addNullable(previous.costCents, product.costCents)
      previous.netCents = addNullable(previous.netCents, product.netCents)
      previous.missingCostLineCount += product.missingCostLineCount
      previous.returnPendingCount += product.returnPendingCount
    }
  }
  combined.products = [...products.values()].sort((left, right) => left.grossCents === right.grossCents ? left.productName.localeCompare(right.productName, 'pt-BR') : left.grossCents > right.grossCents ? -1 : 1)
  return combined
}

export function createDemoProductRevenueSummary(): DashboardProductRevenueSummary {
  const products: DashboardProductRevenue[] = [
    { productId: 'demo-product-detergente', productName: 'Detergente neutro', inventoryUnit: 'un', quantityMilli: 6000n, grossCents: 66000n, discountCents: 3000n, costCents: 33000n, netCents: 30000n, missingCostLineCount: 0, returnPendingCount: 0 },
    { productId: 'demo-product-combo', productName: 'Combo de limpeza', inventoryUnit: 'un', quantityMilli: 2000n, grossCents: 40000n, discountCents: 2000n, costCents: 20000n, netCents: 18000n, missingCostLineCount: 0, returnPendingCount: 0 },
  ]
  return {
    products,
    orderCount: 5,
    grossSalesCents: 118000n,
    discountCents: 5000n,
    netSalesCents: 113000n,
    deliveryFeeGrossCents: 12000n,
    deliveryFeeDiscountCents: 0n,
    itemCostCents: 53000n,
    netBillingCents: 60000n,
    missingCostLineCount: 0,
    returnedOrderCount: 0,
  }
}

export function formatQuantityMilli(value: bigint, unit: string | null) {
  const whole = value / 1000n
  const fraction = (value % 1000n).toString().padStart(3, '0').replace(/0+$/, '')
  const formattedWhole = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(whole)
  const formatted = fraction ? `${formattedWhole},${fraction}` : formattedWhole
  return unit ? `${formatted} ${unit}` : formatted
}
