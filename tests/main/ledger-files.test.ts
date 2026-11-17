import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dateSerial, readDb, readXlsx, writeCsv, writeDb, writeXls, writeXlsx, XLS_MAX_ROWS, type SheetData } from '../../src/node/ledger-files'

const sheet: SheetData = {
  name: '비품 대장 2026',
  columns: [
    { name: '품명', kind: 'text', width: 160 },
    { name: '수량', kind: 'number', format: '#,##0' },
    { name: '단가', kind: 'number', format: '#,##0"원"' },
    { name: '취득일', kind: 'date' },
    { name: '확인', kind: 'check' },
    { name: '비고 <&"특수">', kind: 'text' }
  ],
  rows: [
    ['노트북 15"', 2, 1250000, '2026-03-02', true, '줄\n바꿈, 쉼표'],
    ['의자', 10, 89000.5, '2026-11-16', false, null],
    ['', null, -3, '날짜 아님', null, ' 앞뒤 공백 ']
  ]
}
/** LEDGER_FILES_OUT=<folder>: also leave the files there, to open them in Excel by hand or by script. */
const keep = process.env.LEDGER_FILES_OUT

describe('ledger files (다른 이름으로 저장)', () => {
  it('dates become Excel day numbers', () => {
    expect(dateSerial('1900-03-01')).toBe(61)
    expect(dateSerial('2026-03-02')).toBe(46083)
    expect(dateSerial('2026-02-30')).toBeNull()
    expect(dateSerial('어제')).toBeNull()
  })

  it('xlsx: what is written is read back — text, numbers, dates, checks, special characters', () => {
    const buf = writeXlsx(sheet)
    expect(buf.subarray(0, 2).toString()).toBe('PK')
    const back = readXlsx(buf)
    expect(back.name).toBe('비품 대장 2026')
    expect(back.rows[0]).toEqual(sheet.columns.map((c) => c.name))
    expect(back.rows[1]).toEqual(['노트북 15"', 2, 1250000, '2026-03-02', true, '줄\n바꿈, 쉼표'])
    expect(back.rows[2]).toEqual(['의자', 10, 89000.5, '2026-11-16', false])
    expect(back.rows[3]).toEqual([null, null, -3, '날짜 아님', null, ' 앞뒤 공백 '])
    if (keep) writeFileSync(join(keep, 'ledger.xlsx'), buf)
  })

  it('xlsx: a large sheet', () => {
    const rows = Array.from({ length: 100_000 }, (_, i) => [`품목 ${i}`, i, i * 1.5, '2026-01-01', i % 2 === 0, null])
    const buf = writeXlsx({ ...sheet, rows })
    const back = readXlsx(buf)
    expect(back.rows).toHaveLength(100_001)
    expect(back.rows[100_000].slice(0, 5)).toEqual(['품목 99999', 99999, 149998.5, '2026-01-01', false])
    if (keep) writeFileSync(join(keep, 'ledger-100k.xlsx'), buf)
  }, 60_000)

  it('xls: a compound file with one Workbook stream; refuses more rows than the format holds', () => {
    const buf = writeXls(sheet)
    expect(buf.subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1')
    expect(buf.length % 512).toBe(0)
    expect(buf.includes(Buffer.from('Workbook', 'utf16le'))).toBe(true)
    expect(buf.includes(Buffer.from('노트북', 'utf16le'))).toBe(true)
    // many sectors: the list of FAT sectors continues outside the header
    const big = writeXls({ ...sheet, rows: Array.from({ length: XLS_MAX_ROWS }, (_, i) => [`품목 ${i} 설명이 조금 긴 편`, i, i * 2, '2026-01-01', true, '비고']) })
    expect(big.length).toBeGreaterThan(109 * 128 * 512)
    expect(big.readUInt32LE(72)).toBeGreaterThan(0)
    expect(() => writeXls({ ...sheet, rows: Array.from({ length: XLS_MAX_ROWS + 1 }, () => []) })).toThrow(/65,535행/)
    if (keep) {
      writeFileSync(join(keep, 'ledger.xls'), buf)
      writeFileSync(join(keep, 'ledger-65k.xls'), big)
    }
  }, 60_000)

  it('csv: UTF-8 with a byte order mark, quoted where needed', () => {
    const text = writeCsv(sheet).toString('utf8')
    expect(text.charCodeAt(0)).toBe(0xfeff)
    const lines = text.slice(1).split('\r\n')
    expect(lines[0]).toBe('품명,수량,단가,취득일,확인,"비고 <&""특수"">"')
    expect(lines[1]).toBe('"노트북 15""",2,1250000,2026-03-02,O,"줄\n바꿈, 쉼표"')
    expect(lines[2]).toBe('의자,10,89000.5,2026-11-16,,')
    expect(lines[3]).toBe(',,-3,날짜 아님,," 앞뒤 공백 "')
  })

  it('db: a table any SQLite tool reads, and the ledger itself to read back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'th-ledger-'))
    try {
      const path = join(dir, 'ledger.db')
      const book = { name: '비품 대장 2026', cols: [{ id: 'c1', name: '품명', type: 'text' }], rows: [{ id: 'r1', c: { c1: '=A1' } }] }
      writeDb(path, sheet, book)
      writeDb(path, sheet, book) // saving over an existing file
      const db = new DatabaseSync(path)
      const rows = db.prepare('SELECT * FROM data ORDER BY No').all() as Record<string, unknown>[]
      db.close()
      expect(rows).toHaveLength(3)
      expect(rows[0]).toEqual({ No: 1, 품명: '노트북 15"', 수량: 2, 단가: 1250000, 취득일: '2026-03-02', 확인: 1, "비고 <&'특수'>": '줄\n바꿈, 쉼표' })
      expect(rows[2]).toMatchObject({ 품명: null, 수량: null, 단가: -3 })
      expect(readDb(path)).toEqual(book)
      if (keep) {
        mkdirSync(keep, { recursive: true })
        writeDb(join(keep, 'ledger.db'), sheet, book)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
