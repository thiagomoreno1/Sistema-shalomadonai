export type MatchItem = { kind: 'receipt' | 'outflow'; id: string }
export type MatchSelection = { items: MatchItem[]; requestId: string }
export function canonicalMatchItems(items: MatchItem[]): MatchItem[]
export function matchSelectionSummary(movementAmount: string | number, items: (MatchItem & { amount_cents: string | number })[]): { total: bigint; difference: bigint; canConfirm: boolean }
export function updateMatchSelection(previous: MatchSelection, items: MatchItem[], newRequestId: () => string): MatchSelection
export function isMissingGroupingSchema(error: unknown): boolean
export function loadVoidedOutflows(ids: string[], loadChunk: (ids: string[]) => PromiseLike<{ data: { outflow_id: string }[] | null; error: unknown }>): Promise<{ data: { outflow_id: string }[] | null; error: unknown }>
export function loadIdBatches<T>(ids: string[], loadChunk: (ids: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<{ data: T[] | null; error: unknown }>
