/**
 * Update flow without an installed app (M1-6): the unpackaged app runs the real check,
 * feed choice, download and hash verification (TEAMHUB_E2E_UPDATER=1); the installer is
 * never run. The download site is a local HTTP server; the server PC feed is the app's own
 * embedded server. Running a real installer is covered by update-installed.e2e.ts.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Page } from 'playwright-core'
import type { UpdateSettings, UpdateState } from '../src/shared/ipc'
import { launch, runWizard, type Launched } from './helpers'

const PORT = '47911'
const CACHE = join(process.env.LOCALAPPDATA ?? '', 'teamhub-updater-e2e')

/** Stand-in for the public download site. */
const site = {
  server: null as Server | null,
  url: '',
  version: null as string | null,
  body: Buffer.alloc(0),
  /** serve other bytes than latest.yml promises */
  corrupt: false,
  hits: 0
}
const siteYml = (): string => {
  const name = `TeamHub-Setup-${site.version}.exe`
  const sha = createHash('sha512').update(site.body).digest('base64')
  return `version: ${site.version}\nfiles:\n  - url: ${name}\n    sha512: ${sha}\n    size: ${site.body.length}\npath: ${name}\nsha512: ${sha}\nreleaseDate: '${new Date().toISOString()}'\n`
}
async function startSite(port = 0): Promise<void> {
  site.server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!
    if (path === '/updates/latest.yml' && site.version) {
      site.hits++
      res.writeHead(200, { 'Content-Type': 'text/yaml' }).end(siteYml())
    } else if (path.endsWith('.exe') && site.version) {
      const body = site.corrupt ? Buffer.alloc(site.body.length, 1) : site.body
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }).end(body)
    } else res.writeHead(404).end('not found')
  })
  await new Promise<void>((r) => site.server!.listen(port, '127.0.0.1', r))
  site.url = `http://127.0.0.1:${(site.server.address() as AddressInfo).port}/updates/`
}
const stopSite = (): Promise<void> => new Promise((r) => (site.server ? site.server.close(() => r()) : r()))

const updState = (p: Page): Promise<UpdateState> => p.evaluate(() => window.teamhub.invoke('update:getState', undefined as never))
const setCfg = (p: Page, c: UpdateSettings): Promise<void> => p.evaluate((x) => window.teamhub.invoke('update:setSettings', x), c)
const check = (p: Page, o: { manual?: boolean; force?: boolean } = { manual: true }): Promise<UpdateState> =>
  p.evaluate(async (x) => {
    const c = await window.teamhub.invoke('conn:get', undefined as never)
    return window.teamhub.invoke('update:check', { serverUrl: c.serverUrl, ...x })
  }, o)

/** Register a release on the server PC (admin API), as 관리 → 업데이트 배포 does. */
const publishLan = (p: Page, version: string, mandatory = false): Promise<number> =>
  p.evaluate(
    async ({ version: v, mandatory: m }) => {
      const c = await window.teamhub.invoke('conn:get', undefined as never)
      const body = new Uint8Array(1024 * 1024 + 4096)
      for (let i = 0; i < body.length; i += 4096) body[i] = (i / 4096) % 251
      const r = await fetch(`${c.serverUrl}/api/admin/releases?version=${v}&mandatory=${m ? 1 : 0}&fileName=TeamHub-Setup-${v}.exe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1' },
        body
      })
      return r.status
    },
    { version, mandatory }
  )

describe('update flow: feed choice, download, verification, recovery', () => {
  let a: Launched
  const env = (): Record<string, string> => ({ TEAMHUB_E2E_UPDATER: '1', TEAMHUB_E2E_WEB_FEED: site.url })

  beforeAll(async () => {
    rmSync(CACHE, { recursive: true, force: true })
    await startSite()
  })
  afterAll(async () => {
    await a?.close()
    await stopSite()
    rmSync(CACHE, { recursive: true, force: true })
  })

  it('nothing offered: "최신 버전", and an unreachable feed is reported as such', async () => {
    a = await launch({ profile: 'e2e-upd', env: env() })
    await runWizard(a.page, PORT)
    // the site answers without a release, the server PC has none either
    const none = await check(a.page)
    expect(none.status).toBe('none')
    // site only, and the site is down
    const sitePort = Number(new URL(site.url).port)
    await stopSite()
    await setCfg(a.page, { auto: true, source: 'web' })
    const err = await check(a.page)
    expect(err.status).toBe('error')
    expect(err.message).toContain('연결하지 못했습니다')
    // automatic: the site is down, the server PC answers (nothing newer) → not an error
    await setCfg(a.page, { auto: true, source: 'auto' })
    const lan = await check(a.page)
    expect(lan).toMatchObject({ status: 'none', source: 'lan' })
    console.log('[e2e] update', JSON.stringify([none, err, lan]))
    await startSite(sitePort)
  }, 120000)

  it('a release on the server PC is downloaded automatically and offered in the status bar', async () => {
    expect(await publishLan(a.page, '9.0.0')).toBe(200)
    // update.available → check → download → hash check → ready
    await expect.poll(async () => (await updState(a.page)).status, { timeout: 60000 }).toBe('downloaded')
    expect(await updState(a.page)).toMatchObject({ version: '9.0.0', source: 'lan' })
    await a.page.getByRole('button', { name: /v9\.0\.0 설치\(다시 시작\)/ }).waitFor({ timeout: 10000 })
    console.log('[e2e] update', JSON.stringify(await updState(a.page)))
    // further checks leave a finished download alone
    expect((await check(a.page)).status).toBe('downloaded')
  }, 120000)

  it('automatic update off: the newer of site and server PC is reported, downloaded on request; a damaged file is refused and fetched again', async () => {
    await setCfg(a.page, { auto: false, source: 'auto' })
    await a.close({ keepData: true })
    site.version = '9.5.0'
    site.body = randomBytes(1024 * 1024 + 123)
    site.corrupt = true
    a = await launch({ profile: 'e2e-upd', userData: a.userData, env: env() })
    await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    // automatic checks do nothing when turned off
    expect((await check(a.page, {})).status).toBe('idle')
    // site 9.5.0 > server PC 9.0.0
    const found = await check(a.page)
    expect(found).toMatchObject({ status: 'available', version: '9.5.0', source: 'web' })
    await a.page.evaluate(() => (window.location.hash = '/settings'))
    await a.page.getByTestId('update-card').getByRole('button', { name: '내려받기' }).click()
    await expect.poll(async () => (await updState(a.page)).status, { timeout: 60000 }).toBe('error')
    expect((await updState(a.page)).message).toContain('손상')
    console.log('[e2e] update', JSON.stringify([found, await updState(a.page)]))
    // the site is repaired: the next check downloads a good copy
    site.corrupt = false
    await check(a.page)
    await a.page.getByTestId('update-card').getByRole('button', { name: '내려받기' }).click()
    await expect.poll(async () => (await updState(a.page)).status, { timeout: 60000 }).toBe('downloaded')
    expect(await updState(a.page)).toMatchObject({ version: '9.5.0', source: 'web' })
    await a.page.getByTestId('update-card').getByRole('button', { name: '설치하고 다시 시작' }).waitFor({ timeout: 10000 })
  }, 180000)

  it('a mandatory release is downloaded even with automatic update off and "site only"', async () => {
    await setCfg(a.page, { auto: false, source: 'web' })
    await a.close({ keepData: true })
    rmSync(CACHE, { recursive: true, force: true })
    site.version = null // the site offers nothing; the mandatory release is on the server PC
    a = await launch({ profile: 'e2e-upd', userData: a.userData, env: env() })
    await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    expect(await publishLan(a.page, '9.9.0', true)).toBe(200)
    await expect.poll(async () => (await updState(a.page)).status, { timeout: 60000 }).toBe('downloaded')
    expect(await updState(a.page)).toMatchObject({ version: '9.9.0', source: 'lan' })
    console.log('[e2e] update', JSON.stringify(await updState(a.page)), 'site hits', site.hits)
  }, 120000)
})
