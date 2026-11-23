import { describe, it, expect, afterAll } from 'vitest'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47917'

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
    await b.page.getByRole('button', { name: '내 근무상황 올리기' }).click()
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
    expect(sum).toContain('근무 1')
    expect(sum).toContain('부재 1')
  }, 60000)

  it('the admin records for the member; the member deletes it', async () => {
    await a.page.getByRole('button', { name: '대신 올리기' }).click()
    const dlg = a.page.getByTestId('duty-dialog')
    await dlg.getByRole('radio', { name: '교육' }).click()
    await dlg.getByRole('button', { name: /오후/ }).click()
    await a.page.getByRole('button', { name: '올리기', exact: true }).click()
    await expect.poll(() => b.page.getByTestId('duty-row').count(), { timeout: 15000 }).toBe(2)
    const edu = b.page.getByTestId('duty-row').filter({ hasText: '교육' })
    expect(await edu.textContent()).toContain('14:00~18:00')
    expect(await edu.textContent()).toContain('서버관리자 대신 올림')
    // a plain member has no "대신 올리기"
    expect(await b.page.getByRole('button', { name: '대신 올리기' }).count()).toBe(0)
    await edu.getByRole('button', { name: /지우기/ }).click()
    await expect.poll(() => a.page.getByTestId('duty-row').count(), { timeout: 15000 }).toBe(1)
  }, 60000)

  it('week view, monthly record and the calendar show the same absence', async () => {
    await a.page.getByRole('tab', { name: '주간' }).click()
    await expect.poll(() => a.page.getByTestId('duty-week').textContent(), { timeout: 10000 }).toContain('출장')
    await a.page.getByRole('tab', { name: '기록' }).click()
    await expect.poll(() => a.page.getByTestId('duty-list').textContent(), { timeout: 10000 }).toContain('도청E2E')
    await go(a.page, '/calendar')
    await expect.poll(() => a.page.getByText('[출장] 팀원B').count(), { timeout: 15000 }).toBeGreaterThanOrEqual(1)
  }, 60000)

  it('the admin names a 서무, who may then record for others', async () => {
    await go(a.page, '/duty')
    await a.page.getByRole('button', { name: '서무 지정' }).click()
    await a.page.getByRole('checkbox', { name: '팀원B' }).check()
    await a.page.getByRole('button', { name: '저장' }).click()
    await expect.poll(() => b.page.getByRole('button', { name: '대신 올리기' }).count(), { timeout: 15000 }).toBe(1)
  }, 60000)
})
