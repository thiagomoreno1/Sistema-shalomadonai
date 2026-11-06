import { useCallback, useEffect, useRef, useState } from 'react'
import { useBusiness } from '../business/BusinessContext'
import { formatBRLExact, formatBusinessDate } from '../lib/formatters'
import { createDemoProductRevenueSummary, formatQuantityMilli, loadDashboardProductRevenue, type DashboardProductRevenueSummary } from '../lib/dashboardProductRevenue'
import { isDemoPreviewEnabled } from '../lib/demoPreview'
import { supabaseClient } from '../lib/supabase'
import { useVisibleAutoRefresh } from '../lib/useVisibleAutoRefresh'

function dayCountBetween(startOn: string, endOn: string) {
  return Math.floor((Date.parse(`${endOn}T00:00:00Z`) - Date.parse(`${startOn}T00:00:00Z`)) / 86_400_000) + 1
}

export function DashboardProductRevenue({ startOn, endOn }: { startOn: string; endOn: string }) {
  const { id: businessId, role } = useBusiness()
  const demoPreview = role === 'owner' && isDemoPreviewEnabled()
  const scopeKey = `${businessId}:${startOn}:${endOn}:${demoPreview}`
  const requestId = useRef(0)
  const [state, setState] = useState<{ scopeKey: string; loading: boolean; error: boolean; summary: DashboardProductRevenueSummary | null }>({ scopeKey: '', loading: true, error: false, summary: null })
  const current = state.scopeKey === scopeKey ? state : { loading: true, error: false, summary: null }

  const load = useCallback(async (silent = false) => {
    const currentRequestId = ++requestId.current
    try {
      if (demoPreview) {
        await Promise.resolve()
        if (currentRequestId === requestId.current) setState({ scopeKey, loading: false, error: false, summary: createDemoProductRevenueSummary() })
        return
      }
      const client = supabaseClient
      if (!client) throw new Error('Supabase is not configured.')
      const summary = await loadDashboardProductRevenue(startOn, dayCountBetween(startOn, endOn), async (chunkStart, chunkEnd) => {
        const { data, error } = await client.rpc('get_dashboard_product_revenue', {
          p_business_id: businessId,
          p_start_on: chunkStart,
          p_end_on: chunkEnd,
        })
        return { data, error }
      })
      if (currentRequestId === requestId.current) setState({ scopeKey, loading: false, error: false, summary })
    } catch {
      if (!silent && currentRequestId === requestId.current) setState({ scopeKey, loading: false, error: true, summary: null })
    }
  }, [businessId, demoPreview, endOn, scopeKey, startOn])
  useVisibleAutoRefresh(() => load(true))

  useEffect(() => {
    const scheduledRequestId = requestId.current
    queueMicrotask(() => {
      if (requestId.current === scheduledRequestId) void load()
    })
    return () => {
      requestId.current += 1
    }
  }, [load])

  const products = current.summary?.products ?? []
  const grossProducts = products.reduce((total, product) => total + product.grossCents, 0n)
  const discountsProducts = products.reduce((total, product) => total + product.discountCents, 0n)
  const costsComplete = products.every((product) => product.costCents !== null)
    && (current.summary?.missingCostLineCount ?? 0) === 0
    && (current.summary?.returnedOrderCount ?? 0) === 0
  const productCost = costsComplete ? products.reduce((total, product) => total + (product.costCents ?? 0n), 0n) : null
  const productNet = costsComplete ? products.reduce((total, product) => total + (product.netCents ?? 0n), 0n) : null

  return (
    <section className="surface-panel dashboard-product-revenue" aria-labelledby="dashboard-product-revenue-title">
      <header className="dashboard-product-revenue-heading">
        <div>
          <p className="eyebrow">DETALHAMENTO</p>
          <h2 id="dashboard-product-revenue-title">Faturamento por produto</h2>
          <p>{formatBusinessDate(startOn)} a {formatBusinessDate(endOn)}</p>
        </div>
        {current.summary && <span className="dashboard-product-order-count">{current.summary.orderCount} {current.summary.orderCount === 1 ? 'pedido concluído' : 'pedidos concluídos'}</span>}
      </header>

      {current.loading ? <p className="inline-state" aria-live="polite">Carregando vendas por produto…</p> : current.error ? (
        <div className="dashboard-product-revenue-state" role="alert">
          <p>Não foi possível carregar as vendas por produto.</p>
          <button className="text-button" onClick={() => void load()} type="button">Tentar novamente</button>
        </div>
      ) : current.summary && products.length === 0 ? (
        <p className="dashboard-product-revenue-state" role="status">Nenhuma venda concluída neste período.</p>
      ) : current.summary && <>
        {(current.summary.missingCostLineCount > 0 || current.summary.returnedOrderCount > 0) && <p className="dashboard-product-revenue-warning" role="status">
          {current.summary.missingCostLineCount > 0 ? `Falta informar o custo de ${current.summary.missingCostLineCount} item(ns). ` : ''}
          {current.summary.returnedOrderCount > 0 ? `${current.summary.returnedOrderCount} pedido(s) têm devolução sem ajuste financeiro. ` : ''}
          O custo ou faturamento líquido afetado aparece como indisponível.
        </p>}
        <div className="dashboard-trend-table-wrap dashboard-product-table-wrap" role="region" aria-label="Faturamento detalhado por produto" tabIndex={0}>
          <table className="dashboard-trend-table dashboard-product-table">
            <caption>Desconto proporcional; combo usa o custo próprio cadastrado.</caption>
            <thead><tr><th scope="col">Produto</th><th scope="col">Quantidade</th><th scope="col">Faturamento bruto</th><th scope="col">Desconto</th><th scope="col">Custo</th><th scope="col">Faturamento líquido</th></tr></thead>
            <tbody>{products.map((product) => <tr key={product.productId}>
              <th scope="row">{product.productName}{product.missingCostLineCount > 0 && <small className="dashboard-product-row-note">Custo pendente</small>}{product.returnPendingCount > 0 && <small className="dashboard-product-row-note">Devolução a conferir</small>}</th>
              <td>{formatQuantityMilli(product.quantityMilli, product.inventoryUnit)}</td>
              <td>{formatBRLExact(product.grossCents)}</td>
              <td>{formatBRLExact(product.discountCents)}</td>
              <td>{product.costCents === null ? 'A conferir' : formatBRLExact(product.costCents)}</td>
              <td>{product.netCents === null ? 'A conferir' : formatBRLExact(product.netCents)}</td>
            </tr>)}</tbody>
            <tfoot><tr><th scope="row">Total dos produtos</th><td>—</td><td>{formatBRLExact(grossProducts)}</td><td>{formatBRLExact(discountsProducts)}</td><td>{productCost === null ? 'A conferir' : formatBRLExact(productCost)}</td><td>{productNet === null ? 'A conferir' : formatBRLExact(productNet)}</td></tr></tfoot>
          </table>
        </div>
        <p className="dashboard-product-scroll-hint">No celular, deslize para ver as demais colunas.</p>
        <dl className="dashboard-product-fee-summary">
          <div><dt>Taxa de entrega cobrada</dt><dd>{formatBRLExact(current.summary.deliveryFeeGrossCents)}</dd></div>
          <div><dt>Desconto aplicado à taxa</dt><dd>{formatBRLExact(current.summary.deliveryFeeDiscountCents)}</dd></div>
          <div><dt>Vendas após descontos, incluindo entrega</dt><dd>{formatBRLExact(current.summary.netSalesCents)}</dd></div>
          <div><dt>Faturamento líquido total</dt><dd>{current.summary.netBillingCents === null ? 'A conferir' : formatBRLExact(current.summary.netBillingCents)}</dd></div>
        </dl>
      </>}
    </section>
  )
}
