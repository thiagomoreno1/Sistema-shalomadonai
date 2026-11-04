import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalMatchItems, matchSelectionSummary, updateMatchSelection, isMissingGroupingSchema } from '../src/lib/bank-match-selection.mjs'

// Guards monetary rounding, permissive confirmation, duplicate payloads and unsafe retries.
test('totals cents beyond Number precision with BigInt', () => {
  const summary = matchSelectionSummary('9007199254740993', [
    { kind: 'receipt', id: 'a', amount_cents: '9007199254740992' },
    { kind: 'receipt', id: 'b', amount_cents: '1' },
  ])
  assert.equal(summary.total, 9007199254740993n)
  assert.equal(summary.difference, 0n)
  assert.equal(summary.canConfirm, true)
})

test('confirms only nonempty exact same-direction positive selections of at most 50', () => {
  const row = { kind: 'receipt', id: 'a', amount_cents: '100' }
  assert.equal(matchSelectionSummary('100', []).canConfirm, false)
  assert.equal(matchSelectionSummary('100', [row]).canConfirm, true)
  assert.equal(matchSelectionSummary('101', [row]).difference, 1n)
  assert.equal(matchSelectionSummary('101', [row]).canConfirm, false)
  assert.equal(matchSelectionSummary('99', [row]).difference, -1n)
  assert.equal(matchSelectionSummary('99', [row]).canConfirm, false)
  assert.equal(matchSelectionSummary('-100', [row]).canConfirm, false)
  assert.equal(matchSelectionSummary('-100', [{ ...row, kind: 'outflow' }]).canConfirm, true)
  assert.equal(matchSelectionSummary('0', [{ ...row, amount_cents: '0' }]).canConfirm, false)
  assert.equal(matchSelectionSummary('200', [row, row]).canConfirm, false)
  const many = Array.from({ length: 51 }, (_, i) => ({ ...row, id: String(i), amount_cents: '1' }))
  assert.equal(matchSelectionSummary('50', many.slice(0, 50)).canConfirm, true)
  assert.equal(matchSelectionSummary('51', many).canConfirm, false)
})

test('canonical payload sorts kind and lowercase ID, stripping display metadata', () => {
  assert.deepEqual(canonicalMatchItems([
    { kind: 'receipt', id: 'B', title: 'second', amount_cents: '20' },
    { kind: 'outflow', id: 'C' },
    { kind: 'receipt', id: 'a' },
  ]), [{ kind: 'outflow', id: 'c' }, { kind: 'receipt', id: 'a' }, { kind: 'receipt', id: 'b' }])
})

test('unchanged selection and retries keep UUID; every changed selection gets a fresh UUID', () => {
  const previous = { items: [{ kind: 'receipt', id: 'a' }, { kind: 'receipt', id: 'b' }], requestId: 'original' }
  let issued = 0
  const nextId = () => `new-${++issued}`
  const retry = updateMatchSelection(previous, [{ kind: 'receipt', id: 'B' }, { kind: 'receipt', id: 'a' }], nextId)
  assert.equal(retry, previous)
  assert.equal(issued, 0)
  const changed = updateMatchSelection(retry, [{ kind: 'receipt', id: 'a' }], nextId)
  assert.equal(changed.requestId, 'new-1')
  const restored = updateMatchSelection(changed, previous.items, nextId)
  assert.equal(restored.requestId, 'new-2')
})

test('only missing schema/function errors activate legacy mode', () => {
  for (const code of ['42703', '42P01', '42883', 'PGRST202', 'PGRST204', 'PGRST205']) {
    assert.equal(isMissingGroupingSchema({ code }), true)
  }
  for (const error of [{ code: '42501' }, { code: '23505' }, { message: 'network error' }, null]) {
    assert.equal(isMissingGroupingSchema(error), false)
  }
})
