const routeLoaders: Record<string, () => Promise<unknown>> = {
  '/clientes': () => import('../pages/CustomersPage'),
  '/atendimento': () => import('../pages/FollowUpsPage'),
  '/whatsapp': () => import('../pages/WhatsAppInboxPage'),
  '/pedidos': () => import('../pages/OrdersPage'),
  '/catalogo': () => import('../pages/ProductsPage'),
  '/estoque': () => import('../pages/InventoryPage'),
  '/entregas': () => import('../pages/DeliveriesPage'),
  '/equipe': () => import('../pages/TeamPage'),
  '/financeiro': () => import('../pages/ReceivablesPage'),
  '/relatorios': () => import('../pages/ReportsPage'),
  '/configuracoes': () => import('../pages/SettingsPage'),
  '/mais': () => import('../pages/ModulePage'),
}

export function prefetchRoute(path: string) {
  const loader = routeLoaders[path]
  if (loader) void loader().catch(() => undefined)
}
