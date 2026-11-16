import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx: Record<string, any> = {}
for (const f of ['formula.js', 'sheet.js']) runInNewContext(readFileSync(join(import.meta.dirname, '../../resources/ledger', f), 'utf8'), ctx)
const F = ctx.LedgerFormula
const S = ctx.LedgerSheet

type Raw = string | number | boolean
/** Build a book from column specs and rows of raw values (by column order). */
function book(cols: Array<[string, string, Record<string, unknown>?]>, rows: Raw[][]): any {
  const cs = cols.map(([name, type, more], i) => ({ id: `c${i}`, name, type, ...(more ?? {}) }))
  return { id: 'b', name: 't', cols: cs, rows: rows.map((r, i) => ({ id: `r${i}`, c: Object.fromEntries(r.map((v, j) => [`c${j}`, v]).filter(([, v]) => v !== '')) })) }
}
const show = (b: any): string[][] => {
  const { values } = S.compute(b)
  return values.map((r: unknown[]) => r.map((v, c) => S.display(v, b.cols[c])))
}
/** Evaluate one formula in a 3x3 numeric sheet A1..C3 = 1..9 (no column names needed). */
const one = (f: string): string => {
  const b = book(
    [
      ['A', 'number'],
      ['B', 'number'],
      ['C', 'number'],
      ['D', 'text']
    ],
    [
      [1, 2, 3, f],
      [4, 5, 6, ''],
      [7, 8, 9, '']
    ]
  )
  return show(b)[0][3]
}

describe('ledger formulas (Excel-like)', () => {
  it('arithmetic, precedence, comparison, text join, percent', () => {
    expect(one('=1+2*3')).toBe('7')
    expect(one('=(1+2)*3')).toBe('9')
    expect(one('=2^3^2')).toBe('512')
    expect(one('=-A1+B1')).toBe('1')
    expect(one('=10/4')).toBe('2.5')
    expect(one('=1/0')).toBe('#DIV/0!')
    expect(one('=50%*A3')).toBe('3.5')
    expect(one('="합계: "&SUM(A1:C3)')).toBe('합계: 45')
    expect(one('=A1<B1')).toBe('TRUE')
    expect(one('="가"="가"')).toBe('TRUE')
    expect(one('=0.1+0.2')).toBe('0.3')
  })

  it('references and ranges, absolute markers, errors', () => {
    expect(one('=A1+C3')).toBe('10')
    expect(one('=$B$2*2')).toBe('10')
    expect(one('=SUM(A1:C3)')).toBe('45')
    expect(one('=SUM(C3:A1)')).toBe('45')
    expect(one('=AVERAGE(A1:A3)')).toBe('4')
    expect(one('=MAX(A1:C2)')).toBe('6')
    expect(one('=MIN(B1:B3)')).toBe('2')
    expect(one('=COUNT(A1:D3)')).toBe('9')
    expect(one('=SUM(A1:A100)')).toBe('12') // past the last row is empty
    expect(one('=Z1')).toBe('#REF!')
    expect(one('=NOPE(1)')).toBe('#NAME?')
    expect(one('=1+')).toBe('#ERROR!')
    expect(one('=SUM(1,"x")')).toBe('#VALUE!')
    expect(one('=D1')).toBe('#CYCLE!')
  })

  it('functions: logic, rounding, text, dates, lookups, conditional aggregates', () => {
    expect(one('=IF(A1>0,"양수","음수")')).toBe('양수')
    expect(one('=IF(A1>5,"큼")')).toBe('FALSE')
    expect(one('=IFERROR(1/0,"없음")')).toBe('없음')
    expect(one('=AND(A1>0,B1>0,OR(C1>100,TRUE))')).toBe('TRUE')
    expect(one('=NOT(A1=1)')).toBe('FALSE')
    expect(one('=ROUND(2.345,2)')).toBe('2.35')
    expect(one('=ROUND(-2.5,0)')).toBe('-3')
    expect(one('=ROUNDUP(2.301,1)')).toBe('2.4')
    expect(one('=ROUNDDOWN(2.399,1)')).toBe('2.3')
    expect(one('=INT(-1.5)')).toBe('-2')
    expect(one('=MOD(10,3)')).toBe('1')
    expect(one('=LEN("대장관리")')).toBe('4')
    expect(one('=LEFT("2026-11-12",4)&"년"')).toBe('2026년')
    expect(one('=MID("ABCDEF",2,3)')).toBe('BCD')
    expect(one('=TRIM("  a   b ")')).toBe('a b')
    expect(one('=TEXT(1234567.891,"#,##0.00")')).toBe('1,234,567.89')
    expect(one('=TEXT(0.125,"0.0%")')).toBe('12.5%')
    expect(one('=TEXT(DATE(2026,3,5),"yyyy.mm.dd")')).toBe('2026.03.05')
    expect(one('=DATE(2026,12,25)-DATE(2026,12,1)')).toBe('24')
    expect(one('=YEAR("2026-03-05")*100+MONTH("2026-03-05")')).toBe('202,603') // a number in a text column shows with separators
    expect(one('=DATEDIF("2025-01-15","2026-03-14","M")')).toBe('13')
    expect(one('=DATEDIF("2020-02-29","2026-02-28","Y")')).toBe('5')
    expect(one('=SUMIF(A1:A3,">=4")')).toBe('11')
    expect(one('=SUMIF(A1:A3,">=4",C1:C3)')).toBe('15')
    expect(one('=COUNTIF(A1:C3,"<>5")')).toBe('8')
    expect(one('=AVERAGEIF(B1:B3,">2")')).toBe('6.5')
    expect(one('=VLOOKUP(4,A1:C3,3,FALSE)')).toBe('6')
    expect(one('=VLOOKUP(5,A1:C3,2)')).toBe('5') // approximate: largest key ≤ 5
    expect(one('=VLOOKUP(99,A1:C3,2,FALSE)')).toBe('#N/A')
    expect(one('=INDEX(A1:C3,MATCH(7,A1:A3),2)')).toBe('8')
    expect(one('=ISBLANK(D2)')).toBe('TRUE')
    expect(F.FUNCTIONS).toContain('SUMIF')
  })

  it('column names: [열] is this row in a calculation and the whole column inside SUM', () => {
    const b = book(
      [
        ['품명', 'text'],
        ['수량', 'number'],
        ['단가', 'number', { format: 'won' }],
        ['금액', 'calc', { calc: '=[수량]*[단가]', format: 'won' }],
        ['비율', 'calc', { calc: '=ROUND([금액]/SUM([금액]),3)', format: 'pct' }],
        ['누적', 'calc', { calc: '=CUMSUM([금액])+[@수량]*0' }]
      ],
      [
        ['볼펜', 10, 500],
        ['노트', 5, 2000],
        ['파일', '', 1000]
      ]
    )
    expect(show(b)).toEqual([
      ['볼펜', '10', '500원', '5,000원', '33.3%', '5,000'],
      ['노트', '5', '2,000원', '10,000원', '66.7%', '15,000'],
      ['파일', '', '1,000원', '0원', '0%', '15,000']
    ])
  })

  it('CUMSUM accepts the whole column; a column that sums itself is a cycle, not a crash', () => {
    const b = book(
      [
        ['금액', 'number'],
        ['누적', 'calc', { calc: '=CUMSUM([금액])' }],
        ['자기', 'calc', { calc: '=SUM([자기])' }]
      ],
      [[1], [2], [3]]
    )
    expect(show(b).map((r) => r.slice(1))).toEqual([
      ['1', '#CYCLE!'],
      ['3', '#CYCLE!'],
      ['6', '#CYCLE!']
    ])
  })

  it('a calculated column stays blank on an empty row', () => {
    const b = book(
      [
        ['수량', 'number'],
        ['금액', 'calc', { calc: '=[수량]*2' }]
      ],
      [[3], ['']]
    )
    expect(show(b)).toEqual([
      ['3', '6'],
      ['', '']
    ])
  })

  it('dates: typed forms are normalised, subtraction gives days, TODAY works', () => {
    expect(S.normalizeDate('2026.3.5')).toBe('2026-03-05')
    expect(S.normalizeDate('2026년 3월 5일')).toBe('2026-03-05')
    expect(S.normalizeDate('2026-02-30')).toBeNull()
    const b = book(
      [
        ['시작', 'date'],
        ['끝', 'date'],
        ['일수', 'calc', { calc: '=[끝]-[시작]+1', format: 'int' }],
        ['지남', 'calc', { calc: '=TODAY()>[끝]' }]
      ],
      [['2026-03-30', '2026-04-02']]
    )
    const v = show(b)[0]
    expect(v.slice(0, 3)).toEqual(['2026-03-30', '2026-04-02', '4'])
    expect(v[3]).toBe(String(F.todaySerial() > F.dateToSerial('2026-04-02')).toUpperCase())
  })

  it('totals, sort (blanks last, Korean order, numbers), filter, invalid marks', () => {
    const b = book(
      [
        ['이름', 'text'],
        ['점수', 'number'],
        ['확인', 'check']
      ],
      [
        ['나', 30, true],
        ['가', '', false],
        ['다', 10, true],
        ['라', 'x', '']
      ]
    )
    const { values } = S.compute(b)
    const all = [0, 1, 2, 3]
    expect(S.total(values, 1, 'sum', all)).toBe(40)
    expect(S.total(values, 1, 'avg', all)).toBe(20)
    expect(S.total(values, 2, 'checked', all)).toBe(2)
    expect(S.total(values, 0, 'count', all)).toBe(4)
    expect(S.sortOrder(values, 0, 'asc')).toEqual([1, 0, 2, 3])
    expect(S.sortOrder(values, 1, 'desc')[0]).toBe(3) // text after numbers when descending
    expect(S.sortOrder(values, 1, 'asc').slice(0, 2)).toEqual([2, 0])
    expect(S.sortOrder(values, 1, 'asc').at(-1)).toBe(1) // blank last
    expect(S.filterRows(b, values, '다', null)).toEqual([2])
    expect(S.filterRows(b, values, '', { 2: { values: new Set(['✓']) } })).toEqual([0, 2])
    expect(S.invalid(b.cols[1], 'x')).toBe(true)
    expect(S.invalid(b.cols[1], '1,200')).toBe(false)
  })

  it('CSV round trip keeps text with commas, quotes, line breaks; types are guessed', () => {
    const csv = '\uFEFF품명,수량,취득일,비고\r\n"볼펜, 검정",10,2026.3.5,"말하길 ""좋음"""\r\n노트,"1,200",2026-03-06,"두 줄\n메모"\r\n'
    const b = S.fromCSV(csv, '가져오기')
    expect(b.cols.map((c: any) => c.type)).toEqual(['text', 'number', 'date', 'text'])
    expect(show(b)).toEqual([
      ['볼펜, 검정', '10', '2026-03-05', '말하길 "좋음"'],
      ['노트', '1,200', '2026-03-06', '두 줄\n메모']
    ])
    const { values } = S.compute(b)
    const out = S.toCSV(b, values, [0, 1])
    expect(out.startsWith('\uFEFF품명,수량,취득일,비고\r\n')).toBe(true)
    const again = S.fromCSV(out, 'x')
    expect(show(again)).toEqual(show(b))
  })

  it('pasting a block from Excel (tab separated) fills cells and adds rows', () => {
    const b = book(
      [
        ['A', 'text'],
        ['B', 'number'],
        ['C', 'calc', { calc: '=[B]*2' }]
      ],
      [['x', 1]]
    )
    const area = S.pasteBlock(b, 0, 0, '가\t10\t무시\r\n나\t20\r\n다\t\r\n')
    expect(area).toEqual({ r1: 0, r2: 2, c1: 0, c2: 2 })
    expect(show(b)).toEqual([
      ['가', '10', '20'],
      ['나', '20', '40'],
      ['다', '', '0']
    ])
  })

  it('renaming a column fixes formulas that use its name', () => {
    const b = book(
      [
        ['수량', 'number'],
        ['단가', 'number'],
        ['금액', 'calc', { calc: '=[수량]*[단가]' }],
        ['메모', 'text']
      ],
      [[2, 3, '', '=SUM([@수량],1)']]
    )
    S.renameColumn(b, 'c0', '개수')
    expect(b.cols[2].calc).toBe('=[개수]*[단가]')
    expect(b.rows[0].c.c3).toBe('=SUM([@개수],1)')
    expect(show(b)[0].slice(2)).toEqual(['6', '3'])
  })

  it('every template computes without errors and fits the storage limit with 2,000 rows', () => {
    for (const t of S.TEMPLATES) {
      const b = S.fromTemplate(t.key)
      const v = show(b)
      expect(v.flat().filter((x: string) => x.startsWith('#'))).toEqual([])
    }
    const big = S.fromTemplate('asset')
    for (let i = 0; i < 2000; i++) big.rows.push({ id: `x${i}`, c: { [big.cols[0].id]: `A-${i}`, [big.cols[1].id]: '복사 용지', [big.cols[3].id]: i % 7, [big.cols[4].id]: 4500 } })
    const t0 = performance.now()
    const { values } = S.compute(big)
    expect(performance.now() - t0).toBeLessThan(process.env.CI ? 2000 : 500)
    expect(S.total(values, 5, 'sum', values.map((_: unknown, i: number) => i))).toBeGreaterThan(0)
    expect(S.sizeOf(big)).toBeLessThan(512 * 1024)
  })
})
