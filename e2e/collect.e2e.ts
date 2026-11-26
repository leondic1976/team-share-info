import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'
import { readStoredZip } from '../src/node/zip'

const PORT = '47967'
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = process.env.TEAMHUB_SHOT_DIR
const TITLE = '예산 요구서E2E'

/** With TEAMHUB_SHOT_DIR set: a screenshot in the light and in the dark theme. */
async function shot(p: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await p.waitForTimeout(400)
  await p.screenshot({ path: `${SHOTS}/${name}-light.png` })
  await p.evaluate(() => document.documentElement.classList.add('dark'))
  await p.waitForTimeout(300)
  await p.screenshot({ path: `${SHOTS}/${name}-dark.png` })
  await p.evaluate(() => document.documentElement.classList.remove('dark'))
}

const toasts = (l: Launched): Promise<{ title: string; body: string; route?: string }[]> =>
  l.app.evaluate(() => (globalThis as unknown as { __teamhubToasts?: { title: string; body: string; route?: string }[] }).__teamhubToasts ?? [])

interface Cred {
  deviceId: string
  deviceKey: string
  winUser: string
}

/** A third member without a PC of its own in this test: joins over HTTP, the server PC approves it on screen. */
async function joinOverHttp(admin: Page, name: string): Promise<Cred> {
  const winUser = 'e2e-collect-c'
  const r = await fetch(`${BASE}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Protocol': '1' },
    body: JSON.stringify({ name, deptName: '총무팀', pcName: 'PC-COLLECT-C', winUser, appVersion: '0.1.0' })
  })
  const { requestId, pollToken } = ((await r.json()) as { data: { requestId: string; pollToken: string } }).data
  await go(admin, '/admin/approvals')
  await admin.getByTestId('join-request').filter({ hasText: name }).getByRole('button', { name: '승인' }).click()
  let d: { state: string; deviceId?: string; deviceKey?: string } = { state: 'pending' }
  for (let i = 0; i < 50 && d.state !== 'approved'; i++) {
    const p = await fetch(`${BASE}/api/join/${requestId}?token=${pollToken}`, { headers: { 'X-Protocol': '1' } })
    d = ((await p.json()) as { data: typeof d }).data
    if (d.state !== 'approved') await new Promise((res) => setTimeout(res, 200))
  }
  expect(d.state).toBe('approved')
  return { deviceId: d.deviceId!, deviceKey: d.deviceKey!, winUser }
}

const asMember = (c: Cred, method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })

describe('자료 취합: request with a 양식, alert, submit, 제출 현황, 다시 알림, ZIP', () => {
  let a: Launched
  let b: Launched
  let c: Cred
  let id = ''
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup: server A, member B on a PC, member C without one', async () => {
    a = await launch({ profile: 'e2e-cola' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-colb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    c = await joinOverHttp(a.page, '팀원C')
  }, 150000)

  it('A asks B and C for a file by a deadline, with a 양식 file', async () => {
    await go(a.page, '/collect')
    await a.page.getByRole('button', { name: '새 요청' }).click()
    const dlg = a.page.getByRole('dialog', { name: '새 자료 취합 요청' })
    await dlg.getByLabel('제목', { exact: true }).fill(TITLE)
    await dlg.getByLabel('설명', { exact: true }).fill('첨부한 양식에 맞춰 담당별로 작성해 주세요.')
    await dlg.getByLabel('첨부 파일 선택').setInputFiles({ name: '예산요구서_양식.hwp', mimeType: 'application/octet-stream', buffer: Buffer.from('FORM-CONTENT') })
    await expect.poll(() => dlg.getByText('예산요구서_양식.hwp').count(), { timeout: 15000 }).toBe(1)
    await dlg.getByRole('radio', { name: '지정한 사람' }).click()
    await dlg.getByLabel('팀원B').check()
    await dlg.getByLabel('팀원C').check()
    await shot(a.page, 'collect-create')
    await dlg.getByRole('button', { name: '요청 보내기' }).click()
    await a.page.getByTestId('collect-status').waitFor({ timeout: 15000 })
    id = (await a.page.evaluate(() => window.location.hash)).split('/').pop() ?? ''
    expect(id.length).toBeGreaterThan(10)
    await expect.poll(() => a.page.getByTestId('collect-count-미제출').textContent(), { timeout: 10000 }).toContain('2')
    expect(await a.page.getByTestId('collect-status-row').count()).toBe(2)
  }, 60000)

  it('B gets the alert card and the menu count, opens the request and saves the 양식', async () => {
    await expect
      .poll(async () => (await toasts(b)).filter((t) => t.title === '자료 제출 요청 · 서버관리자').map((t) => `${t.body}>${t.route}`), { timeout: 15000 })
      .toEqual([expect.stringMatching(new RegExp(`^“${TITLE}” .*까지 \\(.+ 남음\\)>/collect/${id}$`))])
    await expect.poll(() => b.page.getByRole('link', { name: '자료 취합 (1)' }).count(), { timeout: 15000 }).toBe(1)
    await go(b.page, '/collect')
    await b.page.getByTestId('collect-row').filter({ hasText: TITLE }).waitFor({ timeout: 10000 })
    expect(await b.page.getByRole('tab', { name: /해야 할 것/ }).getAttribute('aria-selected')).toBe('true')
    await shot(b.page, 'collect-list')
    await b.page.getByTestId('collect-row').filter({ hasText: TITLE }).click()
    const forms = b.page.getByTestId('collect-forms')
    await forms.waitFor({ timeout: 10000 })
    await forms.getByRole('button', { name: '저장' }).click()
    await forms.getByTestId('file-chip-done').waitFor({ timeout: 15000 })
    expect(readFileSync(join(b.userData, 'downloads', '예산요구서_양식.hwp'), 'utf8')).toBe('FORM-CONTENT')
    // B does not see the others' 제출 현황
    expect(await b.page.getByTestId('collect-status').count()).toBe(0)
  }, 60000)

  it('B hands in a file; A sees 제출 at once', async () => {
    const form = b.page.getByTestId('collect-submit-form')
    await form.getByLabel('첨부 파일 선택').setInputFiles({ name: '예산요구서_팀원B.hwp', mimeType: 'application/octet-stream', buffer: Buffer.from('B-ANSWER') })
    await expect.poll(() => form.getByText('예산요구서_팀원B.hwp').count(), { timeout: 15000 }).toBe(1)
    await shot(b.page, 'collect-submit')
    await form.getByRole('button', { name: '제출', exact: true }).click()
    await b.page.getByTestId('collect-mine').waitFor({ timeout: 15000 })
    expect(await b.page.getByTestId('collect-submit').textContent()).toContain('제출')
    await expect.poll(() => b.page.getByRole('link', { name: '자료 취합 (1)' }).count(), { timeout: 15000 }).toBe(0)
    await expect.poll(() => a.page.locator('[data-testid="collect-status-row"][data-status="submitted"]').textContent(), { timeout: 15000 }).toContain('팀원B')
    expect(await a.page.getByTestId('collect-count-제출').textContent()).toContain('1')
  }, 60000)

  it('다시 알림 goes to who has not handed in (C, not connected); then C marks 해당 없음', async () => {
    const before = (await toasts(b)).length
    await a.page.getByRole('button', { name: '미제출자에게 다시 알림' }).click()
    await expect.poll(() => a.page.getByTestId('collect-msg').textContent(), { timeout: 10000 }).toContain('1명에게 다시 알렸습니다.')
    expect(await a.page.getByTestId('collect-msg').textContent()).toContain('지금 접속하지 않은 1명은 접속하면 알림을 받습니다.')
    // C gets the card when it connects
    const pending = (await (await asMember(c, 'GET', '/api/collects/pending')).json()) as { data: { id: string }[] }
    expect(pending.data.map((x) => x.id)).toEqual([id])
    // B, who handed in, gets nothing
    await a.page.waitForTimeout(1000)
    expect((await toasts(b)).length).toBe(before)
    const na = await asMember(c, 'POST', `/api/collects/${id}/na`, { reason: '해당 사업 없음' })
    expect(na.status).toBe(200)
    await expect.poll(() => a.page.locator('[data-testid="collect-status-row"][data-status="na"]').textContent(), { timeout: 15000 }).toContain('해당 사업 없음')
    await shot(a.page, 'collect-status')
  }, 60000)

  it('A downloads everything as one ZIP: <부서>_<이름>_<파일> and the 제출 현황', async () => {
    await a.page.getByRole('button', { name: '한꺼번에 내려받기 (ZIP)' }).click()
    await a.page.getByTestId('collect-saved').waitFor({ timeout: 15000 })
    const dir = join(a.userData, 'downloads')
    const zipName = readdirSync(dir).find((f) => f.startsWith('자료취합_') && f.endsWith('.zip'))
    expect(zipName).toMatch(new RegExp(`^자료취합_${TITLE}_\\d{8}\\.zip$`))
    const entries = readStoredZip(readFileSync(join(dir, zipName!)))
    expect(entries.map((e) => e.name)).toEqual(['부서없음_팀원B_예산요구서_팀원B.hwp', '제출현황.csv'])
    expect(entries[0].data.toString()).toBe('B-ANSWER')
    const csv = entries[1].data.toString('utf8')
    expect(csv).toContain('팀원B,,제출,')
    expect(csv).toContain('총무팀,팀원C,,해당 없음,')
    expect(csv).toContain('해당 사업 없음')
    // the list alone, as CSV
    await a.page.getByRole('button', { name: '목록 저장 (CSV)' }).click()
    await expect.poll(() => readdirSync(dir).some((f) => f.endsWith('_제출현황.csv')), { timeout: 15000 }).toBe(true)
    const list = readdirSync(dir).find((f) => f.endsWith('_제출현황.csv'))!
    expect(existsSync(join(dir, list))).toBe(true)
    expect(readFileSync(join(dir, list), 'utf8')).toBe(csv)
  }, 60000)
})
