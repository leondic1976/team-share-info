/** Minimal RFC 4180 CSV for contact import/export (Excel-compatible, UTF-8 BOM). */

export function toCsv(rows: string[][]): string {
  const esc = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return '\uFEFF' + rows.map((r) => r.map((c) => esc(c ?? '')).join(',')).join('\r\n') + '\r\n'
}

export function parseCsv(text: string): string[][] {
  const s = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

export const CONTACT_COLUMNS: { key: 'org' | 'name' | 'title' | 'phone' | 'mobile' | 'email' | 'memo'; label: string; aliases: string[] }[] = [
  { key: 'org', label: '기관', aliases: ['기관', '회사', '소속', 'org', 'company'] },
  { key: 'name', label: '이름', aliases: ['이름', '성명', 'name'] },
  { key: 'title', label: '직위', aliases: ['직위', '직급', '직책', 'title'] },
  { key: 'phone', label: '전화', aliases: ['전화', '전화번호', '사무실', 'phone', 'tel'] },
  { key: 'mobile', label: '휴대폰', aliases: ['휴대폰', '핸드폰', '휴대전화', 'mobile'] },
  { key: 'email', label: '이메일', aliases: ['이메일', '메일', 'email', 'e-mail'] },
  { key: 'memo', label: '메모', aliases: ['메모', '비고', 'memo', 'note'] }
]

/** Map CSV rows (first row = header) to contact objects using known header names. */
export function csvToContacts(rows: string[][]): Record<string, string>[] {
  if (rows.length < 2) return []
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const idx = CONTACT_COLUMNS.map((c) => ({ key: c.key, i: header.findIndex((h) => c.aliases.some((a) => a.toLowerCase() === h)) }))
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {}
    for (const { key, i } of idx) if (i >= 0) o[key] = (r[i] ?? '').trim()
    return o
  })
}
