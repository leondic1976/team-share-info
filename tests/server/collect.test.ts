import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestServer, type Cred, type TestServer } from './helpers'
import { runCollectJobs } from '../../src/server/routes/collect'
import { runMessageFileRetention } from '../../src/server/message-files'
import { runBackup } from '../../src/server/backup'
import { buildApp } from '../../src/server/app'
import { readStoredZip } from '../../src/node/zip'
import type { CollectChangedPayload, CollectDto, CollectStatusDto, CollectSummaryDto } from '../../src/shared/schemas/collect'
import type { EventName } from '../../src/shared/events'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'
const HOUR = 3600_000
const DAY = 24 * HOUR

async function upload(srv: TestServer, who: Cred, name: string, content: string): Promise<string> {
  const r = await srv.req(who, {
    method: 'POST',
    url: `/api/attachments?name=${encodeURIComponent(name)}`,
    ip: IP,
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from(content)
  })
  expect(r.statusCode, r.body).toBe(200)
  return r.json().data.id
}

type Req = (who: Cred, method: string, url: string, payload?: unknown) => Promise<{ statusCode: number; body: string; rawPayload: Buffer; headers: Record<string, unknown>; json: () => { data: never; error?: { message: string } } }>
const api = (srv: TestServer): Req => (who, method, url, payload) =>
  srv.req(who, { method: method as 'GET', url, ip: IP, ...(payload !== undefined ? { payload: payload as object } : {}) }) as never

/** Record events and pretend the given members are online. */
function spyEvents(srv: TestServer, online: () => string[]): { name: EventName; to: string[]; payload: CollectChangedPayload }[] {
  const out: { name: EventName; to: string[]; payload: CollectChangedPayload }[] = []
  const hub = srv.ctx.hub
  hub.onlineMemberIds = () => new Set(online())
  hub.sendTo = (ids, name, payload) => {
    const to = [...ids].filter((m) => online().includes(m))
    if (to.length) out.push({ name, to, payload: payload as CollectChangedPayload })
  }
  return out
}

async function create(srv: TestServer, who: Cred, body: Record<string, unknown>): Promise<string> {
  const r = await api(srv)(who, 'POST', '/api/collects', { title: '2027년 예산 요구서', description: '양식에 맞춰 제출', deadlineAt: Date.now() + 3 * DAY, scope: { type: 'team' }, ...body })
  expect(r.statusCode, r.body).toBe(200)
  return (r.json().data as unknown as { id: string }).id
}

describe('자료 취합 (collect)', () => {
  it('scope: only the people asked see the request and its 양식; only the requester sees the 제출 현황', async () => {
    s = await createTestServer()
    const call = api(s)
    const a = await s.join('A', { deptName: '기획팀' })
    const b = await s.join('B', { deptName: '총무팀' })
    const c = await s.join('C', { deptName: '총무팀' })
    const d = await s.join('D')
    const form = await upload(s, a, '양식.hwp', 'FORM')
    const id = await create(s, a, { scope: { type: 'members', memberIds: [b.memberId, c.memberId] }, attachmentIds: [form] })

    // D is not asked: not listed, 404 everywhere, no 양식
    expect(((await call(d, 'GET', '/api/collects')).json().data as CollectSummaryDto[]).map((x) => x.id)).not.toContain(id)
    expect((await call(d, 'GET', `/api/collects/${id}`)).statusCode).toBe(404)
    expect((await call(d, 'GET', `/api/attachments/${form}`)).statusCode).toBe(404)
    expect((await call(d, 'GET', `/api/collects/${id}/status`)).statusCode).toBe(404)
    expect((await call(d, 'PUT', `/api/collects/${id}/submission`, { attachmentIds: [] })).statusCode).toBe(404)

    // B is asked: sees it, gets the form, counts it on the menu
    const lb = (await call(b, 'GET', '/api/collects')).json().data as CollectSummaryDto[]
    expect(lb.find((x) => x.id === id)).toMatchObject({ isTarget: true, myStatus: 'none', canManage: false, counts: null, formCount: 1 })
    expect((await call(b, 'GET', '/api/collects/summary')).json().data).toEqual({ todo: 1, canCreate: true })
    const dl = await call(b, 'GET', `/api/attachments/${form}`)
    expect(dl.statusCode).toBe(200)
    expect(dl.rawPayload.toString()).toBe('FORM')
    // but not the 제출 현황 of the others
    expect((await call(b, 'GET', `/api/collects/${id}/status`)).statusCode).toBe(403)
    expect((await call(b, 'GET', `/api/collects/${id}/zip`)).statusCode).toBe(403)
    expect((await call(b, 'POST', `/api/collects/${id}/remind`)).statusCode).toBe(403)
    expect((await call(b, 'PATCH', `/api/collects/${id}`, { title: 'x' })).statusCode).toBe(403)

    // B hands in a file: A sees 제출, C still 미제출
    const f = await upload(s, b, '예산요구서.xlsx', 'B-FILE')
    const sub = await call(b, 'PUT', `/api/collects/${id}/submission`, { attachmentIds: [f] })
    expect(sub.statusCode, sub.body).toBe(200)
    expect((await call(b, 'GET', '/api/collects/summary')).json().data).toMatchObject({ todo: 0 })
    const st = (await call(a, 'GET', `/api/collects/${id}/status`)).json().data as CollectStatusDto
    expect(st.counts).toEqual({ total: 2, submitted: 1, late: 0, na: 0, none: 1 })
    expect(st.rows.map((r) => [r.name, r.deptName, r.status, r.files.map((x) => x.name)])).toEqual([
      ['B', '총무팀', 'submitted', ['예산요구서.xlsx']],
      ['C', '총무팀', 'none', []]
    ])
    // a handed-in file: the one who handed it in and the requester; not the other target
    expect((await call(a, 'GET', `/api/attachments/${f}`)).statusCode).toBe(200)
    expect((await call(b, 'GET', `/api/attachments/${f}`)).statusCode).toBe(200)
    expect((await call(c, 'GET', `/api/attachments/${f}`)).statusCode).toBe(404)
    expect((await call(d, 'GET', `/api/attachments/${f}`)).statusCode).toBe(404)
    // the target sees only their own
    const db = (await call(b, 'GET', `/api/collects/${id}`)).json().data as CollectDto
    expect(db.mine).toMatchObject({ status: 'submitted', files: [{ name: '예산요구서.xlsx' }] })
    expect(db.counts).toBeNull()
    const dc = (await call(c, 'GET', `/api/collects/${id}`)).json().data as CollectDto
    expect(dc.mine).toBeNull()
    // the requester is not asked
    expect((await call(a, 'PUT', `/api/collects/${id}/submission`, { attachmentIds: [] })).statusCode).toBe(403)
    // the 최종관리자 (server PC) is not in the scope here: 404 as for anyone else
    expect((await call(s.admin, 'GET', `/api/collects/${id}/status`)).statusCode).toBe(404)
  })

  it('group scope follows the group; the 최종관리자 oversees team requests', async () => {
    s = await createTestServer()
    const call = api(s)
    const a = await s.join('A')
    const b = await s.join('B')
    const c = await s.join('C')
    const g = (await call(a, 'POST', '/api/groups', { name: 'TF', visibility: 'private', memberIds: [b.memberId] })).json().data as unknown as { id: string }
    const inv = (await call(b, 'GET', '/api/group-invites')).json().data as unknown as { id: string; groupId: string }[]
    for (const i of inv) expect((await call(b, 'PATCH', `/api/groups/${i.groupId}/invites/${i.id}`, { action: 'accept' })).statusCode).toBe(200)
    const id = await create(s, a, { scope: { type: 'group', groupIds: [g.id] } })
    expect((await call(c, 'GET', `/api/collects/${id}`)).statusCode).toBe(404)
    let st = (await call(a, 'GET', `/api/collects/${id}/status`)).json().data as CollectStatusDto
    expect(st.rows.map((r) => r.name)).toEqual(['B'])
    // B leaves: no longer asked, cannot see it
    expect((await call(b, 'DELETE', `/api/groups/${g.id}/members/${b.memberId}`)).statusCode).toBe(200)
    expect((await call(b, 'GET', `/api/collects/${id}`)).statusCode).toBe(404)
    st = (await call(a, 'GET', `/api/collects/${id}/status`)).json().data as CollectStatusDto
    expect(st.rows).toEqual([])

    // a team request: everyone but the requester is asked; the 최종관리자 sees the 제출 현황
    const t = await create(s, a, {})
    st = (await call(s.admin, 'GET', `/api/collects/${t}/status`)).json().data as CollectStatusDto
    expect(st.rows.map((r) => r.name).sort()).toEqual(['B', 'C', '관리자'])
    // nobody to ask
    const only = await call(a, 'POST', '/api/collects', { title: 'x', deadlineAt: Date.now() + DAY, scope: { type: 'members', memberIds: [a.memberId] } })
    expect(only.statusCode).toBe(400)
  })

  it('who may ask: everyone by default, or 최종관리자·서무 only', async () => {
    s = await createTestServer()
    const call = api(s)
    const a = await s.join('A')
    await create(s, a, {})
    const put = await call(s.admin, 'PUT', '/api/admin/settings', { ops: { collectCreators: 'admins' } })
    expect(put.statusCode, put.body).toBe(200)
    const r = await call(a, 'POST', '/api/collects', { title: 'x', deadlineAt: Date.now() + DAY, scope: { type: 'team' } })
    expect(r.statusCode).toBe(403)
    expect((await call(a, 'GET', '/api/collects/summary')).json().data).toMatchObject({ canCreate: false })
    await create(s, s.admin, {})
    // a deadline in the past is refused
    expect((await call(s.admin, 'POST', '/api/collects', { title: 'x', deadlineAt: Date.now() - 1000, scope: { type: 'team' } })).statusCode).toBe(400)
  })

  it('deadline rules: late submissions, 마감 후 제출 허용 off, withdraw, 해당 없음, replace, close early', async () => {
    s = await createTestServer()
    const call = api(s)
    const a = await s.join('A')
    const b = await s.join('B')
    const c = await s.join('C')
    const late = await create(s, a, { allowLate: true, submitMode: 'both' })
    const strict = await create(s, a, { allowLate: false, submitMode: 'text' })

    // submit modes
    expect((await call(b, 'PUT', `/api/collects/${strict}/submission`, { text: '' })).statusCode).toBe(400)
    const f0 = await upload(s, b, 'x.txt', 'x')
    expect((await call(b, 'PUT', `/api/collects/${strict}/submission`, { text: '답', attachmentIds: [f0] })).statusCode).toBe(400)
    expect((await call(b, 'PUT', `/api/collects/${strict}/submission`, { text: '답변입니다' })).statusCode).toBe(200)
    expect((await call(b, 'PUT', `/api/collects/${late}/submission`, {})).statusCode).toBe(400)

    // replace: the old file goes, the new one stays
    const f1 = await upload(s, b, '첫본.hwp', 'v1')
    expect((await call(b, 'PUT', `/api/collects/${late}/submission`, { attachmentIds: [f1], text: '메모' })).statusCode).toBe(200)
    const f2 = await upload(s, b, '수정본.hwp', 'v2')
    expect((await call(b, 'PUT', `/api/collects/${late}/submission`, { attachmentIds: [f2] })).statusCode).toBe(200)
    let mine = ((await call(b, 'GET', `/api/collects/${late}`)).json().data as CollectDto).mine!
    expect(mine.files.map((x) => x.name)).toEqual(['수정본.hwp'])
    expect(mine.text).toBe('')
    expect((await call(a, 'GET', `/api/attachments/${f1}`)).statusCode).toBe(404)
    // someone else's upload cannot be slipped in
    const cf = await upload(s, c, 'c.hwp', 'c')
    await call(b, 'PUT', `/api/collects/${late}/submission`, { attachmentIds: [f2, cf] })
    mine = ((await call(b, 'GET', `/api/collects/${late}`)).json().data as CollectDto).mine!
    expect(mine.files.map((x) => x.name)).toEqual(['수정본.hwp'])

    // withdraw before the deadline; 해당 없음 with a reason
    expect((await call(b, 'DELETE', `/api/collects/${late}/submission`)).statusCode).toBe(200)
    expect(((await call(b, 'GET', `/api/collects/${late}`)).json().data as CollectDto).mine).toBeNull()
    expect((await call(c, 'POST', `/api/collects/${late}/na`, { reason: '해당 사업 없음' })).statusCode).toBe(200)

    // the deadline passes
    s.ctx.db.run('UPDATE collect_requests SET deadline_at = ? WHERE id IN (?, ?)', [Date.now() - 1000, late, strict])
    expect((await call(b, 'PUT', `/api/collects/${strict}/submission`, { text: '늦은 답' })).statusCode).toBe(409)
    expect((await call(b, 'DELETE', `/api/collects/${strict}/submission`)).statusCode).toBe(409)
    expect((await call(c, 'POST', `/api/collects/${strict}/na`, {})).statusCode).toBe(409)
    const lt = await call(b, 'PUT', `/api/collects/${late}/submission`, { text: '늦었습니다' })
    expect(lt.statusCode).toBe(200)
    expect((lt.json().data as unknown as { status: string }).status).toBe('late')
    expect((await call(b, 'DELETE', `/api/collects/${late}/submission`)).statusCode).toBe(409)
    let st = (await call(a, 'GET', `/api/collects/${late}/status`)).json().data as CollectStatusDto
    expect(Object.fromEntries(st.rows.map((r) => [r.name, [r.status, r.reason, r.text]]))).toMatchObject({ B: ['late', '', '늦었습니다'], C: ['na', '해당 사업 없음', ''], 관리자: ['none', '', ''] })
    // the deadline moved later: no longer late
    expect((await call(a, 'PATCH', `/api/collects/${late}`, { deadlineAt: Date.now() + DAY, description: '연장합니다' })).statusCode).toBe(200)
    st = (await call(a, 'GET', `/api/collects/${late}/status`)).json().data as CollectStatusDto
    expect(st.rows.find((r) => r.name === 'B')!.status).toBe('submitted')
    expect(((await call(b, 'GET', `/api/collects/${late}`)).json().data as CollectDto).description).toBe('연장합니다')

    // close early: nothing more is taken, 다시 알림 is refused
    expect((await call(a, 'POST', `/api/collects/${late}/close`)).statusCode).toBe(200)
    expect((await call(s.admin, 'PUT', `/api/collects/${late}/submission`, { text: '지금' })).statusCode).toBe(409)
    expect((await call(a, 'POST', `/api/collects/${late}/remind`)).statusCode).toBe(409)
    expect((await call(b, 'GET', '/api/collects/summary')).json().data).toMatchObject({ todo: 0 })

    // delete: gone for everyone, the files too
    expect((await call(a, 'DELETE', `/api/collects/${late}`)).statusCode).toBe(200)
    expect((await call(b, 'GET', `/api/collects/${late}`)).statusCode).toBe(404)
    expect((await call(a, 'GET', `/api/attachments/${f2}`)).statusCode).toBe(404)
  })

  it('alerts: a new request reaches who is online at once and the others when they connect; 다시 알림 goes to who has not handed in', async () => {
    s = await createTestServer()
    const call = api(s)
    const a = await s.join('A')
    const b = await s.join('B')
    const c = await s.join('C')
    const d = await s.join('D')
    let online = [a.memberId, b.memberId, d.memberId]
    const ev = spyEvents(s, () => online)
    const id = await create(s, a, { scope: { type: 'members', memberIds: [b.memberId, c.memberId, d.memberId] } })
    const created = ev.filter((e) => e.payload.created)
    expect(created).toHaveLength(1)
    expect(created[0].to.sort()).toEqual([b.memberId, d.memberId].sort())
    expect(created[0].payload).toMatchObject({ id, title: '2027년 예산 요구서', byName: 'A' })
    // B (online) already had the card; C gets it once on connecting
    expect((await call(b, 'GET', '/api/collects/pending')).json().data).toEqual([])
    expect(((await call(c, 'GET', '/api/collects/pending')).json().data as CollectChangedPayload[]).map((x) => x.id)).toEqual([id])
    expect((await call(c, 'GET', '/api/collects/pending')).json().data).toEqual([])

    // D hands in; 다시 알림 goes to B (online) and C (offline: gets the card on connecting)
    expect((await call(d, 'POST', `/api/collects/${id}/na`, {})).statusCode).toBe(200)
    ev.length = 0
    const r = await call(a, 'POST', `/api/collects/${id}/remind`)
    expect(r.json().data).toEqual({ count: 2, online: 1 })
    expect(ev.filter((e) => e.payload.remind === 'manual').flatMap((e) => e.to)).toEqual([b.memberId])
    online = [a.memberId, b.memberId, c.memberId, d.memberId]
    expect(((await call(c, 'GET', '/api/collects/pending')).json().data as CollectChangedPayload[]).map((x) => x.id)).toEqual([id])
  })

  it('automatic reminders: a day and an hour before, once each, also after a restart; not when set too late', async () => {
    s = await createTestServer()
    const call = api(s)
    const a = await s.join('A')
    const b = await s.join('B')
    const c = await s.join('C')
    const online = [a.memberId, b.memberId, c.memberId]
    const ev = spyEvents(s, () => online)
    const now = Date.now()
    const deadline = now + 3 * DAY
    const id = await create(s, a, { deadlineAt: deadline, scope: { type: 'members', memberIds: [b.memberId, c.memberId] } })
    expect((await call(c, 'PUT', `/api/collects/${id}/submission`, { attachmentIds: [await upload(s, c, 'c.hwp', 'c')] })).statusCode).toBe(200)
    ev.length = 0
    const reminders = (): { to: string[]; kind?: string }[] => ev.filter((e) => e.payload.remind).map((e) => ({ to: e.to, kind: e.payload.remind }))

    expect(runCollectJobs(s.ctx, deadline - 2 * DAY)).toBe(0)
    expect(runCollectJobs(s.ctx, deadline - 23 * HOUR)).toBe(1)
    expect(runCollectJobs(s.ctx, deadline - 22 * HOUR)).toBe(0)
    expect(reminders()).toEqual([{ to: [b.memberId], kind: 'day' }])

    // the server restarts on the same database: nothing is sent again
    const again = await buildApp({ db: s.ctx.db, dataDir: s.dataDir, version: '0.1.0', jobs: false })
    try {
      expect(runCollectJobs(again.ctx, deadline - 21 * HOUR)).toBe(0)
    } finally {
      await again.app.close()
    }
    expect(runCollectJobs(s.ctx, deadline - 50 * 60_000)).toBe(1)
    expect(runCollectJobs(s.ctx, deadline - 10 * 60_000)).toBe(0)
    expect(runCollectJobs(s.ctx, deadline + 60_000)).toBe(0)
    expect(reminders().map((x) => x.kind)).toEqual(['day', 'hour'])
    expect(s.ctx.db.all('SELECT kind, sent_count FROM collect_reminders WHERE request_id = ? ORDER BY sent_at', [id])).toEqual([
      { kind: 'day', sent_count: 1 },
      { kind: 'hour', sent_count: 1 }
    ])

    // made three hours before its deadline: no "하루 전", but "1시간 전"
    ev.length = 0
    const soon = await create(s, a, { deadlineAt: Date.now() + 3 * HOUR, scope: { type: 'members', memberIds: [b.memberId] } })
    const sd = s.ctx.db.get<{ deadline_at: number }>('SELECT deadline_at FROM collect_requests WHERE id = ?', [soon])!.deadline_at
    expect(runCollectJobs(s.ctx, sd - 2 * HOUR)).toBe(0)
    expect(runCollectJobs(s.ctx, sd - 30 * 60_000)).toBe(1)
    expect(reminders().map((x) => x.kind)).toEqual(['hour'])

    // turned off in 사용할 기능: no reminders
    const late = await create(s, a, { deadlineAt: Date.now() + 2 * DAY, scope: { type: 'members', memberIds: [b.memberId] } })
    const ld = s.ctx.db.get<{ deadline_at: number }>('SELECT deadline_at FROM collect_requests WHERE id = ?', [late])!.deadline_at
    s.ctx.db.run(`UPDATE settings SET value = json_set(value, '$.disabledFeatures', json('["collect"]')) WHERE key = 'ops'`)
    expect(runCollectJobs(s.ctx, ld - 23 * HOUR)).toBe(0)
  })

  it('한꺼번에 내려받기: one ZIP with <부서>_<이름>_<파일>, text answers and the 제출 현황; a CSV of the list', async () => {
    s = await createTestServer()
    const call = api(s)
    const a = await s.join('A', { deptName: '기획팀' })
    const b = await s.join('홍길동', { deptName: '총무팀' })
    const c = await s.join('김철수', { deptName: '재무팀' })
    const d = await s.join('이영희', { deptName: '재무팀' })
    const id = await create(s, a, { title: '예산/요구서', submitMode: 'both', scope: { type: 'members', memberIds: [b.memberId, c.memberId, d.memberId] } })
    const b1 = await upload(s, b, '요구서.xlsx', 'B-XLSX')
    const b2 = await upload(s, b, '요구서.xlsx', 'B-XLSX-2')
    expect((await call(b, 'PUT', `/api/collects/${id}/submission`, { attachmentIds: [b1, b2], text: '첫 줄\n둘째 줄' })).statusCode).toBe(200)
    expect((await call(c, 'POST', `/api/collects/${id}/na`, { reason: '대상 아님' })).statusCode).toBe(200)
    // the second file came later (the order of the files is the order they were uploaded)
    s.ctx.db.run('UPDATE attachments SET created_at = created_at + 5 WHERE id = ?', [b2])

    const z = await call(a, 'GET', `/api/collects/${id}/zip`)
    expect(z.statusCode, z.body).toBe(200)
    expect(String(z.headers['content-type'])).toBe('application/zip')
    expect(Number(z.headers['content-length'])).toBe(z.rawPayload.length)
    const today = new Date()
    const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
    expect(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(String(z.headers['content-disposition']))![1])).toBe(`자료취합_예산_요구서_${ymd}.zip`)
    const entries = readStoredZip(z.rawPayload)
    expect(entries.map((e) => e.name)).toEqual(['총무팀_홍길동_요구서.xlsx', '총무팀_홍길동_요구서 (2).xlsx', '총무팀_홍길동_제출내용.txt', '제출현황.csv'])
    expect(entries[0].data.toString()).toBe('B-XLSX')
    expect(entries[1].data.toString()).toBe('B-XLSX-2')
    expect(entries[2].data.toString('utf8')).toBe('﻿첫 줄\r\n둘째 줄')
    const csv = entries[3].data.toString('utf8')
    expect(csv.startsWith('﻿부서,이름,직위,상태,제출 시각,파일,글,해당 없음 사유')).toBe(true)
    expect(csv).toContain('총무팀,홍길동,,제출,')
    expect(csv).toMatch(/재무팀,김철수,,해당 없음,\d{4}-\d{2}-\d{2} \d{2}:\d{2},,,대상 아님/)
    expect(csv).toContain('재무팀,이영희,,미제출')

    const list = await call(a, 'GET', `/api/collects/${id}/csv`)
    expect(list.statusCode).toBe(200)
    expect(list.rawPayload.toString('utf8')).toBe(csv)
  })

  it('handed-in files are kept by the messenger file retention and go into the server backup', async () => {
    s = await createTestServer()
    const call = api(s)
    const a = await s.join('A')
    const b = await s.join('B')
    const form = await upload(s, a, '양식.hwp', 'FORM-OLD')
    const id = await create(s, a, { attachmentIds: [form], scope: { type: 'members', memberIds: [b.memberId] } })
    const f = await upload(s, b, '제출.hwp', 'SUBMITTED-OLD')
    expect((await call(b, 'PUT', `/api/collects/${id}/submission`, { attachmentIds: [f] })).statusCode).toBe(200)
    s.ctx.db.run('UPDATE attachments SET created_at = ? WHERE id IN (?, ?)', [Date.now() - 400 * DAY, form, f])
    expect(runMessageFileRetention(s.ctx, Date.now() + 400 * DAY).files).toBe(0)
    expect((await call(a, 'GET', `/api/attachments/${f}`)).rawPayload.toString()).toBe('SUBMITTED-OLD')
    expect((await call(b, 'GET', `/api/attachments/${form}`)).rawPayload.toString()).toBe('FORM-OLD')

    const root = mkdtempSync(join(tmpdir(), 'teamhub-collect-backup-'))
    try {
      runBackup(s.ctx, root)
      for (const att of [form, f]) {
        const p = s.ctx.db.get<{ path: string }>('SELECT b.path FROM attachments a JOIN blobs b ON b.id = a.blob_id WHERE a.id = ?', [att])!.path
        expect(existsSync(join(root, 'blobs', p))).toBe(true)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
