import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { LedgerExportCell, LedgerExportColumn } from '../shared/schemas/ledger'

/**
 * Files a ledger is saved as (다른 이름으로 저장) or read from: Excel workbook (.xlsx),
 * Excel 97-2003 workbook (.xls), CSV, SQLite database (.db). Written by hand: the app ships
 * no spreadsheet library and no native module.
 */

export const XLS_MAX_ROWS = 65_535
export const XLSX_MAX_ROWS = 1_048_575
/** Longest text of one cell in .xls (one record holds 8,224 bytes) and .xlsx (Excel's limit). */
const XLS_TEXT = 4000
const XLSX_TEXT = 32_767

export interface SheetData {
  name: string
  columns: LedgerExportColumn[]
  rows: LedgerExportCell[][]
}

// ---------- shared ----------
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 'YYYY-MM-DD' → Excel day number (1900 date system); null when it is not a date. */
export function dateSerial(v: unknown): number | null {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null
  if (!m) return null
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3])
  const d = new Date(t)
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3] || +m[1] < 1900) return null
  return Math.round(t / 86_400_000) + 25_569
}
function serialDate(n: number): string {
  return new Date(Math.round((n - 25_569) * 86_400_000)).toISOString().slice(0, 10)
}
const sheetName = (n: string): string => n.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet1'

// ---------- zip ----------
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const body = deflateRawSync(f.data, { level: 6 })
    const crc = crc32(f.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(f.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, body)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0x0800, 8)
    c.writeUInt16LE(8, 10)
    c.writeUInt16LE(0, 12)
    c.writeUInt16LE(0x21, 14)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(body.length, 20)
    c.writeUInt32LE(f.data.length, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt32LE(offset, 42)
    central.push(c, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, end])
}

function unzip(buf: Buffer): Map<string, Buffer> {
  let e = buf.length - 22
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--
  if (e < 0) throw new Error('엑셀 파일(.xlsx)이 아닙니다.')
  const n = buf.readUInt16LE(e + 10)
  let p = buf.readUInt32LE(e + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extra = buf.readUInt16LE(p + 30)
    const comment = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const body = buf.subarray(start, start + size)
    if (method === 0) out.set(name, Buffer.from(body))
    else if (method === 8) out.set(name, inflateRawSync(body))
    p += 46 + nameLen + extra + comment
  }
  return out
}

// ---------- xlsx ----------
// eslint-disable-next-line no-control-regex
const BAD_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g
const xml = (s: string): string => s.replace(BAD_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
function colRef(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}
const numFormat = (c: LedgerExportColumn): string => (c.kind === 'date' ? 'yyyy-mm-dd' : c.format || '')

export function writeXlsx(sheet: SheetData): Buffer {
  if (sheet.rows.length > XLSX_MAX_ROWS) throw new Error('엑셀 통합 문서는 1,048,575행까지 담을 수 있습니다.')
  const cols = sheet.columns
  // styles: 0 default, 1 header, then one per number format
  const formats = [...new Set(cols.map(numFormat).filter(Boolean))]
  const styleOf = cols.map((c) => (numFormat(c) ? 2 + formats.indexOf(numFormat(c)) : 0))
  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="${formats.length}">${formats.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xml(f)}"/>`).join('')}</numFmts>` +
    `<fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts>` +
    `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill></fills>` +
    `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF9AA7B8"/></bottom><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${2 + formats.length}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>` +
    formats.map((_, i) => `<xf numFmtId="${164 + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`).join('') +
    `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

  const text = (ref: string, v: string, s: number): string => `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t xml:space="preserve">${xml(v.length > XLSX_TEXT ? v.slice(0, XLSX_TEXT) : v)}</t></is></c>`
  const out: string[] = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`,
    `<dimension ref="A1:${colRef(Math.max(0, cols.length - 1))}${sheet.rows.length + 1}"/>`,
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`,
    `<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(6, Math.min(80, Math.round((c.width ?? 120) / 7)))}" customWidth="1"/>`).join('')}</cols>`,
    '<sheetData>',
    `<row r="1">${cols.map((c, i) => text(`${colRef(i)}1`, c.name, 1)).join('')}</row>`
  ]
  const refs = cols.map((_, i) => colRef(i))
  for (let r = 0; r < sheet.rows.length; r++) {
    const line = sheet.rows[r]
    const n = r + 2
    let row = `<row r="${n}">`
    for (let c = 0; c < cols.length; c++) {
      const v = line[c]
      if (v === null || v === undefined || v === '') continue
      const ref = refs[c] + n
      const s = styleOf[c]
      if (typeof v === 'number') row += Number.isFinite(v) ? `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v}</v></c>` : ''
      else if (typeof v === 'boolean') row += `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`
      else {
        const d = cols[c].kind === 'date' ? dateSerial(v) : null
        row += d !== null ? `<c r="${ref}" s="${s}"><v>${d}</v></c>` : text(ref, v, 0)
      }
    }
    out.push(row + '</row>')
  }
  out.push('</sheetData>')
  if (cols.length) out.push(`<autoFilter ref="A1:${colRef(cols.length - 1)}${sheet.rows.length + 1}"/>`)
  out.push('</worksheet>')
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  return zip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
          `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
      )
    },
    { name: '_rels/.rels', data: Buffer.from(`${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName(sheet.name))}" sheetId="1" r:id="rId1"/></sheets></workbook>`
      )
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
          `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
      )
    },
    { name: 'xl/styles.xml', data: Buffer.from(styles) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(out.join('')) }
  ])
}

const unxml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/_x([0-9A-F]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
const tText = (s: string): string => [...s.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('')

/** First sheet of a workbook as rows of values (text, numbers, booleans; dates as 'YYYY-MM-DD'). */
export function readXlsx(buf: Buffer, maxRows = 100_001): { name: string; rows: LedgerExportCell[][] } {
  const files = unzip(buf)
  const get = (n: string): string => files.get(n)?.toString('utf8') ?? ''
  const wb = get('xl/workbook.xml')
  if (!wb) throw new Error('엑셀 파일(.xlsx)이 아닙니다.')
  const first = /<sheet\b[^>]*>/.exec(wb)?.[0] ?? ''
  const name = unxml(/\bname="([^"]*)"/.exec(first)?.[1] ?? 'Sheet1')
  const rid = /\br:id="([^"]*)"/.exec(first)?.[1]
  const rel = rid ? new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*>`).exec(get('xl/_rels/workbook.xml.rels'))?.[0] : undefined
  const target = (rel && /\bTarget="([^"]*)"/.exec(rel)?.[1]) || 'worksheets/sheet1.xml'
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`
  const sheet = get(path)
  if (!sheet) throw new Error('엑셀 파일에서 첫 시트를 찾지 못했습니다.')
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => tText((m[1] ?? '').replace(/<rPh[\s\S]*?<\/rPh>/g, '')))
  // which cell styles show a date
  const st = get('xl/styles.xml')
  const custom = new Map([...st.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].map((m) => [+m[1], unxml(m[2])]))
  const isDate = (id: number): boolean => (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58) || /[ymdh]/i.test((custom.get(id) ?? '').replace(/\[[^\]]*\]|"[^"]*"/g, ''))
  const xfs = /<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(st)?.[0] ?? ''
  const dateStyle = [...xfs.matchAll(/<xf\b[^>]*>/g)].map((m) => isDate(+(/numFmtId="(\d+)"/.exec(m[0])?.[1] ?? 0)))
  const colOf = (ref: string): number => {
    let n = 0
    for (const ch of ref) {
      const k = ch.charCodeAt(0)
      if (k < 65 || k > 90) break
      n = n * 26 + (k - 64)
    }
    return n - 1
  }
  const rows: LedgerExportCell[][] = []
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const at = +(/\br="(\d+)"/.exec(rm[1])?.[1] ?? rows.length + 1) - 1
    if (at >= maxRows) throw new Error(`행이 너무 많습니다(${(maxRows - 1).toLocaleString()}행까지).`)
    while (rows.length < at) rows.push([])
    const line: LedgerExportCell[] = []
    let next = 0
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1]
      const c = ref ? colOf(ref) : next
      next = c + 1
      const t = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? 'n'
      const body = cm[2] ?? ''
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let v: LedgerExportCell
      if (t === 'inlineStr') v = tText(body)
      else if (raw === undefined) v = null
      else if (t === 's') v = shared[+raw] ?? ''
      else if (t === 'b') v = raw === '1'
      else if (t === 'str' || t === 'e') v = unxml(raw)
      else {
        const n = Number(raw)
        v = Number.isFinite(n) ? (dateStyle[+(/\bs="(\d+)"/.exec(attrs)?.[1] ?? 0)] && n > 0 ? serialDate(n) : n) : unxml(raw)
      }
      while (line.length < c) line.push(null)
      line[c] = v
    }
    rows.push(line)
  }
  return { name, rows }
}

// ---------- xls (BIFF8 in a compound file) ----------
function rec(id: number, data: Buffer): Buffer {
  const h = Buffer.alloc(4)
  h.writeUInt16LE(id, 0)
  h.writeUInt16LE(data.length, 2)
  return Buffer.concat([h, data])
}
/** Unicode string with a 16-bit length (cell text). */
function ustr16(s: string): Buffer {
  const t = s.length > XLS_TEXT ? s.slice(0, XLS_TEXT) : s
  const b = Buffer.alloc(3 + t.length * 2)
  b.writeUInt16LE(t.length, 0)
  b.writeUInt8(1, 2)
  b.write(t, 3, 'utf16le')
  return b
}
/** Unicode string with an 8-bit length (sheet and font names). */
function ustr8(s: string): Buffer {
  const b = Buffer.alloc(2 + s.length * 2)
  b.writeUInt8(s.length, 0)
  b.writeUInt8(1, 1)
  b.write(s, 2, 'utf16le')
  return b
}
function font(bold: boolean): Buffer {
  const name = ustr8('맑은 고딕')
  const b = Buffer.alloc(14)
  b.writeUInt16LE(220, 0) // 11pt
  b.writeUInt16LE(0, 2)
  b.writeUInt16LE(0x7fff, 4)
  b.writeUInt16LE(bold ? 700 : 400, 6)
  b.writeUInt8(129, 12) // Hangul character set
  return rec(0x0031, Buffer.concat([b, name]))
}
function xf(fontIx: number, fmt: number, style: boolean): Buffer {
  const b = Buffer.alloc(20)
  b.writeUInt16LE(fontIx, 0)
  b.writeUInt16LE(fmt, 2)
  b.writeUInt16LE(style ? 0xfff5 : 0x0001, 4)
  b.writeUInt8(0x20, 6)
  b.writeUInt16LE(0x20c0, 18)
  return rec(0x00e0, b)
}

function biff(sheet: SheetData): Buffer {
  const cols = sheet.columns
  const formats = [...new Set(cols.map(numFormat).filter(Boolean))]
  // cell formats: 15 header (bold), 16 default, 17… one per number format
  const styleOf = cols.map((c) => (numFormat(c) ? 17 + formats.indexOf(numFormat(c)) : 16))
  const bof = (type: number): Buffer => {
    const b = Buffer.alloc(16)
    b.writeUInt16LE(0x0600, 0)
    b.writeUInt16LE(type, 2)
    b.writeUInt16LE(0x0dbb, 4)
    b.writeUInt16LE(0x07cc, 6)
    b.writeUInt32LE(0x00000041, 8)
    b.writeUInt32LE(0x00000006, 12)
    return rec(0x0809, b)
  }
  const u16 = (...v: number[]): Buffer => {
    const b = Buffer.alloc(v.length * 2)
    v.forEach((x, i) => b.writeUInt16LE(x, i * 2))
    return b
  }
  const globals: Buffer[] = [bof(0x0005), rec(0x0042, u16(0x04b0)), rec(0x003d, u16(0, 0, 0x4000, 0x2000, 0x0038, 0, 0, 1, 600)), rec(0x0022, u16(0))]
  // fonts 0-3 plain, the next one written is index 5 (4 does not exist) and is bold
  globals.push(font(false), font(false), font(false), font(false), font(true))
  formats.forEach((f, i) => globals.push(rec(0x041e, Buffer.concat([u16(164 + i), ustr16(f)]))))
  for (let i = 0; i < 15; i++) globals.push(xf(0, 0, true))
  globals.push(xf(5, 0, false), xf(0, 0, false))
  formats.forEach((_, i) => globals.push(xf(0, 164 + i, false)))
  const style = Buffer.alloc(4)
  style.writeUInt16LE(0x8000, 0)
  style.writeUInt8(0, 2)
  style.writeUInt8(0xff, 3)
  globals.push(rec(0x0293, style))
  const nameBuf = ustr8(sheetName(sheet.name))
  const boundAt = globals.reduce((n, b) => n + b.length, 0)
  const bound = Buffer.concat([Buffer.alloc(6), nameBuf])
  const eof = rec(0x000a, Buffer.alloc(0))
  const sheetStart = boundAt + 4 + bound.length + eof.length
  bound.writeUInt32LE(sheetStart, 0)
  globals.push(rec(0x0085, bound), eof)

  const body: Buffer[] = [bof(0x0010)]
  const dim = Buffer.alloc(14)
  dim.writeUInt32LE(0, 0)
  dim.writeUInt32LE(sheet.rows.length + 1, 4)
  dim.writeUInt16LE(0, 8)
  dim.writeUInt16LE(cols.length, 10)
  body.push(rec(0x0200, dim))
  cols.forEach((c, i) => body.push(rec(0x007d, u16(i, i, Math.max(6, Math.min(80, Math.round((c.width ?? 120) / 7))) * 256, 16, 0, 0))))
  const cell = (r: number, c: number, x: number): Buffer => u16(r, c, x)
  const label = (r: number, c: number, x: number, s: string): Buffer => rec(0x0204, Buffer.concat([cell(r, c, x), ustr16(s)]))
  const number = (r: number, c: number, x: number, n: number): Buffer => {
    const b = Buffer.alloc(8)
    b.writeDoubleLE(n, 0)
    return rec(0x0203, Buffer.concat([cell(r, c, x), b]))
  }
  cols.forEach((c, i) => body.push(label(0, i, 15, c.name)))
  for (let r = 0; r < sheet.rows.length; r++) {
    const line = sheet.rows[r]
    for (let c = 0; c < cols.length; c++) {
      const v = line[c]
      if (v === null || v === undefined || v === '') continue
      if (typeof v === 'number') {
        if (Number.isFinite(v)) body.push(number(r + 1, c, styleOf[c], v))
      } else if (typeof v === 'boolean') body.push(rec(0x0205, Buffer.concat([cell(r + 1, c, 16), Buffer.from([v ? 1 : 0, 0])])))
      else {
        const d = cols[c].kind === 'date' ? dateSerial(v) : null
        body.push(d !== null ? number(r + 1, c, styleOf[c], d) : label(r + 1, c, 16, v))
      }
    }
  }
  const win2 = Buffer.alloc(18)
  win2.writeUInt16LE(0x06b6, 0)
  win2.writeUInt16LE(64, 6)
  body.push(rec(0x023e, win2), eof)
  return Buffer.concat([...globals, ...body])
}

/** One stream ("Workbook") in a compound file (512-byte sectors, no mini stream). */
function compound(stream: Buffer): Buffer {
  const SEC = 512
  const FREE = 0xffffffff
  const END = 0xfffffffe
  // streams under 4096 bytes would have to live in the mini stream: pad instead
  const data = stream.length < 4096 ? Buffer.concat([stream, Buffer.alloc(4096 - stream.length)]) : stream
  const dataSecs = Math.ceil(data.length / SEC)
  // sectors: data…, directory, FAT…, DIFAT…
  let fatSecs = 0
  let difSecs = 0
  for (;;) {
    const total = dataSecs + 1 + fatSecs + difSecs
    const needFat = Math.ceil(total / 128)
    const needDif = needFat > 109 ? Math.ceil((needFat - 109) / 127) : 0
    if (needFat === fatSecs && needDif === difSecs) break
    fatSecs = needFat
    difSecs = needDif
  }
  const dirAt = dataSecs
  const fatAt = dirAt + 1
  const difAt = fatAt + fatSecs
  const total = difAt + difSecs
  const out = Buffer.alloc(SEC * (1 + total))
  // header
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(out, 0)
  out.writeUInt16LE(0x003e, 24)
  out.writeUInt16LE(0x0003, 26)
  out.writeUInt16LE(0xfffe, 28)
  out.writeUInt16LE(9, 30)
  out.writeUInt16LE(6, 32)
  out.writeUInt32LE(fatSecs, 44)
  out.writeUInt32LE(dirAt, 48)
  out.writeUInt32LE(4096, 56)
  out.writeUInt32LE(END, 60)
  out.writeUInt32LE(0, 64)
  out.writeUInt32LE(difSecs ? difAt : END, 68)
  out.writeUInt32LE(difSecs, 72)
  for (let i = 0; i < 109; i++) out.writeUInt32LE(i < fatSecs ? fatAt + i : FREE, 76 + i * 4)
  const at = (sec: number): number => SEC * (1 + sec)
  data.copy(out, at(0))
  // directory: root entry and the stream
  const entry = (i: number, name: string, type: number, child: number, start: number, size: number): void => {
    const o = at(dirAt) + i * 128
    out.write(name, o, 'utf16le')
    out.writeUInt16LE(name ? (name.length + 1) * 2 : 0, o + 64)
    out.writeUInt8(type, o + 66)
    out.writeUInt8(1, o + 67)
    out.writeUInt32LE(FREE, o + 68)
    out.writeUInt32LE(FREE, o + 72)
    out.writeUInt32LE(child, o + 76)
    out.writeUInt32LE(start, o + 116)
    out.writeUInt32LE(size, o + 120)
  }
  entry(0, 'Root Entry', 5, 1, END, 0)
  entry(1, 'Workbook', 2, FREE, 0, data.length)
  entry(2, '', 0, FREE, 0, 0)
  entry(3, '', 0, FREE, 0, 0)
  // FAT
  const fat = (sec: number, v: number): void => void out.writeUInt32LE(v, at(fatAt) + sec * 4)
  for (let i = 0; i < fatSecs * 128; i++) fat(i, FREE)
  for (let i = 0; i < dataSecs; i++) fat(i, i === dataSecs - 1 ? END : i + 1)
  fat(dirAt, END)
  for (let i = 0; i < fatSecs; i++) fat(fatAt + i, 0xfffffffd)
  for (let i = 0; i < difSecs; i++) fat(difAt + i, 0xfffffffc)
  // DIFAT sectors list the FAT sectors beyond the 109 of the header
  for (let d = 0; d < difSecs; d++) {
    const o = at(difAt + d)
    for (let k = 0; k < 127; k++) {
      const n = 109 + d * 127 + k
      out.writeUInt32LE(n < fatSecs ? fatAt + n : FREE, o + k * 4)
    }
    out.writeUInt32LE(d === difSecs - 1 ? END : difAt + d + 1, o + 127 * 4)
  }
  return out
}

export function writeXls(sheet: SheetData): Buffer {
  if (sheet.rows.length > XLS_MAX_ROWS) throw new Error('Excel 97-2003 통합 문서(.xls)는 65,535행까지 담을 수 있습니다. Excel 통합 문서(.xlsx)로 저장하세요.')
  if (sheet.columns.length > 256) throw new Error('Excel 97-2003 통합 문서(.xls)는 256열까지 담을 수 있습니다.')
  return compound(biff(sheet))
}

// ---------- csv ----------
export function writeCsv(sheet: SheetData): Buffer {
  const q = (v: LedgerExportCell, check: boolean): string => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'boolean' ? (check ? (v ? 'O' : '') : v ? 'TRUE' : 'FALSE') : String(v)
    return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [sheet.columns.map((c) => q(c.name, false)).join(',')]
  for (const r of sheet.rows) lines.push(sheet.columns.map((c, i) => q(r[i] ?? null, c.kind === 'check')).join(','))
  return Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8')
}

// ---------- sqlite database ----------
/**
 * A database any SQLite tool opens: table "data" with one column per ledger column, plus
 * table "teamhub_ledger" holding the ledger itself (formulas, column settings) so that
 * TeamHub reads it back exactly.
 */
export function writeDb(path: string, sheet: SheetData, book: unknown): void {
  if (existsSync(path)) rmSync(path)
  const db = new DatabaseSync(path)
  try {
    const used = new Set<string>(['no'])
    const names = sheet.columns.map((c) => {
      let n = c.name.replace(/"/g, "'").trim() || '열'
      while (used.has(n.toLowerCase())) n += '_'
      used.add(n.toLowerCase())
      return n
    })
    const type = (c: LedgerExportColumn): string => (c.kind === 'number' ? 'REAL' : c.kind === 'check' ? 'INTEGER' : 'TEXT')
    db.exec('BEGIN')
    db.exec(`CREATE TABLE "data" ("No" INTEGER PRIMARY KEY${names.map((n, i) => `, "${n}" ${type(sheet.columns[i])}`).join('')})`)
    const ins = db.prepare(`INSERT INTO "data" VALUES (?${names.map(() => ', ?').join('')})`)
    sheet.rows.forEach((r, i) => ins.run(i + 1, ...sheet.columns.map((_, c) => (r[c] === undefined || r[c] === '' ? null : typeof r[c] === 'boolean' ? (r[c] ? 1 : 0) : r[c]))))
    db.exec('CREATE TABLE teamhub_ledger (format TEXT NOT NULL, name TEXT NOT NULL, saved_at TEXT NOT NULL, book TEXT NOT NULL)')
    db.prepare('INSERT INTO teamhub_ledger VALUES (?, ?, ?, ?)').run('teamhub-ledger@1', sheet.name, new Date().toISOString(), JSON.stringify(book))
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

/** The ledger kept in a database written by writeDb; null when the file holds none. */
export function readDb(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const r = db.prepare("SELECT book FROM teamhub_ledger WHERE format = 'teamhub-ledger@1' LIMIT 1").get() as { book: string } | undefined
    return r ? JSON.parse(r.book) : null
  } catch {
    return null
  } finally {
    db.close()
  }
}
