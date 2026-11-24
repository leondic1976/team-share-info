import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { PLUGIN_STATE_MAX, pluginManifestSchema } from '../../src/shared/schemas/plugins'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx: Record<string, any> = {}
runInNewContext(readFileSync(join(import.meta.dirname, '../../plugins/bipum/bipum.js'), 'utf8'), ctx)
const B = ctx.Bipum
// values made inside the vm context have another Object/Array prototype: compare as plain data
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v))

const item = (over: Record<string, unknown> = {}): any => B.cleanItem({ id: 'a00001', name: '노트북', cat: '전산장비', qty: 1, unit: '대', ...over }).item
let seq = 0
const room = (shared: unknown, over: Record<string, unknown> = {}): any => ({ id: `r${++seq}`, createdBy: 'boss', createdByName: '담당', createdAt: seq, version: 1, scope: { type: 'team', groups: [], members: [] }, entries: {}, shared, ...over })
const bookWith = (items: any[], entries: Record<string, unknown> = {}): any => {
  const head = room(B.headShared({}, items), { entries })
  return B.books([head])[0]
}
const entry = (name: string, value: unknown): any => ({ name, value, at: 1 })
const T0 = new Date(2026, 10, 24, 9, 0).getTime()

describe('bipum plugin: items', () => {
  it('cleans loose input', () => {
    const r = B.cleanItem({ name: '  A4   복사용지 ', kind: '1', qty: '1,200', unit: '', got: '2025. 3. 5.', price: '24,000원', life: 200, status: 9, min: '3', lend: true })
    expect(plain(r.item)).toMatchObject({ name: 'A4 복사용지', kind: 1, qty: 1200, unit: '개', got: '2025-03-05', price: 24000, life: 99, status: 0, min: 3, lend: false })
    expect(B.cleanItem({ name: ' ' }).error).toBeTruthy()
    // only equipment can be for lending, only consumables have a minimum stock
    expect(plain(B.cleanItem({ name: '빔', lend: true, min: 5 }).item)).toMatchObject({ lend: true, min: 0 })
  })
  it('reads the date formats Excel writes', () => {
    expect(B.cleanDate('2024-03-05')).toBe('2024-03-05')
    expect(B.cleanDate('2024/3/5')).toBe('2024-03-05')
    expect(B.cleanDate('20240305')).toBe('2024-03-05')
    expect(B.cleanDate('2024년 3월 5일')).toBe('2024-03-05')
    expect(B.cleanDate('2024-02-30')).toBe('')
    expect(B.cleanDate('어제')).toBe('')
  })
  it('packs an item into an array and back', () => {
    const it0 = item({ spec: 'gram 16', no: '2025-전산-001', got: '2025-03-10', price: 1850000, life: 5, loc: '3층', holder: '홍길동', status: 2, lend: true, note: '메모', auditAt: '2026-06-01' })
    expect(plain(B.unpack(B.pack(it0)))).toEqual(plain(it0))
    expect(B.unpack(['', 0, '이름'])).toBeNull()
    expect(B.unpack('x')).toBeNull()
  })
  it('makes ids that are not taken', () => {
    const taken = new Set(['000000'])
    let n = 0
    expect(B.makeId(taken, () => (n++ === 0 ? 0 : 0.5))).not.toBe('000000')
  })
})

describe('bipum plugin: rooms', () => {
  it('finds registers and only the volumes their manager made', () => {
    const head = room(B.headShared({}, [item()]))
    const vol = room(B.volShared(head.id, [item({ id: 'b00001', name: '모니터' })]))
    const forged = room(B.volShared(head.id, [item({ id: 'x00001', name: '끼워 넣은 물품' })]), { createdBy: 'other' })
    const other = room({ kind: 'meal' })
    const list = B.books([vol, forged, other, head])
    expect(list).toHaveLength(1)
    expect(list[0].vols.map((v: any) => v.id)).toEqual([vol.id])
    expect(B.itemsOf(list[0]).map((x: any) => x.name)).toEqual(['노트북', '모니터'])
    expect(B.bookOf(list, vol.id).head.id).toBe(head.id)
    expect(B.bookOf(list, 'nope')).toBeNull()
  })
  it('writes only the room that changed', () => {
    const book = bookWith([item()])
    const same = B.distribute(book, B.itemsOf(book))
    expect(same.writes).toHaveLength(0)
    expect(same.creates).toHaveLength(0)
    const next = B.distribute(book, [...B.itemsOf(book), item({ id: 'b00001', name: '모니터' })])
    expect(next.writes).toHaveLength(1)
    expect(next.writes[0]).toMatchObject({ roomId: book.head.id, version: 1 })
    expect(next.writes[0].shared.items).toHaveLength(2)
  })
  it('keeps every room under the size limit of the server and opens volumes for the rest', () => {
    const many = Array.from({ length: 1500 }, (_, i) => item({ id: `i${String(i).padStart(5, '0')}`, name: `사무용 의자 ${i}`, spec: '시디즈 T50 HLDA 메쉬', no: `2025-가구-${String(i).padStart(4, '0')}`, got: '2025-01-15', price: 345000, life: 8, loc: '3층 사무실', holder: '홍길동', note: '2025년 일괄 구매' }))
    const book = bookWith([])
    const plan = B.distribute(book, many)
    expect(plan.error).toBeUndefined()
    expect(plan.creates.length).toBeGreaterThan(1)
    const all = [plan.writes[0].shared, ...plan.creates]
    for (const s of all) expect(JSON.stringify(s).length).toBeLessThanOrEqual(PLUGIN_STATE_MAX)
    expect(all.reduce((n, s) => n + s.items.length, 0)).toBe(1500)
    // a second pass over the result moves nothing
    const head = { ...book.head, shared: plan.writes[0].shared }
    const vols = plan.creates.map((s: any) => room(s))
    const settled = B.books([head, ...vols])[0]
    expect(settled.vols).toHaveLength(plan.creates.length)
    const again = B.distribute(settled, B.itemsOf(settled))
    expect(again.writes).toHaveLength(0)
    expect(again.creates).toHaveLength(0)
    // editing one item rewrites one room
    const edited = B.itemsOf(settled).map((x: any) => (x.id === 'i01499' ? { ...x, holder: '김철수' } : x))
    expect(B.distribute(settled, edited).writes).toHaveLength(1)
  })
  it('refuses more than the register can hold', () => {
    const big = Array.from({ length: 40 }, (_, i) => i)
    const book = bookWith([])
    const huge = big.flatMap((v) => Array.from({ length: 400 }, (_, i) => item({ id: `${v.toString(36)}${String(i).padStart(4, '0')}`, name: '가'.repeat(60), spec: '나'.repeat(80), note: '다'.repeat(200) })))
    expect(B.distribute(book, huge).error).toBeTruthy()
  })
  it('turns the scope of a room into the scope of a new volume', () => {
    expect(plain(B.scopeInput({ type: 'members', groups: [], members: [{ id: 'm1', name: '가' }] }))).toEqual({ type: 'members', groupIds: [], memberIds: ['m1'] })
    expect(plain(B.scopeInput({ type: 'team', groups: [], members: [] }))).toEqual({ type: 'team', groupIds: [], memberIds: [] })
  })
})

describe('bipum plugin: lending and issuing', () => {
  const beam = item({ id: 'beam01', name: '빔프로젝터', qty: 2, lend: true })
  const paper = item({ id: 'paper1', name: 'A4', kind: 1, qty: 10, unit: '박스', min: 3 })
  it('lends only what is left and only lendable equipment', () => {
    const a = B.takeOut(null, beam, [], { qty: 2, due: '2026-11-30', note: '회의' }, T0)
    expect(a.error).toBeUndefined()
    const book = bookWith([beam], { kim: entry('김', a.entry) })
    const loans = B.allLoans(book.head)
    expect(loans).toHaveLength(1)
    expect(loans[0]).toMatchObject({ itemId: 'beam01', qty: 2, name: '김', open: true, due: '2026-11-30' })
    expect(B.stockOf(beam, loans)).toBe(0)
    expect(B.takeOut(null, beam, loans, { qty: 1 }, T0).error).toContain('남은 수량')
    expect(B.takeOut(null, item({ lend: false }), [], { qty: 1 }, T0).error).toContain('대여용')
    expect(B.takeOut(null, { ...beam, status: 2 }, [], { qty: 1 }, T0).error).toContain('수리중')
    expect(B.takeOut(null, beam, [], { qty: 0 }, T0).error).toBeTruthy()
  })
  it('returns a loan: by the borrower, or marked by the manager', () => {
    const a = B.takeOut(null, beam, [], { qty: 1 }, T0)
    const back = B.giveBack(a.entry, a.loan.id, T0 + 1000)
    expect(B.allLoans(bookWith([beam], { kim: entry('김', back.entry) }).head)[0]).toMatchObject({ open: false, backAt: T0 + 1000 })
    expect(B.giveBack(back.entry, a.loan.id, T0).error).toBeTruthy()
    // the manager (creator of the room) marks it in the manager's own entry
    const mark = B.markReturned(null, `kim:${a.loan.id}`, T0 + 5000)
    const book = bookWith([beam], { kim: entry('김', a.entry), boss: entry('담당', mark.entry) })
    expect(B.allLoans(book.head)[0]).toMatchObject({ open: false, backAt: T0 + 5000 })
    // the same mark in anybody else's entry means nothing
    const fake = bookWith([beam], { kim: entry('김', a.entry), lee: entry('이', mark.entry) })
    expect(B.allLoans(fake.head)[0].open).toBe(true)
  })
  it('flags a loan past its due date', () => {
    const a = B.takeOut(null, beam, [], { qty: 1, due: '2026-11-25' }, T0)
    const l = B.allLoans(bookWith([beam], { kim: entry('김', a.entry) }).head)[0]
    expect(B.isOverdue(l, '2026-11-25')).toBe(false)
    expect(B.isOverdue(l, '2026-11-26')).toBe(true)
  })
  it('takes issued consumables off the stock and warns at the minimum', () => {
    const a = B.takeOut(null, paper, [], { qty: 4 }, T0)
    const b = B.takeOut(null, paper, [], { qty: 3, who: '박' }, T0 + 10)
    const loans = B.allLoans(bookWith([paper], { kim: entry('김', a.entry), boss: entry('담당', b.entry) }).head)
    expect(loans.map((l: any) => l.name).sort()).toEqual(['김', '박'])
    expect(loans.find((l: any) => l.name === '박').by).toBe('담당')
    expect(B.stockOf(paper, loans)).toBe(3)
    expect(B.isLow(paper, loans)).toBe(true)
    expect(B.isLow(paper, [])).toBe(false)
    expect(B.takeOut(null, paper, loans, { qty: 4 }, T0 + 20).error).toContain('3박스')
    // counted again (입고·재고 조정): earlier issues no longer come off
    const counted = { ...paper, qty: 20, baseAt: T0 + 100 }
    expect(B.stockOf(counted, loans)).toBe(20)
    // a cancelled record gives the stock back
    const undone = B.cancelLoan(a.entry, a.loan.id)
    expect(B.stockOf(paper, B.allLoans(bookWith([paper], { kim: entry('김', undone.entry) }).head))).toBe(10)
  })
  it('drops old records that no longer matter when an entry is full, and never open loans', () => {
    const counted = { ...paper, qty: 99999, baseAt: T0 + 50000 }
    let e: any = null
    for (let i = 0; i < 1200; i++) e = B.takeOut(e, paper, [], { qty: 1, note: '가'.repeat(60) }, T0 + i).entry
    const open = B.takeOut(e, beam, [], { qty: 1 }, T0 + 1).entry
    expect(JSON.stringify(open).length).toBeGreaterThan(B.LIMITS.entryBudget)
    const fit = B.fitEntry(open, [counted, beam])
    expect(fit.error).toBeUndefined()
    expect(JSON.stringify(fit.entry).length).toBeLessThanOrEqual(PLUGIN_STATE_MAX)
    expect(fit.entry.loans.some((l: any) => l[2] === 'beam01')).toBe(true)
    // nothing may be dropped while the issues still count against the stock
    expect(B.fitEntry(open, [paper, beam]).error).toBeTruthy()
  })
  it('ignores malformed entries', () => {
    const e = B.cleanEntry({ loans: [null, ['x'], ['l1', 0, 'beam01', 0], ['l2', 0, 'beam01', 1, T0]], ret: { bad: 1, 'kim:l2': T0 }, audit: { id: 'a1', c: { beam01: [9], ok0001: [1, 2, '', T0] } } })
    expect(e.loans).toHaveLength(1)
    expect(plain(e.ret)).toEqual({ 'kim:l2': T0 })
    expect(Object.keys(e.audit.c)).toEqual(['ok0001'])
  })
})

describe('bipum plugin: inventory check', () => {
  const pc = item({ id: 'pc0001', name: 'PC', qty: 3 })
  const paper = item({ id: 'paper1', name: 'A4', kind: 1, qty: 10, min: 2 })
  const gone = item({ id: 'old001', name: '폐기한 팩스', status: 4 })
  const audit = { id: 'au0001', title: '하반기 재물조사', at: T0 }
  const head = (entries: Record<string, unknown>): any => room(B.headShared({ audit }, [pc, paper, gone]), { entries })
  it('covers everything but disposed items', () => {
    expect(B.auditTargets([pc, paper, gone]).map((x: any) => x.id)).toEqual(['pc0001', 'paper1'])
  })
  it('takes the newest check of each item, whoever made it', () => {
    const kim = B.setCheck(null, audit, pc, { code: 1 }, T0 + 100, []).entry
    const lee = B.setCheck(null, audit, pc, { code: 3, qty: 2, note: '1대 고장' }, T0 + 200, []).entry
    const map = B.auditMap(head({ kim: entry('김', kim), lee: entry('이', lee) }))
    expect(map.get('pc0001')).toMatchObject({ code: 3, qty: 2, note: '1대 고장', name: '이' })
    expect(plain(B.auditStats([pc, paper, gone], map, []))).toEqual({ total: 2, ok: 0, missing: 0, bad: 1, todo: 1, diff: 1 })
    // checks of an earlier inventory check do not count
    const old = B.setCheck(null, { ...audit, id: 'before' }, paper, { code: 1 }, T0 + 300, []).entry
    expect(B.auditMap(head({ kim: entry('김', old) })).size).toBe(0)
  })
  it('clears a check and starts over for a new inventory check', () => {
    const a = B.setCheck(null, audit, pc, { code: 2 }, T0, []).entry
    expect(plain(a.audit.c.pc0001.slice(0, 2))).toEqual([2, 0])
    expect(Object.keys(B.setCheck(a, audit, pc, { code: 0 }, T0, []).entry.audit.c)).toEqual([])
    const next = B.setCheck(a, { ...audit, id: 'next01' }, paper, { code: 1 }, T0, []).entry
    expect(plain(next.audit)).toMatchObject({ id: 'next01' })
    expect(Object.keys(next.audit.c)).toEqual(['paper1'])
    expect(B.setCheck(null, null, pc, { code: 1 }, T0, []).error).toBeTruthy()
  })
  it('closing writes the date, and the count of a consumable becomes its stock', () => {
    const issue = B.takeOut(null, paper, [], { qty: 2 }, T0 + 10)
    const late = B.takeOut(issue.entry, paper, [], { qty: 1 }, T0 + 5000)
    let e = B.setCheck(late.entry, audit, pc, { code: 1 }, T0 + 1000, []).entry
    // the books say 8 by then; 7 are counted
    e = B.setCheck(e, audit, paper, { code: 1, qty: 7 }, T0 + 1000, []).entry
    const h = head({ kim: entry('김', e) })
    const loans = B.allLoans(h)
    const r = B.closeAudit([pc, paper, gone], B.auditMap(h), audit, T0 + 9000, loans)
    const [pc2, paper2, gone2] = r.items
    expect(pc2.auditAt).toBe('2026-11-24')
    expect(pc2.qty).toBe(3)
    expect(paper2).toMatchObject({ qty: 7, baseAt: T0 + 1000, auditAt: '2026-11-24' })
    // the box handed out after the count still comes off
    expect(B.stockOf(paper2, loans)).toBe(6)
    expect(gone2.auditAt).toBe('')
    expect(plain(r.last)).toMatchObject({ title: '하반기 재물조사', closedAt: T0 + 9000, total: 2, ok: 2, todo: 0 })
  })
  it('leaves an item that was not found untouched', () => {
    const e = B.setCheck(null, audit, pc, { code: 2 }, T0 + 1, []).entry
    const h = head({ kim: entry('김', e) })
    const r = B.closeAudit([pc], B.auditMap(h), audit, T0 + 2, [])
    expect(r.items[0].auditAt).toBe('')
    expect(r.last.missing).toBe(1)
  })
})

describe('bipum plugin: list', () => {
  const items = [
    item({ id: 'a', name: '노트북', cat: '전산장비', no: 'N-2', qty: 2, price: 1000000, got: '2019-01-01', life: 5, loc: '3층', holder: '홍길동' }),
    item({ id: 'b', name: '빔프로젝터', cat: '사무기기', no: 'N-10', qty: 1, price: 700000, got: '2024-06-01', life: 6, loc: '회의실', lend: true }),
    item({ id: 'c', name: 'A4', cat: '소모품', kind: 1, qty: 2, min: 3, price: 24000, loc: '창고' }),
    item({ id: 'd', name: '팩스', cat: '사무기기', qty: 1, status: 4, price: 300000 })
  ]
  const c = { loans: [], today: '2026-11-24' }
  const ids = (list: any[]): string => list.map((x) => x.id).join('')
  it('searches every text field, all words', () => {
    expect(ids(B.filterItems(items, { q: '홍길동' }, c))).toBe('a')
    expect(ids(B.filterItems(items, { q: '3층 노트' }, c))).toBe('a')
    expect(ids(B.filterItems(items, { q: 'n-10' }, c))).toBe('b')
    expect(ids(B.filterItems(items, { q: '없는말' }, c))).toBe('')
  })
  it('hides disposed items unless asked', () => {
    expect(ids(B.filterItems(items, {}, c))).toBe('abc')
    expect(ids(B.filterItems(items, { status: '4' }, c))).toBe('d')
    expect(ids(B.filterItems(items, { cat: '사무기기' }, c))).toBe('b')
    expect(ids(B.filterItems(items, { kind: '1' }, c))).toBe('c')
    expect(ids(B.filterItems(items, { loc: '창고' }, c))).toBe('c')
  })
  it('quick filters: low stock, past service life, lendable', () => {
    expect(ids(B.filterItems(items, { flag: 'low' }, c))).toBe('c')
    expect(ids(B.filterItems(items, { flag: 'over' }, c))).toBe('a')
    expect(ids(B.filterItems(items, { flag: 'lend' }, c))).toBe('b')
    expect(B.lifeEnd(items[0])).toBe('2024-01-01')
    expect(B.lifeOver(items[1], '2026-11-24')).toBe(false)
  })
  it('sorts by any column, numbers as numbers', () => {
    const hangul = items.filter((x) => x.id !== 'c')
    expect(ids(B.sortItems(hangul, 'name', 'asc', c))).toBe('abd')
    expect(ids(B.sortItems(hangul, 'name', 'desc', c))).toBe('dba')
    // N-2 before N-10
    expect(ids(B.sortItems(items, 'no', 'asc', c)).slice(0, 2)).toBe('ab')
    expect(ids(B.sortItems(items, 'no', 'desc', c)).slice(0, 2)).toBe('ba')
    expect(ids(B.sortItems(items, 'amount', 'desc', c))).toBe('abdc')
    expect(ids(B.sortItems(hangul, 'qty', 'asc', c))).toBe('bda')
    expect(items.map((x) => x.id).join('')).toBe('abcd')
    // blanks go last in both directions
    expect(ids(B.sortItems(items, 'holder', 'asc', c))[0]).toBe('a')
    expect(ids(B.sortItems(items, 'holder', 'desc', c))[0]).toBe('a')
  })
  it('sums up by category, status and place', () => {
    const s = B.summary(items, [], '2026-11-24')
    expect(s).toMatchObject({ count: 3, qty: 5, amount: 2000000 + 700000 + 48000, disposed: 1, low: 1, over: 1, out: 0 })
    expect(plain(s.byCat[0])).toEqual({ name: '전산장비', count: 1, qty: 2, amount: 2000000 })
    expect(plain(s.byStatus.map((x: any) => x.count))).toEqual([3, 0, 0, 0, 1])
    expect(s.byLoc.map((x: any) => x.name).sort()).toEqual(['3층', '창고', '회의실'])
    expect(B.catsOf(items)).toContain('전산장비')
    expect(plain(B.locsOf(items))).toEqual(['3층', '창고', '회의실'])
  })
})

describe('bipum plugin: files', () => {
  it('writes a CSV Excel opens (BOM, CRLF, quotes) and reads it back', () => {
    const src = [item({ id: 'a', name: '모니터, 27"', no: 'M-1', qty: 2, price: 300000, got: '2025-01-02', loc: '3층', status: 1, note: '=SUM(A1)' }), item({ id: 'b', name: 'A4', kind: 1, qty: 5, min: 2, unit: '박스' })]
    const csv = B.toCsv(src, { loans: [] })
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('\r\n')
    expect(csv).toContain('"모니터, 27"""')
    // a cell that would run as a formula is written as text
    expect(csv).toContain("'=SUM(A1)")
    const back = B.importCsv(csv, [])
    expect(back.error).toBeUndefined()
    expect(back.added).toBe(2)
    expect(plain(back.items[0])).toMatchObject({ name: '모니터, 27"', no: 'M-1', qty: 2, price: 300000, got: '2025-01-02', loc: '3층', status: 1, note: '=SUM(A1)' })
    expect(plain(back.items[1])).toMatchObject({ name: 'A4', kind: 1, qty: 5, min: 2, unit: '박스' })
  })
  it('updates the item with the same 관리번호 and adds the rest', () => {
    const have = [item({ id: 'keep01', name: '노트북', no: 'N-1', loc: '3층', holder: '홍길동', status: 2 })]
    const r = B.importCsv('물품명,자산번호,보관장소,수량\n노트북(신형),N-1,5층,1\n의자,C-1,5층,4\n,,5층,1\n', have)
    expect(r).toMatchObject({ added: 1, updated: 1 })
    // columns that are not in the file keep their values
    expect(plain(r.items[0])).toMatchObject({ id: 'keep01', name: '노트북(신형)', loc: '5층', holder: '홍길동', status: 2 })
    expect(r.items[1]).toMatchObject({ name: '의자', qty: 4 })
    expect(r.items[1].id).toBeTruthy()
    expect(plain(r.skipped)).toEqual([{ line: 4, reason: '품명을 입력하세요.' }])
  })
  it('reads tab-separated text and reports what it cannot use', () => {
    const r = B.importCsv('품명\t취득일\t상태\n금고\t작년\t보관\n', [])
    expect(r.items[0]).toMatchObject({ name: '금고', got: '', status: 1 })
    expect(r.skipped[0].reason).toContain('취득일')
    expect(B.importCsv('이름,수량\nx,1\n', []).error).toContain('품명')
    expect(B.importCsv('', []).error).toBeTruthy()
  })
  it('the template is a valid import', () => {
    const r = B.importCsv(B.templateCsv(), [])
    expect(r).toMatchObject({ added: 3, updated: 0 })
    expect(plain(r.skipped)).toEqual([])
    expect(plain(r.items.map((x: any) => [x.kind, x.lend, x.min]))).toEqual([[0, false, 0], [0, true, 0], [1, false, 3]])
  })
  it('parses quoted cells with line breaks', () => {
    expect(plain(B.parseCsv('a,"b\nc",d\r\n"1,2",,3\r\n\r\n'))).toEqual([['a', 'b\nc', 'd'], ['1,2', '', '3']])
  })
  it('history and inventory check files', () => {
    const beam = item({ id: 'beam01', name: '빔', qty: 1, lend: true, no: 'B-1' })
    const a = B.takeOut(null, beam, [], { qty: 1, note: '출장' }, T0)
    const h = room(B.headShared({ audit: { id: 'au1', title: '조사', at: T0 } }, [beam]), { entries: { kim: entry('김', B.setCheck(a.entry, { id: 'au1' }, beam, { code: 3, note: '렌즈 흠' }, T0, []).entry) } })
    const loans = B.allLoans(h)
    expect(B.loansCsv(loans, [beam])).toContain('대여,2026-11-24 09:00,빔,B-1,1,대,김,김,,,대여 중,출장')
    expect(B.auditCsv([beam], B.auditMap(h), loans)).toContain('B-1,빔,,전산장비,,,1,1,이상,김,2026-11-24,렌즈 흠')
  })
  it('backup: a register handed over starts from the stock of that moment', () => {
    const paper = item({ id: 'paper1', name: 'A4', kind: 1, qty: 10, baseAt: 5 })
    const out = B.takeOut(null, paper, [], { qty: 4 }, T0)
    const loans = B.allLoans(bookWith([paper], { kim: entry('김', out.entry) }).head)
    const b = B.fromBackup(B.toBackup('총무팀 대장', [paper, item()], loans))
    expect(b.title).toBe('총무팀 대장')
    expect(b.items[0]).toMatchObject({ id: 'paper1', qty: 6, baseAt: 0 })
    expect(b.items).toHaveLength(2)
    expect(B.fromBackup('{"format":"other"}').error).toBeTruthy()
    expect(B.fromBackup('not json').error).toBeTruthy()
  })
})

describe('bipum plugin: manifest', () => {
  it('is a valid plugin manifest', () => {
    const m = JSON.parse(readFileSync(join(import.meta.dirname, '../../plugins/bipum/manifest.json'), 'utf8'))
    expect(pluginManifestSchema.safeParse(m).success).toBe(true)
    expect(m.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
