import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { formatBRLExact } from '../lib/formatters'
import { parseOfxStatement, type OfxStatement } from '../lib/ofxStatement'
import { supabaseClient } from '../lib/supabase'

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_TRANSACTIONS = 1000

type BankAccount = {
  id: string
  institution_name: string
  account_label: string
  account_last_four: string | null
}

type ImportResult = {
  batchId: string
  importedCount: number
  duplicateCount: number
}

type Props = {
  businessId: string
  accounts: BankAccount[]
  disabled?: boolean
  onImported: () => Promise<void>
}

function decodeOfxFile(contents: ArrayBuffer) {
  const bytes = new Uint8Array(contents)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, Math.min(bytes.length, 2048)))
  const charset = header.match(/^CHARSET\s*:\s*([^\r\n]+)/im)?.[1]?.trim().toLowerCase()
  let encoding = 'utf-8'

  if (charset && /^(1252|windows-1252|cp1252)$/.test(charset)) encoding = 'windows-1252'
  else if (charset && /^(65001|utf-8|utf8)$/.test(charset)) encoding = 'utf-8'
  else if (charset && /^(ascii|usascii|us-ascii)$/.test(charset)) encoding = 'windows-1252'
  else if (charset) throw new Error('A codificação deste arquivo não é compatível. Exporte em UTF-8 ou Windows-1252.')

  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Não foi possível ler o arquivo com a codificação declarada. Exporte novamente em UTF-8 ou Windows-1252.')
  }
}

function dateRange(statement: OfxStatement) {
  const dates = statement.rows.map((row) => row.transactionDate).sort()
  return { first: dates[0], last: dates[dates.length - 1] }
}

async function findExistingFitids(businessId: string, accountId: string, statement: OfxStatement) {
  const client = supabaseClient
  if (!client) throw new Error('A conexão da empresa não está disponível.')

  const { first, last } = dateRange(statement)
  const wanted = new Set(statement.rows.map((row) => row.externalTransactionId))
  const found = new Set<string>()
  let start = 0

  for (;;) {
    const { data, error } = await client.from('bank_transactions')
      .select('external_transaction_id')
      .eq('business_id', businessId)
      .eq('bank_account_id', accountId)
      .eq('source', 'statement_file')
      .gte('transaction_date', first)
      .lte('transaction_date', last)
      .not('external_transaction_id', 'is', null)
      .order('id', { ascending: true })
      .range(start, start + 999)

    if (error) throw error
    const rows = data ?? []
    for (const row of rows) {
      const fitid = row.external_transaction_id
      if (typeof fitid === 'string' && wanted.has(fitid)) found.add(fitid)
    }
    if (rows.length < 1000) return found
    start += rows.length
  }
}

function rpcResult(value: unknown): ImportResult {
  const row = Array.isArray(value) ? value[0] : value
  if (!row || typeof row !== 'object') throw new Error('O retorno do lote não pôde ser confirmado.')
  const result = row as Record<string, unknown>
  const batchId = result.batch_id
  const importedCount = Number(result.imported_count)
  const duplicateCount = Number(result.duplicate_count)
  if (typeof batchId !== 'string' || !Number.isSafeInteger(importedCount) || importedCount < 0 || !Number.isSafeInteger(duplicateCount) || duplicateCount < 0) {
    throw new Error('O retorno do lote não pôde ser confirmado.')
  }
  return { batchId, importedCount, duplicateCount }
}

function rpcErrorCode(value: unknown) {
  if (!value || typeof value !== 'object' || !('code' in value) || typeof value.code !== 'string') return null
  return value.code
}

function hasAmbiguousRpcOutcome(code: string) {
  return code.startsWith('08') || code === 'PGRSTX00'
}

function definiteRpcErrorMessage(code: string) {
  if (code === 'PGRST202' || code === '42883') {
    return 'A importação ainda não foi ativada neste sistema. Nenhum movimento foi gravado. A prévia foi mantida; peça ao suporte para habilitar o recurso antes de tentar novamente.'
  }
  if (code === '42501') {
    return 'O Supabase recusou o acesso a esta conta. Confira se está conectado como responsável pela empresa.'
  }
  return 'O Supabase recusou esta importação. Confira a conta e os dados do extrato; nenhuma alteração foi confirmada. A prévia foi mantida para correção ou nova tentativa.'
}

export function BankStatementImportCard({ businessId, accounts, disabled = false, onImported }: Props) {
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [fileName, setFileName] = useState('')
  const [statement, setStatement] = useState<OfxStatement | null>(null)
  const [existingFitids, setExistingFitids] = useState<Set<string>>(new Set())
  const [duplicateLookupError, setDuplicateLookupError] = useState<string | null>(null)
  const [checkingDuplicates, setCheckingDuplicates] = useState(false)
  const [lookupRetry, setLookupRetry] = useState(0)
  const [confirmed, setConfirmed] = useState(false)
  const [showAllRows, setShowAllRows] = useState(false)
  const [reading, setReading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [discardConfirm, setDiscardConfirm] = useState(false)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const lookupSequenceRef = useRef(0)

  const selectedAccount = accounts.find((account) => account.id === selectedAccountId) ?? null
  const accountMismatch = Boolean(statement && selectedAccount?.account_last_four && selectedAccount.account_last_four !== statement.accountLastFour)
  const duplicateFitidCount = statement ? statement.rows.filter((row) => existingFitids.has(row.externalTransactionId)).length : 0
  const netCents = useMemo(() => statement?.rows.reduce((total, row) => total + BigInt(row.amountCents), 0n) ?? 0n, [statement])

  useEffect(() => {
    if (accounts.some((account) => account.id === selectedAccountId)) return
    setSelectedAccountId(accounts[0]?.id ?? '')
  }, [accounts, selectedAccountId])

  useEffect(() => {
    const sequence = ++lookupSequenceRef.current
    setExistingFitids(new Set())
    setDuplicateLookupError(null)
    setConfirmed(false)

    if (!statement || !selectedAccountId || accountMismatch) {
      setCheckingDuplicates(false)
      return
    }

    setCheckingDuplicates(true)
    void findExistingFitids(businessId, selectedAccountId, statement)
      .then((fitids) => {
        if (sequence === lookupSequenceRef.current) setExistingFitids(fitids)
      })
      .catch(() => {
        if (sequence === lookupSequenceRef.current) setDuplicateLookupError('Não foi possível verificar duplicidades já importadas. Tente novamente antes de confirmar.')
      })
      .finally(() => {
        if (sequence === lookupSequenceRef.current) setCheckingDuplicates(false)
      })

    return () => { lookupSequenceRef.current += 1 }
  }, [accountMismatch, businessId, lookupRetry, selectedAccountId, statement])

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    setError(null)
    setResult(null)
    setStatement(null)
    setExistingFitids(new Set())
    setConfirmed(false)
    setShowAllRows(false)
    setUncertain(false)
    setDiscardConfirm(false)
    setRequestId(crypto.randomUUID())
    setFileName('')
    if (!file) return

    const extension = file.name.split('.').pop()?.toLowerCase()
    if (extension !== 'ofx' && extension !== 'qfx') {
      setError('Selecione um arquivo .ofx ou .qfx.')
      event.target.value = ''
      return
    }
    if (file.size > MAX_FILE_BYTES) {
      setError('O arquivo deve ter no máximo 5 MiB.')
      event.target.value = ''
      return
    }

    setReading(true)
    try {
      const parsed = parseOfxStatement(decodeOfxFile(await file.arrayBuffer()))
      if (parsed.rows.length + parsed.duplicateRowsInFile > MAX_TRANSACTIONS) {
        throw new Error('O arquivo excede o limite de 1.000 movimentações.')
      }
      if (parsed.rows.length === 0) throw new Error('O arquivo não contém movimentações bancárias para importar.')
      setFileName(file.name)
      setStatement(parsed)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível interpretar o arquivo OFX.')
      event.target.value = ''
    } finally {
      setReading(false)
    }
  }

  async function importStatement() {
    const client = supabaseClient
    if (!client || !statement || !selectedAccount || !confirmed || accountMismatch || duplicateLookupError || checkingDuplicates) return

    setImporting(true)
    setError(null)
    try {
      let imported: ImportResult
      try {
        const { data, error: rpcError } = await client.rpc('import_bank_statement', {
          p_business_id: businessId,
          p_bank_account_id: selectedAccount.id,
          p_rows: statement.rows.map((row) => ({
            transaction_date: row.transactionDate,
            amount_cents: row.amountCents,
            description: row.description,
            counterparty_name: row.counterpartyName,
            external_transaction_id: row.externalTransactionId,
          })),
          p_duplicate_rows_in_file: statement.duplicateRowsInFile,
          p_request_id: requestId,
        })
        if (rpcError) {
          const code = rpcErrorCode(rpcError)
          if (code && !hasAmbiguousRpcOutcome(code)) {
            setUncertain(false)
            setDiscardConfirm(false)
            setError(definiteRpcErrorMessage(code))
            return
          }
          throw rpcError
        }
        imported = rpcResult(data)
      } catch {
        setUncertain(true)
        setError('Não foi possível confirmar o resultado. Tente novamente com o mesmo arquivo e conta; o mesmo identificador será usado para evitar duplicação.')
        return
      }

      setResult(imported)
      setUncertain(false)
      setDiscardConfirm(false)
      setStatement(null)
      setFileName('')
      setConfirmed(false)
      setRequestId(crypto.randomUUID())
      if (fileInputRef.current) fileInputRef.current.value = ''
      try {
        await onImported()
      } catch {
        setError('O lote foi importado, mas a lista não pôde ser atualizada agora. Atualize a conciliação para ver os movimentos.')
      }
    } finally {
      setImporting(false)
    }
  }

  return (
    <section className="surface-panel settings-panel bank-statement-import" aria-labelledby="bank-statement-import-title">
      <div className="section-heading">
        <div><p className="eyebrow">ARQUIVO DO BANCO</p><h2 id="bank-statement-import-title">Importar extrato OFX</h2></div>
        <span className="neutral-status">Prévia antes de gravar</span>
      </div>
      <p className="section-footnote">Selecione um arquivo OFX ou QFX para conferir os movimentos.</p>

      <div className="record-form-grid bank-import-fields">
        <label className="record-field"><span className="field-label">Conta de destino</span><select className="text-input" disabled={disabled || importing || uncertain || accounts.length === 0} onChange={(event) => { setSelectedAccountId(event.target.value); setRequestId(crypto.randomUUID()); setConfirmed(false); setResult(null); setError(null) }} value={selectedAccountId}><option value="">Selecione uma conta</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.institution_name} · {account.account_label}{account.account_last_four ? ` · final ${account.account_last_four}` : ''}</option>)}</select></label>
        <label className="record-field"><span className="field-label">Arquivo OFX/QFX</span><input ref={fileInputRef} accept=".ofx,.qfx,application/x-ofx,application/xml,text/xml" className="text-input bank-import-file" disabled={disabled || importing || reading || uncertain || accounts.length === 0} onChange={(event) => void handleFileChange(event)} type="file" /></label>
      </div>

      {accounts.length === 0 && <p className="inline-state">Cadastre uma conta bancária ativa para importar um extrato.</p>}
      {reading && <p className="inline-state" aria-live="polite">Lendo e conferindo o extrato no navegador…</p>}
      {fileName && statement && <p className="bank-import-file-name">Arquivo selecionado: <strong>{fileName}</strong></p>}
      {accountMismatch && <p className="form-message form-message-error" role="alert">O arquivo termina em {statement?.accountLastFour}, mas a conta selecionada termina em {selectedAccount?.account_last_four}. Escolha a conta correspondente.</p>}
      {statement && !accountMismatch && !selectedAccount?.account_last_four && <p className="form-message form-message-warning" role="status">A conta cadastrada não tem os últimos dígitos. Confira banco e conta antes de continuar.</p>}

      {statement && <div className="bank-import-preview" aria-live="polite">
        <div className="bank-import-preview-heading"><strong>Prévia</strong><span>{statement.rows.length + statement.duplicateRowsInFile} movimentações no arquivo</span></div>
        <dl className="bank-import-preview-grid">
          <div><dt>Conta no arquivo</dt><dd>final {statement.accountLastFour}</dd></div>
          <div><dt>Novos para conferir</dt><dd>{statement.rows.length}</dd></div>
          <div><dt>Repetidos no arquivo</dt><dd>{statement.duplicateRowsInFile}</dd></div>
          <div><dt>Já importados na faixa</dt><dd>{checkingDuplicates ? 'Verificando…' : duplicateFitidCount}</dd></div>
          <div><dt>Total líquido</dt><dd>{formatBRLExact(netCents)}</dd></div>
        </dl>
        <ul className="bank-import-preview-list" aria-label="Lançamentos da prévia">
          {statement.rows.slice(0, showAllRows ? undefined : 5).map((row) => <li key={row.externalTransactionId}><span><strong>{row.description}</strong><small>{row.transactionDate}{existingFitids.has(row.externalTransactionId) ? ' · já importado nesta faixa de datas' : ''}</small></span><strong>{formatBRLExact(row.amountCents)}</strong></li>)}
        </ul>
        {statement.rows.length > 5 && <button aria-expanded={showAllRows} className="text-button bank-import-show-all" onClick={() => setShowAllRows((value) => !value)} type="button">{showAllRows ? 'Mostrar somente os 5 primeiros' : `Mostrar todos os ${statement.rows.length} lançamentos`}</button>}
        <details className="bank-import-details"><summary>Como o sistema trata duplicados</summary><p>A prévia marca duplicados nas datas do arquivo. Na gravação, o sistema também compara o FITID em toda a conta.</p></details>
        {uncertain && <div className="bank-import-recovery"><p className="form-message form-message-warning" role="status">A resposta anterior não foi confirmada. Reenvie com a mesma conta e arquivo para consultar o mesmo lote.</p><button className="text-button" onClick={() => setDiscardConfirm(true)} type="button">Descartar esta tentativa</button>{discardConfirm && <div className="bank-import-discard" role="alert"><p>O lote pode ter sido registrado antes da falha. Se você importar este extrato de novo para a mesma conta, os FITIDs já registrados nessa conta serão ignorados.</p><div className="record-form-actions"><button className="button button-secondary" onClick={() => { setDiscardConfirm(false); setUncertain(false); setStatement(null); setFileName(''); setConfirmed(false); setRequestId(crypto.randomUUID()); setError(null); if (fileInputRef.current) fileInputRef.current.value = '' }} type="button">Confirmar descarte</button><button className="text-button" onClick={() => setDiscardConfirm(false)} type="button">Voltar</button></div></div>}</div>}
        <label className="bank-import-confirm"><input checked={confirmed} disabled={disabled || importing || uncertain || accountMismatch || checkingDuplicates || Boolean(duplicateLookupError)} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" /><span>Conferi a conta e a prévia. Autorizo registrar os movimentos normalizados nesta conciliação.</span></label>
        {duplicateLookupError && <div className="bank-import-duplicate-error" role="alert"><p className="form-message form-message-error">{duplicateLookupError}</p><button className="button button-secondary" disabled={checkingDuplicates} onClick={() => setLookupRetry((retry) => retry + 1)} type="button">Verificar duplicidades novamente</button></div>}
        <div className="record-form-actions"><button className="button button-primary" disabled={disabled || importing || !confirmed || checkingDuplicates || Boolean(duplicateLookupError) || accountMismatch || !selectedAccount} onClick={() => void importStatement()} type="button">{importing ? 'Importando…' : uncertain ? 'Tentar novamente' : 'Confirmar importação'}</button></div>
      </div>}

      {error && <p className="form-message form-message-error" role="alert">{error}</p>}
      {result && <p className="form-message form-message-success" role="status">Lote {result.batchId.slice(0, 8).toUpperCase()}: {result.importedCount} importados e {result.duplicateCount} duplicados ignorados.</p>}
      <details className="bank-import-details"><summary>Privacidade do arquivo</summary><p>O arquivo e o número completo da conta não são enviados nem armazenados. A deduplicação usa o FITID do extrato na conta selecionada.</p></details>
    </section>
  )
}
