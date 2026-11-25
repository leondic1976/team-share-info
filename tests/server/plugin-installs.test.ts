import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type TestServer } from './helpers'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'

describe('확장 기능: who has which extension, kept on the server PC (지시 92)', () => {
  it('each PC reports its list; counts of PCs installed and used lately, with the people', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const put = (who: typeof a, plugins: unknown[]) => s!.req(who, { method: 'PUT', url: '/api/plugins/installed', ip: IP, payload: { plugins } })
    expect((await put(a, [{ id: 'meal', version: '1.5.0', enabled: true }, { id: 'ladder', version: '1.1.1', enabled: false }])).statusCode).toBe(200)
    expect((await put(b, [{ id: 'meal', version: '1.5.0', enabled: true }])).statusCode).toBe(200)
    // B opens 식사 신청
    expect((await s.req(b, { method: 'POST', url: '/api/plugins/meal/used', ip: IP })).statusCode).toBe(200)
    let r = (await s.req(a, { method: 'GET', url: '/api/plugins/installs', ip: IP })).json().data
    expect(r.plugins.meal).toMatchObject({ installed: 2, used: 1 })
    expect(r.plugins.meal.people.map((p: { name: string; using: boolean; me: boolean }) => [p.name, p.using, p.me])).toEqual([
      ['A', false, true],
      ['B', true, false]
    ])
    expect(r.plugins.ladder).toMatchObject({ installed: 1, used: 0 })
    expect(r.plugins.ladder.people[0]).toMatchObject({ name: 'A', enabled: false })
    expect(r.totals.installed).toBe(2)
    expect(r.totals.used).toBe(1)
    expect(r.totals.pcs).toBeGreaterThanOrEqual(2)
    // A removes 사다리타기: the new list replaces the old one; the time of last use stays
    await put(a, [{ id: 'meal', version: '1.5.1', enabled: true }])
    await put(b, [{ id: 'meal', version: '1.5.1', enabled: true }])
    r = (await s.req(b, { method: 'GET', url: '/api/plugins/installs', ip: IP })).json().data
    expect(r.plugins.ladder).toBeUndefined()
    expect(r.plugins.meal).toMatchObject({ installed: 2, used: 1 })
    // old use (more than 30 days ago) does not count as using
    s.ctx.db.run("UPDATE plugin_installs SET last_used_at = ? WHERE plugin_id = 'meal'", [Date.now() - 31 * 86400000])
    r = (await s.req(b, { method: 'GET', url: '/api/plugins/installs', ip: IP })).json().data
    expect(r.plugins.meal.used).toBe(0)
    // bad input is refused
    expect((await put(a, [{ id: 'Bad Id!' }])).statusCode).toBe(400)
  })
})
