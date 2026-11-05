export const OTHER_INVENTORY_UNIT_OPTION = '__other__'

export const INVENTORY_UNIT_OPTIONS = [
  { value: 'un', label: 'Unidade / peça (un)' },
  { value: 'kg', label: 'Quilograma (kg)' },
  { value: 'g', label: 'Grama (g)' },
  { value: 'L', label: 'Litro (L)' },
  { value: 'mL', label: 'Mililitro (mL)' },
  { value: 'cx', label: 'Caixa (cx)' },
  { value: 'pct', label: 'Pacote (pct)' },
  { value: 'par', label: 'Par' },
  { value: 'm', label: 'Metro (m)' },
  { value: 'cm', label: 'Centímetro (cm)' },
  { value: 'fardo', label: 'Fardo' },
  { value: 'rolo', label: 'Rolo' },
] as const

const fractionalMeasureUnits = new Set([
  'kg', 'quilo', 'quilos', 'quilograma', 'quilogramas',
  'g', 'grama', 'gramas',
  'l', 'litro', 'litros', 'ml', 'mililitro', 'mililitros',
  'm', 'metro', 'metros', 'cm', 'centimetro', 'centimetros',
  'mm', 'milimetro', 'milimetros', 'km', 'quilometro', 'quilometros',
  'm3', 'cm3', 'ton', 'tonelada', 'toneladas',
])

export function isKnownInventoryUnit(unit: string | null | undefined) {
  return INVENTORY_UNIT_OPTIONS.some((option) => option.value === unit)
}

export function isDiscreteInventoryUnit(unit: string | null | undefined) {
  const normalized = (unit ?? '').trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return Boolean(normalized) && !fractionalMeasureUnits.has(normalized)
}

export function isWholeQuantity(value: number | null) {
  return value !== null && Number.isSafeInteger(value)
}
