import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CUSTOMER_IMPORT_FIELDS,
  customerImportFieldLabels,
  importableCustomerRows,
  parseCustomerCsv,
  suggestCustomerColumnMapping,
  validateCustomerImportRows,
} from '../lib/customer-import.mjs'
import './CustomerImport.css'

type ImportField = typeof CUSTOMER_IMPORT_FIELDS[number]
type CustomerImportRecord = {
  name: string
  phone: string | null
  whatsapp_phone: string | null
  delivery_address: string | null
  notes: string | null
}
type ExistingCustomer = { id: string; name: string; phone: string | null; whatsapp_phone: string | null }
type Props = {
  existingCustomers: ExistingCustomer[]
  onImport: (requestId: string, customers: CustomerImportRecord[]) => Promise<void>
  onClose: () => void
}

const labels = customerImportFieldLabels()
const maxFileBytes = 10 * 1024 * 1024

export function CustomerImport({ existingCustomers, onImport, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  const busyRef = useRef(false)
  const uncertainRef = useRef(false)
  const lastPayload = useRef<string | null>(null)
  const requestId = useRef('')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<{ rowNumber: number; values: string[] }[]>([])
  const [mapping, setMapping] = useState<Record<ImportField, number | null>>({ name: null, phone: null, whatsapp_phone: null, delivery_address: null, notes: null })
  const [callingCode, setCallingCode] = useState('55')
  const [numbersIncludeCode, setNumbersIncludeCode] = useState(false)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [importDone, setImportDone] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [allowDuplicates, setAllowDuplicates] = useState<Record<number, boolean>>({})
  useEffect(() => { closeRef.current = onClose }, [onClose])

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    const firstControl = dialogRef.current?.querySelector<HTMLElement>(focusableSelector)
    ;(firstControl ?? dialogRef.current)?.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (!busyRef.current && !uncertainRef.current) {
          event.preventDefault()
          closeRef.current()
        }
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const controls = [...dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector)]
      if (controls.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [])

  const preview = useMemo(() => validateCustomerImportRows(rows, mapping, {
    defaultCallingCode: callingCode,
    numbersIncludeCode,
    existingCustomers,
  }).map((row) => ({ ...row, includeDuplicate: Boolean(allowDuplicates[row.rowNumber]) })), [rows, mapping, callingCode, numbersIncludeCode, existingCustomers, allowDuplicates])
  const importable = useMemo(() => importableCustomerRows(preview), [preview])
  const invalidCount = preview.filter((row) => row.errors.length > 0).length
  const duplicateCount = preview.filter((row) => row.errors.length === 0 && row.duplicateMatches.length > 0 && !row.includeDuplicate).length

  async function selectFile(file?: File) {
    uncertainRef.current = false
    setError('')
    setImportDone(false)
    setUncertain(false)
    lastPayload.current = null
    requestId.current = ''
    if (!file) return
    if (file.size > maxFileBytes) {
      setRows([])
      setError('O CSV deve ter no máximo 10 MB.')
      return
    }
    if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') {
      setRows([])
      setError('Por enquanto, selecione um arquivo CSV. A leitura de Excel será adicionada depois.')
      return
    }
    try {
      const parsed = parseCustomerCsv(await file.text())
      setHeaders(parsed.headers)
      setRows(parsed.rows)
      setMapping(suggestCustomerColumnMapping(parsed.headers))
      setFileName(file.name)
      setAllowDuplicates({})
    } catch (cause) {
      setRows([])
      setError(cause instanceof Error ? cause.message : 'Não foi possível ler este arquivo.')
    }
  }

  async function submit() {
    if (!importable.length || busy) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const payload = JSON.stringify(importable)
      if (lastPayload.current !== payload) {
        lastPayload.current = payload
        requestId.current = crypto.randomUUID()
      }
      await onImport(requestId.current, importable)
      uncertainRef.current = false
      setUncertain(false)
      setImportDone(true)
    } catch (cause) {
      const hasUncertainOutcome = typeof cause === 'object' && cause !== null && 'uncertain' in cause && Boolean((cause as { uncertain?: unknown }).uncertain)
      if (hasUncertainOutcome) {
        uncertainRef.current = true
        setUncertain(true)
      }
      setError(cause instanceof Error ? cause.message : 'Não foi possível importar os clientes. Tente novamente.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="customer-import-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && !uncertain && event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} className="customer-import" role="dialog" aria-modal="true" aria-labelledby="customer-import-title" tabIndex={-1}>
        <header className="customer-import__header">
          <div><span className="customer-import__eyebrow">CLIENTES</span><h2 id="customer-import-title">Importar clientes</h2><p>Carregue um CSV, confira os dados e importe apenas os registros escolhidos.</p></div>
          <button className="customer-import__close" type="button" onClick={onClose} aria-label="Fechar" disabled={busy || uncertain}>×</button>
        </header>

        <div className="customer-import__body">
          <input ref={inputRef} hidden type="file" accept=".csv,text/csv" disabled={busy || uncertain || importDone} onChange={(event) => { void selectFile(event.target.files?.[0]); event.target.value = '' }} />
          <div className="customer-import__file">
            <div><strong>{fileName || 'Escolha um arquivo CSV'}</strong><span>Arquivo processado neste navegador • limite de 10 MB e 2.000 linhas</span></div>
            <button type="button" className="customer-import__secondary" disabled={busy || uncertain || importDone} onClick={() => inputRef.current?.click()}>Selecionar arquivo</button>
          </div>
          {error && <div className="customer-import__alert" role="alert">{error}</div>}
          {importDone && <div className="customer-import__success" role="status">{importable.length} clientes importados. Nenhum cadastro existente foi atualizado.</div>}

          {headers.length > 0 && <>
            <div className="customer-import__mapping">
              <div className="customer-import__section-heading"><div><h3>Associe as colunas</h3><p>Reconhecemos alguns nomes automaticamente; ajuste se necessário.</p></div></div>
              <div className="customer-import__mapping-grid">{CUSTOMER_IMPORT_FIELDS.map((field) => <label key={field}>{labels[field]}{field === 'name' && <em>Obrigatório</em>}<select disabled={busy || uncertain || importDone} value={mapping[field] ?? ''} onChange={(event) => setMapping((current) => ({ ...current, [field]: event.target.value === '' ? null : Number(event.target.value) }))}><option value="">Não importar</option>{headers.map((header, index) => <option key={`${index}-${header}`} value={index}>{header}</option>)}</select></label>)}</div>
              <div className="customer-import__phone-options"><label>Código do país para telefones sem DDI<div className="customer-import__code"><span>+</span><input disabled={busy || uncertain || importDone} inputMode="numeric" value={callingCode} onChange={(event) => setCallingCode(event.target.value.replace(/\D/g, '').slice(0, 3))} aria-label="Código do país" /></div></label><label className="customer-import__checkbox"><input type="checkbox" disabled={busy || uncertain || importDone} checked={numbersIncludeCode} onChange={(event) => setNumbersIncludeCode(event.target.checked)} /> Telefones sem + ou 00 já incluem o código do país</label></div>
            </div>

            <div className="customer-import__section-heading customer-import__preview-heading" aria-live="polite" aria-atomic="true"><div><h3>Prévia da importação</h3><p>{importable.length} prontos · {invalidCount} com erros · {duplicateCount} duplicados ignorados</p></div></div>
            <div className="customer-import__table-wrap"><table><caption className="visually-hidden">Prévia dos clientes que serão importados e dos erros encontrados por linha</caption><thead><tr><th>Linha</th><th>Nome</th><th>Telefone</th><th>WhatsApp</th><th>Endereço</th><th>Observações</th><th>Resultado</th></tr></thead><tbody>{preview.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.values.name || '—'}</td><td>{row.values.phone || '—'}</td><td>{row.values.whatsapp_phone || '—'}</td><td>{row.values.delivery_address || '—'}</td><td>{row.values.notes || '—'}</td><td>{row.errors.length > 0 ? <span className="customer-import__row-error">{row.errors.join(' ')}</span> : row.duplicateMatches.length > 0 ? <div className="customer-import__duplicate"><span>{row.duplicateMatches.join(' ')}</span><label><input type="checkbox" disabled={busy} checked={Boolean(allowDuplicates[row.rowNumber])} onChange={(event) => setAllowDuplicates((current) => ({ ...current, [row.rowNumber]: event.target.checked }))} /> Importar mesmo assim</label></div> : <span className="customer-import__row-ready">Pronto</span>}</td></tr>)}</tbody></table></div>
            <p className="customer-import__privacy">Duplicados são ignorados por padrão. Se confirmar um duplicado, será criado um novo cadastro; dados existentes nunca são mesclados nem sobrescritos.</p>
          </>}
        </div>

        <footer className="customer-import__footer"><button type="button" className="customer-import__secondary" onClick={onClose} disabled={busy || uncertain}>{importDone ? 'Concluir' : uncertain ? 'Reenvie o mesmo lote' : 'Cancelar'}</button>{!importDone && <button type="button" className="customer-import__primary" disabled={busy || importable.length === 0} onClick={() => void submit()}>{busy ? 'Importando…' : uncertain ? `Reenviar ${importable.length} cliente${importable.length === 1 ? '' : 's'}` : `Importar ${importable.length} cliente${importable.length === 1 ? '' : 's'}`}</button>}</footer>
      </section>
    </div>
  )
}

export default CustomerImport
