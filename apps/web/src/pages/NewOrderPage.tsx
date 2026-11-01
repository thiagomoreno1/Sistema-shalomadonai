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
      if (requestId !== choicesRequestIdRef.current) return
      if (customersResult.error || productsResult.error) {
        setChoiceError('Não foi possível carregar clientes e produtos ativos. Tente novamente.')
        return
      }
      const activeCustomers = (customersResult.data ?? []) as Customer[]
      const activeProducts = (productsResult.data ?? []) as Product[]
      setCustomers(activeCustomers)
      setProducts(activeProducts)
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
              <button className="button button-secondary" disabled={disabled} onClick={() => setInstallments((current) => [...current, { key: newKey(), amount: '', dueOn: '', paymentMethod: '' }])} type="button"><Icon name="plus" /> Adicionar vencimento</button>
            </div>
            <p className="section-footnote order-payment-hint">Informe manualmente o valor e a data de cada vencimento. Nenhum prazo ou parcelamento é sugerido automaticamente.</p>
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
