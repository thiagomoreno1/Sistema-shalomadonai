import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { canManageBusiness, useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { CustomerSearchSelect } from '../components/CustomerSearchSelect'
import { nextArariboiaDueDate } from '../lib/arariboia'
import { formatBRL, formatBusinessDate, parseBrazilianCurrency } from '../lib/formatters'
import { isDiscreteInventoryUnit } from '../lib/inventoryUnits'
import { supabaseClient } from '../lib/supabase'

type Customer = { id: string; name: string; phone: string | null; whatsapp_phone: string | null; delivery_address: string | null; is_arariboia: boolean; arariboia_limit_cents: number | null }
type CustomerAddress = { id: string; label: string; address: string; is_default: boolean }
type DeliveryWorkerChoice = { id: string; name: string; user_id: string | null }
type Product = { id: string; name: string; inventory_unit: string | null; sale_price_cents: number | null; is_combo: boolean }
type StockProduct = { id: string; name: string; inventory_unit: string; inventory_tracked: true }
type ComboComponentDraft = { productId: string; quantityPerCombo: string }
type ItemDraft = { key: string; productId: string; quantity: string; components?: ComboComponentDraft[]; compositionOpen?: boolean; requiresCompositionReview?: boolean }
type InstallmentDraft = { key: string; amount: string; dueOn: string; paymentMethod: string }
type PaymentPlanMode = 'once' | 'monthly' | 'custom'
type OrderCopySummary = { customerName: string; copiedItems: number; customCompositionsCopied: number; legacyCompositionsReviewCount: number; skippedItems: number }
type ScheduleEntry = { ordinal: number; amount_bps: number; days_after_base: number; payment_method: string | null }
type ScheduleTemplate = { id: string; name: string; schedule: ScheduleEntry[] }
type CustomComboOrderCapability = 'available' | 'unavailable' | 'unknown'
type InstallmentSuggestionStatus = 'pending' | 'applied' | 'preserved' | 'incompatible' | 'none' | 'chosen_other'
type CustomerOrderSuggestion = { customerName: string; sourceOrderId: string; sourceCreatedAt: string; copiedItems: number; customCompositionsCopied: number; legacyCompositionsReviewCount: number; skippedItems: number; itemsApplied: boolean; addressApplied: boolean; deliveryApplied: boolean; feeApplied: boolean; installmentStatus: InstallmentSuggestionStatus; preservedFields: string[] }

type NewOrderDraft = {
  version: 1
  requestId: string
  submissionPending: boolean
  customerId: string
  selectedAddressId: string
  requiresDelivery: boolean
  deliveryWorkerId: string
  deliveryAddress: string
  deliveryFee: string
  discount: string
  items: ItemDraft[]
  installments: InstallmentDraft[]
  paymentPlanMode: PaymentPlanMode
  installmentCount: string
  installmentPaymentMethod: string
  selectedScheduleTemplateId: string
  scheduleBaseDate: string
  newTemplateName: string
}
type NewOrderDraftStatus = 'restored' | 'saved' | 'unavailable' | null

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function writeNewOrderDraft(storageKey: string, draft: NewOrderDraft) {
  if (typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(draft))
    return true
  } catch {
    return false
  }
}

function hasOrderDraftContent(draft: NewOrderDraft) {
  return Boolean(draft.submissionPending || draft.customerId || draft.selectedAddressId || draft.requiresDelivery || draft.deliveryWorkerId
    || draft.deliveryAddress.trim() || draft.deliveryFee.trim() || draft.discount.trim()
    || draft.selectedScheduleTemplateId || draft.newTemplateName.trim()
    || draft.items.some((item) => item.productId || item.quantity !== '1' || item.components?.length)
    || draft.installments.some((installment) => installment.amount.trim() || installment.dueOn || installment.paymentMethod.trim()))
}

function readNewOrderDraft(storageKey: string): NewOrderDraft | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(storageKey)
    if (!value) return null
    const parsed = JSON.parse(value) as Partial<NewOrderDraft> | null
    const validItems = Array.isArray(parsed?.items) && parsed.items.length > 0 && parsed.items.length <= 120
      && parsed.items.every((item) => item && typeof item.key === 'string' && typeof item.productId === 'string'
        && typeof item.quantity === 'string' && (item.components === undefined || Array.isArray(item.components)
          && item.components.every((component) => component && typeof component.productId === 'string' && typeof component.quantityPerCombo === 'string')))
    const validInstallments = Array.isArray(parsed?.installments) && parsed.installments.length > 0 && parsed.installments.length <= 120
      && parsed.installments.every((installment) => installment && typeof installment.key === 'string'
        && typeof installment.amount === 'string' && typeof installment.dueOn === 'string' && typeof installment.paymentMethod === 'string')
    if (!parsed || parsed.version !== 1 || !isUuid(parsed.requestId) || typeof parsed.submissionPending !== 'boolean' || !validItems || !validInstallments
      || typeof parsed.customerId !== 'string' || typeof parsed.selectedAddressId !== 'string'
      || typeof parsed.requiresDelivery !== 'boolean' || typeof parsed.deliveryWorkerId !== 'string'
      || typeof parsed.deliveryAddress !== 'string' || typeof parsed.deliveryFee !== 'string'
      || typeof parsed.discount !== 'string'
      || typeof parsed.selectedScheduleTemplateId !== 'string' || typeof parsed.scheduleBaseDate !== 'string'
      || typeof parsed.newTemplateName !== 'string'
      || (parsed.paymentPlanMode !== undefined && !['once', 'monthly', 'custom'].includes(String(parsed.paymentPlanMode)))
      || (parsed.installmentCount !== undefined && typeof parsed.installmentCount !== 'string')
      || (parsed.installmentPaymentMethod !== undefined && typeof parsed.installmentPaymentMethod !== 'string')) {
      window.localStorage.removeItem(storageKey)
      return null
    }
    const draft: NewOrderDraft = {
      version: 1,
      requestId: parsed.requestId,
      submissionPending: parsed.submissionPending,
      customerId: parsed.customerId,
      selectedAddressId: parsed.selectedAddressId,
      requiresDelivery: parsed.requiresDelivery,
      deliveryWorkerId: parsed.deliveryWorkerId,
      deliveryAddress: parsed.deliveryAddress,
      deliveryFee: parsed.deliveryFee,
      discount: parsed.discount,
      items: parsed.items as ItemDraft[],
      installments: parsed.installments as InstallmentDraft[],
      paymentPlanMode: parsed.paymentPlanMode as PaymentPlanMode | undefined
        ?? ((parsed.installments as InstallmentDraft[]).length > 1
          || (parsed.installments as InstallmentDraft[]).some((installment) => installment.amount.trim() || installment.paymentMethod.trim()) ? 'custom' : 'once'),
      installmentCount: parsed.installmentCount ?? String(Math.max(2, (parsed.installments as InstallmentDraft[]).length)),
      installmentPaymentMethod: parsed.installmentPaymentMethod ?? (parsed.installments as InstallmentDraft[])[0]?.paymentMethod ?? '',
      selectedScheduleTemplateId: parsed.selectedScheduleTemplateId,
      scheduleBaseDate: parsed.scheduleBaseDate,
      newTemplateName: parsed.newTemplateName,
    }
    if (!hasOrderDraftContent(draft)) {
      window.localStorage.removeItem(storageKey)
      return null
    }
    return draft
  } catch {
    return null
  }
}

function createNewOrderDraftStorageKey(businessId: string, userId: string) {
  return `shalom-adonai:new-order-draft:v1:${[businessId, userId].map(encodeURIComponent).join(':')}`
}

function newKey() {
  return crypto.randomUUID()
}

function businessDateForTimestamp(value: string | Date, timezone: string) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function daysBetweenDates(start: string, end: string) {
  if (!isCalendarDate(start) || !isCalendarDate(end)) return null
  const [startYear, startMonth, startDay] = start.split('-').map(Number)
  const [endYear, endMonth, endDay] = end.split('-').map(Number)
  return Math.round((Date.UTC(endYear, endMonth - 1, endDay) - Date.UTC(startYear, startMonth - 1, startDay)) / 86400000)
}

function installmentsFromSchedule(schedule: ScheduleEntry[], baseDate: string, totalCents: number) {
  if (schedule.length === 0 || schedule.length > 120 || !Number.isSafeInteger(totalCents) || totalCents <= 0 || schedule.length > totalCents) return null
  const total = BigInt(totalCents)
  const amounts = schedule.map((entry) => total * BigInt(entry.amount_bps) / 10000n)
  amounts[amounts.length - 1] += total - amounts.reduce((sum, amount) => sum + amount, 0n)
  if (amounts.some((amount) => amount <= 0n)) return null
  const result = schedule.map((entry, index) => {
    const dueOn = addDaysToDate(baseDate, entry.days_after_base)
    return dueOn ? { key: newKey(), amount: centsToInput(amounts[index]), dueOn, paymentMethod: entry.payment_method ?? '' } : null
  })
  return result.some((entry) => entry === null) ? null : result as InstallmentDraft[]
}

function monthlyInstallmentSchedule(countValue: string, baseDate: string, totalCents: number, paymentMethod: string) {
  const count = Number(countValue)
  if (!Number.isInteger(count) || count < 2 || count > 120 || !isCalendarDate(baseDate)
    || !Number.isSafeInteger(totalCents) || totalCents < count) return null

  const total = BigInt(totalCents)
  const baseAmount = total / BigInt(count)
  const remainder = total % BigInt(count)
  const method = paymentMethod.trim().slice(0, 64)
  const schedule = Array.from({ length: count }, (_, index) => {
    const dueOn = addMonthsToDate(baseDate, index)
    if (!dueOn) return null
    const amount = baseAmount + (index === count - 1 ? remainder : 0n)
    return { key: newKey(), amount: centsToInput(amount), dueOn, paymentMethod: method }
  })
  return schedule.some((entry) => entry === null) ? null : schedule as InstallmentDraft[]
}

function quantityInThousandths(value: string) {
  const cleaned = value.trim().replace(',', '.')
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(cleaned)
  if (!match) return null
  const whole = Number(match[1])
  const fraction = Number((match[2] ?? '').padEnd(3, '0'))
  const result = whole * 1000 + fraction
  return Number.isSafeInteger(result) && result > 0 ? result : null
}

function quantityDecimal(value: string) {
  const mills = quantityInThousandths(value)
  if (mills === null) return null
  return formatQuantityMills(mills)
}

function wholeCountQuantity(value: string) {
  const mills = quantityInThousandths(value)
  return mills !== null && mills % 1000 === 0
}

function formatQuantityMills(mills: number) {
  const whole = Math.floor(mills / 1000)
  const fraction = String(mills % 1000).padStart(3, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

function quantityProduct(left: string, right: string) {
  const leftMills = quantityInThousandths(left)
  const rightMills = quantityInThousandths(right)
  if (leftMills === null || rightMills === null) return null
  const result = (BigInt(leftMills) * BigInt(rightMills) + 500n) / 1000n
  if (result <= 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return formatQuantityMills(Number(result))
}

function quantityRatio(total: string, orderQuantity: string) {
  const totalMills = quantityInThousandths(total)
  const orderMills = quantityInThousandths(orderQuantity)
  if (totalMills === null || orderMills === null) return null
  const ratio = (BigInt(totalMills) * 1000n + BigInt(orderMills) / 2n) / BigInt(orderMills)
  if (ratio <= 0n || ratio > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return formatQuantityMills(Number(ratio))
}

function sameComposition(left: ComboComponentDraft[], right: ComboComponentDraft[]) {
  const normalize = (values: ComboComponentDraft[]) => values
    .map((entry) => `${entry.productId}:${quantityDecimal(entry.quantityPerCombo) ?? ''}`)
    .sort()
  const leftNormalized = normalize(left)
  const rightNormalized = normalize(right)
  return leftNormalized.length === rightNormalized.length
    && leftNormalized.every((value, index) => value === rightNormalized[index])
}

async function detectCustomComboOrderCapability(businessId: string): Promise<CustomComboOrderCapability> {
  if (!supabaseClient) return 'unknown'
  try {
    const { error } = await supabaseClient.from('order_line_components')
      .select('quantity_per_unit_snapshot').eq('business_id', businessId).limit(0)
    if (!error) return 'available'
    if (['42703', '42P01'].includes(error.code)) return 'unavailable'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

function snapshotsForReviewRequired(snapshots: Array<{ quantity_per_unit_snapshot: string | null }>) {
  return snapshots.some((snapshot) => snapshot.quantity_per_unit_snapshot === null)
}

function safeLineTotal(priceCents: number | null, quantityMills: number | null) {
  if (priceCents === null || quantityMills === null || !Number.isSafeInteger(priceCents) || priceCents < 0) return null
  const scaled = priceCents * quantityMills
  if (!Number.isSafeInteger(scaled)) return null
  return Math.floor((scaled + 500) / 1000)
}

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function addDaysToDate(value: string, days: number) {
  if (!isCalendarDate(value) || !Number.isInteger(days) || days < 0 || days > 36500) return null
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function addMonthsToDate(value: string, months: number) {
  if (!isCalendarDate(value) || !Number.isInteger(months) || months < 0 || months > 120) return null
  const [year, month, day] = value.split('-').map(Number)
  const monthIndex = year * 12 + month - 1 + months
  const targetYear = Math.floor(monthIndex / 12)
  const targetMonth = monthIndex % 12
  if (targetYear < 1 || targetYear > 9999) return null
  const finalDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  const targetDay = Math.min(day, finalDay)
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`
}

function scheduleBasisPoints(amounts: number[]) {
  const total = amounts.reduce((sum, amount) => sum + amount, 0)
  if (!Number.isSafeInteger(total) || total <= 0 || amounts.some((amount) => !Number.isSafeInteger(amount) || amount <= 0) || amounts.length > 120) return null
  const totalBig = BigInt(total)
  const raw = amounts.map((amount) => {
    const scaled = BigInt(amount) * 10000n
    return { basisPoints: Number(scaled / totalBig), remainder: scaled % totalBig }
  })
  const basisPoints = raw.map((value) => value.basisPoints)
  let remaining = 10000 - basisPoints.reduce((sum, value) => sum + value, 0)
  const order = raw.map((value, index) => ({ index, remainder: value.remainder }))
    .sort((left, right) => left.remainder === right.remainder ? left.index - right.index : left.remainder > right.remainder ? -1 : 1)
  for (let cursor = 0; remaining > 0; cursor += 1, remaining -= 1) basisPoints[order[cursor % order.length].index] += 1
  if (basisPoints.some((value) => value <= 0)) return null
  return basisPoints
}

function centsToInput(cents: bigint) {
  return `${cents / 100n},${String(cents % 100n).padStart(2, '0')}`
}

export function NewOrderPage() {
  const { id: businessId, timezone, role } = useBusiness()
  const { session } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const requestedCustomerId = searchParams.get('cliente') ?? ''
  const sourceOrderId = searchParams.get('origem') ?? ''
  const orderDraftStorageKey = session?.user.id
    ? createNewOrderDraftStorageKey(businessId, session.user.id)
    : null
  const [initialOrderDraft] = useState(() => orderDraftStorageKey ? readNewOrderDraft(orderDraftStorageKey) : null)
  const [draftStatus, setDraftStatus] = useState<NewOrderDraftStatus>(initialOrderDraft ? 'restored' : null)
  const [draftActionError, setDraftActionError] = useState<string | null>(null)
  const draftRestoredRef = useRef(Boolean(initialOrderDraft))
  const draftClearedRef = useRef(false)
  const firstDraftWriteRef = useRef(Boolean(initialOrderDraft))
  const draftTouchedRef = useRef(Boolean(initialOrderDraft))
  const [customers, setCustomers] = useState<Customer[]>([])
  const [deliveryWorkers, setDeliveryWorkers] = useState<DeliveryWorkerChoice[]>([])
  const [deliveryWorkersLoadError, setDeliveryWorkersLoadError] = useState(false)
  const [products, setProducts] = useState<Product[]>([])
  const [stockProducts, setStockProducts] = useState<StockProduct[]>([])
  const [comboDefaults, setComboDefaults] = useState<Record<string, ComboComponentDraft[]>>({})
  const [customComboOrderCapability, setCustomComboOrderCapability] = useState<CustomComboOrderCapability>('unknown')
  const [customComboCapabilityChecking, setCustomComboCapabilityChecking] = useState(false)
  const [loadingChoices, setLoadingChoices] = useState(true)
  const [choiceError, setChoiceError] = useState<string | null>(null)
  const [orderCopySummary, setOrderCopySummary] = useState<OrderCopySummary | null>(null)
  const [orderCopyWarning, setOrderCopyWarning] = useState<string | null>(null)
  const [customerOrderSuggestion, setCustomerOrderSuggestion] = useState<CustomerOrderSuggestion | null>(null)
  const [legacyCompositionReviewConfirmed, setLegacyCompositionReviewConfirmed] = useState(false)
  const [customerSuggestedItems, setCustomerSuggestedItems] = useState<ItemDraft[]>([])
  const [customerPaymentPattern, setCustomerPaymentPattern] = useState<ScheduleEntry[] | null>(null)
  const [customerPrefillNotice, setCustomerPrefillNotice] = useState<string | null>(null)
  const [customerPrefillLoading, setCustomerPrefillLoading] = useState(false)
  const [customerId, setCustomerId] = useState(initialOrderDraft?.customerId ?? requestedCustomerId)
  const [customerSearchPending, setCustomerSearchPending] = useState(false)
  const [customerAddresses, setCustomerAddresses] = useState<CustomerAddress[]>([])
  const [customerAddressesLoading, setCustomerAddressesLoading] = useState(false)
  const [customerAddressesError, setCustomerAddressesError] = useState<string | null>(null)
  const [selectedAddressId, setSelectedAddressId] = useState(initialOrderDraft?.requiresDelivery ? initialOrderDraft.selectedAddressId : '')
  const [requiresDelivery, setRequiresDelivery] = useState(initialOrderDraft?.requiresDelivery ?? false)
  const [deliveryWorkerId, setDeliveryWorkerId] = useState(initialOrderDraft?.requiresDelivery ? initialOrderDraft.deliveryWorkerId : '')
  const [deliveryAddress, setDeliveryAddress] = useState(initialOrderDraft?.requiresDelivery ? initialOrderDraft.deliveryAddress : '')
  const [deliveryFee, setDeliveryFee] = useState(initialOrderDraft?.requiresDelivery ? initialOrderDraft.deliveryFee : '')
  const [discount, setDiscount] = useState(initialOrderDraft?.discount ?? '')
  const [items, setItems] = useState<ItemDraft[]>(initialOrderDraft?.items ?? [{ key: newKey(), productId: '', quantity: '1' }])
  const [scheduleBaseDate, setScheduleBaseDate] = useState(() => initialOrderDraft?.scheduleBaseDate || businessDateForTimestamp(new Date(), timezone))
  const [installments, setInstallments] = useState<InstallmentDraft[]>(() => initialOrderDraft?.installments ?? [{ key: newKey(), amount: '', dueOn: initialOrderDraft?.scheduleBaseDate || businessDateForTimestamp(new Date(), timezone), paymentMethod: '' }])
  const [paymentPlanMode, setPaymentPlanMode] = useState<PaymentPlanMode>(() => initialOrderDraft?.paymentPlanMode
    ?? (initialOrderDraft?.installments.some((installment) => installment.amount.trim() || installment.dueOn || installment.paymentMethod.trim()) ? 'custom' : 'once'))
  const [installmentCount, setInstallmentCount] = useState(() => initialOrderDraft?.installmentCount ?? String(Math.max(2, initialOrderDraft?.installments.length ?? 2)))
  const [installmentPaymentMethod, setInstallmentPaymentMethod] = useState(() => initialOrderDraft?.installmentPaymentMethod ?? initialOrderDraft?.installments[0]?.paymentMethod ?? '')
  const [scheduleTemplates, setScheduleTemplates] = useState<ScheduleTemplate[]>([])
  const [scheduleTemplateLoadError, setScheduleTemplateLoadError] = useState<string | null>(null)
  const [selectedScheduleTemplateId, setSelectedScheduleTemplateId] = useState(initialOrderDraft?.selectedScheduleTemplateId ?? '')
  const [newTemplateName, setNewTemplateName] = useState(initialOrderDraft?.newTemplateName ?? '')
  const [scheduleTemplateMessage, setScheduleTemplateMessage] = useState<string | null>(null)
  const [scheduleTemplateError, setScheduleTemplateError] = useState<string | null>(null)
  const [templateSaving, setTemplateSaving] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uncertain, setUncertain] = useState(Boolean(initialOrderDraft?.submissionPending))
  const [formError, setFormError] = useState<string | null>(initialOrderDraft?.submissionPending
    ? 'Uma tentativa anterior não teve confirmação. Os campos estão bloqueados; tente novamente sem alterar os dados para evitar duplicidade.'
    : null)
  const legacyCompositionReviewCount = items.filter((item) => item.requiresCompositionReview).length
  const requestIdRef = useRef(initialOrderDraft?.requestId ?? newKey())
  const submissionPendingRef = useRef(Boolean(initialOrderDraft?.submissionPending))
  const choicesRequestIdRef = useRef(0)
  const autoScheduleRef = useRef(!initialOrderDraft)
  const scheduleTemplateBusinessRef = useRef<string | null>(null)
  const customerOrderRequestRef = useRef(0)
  const customerAddressRequestRef = useRef(0)
  const initialCustomerPrefillRef = useRef('')
  const customerPrefillManualRef = useRef({
    items: Boolean(initialOrderDraft),
    address: Boolean(initialOrderDraft),
    delivery: Boolean(initialOrderDraft),
    fee: Boolean(initialOrderDraft),
    installments: Boolean(initialOrderDraft),
    baseDate: Boolean(initialOrderDraft),
  })
  const disabled = saving || uncertain
  const createCurrentOrderDraft = useCallback((): NewOrderDraft => ({
    version: 1,
    requestId: requestIdRef.current,
    submissionPending: submissionPendingRef.current,
    customerId,
    selectedAddressId,
    requiresDelivery,
    deliveryWorkerId,
    deliveryAddress,
    deliveryFee,
    discount,
    items,
    installments,
    paymentPlanMode,
    installmentCount,
    installmentPaymentMethod,
    selectedScheduleTemplateId,
    scheduleBaseDate,
    newTemplateName,
  }), [customerId, selectedAddressId, requiresDelivery, deliveryWorkerId, deliveryAddress, deliveryFee,
    discount, items, installments, paymentPlanMode, installmentCount, installmentPaymentMethod, selectedScheduleTemplateId, scheduleBaseDate, newTemplateName])

  const loadChoices = useCallback(async () => {
    const requestId = ++choicesRequestIdRef.current
    if (!supabaseClient) {
      setChoiceError('A conexão da empresa não está disponível.')
      setLoadingChoices(false)
      return
    }
    setLoadingChoices(true)
    setOrderCopySummary(null)
    setOrderCopyWarning(null)
    setLegacyCompositionReviewConfirmed(false)
    try {
      const deliveryWorkersRequest = canManageBusiness(role)
        ? supabaseClient.from('delivery_workers').select('id, name, user_id').eq('business_id', businessId).eq('member_type', 'delivery_driver').eq('is_active', true).not('user_id', 'is', null).order('name', { ascending: true })
        : Promise.resolve({ data: [] as DeliveryWorkerChoice[], error: null })
      const [customersResult, productsResult, stockProductsResult, customComboOrderSupport, deliveryWorkersResult] = await Promise.all([
        supabaseClient.from('customers').select('id, name, phone, whatsapp_phone, delivery_address, is_arariboia, arariboia_limit_cents')
          .eq('business_id', businessId).eq('is_active', true).order('name', { ascending: true }),
        supabaseClient.from('products').select('id, name, inventory_unit, sale_price_cents, is_combo')
          .eq('business_id', businessId).eq('is_active', true).not('sale_price_cents', 'is', null)
          .order('name', { ascending: true }),
        supabaseClient.from('products').select('id, name, inventory_unit, inventory_tracked')
          .eq('business_id', businessId).eq('is_active', true).eq('inventory_tracked', true)
          .eq('is_combo', false).not('inventory_unit', 'is', null).order('name', { ascending: true }),
        detectCustomComboOrderCapability(businessId),
        deliveryWorkersRequest,
      ])
      let loadedTemplates: ScheduleTemplate[] = []
      let templatesUnavailable = false
      try {
        const templatesResult = await supabaseClient.from('payment_schedule_templates')
          .select('id, name, schedule').eq('business_id', businessId).order('name', { ascending: true })
        if (templatesResult.error) templatesUnavailable = true
        else loadedTemplates = (templatesResult.data ?? []) as ScheduleTemplate[]
      } catch {
        templatesUnavailable = true
      }
      if (requestId !== choicesRequestIdRef.current) return
      setCustomComboOrderCapability(customComboOrderSupport)
      if (customersResult.error || productsResult.error || stockProductsResult.error) {
        setChoiceError('Não foi possível carregar clientes e produtos ativos. Tente novamente.')
        return
      }
      const activeCustomers = (customersResult.data ?? []) as Customer[]
      const activeProducts = (productsResult.data ?? []) as Product[]
      const activeStockProducts = (stockProductsResult.data ?? []) as StockProduct[]
      const comboIds = activeProducts.filter((product) => product.is_combo).map((product) => product.id)
      let defaults: Record<string, ComboComponentDraft[]> = {}
      if (comboIds.length > 0) {
        const { data: comboRows, error: comboError } = await supabaseClient.from('combo_components')
          .select('combo_product_id, component_product_id, quantity_per_combo')
          .eq('business_id', businessId).in('combo_product_id', comboIds)
        if (comboError) {
          setChoiceError('Não foi possível carregar a composição padrão das cestas. Tente novamente.')
          return
        }
        defaults = Object.fromEntries(comboIds.map((comboId) => [comboId, []]))
        for (const row of comboRows ?? []) {
          defaults[row.combo_product_id] = [...(defaults[row.combo_product_id] ?? []), {
            productId: row.component_product_id,
            quantityPerCombo: String(row.quantity_per_combo),
          }]
        }
      }
      setCustomers(activeCustomers)
      setProducts(activeProducts)
      setStockProducts(activeStockProducts)
      setDeliveryWorkers((deliveryWorkersResult.data ?? []) as DeliveryWorkerChoice[])
      setDeliveryWorkersLoadError(Boolean(deliveryWorkersResult.error))
      if (!draftRestoredRef.current) setDeliveryWorkerId('')
      setComboDefaults(defaults)
      if (templatesUnavailable) {
        setScheduleTemplates([])
        setScheduleTemplateLoadError('Os modelos de parcelas ainda não estão disponíveis. Você pode informar as parcelas manualmente.')
      } else {
        setScheduleTemplates(loadedTemplates)
        setScheduleTemplateLoadError(null)
        if (scheduleTemplateBusinessRef.current !== businessId) {
          if (!draftRestoredRef.current) setSelectedScheduleTemplateId('')
          autoScheduleRef.current = false
          scheduleTemplateBusinessRef.current = businessId
        }
      }
      const preselectedCustomer = activeCustomers.find((customer) => customer.id === requestedCustomerId)
      if (!sourceOrderId && preselectedCustomer && !draftRestoredRef.current) setDeliveryAddress(preselectedCustomer.delivery_address ?? '')
      setChoiceError(null)

      if (sourceOrderId && !draftRestoredRef.current) {
        try {
          const { data: sourceOrder, error: sourceOrderError } = await supabaseClient.from('orders')
            .select('id, customer_id, status')
            .eq('business_id', businessId).eq('id', sourceOrderId).maybeSingle()
          if (requestId !== choicesRequestIdRef.current) return
          if (sourceOrderError || !sourceOrder) {
            setOrderCopyWarning('Não foi possível usar esse pedido como base. Você pode continuar com um pedido novo.')
            return
          }
          if (sourceOrder.status !== 'open') {
            setOrderCopyWarning('Pedidos cancelados não podem ser repetidos. Você pode continuar com um pedido novo.')
            return
          }

          const sourceCustomer = activeCustomers.find((customer) => customer.id === sourceOrder.customer_id)
          if (!sourceCustomer) {
            setOrderCopyWarning('O cliente do pedido original não está ativo. Selecione um cliente para continuar manualmente.')
            return
          }

          const { data: sourceLines, error: sourceLinesError } = await supabaseClient.from('order_lines')
            .select('id, product_id, quantity')
            .eq('business_id', businessId).eq('order_id', sourceOrderId).order('line_number', { ascending: true })
          if (requestId !== choicesRequestIdRef.current) return
          if (sourceLinesError || !sourceLines || sourceLines.length === 0) {
            setOrderCopyWarning('Não foi possível carregar os itens do pedido original. Você pode continuar com um pedido novo.')
            return
          }

          const { data: sourceComponents, error: sourceComponentsError } = await supabaseClient.from('order_line_components')
            .select('order_line_id, product_id, quantity_snapshot, quantity_per_unit_snapshot')
            .eq('business_id', businessId).eq('order_id', sourceOrderId)
          if (requestId !== choicesRequestIdRef.current) return
          if (sourceComponentsError) {
            setOrderCopyWarning('Não foi possível carregar a composição original das cestas. Você pode continuar com um pedido novo.')
            return
          }
          const componentsByLine = new Map<string, Array<{ product_id: string; quantity_snapshot: string; quantity_per_unit_snapshot: string | null }>>()
          for (const component of sourceComponents ?? []) {
            componentsByLine.set(component.order_line_id, [...(componentsByLine.get(component.order_line_id) ?? []), component])
          }
          const activeProductIds = new Set(activeProducts.map((product) => product.id))
          const activeStockProductIds = new Set(activeStockProducts.map((product) => product.id))
          let skippedItems = 0
          let legacyCompositionsReviewCount = 0
          const copiedItems: ItemDraft[] = []
          for (const line of sourceLines) {
            if (!activeProductIds.has(line.product_id)) {
              skippedItems += 1
              continue
            }
            const product = activeProducts.find((candidate) => candidate.id === line.product_id)
            let copiedComposition: ComboComponentDraft[] | undefined
            if (product?.is_combo) {
              const snapshots = componentsByLine.get(line.id) ?? []
              const historicalComposition = snapshots.map((snapshot) => ({
                productId: snapshot.product_id,
                quantityPerCombo: snapshot.quantity_per_unit_snapshot === null
                  ? quantityRatio(String(snapshot.quantity_snapshot), String(line.quantity)) ?? ''
                  : String(snapshot.quantity_per_unit_snapshot),
              }))
              const validComposition = historicalComposition.length > 0
                && historicalComposition.every((component) => activeStockProductIds.has(component.productId) && Boolean(quantityInThousandths(component.quantityPerCombo)))
              if (!validComposition) {
                skippedItems += 1
                continue
              }
              if (snapshots.some((snapshot) => snapshot.quantity_per_unit_snapshot === null)) legacyCompositionsReviewCount += 1
              const defaultComposition = defaults[line.product_id] ?? []
              if (!sameComposition(historicalComposition, defaultComposition)) copiedComposition = historicalComposition
            }
            copiedItems.push({
              key: newKey(),
              productId: line.product_id,
              quantity: String(line.quantity),
              ...(product?.is_combo && snapshotsForReviewRequired(componentsByLine.get(line.id) ?? []) ? { requiresCompositionReview: true } : {}),
              ...(copiedComposition ? { components: copiedComposition, compositionOpen: true } : {}),
            })
          }
          if (copiedItems.length === 0) {
            setOrderCopyWarning('Os itens do pedido original não estão mais disponíveis com a composição atual. Você pode continuar com um pedido novo.')
            return
          }

          setCustomerId(sourceCustomer.id)
          setDeliveryAddress(sourceCustomer.delivery_address ?? '')
          setItems(copiedItems)
          setLegacyCompositionReviewConfirmed(false)
          setOrderCopySummary({ customerName: sourceCustomer.name, copiedItems: copiedItems.length, customCompositionsCopied: copiedItems.filter((item) => item.components !== undefined).length, legacyCompositionsReviewCount, skippedItems })
        } catch {
          if (requestId === choicesRequestIdRef.current) setOrderCopyWarning('Não foi possível carregar o pedido original. Você pode continuar com um pedido novo.')
        }
      }
    } catch {
      if (requestId === choicesRequestIdRef.current) setChoiceError('Não foi possível carregar clientes e produtos ativos. Tente novamente.')
    } finally {
      if (requestId === choicesRequestIdRef.current) setLoadingChoices(false)
    }
  }, [businessId, requestedCustomerId, role, sourceOrderId])

  async function recheckCustomComboOrderCapability() {
    setCustomComboCapabilityChecking(true)
    try {
      setCustomComboOrderCapability(await detectCustomComboOrderCapability(businessId))
    } finally {
      setCustomComboCapabilityChecking(false)
    }
  }

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    void loadChoices()
    return () => { choicesRequestIdRef.current += 1 }
  }, [loadChoices])

  useEffect(() => {
    const requestId = ++customerAddressRequestRef.current
    const nextCustomerId = customerId
    if (nextCustomerId && !requiresDelivery && supabaseClient) {
      setCustomerAddressesLoading(false)
      return
    }
    // oxlint-disable-next-line react/set-state-in-effect
    setCustomerAddresses([])
    if (!customerPrefillManualRef.current.address) setSelectedAddressId('')
    setCustomerAddressesError(null)
    setCustomerAddressesLoading(Boolean(nextCustomerId && requiresDelivery && supabaseClient))
    if (!nextCustomerId || !requiresDelivery || !supabaseClient) {
      if (!nextCustomerId && !customerPrefillManualRef.current.address) setDeliveryAddress('')
      setCustomerAddressesLoading(false)
      return
    }

    let active = true
    void (async () => {
      try {
        const { data, error: queryError } = await supabaseClient.from('customer_addresses')
          .select('id, label, address, is_default')
          .eq('business_id', businessId).eq('customer_id', nextCustomerId)
          .order('is_default', { ascending: false }).order('label', { ascending: true }).order('id', { ascending: true })
        if (!active || requestId !== customerAddressRequestRef.current) return
        const selectedCustomer = customers.find((customer) => customer.id === nextCustomerId)
        if (queryError) {
          setCustomerAddressesError('Os endereços salvos não estão disponíveis. Você ainda pode informar o endereço neste pedido.')
          if (!customerPrefillManualRef.current.address) setDeliveryAddress(selectedCustomer?.delivery_address ?? '')
          return
        }
        const addresses = (data ?? []) as CustomerAddress[]
        setCustomerAddresses(addresses)
        const preferred = addresses.find((address) => address.is_default) ?? addresses[0]
        if (!customerPrefillManualRef.current.address) {
          setSelectedAddressId(preferred?.id ?? '')
          setDeliveryAddress(preferred?.address ?? selectedCustomer?.delivery_address ?? '')
        }
      } catch {
        if (active && requestId === customerAddressRequestRef.current) {
          setCustomerAddressesError('Os endereços salvos não estão disponíveis. Você ainda pode informar o endereço neste pedido.')
          const selectedCustomer = customers.find((customer) => customer.id === nextCustomerId)
          if (!customerPrefillManualRef.current.address) setDeliveryAddress(selectedCustomer?.delivery_address ?? '')
        }
      } finally {
        if (active && requestId === customerAddressRequestRef.current) setCustomerAddressesLoading(false)
      }
    })()
    return () => { active = false }
  }, [businessId, customerId, customers, requiresDelivery])

  const loadCustomerOrderSuggestion = useCallback(async (nextCustomerId: string) => {
    const requestId = ++customerOrderRequestRef.current
    const manual = customerPrefillManualRef.current
    setCustomerOrderSuggestion(null)
    setCustomerSuggestedItems([])
    setLegacyCompositionReviewConfirmed(false)
    setCustomerPaymentPattern(null)
    setCustomerPrefillNotice(null)
    setCustomerPrefillLoading(Boolean(nextCustomerId && supabaseClient))

    if (!manual.items) setItems([{ key: newKey(), productId: '', quantity: '1' }])
    if (!manual.delivery) setRequiresDelivery(false)
    if (!manual.fee) setDeliveryFee('')
    if (!manual.installments) {
      const nextBaseDate = !manual.baseDate ? businessDateForTimestamp(new Date(), timezone) : scheduleBaseDate
      setInstallments([{ key: newKey(), amount: '', dueOn: nextBaseDate, paymentMethod: '' }])
      setPaymentPlanMode('once')
      setInstallmentPaymentMethod('')
      if (!manual.baseDate) setScheduleBaseDate(nextBaseDate)
      autoScheduleRef.current = false
    }

    if (!nextCustomerId || !supabaseClient) return
    const customer = customers.find((candidate) => candidate.id === nextCustomerId)
    if (!manual.address) setDeliveryAddress(customer?.delivery_address ?? '')

    try {
      const { data: sourceOrder, error: orderError } = await supabaseClient.from('orders')
        .select('id, created_at, requires_delivery, delivery_fee_cents')
        .eq('business_id', businessId).eq('customer_id', nextCustomerId).neq('status', 'cancelled')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (requestId !== customerOrderRequestRef.current) return
      if (orderError) {
        setCustomerPrefillNotice('Não consegui buscar o pedido anterior. O formulário continua disponível para um pedido novo.')
        return
      }
      if (!sourceOrder) {
        setCustomerPrefillNotice('Sem pedido anterior para reaproveitar: carreguei o endereço do cadastro e reiniciei entrega e taxa para este cliente.')
        return
      }

      const [linesResult, installmentsResult] = await Promise.all([
        supabaseClient.from('order_lines').select('id, product_id, quantity')
          .eq('business_id', businessId).eq('order_id', sourceOrder.id).order('line_number', { ascending: true }),
        supabaseClient.from('order_installments').select('amount_cents, due_on, payment_method')
          .eq('business_id', businessId).eq('order_id', sourceOrder.id).order('installment_number', { ascending: true }),
      ])
      if (requestId !== customerOrderRequestRef.current) return
      if (linesResult.error || installmentsResult.error) {
        setCustomerPrefillNotice('Encontrei o pedido anterior, mas não consegui carregar todos os detalhes. Você pode continuar com um pedido novo.')
        return
      }

      const sourceLines = linesResult.data ?? []
      const { data: sourceComponents, error: componentsError } = await supabaseClient.from('order_line_components')
        .select('order_line_id, product_id, quantity_snapshot, quantity_per_unit_snapshot')
        .eq('business_id', businessId).eq('order_id', sourceOrder.id)
      if (requestId !== customerOrderRequestRef.current) return
      if (componentsError) {
        setCustomerPrefillNotice('Encontrei o pedido anterior, mas não consegui carregar a composição das cestas. Você pode continuar com um pedido novo.')
        return
      }
      const componentsByLine = new Map<string, Array<{ product_id: string; quantity_snapshot: string; quantity_per_unit_snapshot: string | null }>>()
      for (const component of sourceComponents ?? []) {
        componentsByLine.set(component.order_line_id, [...(componentsByLine.get(component.order_line_id) ?? []), component])
      }
      const activeProductIds = new Set(products.map((product) => product.id))
      const activeStockProductIds = new Set(stockProducts.map((product) => product.id))
      let skippedItems = 0
      let legacyCompositionsReviewCount = 0
      const copiedItems: ItemDraft[] = []
      for (const line of sourceLines) {
        if (!activeProductIds.has(line.product_id)) {
          skippedItems += 1
          continue
        }
        const product = products.find((candidate) => candidate.id === line.product_id)
        let copiedComposition: ComboComponentDraft[] | undefined
        if (product?.is_combo) {
          const snapshots = componentsByLine.get(line.id) ?? []
          const historicalComposition = snapshots.map((snapshot) => ({
            productId: snapshot.product_id,
            quantityPerCombo: snapshot.quantity_per_unit_snapshot === null
              ? quantityRatio(String(snapshot.quantity_snapshot), String(line.quantity)) ?? ''
              : String(snapshot.quantity_per_unit_snapshot),
          }))
          const validComposition = historicalComposition.length > 0
            && historicalComposition.every((component) => activeStockProductIds.has(component.productId) && Boolean(quantityInThousandths(component.quantityPerCombo)))
          if (!validComposition) {
            skippedItems += 1
            continue
          }
          if (snapshots.some((snapshot) => snapshot.quantity_per_unit_snapshot === null)) legacyCompositionsReviewCount += 1
          const defaultComposition = comboDefaults[line.product_id] ?? []
          if (!sameComposition(historicalComposition, defaultComposition)) copiedComposition = historicalComposition
        }
        copiedItems.push({
          key: newKey(),
          productId: line.product_id,
          quantity: String(line.quantity),
          ...(product?.is_combo && snapshotsForReviewRequired(componentsByLine.get(line.id) ?? []) ? { requiresCompositionReview: true } : {}),
          ...(copiedComposition ? { components: copiedComposition, compositionOpen: true } : {}),
        })
      }
      setCustomerSuggestedItems(copiedItems)
      if (!manual.items && copiedItems.length > 0) setItems(copiedItems)

      const deliveryApplied = !manual.delivery
      const feeApplied = !manual.fee
      if (deliveryApplied) setRequiresDelivery(Boolean(sourceOrder.requires_delivery))
      if (feeApplied) {
        const feeCents = Number(sourceOrder.delivery_fee_cents)
        setDeliveryFee(Number.isSafeInteger(feeCents) && feeCents > 0 ? centsToInput(BigInt(feeCents)) : '')
      }

      const sourceInstallments = installmentsResult.data ?? []
      const originalAmounts = sourceInstallments.map((installment) => Number(installment.amount_cents))
      const basisPoints = scheduleBasisPoints(originalAmounts)
      const originalBaseDate = businessDateForTimestamp(sourceOrder.created_at, timezone)
      const paymentPattern = basisPoints && basisPoints.length === sourceInstallments.length
        ? sourceInstallments.map((installment, index) => {
          const offset = daysBetweenDates(originalBaseDate, installment.due_on)
          return offset === null || offset > 36500 ? null : {
            ordinal: index + 1,
            amount_bps: basisPoints[index],
            days_after_base: Math.max(0, offset),
            payment_method: installment.payment_method,
          }
        })
        : []
      const validPaymentPattern = paymentPattern.length > 0 && paymentPattern.every((entry) => entry !== null)
        ? paymentPattern as ScheduleEntry[]
        : null
      if (validPaymentPattern) setCustomerPaymentPattern(validPaymentPattern)
      if (validPaymentPattern && !manual.installments) {
        setSelectedScheduleTemplateId('')
        if (!manual.baseDate) setScheduleBaseDate(businessDateForTimestamp(new Date(), timezone))
        customerPrefillManualRef.current.installments = false
        autoScheduleRef.current = false
      }

      const currentCustomer = customers.find((candidate) => candidate.id === nextCustomerId)
      setCustomerOrderSuggestion({
        customerName: currentCustomer?.name ?? 'este cliente',
        sourceOrderId: sourceOrder.id,
        sourceCreatedAt: sourceOrder.created_at,
        copiedItems: copiedItems.length,
        customCompositionsCopied: copiedItems.filter((item) => item.components !== undefined).length,
        legacyCompositionsReviewCount,
        skippedItems,
        itemsApplied: !manual.items && copiedItems.length > 0,
        addressApplied: !manual.address,
        deliveryApplied,
        feeApplied,
        installmentStatus: !validPaymentPattern
          ? sourceInstallments.length > 0 ? 'incompatible' : 'none'
          : manual.installments ? 'preserved' : 'pending',
        preservedFields: [
          manual.items ? 'itens' : null,
          manual.address ? 'endereço' : null,
          manual.delivery ? 'opção de entrega' : null,
          manual.fee ? 'taxa' : null,
          manual.installments ? 'parcelas' : null,
          manual.baseDate ? 'data-base' : null,
        ].filter((field): field is string => Boolean(field)),
      })
      if (copiedItems.length === 0 && !deliveryApplied && !feeApplied && !validPaymentPattern) {
        setCustomerPrefillNotice('O pedido anterior não tem itens ativos para reaproveitar. O formulário continua editável.')
      }
    } catch {
      if (requestId === customerOrderRequestRef.current) setCustomerPrefillNotice('Não consegui buscar os detalhes do pedido anterior. O formulário continua disponível para um pedido novo.')
    } finally {
      if (requestId === customerOrderRequestRef.current) setCustomerPrefillLoading(false)
    }
  }, [businessId, comboDefaults, customers, products, stockProducts, timezone])

  useEffect(() => {
    if (sourceOrderId || !requestedCustomerId || loadingChoices || customerId !== requestedCustomerId) return
    if (initialCustomerPrefillRef.current === requestedCustomerId) return
    initialCustomerPrefillRef.current = requestedCustomerId
    void loadCustomerOrderSuggestion(requestedCustomerId)
  }, [customerId, loadCustomerOrderSuggestion, loadingChoices, requestedCustomerId, sourceOrderId])

  const selectedCustomer = customers.find((customer) => customer.id === customerId)
  const arariboiaDueDate = nextArariboiaDueDate(businessDateForTimestamp(new Date(), timezone))
  const arariboiaLimitLabel = selectedCustomer?.arariboia_limit_cents === null || selectedCustomer?.arariboia_limit_cents === undefined
    ? ''
    : ` · limite de referência ${formatBRL(selectedCustomer.arariboia_limit_cents)}`
  const productById = new Map(products.map((product) => [product.id, product]))
  const estimate = useMemo(() => {
    let subtotal = 0
    let invalid = false
    for (const item of items) {
      const product = products.find((candidate) => candidate.id === item.productId)
      const lineTotal = safeLineTotal(product?.sale_price_cents ?? null, quantityInThousandths(item.quantity))
      if (!product || lineTotal === null || !Number.isSafeInteger(subtotal + lineTotal)) {
        invalid = true
      } else {
        subtotal += lineTotal
      }
    }
    return { subtotal, invalid }
  }, [items, products])

  const feeCents = parseBrazilianCurrency(deliveryFee)
  const discountCents = parseBrazilianCurrency(discount)
  const safeFeeCents = requiresDelivery && feeCents !== null ? feeCents : 0
  const safeDiscountCents = discountCents === null ? 0 : discountCents
  const totalCents = estimate.subtotal + safeFeeCents - safeDiscountCents

  function updateItem(key: string, changes: Partial<ItemDraft>) {
    customerPrefillManualRef.current.items = true
    setLegacyCompositionReviewConfirmed(false)
    setItems((current) => current.map((item) => item.key === key
      ? { ...item, ...changes, ...(Object.prototype.hasOwnProperty.call(changes, 'productId') ? { components: undefined, compositionOpen: false, requiresCompositionReview: false } : {}) }
      : item))
    setFormError(null)
  }

  function toggleComboComposition(item: ItemDraft) {
    customerPrefillManualRef.current.items = true
    setItems((current) => current.map((row) => row.key === item.key
      ? { ...row, compositionOpen: !row.compositionOpen }
      : row))
    setFormError(null)
  }

  function resetComboComposition(item: ItemDraft) {
    customerPrefillManualRef.current.items = true
    setLegacyCompositionReviewConfirmed(false)
    setItems((current) => current.map((row) => row.key === item.key
      ? { ...row, components: undefined, compositionOpen: false, requiresCompositionReview: false }
      : row))
    setFormError(null)
  }

  function updateComboComponent(itemKey: string, componentIndex: number, changes: Partial<ComboComponentDraft>) {
    customerPrefillManualRef.current.items = true
    setLegacyCompositionReviewConfirmed(false)
    setItems((current) => current.map((row) => {
      if (row.key !== itemKey) return row
      const currentComponents = row.components ?? comboDefaults[row.productId] ?? []
      const components = currentComponents.map((component, index) => index === componentIndex
        ? { ...component, ...changes }
        : component)
      return { ...row, components }
    }))
    setFormError(null)
  }

  function addComboComponent(item: ItemDraft) {
    const composition = item.components ?? comboDefaults[item.productId] ?? []
    const available = stockProducts.find((candidate) => !composition.some((component) => component.productId === candidate.id))
    if (!available) return
    customerPrefillManualRef.current.items = true
    setLegacyCompositionReviewConfirmed(false)
    setItems((current) => current.map((row) => row.key === item.key ? {
      ...row,
      components: [...composition.map((component) => ({ ...component })), { productId: available.id, quantityPerCombo: '1' }],
      compositionOpen: true,
    } : row))
    setFormError(null)
  }

  function removeComboComponent(itemKey: string, componentIndex: number) {
    customerPrefillManualRef.current.items = true
    setLegacyCompositionReviewConfirmed(false)
    setItems((current) => current.map((row) => row.key === itemKey
      ? { ...row, components: (row.components ?? comboDefaults[row.productId] ?? []).filter((_, index) => index !== componentIndex) }
      : row))
    setFormError(null)
  }

  function updateInstallment(key: string, changes: Partial<InstallmentDraft>) {
    autoScheduleRef.current = false
    customerPrefillManualRef.current.installments = true
    setPaymentPlanMode('custom')
    setCustomerOrderSuggestion((current) => current ? {
      ...current,
      installmentStatus: 'preserved',
      preservedFields: current.preservedFields.includes('parcelas') ? current.preservedFields : [...current.preservedFields, 'parcelas'],
    } : current)
    setInstallments((current) => current.map((installment) => installment.key === key ? { ...installment, ...changes } : installment))
    setFormError(null)
  }

  function handleCustomerChange(nextId: string) {
    setCustomerId(nextId)
    if (nextId !== customerId) {
      // These fields belong to the selected customer; do not carry customer A's
      // address or delivery fee into a new customer's draft.
      customerPrefillManualRef.current.address = false
      customerPrefillManualRef.current.delivery = false
      customerPrefillManualRef.current.fee = false
      customerPrefillManualRef.current.installments = false
      customerPrefillManualRef.current.baseDate = false
      setInstallmentPaymentMethod('')
      setSelectedAddressId('')
      setCustomerAddresses([])
    }
    if (!nextId) {
      setDeliveryAddress('')
      setRequiresDelivery(false)
      setDeliveryFee('')
    }
    void loadCustomerOrderSuggestion(nextId)
    setFormError(null)
  }

  function handleSavedAddressChange(addressId: string) {
    customerPrefillManualRef.current.address = true
    setSelectedAddressId(addressId)
    const selected = customerAddresses.find((address) => address.id === addressId)
    setDeliveryAddress(selected?.address ?? '')
    setFormError(null)
  }

  function applyCustomerSuggestedItems() {
    if (customerSuggestedItems.length === 0) return
    customerPrefillManualRef.current.items = false
    setLegacyCompositionReviewConfirmed(false)
    setItems(customerSuggestedItems.map((item) => ({ ...item, key: newKey() })))
    setCustomerOrderSuggestion((current) => current ? {
      ...current,
      itemsApplied: true,
      preservedFields: current.preservedFields.filter((field) => field !== 'itens'),
    } : current)
  }

  function applyCustomerPaymentSuggestion() {
    if (!customerPaymentPattern) return
    const baseDate = businessDateForTimestamp(new Date(), timezone)
    const nextInstallments = installmentsFromSchedule(customerPaymentPattern, baseDate, totalCents)
    if (!nextInstallments) {
      setScheduleTemplateError('O total do pedido não permite usar essas parcelas. Ajuste o pedido ou as parcelas.')
      setCustomerOrderSuggestion((current) => current ? { ...current, installmentStatus: 'incompatible' } : current)
      return
    }
    customerPrefillManualRef.current.installments = false
    customerPrefillManualRef.current.baseDate = false
    autoScheduleRef.current = false
    setSelectedScheduleTemplateId('')
    setScheduleBaseDate(baseDate)
    setInstallments(nextInstallments)
    setPaymentPlanMode('custom')
    setScheduleTemplateError(null)
    setCustomerOrderSuggestion((current) => current ? {
      ...current,
      installmentStatus: 'applied',
      preservedFields: current.preservedFields.filter((field) => field !== 'parcelas' && field !== 'data-base'),
    } : current)
  }

  const automaticMonthlyInstallments = paymentPlanMode === 'monthly'
    ? monthlyInstallmentSchedule(installmentCount, scheduleBaseDate, totalCents, installmentPaymentMethod)
    : null
  const paymentInstallments = paymentPlanMode === 'once'
    ? [{
      key: installments[0]?.key ?? 'single-payment',
      amount: Number.isSafeInteger(totalCents) && totalCents > 0 ? centsToInput(BigInt(totalCents)) : '',
      dueOn: scheduleBaseDate,
      paymentMethod: installmentPaymentMethod,
    }]
    : paymentPlanMode === 'monthly' ? automaticMonthlyInstallments ?? [] : installments
  const scheduleTotalCents = paymentInstallments.reduce((sum, installment) => {
    const parsed = parseBrazilianCurrency(installment.amount)
    return parsed === null || Number.isNaN(parsed) ? sum : sum + parsed
  }, 0)

  const applyScheduleTemplate = useCallback((automatic = false) => {
    const template = scheduleTemplates.find((candidate) => candidate.id === selectedScheduleTemplateId)
    if (!template) {
      if (!automatic) setScheduleTemplateError('Selecione um modelo para aplicar.')
      return
    }
    if (!isCalendarDate(scheduleBaseDate)) {
      if (!automatic) setScheduleTemplateError('Escolha uma data-base válida antes de aplicar o modelo.')
      return
    }
    if (estimate.invalid || !Number.isSafeInteger(totalCents) || totalCents <= 0) {
      if (!automatic) setScheduleTemplateError('Confira o total do pedido antes de calcular as parcelas.')
      return
    }
    if (template.schedule.length > totalCents) {
      if (!automatic) setScheduleTemplateError('O total do pedido é menor que o número de parcelas. Diminua as parcelas ou ajuste o modelo.')
      return
    }
    const nextInstallments = installmentsFromSchedule(template.schedule, scheduleBaseDate, totalCents)
    if (!nextInstallments) {
      if (!automatic) setScheduleTemplateError('Não foi possível calcular uma das datas deste modelo. Confira a data-base e os prazos.')
      return
    }
    autoScheduleRef.current = true
    setInstallments(nextInstallments)
    setPaymentPlanMode('custom')
    setScheduleTemplateError(null)
    setScheduleTemplateMessage(automatic
      ? `Modelo “${template.name}” preenchido automaticamente para o total atual. Confira as parcelas; você pode editá-las.`
      : `Modelo “${template.name}” aplicado ao total do pedido. Confira os valores e as datas; você ainda pode mudar.`)
  }, [scheduleTemplates, selectedScheduleTemplateId, scheduleBaseDate, estimate.invalid, totalCents])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    if (!customerPaymentPattern) return
    if (estimate.invalid || !Number.isSafeInteger(totalCents) || totalCents <= 0) {
      setCustomerOrderSuggestion((current) => current && current.installmentStatus !== 'incompatible' ? {
        ...current,
        installmentStatus: 'incompatible',
      } : current)
      return
    }
    const nextInstallments = installmentsFromSchedule(customerPaymentPattern, scheduleBaseDate, totalCents)
    if (!nextInstallments) {
      setCustomerOrderSuggestion((current) => current && current.installmentStatus !== 'incompatible' ? {
        ...current,
        installmentStatus: 'incompatible',
      } : current)
      return
    }
    if (customerPrefillManualRef.current.installments) {
      setCustomerOrderSuggestion((current) => current && current.installmentStatus !== 'preserved' ? {
        ...current,
        installmentStatus: 'preserved',
      } : current)
      return
    }
    setCustomerOrderSuggestion((current) => current && current.installmentStatus !== 'pending' ? {
      ...current,
      installmentStatus: 'pending',
    } : current)
  }, [customerPaymentPattern, estimate.invalid, scheduleBaseDate, totalCents])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    if (!autoScheduleRef.current || !selectedScheduleTemplateId || scheduleTemplates.length === 0) return
    applyScheduleTemplate(true)
  }, [applyScheduleTemplate, scheduleTemplates.length, selectedScheduleTemplateId])

  useEffect(() => {
    if (!orderDraftStorageKey || loadingChoices || saving || draftClearedRef.current
      || (customerPrefillLoading && !draftTouchedRef.current)) return
    try {
      const draft = createCurrentOrderDraft()
      if (!hasOrderDraftContent(draft)) {
        window.localStorage.removeItem(orderDraftStorageKey)
        setDraftStatus(null)
        return
      }
      if (!writeNewOrderDraft(orderDraftStorageKey, draft)) throw new Error('Storage indisponível')
      if (firstDraftWriteRef.current) {
        firstDraftWriteRef.current = false
        return
      }
      setDraftStatus('saved')
    } catch {
      setDraftStatus('unavailable')
    }
  }, [orderDraftStorageKey, loadingChoices, saving, customerPrefillLoading, draftTouchedRef, createCurrentOrderDraft])

  async function saveScheduleTemplate() {
    if (!supabaseClient || templateSaving) return
    const name = newTemplateName.trim()
    if (name.length < 1 || name.length > 80) {
      setScheduleTemplateError('Informe um nome de até 80 caracteres para o modelo.')
      return
    }
    if (paymentInstallments.length > 120) {
      setScheduleTemplateError('Um modelo pode ter no máximo 120 parcelas.')
      return
    }
    const amounts = paymentInstallments.map((installment) => parseBrazilianCurrency(installment.amount))
    if (amounts.some((amount) => amount === null || Number.isNaN(amount) || amount <= 0)
      || !Number.isSafeInteger(scheduleTotalCents) || scheduleTotalCents !== totalCents) {
      setScheduleTemplateError('Confira os valores e faça a soma das parcelas dar exatamente o total do pedido antes de salvar o modelo.')
      return
    }
    const basisPoints = scheduleBasisPoints(amounts as number[])
    if (!basisPoints) {
      setScheduleTemplateError('O modelo precisa ter valores acima de zero. Ajuste as parcelas e tente de novo.')
      return
    }
    const schedule = paymentInstallments.map((installment, index) => {
      const [year, month, day] = scheduleBaseDate.split('-').map(Number)
      const [dueYear, dueMonth, dueDay] = installment.dueOn.split('-').map(Number)
      const daysAfterBase = Math.round((Date.UTC(dueYear, dueMonth - 1, dueDay) - Date.UTC(year, month - 1, day)) / 86400000)
      return { ordinal: index + 1, amount_bps: basisPoints[index], days_after_base: daysAfterBase, payment_method: installment.paymentMethod.trim() || null }
    })
    if (!isCalendarDate(scheduleBaseDate) || paymentInstallments.some((installment) => !isCalendarDate(installment.dueOn))
      || schedule.some((entry) => entry.days_after_base < 0 || entry.days_after_base > 36500)) {
      setScheduleTemplateError('Para salvar o modelo, escolha a data da primeira parcela e o intervalo entre as parcelas.')
      return
    }
    setTemplateSaving(true)
    setScheduleTemplateError(null)
    try {
      const { data, error: insertError } = await supabaseClient.from('payment_schedule_templates')
        .insert({ business_id: businessId, name, schedule }).select('id, name, schedule').single()
      if (insertError || !data) {
        setScheduleTemplateError('Não foi possível salvar o modelo. Você ainda pode continuar com as parcelas atuais.')
        return
      }
      setScheduleTemplates((current) => [...current, data as ScheduleTemplate].sort((left, right) => left.name.localeCompare(right.name, 'pt-BR')))
      autoScheduleRef.current = false
      customerPrefillManualRef.current.installments = true
      setCustomerPaymentPattern(null)
      setCustomerOrderSuggestion((current) => current ? { ...current, installmentStatus: 'chosen_other' } : current)
      setSelectedScheduleTemplateId('')
      setNewTemplateName('')
      setScheduleTemplateMessage(`Modelo “${data.name}” salvo. Ele poderá ser aplicado a outro pedido depois.`)
    } catch {
      setScheduleTemplateError('Não foi possível salvar o modelo. Você ainda pode continuar com as parcelas atuais.')
    } finally {
      setTemplateSaving(false)
    }
  }

  function discardOrderDraft() {
    if (!window.confirm('Descartar este rascunho e começar um pedido novo? Os dados preenchidos serão removidos.')) return
    setDraftActionError(null)
    if (submissionPendingRef.current) {
      setDraftActionError('Esta tentativa pode já ter criado o pedido. Tente novamente sem alterar os dados ou confira a lista de pedidos antes de descartar.')
      return
    }
    if (!orderDraftStorageKey) {
      setDraftActionError('Não foi possível identificar este rascunho. Seus dados continuam no formulário.')
      return
    }
    try {
      window.localStorage.removeItem(orderDraftStorageKey)
    } catch {
      writeNewOrderDraft(orderDraftStorageKey, createCurrentOrderDraft())
      setDraftActionError('Não foi possível descartar o rascunho. Seus dados foram preservados; tente novamente.')
      return
    }

    draftClearedRef.current = false
    draftRestoredRef.current = false
    firstDraftWriteRef.current = false
    draftTouchedRef.current = false
    requestIdRef.current = newKey()
    submissionPendingRef.current = false
    customerOrderRequestRef.current += 1
    customerAddressRequestRef.current += 1
    initialCustomerPrefillRef.current = ''
    customerPrefillManualRef.current = { items: false, address: false, delivery: false, fee: false, installments: false, baseDate: false }
    autoScheduleRef.current = false

    setDraftStatus(null)
    setDraftActionError(null)
    setChoiceError(null)
    setOrderCopySummary(null)
    setOrderCopyWarning(null)
    setCustomerOrderSuggestion(null)
    setCustomerSuggestedItems([])
    setCustomerPaymentPattern(null)
    setCustomerPrefillNotice(null)
    setCustomerPrefillLoading(false)
    setCustomerId('')
    setCustomerSearchPending(false)
    setCustomerAddresses([])
    setCustomerAddressesLoading(false)
    setCustomerAddressesError(null)
    setSelectedAddressId('')
    setRequiresDelivery(false)
    setDeliveryWorkerId('')
    setDeliveryAddress('')
    setDeliveryFee('')
    setDiscount('')
    setItems([{ key: newKey(), productId: '', quantity: '1' }])
    const nextPaymentDate = businessDateForTimestamp(new Date(), timezone)
    setInstallments([{ key: newKey(), amount: '', dueOn: nextPaymentDate, paymentMethod: '' }])
    setPaymentPlanMode('once')
    setInstallmentCount('2')
    setInstallmentPaymentMethod('')
    setSelectedScheduleTemplateId('')
    setScheduleBaseDate(nextPaymentDate)
    setNewTemplateName('')
    setScheduleTemplateMessage(null)
    setScheduleTemplateError(null)
    setLegacyCompositionReviewConfirmed(false)
    setFormError(null)
    setUncertain(false)
    navigate('/pedidos/novo', { replace: true })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || saving) return
    if (legacyCompositionReviewCount > 0 && !legacyCompositionReviewConfirmed) {
      setFormError('Confira as quantidades das cestas antigas e confirme antes de criar o pedido.')
      return
    }
    if (customerSearchPending) {
      setFormError('Selecione um cliente na lista ou cancele a busca antes de criar o pedido.')
      return
    }
    if (choiceError || loadingChoices) {
      setFormError('Carregue clientes e produtos antes de salvar o pedido.')
      return
    }
    if (!customers.some((customer) => customer.id === customerId)) {
      setFormError('Selecione um cliente ativo.')
      return
    }
    if (paymentInstallments.length < 1 || paymentInstallments.length > 120) {
      setFormError('O pedido precisa ter entre 1 e 120 parcelas.')
      return
    }
    if (items.length === 0 || items.some((item) => !productById.has(item.productId))) {
      setFormError('Escolha ao menos um produto ativo para cada linha.')
      return
    }
    const productIds = items.map((item) => item.productId)
    if (new Set(productIds).size !== productIds.length) {
      setFormError('Cada produto deve aparecer uma única vez. Ajuste a quantidade na linha correspondente.')
      return
    }
    for (const item of items) {
      const product = productById.get(item.productId)
      if ((product?.is_combo || isDiscreteInventoryUnit(product?.inventory_unit))
        && quantityInThousandths(item.quantity) !== null && !wholeCountQuantity(item.quantity)) {
        setFormError(`Informe um número inteiro para ${product?.name ?? 'este produto'}; a quantidade é contada por unidade.`)
        return
      }
    }
    const stockProductById = new Map(stockProducts.map((product) => [product.id, product]))
    const stockProductIds = new Set(stockProducts.map((product) => product.id))
    for (const item of items) {
      const product = productById.get(item.productId)
      const components = item.components ?? comboDefaults[item.productId] ?? []
      if (!product?.is_combo) {
        if (item.components && item.components.length > 0) {
          setFormError('A composição personalizada só pode ser usada em cestas configuradas como combo.')
          return
        }
        continue
      }
      if ((comboDefaults[item.productId] ?? []).length === 0) {
        setFormError('Cada cesta precisa ter uma composição cadastrada no catálogo antes de entrar em um pedido.')
        return
      }
      if (components.length === 0 || components.length > 100) {
        setFormError('Cada cesta precisa ter de 1 a 100 produtos na composição. Confira a composição cadastrada ou personalize esta cesta.')
        return
      }
      const componentIds = components.map((component) => component.productId)
      const invalidComponentQuantity = components.some((component) => {
        const componentProduct = stockProductById.get(component.productId)
        return !stockProductIds.has(component.productId)
          || quantityInThousandths(component.quantityPerCombo) === null
          || Boolean(componentProduct && isDiscreteInventoryUnit(componentProduct.inventory_unit) && !wholeCountQuantity(component.quantityPerCombo))
      })
      if (new Set(componentIds).size !== componentIds.length || invalidComponentQuantity) {
        setFormError('Confira a composição da cesta. Componentes contados por unidade precisam de quantidades inteiras; kg e outras medidas aceitam até 3 casas decimais.')
        return
      }
      if (customComboOrderCapability !== 'available' && item.components && !sameComposition(item.components, comboDefaults[item.productId] ?? [])) {
        setFormError(customComboOrderCapability === 'unavailable'
          ? 'Este rascunho tem uma composição diferente da cadastrada no Catálogo, e o servidor ainda não salva esse ajuste. Desfaça os ajustes da cesta antes de criar o pedido.'
          : 'Não foi possível confirmar se o servidor salva composições personalizadas. Desfaça os ajustes da cesta ou verifique o suporte novamente antes de criar o pedido.')
        return
      }
    }
    const itemPayload = items.map((item) => ({
      product_id: item.productId,
      quantity: quantityDecimal(item.quantity),
      ...(item.components ? {
        components: item.components.map((component) => ({
          product_id: component.productId,
          quantity_per_combo: quantityDecimal(component.quantityPerCombo),
        })),
      } : {}),
    }))
    if (estimate.invalid || itemPayload.some((item) => item.quantity === null)) {
      setFormError('Confira as quantidades e os valores do catálogo antes de continuar.')
      return
    }
    if (Number.isNaN(feeCents ?? 0) || Number.isNaN(discountCents ?? 0)) {
      setFormError('Confira a taxa de entrega e o desconto. Use valores em reais com até duas casas decimais.')
      return
    }
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0 || safeDiscountCents > estimate.subtotal + safeFeeCents) {
      setFormError('O desconto e a taxa de entrega precisam deixar um total positivo e válido.')
      return
    }
    if (deliveryAddress.trim().length > 1000) {
      setFormError('O endereço é muito longo.')
      return
    }
    if (requiresDelivery && !deliveryAddress.trim()) {
      setFormError('Informe o endereço deste pedido para incluí-lo na fila de entregas.')
      return
    }

    const installmentPayload = [] as { amount_cents: number; due_on: string; payment_method: string | null }[]
    for (const installment of paymentInstallments) {
      const amountCents = parseBrazilianCurrency(installment.amount)
      if (amountCents === null || Number.isNaN(amountCents) || amountCents <= 0 || !isCalendarDate(installment.dueOn)) {
        setFormError('Cada data de pagamento precisa ter um valor positivo e uma data válida.')
        return
      }
      installmentPayload.push({
        amount_cents: amountCents,
        due_on: installment.dueOn,
        payment_method: installment.paymentMethod.trim() || null,
      })
    }
    if (!Number.isSafeInteger(scheduleTotalCents) || scheduleTotalCents !== totalCents) {
      setFormError('A soma das parcelas precisa ser igual ao total do pedido.')
      return
    }

    const wasAlreadyPending = submissionPendingRef.current
    const submissionRequestId = requestIdRef.current
    const submittedDraft = { ...createCurrentOrderDraft(), requestId: submissionRequestId, submissionPending: true }
    if (!orderDraftStorageKey || !writeNewOrderDraft(orderDraftStorageKey, submittedDraft)) {
      setDraftStatus('unavailable')
      setFormError('Não foi possível salvar a tentativa com segurança neste dispositivo. O pedido não foi enviado e seus dados continuam no formulário. Confira o armazenamento do navegador e tente novamente.')
      return
    }

    submissionPendingRef.current = true
    setDraftStatus('saved')
    setSaving(true)
    setFormError(null)
    try {
      const { data, error: rpcError, status: rpcStatus } = await supabaseClient.rpc('create_order', {
        p_business_id: businessId,
        p_customer_id: customerId,
        p_requires_delivery: requiresDelivery,
        p_delivery_address: requiresDelivery ? deliveryAddress.trim() || null : null,
        p_delivery_fee_cents: safeFeeCents,
        p_discount_cents: safeDiscountCents,
        p_notes: null,
        p_items: itemPayload,
        p_installments: installmentPayload,
        p_request_id: submissionRequestId,
      })
      if (rpcError) {
        if (rpcStatus >= 400 && rpcStatus < 500 && !wasAlreadyPending) {
          submissionPendingRef.current = false
          requestIdRef.current = newKey()
          if (!writeNewOrderDraft(orderDraftStorageKey, createCurrentOrderDraft())) setDraftStatus('unavailable')
          setUncertain(false)
          setFormError('O pedido não foi salvo. Revise os dados informados e tente novamente.')
        } else {
          setUncertain(true)
          setFormError(wasAlreadyPending
            ? 'A tentativa anterior ainda pode ter sido salva. Os dados continuam bloqueados; confira a lista de pedidos ou tente novamente sem alterar o formulário.'
            : 'Não foi possível confirmar se o pedido foi salvo. Tente novamente sem alterar os dados para evitar duplicidade.')
        }
        return
      }
      if (typeof data !== 'string') {
        setUncertain(true)
        setFormError('A resposta do pedido não chegou completa. Seus dados foram preservados; tente novamente sem alterar o formulário.')
        return
      }
      draftClearedRef.current = true
      let draftRemoved = false
      if (orderDraftStorageKey) {
        try {
          window.localStorage.removeItem(orderDraftStorageKey)
          draftRemoved = true
        } catch {
          setDraftStatus('unavailable')
        }
      }
      if (draftRemoved) setDraftStatus(null)
      let successMessage = 'Pedido criado. Nenhum recebimento foi registrado; se já recebeu, registre-o manualmente nesta tela.'
      if (!draftRemoved) {
        successMessage += ' O pedido já foi criado, mas o rascunho não pôde ser apagado neste dispositivo. Se ele voltar a aparecer, os campos ficarão bloqueados; tente novamente sem alterar para abrir o mesmo pedido.'
      }
      if (requiresDelivery && deliveryWorkerId) {
        try {
          const { data: delivery, error: deliveryError } = await supabaseClient.from('deliveries')
            .select('id').eq('business_id', businessId).eq('order_id', data).maybeSingle()
          if (deliveryError || !delivery) {
            successMessage += ' Não foi possível confirmar a atribuição do entregador; confira a entrega na fila.'
          } else {
            const { error: planError } = await supabaseClient.rpc('update_delivery_plan', {
              p_business_id: businessId,
              p_delivery_id: delivery.id,
              p_delivery_worker_id: deliveryWorkerId,
              p_scheduled_on: null,
              p_time_window: null,
              p_notes: null,
              p_request_id: newKey(),
            })
            if (planError) successMessage += ' O pedido foi salvo, mas a atribuição do entregador não foi confirmada; confira a fila de entregas.'
          }
        } catch {
          successMessage += ' O pedido foi salvo, mas não foi possível confirmar a atribuição do entregador; confira a fila de entregas.'
        }
      }
      navigate(`/pedidos/${data}`, { replace: true, state: { successMessage } })
    } catch {
      setUncertain(true)
      setFormError('Não foi possível confirmar se o pedido foi salvo. Seus dados foram preservados; tente novamente sem alterar o formulário.')
    } finally {
      setSaving(false)
    }
  }

  const installmentSuggestionMessage = (() => {
    switch (customerOrderSuggestion?.installmentStatus) {
      case 'applied':
        return 'Os valores e as datas do pedido anterior foram ajustados ao total atual. As parcelas começam a partir de hoje.'
      case 'preserved':
        return 'Encontrei as parcelas anteriores, mas mantive as que você já editou. Você pode usar a sugestão abaixo.'
      case 'incompatible':
        return `As parcelas do pedido anterior não cabem no total atual. Ajuste o total ou as parcelas antes de usá-las de novo.${customerOrderSuggestion.preservedFields.includes('parcelas') ? ' Suas edições foram mantidas.' : ''}`
      case 'pending':
        return 'Encontrei as parcelas do pedido anterior. Elas só serão usadas se você escolher reaproveitá-las.'
      case 'chosen_other':
        return 'As parcelas do pedido anterior não serão usadas porque você escolheu outro modelo ou mudou a quantidade.'
      default:
        return 'O pedido anterior não tinha parcelas para reaproveitar.'
    }
  })()
  const hasComboOrderItems = items.some((item) => productById.get(item.productId)?.is_combo)

  return (
    <div className="page-stack">
      <Link className="quiet-link" to="/pedidos">← Voltar para pedidos</Link>
      <header className="page-heading">
        <div><p className="eyebrow">VENDAS</p><h1>Novo pedido</h1><p className="page-description">Escolha o cliente e os produtos. O pagamento único já usa o total do pedido.</p></div>
      </header>
      {draftStatus && <div className={`form-message ${draftStatus === 'unavailable' ? 'form-message-warning' : 'form-message-success'}`}>
        <p role="status">{uncertain
          ? 'Uma tentativa anterior não teve confirmação. Os dados estão bloqueados; repita sem alterar para abrir o mesmo pedido com segurança.'
          : draftStatus === 'restored'
            ? 'Rascunho restaurado. As alterações ficam salvas automaticamente neste dispositivo.'
            : draftStatus === 'saved'
              ? 'Rascunho salvo automaticamente neste dispositivo.'
              : 'Não foi possível salvar o rascunho neste dispositivo. Mantenha esta tela aberta até criar o pedido.'}</p>
        {!uncertain && <button className="text-button" disabled={saving} onClick={discardOrderDraft} type="button">Descartar rascunho</button>}
      </div>}
      {draftActionError && <p className="form-message form-message-error" role="alert">{draftActionError}</p>}

      {choiceError && <div className="inline-state inline-state-error" role="alert"><p>{choiceError}</p><button className="text-button" onClick={() => void loadChoices()} type="button">Tentar novamente</button></div>}
      {orderCopySummary && <div className="form-message form-message-success" role="status">
        <p>Rascunho baseado no pedido de <strong>{orderCopySummary.customerName}</strong>: {orderCopySummary.copiedItems} {orderCopySummary.copiedItems === 1 ? 'item carregado' : 'itens carregados'} com preços atuais.</p>
        <p>Confira os produtos, a entrega e as datas de pagamento antes de salvar.</p>
        {orderCopySummary.customCompositionsCopied > 0 && <p>{orderCopySummary.customCompositionsCopied} {orderCopySummary.customCompositionsCopied === 1 ? 'cesta personalizada foi' : 'cestas personalizadas foram'} reaproveitadas com os produtos ainda disponíveis.</p>}
        {legacyCompositionReviewCount > 0 && <p className="delivery-stock-warning">{legacyCompositionReviewCount} cesta(s) antiga(s) não guardava(m) a quantidade por unidade. Estimei pela quantidade total arredondada; confira os componentes antes de salvar.</p>}
        {orderCopySummary.skippedItems > 0 && <p>{orderCopySummary.skippedItems} {orderCopySummary.skippedItems === 1 ? 'item não foi copiado' : 'itens não foram copiados'} porque o produto ou sua composição não está disponível no catálogo.</p>}
      </div>}
      {orderCopyWarning && <p className="form-message form-message-warning" role="status">{orderCopyWarning}</p>}
      {customerPrefillNotice && <p className="form-message form-message-warning" role="status">{customerPrefillNotice}</p>}
      {customerPrefillLoading && <p className="form-message" role="status">Buscando o pedido anterior deste cliente…</p>}
      {customerOrderSuggestion && <div className="form-message form-message-success" role="status">
        <p>Rascunho baseado no pedido de <strong>{customerOrderSuggestion.customerName}</strong>, de {formatBusinessDate(businessDateForTimestamp(customerOrderSuggestion.sourceCreatedAt, timezone))}. {customerOrderSuggestion.itemsApplied ? 'Itens e endereço foram carregados.' : 'Itens disponíveis para reaproveitar.'} <Link className="quiet-link" to={`/pedidos/${customerOrderSuggestion.sourceOrderId}`}>Ver pedido anterior</Link></p>
        <p>Confira quantidades, preços, entrega e datas de pagamento. Nada foi salvo ainda. {installmentSuggestionMessage}</p>
        {legacyCompositionReviewCount > 0 && <p className="delivery-stock-warning">{legacyCompositionReviewCount} cesta(s) antiga(s) não guardava(m) a quantidade por unidade. Estimei pela quantidade total arredondada; confira os componentes antes de salvar.</p>}
        {customerOrderSuggestion.skippedItems > 0 && <p>{customerOrderSuggestion.skippedItems} {customerOrderSuggestion.skippedItems === 1 ? 'item não foi copiado' : 'itens não foram copiados'} porque o produto ou sua composição não está disponível no catálogo.</p>}
        {customerOrderSuggestion.preservedFields.length > 0 && <p>Preservei suas alterações em: {customerOrderSuggestion.preservedFields.join(', ')}.</p>}
        {customerPrefillManualRef.current.items && customerSuggestedItems.length > 0 && <button className="text-button" disabled={disabled} onClick={applyCustomerSuggestedItems} type="button">Usar os itens deste pedido</button>}
        {(customerOrderSuggestion.installmentStatus === 'preserved' || customerOrderSuggestion.installmentStatus === 'pending') && customerPaymentPattern && <button className="text-button" disabled={disabled} onClick={applyCustomerPaymentSuggestion} type="button">Usar as parcelas deste pedido, recalculadas para hoje</button>}
      </div>}
      {loadingChoices ? <p className="inline-state" aria-live="polite">Carregando clientes e produtos ativos…</p> : (
        <form className="order-create-form" onChangeCapture={() => { draftTouchedRef.current = true; setDraftActionError(null) }} onClickCapture={() => { draftTouchedRef.current = true; setDraftActionError(null) }} onSubmit={handleSubmit}>
          <section className="surface-panel record-form" aria-labelledby="order-customer-heading">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">01 · CLIENTE</p><h2 id="order-customer-heading">Cliente e entrega</h2></div></div>
            {customers.length === 0 ? <p className="inline-state">Cadastre um cliente ativo antes de criar um pedido. <Link to="/clientes">Abrir clientes</Link></p> : (
              <div className="record-form-grid">
                <CustomerSearchSelect customers={customers} disabled={disabled} onPendingChange={setCustomerSearchPending} onSelect={handleCustomerChange} selectedId={customerId} />
                {requestedCustomerId && !selectedCustomer && <p className="form-message form-message-warning record-field-wide">O cliente do atalho não está ativo. Selecione outro cliente disponível.</p>}
                {requiresDelivery && customerId && <label className="record-field record-field-wide"><span className="field-label">Endereço salvo do cliente <span className="field-optional">opcional</span></span>
                  <select className="text-input" disabled={disabled || customerAddressesLoading} onChange={(event) => handleSavedAddressChange(event.target.value)} value={selectedAddressId}>
                    <option value="">Informar endereço neste pedido</option>
                    {customerAddresses.map((address) => <option key={address.id} value={address.id}>{address.label}{address.is_default ? ' · principal' : ''} — {address.address}</option>)}
                  </select>
                  {customerAddressesLoading && <span className="customer-whatsapp-hint" role="status">Carregando endereços salvos…</span>}
                  {customerAddressesError && <span className="customer-whatsapp-hint" role="status">{customerAddressesError}</span>}
                </label>}
                <label className="record-checkbox record-field-wide order-delivery-toggle"><input checked={requiresDelivery} disabled={disabled} onChange={(event) => {
                  const nextRequiresDelivery = event.target.checked
                  customerPrefillManualRef.current.delivery = true
                  setRequiresDelivery(nextRequiresDelivery)
                  if (!nextRequiresDelivery) {
                    customerPrefillManualRef.current.address = true
                    customerPrefillManualRef.current.fee = true
                    setSelectedAddressId('')
                    setDeliveryAddress('')
                    setDeliveryWorkerId('')
                    setDeliveryFee('')
                  }
                }} type="checkbox" /><span><strong>Este pedido precisa ser entregue</strong></span></label>
                {requiresDelivery && <label className="record-field record-field-wide"><span className="field-label">Entregador responsável <span className="field-optional">opcional</span></span>
                  <select className="text-input" disabled={disabled || deliveryWorkersLoadError} onChange={(event) => setDeliveryWorkerId(event.target.value)} value={deliveryWorkerId}>
                    <option value="">Definir depois em Entregas</option>
                    {deliveryWorkers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}
                  </select>
                  {deliveryWorkersLoadError
                    ? <span className="customer-whatsapp-hint">Não foi possível carregar os entregadores com acesso ao painel. Você pode atribuir depois em Entregas.</span>
                    : deliveryWorkers.length === 0
                      ? <span className="customer-whatsapp-hint">Nenhum entregador com acesso ao painel. Cadastre e vincule um acesso em Entregas.</span>
                      : <span className="customer-whatsapp-hint">A atribuição aparece no painel do entregador quando o pedido é salvo.</span>}
                </label>}
                {requiresDelivery && <label className="record-field record-field-wide"><span className="field-label">Endereço da entrega <span className="field-optional">obrigatório</span></span>
                  <textarea className="text-input record-textarea" disabled={disabled} maxLength={1000} onChange={(event) => { customerPrefillManualRef.current.address = true; setSelectedAddressId(''); setDeliveryAddress(event.target.value) }} placeholder="Rua, número e bairro" required rows={2} value={deliveryAddress} />
                  <span className="customer-whatsapp-hint">O endereço fica salvo neste pedido.</span>
                </label>
                }
              </div>
            )}
          </section>

          <section className="surface-panel record-form" aria-labelledby="order-items-heading">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">02 · PRODUTOS</p><h2 id="order-items-heading">Itens do pedido</h2></div>
              <button className="button button-secondary" disabled={disabled || products.length === 0} onClick={() => { customerPrefillManualRef.current.items = true; setLegacyCompositionReviewConfirmed(false); setItems((current) => [...current, { key: newKey(), productId: '', quantity: '1' }]) }} type="button"><Icon name="plus" /> Adicionar item</button>
            </div>
            {hasComboOrderItems && customComboOrderCapability === 'unavailable' && <p className="section-footnote form-message-warning" role="status">A personalização por pedido ainda não está ativa neste servidor. Pedidos usarão as composições cadastradas no Catálogo.</p>}
            {hasComboOrderItems && customComboOrderCapability === 'unknown' && <div className="section-footnote form-message-warning" role="status">
              <p>Não foi possível confirmar se dá para mudar os produtos deste combo. O pedido usará os produtos cadastrados no Catálogo.</p>
              <button className="text-button" disabled={customComboCapabilityChecking} onClick={() => void recheckCustomComboOrderCapability()} type="button">{customComboCapabilityChecking ? 'Verificando suporte…' : 'Verificar novamente'}</button>
            </div>}
            {products.length === 0 ? <p className="inline-state">Não há produtos ativos com preço de venda. <Link to="/catalogo">Abrir catálogo</Link></p> : (
              <div className="order-draft-list">
                {items.map((item, index) => {
                  const product = productById.get(item.productId)
                  const quantityMustBeWhole = Boolean(product?.is_combo || isDiscreteInventoryUnit(product?.inventory_unit))
                  const itemQuantityIsFractional = quantityMustBeWhole && item.quantity.trim() !== ''
                    && quantityInThousandths(item.quantity) !== null && !wholeCountQuantity(item.quantity)
                  const lineCents = safeLineTotal(product?.sale_price_cents ?? null, quantityInThousandths(item.quantity))
                  return (
                    <div className="order-draft-item" key={item.key}>
                      <label className="record-field order-product-select"><span className="field-label">Produto {index + 1} <span aria-hidden="true">*</span></span>
                        <select className="text-input" disabled={disabled} onChange={(event) => updateItem(item.key, { productId: event.target.value })} required value={item.productId}>
                          <option value="">Selecione um produto</option>
                          {products.map((option) => {
                            const missingComboComposition = option.is_combo && (comboDefaults[option.id] ?? []).length === 0
                            return <option disabled={missingComboComposition} key={option.id} value={option.id}>{option.name} · {formatBRL(option.sale_price_cents)}{option.inventory_unit ? ` / ${option.inventory_unit}` : ''}{missingComboComposition ? ' · cadastre a composição no catálogo' : ''}</option>
                          })}
                        </select>
                      </label>
                      <label className="record-field order-quantity-field"><span className="field-label">Quantidade{product?.is_combo ? ' · cesta' : product?.inventory_unit ? ' · ' + product.inventory_unit : ''} <span aria-hidden="true">*</span></span>
                        <input aria-invalid={itemQuantityIsFractional} className="text-input" disabled={disabled} inputMode={quantityMustBeWhole ? 'numeric' : 'decimal'} maxLength={16} onChange={(event) => updateItem(item.key, { quantity: event.target.value })} placeholder="1" value={item.quantity} />
                        {itemQuantityIsFractional && <small className="form-message form-message-error">Use um número inteiro para este produto.</small>}
                      </label>
                      <div className="order-line-total"><span className="field-label">Valor do item</span><strong>{lineCents === null ? '—' : formatBRL(lineCents)}</strong></div>
                      <button aria-label={`Remover item ${index + 1}`} className="text-button order-remove-button" disabled={disabled || items.length === 1} onClick={() => { customerPrefillManualRef.current.items = true; setLegacyCompositionReviewConfirmed(false); setItems((current) => current.filter((row) => row.key !== item.key)) }} type="button">Remover</button>
                      {product?.is_combo && (() => {
                        const catalogComposition = comboDefaults[item.productId] ?? []
                        const composition = item.components ?? catalogComposition
                        const customized = item.components !== undefined
                        const compositionDiffersFromCatalog = customized && !sameComposition(composition, catalogComposition)
                        if ((comboDefaults[item.productId] ?? []).length === 0) {
                          return <p className="section-footnote form-message-error">Cadastre a composição desta cesta no <Link to="/catalogo">catálogo</Link> antes de vendê-la.</p>
                        }
                        return <div className="combo-composition record-field-wide">
                          <div className="section-heading section-heading-compact">
                            <div><p className="eyebrow">{customComboOrderCapability === 'available' ? 'CESTA PERSONALIZÁVEL' : compositionDiffersFromCatalog ? 'COMPOSIÇÃO DIFERENTE DO CATÁLOGO' : 'COMPOSIÇÃO DO CATÁLOGO'}</p><h3>Conteúdo desta cesta</h3></div>
                            {customComboOrderCapability === 'available'
                              ? <button aria-expanded={Boolean(item.compositionOpen)} className="text-button" disabled={disabled} onClick={() => toggleComboComposition(item)} type="button">{item.compositionOpen ? 'Ocultar composição' : customized ? 'Editar composição' : 'Personalizar cesta'}</button>
                              : <span className="neutral-status">Usar padrão do catálogo</span>}
                          </div>
                          {compositionDiffersFromCatalog && customComboOrderCapability !== 'available' && <p className="section-footnote form-message-warning" role="alert">Este pedido tem produtos diferentes dos cadastrados no Catálogo, e o sistema não confirmou se consegue salvar a mudança. Use “Descartar ajustes e voltar ao padrão” antes de salvar.</p>}
                          {customComboOrderCapability !== 'available' && compositionDiffersFromCatalog && !item.compositionOpen && <button className="text-button" disabled={disabled} onClick={() => resetComboComposition(item)} type="button">Descartar ajustes e voltar ao padrão</button>}
                          {!item.compositionOpen && <p className="section-footnote">{customized ? 'Composição personalizada neste pedido.' : composition.length > 0 ? `Usando a composição padrão com ${composition.length} ${composition.length === 1 ? 'produto' : 'produtos'}.` : 'Esta cesta ainda não tem composição padrão; adicione os produtos que farão parte dela.'}</p>}
                          {item.compositionOpen && <>
                            <p className="section-footnote">A quantidade total abaixo considera a quantidade da cesta. O preço continua sendo o valor atual configurado no catálogo.</p>
                            {composition.length === 0 && <p className="inline-state">Nenhum produto na composição. Adicione pelo menos um produto.</p>}
                            {composition.map((component, componentIndex) => {
                              const currentStockProduct = stockProducts.find((candidate) => candidate.id === component.productId)
                              const otherComponents = composition.filter((_, candidateIndex) => candidateIndex !== componentIndex)
                              const selectableProducts = stockProducts.filter((candidate) => candidate.id === component.productId || !otherComponents.some((other) => other.productId === candidate.id))
                              const totalQuantity = quantityProduct(item.quantity, component.quantityPerCombo)
                              const componentQuantityMustBeWhole = isDiscreteInventoryUnit(currentStockProduct?.inventory_unit)
                              const componentQuantityIsFractional = componentQuantityMustBeWhole && component.quantityPerCombo.trim() !== ''
                                && quantityInThousandths(component.quantityPerCombo) !== null && !wholeCountQuantity(component.quantityPerCombo)
                              return <div className="combo-component-row" key={`${item.key}-${componentIndex}`}>
                                <label className="record-field"><span className="field-label">Produto {componentIndex + 1}</span>
                                  <select aria-label={`Produto ${componentIndex + 1} da cesta ${index + 1}`} className="text-input" disabled={disabled || customComboOrderCapability !== 'available'} onChange={(event) => updateComboComponent(item.key, componentIndex, { productId: event.target.value })} required value={component.productId}>
                                    <option value="">Selecione um produto</option>
                                    {!currentStockProduct && <option value={component.productId}>Produto indisponível</option>}
                                    {selectableProducts.map((option) => <option key={option.id} value={option.id}>{option.name}{option.inventory_unit ? ` · ${option.inventory_unit}` : ''}</option>)}
                                  </select>
                                </label>
                                <label className="record-field"><span className="field-label">Por cesta{currentStockProduct?.inventory_unit ? ' · ' + currentStockProduct.inventory_unit : ''}</span>
                                  <input aria-invalid={componentQuantityIsFractional} aria-label={`Quantidade por cesta de ${currentStockProduct?.name ?? `produto ${componentIndex + 1}`}`} className="text-input" disabled={disabled || customComboOrderCapability !== 'available'} inputMode={componentQuantityMustBeWhole ? 'numeric' : 'decimal'} maxLength={16} onChange={(event) => updateComboComponent(item.key, componentIndex, { quantityPerCombo: event.target.value })} placeholder="1" required value={component.quantityPerCombo} />
                                  {componentQuantityIsFractional && <small className="form-message form-message-error">Use um número inteiro para este produto.</small>}
                                </label>
                                <div className="order-line-total"><span className="field-label">Total neste pedido</span><strong>{totalQuantity === null ? '—' : `${totalQuantity}${currentStockProduct?.inventory_unit ? ` ${currentStockProduct.inventory_unit}` : ''}`}</strong></div>
                                <button aria-label={`Remover produto ${componentIndex + 1} da cesta ${index + 1}`} className="text-button order-remove-button" disabled={disabled || customComboOrderCapability !== 'available' || composition.length <= 1} onClick={() => removeComboComponent(item.key, componentIndex)} type="button">Remover</button>
                              </div>
                            })}
                            <div className="record-form-actions">
                              <button className="button button-secondary" disabled={disabled || customComboOrderCapability !== 'available' || composition.length >= 100 || stockProducts.length <= composition.length} onClick={() => addComboComponent(item)} type="button"><Icon name="plus" /> Adicionar produto</button>
                              {customized && <button className="text-button" disabled={disabled} onClick={() => resetComboComposition(item)} type="button">Descartar ajustes e voltar ao padrão</button>}
                            </div>
                          </>}
                        </div>
                      })()}
                    </div>
                  )
                })}
              </div>
            )}
            {legacyCompositionReviewCount > 0 && <label className="record-checkbox record-field-wide"><input checked={legacyCompositionReviewConfirmed} disabled={disabled} onChange={(event) => setLegacyCompositionReviewConfirmed(event.target.checked)} type="checkbox" /><span><strong>Revisei a composição estimada dessas cestas antigas</strong><small>O histórico antigo guardava o total arredondado, não a quantidade original por cesta.</small></span></label>}
            <details className="order-payment-advanced order-optional-details order-adjustments-details">
              <summary>Ajustes no total <span className="field-optional">opcional</span></summary>
              <div className="record-form-grid order-adjustments">
                <label className="record-field"><span className="field-label">Taxa de entrega</span>
                  <input className="text-input" disabled={disabled} inputMode="decimal" onChange={(event) => { customerPrefillManualRef.current.fee = true; setDeliveryFee(event.target.value) }} placeholder="0,00" value={deliveryFee} />
                </label>
                <label className="record-field"><span className="field-label">Desconto</span>
                  <input className="text-input" disabled={disabled} inputMode="decimal" onChange={(event) => setDiscount(event.target.value)} placeholder="0,00" value={discount} />
                </label>
              </div>
            </details>
            <dl className="order-total-list">
              <div><dt>Produtos</dt><dd>{formatBRL(estimate.subtotal)}</dd></div>
              {requiresDelivery && (deliveryFee.trim() || safeFeeCents > 0) && <div><dt>Taxa de entrega</dt><dd>{feeCents === null ? 'Confira o valor' : formatBRL(safeFeeCents)}</dd></div>}
              {(discount.trim() || safeDiscountCents > 0) && <div><dt>Desconto</dt><dd>{discountCents === null ? 'Confira o valor' : `− ${formatBRL(safeDiscountCents)}`}</dd></div>}
              <div className="order-total-grand"><dt>Total estimado do pedido</dt><dd>{Number.isSafeInteger(totalCents) ? formatBRL(totalCents) : '—'}</dd></div>
            </dl>
          </section>

          <section className="surface-panel record-form" aria-labelledby="order-installments-heading">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">03 · PAGAMENTO DO CLIENTE</p><h2 id="order-installments-heading">{paymentPlanMode === 'monthly' ? `${installmentCount || '—'} parcelas mensais` : paymentPlanMode === 'custom' ? 'Parcelas personalizadas' : 'Pagar de uma vez'}</h2></div></div>
            <div className="order-payment-mode-selector" role="group" aria-label="Como o cliente vai pagar">
              <button aria-pressed={paymentPlanMode === 'once'} className="order-payment-mode" disabled={disabled} onClick={() => {
                if (paymentPlanMode === 'custom') {
                  const firstDueDate = installments[0]?.dueOn
                  if (isCalendarDate(firstDueDate)) setScheduleBaseDate(firstDueDate)
                }
                setPaymentPlanMode('once')
                setSelectedScheduleTemplateId('')
                setFormError(null)
              }} type="button"><strong>Uma vez</strong><span>1 pagamento pelo total do pedido</span></button>
              <button aria-pressed={paymentPlanMode === 'monthly'} className="order-payment-mode" disabled={disabled} onClick={() => {
                customerPrefillManualRef.current.installments = true
                setPaymentPlanMode('monthly')
                setCustomerPaymentPattern(null)
                setSelectedScheduleTemplateId('')
                setFormError(null)
              }} type="button"><strong>Parcelado</strong><span>Divisão mensal automática</span></button>
            </div>
            {selectedCustomer?.is_arariboia && <div className="order-payment-preview" aria-label="Cartão Arariboia">
              <span><strong>Arariboia</strong> · vence no dia 6 ({formatBusinessDate(arariboiaDueDate)}){arariboiaLimitLabel}</span>
              <button className="button button-secondary" disabled={disabled} onClick={() => {
                customerPrefillManualRef.current.installments = true
                customerPrefillManualRef.current.baseDate = true
                autoScheduleRef.current = false
                setScheduleBaseDate(arariboiaDueDate)
                setInstallments([{ key: newKey(), amount: '', dueOn: arariboiaDueDate, paymentMethod: 'Arariboia' }])
                setPaymentPlanMode('once')
                setInstallmentPaymentMethod('Arariboia')
                setSelectedScheduleTemplateId('')
                setCustomerPaymentPattern(null)
                setScheduleTemplateMessage(null)
                setScheduleTemplateError(null)
                setFormError(null)
              }} type="button">Usar Arariboia</button>
            </div>}
            {paymentPlanMode !== 'custom' && <div className="record-form-grid order-adjustments">
              {paymentPlanMode === 'monthly' && <label className="record-field"><span className="field-label">Quantidade de parcelas</span>
                <input className="text-input" disabled={disabled} inputMode="numeric" max="120" min="2" onChange={(event) => setInstallmentCount(event.target.value)} type="number" value={installmentCount} />
              </label>}
              <label className="record-field"><span className="field-label">{paymentPlanMode === 'monthly' ? 'Data da 1ª parcela' : 'Data de pagamento'}</span>
                <input className="text-input" disabled={disabled} onChange={(event) => { customerPrefillManualRef.current.baseDate = true; setScheduleBaseDate(event.target.value); setScheduleTemplateMessage(null); setFormError(null) }} type="date" value={scheduleBaseDate} />
              </label>
              <label className="record-field"><span className="field-label">Forma de pagamento <span className="field-optional">opcional · vale para todas</span></span>
                <input className="text-input" disabled={disabled} maxLength={64} onChange={(event) => setInstallmentPaymentMethod(event.target.value)} placeholder="Ex.: Pix, dinheiro, cartão" value={installmentPaymentMethod} />
              </label>
            </div>}
            <p className="section-footnote order-payment-hint">{paymentPlanMode === 'once'
              ? `Valor automático: ${Number.isSafeInteger(totalCents) && totalCents > 0 ? formatBRL(totalCents) : 'o total do pedido'}. O pedido não será marcado como recebido.`
              : paymentPlanMode === 'monthly'
                ? 'Os valores são divididos automaticamente pelo total; centavos restantes ficam na última parcela. Alterar itens ou total recalcula as parcelas.'
                : 'Confira as parcelas e as datas de pagamento abaixo. A soma precisa ser igual ao total do pedido.'}</p>
            {paymentPlanMode === 'monthly' && !automaticMonthlyInstallments && <p className="form-message form-message-error" role="alert">Informe de 2 a 120 parcelas, uma data válida e um total que cubra ao menos R$ 0,01 por parcela.</p>}
            {scheduleTemplateLoadError && <p className="form-message form-message-warning" role="status">{scheduleTemplateLoadError}</p>}
            {(paymentPlanMode === 'once' || paymentPlanMode === 'monthly') && <div className="order-payment-preview" aria-live="polite">
              <strong>{paymentPlanMode === 'once' ? Number.isSafeInteger(totalCents) && totalCents > 0 ? formatBRL(totalCents) : '—' : automaticMonthlyInstallments?.length === 1 ? formatBRL(parseBrazilianCurrency(automaticMonthlyInstallments[0].amount) ?? 0) : automaticMonthlyInstallments ? `${formatBRL(parseBrazilianCurrency(automaticMonthlyInstallments[0].amount) ?? 0)} por parcela` : '—'}</strong>
              <span>{paymentPlanMode === 'once' ? `1 pagamento · ${isCalendarDate(scheduleBaseDate) ? formatBusinessDate(scheduleBaseDate) : 'data a definir'}` : `${installmentCount || '—'} parcelas mensais · total do pedido dividido automaticamente`}</span>
            </div>}
            <details className="order-payment-advanced">
              <summary>Mais opções de pagamento</summary>
              <div className="record-form-actions">
                {paymentPlanMode !== 'custom' && <button className="button button-secondary" disabled={disabled} onClick={() => {
                  setInstallments(paymentInstallments.map((installment) => ({ ...installment })))
                  setPaymentPlanMode('custom')
                  customerPrefillManualRef.current.installments = true
                  setSelectedScheduleTemplateId('')
                }} type="button">Ajustar parcelas manualmente</button>}
              </div>
              {scheduleTemplates.length > 0 && <div className="record-form-grid order-adjustments" aria-label="Aplicar modelo de pagamento">
                <label className="record-field"><span className="field-label">Modelo salvo</span>
                  <select className="text-input" disabled={disabled} onChange={(event) => { const nextId = event.target.value; customerPrefillManualRef.current.installments = true; autoScheduleRef.current = Boolean(nextId); setCustomerPaymentPattern(null); setCustomerOrderSuggestion((current) => current ? { ...current, installmentStatus: 'chosen_other' } : current); setSelectedScheduleTemplateId(nextId); setScheduleTemplateError(null); setScheduleTemplateMessage(null) }} value={selectedScheduleTemplateId}>
                    <option value="">Selecione um modelo</option>
                    {scheduleTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                  </select>
                </label>
                <div className="record-form-actions record-field-wide">
                  <button className="button button-secondary" disabled={disabled || !selectedScheduleTemplateId} onClick={() => { customerPrefillManualRef.current.installments = true; setCustomerPaymentPattern(null); setCustomerOrderSuggestion((current) => current ? { ...current, installmentStatus: 'chosen_other' } : current); applyScheduleTemplate() }} type="button">Aplicar modelo</button>
                  <span className="section-footnote">As datas e valores do modelo serão ajustados a este pedido.</span>
                </div>
              </div>}
              {paymentPlanMode === 'custom' && <>
                <div className="record-form-actions"><button className="text-button" disabled={disabled} onClick={() => setPaymentPlanMode('once')} type="button">Voltar para pagamento automático</button>
                  <button className="button button-secondary" disabled={disabled || installments.length >= 120} onClick={() => setInstallments((current) => [...current, { key: newKey(), amount: '', dueOn: '', paymentMethod: installmentPaymentMethod }])} type="button"><Icon name="plus" /> Adicionar parcela</button>
                </div>
                <div className="order-draft-list">
                  {installments.map((installment, index) => (
                    <div className="order-draft-item installment-draft-item" key={installment.key}>
                      <label className="record-field order-money-field"><span className="field-label">Valor da parcela {index + 1} <span aria-hidden="true">*</span></span>
                        <input className="text-input" disabled={disabled} inputMode="decimal" onChange={(event) => updateInstallment(installment.key, { amount: event.target.value })} placeholder="0,00" value={installment.amount} />
                      </label>
                      <label className="record-field order-date-field"><span className="field-label">Data de pagamento <span aria-hidden="true">*</span></span>
                        <input className="text-input" disabled={disabled} onChange={(event) => updateInstallment(installment.key, { dueOn: event.target.value })} type="date" value={installment.dueOn} />
                      </label>
                      <label className="record-field order-method-field"><span className="field-label">Forma de pagamento <span className="field-optional">opcional</span></span>
                        <input className="text-input" disabled={disabled} maxLength={64} onChange={(event) => updateInstallment(installment.key, { paymentMethod: event.target.value })} placeholder="Ex.: Pix, dinheiro, boleto" value={installment.paymentMethod} />
                      </label>
                      <button aria-label={`Remover data de pagamento ${index + 1}`} className="text-button order-remove-button" disabled={disabled || installments.length === 1} onClick={() => { autoScheduleRef.current = false; customerPrefillManualRef.current.installments = true; setInstallments((current) => current.filter((row) => row.key !== installment.key)) }} type="button">Remover</button>
                    </div>
                  ))}
                </div>
              </>}
              {!scheduleTemplateLoadError && <div className="record-form-grid order-adjustments">
                <label className="record-field"><span className="field-label">Nome deste modelo</span>
                  <input className="text-input" disabled={disabled || templateSaving} maxLength={80} onChange={(event) => setNewTemplateName(event.target.value)} placeholder="Ex.: entrada e restante em 30 dias" value={newTemplateName} />
                </label>
                <div className="record-form-actions record-field-wide">
                  <button className="button button-secondary" disabled={disabled || templateSaving || Boolean(scheduleTemplateLoadError) || !newTemplateName.trim()} onClick={() => void saveScheduleTemplate()} type="button">{templateSaving ? 'Salvando modelo…' : 'Salvar como modelo'}</button>
                </div>
              </div>}
              {scheduleTemplateMessage && <p className="form-message form-message-success" role="status">{scheduleTemplateMessage}</p>}
              {scheduleTemplateError && <p className="form-message form-message-error" role="alert">{scheduleTemplateError}</p>}
            </details>
            <p className={`order-schedule-total ${scheduleTotalCents === totalCents ? 'order-schedule-match' : ''}`} aria-live="polite">
              Total do pagamento: <strong>{formatBRL(scheduleTotalCents)}</strong> · Total do pedido: <strong>{formatBRL(totalCents)}</strong>
            </p>
          </section>

          {formError && <p className="form-message form-message-error" role="alert">{formError}</p>}
          <div className="record-form-actions order-submit-actions">
            <button className="button button-primary" disabled={saving || customerPrefillLoading || customerSearchPending || (!uncertain && (customers.length === 0 || products.length === 0))} type="submit">
              {saving ? 'Salvando pedido…' : customerPrefillLoading ? 'Buscando pedido anterior…' : uncertain ? 'Tentar novamente sem alterar os dados' : 'Criar pedido'}
            </button>
            <span className="section-footnote">O sistema mostra as datas, mas não cobra nem confirma pagamentos sozinho.</span>
          </div>
        </form>
      )}
    </div>
  )
}
