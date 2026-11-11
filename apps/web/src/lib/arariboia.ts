export function nextArariboiaDueDate(today: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today)
  if (!match) return today

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return today

  const dueDate = new Date(Date.UTC(year, month - 1 + (day > 6 ? 1 : 0), 6))
  return `${dueDate.getUTCFullYear()}-${String(dueDate.getUTCMonth() + 1).padStart(2, '0')}-06`
}

export function isArariboiaPaymentMethod(value: string | null | undefined) {
  return value?.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').includes('arariboia') ?? false
}
