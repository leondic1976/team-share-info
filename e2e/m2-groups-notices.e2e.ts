import { describe, it, expect, afterAll } from 'vitest'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47895'

async function postNotice(page: Page, opts: { title: string; level?: '일반' | '중요' | '긴급'; group?: string; ack?: boolean; replies?: string }): Promise<void> {
  await go(page, '/notices')
  await page.getByRole('button', { name: '공지 쓰기' }).click()
  const dlg = page.getByRole('dialog', { name: '공지 쓰기' })
  if (opts.level && opts.level !== '일반') await dlg.getByRole('radio', { name: new RegExp(opts.level) }).click()
  if (opts.group) {
    await dlg.getByRole('radio', { name: '그룹' }).click()
    await dlg.getByLabel(`그룹 ${opts.group}`).check({ force: true })
  }
  await dlg.getByLabel('제목', { exact: true }).fill(opts.title)
  await dlg.getByRole('textbox', { name: '본문' }).click()
  await page.keyboard.type(`${opts.title} 본문입니다.`)
  if (opts.ack) {
    await dlg.getByText('받는 사람의 "확인" 받기').click()
    if (opts.replies) await dlg.getByLabel('회신 항목').fill(opts.replies)
  }
  await dlg.getByRole('button', { name: /게시|긴급 발송/ }).click()
  await page.getByTestId('notice-detail').waitFor({ timeout: 10000 })
}

describe('M2 groups, notices, urgent alerts', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('sets up server A and member B', async () => {
    a = await launch({ profile: 'e2e-m2a' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-m2b' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
  })

  it('group notice is invisible to a non-member, visible after joining', async () => {
    // A creates group TF without B
    await go(a.page, '/groups')
    await a.page.getByRole('button', { name: '새 그룹' }).click()
    await a.page.getByLabel('그룹 이름').fill('TF')
    await a.page.getByRole('dialog').getByRole('button', { name: '만들기' }).click()
    await a.page.getByTestId('group-card-TF').waitFor()
    await postNotice(a.page, { title: '그룹전용공지', group: 'TF' })

    await go(b.page, '/notices')
    await b.page.getByTestId('notice-list').waitFor()
    await b.page.waitForTimeout(800)
    expect(await b.page.getByTestId('notice-item-그룹전용공지').count()).toBe(0)

    // invite B
    await go(a.page, '/groups')
    await a.page.getByTestId('group-card-TF').click()
    const dlg = a.page.getByRole('dialog')
    await dlg.getByLabel('팀원B').check()
    await dlg.getByRole('button', { name: '초대 보내기' }).click()
    await dlg.getByRole('button', { name: '닫기' }).click()

    await go(b.page, '/groups')
    await b.page.getByTestId('group-invite').getByRole('button', { name: '수락' }).click()
    await b.page.getByTestId('group-card-TF').waitFor({ timeout: 10000 })
    await go(b.page, '/notices')
    await expect.poll(() => b.page.getByTestId('notice-item-그룹전용공지').count(), { timeout: 10000 }).toBe(1)
  })

  it('space switcher filters notices to the selected group', async () => {
    await postNotice(a.page, { title: '팀전체공지' })
    await go(b.page, '/notices')
    await expect.poll(() => b.page.getByTestId('notice-item-팀전체공지').count(), { timeout: 10000 }).toBe(1)
    await b.page.getByTestId('space-switcher').click()
    await b.page.getByRole('option', { name: 'TF' }).click()
    await expect.poll(() => b.page.getByTestId('notice-item-팀전체공지').count()).toBe(0)
    expect(await b.page.getByTestId('notice-item-그룹전용공지').count()).toBe(1)
    await b.page.getByTestId('space-switcher').click()
    await b.page.getByRole('option', { name: '팀 전체' }).click()
  })

  it('urgent notice sent while B is offline pops up when B starts; ack shows on A', async () => {
    await b.close({ keepData: true })
    await postNotice(a.page, { title: '긴급훈련', level: '긴급', ack: true, replies: '참석, 불참' })
    await expect.poll(() => a.page.getByTestId('receipt-팀원B').textContent(), { timeout: 10000 }).toContain('팀원B')

    b = await launch({ profile: 'e2e-m2b', userData: b.userData })
    // the pop-up may already be open when launch() returns
    await expect.poll(() => b.app.windows().some((w) => w.url().includes('/popup/urgent/')), { timeout: 30000, interval: 300 }).toBe(true)
    const popup = b.app.windows().find((w) => w.url().includes('/popup/urgent/'))!
    await popup.getByTestId('urgent-popup').waitFor()
    expect(await popup.getByRole('heading', { name: '긴급훈련' }).isVisible()).toBe(true)
    await popup.getByRole('button', { name: '참석' }).click()
    await popup.waitForEvent('close', { timeout: 10000 })

    // A's receipts board: B moves to the "확인함" tab with reply
    await a.page.getByRole('button', { name: /^확인함/ }).click()
    await expect.poll(() => a.page.getByTestId('receipt-팀원B').textContent(), { timeout: 15000 }).toContain('참석')
  })

  it('home widget order is kept after restart', async () => {
    await go(b.page, '/home')
    await b.page.getByRole('button', { name: '위젯 편집' }).click()
    // Move "팀원 현황" to the top, however many widgets are above it.
    const up = b.page.getByRole('button', { name: '팀원 현황 위로' })
    while (await up.isEnabled()) await up.click()
    await b.page.getByRole('button', { name: '편집 완료' }).click()
    const first = () => b.page.locator('[data-widget]').first().getAttribute('data-widget')
    expect(await first()).toBe('presence')
    await b.close({ keepData: true })
    b = await launch({ profile: 'e2e-m2b', userData: b.userData })
    await b.page.locator('[data-widget]').first().waitFor({ timeout: 15000 })
    expect(await first()).toBe('presence')
  })
})
