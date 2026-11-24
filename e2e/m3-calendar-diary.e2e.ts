import { describe, it, expect, afterAll } from 'vitest'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47896'
const pad = (n: number) => String(n).padStart(2, '0')
const localInput = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function newEvent(page: Page, o: { kind: '개인 일정' | '공유 일정'; title: string; start: number; end: number; repeat?: string; reminder?: string }): Promise<void> {
  await go(page, '/calendar')
  await page.getByRole('button', { name: '새 일정' }).click()
  const dlg = page.getByRole('dialog', { name: '새 일정' })
  await dlg.getByRole('radio', { name: new RegExp(o.kind) }).click()
  await dlg.getByLabel('일정 제목').fill(o.title)
  await dlg.getByLabel('시작').fill(localInput(o.start))
  await dlg.getByLabel('끝', { exact: true }).fill(localInput(o.end))
  if (o.repeat) await dlg.getByLabel('반복', { exact: true }).selectOption(o.repeat)
  // default reminder is "10분 전"; switch to the requested one
  if (o.reminder) {
    await dlg.getByRole('button', { name: '10분 전' }).click()
    await dlg.getByRole('button', { name: o.reminder }).click()
  }
  await dlg.getByRole('button', { name: '저장' }).click()
  await dlg.waitFor({ state: 'detached', timeout: 10000 })
}

describe('M3 calendar, reminders, diary, worklogs', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup', async () => {
    a = await launch({ profile: 'e2e-m3a' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-m3b' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
  })

  it('shared recurring event appears for the member', async () => {
    const t = new Date()
    const start = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 15, 0).getTime()
    await newEvent(a.page, { kind: '공유 일정', title: '주간회의E2E', start, end: start + 3600000, repeat: 'weekly' })
    await go(b.page, '/calendar')
    await expect.poll(() => b.page.getByTestId('calendar').getByText('주간회의E2E').count(), { timeout: 15000 }).toBeGreaterThanOrEqual(2)
  })

  it('personal event reminder fires while the window is hidden', async () => {
    const start = Date.now() + 10 * 60000 + 25000
    await newEvent(b.page, { kind: '개인 일정', title: '개인알림E2E', start, end: start + 1800000 })
    expect(await b.page.getByTestId('calendar').getByText('개인알림E2E').count()).toBeGreaterThanOrEqual(1)
    await b.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
    await expect
      .poll(() => b.app.evaluate(() => ((globalThis as unknown as { __teamhubFired: { body: string }[] }).__teamhubFired ?? []).map((r) => r.body).join('|')), { timeout: 60000, interval: 2000 })
      .toContain('개인알림E2E')
    await b.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
  }, 90000)

  it('worklog shared with the team is visible to the admin', async () => {
    await go(b.page, '/diary')
    await b.page.getByRole('button', { name: '업무일지' }).click()
    await b.page.getByRole('textbox', { name: '오늘 한 일' }).click()
    await b.page.keyboard.type('E2E 보고서 작성')
    await b.page.getByRole('button', { name: '업무일지 저장' }).click()
    await expect.poll(() => b.page.getByTestId('worklog-status').textContent()).toContain('저장했습니다')
    await go(a.page, '/diary')
    await a.page.getByRole('button', { name: '업무일지' }).click()
    await a.page.getByRole('button', { name: /팀 업무일지/ }).click()
    await expect.poll(() => a.page.getByText('E2E 보고서 작성').count(), { timeout: 10000 }).toBe(1)
  })

  it('with the server stopped, personal events and diary still work', async () => {
    await a.close({ keepData: true })
    await expect.poll(() => b.page.getByTestId('conn-state').textContent(), { timeout: 20000 }).toContain('끊김')
    // diary write
    await go(b.page, '/diary')
    await b.page.getByRole('button', { name: '다이어리', exact: true }).click()
    await b.page.getByRole('textbox', { name: '다이어리 본문' }).click()
    await b.page.keyboard.type('서버 없이 쓴 다이어리')
    await expect.poll(() => b.page.getByTestId('diary-status').textContent(), { timeout: 5000 }).toContain('저장됨')
    // personal event write
    const start = Date.now() + 2 * 3600000
    await newEvent(b.page, { kind: '개인 일정', title: '오프라인일정', start, end: start + 3600000 })
    expect(await b.page.getByTestId('calendar').getByText('오프라인일정').count()).toBeGreaterThanOrEqual(1)
    // persists across restart
    await b.close({ keepData: true })
    b = await launch({ profile: 'e2e-m3b', userData: b.userData })
    // last known org/name are shown even though the server is offline (13.11)
    await expect.poll(() => b.page.getByTestId('org-text').textContent(), { timeout: 10000 }).toBe('E2E기관 검증팀')
    await go(b.page, '/diary')
    await b.page.getByRole('button', { name: '다이어리', exact: true }).click()
    await expect.poll(() => b.page.getByRole('textbox', { name: '다이어리 본문' }).textContent(), { timeout: 10000 }).toContain('서버 없이 쓴 다이어리')
  }, 120000)
})
