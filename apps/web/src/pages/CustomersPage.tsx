import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { canManageBusiness, useBusiness } from '../business/BusinessContext'
import { Icon } from '../components/Icon'
import { formatBRL, parseBrazilianCurrency } from '../lib/formatters'
import { searchCustomers, toInternationalPhone } from '../lib/customer-search.mjs'
import { supabaseClient } from '../lib/supabase'

const PHONE_COUNTRIES = [
  { iso: 'BR', flag: '🇧🇷', name: 'Brasil', callingCode: '55' },
  { iso: 'US', flag: '🇺🇸', name: 'Estados Unidos', callingCode: '1' },
  { iso: 'CA', flag: '🇨🇦', name: 'Canadá', callingCode: '1' },
  { iso: 'PT', flag: '🇵🇹', name: 'Portugal', callingCode: '351' },
  { iso: 'AR', flag: '🇦🇷', name: 'Argentina', callingCode: '54' },
  { iso: 'UY', flag: '🇺🇾', name: 'Uruguai', callingCode: '598' },
  { iso: 'PY', flag: '🇵🇾', name: 'Paraguai', callingCode: '595' },
  { iso: 'BO', flag: '🇧🇴', name: 'Bolívia', callingCode: '591' },
  { iso: 'CL', flag: '🇨🇱', name: 'Chile', callingCode: '56' },
  { iso: 'CO', flag: '🇨🇴', name: 'Colômbia', callingCode: '57' },
  { iso: 'PE', flag: '🇵🇪', name: 'Peru', callingCode: '51' },
  { iso: 'MX', flag: '🇲🇽', name: 'México', callingCode: '52' },
  { iso: 'GB', flag: '🇬🇧', name: 'Reino Unido', callingCode: '44' },
  { iso: 'ES', flag: '🇪🇸', name: 'Espanha', callingCode: '34' },
  { iso: 'IT', flag: '🇮🇹', name: 'Itália', callingCode: '39' },
  { iso: 'FR', flag: '🇫🇷', name: 'França', callingCode: '33' },
  { iso: 'DE', flag: '🇩🇪', name: 'Alemanha', callingCode: '49' },
  { iso: 'JP', flag: '🇯🇵', name: 'Japão', callingCode: '81' },
  { iso: 'CN', flag: '🇨🇳', name: 'China', callingCode: '86' },
  { iso: 'AU', flag: '🇦🇺', name: 'Austrália', callingCode: '61' },
  { iso: 'IE', flag: '🇮🇪', name: 'Irlanda', callingCode: '353' },
  { iso: 'NL', flag: '🇳🇱', name: 'Países Baixos', callingCode: '31' },
  { iso: 'CH', flag: '🇨🇭', name: 'Suíça', callingCode: '41' },
  { iso: 'ZA', flag: '🇿🇦', name: 'África do Sul', callingCode: '27' },
  { iso: 'AO', flag: '🇦🇴', name: 'Angola', callingCode: '244' },
  { iso: 'MZ', flag: '🇲🇿', name: 'Moçambique', callingCode: '258' },
  { iso: 'IL', flag: '🇮🇱', name: 'Israel', callingCode: '972' },
  { iso: 'AE', flag: '🇦🇪', name: 'Emirados Árabes Unidos', callingCode: '971' },
  { iso: 'IN', flag: '🇮🇳', name: 'Índia', callingCode: '91' },
] as const

type CepAddress = { street: string; neighborhood: string; city: string; state: string }

async function fetchCepProvider(url: string, parentSignal: AbortSignal) {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort()
  parentSignal.addEventListener('abort', abortFromParent, { once: true })
  if (parentSignal.aborted) controller.abort()
  const timeout = window.setTimeout(() => controller.abort(), 4500)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    window.clearTimeout(timeout)
    parentSignal.removeEventListener('abort', abortFromParent)
  }
}

async function lookupCepAddress(value: string, signal: AbortSignal): Promise<CepAddress> {
  const cep = value.replace(/\D/g, '')
  const endpoints = [
    { url: `https://brasilapi.com.br/api/cep/v2/${cep}`, read: (data: Record<string, unknown>) => ({ street: data.street, neighborhood: data.neighborhood, city: data.city, state: data.state }) },
    { url: `https://viacep.com.br/ws/${cep}/json/`, read: (data: Record<string, unknown>) => ({ street: data.logradouro, neighborhood: data.bairro, city: data.localidade, state: data.uf }) },
  ]
  for (const endpoint of endpoints) {
    try {
      const response = await fetchCepProvider(endpoint.url, signal)
      if (!response.ok) continue
      const data = await response.json() as Record<string, unknown>
      if (data.erro) continue
      const address = endpoint.read(data)
      const result = {
        street: typeof address.street === 'string' ? address.street.trim() : '',
        neighborhood: typeof address.neighborhood === 'string' ? address.neighborhood.trim() : '',
        city: typeof address.city === 'string' ? address.city.trim() : '',
        state: typeof address.state === 'string' ? address.state.trim() : '',
      }
      if (result.street || result.neighborhood || result.city || result.state) return result
    } catch (error) {
      if (signal.aborted) throw error
    }
  }
  throw new Error('CEP não encontrado ou serviço indisponível.')
}

function formatCepAddress(address: CepAddress, cep: string) {
  return [address.street, address.neighborhood, [address.city, address.state].filter(Boolean).join(' - '), cep]
    .filter(Boolean)
    .join(', ')
}

type Customer = {
  id: string
  name: string
  phone: string | null
  whatsapp_phone: string | null
  delivery_address: string | null
  created_at: string
  is_active: boolean
  is_arariboia: boolean
  arariboia_limit_cents: number | null
  open_balance_cents: number | null
}
type CustomerOpenBalance = { customer_id: string; balance_cents: number | string }
type PhoneMatch = { id: string; name: string; matched_phone_masked: string }

function getWhatsAppChatUrl(value: string) {
  const trimmed = value.trim()
  const digits = trimmed.replace(/\D/g, '')
  return trimmed.startsWith('+') && digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0')
    ? `https://wa.me/${digits}`
    : null
}

export function CustomersPage() {
  const { id: businessId, role } = useBusiness()
  const canViewBalances = canManageBusiness(role)
  const navigate = useNavigate()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [loading, setLoading] = useState(true)
  const [balancesUnavailable, setBalancesUnavailable] = useState(!canViewBalances)
  const [saving, setSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [isArariboia, setIsArariboia] = useState(false)
  const [arariboiaLimit, setArariboiaLimit] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [phone, setPhone] = useState('')
  const [phoneCountryIso, setPhoneCountryIso] = useState('BR')
  const [customPhoneCallingCode, setCustomPhoneCallingCode] = useState('')
  const [phoneIsWhatsApp, setPhoneIsWhatsApp] = useState(true)
  const [showDifferentWhatsapp, setShowDifferentWhatsapp] = useState(false)
  const [whatsappPhone, setWhatsappPhone] = useState('')
  const [whatsappCountryIso, setWhatsappCountryIso] = useState('BR')
  const [customWhatsappCallingCode, setCustomWhatsappCallingCode] = useState('')
  const [showOptionalDetails, setShowOptionalDetails] = useState(false)
  const [cep, setCep] = useState('')
  const [cepStatus, setCepStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [cepResultAddress, setCepResultAddress] = useState('')
  const [cepRetry, setCepRetry] = useState(0)
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [addressEdited, setAddressEdited] = useState(false)
  const [phoneMatches, setPhoneMatches] = useState<PhoneMatch[]>([])
  const [phoneLookupBusy, setPhoneLookupBusy] = useState(false)
  const [phoneLookupUnavailable, setPhoneLookupUnavailable] = useState(false)
  const [duplicateConfirmation, setDuplicateConfirmation] = useState('')
  const [lookupUnavailableConfirmed, setLookupUnavailableConfirmed] = useState(false)
  const phoneLookupSequence = useRef(0)
  const addressEditedRef = useRef(false)
  const phoneCountry = PHONE_COUNTRIES.find((country) => country.iso === phoneCountryIso)
    ?? { iso: 'OTHER', flag: '🌐', name: 'Outro país', callingCode: customPhoneCallingCode.replace(/\D/g, '').slice(0, 3) }
  const whatsappCountry = PHONE_COUNTRIES.find((country) => country.iso === whatsappCountryIso)
    ?? { iso: 'OTHER', flag: '🌐', name: 'Outro país', callingCode: customWhatsappCallingCode.replace(/\D/g, '').slice(0, 3) }
  const internationalPhone = toInternationalPhone(phoneCountry.callingCode, phone)
  const internationalWhatsapp = phoneIsWhatsApp ? internationalPhone : toInternationalPhone(whatsappCountry.callingCode, whatsappPhone)

  function clearPhoneLookupState() {
    setDuplicateConfirmation('')
    setLookupUnavailableConfirmed(false)
    setPhoneMatches([])
    setPhoneLookupUnavailable(false)
    setPhoneLookupBusy(false)
  }

  function applyCepAddress() {
    if (!cepResultAddress) return
    setDeliveryAddress(cepResultAddress)
    setAddressEdited(false)
    addressEditedRef.current = false
  }

  const lookupPotentialDuplicates = useCallback(async () => {
    if (!supabaseClient) return { data: [] as PhoneMatch[], error: new Error('Conexão indisponível.') }
    const localPhone = phoneCountry.iso === 'BR' ? phone.replace(/\D/g, '') : internationalPhone
    const localWhatsapp = phoneIsWhatsApp
      ? localPhone
      : whatsappCountry.iso === 'BR' ? whatsappPhone.replace(/\D/g, '') : internationalWhatsapp
    const internationalRequest = supabaseClient.rpc('find_customer_phone_matches', { p_phone: internationalPhone, p_whatsapp_phone: internationalWhatsapp })
    const localRequest = localPhone === internationalPhone && localWhatsapp === internationalWhatsapp
      ? internationalRequest
      : supabaseClient.rpc('find_customer_phone_matches', { p_phone: localPhone, p_whatsapp_phone: localWhatsapp })
    const [internationalLookup, localLookup] = await Promise.all([internationalRequest, localRequest])
    const error = internationalLookup.error ?? localLookup.error
    const data = ([...new Map([...(internationalLookup.data ?? []), ...(localLookup.data ?? [])].map((match) => [match.id, match])).values()] as PhoneMatch[])
      .sort((left, right) => left.name.localeCompare(right.name, 'pt-BR') || left.id.localeCompare(right.id))
      .slice(0, 5)
    return { data, error }
  }, [internationalPhone, internationalWhatsapp, phone, phoneCountry.iso, phoneIsWhatsApp, whatsappCountry.iso, whatsappPhone])

  // CEP is only sent to public Brazilian postal-code providers after all 8 digits are entered.
  useEffect(() => {
    const digits = cep.replace(/\D/g, '')
    if (!showForm || digits.length !== 8) return
    const controller = new AbortController()
    let active = true
    let abortTimeout: number | undefined
    const timeout = window.setTimeout(async () => {
      setCepStatus('loading')
      setCepResultAddress('')
      abortTimeout = window.setTimeout(() => controller.abort(), 10000)
      try {
        const address = await lookupCepAddress(digits, controller.signal)
        if (!active) return
        const formatted = formatCepAddress(address, digits)
        setCepResultAddress(formatted)
        if (!addressEditedRef.current) {
          setDeliveryAddress(formatted)
          setAddressEdited(false)
          addressEditedRef.current = false
        }
        setCepStatus('success')
      } catch {
        if (!active) return
        setCepStatus('error')
      } finally {
        window.clearTimeout(abortTimeout)
      }
    }, cepRetry ? 0 : 450)
    return () => {
      active = false
      controller.abort()
      window.clearTimeout(timeout)
      if (abortTimeout !== undefined) window.clearTimeout(abortTimeout)
    }
  }, [cep, cepRetry, showForm])

  const loadCustomers = useCallback(async () => {
    if (!supabaseClient) {
      setError('Conexão indisponível. Tente novamente.')
      setBalancesUnavailable(true)
      setLoading(false)
      return
    }
    try {
      const [customerResult, balanceResult] = await Promise.all([
        supabaseClient
          .from('customers')
          .select('id, name, phone, whatsapp_phone, delivery_address, created_at, is_active, is_arariboia, arariboia_limit_cents')
          .eq('business_id', businessId)
          .eq('is_active', !showArchived)
          .order('name', { ascending: true }),
        canViewBalances
          ? supabaseClient.rpc('get_customer_open_balances', { p_business_id: businessId })
          : Promise.resolve({ data: null, error: null }),
      ])

      if (customerResult.error) {
        setError('Não foi possível carregar os clientes. Tente novamente.')
        setBalancesUnavailable(true)
      } else {
        let nextBalancesUnavailable = !canViewBalances || Boolean(balanceResult.error)
        const balanceByCustomer = new Map<string, number>()
        for (const row of (balanceResult.data ?? []) as CustomerOpenBalance[]) {
          const balance = Number(row.balance_cents)
          if (!Number.isSafeInteger(balance) || balance < 0) {
            nextBalancesUnavailable = true
            break
          }
          balanceByCustomer.set(row.customer_id, balance)
        }
        setBalancesUnavailable(nextBalancesUnavailable)
        setCustomers(((customerResult.data ?? []) as Omit<Customer, 'open_balance_cents'>[]).map((customer) => ({
          ...customer,
          open_balance_cents: nextBalancesUnavailable ? null : balanceByCustomer.get(customer.id) ?? 0,
        })))
        setError(null)
      }
    } catch {
      setError('Não foi possível carregar os clientes. Tente novamente.')
      setBalancesUnavailable(true)
    } finally {
      setLoading(false)
    }
  }, [businessId, canViewBalances, showArchived])

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadCustomers() }, [loadCustomers])

  useEffect(() => {
    const phoneDigits = internationalPhone.replace(/\D/g, '')
    const whatsappDigits = internationalWhatsapp.replace(/\D/g, '')
    const hasSearchableNumber = [phoneDigits, whatsappDigits].some((digits) => digits.length >= 8 && digits.length <= 15)
    if (!showForm || !hasSearchableNumber || !supabaseClient) return
    let active = true
    const requestId = ++phoneLookupSequence.current
    const timeout = window.setTimeout(async () => {
      setPhoneLookupBusy(true)
      try {
        const { data, error: lookupError } = await lookupPotentialDuplicates()
        if (!active || requestId !== phoneLookupSequence.current) return
        if (lookupError) {
          setPhoneMatches([])
          setPhoneLookupUnavailable(true)
        } else {
          setPhoneMatches((data ?? []) as PhoneMatch[])
          setPhoneLookupUnavailable(false)
        }
      } catch {
        if (!active || requestId !== phoneLookupSequence.current) return
        setPhoneMatches([])
        setPhoneLookupUnavailable(true)
      } finally {
        if (active && requestId === phoneLookupSequence.current) setPhoneLookupBusy(false)
      }
    }, 350)
    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [internationalPhone, internationalWhatsapp, lookupPotentialDuplicates, phoneLookupSequence, showForm])

  const filteredCustomers = useMemo(() => {
    return searchCustomers(customers, search, customers.length)
  }, [customers, search])
  const displayedCustomers = useMemo(() => [...filteredCustomers].sort((left, right) =>
    (right.open_balance_cents ?? -1) - (left.open_balance_cents ?? -1) || left.name.localeCompare(right.name, 'pt-BR'),
  ), [filteredCustomers])
  const totalOpenBalance = useMemo(() => customers.reduce((total, customer) => total + (customer.open_balance_cents ?? 0), 0), [customers])
  const customersWithBalance = useMemo(() => customers.filter((customer) => (customer.open_balance_cents ?? 0) > 0).length, [customers])
  const phoneMatchSignature = phoneMatches.map((match) => match.id).sort().join('|')

  async function handleCreateCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const arariboiaLimitCents = isArariboia ? parseBrazilianCurrency(String(form.get('arariboia_limit') ?? '')) : null
    const phoneWasEntered = phone.trim().length > 0
    const whatsappWasEntered = showDifferentWhatsapp && whatsappPhone.trim().length > 0
    const normalizedWhatsappPhone = internationalWhatsapp
    const normalizedPhone = internationalPhone
    if (!name) {
      setSaveError('Informe o nome do cliente.')
      return
    }
    if (isArariboia && Number.isNaN(arariboiaLimitCents)) {
      setSaveError('Confira o limite do cartão. Use um valor como 600,00.')
      return
    }
    if ((phoneCountry.iso === 'OTHER' && phoneWasEntered && !/^[1-9]\d{0,2}$/.test(phoneCountry.callingCode))
      || (whatsappCountry.iso === 'OTHER' && whatsappWasEntered && !/^[1-9]\d{0,2}$/.test(whatsappCountry.callingCode))) {
      setSaveError('Informe o DDI com até três dígitos para o país selecionado.')
      return
    }
    if (normalizedWhatsappPhone && !getWhatsAppChatUrl(normalizedWhatsappPhone)) {
      setSaveError('Confira o telefone e o código do país selecionados.')
      return
    }
    const enteredNumbers = [normalizedPhone, normalizedWhatsappPhone].filter(Boolean)
    if (enteredNumbers.some((value) => {
      const digits = value.replace(/\D/g, '')
      return digits.length < 8 || digits.length > 15
    })) {
      setSaveError('Confira o DDD e o número. O telefone precisa ter entre 8 e 15 dígitos com o código do país.')
      return
    }

    const phoneDigits = normalizedPhone.replace(/\D/g, '')
    const whatsappDigits = normalizedWhatsappPhone.replace(/\D/g, '')
    const hasSearchableNumber = [phoneDigits, whatsappDigits].some((digits) => digits.length >= 8 && digits.length <= 15)
    if (hasSearchableNumber && !lookupUnavailableConfirmed) {
      setSaving(true)
      setSaveError(null)
      try {
        const { data, error: lookupError } = await lookupPotentialDuplicates()
        if (lookupError) {
          setPhoneLookupUnavailable(true)
          if (!lookupUnavailableConfirmed) {
            setSaveError('Não foi possível concluir a busca agora. Confira se o telefone pertence a outra pessoa e confirme se quer continuar mesmo sem a verificação.')
            return
          }
        } else {
          const matches = data
          const signature = matches.map((match) => match.id).sort().join('|')
          setPhoneMatches(matches)
          setPhoneLookupUnavailable(false)
          if (signature && duplicateConfirmation !== signature) {
            setDuplicateConfirmation('')
            setSaveError('Encontramos cadastros com este telefone. Confira os nomes e confirme abaixo se é outra pessoa para continuar.')
            return
          }
        }
      } catch {
        setPhoneLookupUnavailable(true)
        if (!lookupUnavailableConfirmed) {
          setSaveError('Não foi possível concluir a busca agora. Confira se o telefone pertence a outra pessoa e confirme se quer continuar mesmo sem a verificação.')
          return
        }
      } finally {
        setSaving(false)
      }
    }

    setSaving(true)
    setSaveError(null)
    try {
      const { data, error: insertError } = await supabaseClient
        .from('customers')
        .insert({
          business_id: businessId,
          name,
          phone: normalizedPhone || null,
          whatsapp_phone: normalizedWhatsappPhone || null,
          delivery_address: deliveryAddress.trim() || null,
          is_arariboia: isArariboia,
          arariboia_limit_cents: arariboiaLimitCents,
        })
        .select('id')
        .single()

      if (insertError || !data) {
        setSaveError('Não foi possível salvar. Seus dados continuam no formulário; tente novamente.')
        return
      }
      navigate(`/clientes/${data.id}`)
    } catch {
      setSaveError('Não foi possível salvar. Seus dados continuam no formulário; tente novamente.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page-stack customers-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">RELACIONAMENTO</p>
          <h1>Clientes</h1>
          <p className="page-description">Cadastros e valores em aberto.</p>
        </div>
        <div className="record-heading-actions">
          <button className="button button-primary" disabled={saving} onClick={() => { setShowForm((value) => !value); setIsArariboia(false); setArariboiaLimit(''); setSaveError(null); clearPhoneLookupState(); setPhone(''); setPhoneCountryIso('BR'); setCustomPhoneCallingCode(''); setPhoneIsWhatsApp(true); setShowDifferentWhatsapp(false); setWhatsappPhone(''); setWhatsappCountryIso('BR'); setCustomWhatsappCallingCode(''); setShowOptionalDetails(false); setCep(''); setCepStatus('idle'); setCepResultAddress(''); setDeliveryAddress(''); setAddressEdited(false); addressEditedRef.current = false }} type="button">
            <Icon name="plus" /> {showForm ? 'Fechar' : 'Novo cliente'}
          </button>
        </div>
      </header>


      <section className="surface-panel record-panel customer-list-panel" aria-labelledby="customer-list-title">
        <div className="section-heading section-heading-compact">
          <div><p className="eyebrow">CADASTROS</p><h2 id="customer-list-title">{showArchived ? 'Clientes arquivados' : 'Clientes ativos'}</h2></div>
          <div className="record-heading-actions"><span className="neutral-status">{customers.length} {customers.length === 1 ? 'cadastro' : 'cadastros'}</span><button className="text-button" onClick={() => { setLoading(true); setError(null); setShowArchived((value) => !value) }} type="button">{showArchived ? 'Ver ativos' : 'Ver arquivados'}</button></div>
        </div>
        <div className={`customer-debt-summary${!loading && !error && !balancesUnavailable ? totalOpenBalance > 0 ? ' has-open-balance' : ' is-clear' : ''}`} aria-label="Resumo dos valores em aberto" aria-live="polite">
          <div><span>Falta receber</span><strong>{loading || error || balancesUnavailable ? '—' : formatBRL(totalOpenBalance)}</strong></div>
          <small>{loading ? 'Carregando saldos…' : error || balancesUnavailable ? 'Saldo indisponível' : `${customersWithBalance} ${customersWithBalance === 1 ? 'cliente deve' : 'clientes devem'}`}</small>
        </div>
        <label className="search-field">
          <Icon name="search" />
          <span className="visually-hidden">Buscar clientes por nome, telefone ou WhatsApp</span>
          <input onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nome, telefone ou WhatsApp" value={search} />
        </label>

        {loading ? <p className="inline-state" aria-live="polite">Carregando clientes…</p> : null}
        {!loading && error && (
          <div className="inline-state inline-state-error" role="alert">
            <p>{error}</p><button className="text-button" onClick={() => { setLoading(true); void loadCustomers() }} type="button">Tentar novamente</button>
          </div>
        )}
        {!loading && !error && customers.length === 0 && (
          <div className="module-empty-panel record-empty">
            <span className="empty-icon"><Icon name="people" /></span>
            <h2>{showArchived ? 'Nenhum cliente arquivado' : 'Nenhum cliente cadastrado'}</h2>
            <p>{showArchived ? 'Os cadastros arquivados continuam disponíveis para consulta.' : 'Cadastre o primeiro cliente pelo nome.'}</p>
            {!showArchived && <button className="button button-primary" onClick={() => setShowForm(true)} type="button">Cadastrar primeiro cliente</button>}
          </div>
        )}
        {!loading && !error && customers.length > 0 && filteredCustomers.length === 0 && (
          <div className="inline-state"><p>Nenhum cliente corresponde à busca.</p><button className="text-button" onClick={() => setSearch('')} type="button">Limpar busca</button></div>
        )}
        {!loading && !error && displayedCustomers.length > 0 && (
          <div className="customer-debt-table-wrap">
            <table className="customer-debt-table">
              <caption className="visually-hidden">Saldo de cada cliente</caption>
              <thead><tr><th scope="col">Cliente</th><th scope="col">Falta receber</th><th scope="col">Situação</th></tr></thead>
              <tbody>{displayedCustomers.map((customer) => (
                <tr key={customer.id}>
                  <td data-label="Cliente">
                    <Link className="customer-debt-customer" to={`/clientes/${customer.id}`}>
                      <span className="record-avatar" aria-hidden="true">{customer.name.slice(0, 1).toLocaleUpperCase('pt-BR')}</span>
                      <span><strong>{customer.name}</strong><small>{customer.phone || (customer.whatsapp_phone ? `WhatsApp: ${customer.whatsapp_phone}` : 'Telefone não informado')}{customer.is_arariboia ? ` · Arariboia${customer.arariboia_limit_cents === null ? '' : ` · limite de referência ${formatBRL(customer.arariboia_limit_cents)}`}` : ''}</small></span>
                    </Link>
                  </td>
                  <td className={`customer-debt-amount${customer.open_balance_cents === null ? '' : customer.open_balance_cents > 0 ? ' has-open-balance' : ' is-clear'}`} data-label="Falta receber">{customer.open_balance_cents === null ? '—' : formatBRL(customer.open_balance_cents)}</td>
                  <td data-label="Situação"><span className={`customer-debt-status ${customer.open_balance_cents === null ? '' : customer.open_balance_cents > 0 ? 'customer-debt-status-open' : 'customer-debt-status-clear'}`}>{customer.open_balance_cents === null ? 'Indisponível' : customer.open_balance_cents > 0 ? 'Deve' : 'Não deve'}</span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      {showForm && (
        <form className="surface-panel record-form customer-create-form" onSubmit={handleCreateCustomer}>
          <div className="section-heading section-heading-compact">
            <div><p className="eyebrow">CADASTRO RÁPIDO</p><h2>Novo cliente</h2></div>
          </div>
          <div className="record-form-grid">
            <label className="record-field record-field-wide">
              <span className="field-label">Nome <span aria-hidden="true">*</span></span>
              <input autoFocus className="text-input" disabled={saving} maxLength={160} name="name" required />
            </label>
            <label className="record-checkbox record-field-wide"><input checked={isArariboia} disabled={saving} onChange={(event) => setIsArariboia(event.target.checked)} type="checkbox" /><span><strong>Cliente Arariboia</strong></span></label>
            {isArariboia && <label className="record-field"><span className="field-label">Limite de referência <span className="field-optional">opcional</span></span><input className="text-input" disabled={saving} inputMode="decimal" maxLength={18} name="arariboia_limit" onChange={(event) => setArariboiaLimit(event.target.value)} placeholder="R$ 600,00" value={arariboiaLimit} /></label>}
            <div className="record-field record-field-wide">
              <span className="field-label" id="customer-phone-label">Telefone ou WhatsApp <span className="field-optional">opcional</span></span>
              <div className={`customer-phone-row${phoneCountry.iso === 'OTHER' ? ' customer-phone-row-custom' : ''}`}>
                <label className="visually-hidden" htmlFor="customer-phone-country">País do telefone</label>
                <select className="text-input customer-country-select" disabled={saving} id="customer-phone-country" onChange={(event) => { setPhoneCountryIso(event.target.value); clearPhoneLookupState() }} value={phoneCountry.iso}>
                  {PHONE_COUNTRIES.map((country) => <option key={country.iso} value={country.iso}>{country.flag} {country.name} (+{country.callingCode})</option>)}
                  <option value="OTHER">🌐 Outro país</option>
                </select>
                {phoneCountry.iso === 'OTHER' && <input aria-label="Código do país" className="text-input customer-calling-code" disabled={saving} inputMode="numeric" maxLength={3} onChange={(event) => { setCustomPhoneCallingCode(event.target.value); clearPhoneLookupState() }} placeholder="DDI" value={customPhoneCallingCode} />}
                <input aria-labelledby="customer-phone-label" autoComplete="tel-national" className="text-input" disabled={saving} inputMode="tel" maxLength={32} onChange={(event) => { setPhone(event.target.value); clearPhoneLookupState() }} placeholder="DDD + número" type="tel" value={phone} />
              </div>
            </div>
            <label className="record-checkbox record-field-wide customer-same-whatsapp"><input checked={phoneIsWhatsApp} disabled={saving || !phone.trim()} onChange={(event) => { setPhoneIsWhatsApp(event.target.checked); clearPhoneLookupState() }} type="checkbox" /><span><strong>Usar também como WhatsApp</strong></span></label>
            {!showDifferentWhatsapp && <div className="record-field record-field-wide"><button className="text-button customer-add-whatsapp" onClick={() => { setPhoneIsWhatsApp(false); setShowDifferentWhatsapp(true); clearPhoneLookupState() }} type="button">Adicionar outro WhatsApp</button></div>}
            {!phoneIsWhatsApp && showDifferentWhatsapp && <div className="record-field record-field-wide">
              <span className="field-label" id="customer-whatsapp-label">WhatsApp diferente <span className="field-optional">opcional</span></span>
              <div className={`customer-phone-row${whatsappCountry.iso === 'OTHER' ? ' customer-phone-row-custom' : ''}`}>
                <label className="visually-hidden" htmlFor="customer-whatsapp-country">País do WhatsApp</label>
                <select className="text-input customer-country-select" disabled={saving} id="customer-whatsapp-country" onChange={(event) => { setWhatsappCountryIso(event.target.value); clearPhoneLookupState() }} value={whatsappCountry.iso}>
                  {PHONE_COUNTRIES.map((country) => <option key={country.iso} value={country.iso}>{country.flag} {country.name} (+{country.callingCode})</option>)}
                  <option value="OTHER">🌐 Outro país</option>
                </select>
                {whatsappCountry.iso === 'OTHER' && <input aria-label="Código do país do WhatsApp" className="text-input customer-calling-code" disabled={saving} inputMode="numeric" maxLength={3} onChange={(event) => { setCustomWhatsappCallingCode(event.target.value); clearPhoneLookupState() }} placeholder="DDI" value={customWhatsappCallingCode} />}
                <input aria-labelledby="customer-whatsapp-label" autoComplete="tel-national" className="text-input" disabled={saving} inputMode="tel" maxLength={32} onChange={(event) => { setWhatsappPhone(event.target.value); clearPhoneLookupState() }} placeholder="DDD + número" type="tel" value={whatsappPhone} />
              </div>
            </div>}
            <div className="record-field record-field-wide customer-optional-details">
              <button aria-expanded={showOptionalDetails} className="text-button" onClick={() => setShowOptionalDetails((value) => !value)} type="button">{showOptionalDetails ? 'Ocultar endereço' : 'Adicionar endereço'}</button>
              {showOptionalDetails && <div className="record-form-grid customer-optional-grid">
                <label className="record-field record-field-wide">
                  <span className="field-label">CEP <span className="field-optional">opcional</span></span>
                  <input autoComplete="postal-code" className="text-input" disabled={saving} inputMode="numeric" maxLength={9} onChange={(event) => { if (cepResultAddress && !addressEditedRef.current) { setDeliveryAddress(''); setAddressEdited(false) } setCep(event.target.value); setCepRetry(0); setCepStatus('idle'); setCepResultAddress('') }} placeholder="00000-000" value={cep} />
                  <span className="customer-whatsapp-hint">Buscamos o endereço pelo CEP.</span>
                </label>
                {cepStatus === 'loading' && <p className="inline-state" aria-live="polite">Buscando endereço pelo CEP…</p>}
                {cepStatus === 'error' && <div className="form-message form-message-warning" role="status"><span>Não foi possível localizar este CEP. {addressEdited ? 'Seu endereço digitado foi mantido.' : 'Você pode digitar o endereço normalmente.'}</span><button className="text-button" onClick={() => setCepRetry((value) => value + 1)} type="button">Tentar novamente</button></div>}
                {cepStatus === 'success' && addressEdited && <div className="form-message form-message-success" role="status"><span>Encontramos o endereço para este CEP.</span><button className="text-button" onClick={applyCepAddress} type="button">Usar endereço encontrado</button></div>}
                {cepStatus === 'success' && !addressEdited && <p className="section-footnote" role="status">Endereço preenchido. Confira e complete número e complemento.</p>}
                <label className="record-field record-field-wide">
                  <span className="field-label">Endereço de entrega <span className="field-optional">opcional</span></span>
                  <textarea autoComplete="street-address" className="text-input record-textarea" disabled={saving} maxLength={1000} onChange={(event) => { setDeliveryAddress(event.target.value); setAddressEdited(true); addressEditedRef.current = true }} placeholder="Rua, número, bairro, cidade e complemento" rows={2} value={deliveryAddress} />
                </label>
              </div>}
            </div>
          </div>
          {phoneLookupBusy && <p className="inline-state" aria-live="polite">Conferindo se já existe um cadastro com estes números…</p>}
          {phoneMatches.length > 0 && <div className="form-message form-message-warning" role="status">
            <strong>Possíveis cadastros com este número</strong>
            <p>A consulta mostra até cinco correspondências. Confira manualmente antes de continuar se houver outros cadastros com o mesmo telefone.</p>
            <ul>{phoneMatches.map((match) => <li key={match.id}><Link to={`/clientes/${match.id}`} target="_blank" rel="noreferrer">{match.name}</Link> · {match.matched_phone_masked}</li>)}</ul>
            <label className="record-checkbox"><input checked={duplicateConfirmation === phoneMatchSignature && Boolean(phoneMatchSignature)} disabled={saving} onChange={(event) => setDuplicateConfirmation(event.target.checked ? phoneMatchSignature : '')} type="checkbox" /><span><strong>Conferi: é outra pessoa e quero continuar</strong><small>Nenhum cadastro será mesclado ou alterado.</small></span></label>
          </div>}
          {phoneLookupUnavailable && <div className="form-message form-message-warning" role="status">
            <p>A consulta de possíveis duplicados está indisponível. Você ainda pode continuar manualmente depois de conferir os números.</p>
            <label className="record-checkbox"><input checked={lookupUnavailableConfirmed} disabled={saving} onChange={(event) => setLookupUnavailableConfirmed(event.target.checked)} type="checkbox" /><span><strong>Conferi os números e quero continuar sem a consulta</strong></span></label>
          </div>}
          {saveError && <p className="form-message form-message-error" role="alert">{saveError}</p>}
          <div className="record-form-actions">
            <button className="button button-primary" disabled={saving} type="submit">{saving ? 'Salvando…' : 'Salvar cliente'}</button>
          </div>
        </form>
      )}
    </div>
  )
}
