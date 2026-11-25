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
    // the sender's id comes with each hit, so the client can show the 서무 mark next to the name
    expect((await s.req(b, { method: 'GET', url: '/api/messages/search?q=사진', ip: IP })).json().data).toMatchObject([{ senderId: a.memberId, body: '사진' }])
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

  it('leaving a 1:1 chat only hides it from my list; it comes back with its history when the other writes or I start it again', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const dm = (await s.req(a, { method: 'POST', url: '/api/conversations', ip: IP, payload: { memberIds: [b.memberId] } })).json().data
    await s.req(a, { method: 'POST', url: `/api/conversations/${dm.id}/messages`, ip: IP, payload: { body: '첫 메시지' } })
    const ids = async (who: typeof a): Promise<string[]> => (await s!.req(who, { method: 'GET', url: '/api/conversations', ip: IP })).json().data.map((c: { id: string }) => c.id)

    expect((await s.req(b, { method: 'DELETE', url: `/api/conversations/${dm.id}/members/me`, ip: IP })).statusCode).toBe(200)
    expect(await ids(b)).toEqual([])
    expect((await s.req(b, { method: 'GET', url: `/api/conversations/${dm.id}/messages`, ip: IP })).statusCode).toBe(404)
    // the other person is told nothing and keeps the conversation
    expect(await ids(a)).toEqual([dm.id])
    // ... still named after the one who left, and still the same pair
    const kept = (await s.req(a, { method: 'GET', url: '/api/conversations', ip: IP })).json().data[0]
    expect(kept).toMatchObject({ title: 'B', memberCount: 2 })
    expect([...kept.memberIds].sort()).toEqual([a.memberId, b.memberId].sort())
    const mine = (await s.req(a, { method: 'GET', url: `/api/conversations/${dm.id}/messages`, ip: IP })).json().data
    expect(mine.map((m: { kind: string; body: string }) => [m.kind, m.body])).toEqual([['text', '첫 메시지']])

    // the other person writes again: nothing is lost, the chat is back in my list as unread
    expect((await s.req(a, { method: 'POST', url: `/api/conversations/${dm.id}/messages`, ip: IP, payload: { body: '다시 보냅니다' } })).statusCode).toBe(200)
    const list = (await s.req(b, { method: 'GET', url: '/api/conversations', ip: IP })).json().data
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: dm.id, lastPreview: '다시 보냅니다', title: 'A' })
    expect(list[0].unread).toBeGreaterThanOrEqual(1)
    const back = (await s.req(b, { method: 'GET', url: `/api/conversations/${dm.id}/messages`, ip: IP })).json().data
    expect(back.map((m: { body: string }) => m.body)).toEqual(['첫 메시지', '다시 보냅니다'])

    // leaving again and starting the chat myself gives the same conversation back
    await s.req(b, { method: 'DELETE', url: `/api/conversations/${dm.id}/members/me`, ip: IP })
    const again = (await s.req(b, { method: 'POST', url: '/api/conversations', ip: IP, payload: { memberIds: [a.memberId] } })).json().data
    expect(again.id).toBe(dm.id)
    expect(await ids(b)).toEqual([dm.id])
  })

  it('rooms: the maker and admins remove a participant, others cannot; the removed one is shut out', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const c = await s.join('C')
    const d = await s.join('D')
    const url = (id: string, tail = ''): string => `/api/conversations/${id}${tail}`
    // the admin is a participant too: only people in the room can see or manage it
    const room = (await s.req(a, { method: 'POST', url: '/api/conversations', ip: IP, payload: { memberIds: [b.memberId, c.memberId, d.memberId, s.admin.memberId], title: '행사 준비' } })).json().data
    expect(room).toMatchObject({ kind: 'room', createdBy: a.memberId, canRemove: true })
    expect((await s.req(b, { method: 'GET', url: url(room.id), ip: IP })).json().data.canRemove).toBe(false)
    expect((await s.req(s.admin, { method: 'GET', url: url(room.id) })).json().data.canRemove).toBe(true)
    await s.req(a, { method: 'POST', url: url(room.id, '/messages'), ip: IP, payload: { body: '내보내기 전 메시지' } })

    // another participant may not remove anyone
    expect((await s.req(b, { method: 'DELETE', url: url(room.id, `/members/${c.memberId}`), ip: IP })).statusCode).toBe(403)
    // somebody outside the room does not even see it
    const e = await s.join('E')
    expect((await s.req(e, { method: 'DELETE', url: url(room.id, `/members/${c.memberId}`), ip: IP })).statusCode).toBe(404)
    expect((await s.req(a, { method: 'DELETE', url: url(room.id, `/members/${a.memberId}`), ip: IP })).statusCode).toBe(400)

    const sent: { to: string[]; name: string; payload: unknown }[] = []
    const orig = s.ctx.hub.sendTo.bind(s.ctx.hub)
    s.ctx.hub.sendTo = (ids, name, payload) => {
      sent.push({ to: [...ids], name, payload })
      orig(ids, name, payload)
    }
    // the maker removes C
    expect((await s.req(a, { method: 'DELETE', url: url(room.id, `/members/${c.memberId}`), ip: IP })).statusCode).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ name: 'conversation.changed', payload: { id: room.id, removed: [c.memberId] } })
    expect(sent[0].to).toContain(c.memberId)
    // an admin removes D
    expect((await s.req(s.admin, { method: 'DELETE', url: url(room.id, `/members/${d.memberId}`) })).statusCode).toBe(200)
    expect((await s.req(a, { method: 'DELETE', url: url(room.id, `/members/${d.memberId}`), ip: IP })).statusCode).toBe(404)

    const msgs = (await s.req(b, { method: 'GET', url: url(room.id, '/messages'), ip: IP })).json().data
    expect(msgs.slice(-2).map((m: { kind: string; body: string }) => [m.kind, m.body])).toEqual([
      ['system', 'A님이 C님을 내보냈습니다.'],
      ['system', '관리자님이 D님을 내보냈습니다.']
    ])
    const info = (await s.req(b, { method: 'GET', url: url(room.id), ip: IP })).json().data
    expect(info.memberIds.sort()).toEqual([a.memberId, b.memberId, s.admin.memberId].sort())

    // C: no list entry, no reading (not even what was said before), no posting, no search hit
    expect((await s.req(c, { method: 'GET', url: '/api/conversations', ip: IP })).json().data).toEqual([])
    expect((await s.req(c, { method: 'GET', url: url(room.id), ip: IP })).statusCode).toBe(404)
    expect((await s.req(c, { method: 'GET', url: url(room.id, '/messages'), ip: IP })).statusCode).toBe(404)
    expect((await s.req(c, { method: 'POST', url: url(room.id, '/messages'), ip: IP, payload: { body: '들리나요' } })).statusCode).toBe(404)
    expect((await s.req(c, { method: 'GET', url: '/api/messages/search?q=내보내기', ip: IP })).json().data).toEqual([])

    // later messages go to the people still in the room only
    sent.length = 0
    await s.req(b, { method: 'POST', url: url(room.id, '/messages'), ip: IP, payload: { body: '남은 사람끼리' } })
    const msgNew = sent.find((x) => x.name === 'message.new')!
    expect(msgNew.to.sort()).toEqual([a.memberId, b.memberId, s.admin.memberId].sort())

    // leaving still works, and a removed person can be added again
    expect((await s.req(b, { method: 'DELETE', url: url(room.id, '/members/me'), ip: IP })).statusCode).toBe(200)
    expect((await s.req(b, { method: 'GET', url: url(room.id), ip: IP })).statusCode).toBe(404)
    expect((await s.req(a, { method: 'POST', url: url(room.id, '/members'), ip: IP, payload: { memberIds: [c.memberId, a.memberId] } })).json().data).toMatchObject({ added: 1, conversationId: room.id })
    expect((await s.req(c, { method: 'GET', url: url(room.id), ip: IP })).statusCode).toBe(200)
  })

  it('adding people to a 1:1 conversation makes a new room and leaves the pair alone', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const c = await s.join('C')
    const dm = (await s.req(a, { method: 'POST', url: '/api/conversations', ip: IP, payload: { memberIds: [b.memberId] } })).json().data
    expect(dm).toMatchObject({ kind: 'dm', canRemove: false })
    await s.req(a, { method: 'POST', url: `/api/conversations/${dm.id}/messages`, ip: IP, payload: { body: '둘만의 이야기' } })
    // nobody new chosen: nothing is made
    expect((await s.req(a, { method: 'POST', url: `/api/conversations/${dm.id}/members`, ip: IP, payload: { memberIds: [b.memberId] } })).statusCode).toBe(400)
    const r = (await s.req(a, { method: 'POST', url: `/api/conversations/${dm.id}/members`, ip: IP, payload: { memberIds: [c.memberId] } })).json().data
    expect(r).toMatchObject({ added: 1, created: true })
    expect(r.conversationId).not.toBe(dm.id)
    const room = (await s.req(c, { method: 'GET', url: `/api/conversations/${r.conversationId}`, ip: IP })).json().data
    expect(room).toMatchObject({ kind: 'room', memberCount: 3, createdBy: a.memberId })
    // the old messages are not copied, and the 1:1 stays closed to C
    const msgs = (await s.req(c, { method: 'GET', url: `/api/conversations/${r.conversationId}/messages`, ip: IP })).json().data
    expect(msgs.map((m: { kind: string; body: string }) => [m.kind, m.body])).toEqual([['system', 'A님이 C님을 추가해 새 대화방을 만들었습니다.']])
    expect((await s.req(c, { method: 'GET', url: `/api/conversations/${dm.id}/messages`, ip: IP })).statusCode).toBe(404)
    expect((await s.req(b, { method: 'GET', url: `/api/conversations/${dm.id}`, ip: IP })).json().data).toMatchObject({ kind: 'dm', memberCount: 2 })
    // a 1:1 has nobody to remove
    expect((await s.req(a, { method: 'DELETE', url: `/api/conversations/${dm.id}/members/${b.memberId}`, ip: IP })).statusCode).toBe(400)
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
    // participants of a group chat are managed in the group
    const c = await s.join('C')
    expect((await s.req(a, { method: 'POST', url: `/api/conversations/${gc.id}/members`, ip: IP, payload: { memberIds: [c.memberId] } })).statusCode).toBe(400)
    expect((await s.req(a, { method: 'DELETE', url: `/api/conversations/${gc.id}/members/${b.memberId}`, ip: IP })).statusCode).toBe(400)
    expect((await s.req(a, { method: 'DELETE', url: `/api/conversations/${gc.id}/members/me`, ip: IP })).statusCode).toBe(400)
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

  it('the sender edits (text, 24 hours) and deletes; both are shown to everybody, others cannot', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const conv = (await s.req(a, { method: 'POST', url: '/api/conversations', ip: IP, payload: { memberIds: [b.memberId] } })).json().data
    const url = `/api/conversations/${conv.id}/messages`
    await s.req(a, { method: 'POST', url, ip: IP, payload: { body: '처음 글' } })
    await s.req(a, { method: 'POST', url, ip: IP, payload: { body: '둘째 글' } })
    let msgs = (await s.req(b, { method: 'GET', url, ip: IP })).json().data
    const [first, second] = msgs
    expect([first.editedAt, first.deleted]).toEqual([null, false])
    // only the sender, never empty
    expect((await s.req(b, { method: 'PATCH', url: `/api/messages/${first.id}`, ip: IP, payload: { body: '남의 글' } })).statusCode).toBe(403)
    expect((await s.req(a, { method: 'PATCH', url: `/api/messages/${first.id}`, ip: IP, payload: { body: '   ' } })).statusCode).toBe(400)
    expect((await s.req(a, { method: 'PATCH', url: `/api/messages/${first.id}`, ip: IP, payload: { body: '고친 글' } })).statusCode).toBe(200)
    msgs = (await s.req(b, { method: 'GET', url, ip: IP })).json().data
    expect(msgs[0].body).toBe('고친 글')
    expect(msgs[0].editedAt).toBeGreaterThan(0)
    // the search finds the new text, not the old
    expect((await s.req(b, { method: 'GET', url: '/api/messages/search?q=처음', ip: IP })).json().data).toEqual([])
    expect((await s.req(b, { method: 'GET', url: '/api/messages/search?q=고친', ip: IP })).json().data).toHaveLength(1)
    // older than 24 hours: no more changes
    s.ctx.db.run('UPDATE messages SET created_at = ? WHERE id = ?', [Date.now() - 25 * 3600_000, second.id])
    const late = await s.req(a, { method: 'PATCH', url: `/api/messages/${second.id}`, ip: IP, payload: { body: '늦은 수정' } })
    expect([late.statusCode, late.json().error?.message]).toEqual([400, '보낸 지 24시간이 지난 메시지는 고칠 수 없습니다.'])
    // delete: only the sender; the place stays, the text and the edit time go
    expect((await s.req(b, { method: 'DELETE', url: `/api/messages/${first.id}`, ip: IP })).statusCode).toBe(403)
    expect((await s.req(a, { method: 'DELETE', url: `/api/messages/${first.id}`, ip: IP })).statusCode).toBe(200)
    msgs = (await s.req(b, { method: 'GET', url, ip: IP })).json().data
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ id: first.id, deleted: true, body: '삭제된 메시지입니다.', attachments: [], editedAt: null, unreadBy: 0 })
    expect(s.ctx.db.get<{ body: string }>('SELECT body FROM messages WHERE id = ?', [first.id])!.body).toBe('')
    expect((await s.req(b, { method: 'GET', url: '/api/messages/search?q=고친', ip: IP })).json().data).toEqual([])
    // a deleted message cannot be changed or deleted again
    expect((await s.req(a, { method: 'PATCH', url: `/api/messages/${first.id}`, ip: IP, payload: { body: '되살리기' } })).statusCode).toBe(404)
    expect((await s.req(a, { method: 'DELETE', url: `/api/messages/${first.id}`, ip: IP })).statusCode).toBe(404)
    // the list of conversations shows the last message that is still there
    expect((await s.req(b, { method: 'GET', url: '/api/conversations', ip: IP })).json().data[0].lastPreview).toBe('둘째 글')
  })

  it('a file message cannot be edited, only deleted', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const conv = (await s.req(a, { method: 'POST', url: '/api/conversations', ip: IP, payload: { memberIds: [b.memberId] } })).json().data
    const url = `/api/conversations/${conv.id}/messages`
    await s.req(a, { method: 'POST', url, ip: IP, payload: { body: '글' } })
    const id = (await s.req(a, { method: 'GET', url, ip: IP })).json().data[0].id
    s.ctx.db.run("UPDATE messages SET kind = 'file' WHERE id = ?", [id])
    expect((await s.req(a, { method: 'PATCH', url: `/api/messages/${id}`, ip: IP, payload: { body: '바꿈' } })).statusCode).toBe(400)
    expect((await s.req(a, { method: 'DELETE', url: `/api/messages/${id}`, ip: IP })).statusCode).toBe(200)
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
