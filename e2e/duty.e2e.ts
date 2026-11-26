import { describe, it, expect, afterAll } from 'vitest'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47917'
const SHOTS = process.env.TEAMHUB_SHOT_DIR

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

const WEEKDAYS = '일월화수목금토'
/** "2026. 11. 26.(목)", as on the report */
const reportDate = (d: Date): string => `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.(${WEEKDAYS[d.getDay()]})`

describe('근무현황: who is away today, by department', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup', async () => {
    a = await launch({ profile: 'e2e-dutya' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-dutyb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    a.page.on('dialog', (d) => void d.accept())
    b.page.on('dialog', (d) => void d.accept())
  }, 90000)

  it('a member records a trip for today; the admin sees it at once', async () => {
    await go(a.page, '/duty')
    await expect.poll(() => a.page.getByTestId('duty-summary').textContent(), { timeout: 15000 }).toContain('총원 2')
    expect(await a.page.getByTestId('duty-row').count()).toBe(0)

    await b.page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '근무현황', exact: true }).click()
    await b.page.getByRole('button', { name: '사고 신청' }).click()
    const dlg = b.page.getByTestId('duty-dialog')
    await dlg.getByRole('radio', { name: '출장' }).click()
    await dlg.getByLabel('행선지').fill('도청E2E')
    await b.page.getByRole('button', { name: '올리기', exact: true }).click()
    await expect.poll(() => b.page.getByTestId('duty-row').count(), { timeout: 10000 }).toBe(1)

    // realtime on the admin's screen
    await expect.poll(() => a.page.getByTestId('duty-row').count(), { timeout: 15000 }).toBe(1)
    const row = await a.page.getByTestId('duty-row').textContent()
    expect(row).toContain('팀원B')
    expect(row).toContain('출장')
    expect(row).toContain('종일')
    expect(row).toContain('도청E2E')
    const sum = await a.page.getByTestId('duty-summary').textContent()
    expect(sum).toContain('현재원 1')
    expect(sum).toContain('사고 1')
  }, 60000)

  it('home widget 오늘 부재자 lists the absence by 소속 and leads to 근무현황', async () => {
    await go(b.page, '/home')
    const w = b.page.getByTestId('widget-absent')
    await expect.poll(() => w.textContent(), { timeout: 15000 }).toContain('팀원B')
    const text = await w.textContent()
    expect(text).toContain('출장')
    expect(text).toContain('도청E2E')
    expect(text).toContain('1명')
    expect(await w.getByTestId('absent-row').count()).toBe(1)
    // the admin's home shows the same
    await go(a.page, '/home')
    await expect.poll(() => a.page.getByTestId('widget-absent').textContent(), { timeout: 15000 }).toContain('도청E2E')
    await shot(a.page, 'duty-home-widget')
    // it can be hidden like the other widgets
    await a.page.getByRole('button', { name: '위젯 편집' }).click()
    await a.page.getByRole('button', { name: '오늘 부재자 숨기기' }).click()
    expect(await a.page.getByTestId('widget-absent').count()).toBe(0)
    await a.page.getByRole('button', { name: '오늘 부재자 보이기' }).click()
    await a.page.getByRole('button', { name: '편집 완료' }).click()
    await w.getByRole('button', { name: '근무현황' }).click()
    await expect.poll(() => b.page.evaluate(() => window.location.hash)).toContain('/duty')
    await go(a.page, '/duty')
    await expect.poll(() => a.page.getByTestId('duty-row').count(), { timeout: 15000 }).toBe(1)
  }, 60000)

  it('the admin records for the member; the member deletes it', async () => {
    await a.page.getByRole('button', { name: '대신 신청' }).click()
    const dlg = a.page.getByTestId('duty-dialog')
    await dlg.getByRole('radio', { name: '교육' }).click()
    await dlg.getByRole('button', { name: /오후/ }).click()
    await a.page.getByRole('button', { name: '올리기', exact: true }).click()
    await expect.poll(() => b.page.getByTestId('duty-row').count(), { timeout: 15000 }).toBe(2)
    const edu = b.page.getByTestId('duty-row').filter({ hasText: '교육' })
    expect(await edu.textContent()).toContain('14:00~18:00')
    expect(await edu.textContent()).toContain('서버관리자 대신 신청')
    // a plain member has no "대신 올리기"
    expect(await b.page.getByRole('button', { name: '대신 신청' }).count()).toBe(0)
    await edu.getByRole('button', { name: /지우기/ }).click()
    await expect.poll(() => a.page.getByTestId('duty-row').count(), { timeout: 15000 }).toBe(1)
  }, 60000)

  it('the daily report: totals and the people away, ready to print', async () => {
    await a.page.getByRole('tab', { name: '일별' }).click()
    await a.page.getByRole('button', { name: '보고서 인쇄' }).click()
    const r = a.page.getByTestId('duty-report')
    await r.waitFor({ timeout: 10000 })
    const text = (await r.textContent()) ?? ''
    expect(text).toContain(`일일 근무상황 보고 (${reportDate(new Date())})`)
    expect(text).toContain('작성 시각')
    expect(text).toContain('작성자서버관리자')
    expect(text).toContain('1. 인원 총괄')
    expect(text).toContain('2. 사고자 명단')
    // 계: 총원 2, 현재원 1, 사고 1 (출장 1)
    const sum = await r.getByTestId('duty-report-totals').locator('tbody tr').first().locator('td').allTextContents()
    expect(sum.slice(0, 5)).toEqual(['계', '2', '1', '1', '1'])
    const rows = r.getByTestId('duty-report-row')
    expect(await rows.count()).toBe(1)
    const row = await rows.locator('td').allTextContents()
    expect(row).toContain('팀원B')
    expect(row).toContain('출장')
    expect(row).toContain('종일')
    expect(row).toContain('도청E2E')
    await shot(a.page, 'duty-report')
    // 인쇄: only the report goes to the printer (the rest of the page is hidden while printing)
    await a.page.evaluate(() => {
      const w = window as unknown as { __printed: number; print: () => void }
      w.__printed = 0
      w.print = () => {
        w.__printed = document.documentElement.classList.contains('duty-printing') ? 1 : -1
      }
    })
    await a.page.getByRole('dialog').getByRole('button', { name: '인쇄' }).click()
    expect(await a.page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1)
    expect(await a.page.locator('.duty-print-root .duty-sheet').count()).toBe(1)
    expect(await a.page.locator('.duty-print-root').textContent()).toContain('도청E2E')
    await a.page.getByRole('dialog').getByRole('button', { name: '닫기' }).first().click()
    await expect.poll(() => a.page.locator('.duty-print-root').count()).toBe(0)
    expect(await a.page.evaluate(() => document.documentElement.classList.contains('duty-printing'))).toBe(false)
  }, 60000)

  it('week view, monthly record and the calendar show the same absence', async () => {
    await a.page.getByRole('tab', { name: '주간' }).click()
    await expect.poll(() => a.page.getByTestId('duty-week').textContent(), { timeout: 10000 }).toContain('출장')
    await a.page.getByRole('tab', { name: '기록' }).click()
    await expect.poll(() => a.page.getByTestId('duty-list').textContent(), { timeout: 10000 }).toContain('도청E2E')
    await go(a.page, '/calendar')
    await expect.poll(() => a.page.getByText('[출장] 팀원B').count(), { timeout: 15000 }).toBeGreaterThanOrEqual(1)
  }, 60000)

  it('the admin names a 대리 등록자, who may then record for others', async () => {
    await go(a.page, '/duty')
    await a.page.getByRole('button', { name: '대리 등록자 지정' }).click()
    await a.page.getByRole('checkbox', { name: '팀원B' }).check()
    await a.page.getByRole('button', { name: '저장' }).click()
    await expect.poll(() => b.page.getByRole('button', { name: '대신 신청' }).count(), { timeout: 15000 }).toBe(1)
  }, 60000)

  it('public holidays show in the day, week and month views', async () => {
    await go(a.page, '/duty')
    await a.page.getByRole('tab', { name: '일별' }).click()
    await a.page.getByLabel('날짜 고르기').fill('2026-12-25')
    await expect.poll(() => a.page.getByTestId('duty-holiday').textContent(), { timeout: 10000 }).toBe('성탄절')
    expect(await a.page.getByTestId('duty-summary').textContent()).toContain('성탄절')
    // a 연가 over Christmas, so the week has an absence next to the holiday
    await a.page.getByLabel('날짜 고르기').fill('2026-12-24')
    expect(await a.page.getByTestId('duty-holiday').count()).toBe(0)
    await a.page.getByRole('button', { name: '사고 신청' }).click()
    const dlg = a.page.getByTestId('duty-dialog')
    await dlg.getByRole('radio', { name: '연가' }).click()
    await dlg.getByLabel('끝', { exact: true }).fill('2026-12-28')
    await a.page.getByRole('button', { name: '올리기', exact: true }).click()
    await expect.poll(() => a.page.getByTestId('duty-row').count(), { timeout: 10000 }).toBe(1)

    await a.page.getByRole('tab', { name: '주간' }).click()
    const head = a.page.getByTestId('duty-week').locator('thead th[data-holiday]')
    await expect.poll(() => head.count(), { timeout: 10000 }).toBe(1)
    expect(await head.getAttribute('data-holiday')).toBe('성탄절')
    expect(await head.textContent()).toContain('12/25')
    expect(await a.page.getByTestId('duty-week').textContent()).toContain('연가')
    await shot(a.page, 'duty-week-holiday')

    await a.page.getByRole('tab', { name: '기록' }).click()
    await expect.poll(() => a.page.getByTestId('duty-month-holidays').textContent(), { timeout: 10000 }).toContain('12. 25.(금) 성탄절')
    // September 2026: 추석 연휴 (lunar), 9/24~9/26
    await a.page.getByLabel('날짜 고르기').fill('2026-09-10')
    await expect.poll(() => a.page.getByTestId('duty-month-holidays').textContent(), { timeout: 10000 }).toContain('9. 25.(금) 추석')
  }, 60000)
})
