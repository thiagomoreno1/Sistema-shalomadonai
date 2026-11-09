export type RecurringOperationKind = 'inventory_purchase' | 'operating_expense'

export type RecurringOperationTemplate = {
  id: string
  business_id: string
  kind: RecurringOperationKind
  name: string
  description: string | null
  category: string | null
  counterparty_name: string | null
  product_id: string | null
  quantity: number | string | null
  expected_unit_cost_cents: number | string | null
  amount_cents: number | string | null
  day_of_month: number
  starts_on: string
  next_due_on: string
  is_active: boolean
}

function monthDate(year: number, month: number, day: number) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`
}

export function firstMonthlyDueDate(startsOn: string, dayOfMonth: number) {
  const [year, month] = startsOn.split('-').map(Number)
  const thisMonth = monthDate(year, month, dayOfMonth)
  if (thisMonth >= startsOn) return thisMonth
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  return monthDate(nextYear, nextMonth, dayOfMonth)
}

export function formatRecurringDay(dayOfMonth: number) {
  return `Todo mês, dia ${dayOfMonth}`
}
