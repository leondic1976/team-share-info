import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type Cred, type TestServer } from './helpers'
import { PII_CHECK_PROTOCOL } from '../../src/shared/constants'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'
const PHONE = '연락처 010-1234-5678'
const team = { type: 'team', groupIds: [], memberIds: [] }
type Body = Record<string, unknown>

/** The server answer to one write, with or without the writer's confirmation. */
async function send(c: Cred, method: 'POST' | 'PATCH', url: string, payload: Body, headers: Record<string, string> = {}): Promise<{ status: number; json: { data?: { id?: string }; error?: { code: string; details?: { found: { kind: string; count: number; samples: string[] }[] } } } }> {
  const r = await s!.req(c, { method, url, ip: IP, payload, headers })
  return { status: r.statusCode, json: r.json() }
}

describe('personal information is checked on the server too (125-9)', () => {
  it('refuses an unconfirmed message with the kinds found, takes it once confirmed', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const conv = (await s.req(a, { method: 'POST', url: '/api/conversations', ip: IP, payload: { memberIds: [b.memberId] } })).json().data
    const url = `/api/conversations/${conv.id}/messages`

    const refused = await send(a, 'POST', url, { body: `${PHONE}, hong@example.go.kr` })
    expect(refused.status).toBe(422)
    expect(refused.json.error?.code).toBe('PII_UNCONFIRMED')
    expect(refused.json.error?.details?.found.map((f) => [f.kind, f.count, f.samples])).toEqual([
      ['mobile', 1, ['010-****-****']],
      ['email', 1, ['ho**@*******.**.**']]
    ])
    expect((await s.req(b, { method: 'GET', url, ip: IP })).json().data).toEqual([])

    // nothing personal: no confirmation needed
    expect((await send(a, 'POST', url, { body: '내선 1234로 전화 주세요' })).status).toBe(200)
    // confirmed in the dialog: sent, and the flag is not part of what is stored
    expect((await send(a, 'POST', url, { body: PHONE, piiAck: true })).status).toBe(200)
    const msgs = (await s.req(b, { method: 'GET', url, ip: IP })).json().data as { id: string; body: string }[]
    expect(msgs.map((m) => m.body)).toEqual(['내선 1234로 전화 주세요', PHONE])

    // a changed message is checked again
    const first = msgs[0].id
    expect((await send(a, 'PATCH', `/api/messages/${first}`, { body: '주민번호 900101-1234567' })).json.error?.code).toBe('PII_UNCONFIRMED')
    expect((await send(a, 'PATCH', `/api/messages/${first}`, { body: '주민번호 900101-1234567', piiAck: true })).status).toBe(200)
  })

  it('checks every write the PC checks before sending', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const board = (await s.req(s.admin, { method: 'POST', url: '/api/boards', payload: { name: '자유게시판', scope: team } })).json().data
    const post = (await send(b, 'POST', '/api/posts', { boardId: board.id, title: '점심', bodyHtml: '<p>추천</p>' })).json.data!
    const notice = (await send(s.admin, 'POST', '/api/notices', { title: '공지', bodyHtml: '<p>x</p>', level: 'normal', scope: team })).json.data!
    const from = Date.UTC(2026, 10, 30)
    const duty = (await send(b, 'POST', '/api/duty', { type: '출장', startAt: from, endAt: from + 86_400_000, allDay: true, place: '도청' })).json.data!

    const writes: [Cred, 'POST' | 'PATCH', string, Body][] = [
      [b, 'POST', '/api/notes', { toIds: [s.admin.memberId], body: PHONE }],
      [b, 'POST', `/api/comments/post/${post.id}`, { body: PHONE }],
      [b, 'POST', '/api/posts', { boardId: board.id, title: '점심', bodyHtml: `<p>${PHONE}</p>` }],
      [b, 'POST', '/api/posts', { boardId: board.id, title: '투표', bodyHtml: '', poll: { question: '어디로', options: ['식당', PHONE], multiple: false, anonymous: false, closesAt: null } }],
      [b, 'PATCH', `/api/posts/${post.id}`, { bodyHtml: `<p>${PHONE}</p>` }],
      [b, 'POST', '/api/shared-memos', { body: PHONE, scope: team }],
      [b, 'POST', '/api/alarms', { toIds: [s.admin.memberId], fireAt: Date.now(), immediate: true, title: '회의', body: PHONE }],
      [b, 'POST', '/api/duty', { type: '출장', startAt: from, endAt: from + 86_400_000, allDay: true, note: PHONE }],
      [b, 'PATCH', `/api/duty/${duty.id}`, { type: '출장', startAt: from, endAt: from + 86_400_000, allDay: true, place: PHONE }],
      [s.admin, 'POST', '/api/notices', { title: '공지', bodyHtml: `<p>${PHONE}</p>`, level: 'normal', scope: team }],
      [s.admin, 'POST', '/api/notices', { title: `긴급 ${PHONE}`, bodyHtml: '', level: 'urgent', scope: team }],
      [s.admin, 'PATCH', `/api/notices/${notice.id}`, { title: `공지 ${PHONE}` }]
    ]
    for (const [c, method, url, payload] of writes) {
      const refused = await send(c, method, url, payload)
      expect([url, refused.status, refused.json.error?.code]).toEqual([url, 422, 'PII_UNCONFIRMED'])
      const taken = await send(c, method, url, { ...payload, piiAck: true })
      expect([url, taken.status]).toEqual([url, 200])
    }
  })

  it('takes the confirmation in the query where the body has a fixed shape (feedback)', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const item = (n: number): Body => ({
      kind: 'bug',
      title: '오류 신고',
      body: `연락은 ${PHONE} 으로 주세요. 화면이 멈춥니다.`,
      author: '',
      installId: 'ABCD-EFGH-JKLM',
      submissionId: `${String(n).padStart(8, '0')}-2222-4333-8444-555555555555`,
      createdAt: new Date().toISOString()
    })
    expect((await send(b, 'POST', '/api/feedback', item(1))).json.error?.code).toBe('PII_UNCONFIRMED')
    expect((await s.req(b, { method: 'POST', url: '/api/feedback?piiAck=1', ip: IP, payload: item(1) })).statusCode).toBe(200)
    // the flag in the body is taken out before the strict schema reads it
    s.ctx.db.run('UPDATE feedback_items SET received_at = received_at - 120000')
    expect((await send(b, 'POST', '/api/feedback', { ...item(2), piiAck: true })).status).toBe(200)
  })

  it('leaves programs older than the check alone, so they keep working during the rollout', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const old = { 'x-protocol': String(PII_CHECK_PROTOCOL - 1) }
    expect((await send(a, 'POST', '/api/notes', { toIds: [s.admin.memberId], body: PHONE }, old)).status).toBe(200)
    expect((await send(a, 'POST', '/api/notes', { toIds: [s.admin.memberId], body: PHONE })).status).toBe(422)
  })

  it('logs a refusal with the kinds and counts only, never the text', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const lines: string[] = []
    s.ctx.log = (_level, message) => void lines.push(message)
    await send(a, 'POST', '/api/notes', { toIds: [s.admin.memberId], body: `${PHONE}, 010-9876-5432, 주민 900101-1234567` })
    const rows = s.ctx.db.all<{ action: string; member_id: string; detail: string }>(`SELECT action, member_id, detail FROM activity_logs WHERE action = 'pii.refused'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].member_id).toBe(a.memberId)
    expect(JSON.parse(rows[0].detail)).toEqual({ where: 'note', counts: { rrn: 1, mobile: 2 } })
    expect(lines).toEqual(['pii refused: note rrn=1,mobile=2'])
    for (const t of [rows[0].detail, ...lines]) {
      expect(t).not.toMatch(/010|1234|900101/)
    }
  })

  it('a kept item sent again with the same key after a refusal is carried out, not replayed', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const headers = { 'x-idempotency-key': 'outbox-0000-1111-2222' }
    const payload = { toIds: [s.admin.memberId], body: PHONE }
    expect((await send(a, 'POST', '/api/notes', payload, headers)).status).toBe(422)
    const ok = await send(a, 'POST', '/api/notes', { ...payload, piiAck: true }, headers)
    expect(ok.status).toBe(200)
    expect((await send(a, 'POST', '/api/notes', { ...payload, piiAck: true }, headers)).json).toEqual(ok.json)
    expect(s.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notes WHERE from_id = ?', [a.memberId])!.n).toBe(1)
  })
})
