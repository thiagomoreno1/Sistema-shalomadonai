import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { CustomerSearchSelect } from '../components/CustomerSearchSelect'
import { formatBRL, formatBusinessDate, parseBrazilianCurrency } from '../lib/formatters'
import { supabaseClient } from '../lib/supabase'

type Customer = { id: string; name: string; phone: string | null; whatsapp_phone: string | null; delivery_address: string | null }
type Product = { id: string; name: string; inventory_unit: string | null; sale_price_cents: number | null; is_combo: boolean }
type StockProduct = { id: string; name: string; inventory_unit: string; inventory_tracked: true }
type ComboComponentDraft = { productId: string; quantityPerCombo: string }
type ItemDraft = { key: string; productId: string; quantity: string; components?: ComboComponentDraft[]; compositionOpen?: boolean; requiresCompositionReview?: boolean }
type InstallmentDraft = { key: string; amount: string; dueOn: string; paymentMethod: string }
type OrderCopySummary = { customerName: string; copiedItems: number; customCompositionsCopied: number; legacyCompositionsReviewCount: number; skippedItems: number }
type ScheduleEntry = { ordinal: number; amount_bps: number; days_after_base: number; payment_method: string | null }
type ScheduleTemplate = { id: string; name: string; schedule: ScheduleEntry[] }
type InstallmentSuggestionStatus = 'pending' | 'applied' | 'preserved' | 'incompatible' | 'none' | 'chosen_other'
type CustomerOrderSuggestion = { customerName: string; sourceOrderId: string; sourceCreatedAt: string; copiedItems: number; customCompositionsCopied: number; legacyCompositionsReviewCount: number; skippedItems: number; itemsApplied: boolean; addressApplied: boolean; deliveryApplied: boolean; feeApplied: boolean; installmentStatus: InstallmentSuggestionStatus; preservedFields: string[] }

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
  const { id: businessId, timezone } = useBusiness()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const requestedCustomerId = searchParams.get('cliente') ?? ''
  const sourceOrderId = searchParams.get('origem') ?? ''
  const [customers, setCustomers] = useState<Customer[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [stockProducts, setStockProducts] = useState<StockProduct[]>([])
  const [comboDefaults, setComboDefaults] = useState<Record<string, ComboComponentDraft[]>>({})
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
  const [customerId, setCustomerId] = useState(requestedCustomerId)
  const [customerSearchPending, setCustomerSearchPending] = useState(false)
  const [requiresDelivery, setRequiresDelivery] = useState(false)
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [deliveryFee, setDeliveryFee] = useState('')
  const [discount, setDiscount] = useState('')
  const [notes, setNotes] = useState('')
  const [items, setItems] = useState<ItemDraft[]>([{ key: newKey(), productId: '', quantity: '1' }])
  const [installments, setInstallments] = useState<InstallmentDraft[]>([{ key: newKey(), amount: '', dueOn: '', paymentMethod: '' }])
  const [scheduleTemplates, setScheduleTemplates] = useState<ScheduleTemplate[]>([])
  const [scheduleTemplateLoadError, setScheduleTemplateLoadError] = useState<string | null>(null)
  const [selectedScheduleTemplateId, setSelectedScheduleTemplateId] = useState('')
  const [scheduleBaseDate, setScheduleBaseDate] = useState(() => businessDateForTimestamp(new Date(), timezone))
  const [newTemplateName, setNewTemplateName] = useState('')
  const [scheduleTemplateMessage, setScheduleTemplateMessage] = useState<string | null>(null)
  const [scheduleTemplateError, setScheduleTemplateError] = useState<string | null>(null)
  const [templateSaving, setTemplateSaving] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const legacyCompositionReviewCount = items.filter((item) => item.requiresCompositionReview).length
  const requestIdRef = useRef(newKey())
  const choicesRequestIdRef = useRef(0)
  const autoScheduleRef = useRef(true)
  const scheduleTemplateBusinessRef = useRef<string | null>(null)
  const customerOrderRequestRef = useRef(0)
  const initialCustomerPrefillRef = useRef('')
  const customerPrefillManualRef = useRef({ items: false, address: false, delivery: false, fee: false, installments: false, baseDate: false })
  const disabled = saving || uncertain

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
      const [customersResult, productsResult, stockProductsResult] = await Promise.all([
        supabaseClient.from('customers').select('id, name, phone, whatsapp_phone, delivery_address')
          .eq('business_id', businessId).eq('is_active', true).order('name', { ascending: true }),
        supabaseClient.from('products').select('id, name, inventory_unit, sale_price_cents, is_combo')
          .eq('business_id', businessId).eq('is_active', true).not('sale_price_cents', 'is', null)
          .order('name', { ascending: true }),
        supabaseClient.from('products').select('id, name, inventory_unit, inventory_tracked')
          .eq('business_id', businessId).eq('is_active', true).eq('inventory_tracked', true)
          .eq('is_combo', false).not('inventory_unit', 'is', null).order('name', { ascending: true }),
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
      setComboDefaults(defaults)
      if (templatesUnavailable) {
        setScheduleTemplates([])
        setScheduleTemplateLoadError('Os modelos de vencimentos ainda não estão disponíveis. Você pode informar as parcelas manualmente.')
      } else {
        setScheduleTemplates(loadedTemplates)
        setScheduleTemplateLoadError(null)
        if (scheduleTemplateBusinessRef.current !== businessId) {
          setSelectedScheduleTemplateId('')
          autoScheduleRef.current = false
          scheduleTemplateBusinessRef.current = businessId
        }
      }
      const preselectedCustomer = activeCustomers.find((customer) => customer.id === requestedCustomerId)
      if (!sourceOrderId && preselectedCustomer) setDeliveryAddress(preselectedCustomer.delivery_address ?? '')
      setChoiceError(null)

      if (sourceOrderId) {
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
  }, [businessId, requestedCustomerId, sourceOrderId])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    void loadChoices()
    return () => { choicesRequestIdRef.current += 1 }
  }, [loadChoices])

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
      setInstallments([{ key: newKey(), amount: '', dueOn: '', paymentMethod: '' }])
      if (!manual.baseDate) setScheduleBaseDate(businessDateForTimestamp(new Date(), timezone))
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
  const safeFeeCents = feeCents === null ? 0 : feeCents
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
    }
    if (!nextId) {
      setDeliveryAddress('')
      setRequiresDelivery(false)
      setDeliveryFee('')
    }
    void loadCustomerOrderSuggestion(nextId)
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
      setScheduleTemplateError('O total atual não permite reaproveitar esta distribuição de parcelas. Ajuste o pedido ou as parcelas manualmente.')
      setCustomerOrderSuggestion((current) => current ? { ...current, installmentStatus: 'incompatible' } : current)
      return
    }
    customerPrefillManualRef.current.installments = false
    customerPrefillManualRef.current.baseDate = false
    autoScheduleRef.current = false
    setSelectedScheduleTemplateId('')
    setScheduleBaseDate(baseDate)
    setInstallments(nextInstallments)
    setScheduleTemplateError(null)
    setCustomerOrderSuggestion((current) => current ? {
      ...current,
      installmentStatus: 'applied',
      preservedFields: current.preservedFields.filter((field) => field !== 'parcelas' && field !== 'data-base'),
    } : current)
  }

  const scheduleTotalCents = installments.reduce((sum, installment) => {
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
      if (!automatic) setScheduleTemplateError('Confira o total do pedido antes de calcular os vencimentos.')
      return
    }
    if (template.schedule.length > totalCents) {
      if (!automatic) setScheduleTemplateError('O total atual é menor que a quantidade de parcelas. Reduza as parcelas ou altere os percentuais do modelo.')
      return
    }
    const nextInstallments = installmentsFromSchedule(template.schedule, scheduleBaseDate, totalCents)
    if (!nextInstallments) {
      if (!automatic) setScheduleTemplateError('Não foi possível calcular uma das datas deste modelo. Confira a data-base e os prazos.')
      return
    }
    autoScheduleRef.current = true
    setInstallments(nextInstallments)
    setScheduleTemplateError(null)
    setScheduleTemplateMessage(automatic
      ? `Modelo “${template.name}” preenchido automaticamente para o total atual. Confira os vencimentos; você pode editá-los.`
      : `Modelo “${template.name}” aplicado sobre o total atual. Confira valores e datas; eles continuam editáveis.`)
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

  async function saveScheduleTemplate() {
    if (!supabaseClient || templateSaving) return
    const name = newTemplateName.trim()
    if (name.length < 1 || name.length > 80) {
      setScheduleTemplateError('Informe um nome de até 80 caracteres para o modelo.')
      return
    }
    if (installments.length > 120) {
      setScheduleTemplateError('Um modelo pode ter no máximo 120 vencimentos.')
      return
    }
    const amounts = installments.map((installment) => parseBrazilianCurrency(installment.amount))
    if (amounts.some((amount) => amount === null || Number.isNaN(amount) || amount <= 0)
      || !Number.isSafeInteger(scheduleTotalCents) || scheduleTotalCents !== totalCents) {
      setScheduleTemplateError('Confira os valores positivos e faça a soma dos vencimentos fechar exatamente o total atual antes de salvar o modelo.')
      return
    }
    const basisPoints = scheduleBasisPoints(amounts as number[])
    if (!basisPoints) {
      setScheduleTemplateError('Os valores não podem ser convertidos em percentuais positivos para um modelo. Ajuste as parcelas e tente novamente.')
      return
    }
    const schedule = installments.map((installment, index) => {
      const [year, month, day] = scheduleBaseDate.split('-').map(Number)
      const [dueYear, dueMonth, dueDay] = installment.dueOn.split('-').map(Number)
      const daysAfterBase = Math.round((Date.UTC(dueYear, dueMonth - 1, dueDay) - Date.UTC(year, month - 1, day)) / 86400000)
      return { ordinal: index + 1, amount_bps: basisPoints[index], days_after_base: daysAfterBase, payment_method: installment.paymentMethod.trim() || null }
    })
    if (!isCalendarDate(scheduleBaseDate) || installments.some((installment) => !isCalendarDate(installment.dueOn))
      || schedule.some((entry) => entry.days_after_base < 0 || entry.days_after_base > 36500)) {
      setScheduleTemplateError('Para salvar um modelo, informe a data-base e vencimentos entre 0 e 36.500 dias depois dela.')
      return
    }
    setTemplateSaving(true)
    setScheduleTemplateError(null)
    try {
      const { data, error: insertError } = await supabaseClient.from('payment_schedule_templates')
        .insert({ business_id: businessId, name, schedule }).select('id, name, schedule').single()
      if (insertError || !data) {
        setScheduleTemplateError('Não foi possível salvar o modelo. Você ainda pode continuar com os vencimentos atuais.')
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
      setScheduleTemplateError('Não foi possível salvar o modelo. Você ainda pode continuar com os vencimentos atuais.')
    } finally {
      setTemplateSaving(false)
    }
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
    if (installments.length < 1 || installments.length > 120) {
      setFormError('O pedido precisa ter entre 1 e 120 vencimentos.')
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
      if (new Set(componentIds).size !== componentIds.length
        || components.some((component) => !stockProductIds.has(component.productId) || quantityInThousandths(component.quantityPerCombo) === null)) {
        setFormError('Confira os produtos e as quantidades da composição da cesta. Use quantidades positivas com até três casas decimais.')
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
    if (deliveryAddress.trim().length > 1000 || notes.trim().length > 4000) {
      setFormError('Confira o tamanho do endereço ou das observações.')
      return
    }
    if (requiresDelivery && !deliveryAddress.trim()) {
      setFormError('Informe o endereço deste pedido para incluí-lo na fila de entregas.')
      return
    }

    const installmentPayload = [] as { amount_cents: number; due_on: string; payment_method: string | null }[]
    for (const installment of installments) {
      const amountCents = parseBrazilianCurrency(installment.amount)
      if (amountCents === null || Number.isNaN(amountCents) || amountCents <= 0 || !isCalendarDate(installment.dueOn)) {
        setFormError('Cada vencimento precisa ter um valor positivo e uma data válida.')
        return
      }
      installmentPayload.push({
        amount_cents: amountCents,
        due_on: installment.dueOn,
        payment_method: installment.paymentMethod.trim() || null,
      })
    }
    if (!Number.isSafeInteger(scheduleTotalCents) || scheduleTotalCents !== totalCents) {
      setFormError('A soma dos vencimentos precisa ser exatamente igual ao total do pedido.')
      return
    }

    setSaving(true)
    setFormError(null)
    try {
      const { data, error: rpcError, status: rpcStatus } = await supabaseClient.rpc('create_order', {
        p_business_id: businessId,
        p_customer_id: customerId,
        p_requires_delivery: requiresDelivery,
        p_delivery_address: deliveryAddress.trim() || null,
        p_delivery_fee_cents: safeFeeCents,
        p_discount_cents: safeDiscountCents,
        p_notes: notes.trim() || null,
        p_items: itemPayload,
        p_installments: installmentPayload,
        p_request_id: requestIdRef.current,
      })
      if (rpcError) {
        if (rpcStatus >= 400 && rpcStatus < 500) {
          requestIdRef.current = newKey()
          setFormError('O pedido não foi salvo. Revise os dados informados e tente novamente.')
        } else {
          setUncertain(true)
          setFormError('Não foi possível confirmar se o pedido foi salvo. Tente novamente sem alterar os dados para evitar duplicidade.')
        }
        return
      }
      if (typeof data !== 'string') {
        setUncertain(true)
        setFormError('A resposta do pedido não chegou completa. Seus dados foram preservados; tente novamente sem alterar o formulário.')
        return
      }
      navigate(`/pedidos/${data}`, { replace: true, state: { successMessage: 'Pedido criado. Nenhum recebimento foi registrado; se já recebeu, registre-o manualmente nesta tela.' } })
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
        return 'A distribuição e os intervalos do pedido anterior foram aplicados ao total atual, com vencimentos recalculados a partir de hoje.'
      case 'preserved':
        return 'Encontrei as parcelas anteriores, mas mantive os vencimentos que você já editou. Você pode reaplicar a sugestão abaixo.'
      case 'incompatible':
        return `A distribuição anterior não cabe no total atual. Ajuste o total ou a quantidade/valores das parcelas antes de reaplicá-la.${customerOrderSuggestion.preservedFields.includes('parcelas') ? ' Suas edições foram preservadas.' : ''}`
      case 'pending':
        return 'Encontrei a distribuição de parcelas no pedido anterior. Os vencimentos ficam em branco até você escolher reaproveitá-la.'
      case 'chosen_other':
        return 'A distribuição do pedido anterior não está sendo usada porque você escolheu outro modelo ou alterou o seletor.'
      default:
        return 'O pedido anterior não tinha parcelas para reaproveitar.'
    }
  })()

  return (
    <div className="page-stack">
      <Link className="quiet-link" to="/pedidos">← Voltar para pedidos</Link>
      <header className="page-heading">
        <div><p className="eyebrow">VENDAS</p><h1>Novo pedido</h1><p className="page-description">Registre os itens atuais do catálogo e informe cada vencimento combinado.</p></div>
      </header>

      {choiceError && <div className="inline-state inline-state-error" role="alert"><p>{choiceError}</p><button className="text-button" onClick={() => void loadChoices()} type="button">Tentar novamente</button></div>}
      {orderCopySummary && <div className="form-message form-message-success" role="status">
        <p>Pedido parecido preparado para <strong>{orderCopySummary.customerName}</strong>: {orderCopySummary.copiedItems} {orderCopySummary.copiedItems === 1 ? 'item copiado' : 'itens copiados'}; preços recalculados pelo catálogo atual.</p>
        <p>O endereço atual do cadastro foi carregado para conferência. Confirme se há entrega e confira taxa, desconto, observações e vencimentos antes de salvar. Nada foi registrado ainda.</p>
        {orderCopySummary.customCompositionsCopied > 0 && <p>{orderCopySummary.customCompositionsCopied} {orderCopySummary.customCompositionsCopied === 1 ? 'cesta personalizada foi' : 'cestas personalizadas foram'} reaproveitadas com os produtos ainda disponíveis.</p>}
        {legacyCompositionReviewCount > 0 && <p className="delivery-stock-warning">{legacyCompositionReviewCount} cesta(s) antiga(s) não guardava(m) a quantidade por unidade. Estimei pela quantidade total arredondada; confira os componentes antes de salvar.</p>}
        {orderCopySummary.skippedItems > 0 && <p>{orderCopySummary.skippedItems} {orderCopySummary.skippedItems === 1 ? 'item não foi copiado' : 'itens não foram copiados'} porque o produto ou sua composição não está disponível no catálogo.</p>}
      </div>}
      {orderCopyWarning && <p className="form-message form-message-warning" role="status">{orderCopyWarning}</p>}
      {customerPrefillNotice && <p className="form-message form-message-warning" role="status">{customerPrefillNotice}</p>}
      {customerPrefillLoading && <p className="form-message" role="status">Buscando o pedido anterior deste cliente…</p>}
      {customerOrderSuggestion && <div className="form-message form-message-success" role="status">
        <p>Rascunho preenchido com o pedido de <strong>{customerOrderSuggestion.customerName}</strong>, de {formatBusinessDate(businessDateForTimestamp(customerOrderSuggestion.sourceCreatedAt, timezone))}. <Link className="quiet-link" to={`/pedidos/${customerOrderSuggestion.sourceOrderId}`}>Ver pedido usado</Link></p>
        <p>{customerOrderSuggestion.itemsApplied ? `${customerOrderSuggestion.copiedItems} ${customerOrderSuggestion.copiedItems === 1 ? 'item carregado' : 'itens carregados'} com preços atuais.` : `${customerOrderSuggestion.copiedItems} ${customerOrderSuggestion.copiedItems === 1 ? 'item encontrado' : 'itens encontrados'} no pedido anterior.`} {customerOrderSuggestion.customCompositionsCopied > 0 ? `${customerOrderSuggestion.customCompositionsCopied} ${customerOrderSuggestion.customCompositionsCopied === 1 ? 'composição personalizada foi' : 'composições personalizadas foram'} reaproveitadas.` : ''} {customerOrderSuggestion.addressApplied ? 'Endereço atual carregado do cadastro.' : 'Endereço que você digitou foi mantido.'} {customerOrderSuggestion.deliveryApplied ? 'Opção de entrega' : 'Opção de entrega que você escolheu'} e {customerOrderSuggestion.feeApplied ? 'taxa anterior' : 'taxa digitada'} foram considerados. {installmentSuggestionMessage} Recebimentos, anotações e eventos antigos não foram copiados; nada foi salvo ainda.</p>
        {legacyCompositionReviewCount > 0 && <p className="delivery-stock-warning">{legacyCompositionReviewCount} cesta(s) antiga(s) não guardava(m) a quantidade por unidade. Estimei pela quantidade total arredondada; confira os componentes antes de salvar.</p>}
        {customerOrderSuggestion.skippedItems > 0 && <p>{customerOrderSuggestion.skippedItems} {customerOrderSuggestion.skippedItems === 1 ? 'item não foi copiado' : 'itens não foram copiados'} porque o produto ou sua composição não está disponível no catálogo.</p>}
        {customerOrderSuggestion.preservedFields.length > 0 && <p>Preservei suas alterações em: {customerOrderSuggestion.preservedFields.join(', ')}.</p>}
        {customerPrefillManualRef.current.items && customerSuggestedItems.length > 0 && <button className="text-button" disabled={disabled} onClick={applyCustomerSuggestedItems} type="button">Usar os itens deste pedido</button>}
        {(customerOrderSuggestion.installmentStatus === 'preserved' || customerOrderSuggestion.installmentStatus === 'pending') && customerPaymentPattern && <button className="text-button" disabled={disabled} onClick={applyCustomerPaymentSuggestion} type="button">Usar as parcelas deste pedido, recalculadas para hoje</button>}
      </div>}
      {loadingChoices ? <p className="inline-state" aria-live="polite">Carregando clientes e produtos ativos…</p> : (
        <form className="order-create-form" onSubmit={handleSubmit}>
          <section className="surface-panel record-form" aria-labelledby="order-customer-heading">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">01 · CLIENTE</p><h2 id="order-customer-heading">Entrega e observações</h2></div></div>
            {customers.length === 0 ? <p className="inline-state">Cadastre um cliente ativo antes de criar um pedido. <Link to="/clientes">Abrir clientes</Link></p> : (
              <div className="record-form-grid">
                <CustomerSearchSelect customers={customers} disabled={disabled} onPendingChange={setCustomerSearchPending} onSelect={handleCustomerChange} selectedId={customerId} />
                {requestedCustomerId && !selectedCustomer && <p className="form-message form-message-warning record-field-wide">O cliente do atalho não está ativo. Selecione outro cliente disponível.</p>}
                <label className="record-checkbox record-field-wide order-delivery-toggle"><input checked={requiresDelivery} disabled={disabled} onChange={(event) => { customerPrefillManualRef.current.delivery = true; setRequiresDelivery(event.target.checked) }} type="checkbox" /><span><strong>Este pedido precisa ser entregue</strong><small>Só pedidos marcados aqui entram na fila de entregas.</small></span></label>
                <label className="record-field record-field-wide"><span className="field-label">Endereço registrado para este pedido <span className="field-optional">{requiresDelivery ? 'obrigatório para entrega' : 'opcional'}</span></span>
                  <textarea className="text-input record-textarea" disabled={disabled} maxLength={1000} onChange={(event) => { customerPrefillManualRef.current.address = true; setDeliveryAddress(event.target.value) }} placeholder="Pode ajustar ou deixar em branco" required={requiresDelivery} rows={2} value={deliveryAddress} />
                </label>
                <label className="record-field record-field-wide"><span className="field-label">Observações do pedido <span className="field-optional">opcional</span></span>
                  <textarea className="text-input record-textarea" disabled={disabled} maxLength={4000} onChange={(event) => setNotes(event.target.value)} rows={3} value={notes} />
                </label>
              </div>
            )}
          </section>

          <section className="surface-panel record-form" aria-labelledby="order-items-heading">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">02 · PRODUTOS</p><h2 id="order-items-heading">Itens do pedido</h2></div>
              <button className="button button-secondary" disabled={disabled || products.length === 0} onClick={() => { customerPrefillManualRef.current.items = true; setLegacyCompositionReviewConfirmed(false); setItems((current) => [...current, { key: newKey(), productId: '', quantity: '1' }]) }} type="button"><Icon name="plus" /> Adicionar item</button>
            </div>
            {products.length === 0 ? <p className="inline-state">Não há produtos ativos com preço de venda. <Link to="/catalogo">Abrir catálogo</Link></p> : (
              <div className="order-draft-list">
                {items.map((item, index) => {
                  const product = productById.get(item.productId)
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
                      <label className="record-field order-quantity-field"><span className="field-label">Quantidade <span aria-hidden="true">*</span></span>
                        <input className="text-input" disabled={disabled} inputMode="decimal" maxLength={16} onChange={(event) => updateItem(item.key, { quantity: event.target.value })} placeholder="1" value={item.quantity} />
                      </label>
                      <div className="order-line-total"><span className="field-label">Valor do item</span><strong>{lineCents === null ? '—' : formatBRL(lineCents)}</strong></div>
                      <button aria-label={`Remover item ${index + 1}`} className="text-button order-remove-button" disabled={disabled || items.length === 1} onClick={() => { customerPrefillManualRef.current.items = true; setLegacyCompositionReviewConfirmed(false); setItems((current) => current.filter((row) => row.key !== item.key)) }} type="button">Remover</button>
                      {product?.is_combo && (() => {
                        const composition = item.components ?? comboDefaults[item.productId] ?? []
                        const customized = item.components !== undefined
                        if ((comboDefaults[item.productId] ?? []).length === 0) {
                          return <p className="section-footnote form-message-error">Cadastre a composição desta cesta no <Link to="/catalogo">catálogo</Link> antes de vendê-la.</p>
                        }
                        return <div className="combo-composition record-field-wide">
                          <div className="section-heading section-heading-compact">
                            <div><p className="eyebrow">CESTA PERSONALIZÁVEL</p><h3>Conteúdo desta cesta</h3></div>
                            <button aria-expanded={Boolean(item.compositionOpen)} className="text-button" disabled={disabled} onClick={() => toggleComboComposition(item)} type="button">
                              {item.compositionOpen ? 'Ocultar composição' : customized ? 'Editar composição' : 'Personalizar cesta'}
                            </button>
                          </div>
                          {!item.compositionOpen && <p className="section-footnote">{customized ? 'Composição personalizada neste pedido.' : composition.length > 0 ? `Usando a composição padrão com ${composition.length} ${composition.length === 1 ? 'produto' : 'produtos'}.` : 'Esta cesta ainda não tem composição padrão; adicione os produtos que farão parte dela.'}</p>}
                          {item.compositionOpen && <>
                            <p className="section-footnote">A quantidade total abaixo considera a quantidade da cesta. O preço continua sendo o valor atual configurado no catálogo.</p>
                            {composition.length === 0 && <p className="inline-state">Nenhum produto na composição. Adicione pelo menos um produto.</p>}
                            {composition.map((component, componentIndex) => {
                              const currentStockProduct = stockProducts.find((candidate) => candidate.id === component.productId)
                              const otherComponents = composition.filter((_, candidateIndex) => candidateIndex !== componentIndex)
                              const selectableProducts = stockProducts.filter((candidate) => candidate.id === component.productId || !otherComponents.some((other) => other.productId === candidate.id))
                              const totalQuantity = quantityProduct(item.quantity, component.quantityPerCombo)
                              return <div className="combo-component-row" key={`${item.key}-${componentIndex}`}>
                                <label className="record-field"><span className="field-label">Produto {componentIndex + 1}</span>
                                  <select aria-label={`Produto ${componentIndex + 1} da cesta ${index + 1}`} className="text-input" disabled={disabled} onChange={(event) => updateComboComponent(item.key, componentIndex, { productId: event.target.value })} required value={component.productId}>
                                    <option value="">Selecione um produto</option>
                                    {!currentStockProduct && <option value={component.productId}>Produto indisponível</option>}
                                    {selectableProducts.map((option) => <option key={option.id} value={option.id}>{option.name}{option.inventory_unit ? ` · ${option.inventory_unit}` : ''}</option>)}
                                  </select>
                                </label>
                                <label className="record-field"><span className="field-label">Por cesta</span>
                                  <input aria-label={`Quantidade por cesta de ${currentStockProduct?.name ?? `produto ${componentIndex + 1}`}`} className="text-input" disabled={disabled} inputMode="decimal" maxLength={16} onChange={(event) => updateComboComponent(item.key, componentIndex, { quantityPerCombo: event.target.value })} placeholder="1" required value={component.quantityPerCombo} />
                                </label>
                                <div className="order-line-total"><span className="field-label">Total neste pedido</span><strong>{totalQuantity === null ? '—' : `${totalQuantity}${currentStockProduct?.inventory_unit ? ` ${currentStockProduct.inventory_unit}` : ''}`}</strong></div>
                                <button aria-label={`Remover produto ${componentIndex + 1} da cesta ${index + 1}`} className="text-button order-remove-button" disabled={disabled || composition.length <= 1} onClick={() => removeComboComponent(item.key, componentIndex)} type="button">Remover</button>
                              </div>
                            })}
                            <div className="record-form-actions">
                              <button className="button button-secondary" disabled={disabled || composition.length >= 100 || stockProducts.length <= composition.length} onClick={() => addComboComponent(item)} type="button"><Icon name="plus" /> Adicionar produto</button>
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
            <div className="record-form-grid order-adjustments">
              <label className="record-field"><span className="field-label">Taxa de entrega <span className="field-optional">opcional</span></span>
                <input className="text-input" disabled={disabled} inputMode="decimal" onChange={(event) => { customerPrefillManualRef.current.fee = true; setDeliveryFee(event.target.value) }} placeholder="0,00" value={deliveryFee} />
              </label>
              <label className="record-field"><span className="field-label">Desconto <span className="field-optional">opcional</span></span>
                <input className="text-input" disabled={disabled} inputMode="decimal" onChange={(event) => setDiscount(event.target.value)} placeholder="0,00" value={discount} />
              </label>
            </div>
            <dl className="order-total-list">
              <div><dt>Subtotal atual do catálogo</dt><dd>{formatBRL(estimate.subtotal)}</dd></div>
              <div><dt>Taxa de entrega</dt><dd>{Number.isNaN(feeCents ?? 0) ? 'Confira o valor' : formatBRL(safeFeeCents)}</dd></div>
              <div><dt>Desconto</dt><dd>{Number.isNaN(discountCents ?? 0) ? 'Confira o valor' : `− ${formatBRL(safeDiscountCents)}`}</dd></div>
              <div className="order-total-grand"><dt>Total estimado do pedido</dt><dd>{Number.isSafeInteger(totalCents) ? formatBRL(totalCents) : '—'}</dd></div>
            </dl>
            <p className="section-footnote">O pedido guarda o nome e preço atuais dos produtos como fotografia deste registro. A soma final é calculada novamente ao salvar.</p>
          </section>

          <section className="surface-panel record-form" aria-labelledby="order-installments-heading">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">03 · PAGAMENTO COMBINADO</p><h2 id="order-installments-heading">Vencimentos informados neste pedido</h2></div>
              <button className="button button-secondary" disabled={disabled || installments.length >= 120} onClick={() => { autoScheduleRef.current = false; customerPrefillManualRef.current.installments = true; setCustomerOrderSuggestion((current) => current ? { ...current, installmentStatus: 'preserved', preservedFields: current.preservedFields.includes('parcelas') ? current.preservedFields : [...current.preservedFields, 'parcelas'] } : current); setInstallments((current) => [...current, { key: newKey(), amount: '', dueOn: '', paymentMethod: '' }]) }} type="button"><Icon name="plus" /> Adicionar vencimento</button>
            </div>
            <p className="section-footnote order-payment-hint">Informe os vencimentos deste pedido. Se você selecionar um modelo, ele preencherá valores e datas; você pode conferir e ajustar tudo antes de salvar.</p>
            <p className="section-footnote">Cada pedido pode ter no máximo 120 vencimentos.</p>
            {scheduleTemplateLoadError && <p className="form-message form-message-warning" role="status">{scheduleTemplateLoadError}</p>}
            {scheduleTemplates.length > 0 && <div className="record-form-grid order-adjustments" aria-label="Aplicar modelo de vencimentos">
              <label className="record-field"><span className="field-label">Modelo salvo</span>
                <select className="text-input" disabled={disabled} onChange={(event) => { const nextId = event.target.value; customerPrefillManualRef.current.installments = true; autoScheduleRef.current = Boolean(nextId); setCustomerPaymentPattern(null); setCustomerOrderSuggestion((current) => current ? { ...current, installmentStatus: 'chosen_other' } : current); setSelectedScheduleTemplateId(nextId); setScheduleTemplateError(null); setScheduleTemplateMessage(null) }} value={selectedScheduleTemplateId}>
                  <option value="">Selecione um modelo</option>
                  {scheduleTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                </select>
              </label>
              <label className="record-field"><span className="field-label">Data-base <span className="field-optional">padrão: hoje</span></span>
                <input className="text-input" disabled={disabled} onChange={(event) => { customerPrefillManualRef.current.baseDate = true; setScheduleBaseDate(event.target.value); setScheduleTemplateMessage(null) }} type="date" value={scheduleBaseDate} />
              </label>
              <div className="record-form-actions record-field-wide">
                <button className="button button-secondary" disabled={disabled || !selectedScheduleTemplateId} onClick={() => { customerPrefillManualRef.current.installments = true; setCustomerPaymentPattern(null); setCustomerOrderSuggestion((current) => current ? { ...current, installmentStatus: 'chosen_other' } : current); applyScheduleTemplate() }} type="button">Reaplicar modelo</button>
                <span className="section-footnote">Ao trocar o modelo, os vencimentos são recalculados. O ajuste de centavos fica na última parcela; datas e valores continuam editáveis.</span>
              </div>
            </div>}
            {scheduleTemplateMessage && <p className="form-message form-message-success" role="status">{scheduleTemplateMessage}</p>}
            {scheduleTemplateError && <p className="form-message form-message-error" role="alert">{scheduleTemplateError}</p>}
            <div className="order-draft-list">
              {installments.map((installment, index) => (
                <div className="order-draft-item installment-draft-item" key={installment.key}>
                  <label className="record-field order-money-field"><span className="field-label">Valor do vencimento {index + 1} <span aria-hidden="true">*</span></span>
                    <input className="text-input" disabled={disabled} inputMode="decimal" onChange={(event) => updateInstallment(installment.key, { amount: event.target.value })} placeholder="0,00" value={installment.amount} />
                  </label>
                  <label className="record-field order-date-field"><span className="field-label">Data de vencimento <span aria-hidden="true">*</span></span>
                    <input className="text-input" disabled={disabled} onChange={(event) => updateInstallment(installment.key, { dueOn: event.target.value })} type="date" value={installment.dueOn} />
                  </label>
                  <label className="record-field order-method-field"><span className="field-label">Forma combinada <span className="field-optional">texto opcional</span></span>
                    <input className="text-input" disabled={disabled} maxLength={64} onChange={(event) => updateInstallment(installment.key, { paymentMethod: event.target.value })} placeholder="Ex.: Pix, dinheiro, boleto" value={installment.paymentMethod} />
                  </label>
                  <button aria-label={`Remover vencimento ${index + 1}`} className="text-button order-remove-button" disabled={disabled || installments.length === 1} onClick={() => { autoScheduleRef.current = false; customerPrefillManualRef.current.installments = true; setCustomerOrderSuggestion((current) => current ? { ...current, installmentStatus: 'preserved', preservedFields: current.preservedFields.includes('parcelas') ? current.preservedFields : [...current.preservedFields, 'parcelas'] } : current); setInstallments((current) => current.filter((row) => row.key !== installment.key)) }} type="button">Remover</button>
                </div>
              ))}
            </div>
            <p className={`order-schedule-total ${scheduleTotalCents === totalCents ? 'order-schedule-match' : ''}`} aria-live="polite">
              Soma dos vencimentos: <strong>{formatBRL(scheduleTotalCents)}</strong> · Total do pedido: <strong>{formatBRL(totalCents)}</strong>
            </p>
            {!scheduleTemplateLoadError && <div className="record-form-grid order-adjustments">
              {scheduleTemplates.length === 0 && !scheduleTemplateLoadError && <label className="record-field"><span className="field-label">Data-base do modelo</span>
                <input className="text-input" disabled={disabled} onChange={(event) => { customerPrefillManualRef.current.baseDate = true; setScheduleBaseDate(event.target.value); setScheduleTemplateMessage(null) }} type="date" value={scheduleBaseDate} />
                <span className="section-footnote">Escolha antes de salvar. Ela não cria vencimentos por conta própria.</span>
              </label>}
              <label className="record-field"><span className="field-label">Nome para salvar este cronograma como modelo</span>
                <input className="text-input" disabled={disabled || templateSaving} maxLength={80} onChange={(event) => setNewTemplateName(event.target.value)} placeholder="Ex.: entrada e saldo em 30 dias" value={newTemplateName} />
              </label>
              <div className="record-form-actions record-field-wide">
                <button className="button button-secondary" disabled={disabled || templateSaving || Boolean(scheduleTemplateLoadError) || !newTemplateName.trim()} onClick={() => void saveScheduleTemplate()} type="button">{templateSaving ? 'Salvando modelo…' : 'Salvar vencimentos como modelo'}</button>
                {scheduleTemplates.length === 0 && !scheduleTemplateLoadError && <span className="section-footnote">O modelo será salvo para este negócio e usado somente quando você o selecionar.</span>}
              </div>
            </div>}
          </section>

          {formError && <p className="form-message form-message-error" role="alert">{formError}</p>}
          <div className="record-form-actions order-submit-actions">
            <button className="button button-primary" disabled={saving || customerPrefillLoading || customerSearchPending || (!uncertain && (customers.length === 0 || products.length === 0))} type="submit">
              {saving ? 'Salvando pedido…' : customerPrefillLoading ? 'Buscando pedido anterior…' : uncertain ? 'Tentar novamente sem alterar os dados' : 'Criar pedido'}
            </button>
            <span className="section-footnote">Os vencimentos são registros manuais; nenhuma cobrança ou pagamento será processado.</span>
          </div>
        </form>
      )}
    </div>
  )
}
