const MAX_CONTENT_CHARACTERS = 5 * 1024 * 1024
const MAX_TRANSACTIONS = 1000
const MAX_AMOUNT_CENTS = 9_223_372_036_854_775_807n

export type OfxStatementRow = {
  transactionDate: string
  description: string
  counterpartyName: string | null
  amountCents: string
  externalTransactionId: string
}

export type OfxStatement = {
  accountLastFour: string
  currency: 'BRL'
  rows: OfxStatementRow[]
  duplicateRowsInFile: number
}

type RawStatementRow = {
  transactionDate: string
  amountCents: string
  fitid: string
  name: string | null
  memo: string | null
  transactionType: string | null
}

function fail(message: string): never {
  throw new Error(message)
}

function tidyText(value: string, label: string, maxLength: number, required = false) {
  const normalized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC')

  if (required && !normalized) fail(`O campo ${label} está vazio no extrato.`)
  if (normalized.length > maxLength) fail(`O campo ${label} excede o limite aceito.`)
  return normalized
}

function optionalText(value: string | null, label: string, maxLength: number) {
  if (value === null || !value.trim()) return null
  return tidyText(value, label, maxLength)
}

function decodeSgmlEntities(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    const lowered = code.toLowerCase()
    if (lowered === 'amp') return '&'
    if (lowered === 'lt') return '<'
    if (lowered === 'gt') return '>'
    if (lowered === 'quot') return '"'
    if (lowered === 'apos') return "'"
    const numeric = lowered.startsWith('#x')
      ? Number.parseInt(lowered.slice(2), 16)
      : Number.parseInt(lowered.slice(1), 10)
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0x10ffff || (numeric >= 0xd800 && numeric <= 0xdfff)) return entity
    return String.fromCodePoint(numeric)
  })
}

function findSgmlBlocks(source: string, tag: string, boundaryTags: string[] = []): string[] {
  const openTag = new RegExp(`<\\s*${tag}\\b[^>]*>`, 'gi')
  const closeTag = new RegExp(`<\\s*\\/\\s*${tag}\\s*>`, 'gi')
  const nextOpenTag = new RegExp(`<\\s*${tag}\\b[^>]*>`, 'gi')
  const boundaryPatterns = boundaryTags.map((boundary) => new RegExp(`<\\s*\\/?\\s*${boundary}\\b[^>]*>`, 'gi'))
  const blocks: string[] = []

  for (const match of source.matchAll(openTag)) {
    const contentStart = match.index + match[0].length
    let end = source.length
    let closeIndex = Number.POSITIVE_INFINITY
    closeTag.lastIndex = contentStart
    const closeMatch = closeTag.exec(source)
    if (closeMatch) closeIndex = closeMatch.index

    let nextOpenIndex = Number.POSITIVE_INFINITY
    nextOpenTag.lastIndex = contentStart
    const nextOpenMatch = nextOpenTag.exec(source)
    if (nextOpenMatch) nextOpenIndex = nextOpenMatch.index

    let boundaryIndex = Number.POSITIVE_INFINITY
    for (const pattern of boundaryPatterns) {
      pattern.lastIndex = contentStart
      const boundaryMatch = pattern.exec(source)
      if (boundaryMatch) boundaryIndex = Math.min(boundaryIndex, boundaryMatch.index)
    }

    end = Math.min(closeIndex, nextOpenIndex, boundaryIndex, source.length)
    blocks.push(source.slice(contentStart, end))
  }

  return blocks
}

function getSgmlValues(source: string, tag: string): string[] {
  const openTag = new RegExp(`<\\s*${tag}\\b[^>]*>`, 'gi')
  const closeTag = new RegExp(`<\\s*\\/\\s*${tag}\\s*>`, 'gi')
  const anyTag = /<\s*\/?\s*[A-Za-z][A-Za-z0-9_.:-]*\b[^>]*>/g
  const values: string[] = []

  for (const match of source.matchAll(openTag)) {
    const start = match.index + match[0].length
    closeTag.lastIndex = start
    const closeMatch = closeTag.exec(source)
    anyTag.lastIndex = start
    const nextTagMatch = anyTag.exec(source)
    const closeIndex = closeMatch?.index ?? Number.POSITIVE_INFINITY
    const nextTagIndex = nextTagMatch?.index ?? Number.POSITIVE_INFINITY
    const end = Math.min(closeIndex, nextTagIndex, source.length)
    values.push(decodeSgmlEntities(source.slice(start, end)).trim())
  }

  return values
}

function oneSgmlValue(source: string, tag: string, label: string, required?: true): string
function oneSgmlValue(source: string, tag: string, label: string, required: false): string | null
function oneSgmlValue(source: string, tag: string, label: string, required = true): string | null {
  const values = getSgmlValues(source, tag)
  if (values.length > 1) fail(`O extrato tem mais de um campo ${label} na mesma seção.`)
  if (values.length === 0) {
    if (required) fail(`O extrato não contém o campo ${label}.`)
    return null
  }
  return values[0] ?? ''
}

function getXmlElements(parent: Element, tag: string) {
  return Array.from(parent.getElementsByTagName(tag))
}

function oneXmlValue(parent: Element, tag: string, label: string, required?: true): string
function oneXmlValue(parent: Element, tag: string, label: string, required: false): string | null
function oneXmlValue(parent: Element, tag: string, label: string, required = true): string | null {
  const elements = getXmlElements(parent, tag)
  if (elements.length > 1) fail(`O extrato tem mais de um campo ${label} na mesma seção.`)
  if (elements.length === 0) {
    if (required) fail(`O extrato não contém o campo ${label}.`)
    return null
  }
  return elements[0]?.textContent?.trim() ?? ''
}

function accountSuffix(accountId: string | null) {
  const digits = (accountId ?? '').replace(/\D/g, '')
  if (digits.length < 4) fail('Não foi possível confirmar os quatro últimos dígitos da conta no extrato.')
  return digits.slice(-4)
}

function parseTransactionDate(value: string) {
  const raw = value.trim()
  const match = /^(\d{4})(\d{2})(\d{2})(?:\d{6}(?:\.\d+)?(?:\[[^\]]+\])?)?$/.exec(raw)
  if (!match) fail('O extrato contém uma data de lançamento inválida.')

  const [, year, month, day] = match
  const isoDate = `${year}-${month}-${day}`
  const date = new Date(`${isoDate}T00:00:00.000Z`)
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== isoDate) {
    fail('O extrato contém uma data de lançamento inválida.')
  }

  const currentParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const currentDate = `${currentParts.find((part) => part.type === 'year')?.value}-${currentParts.find((part) => part.type === 'month')?.value}-${currentParts.find((part) => part.type === 'day')?.value}`
  if (isoDate > currentDate) fail('O extrato contém um lançamento com data futura.')
  return isoDate
}

function parseAmountCents(value: string) {
  if (value.trim().length > 40) fail('O extrato contém um valor acima do limite aceito.')
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) fail('O extrato contém um valor inválido; são aceitos valores com até duas casas decimais.')

  const [, sign, whole, fraction = ''] = match
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0')
  const signedCents = sign === '-' ? -cents : cents
  if (signedCents === 0n) fail('O extrato contém um movimento sem valor.')
  if (signedCents > MAX_AMOUNT_CENTS || signedCents < -MAX_AMOUNT_CENTS) {
    fail('O extrato contém um valor acima do limite aceito.')
  }
  return signedCents.toString()
}

function parseRawSgmlTransaction(block: string): RawStatementRow {
  const transactionDate = oneSgmlValue(block, 'DTPOSTED', 'DTPOSTED')
  const amount = oneSgmlValue(block, 'TRNAMT', 'TRNAMT')
  const fitid = oneSgmlValue(block, 'FITID', 'FITID')
  const name = oneSgmlValue(block, 'NAME', 'NAME', false)
  const memo = oneSgmlValue(block, 'MEMO', 'MEMO', false)
  const transactionType = oneSgmlValue(block, 'TRNTYPE', 'TRNTYPE', false)

  return {
    transactionDate: parseTransactionDate(transactionDate),
    amountCents: parseAmountCents(amount),
    fitid: tidyText(fitid, 'FITID', 200, true),
    name: optionalText(name, 'NAME', 160),
    memo: optionalText(memo, 'MEMO', 200),
    transactionType: optionalText(transactionType, 'TRNTYPE', 40),
  }
}

function parseRawXmlTransaction(element: Element): RawStatementRow {
  const transactionDate = oneXmlValue(element, 'DTPOSTED', 'DTPOSTED')
  const amount = oneXmlValue(element, 'TRNAMT', 'TRNAMT')
  const fitid = oneXmlValue(element, 'FITID', 'FITID')
  const name = oneXmlValue(element, 'NAME', 'NAME', false)
  const memo = oneXmlValue(element, 'MEMO', 'MEMO', false)
  const transactionType = oneXmlValue(element, 'TRNTYPE', 'TRNTYPE', false)

  return {
    transactionDate: parseTransactionDate(transactionDate),
    amountCents: parseAmountCents(amount),
    fitid: tidyText(fitid, 'FITID', 200, true),
    name: optionalText(name, 'NAME', 160),
    memo: optionalText(memo, 'MEMO', 200),
    transactionType: optionalText(transactionType, 'TRNTYPE', 40),
  }
}

function getDescription(row: RawStatementRow) {
  return tidyText(row.memo ?? row.name ?? row.transactionType ?? 'Movimento bancário', 'descrição', 200, true)
}

function finalizeStatement(accountId: string | null, currency: string | null, rawRows: RawStatementRow[]): OfxStatement {
  if ((currency ?? '').toUpperCase() !== 'BRL') {
    fail(`A moeda do extrato é ${currency || 'desconhecida'}. Este importador aceita somente BRL.`)
  }
  if (rawRows.length === 0) fail('O extrato não tem lançamentos bancários para importar.')
  if (rawRows.length > MAX_TRANSACTIONS) fail(`O extrato excede o limite de ${MAX_TRANSACTIONS} lançamentos por arquivo.`)

  const rows: OfxStatementRow[] = []
  const seenFitids = new Set<string>()
  let duplicateRowsInFile = 0

  for (const row of rawRows) {
    if (seenFitids.has(row.fitid)) {
      duplicateRowsInFile += 1
      continue
    }
    seenFitids.add(row.fitid)
    rows.push({
      transactionDate: row.transactionDate,
      description: getDescription(row),
      counterpartyName: row.name,
      amountCents: row.amountCents,
      externalTransactionId: row.fitid,
    })
  }

  return {
    accountLastFour: accountSuffix(accountId),
    currency: 'BRL',
    rows,
    duplicateRowsInFile,
  }
}

function parseSgmlStatement(body: string): OfxStatement {
  const statements = findSgmlBlocks(body, 'STMTRS', ['BANKMSGSRSV1', 'OFX'])
  if (statements.length !== 1) fail('O arquivo precisa conter exatamente um extrato de conta bancária.')
  const statement = statements[0]

  const accounts = findSgmlBlocks(statement, 'BANKACCTFROM', ['BANKTRANLIST', 'STMTRS', 'OFX'])
  const transactionLists = findSgmlBlocks(statement, 'BANKTRANLIST', ['LEDGERBAL', 'AVAILBAL', 'STMTRS', 'OFX'])
  if (accounts.length !== 1) fail('O extrato precisa identificar exatamente uma conta bancária.')
  if (transactionLists.length !== 1) fail('O extrato precisa conter exatamente uma lista de lançamentos bancários.')

  const accountId = oneSgmlValue(accounts[0], 'ACCTID', 'ACCTID')
  const currency = oneSgmlValue(statement, 'CURDEF', 'CURDEF')
  const transactionBlocks = findSgmlBlocks(transactionLists[0], 'STMTTRN', ['BANKTRANLIST', 'LEDGERBAL', 'AVAILBAL'])
  if (transactionBlocks.length > MAX_TRANSACTIONS) fail(`O extrato excede o limite de ${MAX_TRANSACTIONS} lançamentos por arquivo.`)
  const rawRows = transactionBlocks.map(parseRawSgmlTransaction)
  return finalizeStatement(accountId, currency, rawRows)
}

function parseXmlStatement(body: string): OfxStatement {
  if (/<!DOCTYPE|<!ENTITY/i.test(body)) fail('O extrato XML contém declarações não aceitas.')
  const document = new DOMParser().parseFromString(body, 'application/xml')
  if (document.getElementsByTagName('parsererror').length > 0 || document.documentElement?.tagName.toUpperCase() !== 'OFX') {
    fail('O arquivo OFX XML está malformado.')
  }

  const statements = getXmlElements(document.documentElement, 'STMTRS')
  if (statements.length !== 1) fail('O arquivo precisa conter exatamente um extrato de conta bancária.')
  const statement = statements[0]
  const accounts = getXmlElements(statement, 'BANKACCTFROM')
  const transactionLists = getXmlElements(statement, 'BANKTRANLIST')
  if (accounts.length !== 1) fail('O extrato precisa identificar exatamente uma conta bancária.')
  if (transactionLists.length !== 1) fail('O extrato precisa conter exatamente uma lista de lançamentos bancários.')

  const accountId = oneXmlValue(accounts[0], 'ACCTID', 'ACCTID')
  const currency = oneXmlValue(statement, 'CURDEF', 'CURDEF')
  const transactionElements = getXmlElements(transactionLists[0], 'STMTTRN')
  if (transactionElements.length > MAX_TRANSACTIONS) fail(`O extrato excede o limite de ${MAX_TRANSACTIONS} lançamentos por arquivo.`)
  const rawRows = transactionElements.map(parseRawXmlTransaction)
  return finalizeStatement(accountId, currency, rawRows)
}

export function parseOfxStatement(contents: string): OfxStatement {
  if (contents.length === 0 || contents.length > MAX_CONTENT_CHARACTERS) {
    fail('O arquivo de extrato está vazio ou excede o limite de 5 MiB.')
  }

  const input = contents.replace(/^\uFEFF/, '')
  const headerEnd = input.search(/<\s*OFX\b/i)
  if (headerEnd < 0) fail('Não encontrei o início de um arquivo OFX.')

  const header = input.slice(0, headerEnd)
  const versionValue = /(?:^|\r?\n)VERSION:(\d{3})(?:\r?\n|$)/i.exec(header)?.[1]
  const version = versionValue ? Number(versionValue) : null
  const body = input.slice(headerEnd)
  if (version !== null && version >= 200) return parseXmlStatement(body)
  if (version !== null && version < 200) return parseSgmlStatement(body.replace(/<!--[^]*?-->/g, ''))
  if (/^\s*<\?xml\b/i.test(input.slice(0, headerEnd + 1))) return parseXmlStatement(input.slice(input.search(/<\?xml\b/i)))
  return parseSgmlStatement(body.replace(/<!--[^]*?-->/g, ''))
}
