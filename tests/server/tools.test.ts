import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type TestServer } from './helpers'
import { runAlarmJobs } from '../../src/server/routes/tools'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'

describe('shared memos and team alarms (M6-8)', () => {
  it('shared memo follows scope and records who checked it', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const r = await s.req(s.admin, { method: 'POST', url: '/api/shared-memos', payload: { body: '○○과에서 전화 왔음', scope: { type: 'members', groupIds: [], memberIds: [b.memberId] } } })
    expect(r.statusCode).toBe(200)
    const id = r.json().data.id
    expect((await s.req(b, { method: 'GET', url: '/api/shared-memos', ip: IP })).json().data).toHaveLength(1)
    expect((await s.req(c, { method: 'GET', url: '/api/shared-memos', ip: IP })).json().data).toHaveLength(0)
    expect((await s.req(c, { method: 'POST', url: `/api/shared-memos/${id}/check`, ip: IP, payload: { checked: true } })).statusCode).toBe(404)
    const checked = (await s.req(b, { method: 'POST', url: `/api/shared-memos/${id}/check`, ip: IP, payload: { checked: true } })).json().data
    expect(checked.checkedByName).toBe('B')
    expect((await s.req(b, { method: 'DELETE', url: `/api/shared-memos/${id}`, ip: IP })).statusCode).toBe(403)
    expect((await s.req(s.admin, { method: 'DELETE', url: `/api/shared-memos/${id}` })).statusCode).toBe(200)
    expect((await s.req(b, { method: 'GET', url: '/api/shared-memos', ip: IP })).json().data).toHaveLength(0)
  })

  it('alarm is pushed when due to online recipients, pending until dismissed', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const sent: { to: string[]; name: string; payload: unknown }[] = []
    let online = new Set<string>()
    s.ctx.hub.onlineMemberIds = () => online
    s.ctx.hub.sendTo = (ids, name, payload) => void sent.push({ to: [...ids], name, payload })

    const now = Date.now()
    const fireAt = now + 60_000
    expect((await s.req(s.admin, { method: 'POST', url: '/api/alarms', payload: { toIds: [b.memberId], fireAt: now - 3_600_000, title: 'x' } })).statusCode).toBe(400)
    const { ids } = (await s.req(s.admin, { method: 'POST', url: '/api/alarms', payload: { toIds: [b.memberId], fireAt, title: '14시 회의 자료 지참' } })).json().data
    expect(runAlarmJobs(s.ctx, now)).toBe(0) // not due yet
    expect(runAlarmJobs(s.ctx, fireAt + 1000)).toBe(0) // due, but recipient offline
    online = new Set([b.memberId])
    expect(runAlarmJobs(s.ctx, fireAt + 2000)).toBe(1)
    expect(sent.find((m) => m.name === 'alarm.fire')).toMatchObject({ to: [b.memberId], payload: { id: ids[0], fromName: '관리자', title: '14시 회의 자료 지참' } })
    expect(runAlarmJobs(s.ctx, fireAt + 3000)).toBe(0) // delivered once

    // delivered alarms cannot be cancelled; recipient dismisses
    expect((await s.req(s.admin, { method: 'DELETE', url: `/api/alarms/${ids[0]}` })).statusCode).toBe(400)
    expect((await s.req(s.admin, { method: 'POST', url: `/api/alarms/${ids[0]}/dismiss` })).statusCode).toBe(404)
    expect((await s.req(b, { method: 'POST', url: `/api/alarms/${ids[0]}/dismiss`, ip: IP })).statusCode).toBe(200)
    const sentList = (await s.req(s.admin, { method: 'GET', url: '/api/alarms/sent' })).json().data
    expect(sentList[0]).toMatchObject({ toName: 'B', toId: b.memberId, fromId: s.admin.memberId })
    expect(sentList[0].dismissedAt).not.toBeNull()
  })

  it('offline recipients get due alarms on reconnect; senders may cancel undelivered ones', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    s.ctx.hub.onlineMemberIds = () => new Set()
    const now = Date.now()
    const { ids } = (await s.req(s.admin, { method: 'POST', url: '/api/alarms', payload: { toIds: [b.memberId], fireAt: now, title: '보고서 제출' } })).json().data
    const later = (await s.req(s.admin, { method: 'POST', url: '/api/alarms', payload: { toIds: [b.memberId], fireAt: now + 3_600_000, title: '나중' } })).json().data.ids[0]
    const pending = (await s.req(b, { method: 'GET', url: '/api/alarms/pending', ip: IP })).json().data
    expect(pending.map((p: { id: string }) => p.id)).toEqual(ids)
    // still pending until dismissed (popup may have been missed)
    expect((await s.req(b, { method: 'GET', url: '/api/alarms/pending', ip: IP })).json().data).toHaveLength(1)
    await s.req(b, { method: 'POST', url: `/api/alarms/${ids[0]}/dismiss`, ip: IP })
    expect((await s.req(b, { method: 'GET', url: '/api/alarms/pending', ip: IP })).json().data).toHaveLength(0)
    expect((await s.req(s.admin, { method: 'DELETE', url: `/api/alarms/${later}` })).statusCode).toBe(200)
    expect((await s.req(b, { method: 'GET', url: '/api/alarms/received', ip: IP })).json().data).toHaveLength(1)
  })

  it('immediate alarm uses the server clock, whatever time the sender PC gave', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    s.ctx.hub.onlineMemberIds = () => new Set()
    const before = Date.now()
    // a sender PC whose clock is an hour slow would be refused without "immediate"
    const res = await s.req(s.admin, { method: 'POST', url: '/api/alarms', payload: { toIds: [b.memberId], fireAt: before - 3_600_000, immediate: true, title: '즉시' } })
    expect(res.statusCode).toBe(200)
    const pending = (await s.req(b, { method: 'GET', url: '/api/alarms/pending', ip: IP })).json().data
    expect(pending).toHaveLength(1)
    expect(pending[0].fireAt).toBeGreaterThanOrEqual(before)
  })
})
