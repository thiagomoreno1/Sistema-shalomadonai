export type ReportPdfLine = {
  text?: string
  style?: 'body' | 'section' | 'note' | 'spacer'
}

type ReportPdfOptions = {
  title: string
  subtitle: string
  filename: string
  lines: ReportPdfLine[]
}

const WIN_ANSI_SPECIALS: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87,
  'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91,
  '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99,
  'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
}

function pdfTextBytes(value: string) {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0x3f
    const byte = WIN_ANSI_SPECIALS[character] ?? (codePoint <= 0xff ? codePoint : 0x3f)
    return byte.toString(16).padStart(2, '0')
  }).join('').toUpperCase()
}

function wrapText(value: string, maxCharacters: number) {
  const words = value.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (!word) continue
    if (word.length > maxCharacters) {
      if (line) lines.push(line)
      line = ''
      for (let offset = 0; offset < word.length; offset += maxCharacters) {
        const fragment = word.slice(offset, offset + maxCharacters)
        if (fragment.length === maxCharacters) lines.push(fragment)
        else line = fragment
      }
      continue
    }
    const candidate = line ? `${line} ${word}` : word
    if (candidate.length > maxCharacters && line) {
      lines.push(line)
      line = word
    } else line = candidate
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function buildPageContent(title: string, subtitle: string, lines: ReportPdfLine[], pageIndex: number, pageCount: number) {
  const commands = [
    '0.09 0.13 0.20 rg',
    `BT /F2 19 Tf 48 790 Td <${pdfTextBytes(title)}> Tj ET`,
    '0.34 0.40 0.49 rg',
    `BT /F1 9 Tf 48 770 Td <${pdfTextBytes(subtitle)}> Tj ET`,
    '0.78 0.82 0.87 RG 0.7 w 48 756 m 547 756 l S',
  ]
  let y = 738

  for (const item of lines) {
    if (item.style === 'spacer' || !item.text?.trim()) {
      y -= item.style === 'spacer' ? 7 : 4
      continue
    }
    const isSection = item.style === 'section'
    const isNote = item.style === 'note'
    const fontSize = isSection ? 11 : isNote ? 8 : 9
    const lineHeight = isSection ? 16 : isNote ? 11 : 13
    const maxCharacters = isSection ? 88 : isNote ? 116 : 105
    const font = isSection ? 'F2' : 'F1'
    const color = isSection ? '0.09 0.13 0.20 rg' : isNote ? '0.40 0.45 0.53 rg' : '0.18 0.22 0.29 rg'

    for (const textLine of wrapText(item.text, maxCharacters)) {
      if (y < 54) break
      commands.push(color, `BT /${font} ${fontSize} Tf 48 ${y} Td <${pdfTextBytes(textLine)}> Tj ET`)
      y -= lineHeight
    }
    y -= isSection ? 2 : 0
  }

  commands.push('0.40 0.45 0.53 rg', `BT /F1 8 Tf 485 30 Td <${pdfTextBytes(`Página ${pageIndex + 1} de ${pageCount}`)}> Tj ET`)
  return commands.join('\n')
}

function makePdf(title: string, subtitle: string, lines: ReportPdfLine[]) {
  const pageLines: ReportPdfLine[][] = [[]]
  let remaining = 684
  for (const item of lines) {
    const isSection = item.style === 'section'
    const isNote = item.style === 'note'
    const maxCharacters = isSection ? 88 : isNote ? 116 : 105
    const wrappedCount = item.style === 'spacer' ? 1 : wrapText(item.text ?? '', maxCharacters).length
    const itemHeight = item.style === 'spacer' ? 7 : wrappedCount * (isSection ? 16 : isNote ? 11 : 13) + (isSection ? 2 : 0)
    if (itemHeight > remaining && pageLines.at(-1)!.length > 0) {
      pageLines.push([])
      remaining = 684
    }
    pageLines.at(-1)!.push(item)
    remaining -= itemHeight
  }

  const objects = new Map<number, string>()
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  objects.set(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
  const pageReferences: string[] = []

  pageLines.forEach((pageLinesForFile, index) => {
    const pageObject = 5 + index * 2
    const streamObject = pageObject + 1
    pageReferences.push(`${pageObject} 0 R`)
    const content = buildPageContent(title, subtitle, pageLinesForFile, index, pageLines.length)
    objects.set(pageObject, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamObject} 0 R >>`)
    objects.set(streamObject, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  })
  objects.set(2, `<< /Type /Pages /Kids [${pageReferences.join(' ')}] /Count ${pageReferences.length} >>`)

  let document = '%PDF-1.4\n'
  const offsets = [0]
  for (let objectNumber = 1; objectNumber <= Math.max(...objects.keys()); objectNumber += 1) {
    offsets.push(document.length)
    document += `${objectNumber} 0 obj\n${objects.get(objectNumber)}\nendobj\n`
  }
  const xrefOffset = document.length
  document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  document += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  document += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return document
}

export function downloadReportPdf({ title, subtitle, filename, lines }: ReportPdfOptions) {
  const blob = new Blob([makePdf(title, subtitle, lines)], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
