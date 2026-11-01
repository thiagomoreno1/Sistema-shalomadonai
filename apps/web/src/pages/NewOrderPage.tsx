import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { formatBRL, parseBrazilianCurrency } from '../lib/formatters'
import { supabaseClient } from '../lib/supabase'

type Customer = { id: string; name: string; delivery_address: string | null }
type Product = { id: string; name: string; inventory_unit: string | null; sale_price_cents: number | null }
type ItemDraft = { key: string; productId: string; quantity: string }
type InstallmentDraft = { key: string; amount: string; dueOn: string; paymentMethod: string }
type OrderCopySummary = { customerName: string; copiedItems: number; skippedItems: number }
type ScheduleEntry = { ordinal: number; amount_bps: number; days_after_base: number; payment_method: string | null }
type ScheduleTemplate = { id: string; name: string; schedule: ScheduleEntry[] }

function newKey() {
  return crypto.randomUUID()
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
  const whole = Math.floor(mills / 1000)
  const fraction = String(mills % 1000).padStart(3, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
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
  const { id: businessId } = useBusiness()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const requestedCustomerId = searchParams.get('cliente') ?? ''
  const sourceOrderId = searchParams.get('origem') ?? ''
  const [customers, setCustomers] = useState<Customer[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loadingChoices, setLoadingChoices] = useState(true)
  const [choiceError, setChoiceError] = useState<string | null>(null)
  const [orderCopySummary, setOrderCopySummary] = useState<OrderCopySummary | null>(null)
  const [orderCopyWarning, setOrderCopyWarning] = useState<string | null>(null)
  const [customerId, setCustomerId] = useState(requestedCustomerId)
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
  const [scheduleBaseDate, setScheduleBaseDate] = useState('')
  const [newTemplateName, setNewTemplateName] = useState('')
  const [scheduleTemplateMessage, setScheduleTemplateMessage] = useState<string | null>(null)
  const [scheduleTemplateError, setScheduleTemplateError] = useState<string | null>(null)
  const [templateSaving, setTemplateSaving] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const requestIdRef = useRef(newKey())
  const choicesRequestIdRef = useRef(0)
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
    try {
      const [customersResult, productsResult] = await Promise.all([
        supabaseClient.from('customers').select('id, name, delivery_address')
          .eq('business_id', businessId).eq('is_active', true).order('name', { ascending: true }),
        supabaseClient.from('products').select('id, name, inventory_unit, sale_price_cents')
          .eq('business_id', businessId).eq('is_active', true).not('sale_price_cents', 'is', null)
          .order('name', { ascending: true }),
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
      if (customersResult.error || productsResult.error) {
        setChoiceError('Não foi possível carregar clientes e produtos ativos. Tente novamente.')
        return
      }
      const activeCustomers = (customersResult.data ?? []) as Customer[]
      const activeProducts = (productsResult.data ?? []) as Product[]
      setCustomers(activeCustomers)
      setProducts(activeProducts)
      if (templatesUnavailable) {
        setScheduleTemplates([])
        setScheduleTemplateLoadError('Os modelos de vencimentos ainda não estão disponíveis. Você pode informar as parcelas manualmente.')
      } else {
        setScheduleTemplates(loadedTemplates)
        setScheduleTemplateLoadError(null)
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
            .select('product_id, quantity')
            .eq('business_id', businessId).eq('order_id', sourceOrderId).order('line_number', { ascending: true })
          if (requestId !== choicesRequestIdRef.current) return
          if (sourceLinesError || !sourceLines || sourceLines.length === 0) {
            setOrderCopyWarning('Não foi possível carregar os itens do pedido original. Você pode continuar com um pedido novo.')
            return
          }

          const activeProductIds = new Set(activeProducts.map((product) => product.id))
          const copiedItems = sourceLines
            .filter((line) => activeProductIds.has(line.product_id))
            .map((line) => ({ key: newKey(), productId: line.product_id, quantity: String(line.quantity) }))
          if (copiedItems.length === 0) {
            setOrderCopyWarning('Os produtos do pedido original não estão mais ativos com preço no catálogo. Você pode continuar com um pedido novo.')
            return
          }

          setCustomerId(sourceCustomer.id)
          setDeliveryAddress(sourceCustomer.delivery_address ?? '')
          setItems(copiedItems)
          setOrderCopySummary({ customerName: sourceCustomer.name, copiedItems: copiedItems.length, skippedItems: sourceLines.length - copiedItems.length })
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
    setItems((current) => current.map((item) => item.key === key ? { ...item, ...changes } : item))
    setFormError(null)
  }

  function updateInstallment(key: string, changes: Partial<InstallmentDraft>) {
    setInstallments((current) => current.map((installment) => installment.key === key ? { ...installment, ...changes } : installment))
    setFormError(null)
  }

  function handleCustomerChange(nextId: string) {
    setCustomerId(nextId)
    const nextCustomer = customers.find((customer) => customer.id === nextId)
    setDeliveryAddress(nextCustomer?.delivery_address ?? '')
    setFormError(null)
  }

  const scheduleTotalCents = installments.reduce((sum, installment) => {
    const parsed = parseBrazilianCurrency(installment.amount)
    return parsed === null || Number.isNaN(parsed) ? sum : sum + parsed
  }, 0)

  function applyScheduleTemplate() {
    const template = scheduleTemplates.find((candidate) => candidate.id === selectedScheduleTemplateId)
    if (!template) {
      setScheduleTemplateError('Selecione um modelo para aplicar.')
      return
    }
    if (!isCalendarDate(scheduleBaseDate)) {
      setScheduleTemplateError('Escolha uma data-base válida antes de aplicar o modelo.')
      return
    }
    if (estimate.invalid || !Number.isSafeInteger(totalCents) || totalCents <= 0) {
      setScheduleTemplateError('Confira o total do pedido antes de calcular os vencimentos.')
      return
    }
    if (template.schedule.length > totalCents) {
      setScheduleTemplateError('O total atual é menor que a quantidade de parcelas. Reduza as parcelas ou altere os percentuais do modelo.')
      return
    }
    const totalCentsBigInt = BigInt(totalCents)
    const amounts = template.schedule.map((entry) => totalCentsBigInt * BigInt(entry.amount_bps) / 10000n)
    const residual = totalCentsBigInt - amounts.reduce((sum, amount) => sum + amount, 0n)
    amounts[amounts.length - 1] += residual
    if (amounts.some((amount) => amount <= 0n)) {
      setScheduleTemplateError('Este total não permite valores positivos em todas as parcelas. Reduza a quantidade ou ajuste os percentuais do modelo.')
      return
    }
    const nextInstallments = template.schedule.map((entry, index) => {
      const dueOn = addDaysToDate(scheduleBaseDate, entry.days_after_base)
      return dueOn ? { key: newKey(), amount: centsToInput(amounts[index]), dueOn, paymentMethod: entry.payment_method ?? '' } : null
    })
    if (nextInstallments.some((entry) => entry === null)) {
      setScheduleTemplateError('Não foi possível calcular uma das datas deste modelo. Confira a data-base e os prazos.')
      return
    }
    setInstallments(nextInstallments as InstallmentDraft[])
    setScheduleTemplateError(null)
    setScheduleTemplateMessage(`Modelo “${template.name}” aplicado sobre o total atual. Confira valores e datas; eles continuam editáveis.`)
  }

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
      setSelectedScheduleTemplateId(data.id)
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
    const itemPayload = items.map((item) => ({
      product_id: item.productId,
      quantity: quantityDecimal(item.quantity),
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
        {orderCopySummary.skippedItems > 0 && <p>{orderCopySummary.skippedItems} {orderCopySummary.skippedItems === 1 ? 'item não foi copiado' : 'itens não foram copiados'} porque não está ativo com preço no catálogo.</p>}
      </div>}
      {orderCopyWarning && <p className="form-message form-message-warning" role="status">{orderCopyWarning}</p>}
      {loadingChoices ? <p className="inline-state" aria-live="polite">Carregando clientes e produtos ativos…</p> : (
        <form className="order-create-form" onSubmit={handleSubmit}>
          <section className="surface-panel record-form" aria-labelledby="order-customer-heading">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">01 · CLIENTE</p><h2 id="order-customer-heading">Entrega e observações</h2></div></div>
            {customers.length === 0 ? <p className="inline-state">Cadastre um cliente ativo antes de criar um pedido. <Link to="/clientes">Abrir clientes</Link></p> : (
              <div className="record-form-grid">
                <label className="record-field record-field-wide"><span className="field-label">Cliente <span aria-hidden="true">*</span></span>
                  <select className="text-input" disabled={disabled} onChange={(event) => handleCustomerChange(event.target.value)} required value={customerId}>
                    <option value="">Selecione um cliente</option>
                    {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
                  </select>
                </label>
                {requestedCustomerId && !selectedCustomer && <p className="form-message form-message-warning record-field-wide">O cliente do atalho não está ativo. Selecione outro cliente disponível.</p>}
                <label className="record-checkbox record-field-wide order-delivery-toggle"><input checked={requiresDelivery} disabled={disabled} onChange={(event) => setRequiresDelivery(event.target.checked)} type="checkbox" /><span><strong>Este pedido precisa ser entregue</strong><small>Só pedidos marcados aqui entram na fila de entregas.</small></span></label>
                <label className="record-field record-field-wide"><span className="field-label">Endereço registrado para este pedido <span className="field-optional">{requiresDelivery ? 'obrigatório para entrega' : 'opcional'}</span></span>
                  <textarea className="text-input record-textarea" disabled={disabled} maxLength={1000} onChange={(event) => setDeliveryAddress(event.target.value)} placeholder="Pode ajustar ou deixar em branco" required={requiresDelivery} rows={2} value={deliveryAddress} />
                </label>
                <label className="record-field record-field-wide"><span className="field-label">Observações do pedido <span className="field-optional">opcional</span></span>
                  <textarea className="text-input record-textarea" disabled={disabled} maxLength={4000} onChange={(event) => setNotes(event.target.value)} rows={3} value={notes} />
                </label>
              </div>
            )}
          </section>

          <section className="surface-panel record-form" aria-labelledby="order-items-heading">
            <div className="section-heading section-heading-compact"><div><p className="eyebrow">02 · PRODUTOS</p><h2 id="order-items-heading">Itens do pedido</h2></div>
              <button className="button button-secondary" disabled={disabled || products.length === 0} onClick={() => setItems((current) => [...current, { key: newKey(), productId: '', quantity: '1' }])} type="button"><Icon name="plus" /> Adicionar item</button>
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
                          {products.map((option) => <option key={option.id} value={option.id}>{option.name} · {formatBRL(option.sale_price_cents)}{option.inventory_unit ? ` / ${option.inventory_unit}` : ''}</option>)}
                        </select>
                      </label>
                      <label className="record-field order-quantity-field"><span className="field-label">Quantidade <span aria-hidden="true">*</span></span>
                        <input className="text-input" disabled={disabled} inputMode="decimal" maxLength={16} onChange={(event) => updateItem(item.key, { quantity: event.target.value })} placeholder="1" value={item.quantity} />
                      </label>
                      <div className="order-line-total"><span className="field-label">Valor do item</span><strong>{lineCents === null ? '—' : formatBRL(lineCents)}</strong></div>
                      <button aria-label={`Remover item ${index + 1}`} className="text-button order-remove-button" disabled={disabled || items.length === 1} onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))} type="button">Remover</button>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="record-form-grid order-adjustments">
              <label className="record-field"><span className="field-label">Taxa de entrega <span className="field-optional">opcional</span></span>
                <input className="text-input" disabled={disabled} inputMode="decimal" onChange={(event) => setDeliveryFee(event.target.value)} placeholder="0,00" value={deliveryFee} />
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
              <button className="button button-secondary" disabled={disabled || installments.length >= 120} onClick={() => setInstallments((current) => [...current, { key: newKey(), amount: '', dueOn: '', paymentMethod: '' }])} type="button"><Icon name="plus" /> Adicionar vencimento</button>
            </div>
            <p className="section-footnote order-payment-hint">Informe cada vencimento manualmente ou escolha um modelo salvo. Sem aplicar um modelo, nenhuma data ou condição é sugerida.</p>
            <p className="section-footnote">Cada pedido pode ter no máximo 120 vencimentos.</p>
            {scheduleTemplateLoadError && <p className="form-message form-message-warning" role="status">{scheduleTemplateLoadError}</p>}
            {scheduleTemplates.length > 0 && <div className="record-form-grid order-adjustments" aria-label="Aplicar modelo de vencimentos">
              <label className="record-field"><span className="field-label">Modelo salvo</span>
                <select className="text-input" disabled={disabled} onChange={(event) => { setSelectedScheduleTemplateId(event.target.value); setScheduleTemplateError(null); setScheduleTemplateMessage(null) }} value={selectedScheduleTemplateId}>
                  <option value="">Selecione um modelo</option>
                  {scheduleTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                </select>
              </label>
              <label className="record-field"><span className="field-label">Data-base escolhida por você</span>
                <input className="text-input" disabled={disabled} onChange={(event) => { setScheduleBaseDate(event.target.value); setScheduleTemplateMessage(null) }} type="date" value={scheduleBaseDate} />
              </label>
              <div className="record-form-actions record-field-wide">
                <button className="button button-secondary" disabled={disabled || !selectedScheduleTemplateId} onClick={applyScheduleTemplate} type="button">Substituir vencimentos pelo modelo</button>
                <span className="section-footnote">O modelo substitui a lista atual. Ele calcula o total atual, deixa o ajuste de centavos na última parcela e mantém datas e valores editáveis.</span>
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
                  <button aria-label={`Remover vencimento ${index + 1}`} className="text-button order-remove-button" disabled={disabled || installments.length === 1} onClick={() => setInstallments((current) => current.filter((row) => row.key !== installment.key))} type="button">Remover</button>
                </div>
              ))}
            </div>
            <p className={`order-schedule-total ${scheduleTotalCents === totalCents ? 'order-schedule-match' : ''}`} aria-live="polite">
              Soma dos vencimentos: <strong>{formatBRL(scheduleTotalCents)}</strong> · Total do pedido: <strong>{formatBRL(totalCents)}</strong>
            </p>
            {!scheduleTemplateLoadError && <div className="record-form-grid order-adjustments">
              {scheduleTemplates.length === 0 && !scheduleTemplateLoadError && <label className="record-field"><span className="field-label">Data-base do modelo</span>
                <input className="text-input" disabled={disabled} onChange={(event) => { setScheduleBaseDate(event.target.value); setScheduleTemplateMessage(null) }} type="date" value={scheduleBaseDate} />
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
            <button className="button button-primary" disabled={saving || (!uncertain && (customers.length === 0 || products.length === 0))} type="submit">
              {saving ? 'Salvando pedido…' : uncertain ? 'Tentar novamente sem alterar os dados' : 'Criar pedido'}
            </button>
            <span className="section-footnote">Os vencimentos são registros manuais; nenhuma cobrança ou pagamento será processado.</span>
          </div>
        </form>
      )}
    </div>
  )
}
