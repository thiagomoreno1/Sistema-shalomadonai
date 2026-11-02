export type CustomerImportField = 'name' | 'phone' | 'whatsapp_phone' | 'delivery_address' | 'notes'
export type ParsedCustomerCsvRow = { rowNumber: number; values: string[] }
export type CustomerImportPreviewRow = {
  rowNumber: number
  values: { name: string; phone: string | null; whatsapp_phone: string | null; delivery_address: string | null; notes: string | null }
  errors: string[]
  duplicateMatches: string[]
  includeDuplicate: boolean
}

export const CUSTOMER_IMPORT_FIELDS: CustomerImportField[]
export function customerImportFieldLabels(): Record<CustomerImportField, string>
export function parseCustomerCsv(input: string, options?: { maxRows?: number }): { headers: string[]; rows: ParsedCustomerCsvRow[]; delimiter: string }
export function suggestCustomerColumnMapping(headers: string[]): Record<CustomerImportField, number | null>
export function validateCustomerImportRows(rows: ParsedCustomerCsvRow[], mapping: Record<CustomerImportField, number | null>, options?: { defaultCallingCode?: string; numbersIncludeCode?: boolean; existingCustomers?: Array<{ id?: string; name: string; phone?: string | null; whatsapp_phone?: string | null }> }): CustomerImportPreviewRow[]
export function importableCustomerRows(previewRows: CustomerImportPreviewRow[]): CustomerImportPreviewRow['values'][]
export function normalizeImportText(value: unknown): string
export function normalizeImportPhone(value: unknown, defaultCallingCode?: string, numbersIncludeCode?: boolean): string | null
