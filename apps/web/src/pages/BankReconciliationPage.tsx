import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { FinanceNavigation } from '../components/FinanceNavigation'
import { Icon } from '../components/Icon'
import { businessToday, formatBRLExact, formatBusinessDate, parseBrazilianCurrency } from '../lib/formatters'
import { useBusiness } from '../business/BusinessContext'
import { supabaseClient } from '../lib/supabase'

const PAGE_SIZE = 25

type BankAccount = {
  id: string
  business_id: string
  institution_name: string
  account_label: string
  account_last_four: string | null
  is_active: boolean
  created_at: string
}

type BankTransaction = {
  id: string
  business_id: string
  bank_account_id: string
  transaction_date: string
  description: string
  counterparty_name: string | null
  amount_cents: number | string
  source: 'manual' | 'statement_file' | 'open_finance_sandbox' | 'open_finance_production'
  created_at: string
}

type BankMatch = {
  id: string
  bank_transaction_id: string
  order_payment_id: string | null
  financial_outflow_id: string | null
  created_at: string
}

type MatchReversal = { match_id: string; reason: string; created_at: string }
type DuplicateLink = { id: string; duplicate_transaction_id: string; original_transaction_id: string; reason: string; created_at: string }
type DuplicateClear = { duplicate_id: string; reason: string; created_at: string }
type ReconciliationStatusTotal = { count: string; gross_cents: string }
type BankReconciliationSummary = {
  movement_count: string
  reconciled: ReconciliationStatusTotal
  pending: ReconciliationStatusTotal
  duplicate: ReconciliationStatusTotal
}
type BankReconciliationSummaryRow = {
  status: 'reconciled' | 'pending' | 'duplicate'
  movement_count: string
  gross_cents: string
}
type QueryResponse = { data: unknown[] | null; error: unknown; count?: number | null }
type MatchCandidate = {
  kind: 'receipt' | 'outflow'
  id: string
  date: string
  title: string
  detail: string
  amount_cents: number | string
}

function newRequestId() {
  return crypto.randomUUID()
}

function signedAmount(value: string | number) {
  return BigInt(value)
}

function movementDirectionLabel(value: string | number) {
  return signedAmount(value) > 0n ? 'Entrada' : 'Saída'
}

function sourceLabel(source: BankTransaction['source']) {
  if (source === 'manual') return 'Registrado manualmente'
  if (source === 'statement_file') return 'Arquivo de extrato'
  if (source === 'open_finance_sandbox') return 'Open Finance · sandbox'
  return 'Open Finance · produção'
}

function shortId(value: string) {
  return value.slice(0, 8).toUpperCase()
}

function formatAmount(value: string | number) {
  return formatBRLExact(String(value))
}

async function loadAllPages<T>(
  loadPage: (from: number, to: number) => PromiseLike<QueryResponse>,
): Promise<{ data: T[] | null; error: unknown }> {
  const rows: T[] = []
  let from = 0
  let expectedCount: number | null = null
  for (;;) {
    const { data, error, count } = await loadPage(from, from + 999)
    if (error) return { data: null, error }
    const pageRows = (data ?? []) as T[]
    if (expectedCount === null && count != null) expectedCount = count
    rows.push(...pageRows)
    if (pageRows.length === 0) {
      if (expectedCount !== null && rows.length < expectedCount) return { data: null, error: new Error('A consulta paginada terminou antes de carregar todos os dados.') }
      return { data: rows, error: null }
    }
    from += pageRows.length
    if (expectedCount !== null && rows.length >= expectedCount) return { data: rows, error: null }
    if (expectedCount === null && pageRows.length < 1000) return { data: rows, error: null }
  }
}

function businessDateWindow(day: string, days: number) {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date - days)).toISOString().slice(0, 10)
}

export function BankReconciliationPage() {
  const { id: businessId } = useBusiness()
  const today = businessToday()
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [transactions, setTransactions] = useState<BankTransaction[]>([])
  const [matches, setMatches] = useState<BankMatch[]>([])
  const [matchReversals, setMatchReversals] = useState<MatchReversal[]>([])
  const [duplicates, setDuplicates] = useState<DuplicateLink[]>([])
  const [duplicateClears, setDuplicateClears] = useState<DuplicateClear[]>([])
  const [reconciliationSummary, setReconciliationSummary] = useState<BankReconciliationSummary | null>(null)
  const [summaryBusinessId, setSummaryBusinessId] = useState<string | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [matchLabels, setMatchLabels] = useState<Record<string, string>>({})
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [accountFormOpen, setAccountFormOpen] = useState(false)
  const [movementFormOpen, setMovementFormOpen] = useState(false)
  const [savingAccount, setSavingAccount] = useState(false)
  const [savingMovement, setSavingMovement] = useState(false)
  const [movementUncertain, setMovementUncertain] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [institutionName, setInstitutionName] = useState('')
  const [accountLabel, setAccountLabel] = useState('')
  const [accountLastFour, setAccountLastFour] = useState('')
  const [accountId, setAccountId] = useState('')
  const [transactionDate, setTransactionDate] = useState(today)
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit')
  const [description, setDescription] = useState('')
  const [counterpartyName, setCounterpartyName] = useState('')
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [movementRequestId, setMovementRequestId] = useState(newRequestId)
  const [candidateTarget, setCandidateTarget] = useState<BankTransaction | null>(null)
  const [candidates, setCandidates] = useState<MatchCandidate[]>([])
  const [candidateLimit, setCandidateLimit] = useState(20)
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [candidateError, setCandidateError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSaving, setActionSaving] = useState(false)
  const [matchRequestId, setMatchRequestId] = useState(newRequestId)
  const [unmatchTarget, setUnmatchTarget] = useState<BankMatch | null>(null)
  const [unmatchReason, setUnmatchReason] = useState('')
  const [duplicateTarget, setDuplicateTarget] = useState<BankTransaction | null>(null)
  const [duplicateOriginalId, setDuplicateOriginalId] = useState('')
  const [duplicateReason, setDuplicateReason] = useState('')
  const [duplicateRequestId, setDuplicateRequestId] = useState(newRequestId)
  const [clearDuplicateTarget, setClearDuplicateTarget] = useState<DuplicateLink | null>(null)
  const [clearDuplicateReason, setClearDuplicateReason] = useState('')
  const [clearDuplicateRequestId, setClearDuplicateRequestId] = useState(newRequestId)
  const accountFormHeadingRef = useRef<HTMLHeadingElement>(null)
  const movementFormHeadingRef = useRef<HTMLHeadingElement>(null)
  const candidateHeadingRef = useRef<HTMLHeadingElement>(null)
  const unmatchHeadingRef = useRef<HTMLHeadingElement>(null)
  const duplicateHeadingRef = useRef<HTMLHeadingElement>(null)
  const clearDuplicateHeadingRef = useRef<HTMLHeadingElement>(null)
  const accountTriggerRef = useRef<HTMLButtonElement>(null)
  const movementTriggerRef = useRef<HTMLButtonElement>(null)
  const accountWasOpenRef = useRef(false)
  const movementWasOpenRef = useRef(false)
  const returnFocusIdRef = useRef<string | null>(null)
  const actionRequestRef = useRef(newRequestId())
  const loadRequestRef = useRef(0)
  const summaryRequestRef = useRef(0)

  const activeMatchByTransaction = useMemo(() => {
    const reversedMatchIds = new Set(matchReversals.map((row) => row.match_id))
    return new Map(matches.filter((row) => !reversedMatchIds.has(row.id)).map((row) => [row.bank_transaction_id, row]))
  }, [matches, matchReversals])

  const activeDuplicateByTransaction = useMemo(() => {
    const clearedIds = new Set(duplicateClears.map((row) => row.duplicate_id))
    return new Map(duplicates.filter((row) => !clearedIds.has(row.id)).map((row) => [row.duplicate_transaction_id, row]))
  }, [duplicates, duplicateClears])

  const activeDuplicateOriginalIds = useMemo(() => {
    const clearedIds = new Set(duplicateClears.map((row) => row.duplicate_id))
    return new Set(duplicates.filter((row) => !clearedIds.has(row.id)).map((row) => row.original_transaction_id))
  }, [duplicates, duplicateClears])

  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts])

  const clearActionForms = () => {
    setCandidateTarget(null)
    setCandidates([])
    setCandidateError(null)
    setUnmatchTarget(null)
    setUnmatchReason('')
    setDuplicateTarget(null)
    setDuplicateOriginalId('')
    setDuplicateReason('')
    setClearDuplicateTarget(null)
    setClearDuplicateReason('')
    setActionError(null)
  }

  const closeActionForms = () => {
    const targetId = returnFocusIdRef.current
    clearActionForms()
    window.requestAnimationFrame(() => {
      if (targetId) document.getElementById(targetId)?.focus()
      returnFocusIdRef.current = null
    })
  }

  const loadData = useCallback(async (nextPage: number) => {
    const client = supabaseClient
    const request = ++loadRequestRef.current
    if (!client) {
      setLoadError('A conexão da empresa não está disponível.')
      setLoading(false)
      return
    }

    setLoading(true)
    setLoadError(null)
    try {
      const [accountResult, transactionResult] = await Promise.all([
        loadAllPages<BankAccount>((from, to) => client.from('bank_accounts')
          .select('id, business_id, institution_name, account_label, account_last_four, is_active, created_at', { count: 'exact' })
          .eq('business_id', businessId)
          .order('institution_name', { ascending: true })
          .order('account_label', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)),
        client.from('bank_transactions')
          .select('id, business_id, bank_account_id, transaction_date, description, counterparty_name, amount_cents, source, created_at', { count: 'exact' })
          .eq('business_id', businessId)
          .order('transaction_date', { ascending: false })
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(nextPage * PAGE_SIZE, (nextPage + 1) * PAGE_SIZE - 1),
      ])
      if (accountResult.error) throw accountResult.error
      if (transactionResult.error) throw transactionResult.error
      const accountRows = accountResult.data ?? []
      const transactionRows = (transactionResult.data ?? []) as BankTransaction[]
      const ids = transactionRows.map((row) => row.id)
      let matchRows: BankMatch[] = []
      let reversalRows: MatchReversal[] = []
      let duplicateRows: DuplicateLink[] = []
      let clearRows: DuplicateClear[] = []
      const nextMatchLabels: Record<string, string> = {}

      if (ids.length > 0) {
        const [matchResult, duplicateRowsByTransactionResult, duplicateRowsByOriginalResult] = await Promise.all([
          loadAllPages<BankMatch>((from, to) => client.from('bank_reconciliation_matches')
            .select('id, bank_transaction_id, order_payment_id, financial_outflow_id, created_at', { count: 'exact' })
            .eq('business_id', businessId)
            .in('bank_transaction_id', ids)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to)),
          loadAllPages<DuplicateLink>((from, to) => client.from('bank_transaction_duplicates')
            .select('id, duplicate_transaction_id, original_transaction_id, reason, created_at', { count: 'exact' })
            .eq('business_id', businessId)
            .in('duplicate_transaction_id', ids)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to)),
          loadAllPages<DuplicateLink>((from, to) => client.from('bank_transaction_duplicates')
            .select('id, duplicate_transaction_id, original_transaction_id, reason, created_at', { count: 'exact' })
            .eq('business_id', businessId)
            .in('original_transaction_id', ids)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to)),
        ])
        if (matchResult.error) throw matchResult.error
        if (duplicateRowsByTransactionResult.error) throw duplicateRowsByTransactionResult.error
        if (duplicateRowsByOriginalResult.error) throw duplicateRowsByOriginalResult.error
        matchRows = matchResult.data ?? []
        duplicateRows = Array.from(new Map([
          ...(duplicateRowsByTransactionResult.data ?? []),
          ...(duplicateRowsByOriginalResult.data ?? []),
        ].map((row) => [row.id, row])).values())
        const matchIds = matchRows.map((row) => row.id)
        const duplicateIds = duplicateRows.map((row) => row.id)
        const [reversalResult, clearResult] = await Promise.all([
          matchIds.length
            ? loadAllPages<MatchReversal>((from, to) => client.from('bank_reconciliation_match_reversals').select('match_id, reason, created_at', { count: 'exact' }).eq('business_id', businessId).in('match_id', matchIds).order('match_id', { ascending: true }).range(from, to))
            : Promise.resolve({ data: [], error: null }),
          duplicateIds.length
            ? loadAllPages<DuplicateClear>((from, to) => client.from('bank_transaction_duplicate_clears').select('duplicate_id, reason, created_at', { count: 'exact' }).eq('business_id', businessId).in('duplicate_id', duplicateIds).order('duplicate_id', { ascending: true }).range(from, to))
            : Promise.resolve({ data: [], error: null }),
        ])
        if (reversalResult.error) throw reversalResult.error
        if (clearResult.error) throw clearResult.error
        reversalRows = reversalResult.data ?? []
        clearRows = clearResult.data ?? []

        const activeMatchRows = matchRows.filter((row) => !reversalRows.some((reversal) => reversal.match_id === row.id))
        const paymentIds = activeMatchRows.flatMap((row) => row.order_payment_id ? [row.order_payment_id] : [])
        const outflowIds = activeMatchRows.flatMap((row) => row.financial_outflow_id ? [row.financial_outflow_id] : [])
        if (paymentIds.length > 0) {
          const paymentResult = await client.from('order_payments').select('id, order_id, received_at').eq('business_id', businessId).in('id', paymentIds)
          if (paymentResult.error) throw paymentResult.error
          const paymentRows = (paymentResult.data ?? []) as { id: string; order_id: string; received_at: string }[]
          const orderIds = Array.from(new Set(paymentRows.map((row) => row.order_id)))
          const orderResult = orderIds.length
            ? await client.from('orders').select('id, customer_name_snapshot').eq('business_id', businessId).in('id', orderIds)
            : { data: [], error: null }
          if (orderResult.error) throw orderResult.error
          const orderById = new Map(((orderResult.data ?? []) as { id: string; customer_name_snapshot: string }[]).map((row) => [row.id, row.customer_name_snapshot]))
          for (const payment of paymentRows) {
            nextMatchLabels[payment.id] = `Recebimento de ${orderById.get(payment.order_id) ?? 'pedido'} · ${formatBusinessDate(payment.received_at.slice(0, 10))}`
          }
        }
        if (outflowIds.length > 0) {
          const outflowResult = await client.from('financial_outflows').select('id, description, paid_on').eq('business_id', businessId).in('id', outflowIds)
          if (outflowResult.error) throw outflowResult.error
          for (const outflow of (outflowResult.data ?? []) as { id: string; description: string; paid_on: string }[]) {
            nextMatchLabels[outflow.id] = `Saída paga · ${outflow.description} · ${formatBusinessDate(outflow.paid_on)}`
          }
        }
      }

      if (request !== loadRequestRef.current) return
      setAccounts(accountRows)
      setTransactions(transactionRows)
      setMatches(matchRows)
      setMatchReversals(reversalRows)
      setDuplicates(duplicateRows)
      setDuplicateClears(clearRows)
      setMatchLabels(nextMatchLabels)
      setTotal(transactionResult.count ?? 0)
      setPage(nextPage)
    } catch {
      if (request === loadRequestRef.current) {
        setLoadError('Não foi possível atualizar os movimentos bancários. Os dados anteriores não devem ser usados para confirmar uma ação.')
        closeActionForms()
      }
    } finally {
      if (request === loadRequestRef.current) setLoading(false)
    }
  }, [businessId])

  const loadReconciliationSummary = useCallback(async () => {
    const client = supabaseClient
    const request = ++summaryRequestRef.current
    setSummaryBusinessId(businessId)
    setReconciliationSummary(null)
    setSummaryLoading(true)
    setSummaryError(null)
    if (!client) {
      setSummaryError('O resumo global dos movimentos não está disponível agora.')
      setSummaryLoading(false)
      return
    }

    try {
      const { data, error } = await client.rpc('bank_reconciliation_global_summary', { p_business_id: businessId })
      if (error) throw error
      if (request !== summaryRequestRef.current) return

      const rows = (data ?? []) as BankReconciliationSummaryRow[]
      const totals: Partial<Record<BankReconciliationSummaryRow['status'], ReconciliationStatusTotal>> = {}
      for (const row of rows) {
        if (totals[row.status]) throw new Error('The bank summary returned a duplicate status.')
        const count = BigInt(row.movement_count)
        const grossCents = BigInt(row.gross_cents)
        if (count < 0n || grossCents < 0n) throw new Error('The bank summary returned an invalid total.')
        totals[row.status] = { count: count.toString(), gross_cents: grossCents.toString() }
      }
      if (!totals.reconciled || !totals.pending || !totals.duplicate) {
        throw new Error('The complete bank reconciliation summary could not be loaded.')
      }
      const movementCount = BigInt(totals.reconciled.count) + BigInt(totals.pending.count) + BigInt(totals.duplicate.count)

      setReconciliationSummary({
        movement_count: movementCount.toString(),
        reconciled: totals.reconciled,
        pending: totals.pending,
        duplicate: totals.duplicate,
      })
    } catch {
      if (request === summaryRequestRef.current) {
        setReconciliationSummary(null)
        setSummaryError('Não foi possível carregar o resumo completo. Nenhum total parcial foi exibido.')
      }
    } finally {
      if (request === summaryRequestRef.current) setSummaryLoading(false)
    }
  }, [businessId])

  const refreshBankData = useCallback(async (nextPage: number) => {
    await Promise.all([loadData(nextPage), loadReconciliationSummary()])
  }, [loadData, loadReconciliationSummary])

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshBankData(0) }, 0)
    return () => window.clearTimeout(timer)
  }, [refreshBankData])

  useEffect(() => {
    if (accountFormOpen) accountFormHeadingRef.current?.focus()
    else if (accountWasOpenRef.current) accountTriggerRef.current?.focus()
    accountWasOpenRef.current = accountFormOpen
  }, [accountFormOpen])

  useEffect(() => {
    if (movementFormOpen) movementFormHeadingRef.current?.focus()
    else if (movementWasOpenRef.current) movementTriggerRef.current?.focus()
    movementWasOpenRef.current = movementFormOpen
  }, [movementFormOpen])

  useEffect(() => {
    if (candidateTarget) candidateHeadingRef.current?.focus()
  }, [candidateTarget])

  useEffect(() => { if (unmatchTarget) unmatchHeadingRef.current?.focus() }, [unmatchTarget])
  useEffect(() => { if (duplicateTarget) duplicateHeadingRef.current?.focus() }, [duplicateTarget])
  useEffect(() => { if (clearDuplicateTarget) clearDuplicateHeadingRef.current?.focus() }, [clearDuplicateTarget])

  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient) return
    const cleanInstitution = institutionName.trim()
    const cleanLabel = accountLabel.trim()
    const cleanLastFour = accountLastFour.trim()
    if (!cleanInstitution || !cleanLabel) {
      setFormError('Informe o banco e um nome curto para identificar a conta.')
      return
    }
    if (cleanLastFour && !/^\d{4}$/.test(cleanLastFour)) {
      setFormError('Os últimos dígitos devem ter exatamente 4 números.')
      return
    }

    setSavingAccount(true)
    setFormError(null)
    setNotice(null)
    try {
      const { data: inserted, error } = await supabaseClient.from('bank_accounts').insert({
        business_id: businessId,
        institution_name: cleanInstitution,
        account_label: cleanLabel,
        account_last_four: cleanLastFour || null,
      }).select('id').maybeSingle()
      if (error) {
        let existingQuery = supabaseClient.from('bank_accounts').select('id').eq('business_id', businessId).eq('institution_name', cleanInstitution).eq('account_label', cleanLabel)
        existingQuery = cleanLastFour ? existingQuery.eq('account_last_four', cleanLastFour) : existingQuery.is('account_last_four', null)
        const existing = await existingQuery.maybeSingle()
        if (existing.error || !existing.data) throw error
      } else if (!inserted?.id) {
        throw new Error('Bank account creation could not be confirmed.')
      }
      setInstitutionName('')
      setAccountLabel('')
      setAccountLastFour('')
      setAccountFormOpen(false)
      setNotice('Conta bancária cadastrada. Nenhuma conexão com o banco foi iniciada.')
      await refreshBankData(0)
    } catch {
      setFormError('Não foi possível salvar a conta. Confira os dados e tente novamente.')
    } finally {
      setSavingAccount(false)
    }
  }

  async function saveMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient) return
    const parsedAmount = parseBrazilianCurrency(amount)
    if (!accountId || !isCalendarDate(transactionDate) || transactionDate > today || !description.trim() || parsedAmount === null || Number.isNaN(parsedAmount) || parsedAmount <= 0) {
      setFormError('Informe conta, data válida, descrição e um valor positivo.')
      return
    }

    setSavingMovement(true)
    setFormError(null)
    setNotice(null)
    try {
      const { error } = await supabaseClient.rpc('record_bank_movement', {
        p_business_id: businessId,
        p_bank_account_id: accountId,
        p_transaction_date: transactionDate,
        p_direction: direction,
        p_description: description.trim(),
        p_counterparty_name: counterpartyName.trim() || null,
        p_amount_cents: parsedAmount,
        p_notes: notes.trim() || null,
        p_request_id: movementRequestId,
      })
      if (error) throw error
      setDescription('')
      setCounterpartyName('')
      setAmount('')
      setNotes('')
      setMovementUncertain(false)
      setMovementRequestId(newRequestId())
      setMovementFormOpen(false)
      setNotice('Movimento registrado manualmente. Nenhuma conexão bancária foi consultada.')
      clearActionForms()
      await refreshBankData(0)
    } catch {
      setMovementUncertain(true)
      setFormError('Não foi possível confirmar o registro. Tente novamente com os mesmos dados; o envio usa o mesmo identificador para evitar duplicação.')
    } finally {
      setSavingMovement(false)
    }
  }

  const loadCandidates = async (movement: BankTransaction) => {
    const client = supabaseClient
    if (!client) return
    clearActionForms()
    returnFocusIdRef.current = `bank-movement-title-${movement.id}`
    setCandidateTarget(movement)
    setCandidates([])
    setCandidateLimit(20)
    setCandidateError(null)
    setActionError(null)
    setMatchRequestId(newRequestId())
    setCandidatesLoading(true)
    const signedCents = signedAmount(movement.amount_cents)
    const absoluteAmount = (signedCents > 0n ? signedCents : -signedCents).toString()
    const since = businessDateWindow(movement.transaction_date, 45)
    const until = `${businessDateWindow(movement.transaction_date, -45)}T23:59:59-03:00`
    try {
      const [paymentResult, outflowResult] = await Promise.all([
        loadAllPages<{ id: string; order_id: string; received_at: string; amount_cents: number | string }>((from, to) => client.from('order_payments').select('id, order_id, received_at, amount_cents', { count: 'exact' }).eq('business_id', businessId).eq('amount_cents', absoluteAmount).gte('received_at', `${since}T00:00:00-03:00`).lte('received_at', until).order('received_at', { ascending: false }).order('id', { ascending: true }).range(from, to)),
        loadAllPages<{ id: string; description: string; paid_on: string; amount_cents: number | string }>((from, to) => client.from('financial_outflows').select('id, description, paid_on, amount_cents', { count: 'exact' }).eq('business_id', businessId).eq('amount_cents', absoluteAmount).gte('paid_on', since).lte('paid_on', until.slice(0, 10)).order('paid_on', { ascending: false }).order('id', { ascending: true }).range(from, to)),
      ])
      if (paymentResult.error) throw paymentResult.error
      if (outflowResult.error) throw outflowResult.error
      const payments = paymentResult.data ?? []
      const outflows = outflowResult.data ?? []
      const orderIds = Array.from(new Set(payments.map((row) => row.order_id)))
      const paymentIds = payments.map((row) => row.id)
      const outflowIds = outflows.map((row) => row.id)
      const [orderResult, voidResult, paymentMatchResult, outflowMatchResult] = await Promise.all([
        orderIds.length ? client.from('orders').select('id, customer_name_snapshot').eq('business_id', businessId).in('id', orderIds) : Promise.resolve({ data: [], error: null }),
        outflowIds.length ? client.from('financial_outflow_voids').select('outflow_id').eq('business_id', businessId).in('outflow_id', outflowIds) : Promise.resolve({ data: [], error: null }),
        paymentIds.length ? loadAllPages<{ id: string; order_payment_id: string | null; financial_outflow_id: string | null; created_at: string }>((from, to) => client.from('bank_reconciliation_matches').select('id, order_payment_id, financial_outflow_id, created_at', { count: 'exact' }).eq('business_id', businessId).in('order_payment_id', paymentIds).order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to)) : Promise.resolve({ data: [], error: null }),
        outflowIds.length ? loadAllPages<{ id: string; order_payment_id: string | null; financial_outflow_id: string | null; created_at: string }>((from, to) => client.from('bank_reconciliation_matches').select('id, order_payment_id, financial_outflow_id, created_at', { count: 'exact' }).eq('business_id', businessId).in('financial_outflow_id', outflowIds).order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to)) : Promise.resolve({ data: [], error: null }),
      ])
      if (orderResult.error) throw orderResult.error
      if (voidResult.error) throw voidResult.error
      if (paymentMatchResult.error) throw paymentMatchResult.error
      if (outflowMatchResult.error) throw outflowMatchResult.error
      const ordersById = new Map(((orderResult.data ?? []) as { id: string; customer_name_snapshot: string }[]).map((row) => [row.id, row.customer_name_snapshot]))
      const voidedOutflowIds = new Set(((voidResult.data ?? []) as { outflow_id: string }[]).map((row) => row.outflow_id))
      const allMatchRows = [...(paymentMatchResult.data ?? []), ...(outflowMatchResult.data ?? [])]
      const matchIds = allMatchRows.map((row) => row.id)
      const reversalResult = matchIds.length
        ? await loadAllPages<{ match_id: string }>((from, to) => client.from('bank_reconciliation_match_reversals').select('match_id', { count: 'exact' }).eq('business_id', businessId).in('match_id', matchIds).order('match_id', { ascending: true }).range(from, to))
        : { data: [], error: null }
      if (reversalResult.error) throw reversalResult.error
      const reversedIds = new Set((reversalResult.data ?? []).map((row) => row.match_id))
      const activeMatches = allMatchRows.filter((row) => !reversedIds.has(row.id))
      const matchedPaymentIds = new Set(activeMatches.flatMap((row) => row.order_payment_id ? [row.order_payment_id] : []))
      const matchedOutflowIds = new Set(activeMatches.flatMap((row) => row.financial_outflow_id ? [row.financial_outflow_id] : []))
      const possibleCandidates: MatchCandidate[] = []
      if (signedAmount(movement.amount_cents) > 0n) {
        for (const payment of payments) {
          if (matchedPaymentIds.has(payment.id)) continue
          possibleCandidates.push({
            kind: 'receipt',
            id: payment.id,
            date: payment.received_at.slice(0, 10),
            title: `Recebimento · ${ordersById.get(payment.order_id) ?? 'pedido'}`,
            detail: `Pedido ${shortId(payment.order_id)}`,
            amount_cents: payment.amount_cents,
          })
        }
      } else {
        for (const outflow of outflows) {
          if (voidedOutflowIds.has(outflow.id) || matchedOutflowIds.has(outflow.id)) continue
          possibleCandidates.push({
            kind: 'outflow',
            id: outflow.id,
            date: outflow.paid_on,
            title: outflow.description,
            detail: 'Saída paga registrada',
            amount_cents: outflow.amount_cents,
          })
        }
      }
      possibleCandidates.sort((left, right) => Math.abs(Date.parse(`${left.date}T12:00:00-03:00`) - Date.parse(`${movement.transaction_date}T12:00:00-03:00`)) - Math.abs(Date.parse(`${right.date}T12:00:00-03:00`) - Date.parse(`${movement.transaction_date}T12:00:00-03:00`)))
      setCandidates(possibleCandidates)
    } catch {
      setCandidateError('Não foi possível carregar registros do mesmo valor. A conciliação não foi gravada.')
    } finally {
      setCandidatesLoading(false)
    }
  }

  async function confirmMatch(candidate: MatchCandidate) {
    if (!supabaseClient || !candidateTarget) return
    setActionSaving(true)
    setActionError(null)
    try {
      const { error } = await supabaseClient.rpc('match_bank_transaction', {
        p_business_id: businessId,
        p_bank_transaction_id: candidateTarget.id,
        p_order_payment_id: candidate.kind === 'receipt' ? candidate.id : null,
        p_financial_outflow_id: candidate.kind === 'outflow' ? candidate.id : null,
        p_request_id: matchRequestId,
      })
      if (error) throw error
      setNotice('Conciliação registrada e vinculada ao lançamento financeiro.')
      closeActionForms()
      await refreshBankData(page)
    } catch {
      setActionError('Não foi possível conciliar. O lançamento pode ter sido usado em outra conciliação ou alterado; atualize a lista e tente novamente.')
    } finally {
      setActionSaving(false)
    }
  }

  async function confirmUnmatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || !unmatchTarget || !unmatchReason.trim()) {
      setActionError('Informe o motivo para desfazer a conciliação.')
      return
    }
    setActionSaving(true)
    setActionError(null)
    try {
      const { error } = await supabaseClient.rpc('unmatch_bank_transaction', {
        p_business_id: businessId,
        p_match_id: unmatchTarget.id,
        p_reason: unmatchReason.trim(),
        p_request_id: actionRequestRef.current,
      })
      if (error) throw error
      actionRequestRef.current = newRequestId()
      setNotice('Conciliação desfeita. O motivo permanece no histórico.')
      closeActionForms()
      await refreshBankData(page)
    } catch {
      setActionError('Não foi possível desfazer a conciliação. Atualize os dados e tente novamente.')
    } finally {
      setActionSaving(false)
    }
  }

  async function confirmDuplicate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || !duplicateTarget || !duplicateOriginalId || !duplicateReason.trim()) {
      setActionError('Escolha o movimento original e informe por que este lançamento é duplicado.')
      return
    }
    setActionSaving(true)
    setActionError(null)
    try {
      const { error } = await supabaseClient.rpc('mark_bank_transaction_duplicate', {
        p_business_id: businessId,
        p_duplicate_transaction_id: duplicateTarget.id,
        p_original_transaction_id: duplicateOriginalId,
        p_reason: duplicateReason.trim(),
        p_request_id: duplicateRequestId,
      })
      if (error) throw error
      setDuplicateRequestId(newRequestId())
      setNotice('Lançamento sinalizado como duplicado e retirado das sugestões de conciliação.')
      closeActionForms()
      await refreshBankData(page)
    } catch {
      setActionError('Não foi possível sinalizar o duplicado. Atualize os movimentos e tente novamente.')
    } finally {
      setActionSaving(false)
    }
  }

  async function confirmClearDuplicate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient || !clearDuplicateTarget || !clearDuplicateReason.trim()) {
      setActionError('Informe o motivo para restaurar este movimento.')
      return
    }
    setActionSaving(true)
    setActionError(null)
    try {
      const { error } = await supabaseClient.rpc('clear_bank_transaction_duplicate', {
        p_business_id: businessId,
        p_duplicate_id: clearDuplicateTarget.id,
        p_reason: clearDuplicateReason.trim(),
        p_request_id: clearDuplicateRequestId,
      })
      if (error) throw error
      setClearDuplicateRequestId(newRequestId())
      setNotice('Sinalização removida. O movimento voltou à fila de conciliação.')
      closeActionForms()
      await refreshBankData(page)
    } catch {
      setActionError('Não foi possível restaurar este movimento. Atualize a lista e tente novamente.')
    } finally {
      setActionSaving(false)
    }
  }

  const activeAccounts = accounts.filter((account) => account.is_active)
  const hasMore = (page + 1) * PAGE_SIZE < total
  const firstRecord = total ? page * PAGE_SIZE + 1 : 0
  const lastRecord = Math.min((page + 1) * PAGE_SIZE, total)

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">FINANCEIRO</p>
          <h1>Conciliação bancária</h1>
          <p className="page-description">Compare movimentos do banco com recebimentos e saídas registrados.</p>
        </div>
        <span className="module-heading-icon"><Icon name="coin" /></span>
      </header>

      <FinanceNavigation active="banking" />

      {notice && <p className="form-message form-message-success" role="status">{notice}</p>}
      {loadError && <div className="form-message form-message-error" role="alert">{loadError} <button className="text-button" onClick={() => void refreshBankData(page)} type="button">Atualizar</button></div>}

      <section className="bank-connection-note" aria-labelledby="bank-connection-heading">
        <div className="bank-connection-note-icon" aria-hidden="true"><Icon name="shield" /></div>
        <div>
          <p className="eyebrow">OPEN FINANCE</p>
          <h2 id="bank-connection-heading">Conexão ainda não iniciada</h2>
          <p>O teste de sandbox depende de projeto Supabase disponível e credenciais do provedor. Esta tela não acessa o banco nem contém movimentos fictícios. Enquanto isso, você pode registrar manualmente linhas do extrato e conciliá-las com o financeiro.</p>
          <small>Os segredos da integração deverão ficar no servidor. Não informe senha bancária nesta tela.</small>
        </div>
        <span className="neutral-status">Não conectada</span>
      </section>

      <section className="surface-panel settings-panel" aria-labelledby="bank-accounts-heading">
        <div className="section-heading">
          <div><p className="eyebrow">CONTAS</p><h2 id="bank-accounts-heading">Contas bancárias</h2></div>
          <button className="button button-secondary" disabled={loading || Boolean(loadError) || savingAccount} ref={accountTriggerRef} onClick={() => { setAccountFormOpen((value) => !value); setFormError(null) }} type="button">{accountFormOpen ? 'Fechar' : 'Adicionar conta'}</button>
        </div>
        <p className="section-footnote">Use um nome curto e, se quiser, apenas os 4 últimos dígitos. Não informe senha, token ou número completo de conta.</p>

        {accountFormOpen && <form className="record-form bank-inline-form" onSubmit={(event) => void saveAccount(event)}>
          <h2 ref={accountFormHeadingRef} tabIndex={-1}>Nova conta para conciliação</h2>
          <div className="record-form-grid">
            <label className="record-field"><span className="field-label">Banco ou instituição</span><input autoComplete="off" className="text-input" maxLength={120} onChange={(event) => setInstitutionName(event.target.value)} required value={institutionName} /></label>
            <label className="record-field"><span className="field-label">Nome da conta</span><input autoComplete="off" className="text-input" maxLength={120} onChange={(event) => setAccountLabel(event.target.value)} required value={accountLabel} /></label>
            <label className="record-field"><span className="field-label">Últimos 4 dígitos <span className="field-optional">(opcional)</span></span><input autoComplete="off" className="text-input" inputMode="numeric" maxLength={4} onChange={(event) => setAccountLastFour(event.target.value.replace(/\D/g, '').slice(0, 4))} value={accountLastFour} /></label>
          </div>
          {formError && <p className="form-message form-message-error" role="alert">{formError}</p>}
          <div className="record-form-actions"><button className="button button-primary" disabled={savingAccount || loading || Boolean(loadError)} type="submit">{savingAccount ? 'Salvando…' : 'Salvar conta'}</button><button className="text-button" onClick={() => { setAccountFormOpen(false); setFormError(null) }} type="button">Cancelar</button></div>
        </form>}

        {loading && accounts.length === 0 ? <p className="inline-state" aria-live="polite">Carregando contas…</p> : loadError && accounts.length === 0 ? <p className="inline-state inline-state-error" role="status">Não foi possível consultar as contas. <button className="text-button" onClick={() => void refreshBankData(page)} type="button">Tentar novamente</button></p> : accounts.length === 0 ? <div className="empty-state"><span className="empty-icon"><Icon name="coin" /></span><div><h3>Nenhuma conta cadastrada</h3><p>Cadastre o banco e um identificador da conta para organizar os movimentos que serão conferidos.</p></div></div> : <ul className="bank-account-list">
          {accounts.map((account) => <li key={account.id}>
            <span className="bank-account-mark" aria-hidden="true"><Icon name="coin" /></span>
            <span className="bank-account-copy"><strong>{account.account_label}</strong><small>{account.institution_name}{account.account_last_four ? ` · final ${account.account_last_four}` : ''}</small></span>
            <span className={account.is_active ? 'connected-status' : 'neutral-status'}>{account.is_active ? 'Cadastro ativo' : 'Cadastro inativo'}</span>
          </li>)}
        </ul>}
      </section>

      <section className="surface-panel settings-panel" aria-labelledby="bank-movements-heading">
        <div className="section-heading">
          <div><p className="eyebrow">MOVIMENTOS</p><h2 id="bank-movements-heading">Movimentos do extrato</h2></div>
          <button className="button button-primary" disabled={activeAccounts.length === 0 || loading || Boolean(loadError)} onClick={() => { setAccountId(activeAccounts[0]?.id ?? ''); setMovementFormOpen((value) => !value); setFormError(null) }} ref={movementTriggerRef} type="button">{movementFormOpen ? 'Fechar' : 'Registrar movimento'}</button>
        </div>
        <p className="section-footnote">A conciliação é manual e exige confirmação. Cada movimento bancário pode ser ligado a um único recebimento ou saída, pelo valor exato; divisão e agrupamento ainda não estão disponíveis.</p>

        {(summaryBusinessId !== businessId || summaryLoading) && <p className="inline-state bank-summary-loading" aria-live="polite">Carregando resumo de todos os movimentos…</p>}
        {summaryBusinessId === businessId && !summaryLoading && summaryError && <div className="bank-summary-error" role="alert"><p>{summaryError}</p><button className="text-button" onClick={() => void loadReconciliationSummary()} type="button">Tentar novamente</button></div>}
        {summaryBusinessId === businessId && !summaryLoading && !summaryError && reconciliationSummary && <section className="bank-reconciliation-summary" aria-labelledby="bank-reconciliation-summary-title">
          <div className="bank-reconciliation-summary-heading">
            <div><p className="eyebrow">RESUMO GLOBAL</p><h3 id="bank-reconciliation-summary-title">Todos os movimentos</h3></div>
            <span>{reconciliationSummary.movement_count} {reconciliationSummary.movement_count === '1' ? 'movimento' : 'movimentos'}</span>
          </div>
          <p className="bank-reconciliation-summary-note">Valores brutos: soma dos valores absolutos; entradas e saídas não se compensam.</p>
          <dl className="bank-reconciliation-summary-grid">
            <div className="bank-reconciliation-summary-card"><dt>Conciliados</dt><dd><strong>{reconciliationSummary.reconciled.count}</strong><span>{formatAmount(reconciliationSummary.reconciled.gross_cents)}</span></dd></div>
            <div className="bank-reconciliation-summary-card"><dt>Pendentes</dt><dd><strong>{reconciliationSummary.pending.count}</strong><span>{formatAmount(reconciliationSummary.pending.gross_cents)}</span></dd></div>
            <div className="bank-reconciliation-summary-card"><dt>Duplicados</dt><dd><strong>{reconciliationSummary.duplicate.count}</strong><span>{formatAmount(reconciliationSummary.duplicate.gross_cents)}</span></dd></div>
          </dl>
        </section>}

        {movementFormOpen && <form className="record-form bank-inline-form" onSubmit={(event) => void saveMovement(event)}>
          <h2 ref={movementFormHeadingRef} tabIndex={-1}>Novo movimento do extrato</h2>
          {movementUncertain && <p className="form-message form-message-warning" role="status">A tentativa anterior pode ter sido concluída. Repita com os mesmos dados para consultar o mesmo identificador de operação, ou cancele o formulário para começar outro registro.</p>}
          <div className="record-form-grid">
            <label className="record-field"><span className="field-label">Conta</span><select className="text-input" disabled={movementUncertain} onChange={(event) => setAccountId(event.target.value)} required value={accountId}><option value="">Selecione</option>{activeAccounts.map((account) => <option key={account.id} value={account.id}>{account.institution_name} · {account.account_label}{account.account_last_four ? ` · final ${account.account_last_four}` : ''}</option>)}</select></label>
            <label className="record-field"><span className="field-label">Tipo de movimento</span><select className="text-input" disabled={movementUncertain} onChange={(event) => setDirection(event.target.value as 'credit' | 'debit')} value={direction}><option value="credit">Entrada</option><option value="debit">Saída</option></select></label>
            <label className="record-field"><span className="field-label">Data no extrato</span><input className="text-input" disabled={movementUncertain} max={today} onChange={(event) => setTransactionDate(event.target.value)} required type="date" value={transactionDate} /></label>
            <label className="record-field"><span className="field-label">Valor</span><input className="text-input" disabled={movementUncertain} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} placeholder="0,00" required value={amount} /></label>
            <label className="record-field record-field-wide"><span className="field-label">Descrição</span><input className="text-input" disabled={movementUncertain} maxLength={200} onChange={(event) => setDescription(event.target.value)} required value={description} /></label>
            <label className="record-field"><span className="field-label">Contraparte <span className="field-optional">(opcional)</span></span><input className="text-input" disabled={movementUncertain} maxLength={160} onChange={(event) => setCounterpartyName(event.target.value)} value={counterpartyName} /></label>
            <label className="record-field record-field-wide"><span className="field-label">Observação <span className="field-optional">(opcional)</span></span><textarea className="text-input record-textarea" disabled={movementUncertain} maxLength={1000} onChange={(event) => setNotes(event.target.value)} value={notes} /></label>
          </div>
          {formError && <p className="form-message form-message-error" role="alert">{formError}</p>}
          <div className="record-form-actions"><button className="button button-primary" disabled={savingMovement || loading || Boolean(loadError)} type="submit">{savingMovement ? 'Registrando…' : movementUncertain ? 'Tentar novamente' : 'Registrar movimento'}</button><button className="text-button" onClick={() => { setMovementFormOpen(false); setMovementUncertain(false); setMovementRequestId(newRequestId()); setFormError(null) }} type="button">Cancelar</button></div>
        </form>}

        {!loading && activeAccounts.length === 0 && <p className="inline-state">Cadastre uma conta bancária ativa para começar a registrar os movimentos.</p>}
        {loading && transactions.length === 0 && !loadError && <p className="inline-state" aria-live="polite">Carregando movimentos…</p>}
        {!loading && !loadError && transactions.length === 0 && <div className="empty-state"><span className="empty-icon"><Icon name="check" /></span><div><h3>Nenhum movimento registrado</h3><p>Quando a integração ou o registro manual do extrato for usado, os lançamentos aparecerão aqui. Nada será conciliado automaticamente.</p></div></div>}

        {transactions.length > 0 && !loadError && <>
          <ul className="bank-movement-list" aria-label="Movimentos bancários">
            {transactions.map((movement) => {
              const match = activeMatchByTransaction.get(movement.id)
              const duplicate = activeDuplicateByTransaction.get(movement.id)
              const previousMatches = matches.filter((row) => row.bank_transaction_id === movement.id && matchReversals.some((reversal) => reversal.match_id === row.id))
              const previousDuplicates = duplicates.filter((row) => row.duplicate_transaction_id === movement.id && duplicateClears.some((clear) => clear.duplicate_id === row.id))
              const duplicateOriginals = transactions.filter((candidate) => candidate.id !== movement.id && candidate.bank_account_id === movement.bank_account_id && candidate.transaction_date === movement.transaction_date && String(candidate.amount_cents) === String(movement.amount_cents) && !activeDuplicateByTransaction.has(candidate.id) && !activeDuplicateOriginalIds.has(candidate.id))
              const account = accountById.get(movement.bank_account_id)
              const linkedId = match?.order_payment_id ?? match?.financial_outflow_id ?? ''
              const linkedLabel = linkedId ? matchLabels[linkedId] ?? `Lançamento ${shortId(linkedId)}` : ''
              const original = duplicate ? transactions.find((row) => row.id === duplicate.original_transaction_id) : null
              return <li className="bank-movement-card" key={movement.id}>
                <div className="bank-movement-main">
                  <div className="bank-movement-copy">
                    <div className="bank-movement-title"><strong id={`bank-movement-title-${movement.id}`} tabIndex={-1}>{movement.description}</strong><span className={duplicate ? 'bank-status bank-status-duplicate' : match ? 'bank-status bank-status-matched' : 'bank-status'}>{duplicate ? 'Duplicado' : match ? 'Conciliado' : 'Pendente'}</span></div>
                    <small>{account ? `${account.institution_name} · ${account.account_label}` : 'Conta sem identificação'} · {formatBusinessDate(movement.transaction_date)} · {sourceLabel(movement.source)}</small>
                    {movement.counterparty_name && <small>Contraparte: {movement.counterparty_name}</small>}
                    {linkedLabel && <p className="bank-match-summary">Vinculado a {linkedLabel}</p>}
                    {duplicate && <p className="bank-match-summary">Duplicado do movimento “{original?.description ?? `#${shortId(duplicate.original_transaction_id)}`}” · {duplicate.reason}</p>}
                    {previousMatches.map((previous) => <p className="bank-history-note" key={previous.id}>Conciliação desfeita: {matchReversals.find((row) => row.match_id === previous.id)?.reason}</p>)}
                    {previousDuplicates.map((previous) => <p className="bank-history-note" key={previous.id}>Sinalização de duplicidade removida: {duplicateClears.find((row) => row.duplicate_id === previous.id)?.reason}</p>)}
                  </div>
                  <div className="bank-movement-value"><strong>{formatAmount(movement.amount_cents)}</strong><small>{movementDirectionLabel(movement.amount_cents)}</small></div>
                </div>
                {!loading && !loadError && <div className="bank-row-actions">
                  {!match && !duplicate && <button className="button button-secondary" onClick={() => void loadCandidates(movement)} type="button">Conciliar</button>}
                  {match && <button className="button button-secondary" onClick={() => { clearActionForms(); returnFocusIdRef.current = `bank-movement-title-${movement.id}`; setUnmatchTarget(match); setUnmatchReason(''); actionRequestRef.current = newRequestId() }} type="button">Desfazer conciliação</button>}
                  {!match && duplicate && <button className="button button-secondary" onClick={() => { clearActionForms(); returnFocusIdRef.current = `bank-movement-title-${movement.id}`; setClearDuplicateTarget(duplicate); setClearDuplicateReason(''); setClearDuplicateRequestId(newRequestId()) }} type="button">Restaurar movimento</button>}
                  {!match && !duplicate && duplicateOriginals.length > 0 && <button className="text-button" onClick={() => { clearActionForms(); returnFocusIdRef.current = `bank-movement-title-${movement.id}`; setDuplicateTarget(movement); setDuplicateOriginalId(duplicateOriginals[0].id); setDuplicateReason(''); setDuplicateRequestId(newRequestId()) }} type="button">Sinalizar duplicado</button>}
                </div>}

                {candidateTarget?.id === movement.id && <section className="bank-action-panel" aria-labelledby={`candidate-title-${movement.id}`}>
                  <div className="section-heading"><div><p className="eyebrow">CONFERÊNCIA MANUAL</p><h3 id={`candidate-title-${movement.id}`} ref={candidateHeadingRef} tabIndex={-1}>Escolha o lançamento correspondente</h3></div><button className="text-button" onClick={closeActionForms} type="button">Fechar</button></div>
                  <p className="section-footnote">Sugestões com o mesmo valor, até 45 dias antes ou depois da data bancária. Confira os detalhes; nenhuma conciliação ocorre sem sua confirmação.</p>
                  {candidatesLoading && <p className="inline-state" aria-live="polite">Buscando recebimentos e saídas do mesmo valor…</p>}
                  {candidateError && <p className="form-message form-message-error" role="alert">{candidateError}</p>}
                  {candidateError && <button className="button button-secondary" onClick={() => void loadCandidates(movement)} type="button">Tentar novamente</button>}
                  {!candidatesLoading && !candidateError && candidates.length === 0 && <p className="inline-state">Nenhum lançamento aberto de mesmo valor foi encontrado nesta janela de datas.</p>}
                  {!candidatesLoading && candidates.length > 0 && <>
                    <p className="section-footnote" role="status">Exibindo {Math.min(candidateLimit, candidates.length)} de {candidates.length} sugestões com o mesmo valor.</p>
                    <ul className="bank-candidate-list">{candidates.slice(0, candidateLimit).map((candidate) => <li key={`${candidate.kind}-${candidate.id}`}><div><strong>{candidate.title}</strong><small>{candidate.detail} · {formatBusinessDate(candidate.date)} · {candidate.kind === 'receipt' ? 'Recebimento' : 'Saída paga'}</small></div><strong>{formatAmount(candidate.amount_cents)}</strong><button className="button button-primary" disabled={actionSaving || loading || Boolean(loadError)} onClick={() => void confirmMatch(candidate)} type="button">{actionSaving ? 'Salvando…' : 'Confirmar'}</button></li>)}</ul>
                    {candidates.length > candidateLimit && <button className="button button-secondary" disabled={actionSaving || loading || Boolean(loadError)} onClick={() => setCandidateLimit((limit) => limit + 20)} type="button">Mostrar mais sugestões</button>}
                  </>}
                  {actionError && <p className="form-message form-message-error" role="alert">{actionError}</p>}
                </section>}

                {unmatchTarget?.id === match?.id && <form className="bank-action-panel bank-reason-form" onSubmit={(event) => void confirmUnmatch(event)}>
                  <h3 ref={unmatchHeadingRef} tabIndex={-1}>Desfazer conciliação</h3><p className="section-footnote">O vínculo será encerrado e o motivo ficará no histórico.</p>
                  <label className="record-field"><span className="field-label">Motivo</span><textarea className="text-input record-textarea" maxLength={500} onChange={(event) => setUnmatchReason(event.target.value)} required value={unmatchReason} /></label>
                  {actionError && <p className="form-message form-message-error" role="alert">{actionError}</p>}
                  <div className="record-form-actions"><button className="button button-primary" disabled={actionSaving || loading || Boolean(loadError)} type="submit">{actionSaving ? 'Salvando…' : 'Confirmar e desfazer'}</button><button className="text-button" onClick={closeActionForms} type="button">Cancelar</button></div>
                </form>}

                {duplicateTarget?.id === movement.id && <form className="bank-action-panel bank-reason-form" onSubmit={(event) => void confirmDuplicate(event)}>
                  <h3 ref={duplicateHeadingRef} tabIndex={-1}>Sinalizar lançamento duplicado</h3><p className="section-footnote">A comparação inicial considera mesma conta, data e valor. Confira antes de retirar o movimento das sugestões.</p>
                  <label className="record-field"><span className="field-label">Movimento original</span><select className="text-input" onChange={(event) => setDuplicateOriginalId(event.target.value)} required value={duplicateOriginalId}>{duplicateOriginals.map((row) => <option key={row.id} value={row.id}>{row.description} · {formatBusinessDate(row.transaction_date)} · {formatAmount(row.amount_cents)}</option>)}</select></label>
                  <label className="record-field"><span className="field-label">Motivo</span><textarea className="text-input record-textarea" maxLength={500} onChange={(event) => setDuplicateReason(event.target.value)} required value={duplicateReason} /></label>
                  {actionError && <p className="form-message form-message-error" role="alert">{actionError}</p>}
                  <div className="record-form-actions"><button className="button button-primary" disabled={actionSaving || loading || Boolean(loadError)} type="submit">{actionSaving ? 'Salvando…' : 'Sinalizar como duplicado'}</button><button className="text-button" onClick={closeActionForms} type="button">Cancelar</button></div>
                </form>}

                {clearDuplicateTarget?.duplicate_transaction_id === movement.id && <form className="bank-action-panel bank-reason-form" onSubmit={(event) => void confirmClearDuplicate(event)}>
                  <h3 ref={clearDuplicateHeadingRef} tabIndex={-1}>Restaurar movimento</h3><p className="section-footnote">A sinalização será removida e o motivo permanecerá no histórico.</p>
                  <label className="record-field"><span className="field-label">Motivo</span><textarea className="text-input record-textarea" maxLength={500} onChange={(event) => setClearDuplicateReason(event.target.value)} required value={clearDuplicateReason} /></label>
                  {actionError && <p className="form-message form-message-error" role="alert">{actionError}</p>}
                  <div className="record-form-actions"><button className="button button-primary" disabled={actionSaving || loading || Boolean(loadError)} type="submit">{actionSaving ? 'Salvando…' : 'Restaurar movimento'}</button><button className="text-button" onClick={closeActionForms} type="button">Cancelar</button></div>
                </form>}
              </li>
            })}
          </ul>
          <div className="bank-history-pagination" aria-label="Paginação de movimentos">
            <span>{firstRecord}–{lastRecord} de {total} movimentos</span>
            <div><button className="button button-secondary" disabled={loading || page === 0} onClick={() => void loadData(page - 1)} type="button">Anterior</button><button className="button button-secondary" disabled={loading || !hasMore} onClick={() => void loadData(page + 1)} type="button">Próxima</button></div>
          </div>
        </>}

        {loadError && transactions.length > 0 && <p className="inline-state inline-state-error">A lista anterior está desatualizada e as ações de conciliação estão suspensas.</p>}
      </section>

      <p className="section-footnote bank-scope-note">Movimentos manuais não alteram recebimentos, despesas ou o resultado gerencial. O relatório bancário só poderá ser considerado conciliado após importar ou consultar uma fonte bancária aprovada.</p>
    </div>
  )
}

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
