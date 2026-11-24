import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47906'
const ROOT = resolve(import.meta.dirname, '..')
// the bundle the pack script writes for the version in the manifest
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'plugins', 'ladder', 'manifest.json'), 'utf8')) as { version: string }).version
const BUNDLE = join(ROOT, 'release', 'plugins', `ladder-${VERSION}.thplugin`)

const frame = (p: Page) => p.frameLocator('[data-testid="plugin-frame"]')

async function install(l: Launched): Promise<void> {
  const r = await l.page.evaluate((path) => window.teamhub.invoke('plugins:installFile', { path }), BUNDLE)
  expect(r.ok).toBe(true)
}

describe('plugins: ladder game (install in app, play alone and together)', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup and install from a .thplugin file', async () => {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-plugins.mjs'), join(ROOT, 'release', 'plugins')])
    a = await launch({ profile: 'e2e-m9a' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-m9b' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    const info = await a.page.evaluate((path) => window.teamhub.invoke('plugins:inspectFile', { path }), BUNDLE)
    expect(info.manifest?.permissions).toContain('rooms')
    await install(a)
    await install(b)
    await go(a.page, '/plugins')
    await expect.poll(() => a.page.getByTestId('installed-plugin').count()).toBe(1)
    await expect.poll(() => a.page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '사다리타기' }).count()).toBe(1)
  }, 90000)

  it('quick game: draw, follow every path, results table', async () => {
    await a.page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '사다리타기' }).click()
    const f = frame(a.page)
    await f.locator('#people').fill('가\n나\n다\n라')
    await f.locator('#preset').selectOption('order')
    await f.locator('#start').click()
    await expect.poll(() => f.locator('g.start').count()).toBe(4)
    await f.locator('#revealAll').click()
    await expect.poll(() => f.locator('#resultTable tbody tr').count(), { timeout: 20000 }).toBe(4)
    const results = (await f.locator('#resultTable tbody tr td:nth-child(2)').allTextContents()).sort()
    expect(results).toEqual(['1등', '2등', '3등', '4등'])
  }, 60000)

  it('together: A opens a room for B, both pick a line, A reveals, B sees the result', async () => {
    const f = frame(a.page)
    await f.getByRole('tab', { name: '팀원과 함께' }).click()
    await f.locator('#people').fill('서버관리자\n팀원B')
    await f.locator('#preset').selectOption('coffee')
    await f.locator('#roomTitle').fill('커피 내기E2E')
    await f.locator('#createRoom').click()
    await expect.poll(() => f.locator('#boardTitle').textContent(), { timeout: 10000 }).toBe('커피 내기E2E')
    await f.locator('g.start').nth(0).click()
    await expect.poll(() => f.locator('#boardStatus').textContent()).toContain('내 자리: 1번')

    const roomId = await a.page.evaluate(async () => {
      const c = await window.teamhub.invoke('conn:get', undefined as never)
      const r = await fetch(`${c.serverUrl}/api/plugins/ladder/rooms`, { headers: { Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1' } })
      return ((await r.json()).data[0] as { id: string }).id
    })
    await go(b.page, `/plugins/ladder?room=${roomId}`)
    const g = frame(b.page)
    await expect.poll(() => g.locator('#boardTitle').textContent(), { timeout: 15000 }).toBe('커피 내기E2E')
    await expect.poll(() => g.locator('g.start').nth(0).textContent()).toBe('서버관리자')
    await g.locator('g.start').nth(1).click()
    // A's board updates live
    await expect.poll(() => f.locator('g.start').nth(1).textContent(), { timeout: 10000 }).toBe('팀원B')
    await f.locator('#revealAll').click()
    await expect.poll(() => g.locator('#resultTable tbody tr').count(), { timeout: 20000 }).toBe(2)
    const text = await g.locator('#resultTable').textContent()
    expect(text).toContain('커피 쏘기')
    expect(text).toContain('꽝')
    // same result on both sides
    await expect.poll(() => f.locator('#resultTable').textContent(), { timeout: 20000 }).toBe(text)
  }, 90000)

  it('plugins cannot reach the network and only use declared permissions', async () => {
    const blocked = await a.page.evaluate(async () => {
      const iframe = document.querySelector<HTMLIFrameElement>('[data-testid="plugin-frame"]')!
      return iframe.getAttribute('sandbox')
    })
    expect(blocked).toBe('allow-scripts allow-forms allow-modals')
    // fetch from inside the plugin frame is refused by its CSP (connect-src 'none')
    const err = await frame(a.page)
      .locator('body')
      .evaluate(async () => {
        try {
          await fetch('https://example.com/')
          return 'reached'
        } catch (e) {
          return String(e)
        }
      })
    expect(err).not.toBe('reached')
  })
})
