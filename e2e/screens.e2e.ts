/** Visual QA: SCREENSHOT_DIR=... saves screenshots of key screens. Skipped otherwise. */
import { describe, it } from 'vitest'
import { join } from 'node:path'
import { launch, runWizard } from './helpers'

const DIR = process.env.SCREENSHOT_DIR ?? ''
const ROUTES = (process.env.SCREENSHOT_ROUTES ?? '/home,/admin/approvals,/admin/settings,/help,/settings').split(',')

describe.skipIf(!DIR)('screenshots', () => {
  it('captures key screens', async () => {
    const l = await launch()
    try {
      await l.page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined)
      await l.page.screenshot({ path: join(DIR, '00-first-run.png') })
      await runWizard(l.page, '47894')
      await l.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 20000 })
      await l.page.waitForTimeout(1000)
      for (const [i, r] of ROUTES.entries()) {
        await l.page.evaluate((h) => (window.location.hash = h), r)
        await l.page.waitForTimeout(700)
        await l.page.screenshot({ path: join(DIR, `${String(i + 1).padStart(2, '0')}${r.replace(/\//g, '_')}.png`) })
      }
    } finally {
      await l.close()
    }
  }, 120000)
})
