import { describe, it, expect, afterEach } from 'vitest'
import { FEEDBACK_RETRY_MS, FEEDBACK_WEEK_MS, NO_KEY, bundleText, makeBundles, nextBundleAt, runFeedbackJob, storeItem, uploadBundles } from '../../src/server/feedback'
import { parseBundleText, type FeedbackItem } from '../../src/shared/schemas/feedback'
import { createTestServer, type Cred, type TestServer } from './helpers'
import { FAKE_KEYS, startFakeGithub, type FakeGithub } from './fake-github'

const IP = '192.168.10.20'
const SERVER_ID = 'WXYZ-2345-6789'
const DAY = 86_400_000
const uuid = (n: number): string => `${String(n).padStart(8, '0')}-2222-4333-8444-555555555555`
const item = (n = 1, over: Partial<FeedbackItem> = {}): FeedbackItem => ({
  kind: 'bug',
  title: `인터넷 없는 PC에서 보냄 ${n}`,
  body: '서버 PC에 접수되고 주 1회 묶여 나가야 합니다.',
  author: '',
  installId: 'ABCD-EFGH-JKLM',
  submissionId: uuid(n),
  createdAt: new Date().toISOString(),
  ...over
})

let s: TestServer | null = null
let gh: FakeGithub | null = null
afterEach(async () => {
  await s?.close()
  s = null
  await gh?.close()
  gh = null
})

const post = (c: Cred | null, payload: unknown): ReturnType<TestServer['req']> => s!.req(c, { method: 'POST', url: '/api/feedback', ip: IP, payload: payload as object })
/** as if the posts of this member had come in `ms` ago (1 a minute, 10 a day are counted from the time kept) */
const age = (ms: number): void => void s!.ctx.db.run('UPDATE feedback_items SET received_at = received_at - ?', [ms])
const withKey = (api: string): void => void (s!.ctx.feedback = { creds: { appId: FAKE_KEYS.appId, privateKey: FAKE_KEYS.pem, installationId: '77' }, api, serverId: SERVER_ID })
const states = (): string[] => s!.ctx.db.all<{ state: string }>('SELECT state FROM feedback_items ORDER BY id').map((r) => r.state)
const bundles = (): { id: string; state: string; tries: number; last_error: string | null; issue_number: number | null; item_count: number }[] =>
  s!.ctx.db.all('SELECT id, state, tries, last_error, issue_number, item_count FROM feedback_bundles ORDER BY created_at, id')

describe('feedback, hop 1: a member PC hands a post to the server PC', () => {
  it('keeps a valid post, answers the same post once, and shows a member only the own posts', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C', { ip: '192.168.10.21' })
    expect((await post(null, item())).statusCode).toBe(401)
    const r = await post(b, item(1, { author: '총무팀 김', app: { version: '1.7.2', os: 'Windows 10.0.26100' } }))
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({ id: uuid(1), receipt: 'TH-00000001', kind: 'bug', state: 'received', bundleId: null })
    // sent again (the answer got lost): kept once, no "one a minute" refusal
    expect((await post(b, item(1))).json().data.id).toBe(uuid(1))
    expect(s.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM feedback_items')!.n).toBe(1)
    // the id of somebody else's post says nothing about it
    expect((await post(c, item(1))).statusCode).toBe(409)

    expect((await s.req(b, { method: 'GET', url: '/api/feedback/mine', ip: IP })).json().data).toHaveLength(1)
    expect((await s.req(c, { method: 'GET', url: '/api/feedback/mine', ip: '192.168.10.21' })).json().data).toEqual([])
    expect((await s.req(null, { method: 'GET', url: '/api/feedback/mine', ip: IP })).statusCode).toBe(401)
    // recorded without the text
    const log = s.ctx.db.all<{ action: string; detail: string | null }>(`SELECT action, detail FROM activity_logs WHERE action LIKE 'feedback.%'`)
    expect(log).toEqual([{ action: 'feedback.receive', detail: '{"kind":"bug"}' }])
  })

  it('refuses what is not exactly the defined form, and what is too large', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    for (const bad of [
      { ...item(), installId: 'x' },
      { ...item(), memberId: b.memberId },
      { ...item(), title: 'x' },
      { ...item(), body: 'bell \u0007 rings' },
      { ...item(), title: 'safe\u202Eexe.txt' },
      { ...item(), submissionId: 'TH-ABCDEFGH' },
      { ...item(), createdAt: '2026-11-20' },
      { ...item(), app: { version: '1.7.2', os: 'Windows 10', pcName: 'PC-B' } },
      { schema: 1, ...item() },
      [item()]
    ])
      expect((await post(b, bad)).statusCode).toBe(400)
    expect((await post(b, { ...item(), body: 'x'.repeat(70000) })).statusCode).toBe(413)
    expect(s.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM feedback_items')!.n).toBe(0)
  })

  it('one post a minute and ten a day for a member', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C', { ip: '192.168.10.21' })
    expect((await post(b, item(1))).statusCode).toBe(200)
    const soon = await post(b, item(2))
    expect(soon.statusCode).toBe(400)
    expect(soon.json().error.message).toContain('1분 뒤')
    for (let n = 2; n <= 10; n++) {
      age(61_000)
      expect((await post(b, item(n))).statusCode).toBe(200)
    }
    age(61_000)
    const many = await post(b, item(11))
    expect(many.statusCode).toBe(400)
    expect(many.json().error.message).toContain('하루에 10건')
    // another member is not held back by that
    expect((await post(c, item(12))).statusCode).toBe(200)
    age(DAY)
    expect((await post(b, item(11))).statusCode).toBe(200)
  })

  it('a program older than the weekly bundles (relay) is still answered: its post is kept, not passed on', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    expect((await s.req(b, { method: 'GET', url: '/api/feedback/relay', ip: IP })).json().data).toEqual({ available: true })
    const old = { id: 'TH-ABCDEFGH', kind: 'bug', title: '예전 프로그램에서  보냄', body: '서버 PC가 받아 두어야 합니다.\r\n둘째 줄', author: '', environment: 'TeamHub 1.7.2 · Windows 10.0.26100', installId: 'ABCD-EFGH-JKLM' }
    const r = await s.req(b, { method: 'POST', url: '/api/feedback/relay', ip: IP, payload: old })
    expect(r.json().data).toEqual({ ok: true, number: 1 })
    // the same receipt number again: kept once
    expect((await s.req(b, { method: 'POST', url: '/api/feedback/relay', ip: IP, payload: { ...old, retry: true } })).json().data.ok).toBe(true)
    const rows = s.ctx.db.all<{ title: string; body: string; app_version: string; os: string; state: string }>('SELECT title, body, app_version, os, state FROM feedback_items')
    expect(rows).toEqual([{ title: '예전 프로그램에서 보냄', body: '서버 PC가 받아 두어야 합니다.\n둘째 줄', app_version: '1.7.2', os: 'Windows 10.0.26100', state: 'received' }])
    expect((await s.req(b, { method: 'POST', url: '/api/feedback/relay', ip: IP, payload: { ...old, installId: 'x' } })).statusCode).toBe(400)
    expect((await s.req(null, { method: 'GET', url: '/api/feedback/relay', ip: IP })).statusCode).toBe(401)
  })
})

describe('feedback: what the administrators see and do', () => {
  it('최종관리자 and 서무 read and remove; a member does not; only the 최종관리자 sends out', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const clerk = await s.join('C', { ip: '192.168.10.21' })
    expect((await s.req(s.admin, { method: 'PATCH', url: `/api/admin/members/${clerk.memberId}`, payload: { role: 'admin' } })).statusCode).toBe(200)
    await post(b, item(1))
    age(61_000)
    await post(b, item(2, { kind: 'feature' }))

    expect((await s.req(b, { method: 'GET', url: '/api/admin/feedback', ip: IP })).statusCode).toBe(403)
    for (const who of [s.admin, clerk]) {
      const d = (await s.req(who, { method: 'GET', url: '/api/admin/feedback', ip: who === clerk ? '192.168.10.21' : undefined })).json().data
      expect(d.items.map((i: { id: string; memberName: string; state: string }) => [i.id, i.memberName, i.state])).toEqual([
        [uuid(2), 'B', 'received'],
        [uuid(1), 'B', 'received']
      ])
      expect(d).toMatchObject({ bundles: [], canUpload: false })
      expect(d.nextBundleAt).toBeGreaterThan(Date.now())
    }
    // remove: by an administrator, until the post is in a bundle
    expect((await s.req(b, { method: 'DELETE', url: `/api/admin/feedback/items/${uuid(2)}`, ip: IP })).statusCode).toBe(403)
    expect((await s.req(clerk, { method: 'DELETE', url: `/api/admin/feedback/items/${uuid(2)}`, ip: '192.168.10.21' })).statusCode).toBe(200)
    expect((await s.req(clerk, { method: 'DELETE', url: `/api/admin/feedback/items/${uuid(2)}`, ip: '192.168.10.21' })).statusCode).toBe(404)

    // sending out of the organisation is the 최종관리자's
    const byClerk = await s.req(clerk, { method: 'POST', url: '/api/admin/feedback/send-now', ip: '192.168.10.21', payload: {} })
    expect(byClerk.statusCode).toBe(403)
    expect(byClerk.json().error.code).toBe('OWNER_ONLY')
    // the unique value of the server PC is not known yet: nothing is bundled
    const early = await s.req(s.admin, { method: 'POST', url: '/api/admin/feedback/send-now', payload: {} })
    expect(early.statusCode).toBe(400)
    expect(states()).toEqual(['received'])

    // no key built in: the bundle is made and waits; it can be saved as a file and marked as handed over
    s.ctx.feedback = { serverId: SERVER_ID }
    const now = (await s.req(s.admin, { method: 'POST', url: '/api/admin/feedback/send-now', payload: {} })).json().data
    expect(now).toMatchObject({ made: 1, uploaded: 0, failed: 0, waiting: 1, message: NO_KEY })
    expect(states()).toEqual(['bundled'])
    expect((await s.req(clerk, { method: 'DELETE', url: `/api/admin/feedback/items/${uuid(1)}`, ip: '192.168.10.21' })).statusCode).toBe(409)
    const [bundle] = bundles()
    expect(bundle).toMatchObject({ state: 'pending', tries: 0, last_error: NO_KEY, item_count: 1 })
    expect((await s.req(b, { method: 'GET', url: `/api/admin/feedback/bundles/${bundle.id}/file`, ip: IP })).statusCode).toBe(403)
    const file = (await s.req(clerk, { method: 'GET', url: `/api/admin/feedback/bundles/${bundle.id}/file`, ip: '192.168.10.21' })).json().data
    expect(file.name).toBe(`teamhub-feedback-${bundle.id}.json`)
    // the file is the very document GitHub would get: valid, and without anything about the organisation or the member
    const parsed = parseBundleText(file.text)
    expect(parsed).toMatchObject({ ok: true, skipped: 0 })
    expect(file.text).not.toMatch(/테스트기관|행정팀|192\.168|PC-B|user-B/)
    expect(file.text).not.toContain(b.memberId)
    expect(Object.keys(JSON.parse(file.text))).toEqual(['schema', 'type', 'bundleId', 'serverId', 'period', 'createdAt', 'app', 'items'])
    expect((await s.req(clerk, { method: 'POST', url: `/api/admin/feedback/bundles/${bundle.id}/delivered`, ip: '192.168.10.21', payload: {} })).statusCode).toBe(403)
    expect((await s.req(s.admin, { method: 'POST', url: `/api/admin/feedback/bundles/${bundle.id}/delivered`, payload: {} })).statusCode).toBe(200)
    expect((await s.req(s.admin, { method: 'POST', url: `/api/admin/feedback/bundles/${bundle.id}/delivered`, payload: {} })).statusCode).toBe(409)
    expect(bundles()[0]).toMatchObject({ state: 'uploaded', issue_number: null })
    expect(states()).toEqual(['uploaded'])
    // the member sees how far the post got
    expect((await s.req(b, { method: 'GET', url: '/api/feedback/mine', ip: IP })).json().data[0]).toMatchObject({ id: uuid(1), state: 'uploaded' })
    const actions = s.ctx.db.all<{ action: string }>(`SELECT action FROM activity_logs WHERE action LIKE 'feedback.%' ORDER BY at, rowid`).map((r) => r.action)
    expect(actions).toEqual(['feedback.receive', 'feedback.receive', 'feedback.delete', 'feedback.bundle', 'feedback.send-now', 'feedback.export', 'feedback.delivered'])
  })
})

describe('feedback, hop 2: the server PC hands the posts of a week to GitHub', () => {
  it('the weekly rule: seven days after the oldest waiting post / the last bundle, also after the server was off', async () => {
    gh = await startFakeGithub()
    s = await createTestServer()
    const b = await s.join('B')
    withKey(gh.url)
    const t0 = Date.now()
    expect(nextBundleAt(s.ctx)).toBeNull()
    await runFeedbackJob(s.ctx, t0)
    expect(bundles()).toEqual([])

    storeItem(s.ctx, b.memberId, item(1), t0)
    expect(nextBundleAt(s.ctx)).toBe(t0 + FEEDBACK_WEEK_MS)
    await runFeedbackJob(s.ctx, t0 + 6 * DAY)
    expect(states()).toEqual(['received'])
    expect(gh.issues).toHaveLength(0)

    // the server PC was off over the day it was due: the first run afterwards catches up
    const r = await runFeedbackJob(s.ctx, t0 + 9 * DAY)
    expect(r).toMatchObject({ uploaded: 1, failed: 0, waiting: 0 })
    expect(states()).toEqual(['uploaded'])
    expect(bundles()[0]).toMatchObject({ state: 'uploaded', issue_number: 1, item_count: 1, tries: 0, last_error: null })
    const sent = parseBundleText(gh.issues[0].body.replace(/^```json\n/, '').replace(/\n```\n$/, ''))
    expect(sent).toMatchObject({ ok: true, skipped: 0, value: { serverId: SERVER_ID, items: [{ submissionId: uuid(1), installId: 'ABCD-EFGH-JKLM' }] } })
    expect(gh.issues[0].labels).toEqual(['접수'])
    expect(gh.live.size).toBe(0)

    // the next bundle: seven days after this one, not before
    storeItem(s.ctx, b.memberId, item(2), t0 + 10 * DAY)
    expect(nextBundleAt(s.ctx)).toBe(t0 + 16 * DAY)
    await runFeedbackJob(s.ctx, t0 + 15 * DAY)
    expect(states()).toEqual(['uploaded', 'received'])
    await runFeedbackJob(s.ctx, t0 + 16 * DAY)
    expect(states()).toEqual(['uploaded', 'uploaded'])
    expect(gh.issues).toHaveLength(2)
    const logged = s.ctx.db.all<{ action: string }>(`SELECT action FROM activity_logs WHERE action LIKE 'feedback.%' ORDER BY at, rowid`).map((x) => x.action)
    expect(logged).toEqual(['feedback.bundle', 'feedback.upload', 'feedback.bundle', 'feedback.upload'])
  })

  it('a failed hand-over keeps everything and is tried again once a day, with the reason kept', async () => {
    gh = await startFakeGithub()
    s = await createTestServer()
    const b = await s.join('B')
    const t0 = Date.now()
    storeItem(s.ctx, b.memberId, item(1), t0)
    storeItem(s.ctx, b.memberId, item(2), t0 + 1)

    // no internet on the server PC
    withKey('http://127.0.0.1:9')
    const off = await runFeedbackJob(s.ctx, t0 + 7 * DAY)
    expect(off).toMatchObject({ uploaded: 0, failed: 1, waiting: 1 })
    expect(bundles()[0]).toMatchObject({ state: 'failed', tries: 1, issue_number: null, item_count: 2 })
    expect(bundles()[0].last_error).toContain('GitHub에 연결할 수 없습니다')
    expect(states()).toEqual(['bundled', 'bundled'])

    // an hour later: not yet (once a day), and no second bundle is made of the same posts
    withKey(gh.url)
    await runFeedbackJob(s.ctx, t0 + 7 * DAY + 3600_000)
    expect(gh.issues).toHaveLength(0)
    expect(bundles()).toHaveLength(1)

    // GitHub refuses the key (it was replaced): still nothing is lost
    gh.failAuth = 401
    await runFeedbackJob(s.ctx, t0 + 7 * DAY + FEEDBACK_RETRY_MS)
    expect(bundles()[0]).toMatchObject({ state: 'failed', tries: 2 })
    expect(bundles()[0].last_error).toContain('인증에 실패')
    expect(states()).toEqual(['bundled', 'bundled'])

    // the answer of GitHub gets lost: the bundle is not marked, and the next try finds the issue instead of making a second one
    gh.failAuth = 0
    gh.dropAnswer = true
    await runFeedbackJob(s.ctx, t0 + 7 * DAY + 2 * FEEDBACK_RETRY_MS)
    expect(gh.issues).toHaveLength(1)
    expect(bundles()[0]).toMatchObject({ state: 'failed', tries: 3, issue_number: null })
    gh.dropAnswer = false
    const ok = await runFeedbackJob(s.ctx, t0 + 7 * DAY + 3 * FEEDBACK_RETRY_MS)
    expect(ok).toMatchObject({ uploaded: 1, failed: 0, waiting: 0 })
    expect(gh.issues).toHaveLength(1)
    expect(bundles()[0]).toMatchObject({ state: 'uploaded', issue_number: 1, last_error: null })
    expect(states()).toEqual(['uploaded', 'uploaded'])
  })

  it('too much for one GitHub issue: several bundles, three a day at most', async () => {
    gh = await startFakeGithub()
    s = await createTestServer()
    const b = await s.join('B')
    withKey(gh.url)
    const t0 = Date.now()
    // nine posts of about 15 KB each: a bundle holds three of them (60,000 bytes)
    for (let n = 1; n <= 9; n++) storeItem(s.ctx, b.memberId, item(n, { body: '가'.repeat(4990) }), t0 + n)
    expect(makeBundles(s.ctx, t0 + 100)).toBe(3)
    expect(makeBundles(s.ctx, t0 + 200)).toBe(0)
    expect(bundles().map((x) => x.item_count)).toEqual([3, 3, 3])
    for (const x of bundles()) {
      const text = bundleText(s.ctx, x.id)!
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(60000)
      expect(`\`\`\`json\n${text}\n\`\`\`\n`.length).toBeLessThan(65536)
      expect(parseBundleText(text)).toMatchObject({ ok: true, skipped: 0 })
    }
    // a tenth, eleventh ... post: a fourth bundle on the same day would be refused by GitHub, so it waits here
    for (let n = 10; n <= 12; n++) storeItem(s.ctx, b.memberId, item(n, { body: '가'.repeat(4990) }), t0 + 300 + n)
    expect(makeBundles(s.ctx, t0 + 400)).toBe(1)
    const first = await uploadBundles(s.ctx, t0 + 500, true)
    expect(first).toMatchObject({ uploaded: 3, failed: 0, waiting: 1 })
    expect(first.message).toContain('하루에 3묶음')
    expect(gh.issues).toHaveLength(3)
    expect((await uploadBundles(s.ctx, t0 + 12 * 3600_000, true)).uploaded).toBe(0)
    const next = await uploadBundles(s.ctx, t0 + 26 * 3600_000)
    expect(next).toMatchObject({ uploaded: 1, waiting: 0, message: '' })
    expect(gh.issues).toHaveLength(4)
    expect(new Set(states())).toEqual(new Set(['uploaded']))
  })

  it('no key in the program: bundles wait with a neutral note; the owner can send as soon as there is one', async () => {
    gh = await startFakeGithub()
    s = await createTestServer()
    const b = await s.join('B')
    s.ctx.feedback = { serverId: SERVER_ID }
    const t0 = Date.now()
    storeItem(s.ctx, b.memberId, item(1), t0 - 8 * DAY)
    expect(await runFeedbackJob(s.ctx, t0)).toMatchObject({ uploaded: 0, failed: 0, waiting: 1, message: NO_KEY })
    expect(bundles()[0]).toMatchObject({ state: 'pending', tries: 0, last_error: NO_KEY })
    expect((await s.req(s.admin, { method: 'GET', url: '/api/admin/feedback' })).json().data).toMatchObject({ canUpload: false, bundles: [{ state: 'pending', lastError: NO_KEY }] })
    withKey(gh.url)
    const r = (await s.req(s.admin, { method: 'POST', url: '/api/admin/feedback/send-now', payload: {} })).json().data
    expect(r).toMatchObject({ made: 0, uploaded: 1, failed: 0, waiting: 0 })
    expect((await s.req(s.admin, { method: 'GET', url: '/api/admin/feedback' })).json().data).toMatchObject({ canUpload: true, bundles: [{ state: 'uploaded', issueNumber: 1, lastError: null }] })
  })
})
