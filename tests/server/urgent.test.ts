import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestServer, type Cred, type TestServer } from './helpers'

const IP = '192.168.10.20'

describe('urgent notices: which ones still wait for a member (their windows close when it is over)', () => {
  let s: TestServer
  let b: Cred
  let c: Cred
  beforeEach(async () => {
    s = await createTestServer()
    b = await s.join('B')
    c = await s.join('C')
  })
  afterEach(async () => {
    await s.close()
  })

  const send = async (over: Record<string, unknown> = {}): Promise<string> => {
    const r = await s.req(s.admin, {
      method: 'POST',
      url: '/api/notices',
      payload: { level: 'urgent', title: '대피', bodyHtml: '<p>동쪽 계단</p>', scope: { type: 'team', groupIds: [], memberIds: [] }, requireAck: true, replyOptions: [], pinned: false, publishAt: null, expiresAt: null, renotifyMinutes: 5, attachmentIds: [], ...over }
    })
    expect(r.statusCode, r.body).toBe(200)
    return (r.json() as { data: { id: string } }).data.id
  }
  const waiting = async (who: Cred): Promise<string[]> => {
    const r = await s.req(who, { method: 'GET', url: '/api/notices/attention', ip: IP })
    expect(r.statusCode, r.body).toBe(200)
    return (r.json() as { data: { ids: string[] } }).data.ids
  }

  it('waits for every recipient until they confirm; the sender is not asked', async () => {
    const id = await send()
    expect(await waiting(b)).toEqual([id])
    expect(await waiting(c)).toEqual([id])
    expect(await waiting(s.admin)).toEqual([])
    expect((await s.req(b, { method: 'POST', url: `/api/notices/${id}/ack`, payload: {}, ip: IP })).statusCode).toBe(200)
    expect(await waiting(b)).toEqual([])
    expect(await waiting(c)).toEqual([id])
  })

  it('is over for everyone when the sender ends it (expiry) or deletes it', async () => {
    const ended = await send()
    const deleted = await send({ title: '훈련' })
    expect((await waiting(b)).sort()).toEqual([ended, deleted].sort())
    expect((await s.req(s.admin, { method: 'PATCH', url: `/api/notices/${ended}`, payload: { expiresAt: Date.now() - 1 } })).statusCode).toBe(200)
    expect(await waiting(b)).toEqual([deleted])
    expect((await s.req(s.admin, { method: 'DELETE', url: `/api/notices/${deleted}` })).statusCode).toBe(200)
    expect(await waiting(b)).toEqual([])
    expect(await waiting(c)).toEqual([])
    // a member cannot end somebody else's notice
    const mine = await send()
    expect((await s.req(b, { method: 'PATCH', url: `/api/notices/${mine}`, payload: { expiresAt: Date.now() - 1 }, ip: IP })).statusCode).toBeGreaterThanOrEqual(400)
    expect(await waiting(b)).toEqual([mine])
  })

  it('without confirmation asked, reading it is enough; ordinary notices never wait', async () => {
    const id = await send({ requireAck: false, renotifyMinutes: null })
    await send({ level: 'important', title: '일반 공지', requireAck: true, renotifyMinutes: null })
    expect(await waiting(b)).toEqual([id])
    expect((await s.req(b, { method: 'POST', url: `/api/notices/${id}/read`, payload: {}, ip: IP })).statusCode).toBe(200)
    expect(await waiting(b)).toEqual([])
  })
})
