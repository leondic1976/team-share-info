import { describe, it, expect, afterAll } from 'vitest'
import type { ElectronApplication, Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47902'

async function windowWith(app: ElectronApplication, frag: string, timeout = 30000): Promise<Page> {
  await expect.poll(() => app.windows().some((w) => w.url().includes(frag)), { timeout, interval: 500 }).toBe(true)
  const w = app.windows().find((x) => x.url().includes(frag))!
  await w.waitForLoadState('domcontentloaded')
  return w
}

const alarmsShown = (app: ElectronApplication): Promise<string> =>
  app.evaluate(() => ((globalThis as unknown as { __teamhubAlarms?: { title: string }[] }).__teamhubAlarms ?? []).map((a) => a.title).join('|'))

describe('M6-3 personal tools: memos, alarms, shared memos, team alarms', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup', async () => {
    a = await launch({ profile: 'e2e-m63a' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-m63b' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
  }, 90000)

  it('memo: write, tag, stick to the desktop and move', async () => {
    await go(b.page, '/memos')
    await b.page.getByRole('button', { name: '새 메모' }).click()
    await b.page.getByRole('textbox', { name: '메모 내용' }).click()
    await b.page.keyboard.type('스티커E2E 회신할 것')
    await b.page.getByLabel('태그').fill('전화')
    await expect.poll(() => b.page.getByText('저장됨').count(), { timeout: 10000 }).toBe(1)
    await expect.poll(() => b.page.getByTestId('memo-item').filter({ hasText: '스티커E2E' }).count()).toBe(1)
    await b.page.getByRole('button', { name: '바탕화면에 붙이기' }).click()
    const sticky = await windowWith(b.app, '/popup/sticky/')
    await expect.poll(() => sticky.getByTestId('sticky-window').textContent()).toContain('스티커E2E')
    await b.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/popup/sticky/'))!
      w.setBounds({ x: 160, y: 140, width: 300, height: 260 })
      w.emit('moved')
    })
    await b.page.waitForTimeout(800)
  })

  it('alarm: create a repeating alarm in the dialog', async () => {
    await go(b.page, '/alarms')
    await b.page.getByRole('button', { name: '알람 추가' }).click()
    const dlg = b.page.getByRole('dialog', { name: '알람 추가' })
    await dlg.getByLabel('알람 이름').fill('출근알람E2E')
    await dlg.getByRole('radio', { name: '반복' }).click()
    await dlg.getByLabel('시각').fill('08:50')
    await dlg.getByRole('button', { name: '저장' }).click()
    await dlg.waitFor({ state: 'detached' })
    await b.page.getByRole('tab', { name: '내 알람' }).click()
    await expect.poll(() => b.page.getByTestId('alarm-item').filter({ hasText: '출근알람E2E' }).textContent()).toContain('08:50')
  })

  it('a due alarm rings in a popup window and can be snoozed', async () => {
    await b.page.evaluate(() => window.teamhub.invoke('local:alarms.save', { title: '곧울림E2E', kind: 'once', fireAt: Date.now() + 3000 }))
    await expect.poll(() => alarmsShown(b.app), { timeout: 40000, interval: 1000 }).toContain('곧울림E2E')
    const pop = await windowWith(b.app, '/popup/alarm/')
    await expect.poll(() => pop.getByTestId('alarm-title').textContent()).toBe('곧울림E2E')
    await pop.getByRole('button', { name: '5분 뒤' }).click()
    await b.page.getByRole('tab', { name: '내 알람' }).click()
    await expect.poll(() => b.page.getByTestId('alarm-item').filter({ hasText: '곧울림E2E' }).textContent(), { timeout: 10000 }).toContain('다시 알림')
    // shows in "오늘 울릴 알림" as already rung
    await b.page.getByRole('tab', { name: '오늘 울릴 알림' }).click()
    await expect.poll(() => b.page.getByTestId('today-reminders').textContent()).toContain('곧울림E2E')
  }, 60000)

  it('team alarm: admin sends, member gets a popup and confirms; sender sees it', async () => {
    await go(a.page, '/alarms')
    await a.page.getByRole('tab', { name: '팀원 알람' }).click()
    await a.page.getByRole('checkbox', { name: '팀원B' }).check()
    await a.page.getByLabel('알람 내용').fill('14시 회의 자료 지참E2E')
    await a.page.getByRole('button', { name: '지금' }).click()
    await a.page.getByRole('button', { name: '보내기' }).click()
    await expect.poll(() => a.page.getByText(/1명에게/).count()).toBe(1)
    await expect.poll(() => alarmsShown(b.app), { timeout: 40000, interval: 1000 }).toContain('14시 회의 자료 지참E2E')
    // The server pushes right away (due now), so wait for the window to register.
    const pop = await windowWith(b.app, '/popup/alarm/')
    await expect.poll(() => pop.getByTestId('alarm-popup').textContent()).toContain('서버관리자님이 보낸 알람')
    await pop.getByRole('button', { name: '확인' }).click()
    await expect.poll(() => a.page.getByTestId('sent-alarms').textContent(), { timeout: 15000 }).toContain('확인')
  }, 70000)

  it('shared memo: left for the team and checked by the member', async () => {
    await go(a.page, '/memos')
    await a.page.getByRole('tab', { name: '공유 메모' }).click()
    await a.page.getByRole('button', { name: '공유 메모 남기기' }).click()
    const dlg = a.page.getByRole('dialog', { name: '공유 메모 남기기' })
    await dlg.getByLabel('공유 메모 내용').fill('민원실 전화 왔음E2E')
    await dlg.getByRole('button', { name: '남기기' }).click()
    await dlg.waitFor({ state: 'detached' })
    await go(b.page, '/memos')
    await b.page.getByRole('tab', { name: '공유 메모' }).click()
    const card = b.page.getByTestId('shared-memo').filter({ hasText: '민원실 전화 왔음E2E' })
    await card.getByRole('button', { name: '확인' }).click()
    await expect.poll(() => a.page.getByTestId('shared-memo').filter({ hasText: '민원실 전화 왔음E2E' }).textContent(), { timeout: 15000 }).toContain('팀원B 확인')
  })

  it('quick memo window saves a memo', async () => {
    await b.page.evaluate(() => window.teamhub.invoke('memo:quick', undefined as never))
    const q = await windowWith(b.app, '/popup/quickmemo')
    await q.locator('[contenteditable="true"]').click()
    await q.keyboard.type('빠른메모E2E')
    // Saving closes the window before the key is released.
    await q.keyboard.press('Control+Enter').catch(() => undefined)
    await go(b.page, '/memos')
    await b.page.getByRole('tab', { name: '내 메모' }).click()
    await expect.poll(() => b.page.getByTestId('memo-item').filter({ hasText: '빠른메모E2E' }).count(), { timeout: 10000 }).toBe(1)
  })

  it('calculation tools', async () => {
    await go(b.page, '/utilities')
    await b.page.getByRole('tab', { name: '계산 도구' }).click()
    await b.page.getByLabel('계산식').fill('1,200 × 3 + 10%')
    await expect.poll(() => b.page.getByTestId('calc-result').textContent()).toBe('= 3,600.1')
    await b.page.getByLabel('변환할 값').fill('84')
    await b.page.getByLabel('원래 단위').selectOption('m2')
    await b.page.getByLabel('바꿀 단위').selectOption('pyeong')
    await expect.poll(() => b.page.getByTestId('unit-result').textContent()).toBe('25.41')
  })

  it('after restart the sticky memo comes back at the same place and alarms are kept', async () => {
    const userData = b.userData
    await b.close({ keepData: true })
    b = await launch({ userData, profile: 'e2e-m63b' })
    const sticky = await windowWith(b.app, '/popup/sticky/')
    await expect.poll(() => sticky.getByTestId('sticky-window').textContent(), { timeout: 15000 }).toContain('스티커E2E')
    const bounds = await b.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/popup/sticky/'))!.getBounds())
    expect(bounds).toMatchObject({ x: 160, y: 140, width: 300, height: 260 })
    const main = b.app.windows().find((w) => !w.url().includes('/popup/'))!
    await main.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 20000 })
    await go(main, '/alarms')
    await main.getByRole('tab', { name: '내 알람' }).click()
    await expect.poll(() => main.getByTestId('alarm-list').textContent()).toContain('출근알람E2E')
    // the confirmed team alarm does not ring again
    await main.waitForTimeout(3000)
    expect(await alarmsShown(b.app)).not.toContain('14시 회의 자료 지참E2E')
    // closing the sticky takes it off the desktop but keeps the memo
    await sticky.getByRole('button', { name: '바탕화면에서 떼기' }).click()
    await go(main, '/memos')
    await expect.poll(() => main.getByTestId('memo-item').filter({ hasText: '스티커E2E' }).count()).toBe(1)
    await expect.poll(() => b.app.windows().filter((w) => w.url().includes('/popup/sticky/') && !w.isClosed()).length).toBe(0)
  }, 90000)
})
