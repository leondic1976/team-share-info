import { describe, it, expect, afterAll } from 'vitest'
import { go, launch, runWizard, type Launched } from './helpers'

/** 긴급구조지휘대 (지시 79): a red menu right under 기록, its page says it is being made. */
describe('긴급구조지휘대 menu', () => {
  let a: Launched
  afterAll(async () => {
    await a?.close()
  })

  it('sits under 기록 in red and opens a page that says it is being made', async () => {
    a = await launch({ profile: 'e2e-cmd' })
    await runWizard(a.page, '47948')
    const nav = a.page.getByRole('navigation', { name: '주 메뉴' })
    const labels = await nav.getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    expect(labels.indexOf('긴급구조지휘대')).toBe(labels.indexOf('기록') + 1)
    const link = nav.getByRole('link', { name: '긴급구조지휘대' })
    const color = await link.evaluate((el) => getComputedStyle(el).color)
    const urgent = await a.page.evaluate(() => {
      const probe = document.createElement('span')
      probe.className = 'text-urgent'
      document.body.appendChild(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    })
    expect(color).toBe(urgent)
    await link.click()
    await a.page.getByTestId('command-page').waitFor({ timeout: 10000 })
    expect(await a.page.getByTestId('command-page').textContent()).toContain('제작 중입니다')
    await a.page.screenshot({ path: process.env.TEAMHUB_SHOT ?? 'out/command.png' })
    await go(a.page, '/home')
  }, 120000)
})
