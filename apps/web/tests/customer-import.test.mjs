import test from 'node:test'
import assert from 'node:assert/strict'
import {
  importableCustomerRows,
  normalizeImportPhone,
  parseCustomerCsv,
  suggestCustomerColumnMapping,
  validateCustomerImportRows,
} from '../src/lib/customer-import.mjs'

test('parses quoted CSV fields and auto-detects Brazilian semicolon separators', () => {
  const parsed = parseCustomerCsv('Nome;Telefone;Observações\r\n"Ana Silva";11999990000;"Prefere, mensagem"')
  assert.equal(parsed.delimiter, ';')
  assert.deepEqual(parsed.headers, ['Nome', 'Telefone', 'Observações'])
  assert.equal(parsed.rows[0].values[2], 'Prefere, mensagem')
})

test('rejects unterminated quoted values and files above the row cap', () => {
  assert.throws(() => parseCustomerCsv('Nome,Telefone\n"Ana,11999990000'), /aspas sem fechamento/i)
  assert.throws(() => parseCustomerCsv('Nome\nAna\nBia', { maxRows: 1 }), /limite/i)
})

test('suggests columns and normalizes Brazilian numbers without asking the user to type country code', () => {
  const headers = ['Nome do cliente', 'Celular', 'WhatsApp', 'Endereço de entrega', 'Obs']
  assert.deepEqual(suggestCustomerColumnMapping(headers), {
    name: 0, phone: 1, whatsapp_phone: 2, delivery_address: 3, notes: 4,
  })
  assert.equal(normalizeImportPhone('(11) 99999-0000'), '+5511999990000')
  assert.equal(normalizeImportPhone('+351 912 345 678'), '+351912345678')
  assert.equal(normalizeImportPhone('+012345678'), null)
  assert.equal(normalizeImportPhone('11999990000', '000'), null)
})

test('validates field lengths, detects existing and in-file duplicates, and does not overwrite them', () => {
  const parsed = parseCustomerCsv('Nome;Telefone;WhatsApp;Endereço;Observações\nAna;11999990000;;Rua 1;ok\nBruno;11999990000;;;ok\n;11999991111;;;')
  const mapping = suggestCustomerColumnMapping(parsed.headers)
  const existingCustomers = [{ id: 'existing', name: 'Ana', phone: '+5511888887777', whatsapp_phone: null }]
  const preview = validateCustomerImportRows(parsed.rows, mapping, { existingCustomers })
  assert.equal(preview[0].duplicateMatches.length > 0, true) // matching name; phone remains distinct
  assert.match(preview[1].duplicateMatches.join(' '), /Telefone já associado/i)
  assert.match(preview[2].errors.join(' '), /Nome não informado/i)
  const selected = importableCustomerRows(preview)
  assert.equal(selected.length, 0)
  preview[0].includeDuplicate = true
  assert.deepEqual(importableCustomerRows(preview).map(({ name }) => name), ['Ana'])
  assert.equal(existingCustomers[0].name, 'Ana')
})

test('accepts only rows explicitly selected from duplicate warnings', () => {
  const parsed = parseCustomerCsv('Nome,Telefone\nPessoa,11999990000\nPessoa,11999990000')
  const preview = validateCustomerImportRows(parsed.rows, suggestCustomerColumnMapping(parsed.headers))
  assert.equal(importableCustomerRows(preview).length, 1)
  preview[1].includeDuplicate = true
  assert.equal(importableCustomerRows(preview).length, 2)
})
