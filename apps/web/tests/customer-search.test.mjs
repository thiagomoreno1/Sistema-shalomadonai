import assert from 'node:assert/strict'
import test from 'node:test'
import { searchCustomers, toInternationalPhone } from '../src/lib/customer-search.mjs'

const customers = [
  { id: '1', name: 'João Martins', phone: '+55 (71) 99999-1000', whatsapp_phone: null },
  { id: '2', name: 'Maria Costa', phone: null, whatsapp_phone: '+55 11 98888-2000' },
  { id: '3', name: 'João Santos', phone: '71999991003', whatsapp_phone: null },
]

test('searches customer names without case sensitivity', () => {
  assert.deepEqual(searchCustomers(customers, 'MARIA').map(({ id }) => id), ['2'])
})

test('matches phone numbers when the search omits punctuation and country prefix', () => {
  assert.deepEqual(searchCustomers(customers, '71999991000').map(({ id }) => id), ['1'])
})

test('includes WhatsApp numbers in phone search and limits suggestions', () => {
  assert.deepEqual(searchCustomers(customers, '98888', 1).map(({ id }) => id), ['2'])
})

test('shows only the first eight customers for an empty query', () => {
  const many = Array.from({ length: 10 }, (_, index) => ({ id: String(index), name: `Cliente ${index}` }))
  assert.equal(searchCustomers(many, '').length, 8)
})

test('adds the selected country calling code to a national number', () => {
  assert.equal(toInternationalPhone('55', '(71) 99999-1000'), '+5571999991000')
})

test('preserves a pasted international number instead of adding the selected country twice', () => {
  assert.equal(toInternationalPhone('55', '+44 20 7946 0958'), '+442079460958')
  assert.equal(toInternationalPhone('55', '0044 20 7946 0958'), '+442079460958')
})
