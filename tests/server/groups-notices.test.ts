import { describe, it, expect, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { createTestServer, type Cred, type TestServer } from './helpers'
import { PROTOCOL_VERSION } from '../../src/shared/constants'
import type { ServerMessage } from '../../src/shared/events'
import { runNoticeJobs } from '../../src/server/routes/notices'

let s: TestServer | null = null
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const w of sockets) w.terminate()
  sockets.length = 0
  await s?.close()
  s = null
})

const IP = '192.168.10.20'

async function createGroup(t: TestServer, owner: Cred, name: string, memberIds: string[] = [], visibility = 'private') {
  const r = await t.req(owner, { method: 'POST', url: '/api/groups', ip: IP, payload: { name, visibility, memberIds } })
  expect(r.statusCode).toBe(200)
  return r.json().data as { id: string }
}

async function acceptAll(t: TestServer, who: Cred): Promise<void> {
  const inv = (await t.req(who, { method: 'GET', url: '/api/group-invites', ip: IP })).json().data as { id: string; groupId: string; kind: string }[]
  for (const i of inv.filter((x) => x.kind === 'invite')) {
    const r = await t.req(who, { method: 'PATCH', url: `/api/groups/${i.groupId}/invites/${i.id}`, ip: IP, payload: { action: 'accept' } })
    expect(r.statusCode).toBe(200)
  }
}

async function wsConnect(port: number, cred: Cred): Promise<ServerMessage[]> {
  const messages: ServerMessage[] = []
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    sockets.push(ws)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', ...cred, protocol: PROTOCOL_VERSION, appVersion: '0.1.0' })))
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMessage
      messages.push(m)
      if (m.type === 'welcome') resolve()
    })
    ws.on('error', reject)
  })
  return messages
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('groups (M2-1)', () => {
  it('creates, invites, accepts, leaves', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const g = await createGroup(s, a, 'TF', [b.memberId])
    let list = (await s.req(b, { method: 'GET', url: '/api/groups', ip: IP })).json().data
    expect(list.find((x: { id: string }) => x.id === g.id)).toMatchObject({ myRole: null, myPending: 'invite' })
    await acceptAll(s, b)
    list = (await s.req(b, { method: 'GET', url: '/api/groups', ip: IP })).json().data
    expect(list.find((x: { id: string }) => x.id === g.id)).toMatchObject({ myRole: 'member', memberCount: 2 })
    const me = (await s.req(b, { method: 'GET', url: '/api/me', ip: IP })).json().data
    expect(me.groups.map((x: { name: string }) => x.name)).toEqual(['TF'])
    // owner cannot leave while others remain
    expect((await s.req(a, { method: 'DELETE', url: `/api/groups/${g.id}/members/${a.memberId}`, ip: IP })).statusCode).toBe(400)
    expect((await s.req(b, { method: 'DELETE', url: `/api/groups/${g.id}/members/${b.memberId}`, ip: IP })).statusCode).toBe(200)
  })

  it('hides private groups from non-members and allows join requests to public groups', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const c = await s.join('C')
    const priv = await createGroup(s, a, '비공개')
    const pub = await createGroup(s, a, '공개', [], 'public')
    const list = (await s.req(c, { method: 'GET', url: '/api/groups', ip: IP })).json().data.map((x: { name: string }) => x.name)
    expect(list).toEqual(['공개'])
    expect((await s.req(c, { method: 'GET', url: `/api/groups/${priv.id}`, ip: IP })).statusCode).toBe(404)
    expect((await s.req(c, { method: 'POST', url: `/api/groups/${priv.id}/join-requests`, ip: IP })).statusCode).toBe(404)
    await s.req(c, { method: 'POST', url: `/api/groups/${pub.id}/join-requests`, ip: IP })
    const reqs = (await s.req(a, { method: 'GET', url: '/api/group-invites', ip: IP })).json().data
    expect(reqs[0]).toMatchObject({ kind: 'request', memberName: 'C' })
    await s.req(a, { method: 'PATCH', url: `/api/groups/${pub.id}/invites/${reqs[0].id}`, ip: IP, payload: { action: 'approve' } })
    const g = (await s.req(c, { method: 'GET', url: `/api/groups/${pub.id}`, ip: IP })).json().data
    expect(g.myRole).toBe('member')
  })

  it('respects the admins-only group creation setting', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    await s.req(s.admin, { method: 'PUT', url: '/api/admin/settings', payload: { ops: { groupCreators: 'admins' } } })
    expect((await s.req(a, { method: 'POST', url: '/api/groups', ip: IP, payload: { name: 'x' } })).statusCode).toBe(403)
  })

  it('admin sees group metadata only and can transfer ownership', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const g = await createGroup(s, a, 'TF', [b.memberId])
    await acceptAll(s, b)
    const all = (await s.req(s.admin, { method: 'GET', url: '/api/admin/groups' })).json().data
    expect(all[0]).toMatchObject({ name: 'TF', ownerName: 'A', memberCount: 2 })
    const r = await s.req(s.admin, { method: 'PATCH', url: `/api/groups/${g.id}`, payload: { ownerId: b.memberId } })
    expect(r.json().data.ownerId).toBe(b.memberId)
  })
})

describe('scope enforcement (13.9 required test)', () => {
  it('a non-member never receives group-scoped notices: list, single, attachment, realtime, receipts', async () => {
    s = await createTestServer()
    const a = await s.join('A', { ip: '127.0.0.1' })
    const b = await s.join('B', { ip: '127.0.0.1' })
    const g = await createGroup(s, a, 'TF')
    await s.app.listen({ port: 0, host: '127.0.0.1' })
    const port = (s.app.server.address() as AddressInfo).port
    const aMsgs = await wsConnect(port, a)
    const bMsgs = await wsConnect(port, b)

    const up = await s.req(a, {
      method: 'POST',
      url: '/api/attachments?name=secret.txt',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('group only')
    })
    const att = up.json().data
    const created = await s.req(a, {
      method: 'POST',
      url: '/api/notices',
      payload: { level: 'normal', title: '그룹 공지', bodyHtml: '<p>비밀</p>', scope: { type: 'group', groupIds: [g.id] }, attachmentIds: [att.id] }
    })
    expect(created.statusCode).toBe(200)
    const nid = created.json().data.id
    await sleep(150)

    // list
    const bList = (await s.req(b, { method: 'GET', url: '/api/notices' })).json().data
    expect(bList.find((n: { id: string }) => n.id === nid)).toBeUndefined()
    expect((await s.req(b, { method: 'GET', url: `/api/notices?groupId=${g.id}` })).json().data).toEqual([])
    // single -> 404 (existence hidden)
    expect((await s.req(b, { method: 'GET', url: `/api/notices/${nid}` })).statusCode).toBe(404)
    expect((await s.req(b, { method: 'POST', url: `/api/notices/${nid}/read` })).statusCode).toBe(404)
    // attachment
    expect((await s.req(b, { method: 'GET', url: `/api/attachments/${att.id}` })).statusCode).toBe(404)
    expect((await s.req(a, { method: 'GET', url: `/api/attachments/${att.id}` })).body).toBe('group only')
    // realtime
    expect(aMsgs.some((m) => m.type === 'event' && m.name === 'notice.changed' && (m.payload as { id: string }).id === nid)).toBe(true)
    expect(bMsgs.some((m) => m.type === 'event' && JSON.stringify(m.payload).includes(nid))).toBe(false)
    // unread counter
    expect((await s.req(b, { method: 'GET', url: '/api/notices/unread-count' })).json().data.unread).toBe(0)

    // after B joins the group, B sees it; after leaving, it disappears again
    await s.req(a, { method: 'POST', url: `/api/groups/${g.id}/invites`, payload: { memberIds: [b.memberId] } })
    await acceptAll(s, b)
    expect((await s.req(b, { method: 'GET', url: `/api/notices/${nid}` })).statusCode).toBe(200)
    await s.req(b, { method: 'DELETE', url: `/api/groups/${g.id}/members/${b.memberId}` })
    expect((await s.req(b, { method: 'GET', url: `/api/notices/${nid}` })).statusCode).toBe(404)
  })

  it('cannot post to a group you do not belong to', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const g = await createGroup(s, a, 'TF')
    const r = await s.req(b, { method: 'POST', url: '/api/notices', ip: IP, payload: { title: 'x', scope: { type: 'group', groupIds: [g.id] } } })
    expect(r.statusCode).toBe(400)
  })

  it('members scope: only listed people (and the author) see it', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const c = await s.join('C')
    const r = await s.req(a, { method: 'POST', url: '/api/notices', ip: IP, payload: { title: '개인', scope: { type: 'members', memberIds: [b.memberId] } } })
    const nid = r.json().data.id
    expect((await s.req(b, { method: 'GET', url: `/api/notices/${nid}`, ip: IP })).statusCode).toBe(200)
    expect((await s.req(c, { method: 'GET', url: `/api/notices/${nid}`, ip: IP })).statusCode).toBe(404)
    expect((await s.req(a, { method: 'GET', url: `/api/notices/${nid}`, ip: IP })).statusCode).toBe(200)
  })
})

describe('notices and urgent alerts (M2-2, M2-3)', () => {
  it('tracks delivered -> read -> acked with replies', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const r = await s.req(s.admin, {
      method: 'POST',
      url: '/api/notices',
      payload: { level: 'urgent', title: '대피 훈련', bodyHtml: '<p>14시</p><script>x</script>', scope: { type: 'team' }, requireAck: true, replyOptions: ['참석', '불참'] }
    })
    const nid = r.json().data.id
    const detail = (await s.req(b, { method: 'GET', url: `/api/notices/${nid}`, ip: IP })).json().data
    expect(detail.bodyHtml).toBe('<p>14시</p>')
    expect(detail.my).toMatchObject({ readAt: null, ackedAt: null })
    let rc = (await s.req(s.admin, { method: 'GET', url: `/api/notices/${nid}/receipts` })).json().data
    expect(rc).toHaveLength(1)
    expect(rc[0]).toMatchObject({ name: 'B', readAt: null })
    expect(rc[0].deliveredAt).not.toBeNull()

    expect((await s.req(b, { method: 'POST', url: `/api/notices/${nid}/ack`, ip: IP, payload: {} })).statusCode).toBe(400)
    await s.req(b, { method: 'POST', url: `/api/notices/${nid}/ack`, ip: IP, payload: { reply: '참석' } })
    rc = (await s.req(s.admin, { method: 'GET', url: `/api/notices/${nid}/receipts` })).json().data
    expect(rc[0]).toMatchObject({ reply: '참석' })
    expect(rc[0].readAt).not.toBeNull()
    expect(rc[0].ackedAt).not.toBeNull()
    const list = (await s.req(s.admin, { method: 'GET', url: '/api/notices' })).json().data
    expect(list[0].stats).toEqual({ total: 1, read: 1, acked: 1 })
  })

  it('only admins send urgent notices by default', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const r = await s.req(b, { method: 'POST', url: '/api/notices', ip: IP, payload: { level: 'urgent', title: 'x', scope: { type: 'team' } } })
    expect(r.statusCode).toBe(403)
    await s.req(s.admin, { method: 'PUT', url: '/api/admin/settings', payload: { ops: { urgentSenders: 'everyone' } } })
    expect((await s.req(b, { method: 'POST', url: '/api/notices', ip: IP, payload: { level: 'urgent', title: 'x', scope: { type: 'team' } } })).statusCode).toBe(200)
  })

  it('delivers to offline members on reconnect via /pending and re-shows unacked urgent', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    await s.req(s.admin, { method: 'POST', url: '/api/notices', payload: { level: 'urgent', title: '긴급', scope: { type: 'team' }, requireAck: true } })
    await s.req(s.admin, { method: 'POST', url: '/api/notices', payload: { level: 'normal', title: '일반', scope: { type: 'team' } } })
    let pending = (await s.req(b, { method: 'GET', url: '/api/notices/pending', ip: IP })).json().data
    expect(pending.map((p: { title: string }) => p.title).sort()).toEqual(['긴급', '일반'])
    pending = (await s.req(b, { method: 'GET', url: '/api/notices/pending', ip: IP })).json().data
    expect(pending.map((p: { title: string }) => p.title)).toEqual(['긴급'])
    const rc = (await s.req(s.admin, { method: 'GET', url: `/api/notices/${pending[0].id}/receipts` })).json().data
    expect(rc[0].deliveredAt).not.toBeNull()
  })

  it('publishes scheduled notices and auto re-notifies unacked urgent ones', async () => {
    s = await createTestServer()
    const b = await s.join('B', { ip: '127.0.0.1' })
    await s.app.listen({ port: 0, host: '127.0.0.1' })
    const port = (s.app.server.address() as AddressInfo).port
    const bMsgs = await wsConnect(port, b)
    const future = Date.now() + 60_000
    const sched = (await s.req(s.admin, { method: 'POST', url: '/api/notices', payload: { title: '예약', scope: { type: 'team' }, publishAt: future } })).json().data
    expect(sched.publishedAt).toBeNull()
    expect((await s.req(b, { method: 'GET', url: '/api/notices' })).json().data).toEqual([])
    runNoticeJobs(s.ctx, future + 1)
    expect((await s.req(b, { method: 'GET', url: '/api/notices' })).json().data.map((n: { title: string }) => n.title)).toEqual(['예약'])

    await s.req(s.admin, { method: 'POST', url: '/api/notices', payload: { level: 'urgent', title: '재알림', scope: { type: 'team' }, requireAck: true, renotifyMinutes: 5 } })
    await sleep(100)
    const count = () => bMsgs.filter((m) => m.type === 'event' && m.name === 'notice.urgent').length
    expect(count()).toBe(1)
    // the popup knows the author by id (for the 서무 mark next to the name)
    expect(bMsgs.find((m) => m.type === 'event' && m.name === 'notice.urgent')).toMatchObject({ payload: { authorId: s.admin.memberId } })
    runNoticeJobs(s.ctx, Date.now() + 60_000) // 1 min later: not yet
    await sleep(50)
    expect(count()).toBe(1)
    runNoticeJobs(s.ctx, Date.now() + 6 * 60_000) // 6 min later: re-notified
    await sleep(100)
    expect(count()).toBe(2)
  })

  it('manual renotify targets only unread members; author can edit/delete, others cannot', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const nid = (await s.req(s.admin, { method: 'POST', url: '/api/notices', payload: { level: 'important', title: '중요', scope: { type: 'team' } } })).json().data.id
    await s.req(b, { method: 'POST', url: `/api/notices/${nid}/read`, ip: IP })
    const re = (await s.req(s.admin, { method: 'POST', url: `/api/notices/${nid}/renotify` })).json().data
    expect(re.count).toBe(1)
    expect((await s.req(c, { method: 'PATCH', url: `/api/notices/${nid}`, ip: IP, payload: { title: 'x' } })).statusCode).toBe(403)
    expect((await s.req(s.admin, { method: 'PATCH', url: `/api/notices/${nid}`, payload: { pinned: true } })).statusCode).toBe(200)
    expect((await s.req(s.admin, { method: 'DELETE', url: `/api/notices/${nid}` })).statusCode).toBe(200)
    expect((await s.req(b, { method: 'GET', url: `/api/notices/${nid}`, ip: IP })).statusCode).toBe(404)
  })

  it('blocks attachments with forbidden extensions', async () => {
    s = await createTestServer()
    const r = await s.req(s.admin, { method: 'POST', url: '/api/attachments?name=run.exe', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') })
    expect(r.json().error.code).toBe('EXTENSION_BLOCKED')
  })
})
