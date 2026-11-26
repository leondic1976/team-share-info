/**
 * 지시 125-①: a member PC never installs a version newer than its server runs. The download
 * site (a local HTTP server) offers a version far ahead of the app; the server PC takes it,
 * the member PC holds it back and says why. With TEAMHUB_SHOT_DIR set, the update card of
 * both PCs is captured in the light and the dark theme.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Page } from 'playwright-core'
import type { UpdateState } from '../src/shared/ipc'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47924'
const CACHE = join(process.env.LOCALAPPDATA ?? '', 'teamhub-updater-e2e')
const SHOTS = process.env.TEAMHUB_SHOT_DIR
const APP_VERSION = (JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }).version
const SITE_VERSION = '9.5.0'

const body = randomBytes(1024 * 1024 + 321)
let site: Server | null = null
let siteUrl = ''

async function startSite(): Promise<void> {
  const name = `TeamHub-Setup-${SITE_VERSION}.exe`
  const sha = createHash('sha512').update(body).digest('base64')
  const yml = `version: ${SITE_VERSION}\nfiles:\n  - url: ${name}\n    sha512: ${sha}\n    size: ${body.length}\npath: ${name}\nsha512: ${sha}\nreleaseDate: '${new Date().toISOString()}'\n`
  site = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!
    if (path === '/updates/latest.yml') res.writeHead(200, { 'Content-Type': 'text/yaml' }).end(yml)
    else if (path === `/updates/${name}`) res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }).end(body)
    else res.writeHead(404).end('not found')
  })
  await new Promise<void>((r) => site!.listen(0, '127.0.0.1', r))
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/updates/`
}

const updState = (p: Page): Promise<UpdateState> => p.evaluate(() => window.teamhub.invoke('update:getState', undefined as never))
const check = (p: Page): Promise<UpdateState> =>
  p.evaluate(async () => {
    const c = await window.teamhub.invoke('conn:get', undefined as never)
    return window.teamhub.invoke('update:check', { serverUrl: c.serverUrl, manual: true })
  })

async function shotCard(p: Page, name: string): Promise<void> {
  if (!SHOTS) return
  const card = p.getByTestId('update-card')
  await card.scrollIntoViewIfNeeded()
  await p.waitForTimeout(400)
  await p.screenshot({ path: `${SHOTS}/${name}-light.png` })
  await p.evaluate(() => document.documentElement.classList.add('dark'))
  await p.waitForTimeout(300)
  await p.screenshot({ path: `${SHOTS}/${name}-dark.png` })
  await p.evaluate(() => document.documentElement.classList.remove('dark'))
}

describe('update hold: member PCs wait for the server PC', () => {
  let a: Launched
  let b: Launched
  const env = (): Record<string, string> => ({ TEAMHUB_E2E_UPDATER: '1', TEAMHUB_E2E_WEB_FEED: siteUrl })

  beforeAll(async () => {
    rmSync(CACHE, { recursive: true, force: true })
    await startSite()
  })
  afterAll(async () => {
    await b?.close()
    await a?.close()
    await new Promise<void>((r) => (site ? site.close(() => r()) : r()))
    rmSync(CACHE, { recursive: true, force: true })
  })

  it('a member PC holds back a site version newer than its server and says so', async () => {
    a = await launch({ profile: 'e2e-hold-a', env: env() })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-hold-b', env: env() })
    await joinAndApprove(a.page, b.page, PORT, '팀원갑')
    const held = await check(b.page)
    expect(held).toMatchObject({ status: 'none', heldBack: { version: SITE_VERSION, limit: APP_VERSION, basis: 'server' } })
    expect(held.serverPc).toBe(false)
    await go(b.page, '/settings')
    const note = b.page.getByTestId('update-held-back')
    await note.waitFor({ timeout: 10000 })
    expect(await note.textContent()).toBe(`새 버전(${SITE_VERSION})이 있지만 서버 PC가 아직 ${APP_VERSION}입니다. 서버 PC가 먼저 업데이트하면 자동으로 받습니다.`)
    expect(await b.page.getByTestId('update-card').textContent()).toContain('서버 PC의 업데이트를 기다리는 중입니다.')
    // nothing was downloaded, and the blue box stays away
    expect((await updState(b.page)).status).toBe('none')
    expect(await b.page.getByTestId('update-chip').count()).toBe(0)
    console.log('[e2e] held', JSON.stringify(held))
    await shotCard(b.page, 'update-member-held')
  }, 180000)

  it('the server PC takes the new version and is told that member PCs wait for it', async () => {
    await check(a.page)
    await expect.poll(async () => (await updState(a.page)).status, { timeout: 60000 }).toBe('downloaded')
    const st = await updState(a.page)
    expect(st).toMatchObject({ version: SITE_VERSION, source: 'web', serverPc: true })
    expect(st.heldBack).toBeUndefined()
    const toasts = (): Promise<string> =>
      a.app.evaluate(() => ((globalThis as unknown as { __teamhubToasts?: { title: string; body: string; route?: string }[] }).__teamhubToasts ?? []).map((t) => `${t.title}>${t.route}>${t.body}`).join('|'))
    await expect.poll(toasts, { timeout: 10000 }).toContain(`TeamHub 새 버전 ${SITE_VERSION}>/settings>팀원 PC들은 서버 PC보다 새 버전을 설치하지 않습니다.`)
    await go(a.page, '/settings')
    await a.page.getByTestId('update-server-pc-note').waitFor({ timeout: 10000 })
    await shotCard(a.page, 'update-server-pc')
    // told once per version
    await check(a.page)
    expect((await toasts()).split('|').filter((t) => t.startsWith(`TeamHub 새 버전 ${SITE_VERSION}`))).toHaveLength(1)
  }, 120000)
})
