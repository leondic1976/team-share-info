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
})
