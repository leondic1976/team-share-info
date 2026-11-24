import { describe, it, afterAll, expect } from 'vitest'
import { go, launch, runWizard, type Launched } from './helpers'
// Extension frames are sandboxed and offline: the program serves them its fonts (__fonts.css).
describe('extension frames use the program fonts', () => {
  let a: Launched
  afterAll(async () => {
    await a?.close()
  })
  it('body and title fonts load inside a frame, and the frame still cannot fetch', async () => {
    a = await launch({ profile: 'e2e-fonts' })
    await runWizard(a.page, '47933')
    await go(a.page, '/ledger')
    await a.page.waitForTimeout(4000)
    const f = a.page.frames().find((x) => x.url().startsWith('teamhub-plugin://'))
    const r = await f!.evaluate(async () => {
      await document.fonts.load("14px 'Pretendard Variable'", '가나다 abc').catch(() => undefined)
      await document.fonts.load("20px 'Do Hyeon'", '관리대장').catch(() => undefined)
      const leak = await fetch('index.html').then((x) => String(x.status)).catch(() => 'blocked')
      return [document.fonts.check("14px 'Pretendard Variable'", '가'), document.fonts.check("20px 'Do Hyeon'", '관'), leak]
    })
    expect(r).toEqual([true, true, 'blocked'])
  }, 120000)
})
