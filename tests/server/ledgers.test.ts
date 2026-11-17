import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type Cred, type TestServer } from './helpers'
import { Db } from '../../src/node/sqlite'
import { LedgerStore } from '../../src/node/ledger-store'
import { SERVER_MIGRATIONS } from '../../src/server/db/migrations'
import { LEDGER_MAX_ROWS, LEDGER_ROW_MAX, LEDGER_SNAPSHOT_GAP_MS, LEDGER_TRASH_DAYS } from '../../src/shared/schemas/ledger'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'
const base = '/api/ledgers'
const team = { type: 'team', groupIds: [], memberIds: [] }
const cols = [
  { id: 'c1', name: '품명', type: 'text', width: 160 },
  { id: 'c2', name: '수량', type: 'number', total: 'sum' },
  { id: 'c3', name: '금액', type: 'calc', calc: '=[수량]*1000' }
]
const doc = (name = '비품 대장', rows = 1) => ({
  id: 'b-local',
  name,
  template: 'asset',
  cols,
  rows: Array.from({ length: rows }, (_, i) => ({ id: `r${i}`, c: { c1: `품목 ${i}`, c2: i + 1 } }))
})
const head = (name = '비품 대장', more: object = {}) => ({ name, template: 'asset', cols, ...more })

describe('team ledgers (관리대장 · 팀용/지정자용)', () => {
  const call = (who: Cred, method: string, url: string, payload?: object) => s!.req(who, { method: method as 'GET', url, ip: IP, ...(payload ? { payload } : {}) })
  const data = async (who: Cred, method: string, url: string, payload?: object) => (await call(who, method, url, payload)).json().data
  const rowsOf = async (who: Cred, id: string): Promise<{ id: string; p: number; c: Record<string, unknown> }[]> => (await data(who, 'GET', `${base}/${id}?limit=5000`)).doc.rows

  it('keeps the sheet whole, lists it by scope and hides it outside the scope', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const d = await s.join('D')
    const made = await data(b, 'POST', base, { doc: doc('비품 대장', 3), scope: { type: 'members', groupIds: [], memberIds: [c.memberId] }, icon: '📦' })
    expect(made).toMatchObject({ name: '비품 대장', icon: '📦', rows: 3, version: 1, headRev: 1, editMode: 'all', ownerName: 'B', canEdit: true, canManage: true, more: false })
    // formulas, column settings and unknown fields come back exactly as stored; rows carry a position, no ledger id
    const { rows, ...h } = made.doc
    expect(h).toEqual(head())
    expect(rows).toEqual([0, 1, 2].map((i) => ({ id: `r${i}`, p: (i + 1) * 1024, c: { c1: `품목 ${i}`, c2: i + 1 } })))
    expect((await data(c, 'GET', base)).map((x: { name: string }) => x.name)).toEqual(['비품 대장'])
    expect(await data(c, 'GET', `${base}/${made.id}?limit=100`)).toMatchObject({ canEdit: true, canManage: false })
    expect(await data(d, 'GET', base)).toEqual([])
    for (const [m, u, p] of [
      ['GET', '', undefined],
      ['GET', '/changes?since=0', undefined],
      ['POST', '/changes', { set: [{ id: 'r0', set: { c1: 'x' }, was: { c1: '품목 0' } }] }],
      ['PUT', '', { doc: doc(), version: 1 }],
      ['GET', '/versions', undefined],
      ['DELETE', '', undefined]
    ] as const)
      expect((await call(d, m, `${base}/${made.id}${u}`, p)).statusCode).toBe(404)
    // the list carries no sheet
    expect((await data(c, 'GET', base))[0].doc).toBeUndefined()
    // pages: two rows at a time
    const p1 = await data(c, 'GET', `${base}/${made.id}?limit=2`)
    expect(p1.doc.rows.map((r: { id: string }) => r.id)).toEqual(['r0', 'r1'])
    expect(p1.more).toBe(true)
    const p2 = await data(c, 'GET', `${base}/${made.id}?limit=2&p=${p1.doc.rows[1].p}&after=r1`)
    expect(p2.doc.rows.map((r: { id: string }) => r.id)).toEqual(['r2'])
    expect(p2.more).toBe(false)
  })

  it('several people edit at once: different cells are both kept, the same cell is never overwritten', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const sent: { to: string[]; name: string; payload: unknown }[] = []
    s.ctx.hub.sendTo = (ids, name, payload) => void sent.push({ to: [...ids], name, payload })
    const id = (await data(b, 'POST', base, { doc: doc('대장', 3), scope: team })).id
    const u = `${base}/${id}`
    const save = (who: Cred, change: object) => data(who, 'POST', `${u}/changes`, change)

    // B changes the name of r0, C the amount of r0 — both made on version 1
    sent.length = 0
    const s1 = await save(b, { since: 1, set: [{ id: 'r0', set: { c1: '의자' }, was: { c1: '품목 0' } }] })
    expect(s1).toMatchObject({ meta: { version: 2, updatedByName: 'B' }, refused: { rows: [] }, changes: { version: 2, rows: [], gone: [] } })
    expect(sent.find((m) => m.name === 'ledger.changed')).toMatchObject({ payload: { id, version: 2, byId: b.memberId } })
    expect(sent.find((m) => m.name === 'ledger.changed')!.to).toContain(c.memberId)
    const s2 = await save(c, { since: 1, set: [{ id: 'r0', set: { c2: 7 }, was: { c2: 1 } }] })
    expect(s2.refused.rows).toEqual([])
    // C is told what B did to that row meanwhile
    expect(s2.changes).toMatchObject({ version: 3, rows: [{ id: 'r0', c: { c1: '의자', c2: 7 } }] })
    expect((await rowsOf(b, id))[0].c).toEqual({ c1: '의자', c2: 7 })

    // both change the same cell: the second one is refused and gets the stored value
    await save(b, { since: 3, set: [{ id: 'r1', set: { c1: 'B가 먼저' }, was: { c1: '품목 1' } }] })
    const lost = await save(c, { since: 3, set: [{ id: 'r1', set: { c1: 'C가 나중' }, was: { c1: '품목 1' } }, { id: 'r2', set: { c2: 30 }, was: { c2: 3 } }] })
    expect(lost.refused.rows).toEqual([{ id: 'r1', reason: 'changed' }])
    expect(lost.changes.rows.find((r: { id: string }) => r.id === 'r1').c.c1).toBe('B가 먼저')
    const now = await rowsOf(b, id)
    expect(now[1].c.c1).toBe('B가 먼저')
    // the rest of C's save went through
    expect(now[2].c.c2).toBe(30)
    // sending the same save again (answer lost on the way) changes nothing and is not refused
    const again = await save(c, { since: lost.meta.version, set: [{ id: 'r2', set: { c2: 30 }, was: { c2: 3 } }] })
    expect(again).toMatchObject({ meta: { version: lost.meta.version }, refused: { rows: [] } })

    // new rows, moved rows, removed rows; emptied cells go
    const v = again.meta.version
    const s3 = await save(b, { since: v, add: [{ id: 'n1', p: 1500, c: { c1: '사이에 넣음' } }], move: [{ id: 'r2', p: 100 }], remove: ['r1'], set: [{ id: 'r0', set: { c2: null }, was: { c2: 7 } }] })
    expect(s3.meta).toMatchObject({ rows: 3, version: v + 1 })
    expect((await rowsOf(c, id)).map((r) => [r.id, r.c])).toEqual([
      ['r2', { c1: '품목 2', c2: 30 }],
      ['r0', { c1: '의자' }],
      ['n1', { c1: '사이에 넣음' }]
    ])
    // C was away: the feed says what changed after the version C has
    const feed = await data(c, 'GET', `${u}/changes?since=${v}`)
    expect(feed.version).toBe(v + 1)
    expect(feed.gone).toEqual(['r1'])
    expect(feed.rows.map((r: { id: string }) => r.id).sort()).toEqual(['n1', 'r0', 'r2'])
    expect(await data(c, 'GET', `${u}/changes?since=${v + 1}`)).toMatchObject({ rows: [], gone: [] })
    // a row somebody removed cannot be edited
    expect((await save(c, { since: v + 1, set: [{ id: 'r1', set: { c1: 'x' }, was: { c1: 'B가 먼저' } }] })).refused.rows).toEqual([{ id: 'r1', reason: 'gone' }])

    // name, note and columns are one unit: the second change made on the old head is refused
    const h1 = await save(b, { since: v + 1, head: { rev: 1, value: head('비품 대장 2026', { note: '분기마다 점검' }) } })
    expect(h1.meta).toMatchObject({ name: '비품 대장 2026', headRev: 2 })
    const h2 = await save(c, { since: v + 1, head: { rev: 1, value: head('C의 이름') } })
    expect(h2.refused.head).toBe(true)
    expect(h2.changes.head).toMatchObject({ name: '비품 대장 2026', note: '분기마다 점검' })
    expect((await data(c, 'GET', `${u}?limit=10`)).name).toBe('비품 대장 2026')
    expect((await save(c, { since: h2.meta.version, head: { rev: 2, value: head('둘이 정한 이름') } })).meta).toMatchObject({ name: '둘이 정한 이름', headRev: 3 })
  })

  it('tells who has not seen a change; the admin menu count follows', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const me = async (who: Cred): Promise<number> => (await data(who, 'GET', '/api/me')).ledgerUnseen
    const id = (await data(b, 'POST', base, { doc: doc(), scope: team })).id
    expect(await me(b)).toBe(0)
    expect(await me(c)).toBe(1)
    expect((await data(c, 'GET', base))[0].unseen).toBe(true)
    await data(c, 'GET', `${base}/${id}?limit=10`)
    expect(await me(c)).toBe(0)
    await data(c, 'POST', `${base}/${id}/changes`, { since: 1, set: [{ id: 'r0', set: { c2: 5 }, was: { c2: 1 } }] })
    expect(await me(c)).toBe(0)
    expect(await me(b)).toBe(1)
    await data(b, 'GET', `${base}/${id}/changes?since=1`)
    expect(await me(b)).toBe(0)
  })

  it('edit mode "owner": others only read; the creator and admins edit and manage', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const id = (await data(b, 'POST', base, { doc: doc(), scope: team, editMode: 'owner' })).id
    const u = `${base}/${id}`
    const edit = { since: 1, set: [{ id: 'r0', set: { c1: 'x' }, was: { c1: '품목 0' } }] }
    expect(await data(c, 'GET', `${u}?limit=10`)).toMatchObject({ canEdit: false, canManage: false, doc: { name: '비품 대장' } })
    expect((await call(c, 'POST', `${u}/changes`, edit)).statusCode).toBe(403)
    expect((await call(c, 'PUT', u, { doc: doc('x'), version: 1 })).statusCode).toBe(403)
    expect((await call(c, 'PATCH', u, { editMode: 'all' })).statusCode).toBe(403)
    expect((await call(c, 'DELETE', u)).statusCode).toBe(403)
    expect((await call(c, 'POST', `${u}/versions`)).statusCode).toBe(403)
    expect((await s.req(s.admin, { method: 'POST', url: `${u}/changes`, payload: edit })).json().data.meta.version).toBe(2)
    // the creator opens it up
    expect((await data(b, 'PATCH', u, { editMode: 'all' })).editMode).toBe('all')
    expect((await call(c, 'POST', `${u}/changes`, { since: 2, set: [{ id: 'r0', set: { c2: 9 }, was: { c2: 1 } }] })).statusCode).toBe(200)
  })

  it('changing the audience tells those who gain and lose it; trash, restore, purge', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const d = await s.join('D')
    const g = await data(b, 'POST', '/api/groups', { name: '물품팀', visibility: 'private', memberIds: [c.memberId] })
    for (const i of (await data(c, 'GET', '/api/group-invites')) as { id: string; groupId: string }[]) await call(c, 'PATCH', `/api/groups/${i.groupId}/invites/${i.id}`, { action: 'accept' })
    const sent: { to: string[]; name: string; payload: { shared?: boolean; deleted?: boolean } }[] = []
    s.ctx.hub.sendTo = (ids, name, payload) => void sent.push({ to: [...ids], name, payload: payload as object })
    const id = (await data(b, 'POST', base, { doc: doc(), scope: { type: 'group', groupIds: [g.id], memberIds: [] } })).id
    const u = `${base}/${id}`
    // the people it is shared with are told so, by name
    expect(sent.find((m) => m.payload.shared)).toMatchObject({ to: [c.memberId], payload: { id, name: '비품 대장', byName: 'B' } })
    expect((await data(c, 'GET', `${u}?limit=10`)).scope.groups[0].name).toBe('물품팀')
    expect((await call(d, 'GET', u)).statusCode).toBe(404)
    // D cannot put a ledger into a group D is not in
    expect((await call(d, 'POST', base, { doc: doc(), scope: { type: 'group', groupIds: [g.id], memberIds: [] } })).statusCode).toBe(400)

    sent.length = 0
    await call(b, 'PATCH', u, { scope: { type: 'members', groupIds: [], memberIds: [d.memberId] } })
    expect((await call(d, 'GET', u)).statusCode).toBe(200)
    expect((await call(c, 'GET', u)).statusCode).toBe(404)
    expect(sent.find((m) => m.payload.shared)!.to).toEqual([d.memberId])
    expect(sent.find((m) => !m.payload.shared)!.to).toEqual(expect.arrayContaining([c.memberId, b.memberId]))

    // deleted: gone for everyone, kept in the trash of the creator (and admins)
    sent.length = 0
    expect((await call(d, 'DELETE', u)).statusCode).toBe(403)
    expect((await call(b, 'DELETE', u)).statusCode).toBe(200)
    expect(sent.find((m) => m.name === 'ledger.changed')).toMatchObject({ payload: { id, deleted: true } })
    expect((await call(b, 'GET', u)).statusCode).toBe(404)
    expect(await data(b, 'GET', base)).toEqual([])
    expect((await data(b, 'GET', `${base}/trash`)).map((x: { id: string }) => x.id)).toEqual([id])
    expect((await s.req(s.admin, { method: 'GET', url: `${base}/trash` })).json().data).toHaveLength(1)
    expect(await data(d, 'GET', `${base}/trash`)).toEqual([])
    expect((await call(d, 'POST', `${u}/restore`)).statusCode).toBe(403)
    // back with its rows and its audience
    expect((await call(b, 'POST', `${u}/restore`)).statusCode).toBe(200)
    expect((await rowsOf(d, id)).map((r) => r.c.c1)).toEqual(['품목 0'])
    // removed for good; a ledger left in the trash too long goes by itself
    await call(b, 'DELETE', u)
    expect((await call(b, 'DELETE', `${u}/purge`)).statusCode).toBe(200)
    expect(await data(b, 'GET', `${base}/trash`)).toEqual([])
    expect(s.ctx.db.get('SELECT COUNT(*) AS n FROM ledger_rows WHERE ledger_id = ?', [id])).toEqual({ n: 0 })
    const old = (await data(b, 'POST', base, { doc: doc('오래된 대장'), scope: team })).id
    await call(b, 'DELETE', `${base}/${old}`)
    s.ctx.db.run('UPDATE ledgers SET deleted_at = ? WHERE id = ?', [Date.now() - (LEDGER_TRASH_DAYS + 1) * 24 * 3600_000, old])
    expect(await data(b, 'GET', `${base}/trash`)).toEqual([])
    expect(s.ctx.db.get('SELECT COUNT(*) AS n FROM ledgers WHERE id = ?', [old])).toEqual({ n: 0 })
  })

  it('keeps versions (변경 이력) and goes back to one', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const id = (await data(b, 'POST', base, { doc: doc('대장', 30), scope: team })).id
    const u = `${base}/${id}`
    const save = (who: Cred, change: object) => data(who, 'POST', `${u}/changes`, change)
    // the first edit keeps the sheet as it was
    await save(b, { since: 1, set: [{ id: 'r0', set: { c1: '고침' }, was: { c1: '품목 0' } }] })
    let vs = await data(c, 'GET', `${u}/versions`)
    expect(vs).toMatchObject([{ version: 1, rows: 30, reason: 'edit', byName: 'B' }])
    // more edits in the same round do not
    await save(b, { since: 2, set: [{ id: 'r1', set: { c1: '또 고침' }, was: { c1: '품목 1' } }] })
    expect(await data(c, 'GET', `${u}/versions`)).toHaveLength(1)
    // removing many rows at once does, whatever the time
    const mass = await save(c, { since: 3, remove: Array.from({ length: 25 }, (_, i) => `r${i + 5}`) })
    expect(mass.meta.rows).toBe(5)
    vs = await data(c, 'GET', `${u}/versions`)
    expect(vs).toMatchObject([{ version: 3, rows: 30, reason: 'bulk', byName: 'C' }, { version: 1 }])
    // and so does the next round of edits, ten minutes later
    s.ctx.db.run('UPDATE ledgers SET snap_at = ? WHERE id = ?', [Date.now() - LEDGER_SNAPSHOT_GAP_MS - 1000, id])
    await save(b, { since: mass.meta.version, set: [{ id: 'r2', set: { c2: 99 }, was: { c2: 3 } }] })
    expect((await data(c, 'GET', `${u}/versions`))[0]).toMatchObject({ rows: 5, reason: 'edit' })
    // look at a kept version, then go back to it: the 25 rows return, the sheet of now is kept too
    const kept = await data(c, 'GET', `${u}/versions/${vs[0].id}`)
    expect(kept.rows).toHaveLength(30)
    expect(kept.rows[0].c.c1).toBe('고침')
    const back = await data(c, 'POST', `${u}/versions/${vs[0].id}/restore`)
    expect(back).toMatchObject({ rows: 30, updatedByName: 'C' })
    const rows = await rowsOf(b, id)
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 30 }, (_, i) => `r${i}`))
    expect(rows[2].c.c2).toBe(3)
    expect((await data(c, 'GET', `${u}/versions`))[0]).toMatchObject({ rows: 5, reason: 'restore', byName: 'C' })
    // people who had it open get the returned rows through the feed
    const feed = await data(b, 'GET', `${u}/changes?since=${back.version - 1}`)
    expect(feed.rows.length).toBeGreaterThanOrEqual(25)
    // "지금 상태 보관"
    expect((await data(b, 'POST', `${u}/versions`))[0]).toMatchObject({ reason: 'manual', byName: 'B', rows: 30 })
    expect((await call(b, 'GET', `${u}/versions/nope`)).statusCode).toBe(400)
  })

  it('refuses broken sheets and leaves the stored one untouched', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const post = (d: unknown) => call(b, 'POST', base, { doc: d as object, scope: team })
    expect((await post({ name: '', cols: [], rows: [] })).statusCode).toBe(400)
    expect((await post({ name: 'x', cols: 'no', rows: [] })).statusCode).toBe(400)
    expect((await post({ name: 'x', cols: [], rows: [{ id: 'r', c: { a: { nested: 1 } } }] })).statusCode).toBe(400)
    expect((await post({ name: 'x', cols: [{ id: 'c1', name: '가', type: 'text' }, { id: 'c2', name: '가', type: 'text' }], rows: [] })).statusCode).toBe(400)
    expect((await call(b, 'POST', base, { doc: doc(), scope: { type: 'members', groupIds: [], memberIds: ['nobody'] } })).statusCode).toBe(400)
    expect(s.ctx.db.get('SELECT COUNT(*) AS n FROM ledgers')).toEqual({ n: 0 })

    const id = (await post(doc())).json().data.id
    const u = `${base}/${id}`
    // one row may not grow without end; a refused save changes nothing
    const long = Array.from({ length: 5 }, (_, i) => [`k${i}`, 'x'.repeat(19_000)])
    const big = await call(b, 'POST', `${u}/changes`, { since: 1, add: [{ id: 'ok', p: 5000, c: { c1: '들어가면 안 됨' } }], set: [{ id: 'r0', set: Object.fromEntries(long), was: {} }] })
    expect(JSON.stringify(Object.fromEntries(long)).length).toBeGreaterThan(LEDGER_ROW_MAX)
    expect(big.statusCode).toBe(400)
    expect(await data(b, 'GET', `${u}?limit=10`)).toMatchObject({ version: 1, rows: 1 })
    expect((await call(b, 'POST', `${u}/changes`, { since: 1, head: { rev: 1, value: { name: 'x', cols: [cols[0], { ...cols[0], id: 'c9' }] } } })).statusCode).toBe(400)
  })

  it('PCs still on v1.1.0 keep working: whole-sheet save by version, lock calls answer', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const id = (await data(b, 'POST', base, { doc: doc('대장', 3), scope: team })).id
    const u = `${base}/${id}`
    // the old screen reads every row at once and asks for the edit lock
    const old = await data(b, 'GET', u)
    expect(old.doc.rows).toHaveLength(3)
    expect(old.lock).toBeNull()
    expect((await data(b, 'POST', `${u}/lock`)).doc.rows).toHaveLength(3)
    expect((await data(b, 'POST', `${u}/lock?brief=1`)).doc).toBeUndefined()
    expect((await call(b, 'DELETE', `${u}/lock`)).statusCode).toBe(200)
    // whole sheet: row r1 changed, r2 removed, one row added
    const sheet = doc('대장 (옛 화면)', 2)
    sheet.rows[1].c.c1 = '옛 화면에서 고침'
    sheet.rows.push({ id: 'new', c: { c1: '추가', c2: 1 } })
    expect(await data(b, 'PUT', u, { doc: sheet, version: 1 })).toMatchObject({ name: '대장 (옛 화면)', rows: 3, version: 2 })
    expect((await call(c, 'PUT', u, { doc: doc('늦은 저장'), version: 1 })).statusCode).toBe(409)
    // the new screen sees only what changed
    const feed = await data(c, 'GET', `${u}/changes?since=1`)
    expect(feed.gone).toEqual(['r2'])
    expect(feed.rows.map((r: { id: string }) => r.id).sort()).toEqual(['new', 'r1'])
    expect(feed.head.name).toBe('대장 (옛 화면)')
  })

  it('migration 14 splits the sheets of v1.1.0 into rows and tells nobody about old ledgers', async () => {
    const db = new Db(':memory:')
    db.migrate(SERVER_MIGRATIONS.filter((m) => m.id <= 13))
    db.run("INSERT INTO members (id, name, role, status, created_at, updated_at) VALUES ('m1', '가', 'admin', 'active', 1, 1)")
    db.run(`INSERT INTO ledgers (id, name, doc, row_count, version, scope_type, created_by, created_at, updated_at) VALUES ('L', '옛 대장', ?, 2, 7, 'team', 'm1', 1, 1)`, [JSON.stringify({ ...doc('옛 대장', 2), note: '설명' })])
    db.migrate(SERVER_MIGRATIONS)
    const got = new LedgerStore(db).doc('L')
    expect(got).toEqual({ name: '옛 대장', template: 'asset', note: '설명', cols, rows: [0, 1].map((i) => ({ id: `r${i}`, p: (i + 1) * 1024, c: { c1: `품목 ${i}`, c2: i + 1 } })) })
    expect(db.get('SELECT doc, row_count, head_seq FROM ledgers')).toEqual({ doc: '', row_count: 2, head_seq: 7 })
    expect(db.get('SELECT version FROM ledger_seen')).toEqual({ version: 7 })
    db.close()
  })

  it('holds a large ledger: 100,000 rows in, one cell changed, read back in pages', () => {
    const db = new Db(':memory:')
    db.migrate(SERVER_MIGRATIONS)
    db.run("INSERT INTO members (id, name, role, status, created_at, updated_at) VALUES ('m1', '가', 'admin', 'active', 1, 1)")
    db.run(`INSERT INTO ledgers (id, name, doc, head, scope_type, created_by, created_at, updated_at) VALUES ('L', '큰 대장', '', ?, 'team', 'm1', 1, 1)`, [JSON.stringify(head('큰 대장'))])
    const store = new LedgerStore(db)
    const who = { id: 'm1', name: '가' }
    const t0 = Date.now()
    for (let at = 0; at < LEDGER_MAX_ROWS; at += 2000)
      store.apply('L', { since: 0, set: [], move: [], remove: [], add: Array.from({ length: 2000 }, (_, i) => ({ id: `r${at + i}`, p: (at + i + 1) * 1024, c: { c1: `품목 ${at + i}`, c2: at + i } })) }, who)
    const filled = Date.now() - t0
    expect(db.get('SELECT row_count FROM ledgers')).toEqual({ row_count: LEDGER_MAX_ROWS })
    // full: one more row is refused
    expect(() => store.apply('L', { since: 0, set: [], move: [], remove: [], add: [{ id: 'over', p: 1, c: {} }] }, who)).toThrow(/행이 너무 많습니다/)
    const v = db.get<{ version: number }>('SELECT version FROM ledgers')!.version
    const t1 = Date.now()
    const res = store.apply('L', { since: v, add: [], move: [], remove: [], set: [{ id: 'r77777', set: { c1: '고침' }, was: { c1: '품목 77777' } }] }, who)
    const edited = Date.now() - t1
    expect(res).toMatchObject({ saved: true, version: v + 1, changes: { rows: [], gone: [] } })
    let n = 0
    let after: { p: number; id: string } | null = null
    for (;;) {
      const pg = store.page('L', after, 10_000)
      n += pg.rows.length
      if (!pg.more) break
      const last = pg.rows[pg.rows.length - 1]
      after = { p: last.p, id: last.id }
    }
    expect(n).toBe(LEDGER_MAX_ROWS)
    // a version of the whole sheet can be kept and read back
    const vid = store.snapshot('L', 'manual', who)
    expect(store.versionDoc('L', vid).rows).toHaveLength(LEDGER_MAX_ROWS)
    // not a benchmark, only a guard against something quadratic
    expect(filled).toBeLessThan(30_000)
    expect(edited).toBeLessThan(2_000)
    db.close()
  }, 120_000)
})
