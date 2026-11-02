export const CUSTOMER_IMPORT_FIELDS = ['name', 'phone', 'whatsapp_phone', 'delivery_address', 'notes']

const FIELD_LABELS = {
  name: 'Nome',
  phone: 'Telefone',
  whatsapp_phone: 'WhatsApp',
  delivery_address: 'Endereço',
  notes: 'Observações',
}

const HEADER_ALIASES = {
  name: ['nome', 'name', 'cliente', 'customer', 'nome completo', 'nome do cliente'],
  phone: ['telefone', 'tel', 'fone', 'celular', 'phone', 'mobile'],
  whatsapp_phone: ['whatsapp', 'whats app', 'zap', 'numero whatsapp'],
  delivery_address: ['endereco', 'endereco de entrega', 'address', 'rua', 'delivery address'],
  notes: ['observacao', 'observacoes', 'obs', 'nota', 'notes', 'comentario'],
}

export function normalizeImportText(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('pt-BR')
}

export function normalizeImportPhone(value, defaultCallingCode = '55', numbersIncludeCode = false) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  const callingCode = String(defaultCallingCode).replace(/\D/g, '')
  if (!raw.startsWith('+') && !raw.startsWith('00') && !numbersIncludeCode && !/^[1-9]\d{0,2}$/.test(callingCode)) return null
  const internationalDigits = raw.startsWith('+') ? digits : raw.startsWith('00') ? digits.slice(2) : numbersIncludeCode ? digits : `${callingCode}${digits}`
  return /^[1-9]\d{7,14}$/.test(internationalDigits) ? `+${internationalDigits}` : null
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? ''
  let quoted = false
  const counts = new Map([[';', 0], [',', 0], ['\t', 0]])
  for (let i = 0; i < firstLine.length; i += 1) {
    const char = firstLine[i]
    if (char === '"' && firstLine[i + 1] === '"' && quoted) {
      i += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (!quoted && counts.has(char)) {
      counts.set(char, counts.get(char) + 1)
    }
  }
  return [...counts].sort((left, right) => right[1] - left[1])[0][0]
}

export function parseCustomerCsv(input, { maxRows = 2000 } = {}) {
  const text = String(input ?? '').replace(/^\uFEFF/, '')
  const delimiter = detectDelimiter(text)
  const records = []
  let row = []
  let field = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field.length === 0) {
      quoted = true
    } else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(field)
      if (row.some((value) => value.trim() !== '')) records.push(row)
      row = []
      field = ''
      if (records.length > maxRows + 1) throw new Error(`O arquivo ultrapassa o limite de ${maxRows} clientes.`)
    } else {
      field += char
    }
  }

  if (quoted) throw new Error('O CSV tem aspas sem fechamento. Corrija o arquivo e tente novamente.')
  row.push(field)
  if (row.some((value) => value.trim() !== '')) records.push(row)
  if (records.length < 2) throw new Error('O arquivo precisa ter cabeçalho e pelo menos um cliente.')
  if (records.length - 1 > maxRows) throw new Error(`O arquivo ultrapassa o limite de ${maxRows} clientes.`)

  const headers = records[0].map((value, index) => value.trim() || `Coluna ${index + 1}`)
  const rows = records.slice(1).map((values, index) => ({ rowNumber: index + 2, values }))
  return { headers, rows, delimiter }
}

export function suggestCustomerColumnMapping(headers) {
  const normalizedHeaders = headers.map(normalizeImportText)
  return Object.fromEntries(CUSTOMER_IMPORT_FIELDS.map((field) => {
    const index = normalizedHeaders.findIndex((header) => HEADER_ALIASES[field].includes(header))
    return [field, index < 0 ? null : index]
  }))
}

function mappedValue(row, columnIndex) {
  if (columnIndex === null || columnIndex === undefined) return ''
  return String(row.values[columnIndex] ?? '').trim()
}

export function validateCustomerImportRows(rows, mapping, options = {}) {
  const {
    defaultCallingCode = '55',
    numbersIncludeCode = false,
    existingCustomers = [],
  } = options
  const priorPhones = new Map()
  const priorNames = new Map()
  for (const customer of existingCustomers) {
    const nameKey = normalizeImportText(customer.name)
    if (nameKey) priorNames.set(nameKey, customer.name)
    for (const value of [customer.phone, customer.whatsapp_phone]) {
      const phone = normalizeImportPhone(value, defaultCallingCode, numbersIncludeCode)
      if (phone) priorPhones.set(phone, customer.name)
    }
  }

  const importPhones = new Map()
  const importNames = new Map()
  return rows.map((row) => {
    const name = mappedValue(row, mapping.name)
    const phoneInput = mappedValue(row, mapping.phone)
    const whatsappInput = mappedValue(row, mapping.whatsapp_phone)
    const address = mappedValue(row, mapping.delivery_address)
    const notes = mappedValue(row, mapping.notes)
    const phone = normalizeImportPhone(phoneInput, defaultCallingCode, numbersIncludeCode)
    const whatsappPhone = normalizeImportPhone(whatsappInput, defaultCallingCode, numbersIncludeCode)
    const errors = []
    const duplicateMatches = []
    const nameKey = normalizeImportText(name)

    if (!name) errors.push('Nome não informado.')
    else if (name.length > 160) errors.push('Nome ultrapassa 160 caracteres.')
    if (phoneInput && !phone) errors.push('Telefone precisa ter de 8 a 15 dígitos, incluindo o DDI.')
    if (whatsappInput && !whatsappPhone) errors.push('WhatsApp precisa ter de 8 a 15 dígitos, incluindo o DDI.')
    if (!numbersIncludeCode && !/^[1-9]\d{0,2}$/.test(String(defaultCallingCode).replace(/\D/g, ''))
      && [phoneInput, whatsappInput].some((value) => value && !value.trim().startsWith('+') && !value.trim().startsWith('00'))) {
      errors.push('Informe um DDI de 1 a 3 dígitos para telefones sem prefixo internacional.')
    }
    if (address.length > 1000) errors.push('Endereço ultrapassa 1.000 caracteres.')
    if (notes.length > 4000) errors.push('Observações ultrapassam 4.000 caracteres.')

    if (!errors.length) {
      for (const candidate of [phone, whatsappPhone].filter(Boolean)) {
        const match = priorPhones.get(candidate) ?? importPhones.get(candidate)
        if (match) duplicateMatches.push(`Telefone já associado a ${match}.`)
      }
      const nameMatch = priorNames.get(nameKey) ?? importNames.get(nameKey)
      if (nameMatch && !duplicateMatches.some((message) => message.includes(nameMatch))) {
        duplicateMatches.push(`Nome igual após normalização ao cadastro de ${nameMatch}. Confira se é a mesma pessoa.`)
      }
      if (phone) importPhones.set(phone, name)
      if (whatsappPhone) importPhones.set(whatsappPhone, name)
      if (nameKey) importNames.set(nameKey, name)
    }

    return {
      rowNumber: row.rowNumber,
      values: { name, phone, whatsapp_phone: whatsappPhone, delivery_address: address, notes },
      errors,
      duplicateMatches: [...new Set(duplicateMatches)],
      includeDuplicate: false,
    }
  })
}

export function importableCustomerRows(previewRows) {
  return previewRows.filter((row) => row.errors.length === 0 && (row.duplicateMatches.length === 0 || row.includeDuplicate))
    .map((row) => ({ ...row.values }))
}

export function customerImportFieldLabels() {
  return { ...FIELD_LABELS }
}
