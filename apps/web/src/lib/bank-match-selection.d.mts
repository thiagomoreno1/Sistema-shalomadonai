export type MatchItem = { kind: 'receipt' | 'outflow'; id: string }
export type MatchSelection = { items: MatchItem[]; requestId: string }
export function canonicalMatchItems(items: MatchItem[]): MatchItem[]
export function matchSelectionSummary(movementAmount: string | number, items: (MatchItem & { amount_cents: string | number })[]): { total: bigint; difference: bigint; canConfirm: boolean }
export function updateMatchSelection(previous: MatchSelection, items: MatchItem[], newRequestId: () => string): MatchSelection
export function isMissingGroupingSchema(error: unknown): boolean
