import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import { searchCustomers } from '../lib/customer-search.mjs'
import './CustomerSearchSelect.css'

export type CustomerSearchOption = {
  id: string
  name: string
  phone?: string | null
  whatsapp_phone?: string | null
}

type Props = {
  customers: CustomerSearchOption[]
  selectedId: string
  onSelect: (customerId: string) => void
  onPendingChange: (pending: boolean) => void
  disabled?: boolean
}

export function CustomerSearchSelect({ customers, selectedId, onSelect, onPendingChange, disabled = false }: Props) {
  const inputId = useId()
  const listId = useId()
  const selected = customers.find((customer) => customer.id === selectedId)
  const [query, setQuery] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [navigationActive, setNavigationActive] = useState(false)
  const displayedValue = query ?? selected?.name ?? ''
  const canSelectWithKeyboard = Boolean(query?.trim()) || navigationActive
  const matches = useMemo(() => {
    return searchCustomers(customers, displayedValue)
  }, [customers, displayedValue])

  function select(customerId: string) {
    onSelect(customerId)
    onPendingChange(false)
    setQuery(null)
    setOpen(false)
    setActiveIndex(0)
    setNavigationActive(false)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setNavigationActive(true)
      onPendingChange(true)
      setActiveIndex((current) => navigationActive ? Math.min(current + 1, Math.max(0, matches.length - 1)) : 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setNavigationActive(true)
      onPendingChange(true)
      setActiveIndex((current) => navigationActive ? Math.max(0, current - 1) : Math.max(0, matches.length - 1))
    } else if (event.key === 'Enter' && open && canSelectWithKeyboard && matches[activeIndex]) {
      event.preventDefault()
      select(matches[activeIndex].id)
    } else if (event.key === 'Escape') {
      setOpen(false)
      setQuery(null)
      setNavigationActive(false)
      onPendingChange(false)
    }
  }

  return (
    <div className="customer-search-select">
      <label className="record-field" htmlFor={inputId}>
        <span className="field-label">Cliente <span aria-hidden="true">*</span></span>
        <input
          aria-activedescendant={open && canSelectWithKeyboard && matches[activeIndex] ? `${listId}-${matches[activeIndex].id}` : undefined}
          aria-autocomplete="list"
          aria-controls={open && matches.length > 0 ? listId : undefined}
          aria-expanded={open}
          aria-required="true"
          autoComplete="off"
          className="text-input"
          disabled={disabled}
          id={inputId}
          onBlur={() => window.setTimeout(() => { setOpen(false); setQuery(null); setNavigationActive(false); onPendingChange(false) }, 100)}
          onChange={(event) => {
            const nextQuery = event.target.value
            setQuery(nextQuery)
            setActiveIndex(0)
            setNavigationActive(Boolean(nextQuery.trim()))
            setOpen(true)
            onPendingChange(true)
          }}
          onFocus={() => { setQuery(''); setOpen(true); setActiveIndex(0); setNavigationActive(false) }}
          onKeyDown={handleKeyDown}
          placeholder="Buscar por nome ou telefone"
          role="combobox"
          value={displayedValue}
        />
      </label>
      {open && !disabled && (
        <div className="customer-search-popover">
          {matches.length > 0 ? (
            <ul id={listId} role="listbox" aria-label="Clientes correspondentes">
              {matches.map((customer, index) => (
                <li
                  aria-selected={canSelectWithKeyboard && index === activeIndex}
                  className={canSelectWithKeyboard && index === activeIndex ? 'customer-search-option customer-search-option-active' : 'customer-search-option'}
                  id={`${listId}-${customer.id}`}
                  key={customer.id}
                  onClick={() => select(customer.id)}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                >
                  <strong>{customer.name}</strong>
                  <small>{customer.phone || customer.whatsapp_phone || 'Sem telefone cadastrado'}</small>
                </li>
              ))}
            </ul>
          ) : <p className="customer-search-empty">Nenhum cliente encontrado.</p>}
        </div>
      )}
    </div>
  )
}
