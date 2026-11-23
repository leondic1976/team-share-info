import { describe, it, expect, afterAll } from 'vitest'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47919'
const frame = (p: Page) => p.frameLocator('[data-testid="plugin-frame"]')
const open = async (p: Page, ready: string): Promise<void> => {
  await go(p, '/plugins/meal')
  await frame(p).locator(ready).first().waitFor({ timeout: 20000 })
}

describe('식사 신청 extension: request, cancel, request again until the deadline the admin set', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup: both PCs install it', async () => {
    a = await launch({ profile: 'e2e-meala' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-mealb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    for (const l of [a, b]) {
      const r = await l.page.evaluate(() => window.teamhub.invoke('plugins:installCatalog', { id: 'meal', builtin: true }))
      expect(r.ok, r.error ?? '').toBe(true)
    }
  }, 120000)

  it('nothing can be requested until the admin (server PC) sets the deadlines', async () => {
    await open(b.page, '.empty')
    const fb = frame(b.page)
    expect(await fb.locator('.empty').textContent()).toContain('아직 식사 신청을 받지 않습니다')
    expect(await fb.locator('#settingsTab').isVisible()).toBe(false)

    await open(a.page, '.empty')
    const fa = frame(a.page)
    await fa.locator('#settingsTab').click()
    // lunch is over for today, dinner stays open all day; weekends on so the test runs any day
    await fa.locator('#cut-lunch').fill('00:01')
    await fa.locator('#cut-dinner').fill('23:59')
    await fa.locator('#ahead').fill('2')
    await fa.locator('#weekend').check()
    await fa.locator('#notice').fill('구내식당E2E')
    await fa.locator('#settings button[type=submit]').click()
    await fa.locator('.day.today').waitFor({ timeout: 15000 })

    // the member's screen follows at once: two days, today's lunch already closed
    await expect.poll(() => fb.locator('.day').count(), { timeout: 15000 }).toBe(2)
    expect(await fb.locator('.notice').textContent()).toBe('구내식당E2E')
    const lunch = fb.locator('.day.today [data-tile$=":lunch"]')
    expect(await lunch.textContent()).toContain('00:01 마감됨')
    expect(await lunch.locator('button').count()).toBe(0)
  }, 90000)

  it('before the deadline: request, cancel and request again; the admin sees each change', async () => {
    const fa = frame(a.page)
    const fb = frame(b.page)
    await fa.locator('nav [data-tab="status"]').click()
    const dinnerA = fa.locator('[data-status="dinner"]')
    await expect.poll(() => dinnerA.textContent(), { timeout: 10000 }).toContain('0명')
    expect(await fa.locator('[data-status="lunch"]').textContent()).toContain('마감 · 확정')

    const dinner = fb.locator('.day.today [data-tile$=":dinner"]')
    await dinner.getByRole('button', { name: '신청', exact: true }).click()
    await expect.poll(() => dinner.textContent(), { timeout: 10000 }).toContain('신청함')
    await expect.poll(() => dinnerA.textContent(), { timeout: 15000 }).toContain('1명')
    expect(await dinnerA.textContent()).toContain('팀원B')

    await dinner.getByRole('button', { name: '취소' }).click()
    await expect.poll(() => dinner.textContent(), { timeout: 10000 }).toContain('신청 안 함')
    await expect.poll(() => dinnerA.textContent(), { timeout: 15000 }).toContain('0명')

    await dinner.getByRole('button', { name: '다시 신청' }).click()
    await expect.poll(() => dinnerA.textContent(), { timeout: 15000 }).toContain('팀원B')

    // tomorrow's lunch is still open
    const tomorrow = fb.locator('.day:not(.today) [data-tile$=":lunch"]')
    await tomorrow.getByRole('button', { name: '신청', exact: true }).click()
    await expect.poll(() => tomorrow.textContent(), { timeout: 10000 }).toContain('신청함')
  }, 90000)
})
