import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type TestServer } from './helpers'
import { runChatJobs } from '../../src/server/routes/chat'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'

describe('messenger (M5)', () => {
  it('1:1 chat is reused, messages flow, read state counts down', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const c1 = (await s.req(a, { method: 'POST', url: '/api/conversations', ip: IP, payload: { memberIds: [b.memberId] } })).json().data
    const c2 = (await s.req(b, { method: 'POST', url: '/api/conversations', ip: IP, payload: { memberIds: [a.memberId] } })).json().data
    expect(c2.id).toBe(c1.id)
    expect(c1.title).toBe('B')
    await s.req(a, { method: 'POST', url: `/api/conversations/${c1.id}/messages`, ip: IP, payload: { body: '안녕하세요' } })
    await s.req(a, { method: 'POST', url: `/api/conversations/${c1.id}/messages`, ip: IP, payload: { body: '회의 자료 확인 부탁' } })
    let list = (await s.req(b, { method: 'GET', url: '/api/conversations', ip: IP })).json().data
    expect(list[0]).toMatchObject({ id: c1.id, unread: 2, lastPreview: '회의 자료 확인 부탁', title: 'A' })
    expect((await s.req(b, { method: 'GET', url: '/api/chat/unread', ip: IP })).json().data.messages).toBe(2)
    let msgs = (await s.req(a, { method: 'GET', url: `/api/conversations/${c1.id}/messages`, ip: IP })).json().data
    expect(msgs.map((m: { body: string; unreadBy: number }) => [m.body, m.unreadBy])).toEqual([
      ['안녕하세요', 1],
      ['회의 자료 확인 부탁', 1]
    ])
    await s.req(b, { method: 'POST', url: `/api/conversations/${c1.id}/read`, ip: IP, payload: { seq: 2 } })
    msgs = (await s.req(a, { method: 'GET', url: `/api/conversations/${c1.id}/messages`, ip: IP })).json().data
    expect(msgs.every((m: { unreadBy: number }) => m.unreadBy === 0)).toBe(true)
    list = (await s.req(b, { method: 'GET', url: '/api/conversations', ip: IP })).json().data
    expect(list[0].unread).toBe(0)
  })

  it('outsiders cannot read a conversation or its attachments', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const c = await s.join('C')
    const conv = (await s.req(a, { method: 'POST', url: '/api/conversations', ip: IP, payload: { memberIds: [b.memberId] } })).json().data
    const att = (await s.req(a, { method: 'POST', url: '/api/attachments?name=pic.png', ip: IP, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('png') })).json().data
    await s.req(a, { method: 'POST', url: `/api/conversations/${conv.id}/messages`, ip: IP, payload: { body: '사진', attachmentIds: [att.id] } })
    const msgs = (await s.req(b, { method: 'GET', url: `/api/conversations/${conv.id}/messages`, ip: IP })).json().data
    expect(msgs.map((m: { kind: string }) => m.kind)).toEqual(['image', 'text'])
    expect((await s.req(b, { method: 'GET', url: `/api/attachments/${att.id}`, ip: IP })).statusCode).toBe(200)
    expect((await s.req(c, { method: 'GET', url: `/api/attachments/${att.id}`, ip: IP })).statusCode).toBe(404)
    expect((await s.req(c, { method: 'GET', url: `/api/conversations/${conv.id}/messages`, ip: IP })).statusCode).toBe(404)
    expect((await s.req(c, { method: 'GET', url: '/api/messages/search?q=사진', ip: IP })).json().data).toEqual([])
    expect((await s.req(b, { method: 'GET', url: '/api/messages/search?q=사진', ip: IP })).json().data).toHaveLength(1)
  })

  it('rooms: invite with a system message, leave', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const c = await s.join('C')
    const room = (await s.req(a, { method: 'POST', url: '/api/conversations', ip: IP, payload: { memberIds: [b.memberId], title: '행사 준비' } })).json().data
    expect(room.kind).toBe('room')
    await s.req(a, { method: 'POST', url: `/api/conversations/${room.id}/members`, ip: IP, payload: { memberIds: [c.memberId] } })
    const msgs = (await s.req(c, { method: 'GET', url: `/api/conversations/${room.id}/messages`, ip: IP })).json().data
    expect(msgs[0]).toMatchObject({ kind: 'system', body: 'A님이 C님을 초대했습니다.' })
    await s.req(c, { method: 'DELETE', url: `/api/conversations/${room.id}/members/me`, ip: IP })
    expect((await s.req(c, { method: 'GET', url: `/api/conversations/${room.id}`, ip: IP })).statusCode).toBe(404)
  })

  it('group chat is created automatically and follows group membership', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const g = (await s.req(a, { method: 'POST', url: '/api/groups', ip: IP, payload: { name: 'TF', memberIds: [b.memberId] } })).json().data
    const list = (await s.req(a, { method: 'GET', url: '/api/conversations', ip: IP })).json().data
    const gc = list.find((x: { kind: string }) => x.kind === 'group')
    expect(gc).toMatchObject({ title: 'TF', groupId: g.id, memberCount: 1 })
    await s.req(a, { method: 'POST', url: `/api/conversations/${gc.id}/messages`, ip: IP, payload: { body: '그룹 첫 메시지' } })
    expect((await s.req(b, { method: 'GET', url: `/api/conversations/${gc.id}/messages`, ip: IP })).statusCode).toBe(404)
    const inv = (await s.req(b, { method: 'GET', url: '/api/group-invites', ip: IP })).json().data[0]
    await s.req(b, { method: 'PATCH', url: `/api/groups/${g.id}/invites/${inv.id}`, ip: IP, payload: { action: 'accept' } })
    const msgs = (await s.req(b, { method: 'GET', url: `/api/conversations/${gc.id}/messages`, ip: IP })).json().data
    expect(msgs[0].body).toBe('그룹 첫 메시지')
  })

  it('notes: send to many, read receipt for the sender, delete per side', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const c = await s.join('C')
    await s.req(a, { method: 'POST', url: '/api/notes', ip: IP, payload: { toIds: [b.memberId, c.memberId], body: '전화 왔었습니다' } })
    const inbox = (await s.req(b, { method: 'GET', url: '/api/notes', ip: IP })).json().data
    expect(inbox[0]).toMatchObject({ fromName: 'A', body: '전화 왔었습니다', readAt: null })
    expect((await s.req(b, { method: 'GET', url: '/api/chat/unread', ip: IP })).json().data.notes).toBe(1)
    await s.req(b, { method: 'POST', url: `/api/notes/${inbox[0].id}/read`, ip: IP })
    const sent = (await s.req(a, { method: 'GET', url: '/api/notes?box=sent', ip: IP })).json().data
    expect(sent.find((n: { toName: string }) => n.toName === 'B').readAt).not.toBeNull()
    expect(sent.find((n: { toName: string }) => n.toName === 'C').readAt).toBeNull()
    await s.req(b, { method: 'DELETE', url: `/api/notes/${inbox[0].id}`, ip: IP })
    expect((await s.req(b, { method: 'GET', url: '/api/notes', ip: IP })).json().data).toEqual([])
    expect((await s.req(a, { method: 'GET', url: '/api/notes?box=sent', ip: IP })).json().data).toHaveLength(2)
  })

  it('retention job removes old messages', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const conv = (await s.req(a, { method: 'POST', url: '/api/conversations', ip: IP, payload: { memberIds: [b.memberId] } })).json().data
    await s.req(a, { method: 'POST', url: `/api/conversations/${conv.id}/messages`, ip: IP, payload: { body: 'old' } })
    expect(runChatJobs(s.ctx, Date.now() + 400 * 86400000)).toBe(1)
    expect((await s.req(b, { method: 'GET', url: `/api/conversations/${conv.id}/messages`, ip: IP })).json().data).toEqual([])
  })
})
