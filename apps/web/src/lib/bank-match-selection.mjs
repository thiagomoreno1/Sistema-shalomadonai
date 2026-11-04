export function canonicalMatchItems(items) {
  return items.map(({ kind, id }) => ({ kind, id: id.toLowerCase() }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
}

export function matchSelectionSummary(movementAmount, items) {
  const movement = BigInt(movementAmount)
  const target = movement < 0n ? -movement : movement
  const total = items.reduce((sum, item) => sum + BigInt(item.amount_cents), 0n)
  const unique = new Set(items.map(({ id }) => id.toLowerCase())).size === items.length
  const eligible = items.every((item) => BigInt(item.amount_cents) > 0n && item.kind === (movement > 0n ? 'receipt' : 'outflow'))
  return {
    total,
    difference: target - total,
    canConfirm: items.length > 0 && items.length <= 50 && unique && eligible && total === target,
  }
}

export function updateMatchSelection(previous, items, newRequestId) {
  const canonical = canonicalMatchItems(items)
  if (JSON.stringify(previous.items) === JSON.stringify(canonical)) return previous
  return { items: canonical, requestId: newRequestId() }
}

export function isMissingGroupingSchema(error) {
  return ['42703', '42P01', '42883', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error?.code)
}

export async function loadVoidedOutflows(ids, loadChunk) {
  const rows = []
  // One void per business/outflow: 100 IDs stay below the API row cap and bound the URL.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const { data, error } = await loadChunk(ids.slice(offset, offset + 100))
    if (error) return { data: null, error }
    rows.push(...(data ?? []))
  }
  return { data: rows, error: null }
}
