import { describe, it, afterAll, expect } from 'vitest'
import { go, launch, runWizard, type Launched } from './helpers'
// Extension frames are sandboxed and offline: the program serves them its fonts (__fonts.css).
describe('extension frames use the program fonts; shipped extensions follow the program', () => {
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
  it('an installed extension older than the copy shipped with the program is replaced at the next start', async () => {
    const r = await a.page.evaluate(() => window.teamhub.invoke('plugins:installCatalog', { id: 'survey', builtin: true }))
    expect(r.ok, r.error ?? '').toBe(true)
    const shipped = r.data!.version
    // make it look like the copy an older TeamHub installed, switched off by the user
    await a.page.evaluate(async () => {
      const reg = (await window.teamhub.invoke('local:kv.get', { key: 'plugins' })) as Record<string, { manifest: { version: string }; enabled: boolean }>
      reg.survey.manifest.version = '0.0.1'
      reg.survey.enabled = false
      await window.teamhub.invoke('local:kv.set', { key: 'plugins', value: reg })
    })
    const userData = a.userData
    await a.close({ keepData: true })
    a = await launch({ userData, profile: 'e2e-fonts' })
    await a.page.getByTestId('status-bar').waitFor({ timeout: 20000 })
    const survey = (await a.page.evaluate(() => window.teamhub.invoke('plugins:list', undefined))).find((p) => p.manifest.id === 'survey')!
    expect(survey.manifest.version).toBe(shipped)
    // what the user chose stays
    expect(survey.enabled).toBe(false)
  }, 120000)

  it('식사 신청 is part of the program: an installed copy from before is retired, the menu opens without installing (instruction 148)', async () => {
    // the registry entry an older TeamHub left behind (the copy installed on first opening)
    await a.page.evaluate(async () => {
      const reg = ((await window.teamhub.invoke('local:kv.get', { key: 'plugins' })) ?? {}) as Record<string, unknown>
      reg.meal = { manifest: { id: 'meal', name: '식사 신청', version: '1.8.0', description: '', author: 'TeamHub', icon: '', entry: 'index.html', permissions: ['members', 'rooms'], minAppVersion: '0.1.0' }, installedAt: 1, source: 'builtin', enabled: false }
      await window.teamhub.invoke('local:kv.set', { key: 'plugins', value: reg })
      await window.teamhub.invoke('local:kv.set', { key: 'plugin:meal:keep', value: 'kept' })
    })
    const userData = a.userData
    await a.close({ keepData: true })
    a = await launch({ userData, profile: 'e2e-fonts' })
    await a.page.getByTestId('status-bar').waitFor({ timeout: 20000 })
    const list = await a.page.evaluate(() => window.teamhub.invoke('plugins:list', undefined))
    expect(list.some((p) => p.manifest.id === 'meal')).toBe(false)
    // its data on this PC stays
    expect(await a.page.evaluate(() => window.teamhub.invoke('local:kv.get', { key: 'plugin:meal:keep' }))).toBe('kept')
    // installing it as an extension is refused: it is in the program
    const r = await a.page.evaluate(() => window.teamhub.invoke('plugins:installCatalog', { id: 'meal', builtin: true }))
    expect(r.ok).toBe(false)
    // the screen opens from the program's files although it was switched off as an extension
    await go(a.page, '/meal')
    const f = a.page.frameLocator('[data-testid="plugin-frame"]')
    await f.locator('main').waitFor({ timeout: 20000 })
    await expect.poll(() => f.locator('main').textContent(), { timeout: 20000 }).toBeTruthy()
    expect(await a.page.getByTestId('plugin-stuck').count()).toBe(0)
    // not among the extensions
    await go(a.page, '/plugins')
    await a.page.waitForTimeout(1500)
    expect(await a.page.getByText('식사 신청', { exact: true }).count()).toBeLessThanOrEqual(1)
  }, 120000)
})
