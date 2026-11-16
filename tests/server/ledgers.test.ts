import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type Cred, type TestServer } from './helpers'
import { LEDGER_DOC_MAX, LEDGER_LOCK_MS } from '../../src/shared/schemas/ledger'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'
const base = '/api/ledgers'
const team = { type: 'team', groupIds: [], memberIds: [] }
const doc = (name = '비품 대장', rows = 1) => ({
  id: 'b-local',
  name,
  template: 'asset',
  cols: [
    { id: 'c1', name: '품명', type: 'text', width: 160 },
    { id: 'c2', name: '수량', type: 'number', total: 'sum' },
    { id: 'c3', name: '금액', type: 'calc', calc: '=[수량]*1000' }
  ],
  rows: Array.from({ length: rows }, (_, i) => ({ id: `r${i}`, c: { c1: `품목 ${i}`, c2: i + 1 } }))
})

describe('team ledgers (관리대장 · 팀 대장)', () => {
  const call = (who: Cred, method: string, url: string, payload?: object) => s!.req(who, { method: method as 'GET', url, ip: IP, ...(payload ? { payload } : {}) })

  it('keeps the sheet whole, lists it by scope and hides it outside the scope', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const d = await s.join('D')
    const made = (await call(b, 'POST', base, { doc: doc(), scope: { type: 'members', groupIds: [], memberIds: [c.memberId] }, icon: '📦' })).json().data
    expect(made).toMatchObject({ name: '비품 대장', icon: '📦', rows: 1, version: 1, editMode: 'all', ownerName: 'B', canEdit: true, canManage: true, lock: null })
    // formulas, column settings and unknown fields come back exactly as stored
    expect(made.doc).toEqual(doc())
    expect((await call(c, 'GET', base)).json().data.map((x: { name: string }) => x.name)).toEqual(['비품 대장'])
    expect((await call(c, 'GET', `${base}/${made.id}`)).json().data).toMatchObject({ canEdit: true, canManage: false })
    expect((await call(d, 'GET', base)).json().data).toEqual([])
    expect((await call(d, 'GET', `${base}/${made.id}`)).statusCode).toBe(404)
    expect((await call(d, 'PUT', `${base}/${made.id}`, { doc: doc(), version: 1 })).statusCode).toBe(404)
    expect((await call(d, 'POST', `${base}/${made.id}/lock`)).statusCode).toBe(404)
    // the list carries no sheet
    expect((await call(c, 'GET', base)).json().data[0].doc).toBeUndefined()
  })

  it('one editor at a time: lock, save by version, release, expiry', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const sent: { to: string[]; name: string; payload: unknown }[] = []
    s.ctx.hub.sendTo = (ids, name, payload) => void sent.push({ to: [...ids], name, payload })
    const id = (await call(b, 'POST', base, { doc: doc(), scope: team })).json().data.id
    const u = `${base}/${id}`

    // B starts editing; C is told who edits and cannot save or lock
    expect((await call(b, 'POST', `${u}/lock`)).json().data).toMatchObject({ version: 1, lock: { name: 'B', mine: true }, doc: { name: '비품 대장' } })
    expect((await call(c, 'GET', u)).json().data.lock).toMatchObject({ name: 'B', mine: false })
    const busy = await call(c, 'POST', `${u}/lock`)
    expect(busy.statusCode).toBe(409)
    expect(busy.json().error.message).toContain('B님이 편집 중')
    expect((await call(c, 'PUT', u, { doc: doc('C가 덮어씀'), version: 1 })).statusCode).toBe(409)
    // keeping the lock alive answers without the sheet
    expect((await call(b, 'POST', `${u}/lock?brief=1`)).json().data.doc).toBeUndefined()

    // B saves: version goes up, name and row count follow the sheet, everyone is told
    sent.length = 0
    const saved = (await call(b, 'PUT', u, { doc: doc('비품 대장 2026', 3), version: 1 })).json().data
    expect(saved).toMatchObject({ name: '비품 대장 2026', rows: 3, version: 2, updatedByName: 'B' })
    expect(sent.find((m) => m.name === 'ledger.changed')).toMatchObject({ payload: { id, version: 2 } })
    expect(sent.find((m) => m.name === 'ledger.changed')!.to).toContain(c.memberId)
    // a save made on an old version is refused (B's own second window, a late retry…)
    expect((await call(b, 'PUT', u, { doc: doc('옛 내용'), version: 1 })).statusCode).toBe(409)
    expect((await call(c, 'GET', u)).json().data.doc.name).toBe('비품 대장 2026')

    // only the holder releases; then C edits
    await call(c, 'DELETE', `${u}/lock`)
    expect((await call(c, 'GET', u)).json().data.lock).toMatchObject({ name: 'B' })
    await call(b, 'DELETE', `${u}/lock`)
    expect((await call(c, 'GET', u)).json().data.lock).toBeNull()
    expect((await call(c, 'PUT', u, { doc: doc('C가 고침', 3), version: 2 })).json().data).toMatchObject({ version: 3, lock: { name: 'C', mine: true } })
    expect((await call(b, 'PUT', u, { doc: doc('B가 덮어씀', 3), version: 3 })).statusCode).toBe(409)

    // a lock nobody refreshed (app closed, network lost) frees itself
    s.ctx.db.run('UPDATE ledgers SET lock_at = ? WHERE id = ?', [Date.now() - LEDGER_LOCK_MS - 1000, id])
    expect((await call(b, 'GET', u)).json().data.lock).toBeNull()
    expect((await call(b, 'POST', `${u}/lock`)).json().data.lock).toMatchObject({ name: 'B', mine: true })
  })

  it('edit mode "owner": others only read; the creator and admins edit and manage', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const id = (await call(b, 'POST', base, { doc: doc(), scope: team, editMode: 'owner' })).json().data.id
    const u = `${base}/${id}`
    expect((await call(c, 'GET', u)).json().data).toMatchObject({ canEdit: false, canManage: false, doc: { name: '비품 대장' } })
    expect((await call(c, 'POST', `${u}/lock`)).statusCode).toBe(403)
    expect((await call(c, 'PUT', u, { doc: doc('x'), version: 1 })).statusCode).toBe(403)
    expect((await call(c, 'PATCH', u, { editMode: 'all' })).statusCode).toBe(403)
    expect((await call(c, 'DELETE', u)).statusCode).toBe(403)
    expect((await s.req(s.admin, { method: 'PUT', url: u, payload: { doc: doc('관리자가 고침'), version: 1 } })).json().data.version).toBe(2)
    await s.req(s.admin, { method: 'DELETE', url: `${u}/lock` })
    // the creator opens it up
    expect((await call(b, 'PATCH', u, { editMode: 'all' })).json().data.editMode).toBe('all')
    expect((await call(c, 'PUT', u, { doc: doc('C가 고침'), version: 2 })).statusCode).toBe(200)
  })

  it('changing the audience tells those who lose it; groups; delete', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const d = await s.join('D')
    const g = (await call(b, 'POST', '/api/groups', { name: '물품팀', visibility: 'private', memberIds: [c.memberId] })).json().data
    for (const i of (await call(c, 'GET', '/api/group-invites')).json().data as { id: string; groupId: string }[]) await call(c, 'PATCH', `/api/groups/${i.groupId}/invites/${i.id}`, { action: 'accept' })
    const id = (await call(b, 'POST', base, { doc: doc(), scope: { type: 'group', groupIds: [g.id], memberIds: [] } })).json().data.id
    const u = `${base}/${id}`
    expect((await call(c, 'GET', u)).json().data.scope.groups[0].name).toBe('물품팀')
    expect((await call(d, 'GET', u)).statusCode).toBe(404)
    // D cannot put a ledger into a group D is not in
    expect((await call(d, 'POST', base, { doc: doc(), scope: { type: 'group', groupIds: [g.id], memberIds: [] } })).statusCode).toBe(400)

    const sent: { to: string[]; name: string; payload: unknown }[] = []
    s.ctx.hub.sendTo = (ids, name, payload) => void sent.push({ to: [...ids], name, payload })
    await call(b, 'PATCH', u, { scope: { type: 'members', groupIds: [], memberIds: [d.memberId] } })
    expect((await call(d, 'GET', u)).statusCode).toBe(200)
    expect((await call(c, 'GET', u)).statusCode).toBe(404)
    expect(sent.find((m) => m.name === 'ledger.changed')!.to).toEqual(expect.arrayContaining([c.memberId, d.memberId]))

    // someone is editing: it cannot be deleted under them
    await call(d, 'POST', `${u}/lock`)
    expect((await call(b, 'DELETE', u)).statusCode).toBe(409)
    await call(d, 'DELETE', `${u}/lock`)
    sent.length = 0
    expect((await call(b, 'DELETE', u)).statusCode).toBe(200)
    expect(sent.find((m) => m.name === 'ledger.changed')).toMatchObject({ payload: { id, deleted: true } })
    expect((await call(b, 'GET', u)).statusCode).toBe(404)
    expect((await call(b, 'GET', base)).json().data).toEqual([])
  })

  it('refuses broken or oversized sheets and leaves the stored one untouched', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const post = (d: unknown) => call(b, 'POST', base, { doc: d as object, scope: team })
    expect((await post({ name: '', cols: [], rows: [] })).statusCode).toBe(400)
    expect((await post({ name: 'x', cols: 'no', rows: [] })).statusCode).toBe(400)
    expect((await post({ name: 'x', cols: [], rows: [{ id: 'r', c: { a: { nested: 1 } } }] })).statusCode).toBe(400)
    expect((await post({ name: 'x', cols: [{ id: 'c1', name: '가', type: 'text' }, { id: 'c2', name: '가', type: 'text' }], rows: [] })).statusCode).toBe(400)
    expect((await post({ name: 'x', cols: [{ id: 'c1', name: '가', type: 'text' }], rows: [{ id: 'r', c: { c1: 'x'.repeat(LEDGER_DOC_MAX) } }] })).statusCode).toBe(400)
    expect((await call(b, 'POST', base, { doc: doc(), scope: { type: 'members', groupIds: [], memberIds: ['nobody'] } })).statusCode).toBe(400)

    const id = (await post(doc())).json().data.id
    const big = doc('큰 대장')
    big.rows = Array.from({ length: 2000 }, (_, i) => ({ id: `r${i}`, c: { c1: '가'.repeat(300), c2: i } }))
    expect(JSON.stringify(big).length).toBeGreaterThan(LEDGER_DOC_MAX)
    expect((await call(b, 'PUT', `${base}/${id}`, { doc: big, version: 1 })).statusCode).toBe(400)
    expect((await call(b, 'GET', `${base}/${id}`)).json().data).toMatchObject({ name: '비품 대장', version: 1, rows: 1 })
    // a sheet close to the limit is accepted
    const ok = doc('가득 찬 대장')
    ok.rows = Array.from({ length: 4000 }, (_, i) => ({ id: `r${i}`, c: { c1: `품목 ${i} 설명 `.repeat(6), c2: i } }))
    expect(JSON.stringify(ok).length).toBeLessThan(LEDGER_DOC_MAX)
    expect((await call(b, 'PUT', `${base}/${id}`, { doc: ok, version: 1 })).json().data).toMatchObject({ rows: 4000, version: 2 })
  })
})
