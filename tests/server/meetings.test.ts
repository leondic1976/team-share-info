import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type TestServer } from './helpers'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'

describe('meetings and rtc.signal relay (M7-6, 13.7)', () => {
  it('scope hides meetings; join/leave; last one out ends it', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const sent: { to: string[]; name: string; payload: unknown }[] = []
    s.ctx.hub.sendTo = (ids, name, payload) => void sent.push({ to: [...ids], name, payload })
    const r = await s.req(s.admin, { method: 'POST', url: '/api/meetings', payload: { title: '1:1 통화', scope: { type: 'members', groupIds: [], memberIds: [b.memberId] } } })
    expect(r.statusCode).toBe(200)
    const id = r.json().data.id
    expect(sent.find((m) => m.name === 'meeting.invite')).toMatchObject({ to: [b.memberId], payload: { id, title: '1:1 통화', hostName: '관리자' } })
    expect((await s.req(b, { method: 'GET', url: '/api/meetings', ip: IP })).json().data).toHaveLength(1)
    expect((await s.req(c, { method: 'GET', url: '/api/meetings', ip: IP })).json().data).toHaveLength(0)
    expect((await s.req(c, { method: 'POST', url: `/api/meetings/${id}/join`, ip: IP })).statusCode).toBe(404)
    const joined = (await s.req(b, { method: 'POST', url: `/api/meetings/${id}/join`, ip: IP })).json().data
    expect(joined.participants.map((p: { name: string }) => p.name)).toEqual(['관리자', 'B'])
    expect((await s.req(b, { method: 'POST', url: `/api/meetings/${id}/end`, ip: IP })).statusCode).toBe(403)
    await s.req(s.admin, { method: 'POST', url: `/api/meetings/${id}/leave` })
    expect((await s.req(b, { method: 'GET', url: `/api/meetings/${id}`, ip: IP })).json().data.state).toBe('live')
    await s.req(b, { method: 'POST', url: `/api/meetings/${id}/leave`, ip: IP })
    expect((await s.req(b, { method: 'GET', url: `/api/meetings/${id}`, ip: IP })).json().data.state).toBe('ended')
    expect((await s.req(b, { method: 'POST', url: `/api/meetings/${id}/join`, ip: IP })).statusCode).toBe(400)
  })

  it('signals pass only between active participants of a live meeting', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const sent: { to: string[]; name: string; payload: unknown }[] = []
    s.ctx.hub.sendTo = (ids, name, payload) => void sent.push({ to: [...ids], name, payload })
    const id = (await s.req(s.admin, { method: 'POST', url: '/api/meetings', payload: { title: '팀 회의', scope: { type: 'team', groupIds: [], memberIds: [] } } })).json().data.id
    await s.req(b, { method: 'POST', url: `/api/meetings/${id}/join`, ip: IP })
    const relay = s.ctx.hub.rtcRelay!
    const signals = (): { to: string[]; payload: unknown }[] => sent.filter((m) => m.name === 'rtc.signal')
    relay(s.admin.memberId, { type: 'rtc', meetingId: id, to: b.memberId, data: { kind: 'offer', sdp: 'x' } })
    expect(signals()).toEqual([{ name: 'rtc.signal', to: [b.memberId], payload: { meetingId: id, from: s.admin.memberId, data: { kind: 'offer', sdp: 'x' } } }])
    // C can see the team meeting but has not joined: cannot send or receive
    relay(c.memberId, { type: 'rtc', meetingId: id, to: b.memberId, data: {} })
    relay(s.admin.memberId, { type: 'rtc', meetingId: id, to: c.memberId, data: {} })
    relay(s.admin.memberId, { type: 'rtc', meetingId: 'nope', to: b.memberId, data: {} })
    expect(signals()).toHaveLength(1)
    // a member who disconnects leaves; then signals to them stop
    s.ctx.hub.onMemberOffline!(b.memberId)
    relay(s.admin.memberId, { type: 'rtc', meetingId: id, to: b.memberId, data: {} })
    expect(signals()).toHaveLength(1)
    expect((await s.req(s.admin, { method: 'GET', url: `/api/meetings/${id}` })).json().data.participants.find((p: { name: string }) => p.name === 'B').leftAt).not.toBeNull()
  })
})
