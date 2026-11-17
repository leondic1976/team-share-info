import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Db } from '../../src/node/sqlite'
import { LedgerStore } from '../../src/node/ledger-store'
import { LOCAL_MIGRATIONS } from '../../src/main/localdb/migrations'
import { LedgersRepo } from '../../src/main/localdb/ledgers'
import { KvRepo } from '../../src/main/localdb/kv'
import { ledgerChangeSchema } from '../../src/shared/schemas/ledger'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx: Record<string, any> = {}
for (const f of ['formula.js', 'sheet.js', 'store.js']) runInNewContext(readFileSync(join(import.meta.dirname, '../../resources/ledger', f), 'utf8'), ctx)
const S = ctx.LedgerSheet
const L = ctx.LedgerStore
// objects made inside the vm context have another Object.prototype: compare by value
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v))

const cols = [
  { id: 'a', name: '품명', type: 'text' },
  { id: 'b', name: '수량', type: 'number' },
  { id: 'c', name: '단가', type: 'number' },
  { id: 'd', name: '금액', type: 'calc', calc: '=[수량]*[단가]' }
]
const doc = (n: number) => ({ name: '대장', cols: plain(cols), rows: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, p: (i + 1) * 1024, c: { a: `품목 ${i}`, b: i, c: 100 } })) })
/** A sheet on screen with one edit function, as app.js does it. */
function screen(d: any, meta = { version: 1, headRev: 1 }) {
  const o = L.open(d, meta)
  const st = { book: o.book as any, shadow: o.shadow as any }
  const change = (fn: (b: any) => void): void => {
    st.book.rows = st.book.rows.slice()
    fn(st.book)
    L.seal(st.book.rows)
  }
  return { st, change }
}
const ids = (b: any): string[] => b.rows.map((r: any) => r.id)

describe('ledger store (what a save carries, how others\' changes merge)', () => {
  it('rows are never changed in place; a save carries only the changed cells with the value seen before', () => {
    const { st, change } = screen(doc(4))
    const before = st.book.rows
    expect(L.diff(st.book, st.shadow)).toBeNull()
    expect(() => (before[0].c.a = 'x')).toThrow()
    change((b) => {
      L.writable(b, 1).c.a = '의자'
      delete L.writable(b, 1).c.c
      L.writable(b, 2).c.b = 2 // the same value: nothing to save for this row
      b.rows.splice(1, 0, { id: 'n1', c: { a: '사이' } })
      b.rows.pop()
      b.name = '새 이름'
    })
    expect(before[1].c.a).toBe('품목 1')
    const d = L.diff(st.book, st.shadow)
    expect(plain(d.set)).toEqual([{ id: 'r1', set: { a: '의자', c: null }, was: { a: '품목 1', c: 100 } }])
    expect(plain(d.add)).toEqual([{ id: 'n1', p: 1536, c: { a: '사이' } }])
    expect(plain(d.move)).toEqual([])
    expect(plain(d.remove)).toEqual(['r3'])
    expect(d.head.rev).toBe(1)
    expect(d.head.value.name).toBe('새 이름')
    expect(d.head.value.rows).toBeUndefined()
    // what is sent passes the schema of the storage
    expect(ledgerChangeSchema.safeParse({ ...plain(L.pieces(d)[0]), since: 1 }).success).toBe(true)
  })

  it('positions: new rows go between their neighbours; a sort moves rows; no room left renumbers all', () => {
    const pos = new Map([['a', 1024], ['b', 2048], ['c', 3072]])
    const rows = (...x: string[]) => x.map((id) => ({ id }))
    expect(plain(L.place(rows('a', 'x', 'y', 'b', 'c'), pos))).toEqual([1024, 1024 + 1024 / 3, 1024 + (2 * 1024) / 3, 2048, 3072])
    expect(plain(L.place(rows('x', 'a', 'b', 'c', 'y'), pos))).toEqual([0, 1024, 2048, 3072, 4096])
    expect(plain(L.place(rows('x', 'y'), new Map()))).toEqual([1024, 2048])
    // reversed: the first row keeps its place, the others follow it
    expect(plain(L.place(rows('c', 'b', 'a'), pos))).toEqual([3072, 4096, 5120])
    const tight = new Map([['a', 1], ['b', 1.0000001]])
    expect(plain(L.place(rows('a', 'x', 'b'), tight))).toEqual([1024, 2048, 3072])
    // a large change is cut into requests the storage accepts
    const { st, change } = screen(doc(0))
    change((b) => {
      for (let i = 0; i < 4500; i++) b.rows.push({ id: `n${i}`, c: { a: 'x' } })
    })
    const parts = L.pieces(L.diff(st.book, st.shadow))
    expect(parts.map((x: any) => x.add.length)).toEqual([2000, 2000, 500])
    // …and by size: rows with long text do not make one request too large for the server
    const long = screen(doc(0))
    long.change((b) => {
      for (let i = 0; i < 100; i++) b.rows.push({ id: `n${i}`, c: { a: 'x'.repeat(60_000) } })
    })
    const big = L.pieces(L.diff(long.st.book, long.st.shadow))
    expect(big.length).toBeGreaterThan(3)
    for (const x of big) expect(JSON.stringify(x).length).toBeLessThan(2_000_000)
    expect(big.reduce((n: number, x: any) => n + x.add.length, 0)).toBe(100)
    // removed rows and the head travel with the first request
    const mixed = screen(doc(5))
    mixed.change((b) => {
      b.rows.splice(0, 2)
      b.name = 'x'
      L.writable(b, 0).c.a = 'y'
    })
    const m = L.pieces(L.diff(mixed.st.book, mixed.st.shadow))
    expect(m).toHaveLength(1)
    expect([m[0].remove.length, m[0].set.length, !!m[0].head]).toEqual([2, 1, true])
  })

  it('two people edit one server ledger: different cells merge, the same cell is never overwritten, rows appear and go', () => {
    const db = new Db(':memory:')
    db.migrate(LOCAL_MIGRATIONS)
    const store = new LedgerStore(db)
    db.run('INSERT INTO ledgers (id, name, head, created_at, updated_at) VALUES (?, ?, ?, 1, 1)', ['L', '대장', JSON.stringify({ name: '대장', cols })])
    store.fill('L', doc(4).rows)
    const openIt = () => screen(store.doc('L'), { version: db.get<{ version: number }>('SELECT version FROM ledgers')!.version, headRev: db.get<{ head_rev: number }>('SELECT head_rev FROM ledgers')!.head_rev })
    /** save as app.js does: every piece, then the answer goes into the sheet */
    const save = (who: ReturnType<typeof screen>, name: string) => {
      const d = L.diff(who.st.book, who.st.shadow)
      const out = { lost: [] as any[], headRefused: false }
      if (!d) return out
      for (const piece of L.pieces(d)) {
        const r = store.apply('L', ledgerChangeSchema.parse({ ...plain(piece), since: who.st.shadow.version }), { id: name, name })
        const head = db.get<{ version: number; head_rev: number }>('SELECT version, head_rev FROM ledgers')!
        const res = L.settle(who.st.book, who.st.shadow, piece, d, { meta: { version: head.version, headRev: head.head_rev }, changes: r.changes, refused: r.refused })
        who.st.book = res.book
        out.lost.push(...res.lost)
        out.headRefused = out.headRefused || res.headRefused
      }
      return out
    }
    const pull = (who: ReturnType<typeof screen>) => {
      const res = L.merge(who.st.book, who.st.shadow, store.changes('L', who.st.shadow.version))
      who.st.book = res.book
      return res
    }
    const A = openIt()
    const B = openIt()

    // A: name of r1, a new row after r0. B (not knowing): amount of r1, removes r3.
    A.change((b) => {
      L.writable(b, 1).c.a = 'A가 고친 이름'
      b.rows.splice(1, 0, { id: 'a-new', c: { a: 'A의 새 행' } })
    })
    B.change((b) => {
      L.writable(b, 1).c.b = 77
      b.rows.pop()
    })
    expect(save(A, 'A').lost).toEqual([])
    expect(save(B, 'B').lost).toEqual([])
    // B got A's work with the answer of its own save; A reads what B did
    expect(ids(B.st.book)).toEqual(['r0', 'a-new', 'r1', 'r2'])
    expect(plain(B.st.book.rows[2].c)).toEqual({ a: 'A가 고친 이름', b: 77, c: 100 })
    pull(A)
    expect(plain(A.st.book)).toEqual(plain(B.st.book))
    expect(L.diff(A.st.book, A.st.shadow)).toBeNull()
    expect(L.diff(B.st.book, B.st.shadow)).toBeNull()

    // the same cell: A first, B's value loses and comes back in `lost`; B's other row is saved
    A.change((b) => (L.writable(b, 0).c.a = 'A가 먼저'))
    B.change((b) => {
      L.writable(b, 0).c.a = 'B가 나중'
      L.writable(b, 3).c.a = 'B의 다른 행'
    })
    save(A, 'A')
    const lost = save(B, 'B')
    expect(plain(lost.lost)).toEqual([{ id: 'r0', c: { a: 'B가 나중', b: 0, c: 100 } }])
    expect(B.st.book.rows[0].c.a).toBe('A가 먼저')
    pull(A)
    expect(A.st.book.rows[3].c.a).toBe('B의 다른 행')
    expect(plain(A.st.book)).toEqual(plain(B.st.book))

    // A is typing in a row (not saved yet) while B's change to another cell of that row arrives: both stay
    A.change((b) => (L.writable(b, 2).c.c = 555))
    B.change((b) => (L.writable(b, 2).c.b = 9))
    save(B, 'B')
    expect(pull(A).lost).toEqual([])
    expect(plain(A.st.book.rows[2].c)).toEqual({ a: 'A가 고친 이름', b: 9, c: 555 })
    expect(save(A, 'A').lost).toEqual([])
    pull(B)
    expect(plain(B.st.book.rows[2].c)).toEqual({ a: 'A가 고친 이름', b: 9, c: 555 })

    // B removes a row A is editing: A's edit is refused ("gone") and handed back
    B.change((b) => b.rows.splice(1, 1))
    save(B, 'B')
    A.change((b) => (L.writable(b, 1).c.a = '지워진 행을 고침'))
    const gone = save(A, 'A')
    expect(gone.lost.map((r: any) => r.id)).toEqual(['a-new'])
    expect(ids(A.st.book)).toEqual(['r0', 'r1', 'r2'])

    // head (columns, name): the second change made on the old head is refused and theirs taken
    A.change((b) => (b.name = 'A의 이름'))
    B.change((b) => (b.name = 'B의 이름'))
    save(A, 'A')
    expect(save(B, 'B').headRefused).toBe(true)
    expect(B.st.book.name).toBe('A의 이름')
    expect(L.diff(B.st.book, B.st.shadow)).toBeNull()

    // A sorts while B adds a row at the end: the row count and the content agree afterwards
    A.change((b) => (b.rows = b.rows.slice().reverse()))
    B.change((b) => b.rows.push({ id: 'b-new', c: { a: 'B의 새 행' } }))
    save(B, 'B')
    save(A, 'A')
    pull(B)
    expect(ids(A.st.book).slice().sort()).toEqual(['b-new', 'r0', 'r1', 'r2'])
    expect(ids(B.st.book)).toEqual(ids(A.st.book))
    expect(ids(screen(store.doc('L')).st.book)).toEqual(ids(A.st.book))
    db.close()
  })

  it('computes large sheets row by row: an unchanged row is not computed again', () => {
    const { st, change } = screen(doc(50_000))
    const cache: any = {}
    const first = S.compute(st.book, cache)
    expect(first.values[49_999]).toEqual(['품목 49999', 49_999, 100, 4_999_900])
    const kept = first.values[10]
    change((b) => (L.writable(b, 7).c.b = 3))
    const t0 = Date.now()
    const second = S.compute(st.book, cache)
    const took = Date.now() - t0
    expect(second.values[7][3]).toBe(300)
    expect(second.values[10]).toBe(kept)
    expect(took).toBeLessThan(500)
    // the same numbers as the whole-sheet way
    const small = screen(doc(30))
    expect(plain(S.compute(small.st.book, {}).values)).toEqual(plain(S.compute(small.st.book).values))
    // a formula that reads a whole column, or a cell formula, falls back to the whole sheet
    const whole = screen({ ...doc(5), cols: [...plain(cols), { id: 'e', name: '누적', type: 'calc', calc: '=CUMSUM([금액])' }, { id: 'f', name: '비율', type: 'calc', calc: '=[금액]/SUM([금액])' }] })
    expect(S.computeByRow(whole.st.book, {})).toBeNull()
    expect(S.compute(whole.st.book, {}).values[2].slice(3)).toEqual([200, 300, 0.2])
    const cellF = screen(doc(5))
    cellF.change((b) => (L.writable(b, 4).c.a = '=SUM(B1:B4)'))
    expect(S.computeByRow(cellF.st.book, {})).toBeNull()
    expect(S.compute(cellF.st.book, {}).values[4][0]).toBe(6)
    // functions taking one value per argument work on their own row; an empty row stays blank; cycles show
    const local = screen({
      name: 't',
      cols: [
        { id: 'a', name: '이름', type: 'text' },
        { id: 'b', name: '값', type: 'number' },
        { id: 'c', name: '글자수', type: 'calc', calc: '=LEN([이름])' },
        { id: 'd', name: '판정', type: 'calc', calc: '=IF([@값]>=10,"큼",ROUND([값]/3,1))' },
        { id: 'e', name: '돌고', type: 'calc', calc: '=[돌아]+1' },
        { id: 'f', name: '돌아', type: 'calc', calc: '=[돌고]+1' }
      ],
      rows: [{ id: 'r0', c: { a: '가나다', b: 10 } }, { id: 'r1', c: { a: 'x', b: 4 } }, { id: 'r2', c: {} }]
    })
    const v = S.computeByRow(local.st.book, {}).values
    expect(v[0].slice(2, 4)).toEqual([3, '큼'])
    expect(v[1].slice(2, 4)).toEqual([1, 1.3])
    expect(v[2].slice(2)).toEqual(['', '', '', ''])
    expect(v[0][4].code).toBe('#CYCLE!')
    expect(plain(v.map((r: any[]) => r.slice(0, 4)))).toEqual(plain(S.compute(local.st.book).values.map((r: any[]) => r.slice(0, 4))))
  })

  it('a book from the rows of an Excel sheet: header row, column types from the values', () => {
    const b = S.fromMatrix(
      [
        ['품명', '수량', '취득일', '확인', null, '품명'],
        ['노트북', 2, '2026-03-02', true, null, 1],
        [null, null, null, null, null, null],
        ['의자', 10.5, '2026-11-16', false, 'x', '글자']
      ],
      '가져온 표'
    )
    expect(b.name).toBe('가져온 표')
    expect(b.cols.map((c: any) => [c.name, c.type])).toEqual([['품명', 'text'], ['수량', 'number'], ['취득일', 'date'], ['확인', 'check'], ['E', 'text'], ['품명_', 'text']])
    expect(b.rows).toHaveLength(2)
    expect(Object.values(b.rows[0].c)).toEqual(['노트북', 2, '2026-03-02', true, '1'])
    expect(() => S.fromMatrix([[null]], 'x')).toThrow(/빈 파일/)
  })
})

describe('personal ledgers in the local DB (관리대장 · 개인용)', () => {
  const open = () => {
    const db = new Db(':memory:')
    db.migrate(LOCAL_MIGRATIONS)
    return { db, repo: new LedgersRepo(db), kv: new KvRepo(db) }
  }

  it('create, save by change, versions, trash and restore', () => {
    const { db, repo } = open()
    const made = repo.create({ name: '내 대장', cols: plain(cols), rows: doc(3).rows.map((r) => ({ id: r.id, c: r.c })) }, '📦')
    expect(made).toMatchObject({ name: '내 대장', icon: '📦', rows: 3, version: 1, deletedAt: null })
    expect(repo.list().map((x) => x.id)).toEqual([made.id])
    const got = repo.get(made.id)
    expect(got.doc.rows.map((r) => [r.id, r.p])).toEqual([['r0', 1024], ['r1', 2048], ['r2', 3072]])
    expect(got.more).toBe(false)
    // pages
    expect(repo.get(made.id, null, 2)).toMatchObject({ more: true })
    expect(repo.get(made.id, { p: 2048, id: 'r1' }, 2).doc.rows.map((r) => r.id)).toEqual(['r2'])

    const saved = repo.save(made.id, ledgerChangeSchema.parse({ since: 1, set: [{ id: 'r0', set: { a: '고침' }, was: { a: '품목 0' } }], remove: ['r2'], head: { rev: 1, value: { name: '새 이름', cols } } }))
    expect(saved.meta).toMatchObject({ name: '새 이름', rows: 2, version: 2, headRev: 2 })
    expect(saved.refused).toEqual({ rows: [] })
    // the sheet before the first edit was kept; go back to it
    const vs = repo.versions(made.id)
    expect(vs).toMatchObject([{ version: 1, rows: 3, reason: 'edit', name: '내 대장' }])
    expect(repo.versionDoc(made.id, vs[0].id).rows).toHaveLength(3)
    expect(repo.revert(made.id, vs[0].id)).toMatchObject({ name: '내 대장', rows: 3 })
    expect(repo.doc(made.id).rows.map((r) => r.c.a)).toEqual(['품목 0', '품목 1', '품목 2'])
    expect(repo.keep(made.id)[0]).toMatchObject({ reason: 'manual' })

    repo.remove(made.id)
    expect(repo.list()).toEqual([])
    expect(() => repo.get(made.id)).toThrow()
    expect(repo.trash().map((x) => x.id)).toEqual([made.id])
    expect(repo.restore(made.id).deletedAt).toBeNull()
    repo.remove(made.id)
    repo.purge(made.id)
    expect(repo.trash()).toEqual([])
    expect(db.get('SELECT COUNT(*) AS n FROM ledger_rows')).toEqual({ n: 0 })
    expect(db.get('SELECT COUNT(*) AS n FROM ledger_versions')).toEqual({ n: 0 })
    db.close()
  })

  it('ledgers of v1.1.0 (kept whole under kv keys) become rows once; a broken one stays where it is', () => {
    const { db, repo, kv } = open()
    kv.set('plugin:ledger:index', [{ id: 'b1', name: '옛 대장', icon: '📦', rows: 2, updatedAt: 1700000000000 }])
    kv.set('plugin:ledger:book:b1', { id: 'b1', name: '옛 대장', template: 'asset', updatedAt: 1700000000000, note: '설명', cols: plain(cols), rows: [{ id: 'r1', c: { a: '=A2', b: 2 } }, { id: 'r2', c: {} }], share: { roomId: 'x' } })
    kv.set('plugin:ledger:book:bad', { id: 'bad', name: '', cols: 'no' })
    kv.set('plugin:ledger:last', { book: 'b1' })
    expect(repo.importLegacy(kv)).toBe(1)
    const list = repo.list()
    expect(list).toMatchObject([{ name: '옛 대장', icon: '📦', rows: 2, updatedAt: 1700000000000 }])
    const d = repo.doc(list[0].id)
    expect(d).toMatchObject({ name: '옛 대장', template: 'asset', note: '설명', share: { roomId: 'x' } })
    expect((d as Record<string, unknown>).updatedAt).toBeUndefined()
    expect(d.rows.map((r) => r.c)).toEqual([{ a: '=A2', b: 2 }, {}])
    expect(kv.get('plugin:ledger:last')).toEqual({ book: list[0].id })
    expect(kv.get('plugin:ledger:book:b1')).toBeUndefined()
    // the unreadable one is not thrown away, and nothing is imported twice
    expect(kv.get('plugin:ledger:book:bad')).toBeTruthy()
    expect(repo.importLegacy(kv)).toBe(0)
    expect(repo.list()).toHaveLength(1)
    db.close()
  })
})
