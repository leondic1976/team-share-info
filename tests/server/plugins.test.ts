import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type TestServer } from './helpers'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'
const base = '/api/plugins/ladder/rooms'

describe('plugin rooms (확장 기능 함께하기)', () => {
  it('scope, creator-only shared data, own entries only, invites, versions', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const sent: { to: string[]; name: string; payload: unknown }[] = []
    s.ctx.hub.sendTo = (ids, name, payload) => void sent.push({ to: [...ids], name, payload })
    const room = (await s.req(b, { method: 'POST', url: base, ip: IP, payload: { title: '커피 내기', scope: { type: 'members', groupIds: [], memberIds: [s.admin.memberId] }, shared: { lines: 2 } } })).json().data
    expect(room).toMatchObject({ pluginId: 'ladder', title: '커피 내기', createdByName: 'B', shared: { lines: 2 }, version: 1 })
    expect(sent.find((m) => m.name === 'plugin.invite')).toMatchObject({ to: [s.admin.memberId], payload: { pluginId: 'ladder', roomId: room.id, fromName: 'B' } })
    // C is outside the scope; other plugins do not see it either
    expect((await s.req(c, { method: 'GET', url: `${base}/${room.id}`, ip: IP })).statusCode).toBe(404)
    expect((await s.req(s.admin, { method: 'GET', url: `/api/plugins/other/rooms/${room.id}` })).statusCode).toBe(404)
    expect((await s.req(s.admin, { method: 'GET', url: base })).json().data).toHaveLength(1)
    // only the creator writes shared data
    expect((await s.req(s.admin, { method: 'PUT', url: `${base}/${room.id}/shared`, payload: { shared: { x: 1 } } })).statusCode).toBe(403)
    expect((await s.req(b, { method: 'PUT', url: `${base}/${room.id}/shared`, ip: IP, payload: { shared: { x: 1 }, version: 99 } })).statusCode).toBe(409)
    // each member writes their own entry
    await s.req(s.admin, { method: 'PUT', url: `${base}/${room.id}/entry`, payload: { value: { line: 1 } } })
    const after = (await s.req(b, { method: 'PUT', url: `${base}/${room.id}/entry`, ip: IP, payload: { value: { line: 0 } } })).json().data
    expect(Object.values(after.entries).map((e) => (e as { name: string }).name).sort()).toEqual(['B', '관리자'])
    expect(after.version).toBe(3)
    const closed = (await s.req(b, { method: 'PUT', url: `${base}/${room.id}/shared`, ip: IP, payload: { shared: { result: [1, 0] }, version: 3, close: true } })).json().data
    expect(closed).toMatchObject({ closed: true, shared: { result: [1, 0] } })
    expect((await s.req(s.admin, { method: 'PUT', url: `${base}/${room.id}/entry`, payload: { value: { line: 0 } } })).statusCode).toBe(400)
    // size limit
    expect((await s.req(b, { method: 'POST', url: base, ip: IP, payload: { title: 'x', scope: { type: 'team', groupIds: [], memberIds: [] }, shared: { big: 'x'.repeat(70000) } } })).statusCode).toBe(400)
    expect((await s.req(s.admin, { method: 'DELETE', url: `${base}/${room.id}` })).statusCode).toBe(200)
  })

  it('식사 신청: the server refuses a request changed after its deadline, by its own clock (1.7.0)', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const meal = '/api/plugins/meal/rooms'
    const pad = (n: number) => String(n).padStart(2, '0')
    const d = new Date()
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const settings = (lunch: string) => ({ kind: 'meal', v: 1, meals: { lunch: { on: true, cutoff: lunch }, dinner: { on: true, cutoff: '23:59' } }, weekend: true, holidays: true, stewards: [], clerks: [], ahead: 7, notice: '' })
    // lunch still open today (23:59)
    const room = (await s.req(s.admin, { method: 'POST', url: meal, payload: { title: '식사 신청', scope: { type: 'team', groupIds: [], memberIds: [] }, shared: settings('23:59') } })).json().data
    const put = (who: typeof b, value: unknown) => s!.req(who, { method: 'PUT', url: `${meal}/${room.id}/entry`, ip: who === b ? IP : undefined, payload: { value } })
    const lunch = { v: 1, days: { [today]: { lunch: { on: true, at: Date.now() } } } }
    expect((await put(b, lunch)).statusCode).toBe(200)
    // the admin closes today's lunch (deadline 00:00, passed)
    expect((await s.req(s.admin, { method: 'PUT', url: `${meal}/${room.id}/shared`, payload: { shared: settings('00:00') } })).statusCode).toBe(200)
    // an old or changed client cancels it anyway: refused, with the reason
    const cancel = await put(b, { v: 1, days: { [today]: { lunch: { on: false, at: Date.now() } } } })
    expect(cancel.statusCode).toBe(409)
    const [, m, day] = today.split('-').map(Number)
    expect(cancel.json().error.message).toMatch(new RegExp(`^${m}/${day}\\(.\\) 점심은 마감 시각\\(00:00\\)이 지나 바꿀 수 없습니다\\.$`))
    // taking the record out, or the whole entry, neither
    expect((await put(b, { v: 1, days: {} })).statusCode).toBe(409)
    expect((await put(b, null)).statusCode).toBe(409)
    // the same entry written again (every save writes all of it) and today's dinner (open) are fine
    expect((await put(b, lunch)).statusCode).toBe(200)
    expect((await put(b, { v: 1, days: { [today]: { ...lunch.days[today], dinner: { on: true, at: Date.now() } } } })).statusCode).toBe(200)
    // somebody else's request for B after the deadline (대신 신청) is refused too, with the name
    const proxy = await put(s.admin, { v: 1, days: {}, for: { [b.memberId]: { name: 'B', days: { [today]: { lunch: { on: true, at: Date.now() } } } } } })
    expect(proxy.statusCode).toBe(409)
    expect(proxy.json().error.message).toContain('B 님의')
    // what those in charge keep in their entry (settings, menus) stays free after a deadline
    expect((await put(s.admin, { v: 1, days: {}, menus: { [today]: { note: { t: '외식', at: Date.now() } } } })).statusCode).toBe(200)
    // B's lunch still stands
    const after = (await s.req(s.admin, { method: 'GET', url: `${meal}/${room.id}` })).json().data
    expect(after.entries[b.memberId].value.days[today].lunch.on).toBe(true)
  })
})
