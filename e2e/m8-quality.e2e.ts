import { describe, it, expect, afterAll } from 'vitest'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47908'
const SHOTS = process.env.TEAMHUB_SHOT_DIR

/** With TEAMHUB_SHOT_DIR set: a screenshot in the light and in the dark theme. */
async function shot(p: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await p.waitForTimeout(400)
  await p.screenshot({ path: `${SHOTS}/${name}-light.png` })
  await p.evaluate(() => document.documentElement.classList.add('dark'))
  await p.waitForTimeout(300)
  await p.screenshot({ path: `${SHOTS}/${name}-dark.png` })
  await p.evaluate(() => document.documentElement.classList.remove('dark'))
}

async function apiPost(p: Page, path: string, body: unknown): Promise<number> {
  return p.evaluate(
    async ({ path: u, body: b }) => {
      const c = await window.teamhub.invoke('conn:get', undefined as never)
      const r = await fetch(`${c.serverUrl}${u}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1' },
        body: JSON.stringify(b)
      })
      return r.status
    },
    { path, body }
  )
}

describe('M8 quality: start time, idle cost, search, offline cache, menus, privacy', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup', async () => {
    a = await launch({ profile: 'e2e-m8qa' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-m8qb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    expect(await apiPost(a.page, '/api/notices', { level: 'normal', title: '캐시 확인 공지E2E', bodyHtml: '<p>회의실 예약 방법</p>', scope: { type: 'team', groupIds: [], memberIds: [] } })).toBe(200)
  }, 90000)

  it('Ctrl+K finds team items and my own items', async () => {
    await go(b.page, '/memos')
    await b.page.evaluate(() => window.teamhub.invoke('local:memos.save', { body: '<p>회의실 열쇠 위치 메모E2E</p>', color: 'yellow', tags: [] }))
    await b.page.keyboard.press('Control+k')
    await b.page.getByLabel('검색어').fill('회의실')
    await expect.poll(() => b.page.getByTestId('search-results').textContent(), { timeout: 15000 }).toContain('캐시 확인 공지E2E')
    await expect.poll(() => b.page.getByTestId('search-results').textContent()).toContain('회의실 열쇠 위치 메모E2E')
    await b.page.getByTestId('search-result').filter({ hasText: '캐시 확인 공지E2E' }).click()
    await expect.poll(() => b.page.url()).toContain('/notices/')
  })

  it('초성 search: ㅋㅅ ㅎㅇ finds the notice, ㄱㅁㅎㅎ the 근무현황 menu, 팀ㅇB the member', async () => {
    await go(b.page, '/home')
    await b.page.keyboard.press('Control+k')
    const results = b.page.getByTestId('search-results')
    await b.page.getByLabel('검색어').fill('ㅋㅅ ㅎㅇ')
    await expect.poll(() => results.textContent(), { timeout: 15000 }).toContain('캐시 확인 공지E2E')
    await shot(b.page, 'search-choseong-notice')
    await b.page.getByLabel('검색어').fill('팀ㅇB')
    await expect.poll(() => results.textContent(), { timeout: 15000 }).toContain('팀원B')
    await b.page.getByLabel('검색어').fill('ㄱㅁㅎㅎ')
    await expect.poll(() => results.textContent(), { timeout: 15000 }).toContain('근무현황')
    await shot(b.page, 'search-choseong')
    await b.page.getByTestId('search-result').filter({ hasText: '근무현황' }).first().click()
    await expect.poll(() => b.page.url()).toContain('/duty')
  })

  it('personal data never travels to the server (network level)', async () => {
    const seen: string[] = []
    b.page.on('request', (r) => seen.push(`${r.url()} ${r.postData() ?? ''}`))
    await b.page.evaluate(async () => {
      await window.teamhub.invoke('local:memos.save', { body: '<p>개인비밀메모E2E</p>', color: 'pink', tags: ['개인'] })
      await window.teamhub.invoke('local:diary.save', { date: '2026-11-12', bodyHtml: '<p>개인비밀일기E2E</p>', tags: [] })
      await window.teamhub.invoke('local:alarms.save', { title: '개인비밀알람E2E', kind: 'once', fireAt: Date.now() + 3600_000 })
      await window.teamhub.invoke('notes:create', { title: '개인비밀노트E2E' })
    })
    for (const path of ['/memos', '/diary', '/alarms', '/notes', '/home']) {
      await go(b.page, path)
      await b.page.waitForTimeout(700)
    }
    expect(seen.join('\n')).not.toMatch(/개인비밀/)
    expect(seen.join('\n')).not.toMatch(encodeURIComponent('개인비밀').slice(0, 9))
  }, 60000)

  it('menu edit: hide a menu and move one to the top', async () => {
    await go(b.page, '/settings')
    const card = b.page.getByTestId('menu-card')
    await card.getByRole('button', { name: '게시판 숨기기' }).click()
    const up = card.getByRole('button', { name: '메모 위로' })
    while (await up.isEnabled()) await up.click()
    const nav = b.page.getByRole('navigation', { name: '주 메뉴' })
    await expect.poll(() => nav.getByRole('link', { name: '게시판', exact: true }).count()).toBe(0)
    expect(await nav.getByRole('link').first().getAttribute('aria-label')).toBe('메모')
    await card.getByRole('button', { name: '처음대로' }).click()
    await expect.poll(() => nav.getByRole('link', { name: '게시판', exact: true }).count()).toBe(1)
  })

  it('after using many screens: memory and CPU (logged)', async () => {
    await go(b.page, '/home')
    await b.page.waitForTimeout(8000)
    const sample = () => b.app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, cpu: m.cpu.percentCPUUsage, mem: m.memory.privateBytes ?? m.memory.workingSetSize })))
    await sample()
    await b.page.waitForTimeout(10000)
    const m = await sample()
    const memMB = m.reduce((s, x) => s + x.mem, 0) / 1024
    const cpu = m.reduce((s, x) => s + x.cpu, 0)
    console.log(`[e2e] member PC idle: ${memMB.toFixed(0)} MB, CPU ${cpu.toFixed(2)}% (${m.length} processes)`, m.map((x) => `${x.type}:${(x.mem / 1024).toFixed(0)}MB`).join(' '))
    expect(memMB).toBeLessThan(450)
    expect(cpu).toBeLessThan(process.env.CI ? 10 : 3)
  }, 60000)

  it('idle after a fresh start: private memory ≤ 300 MB, CPU ≤ 1% (11장)', async () => {
    const userData = b.userData
    await b.close({ keepData: true })
    b = await launch({ userData, profile: 'e2e-m8qb' })
    await b.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 20000 })
    await b.page.waitForTimeout(15000)
    const sample = () => b.app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, cpu: m.cpu.percentCPUUsage, mem: m.memory.privateBytes ?? m.memory.workingSetSize })))
    await sample()
    await b.page.waitForTimeout(10000)
    const m = await sample()
    const memMB = m.reduce((x, y) => x + y.mem, 0) / 1024
    const cpu = m.reduce((x, y) => x + y.cpu, 0)
    console.log(`[e2e] fresh idle: ${memMB.toFixed(0)} MB, CPU ${cpu.toFixed(2)}%`, m.map((x) => `${x.type}:${(x.mem / 1024).toFixed(0)}MB`).join(' '))
    expect(memMB).toBeLessThan(300)
    expect(cpu).toBeLessThan(process.env.CI ? 10 : 1)
  }, 60000)
  it('first screen within 3 s, and cached data shows with the server off', async () => {
    await go(b.page, '/notices')
    await expect.poll(() => b.page.getByText('캐시 확인 공지E2E').count(), { timeout: 10000 }).toBeGreaterThanOrEqual(1)
    await b.page.waitForTimeout(3500) // cache is saved a few seconds after loading
    await a.close({ keepData: true })
    const userData = b.userData
    await b.close({ keepData: true })
    const t0 = Date.now()
    b = await launch({ userData, profile: 'e2e-m8qb' })
    await b.page.getByTestId('status-bar').waitFor({ timeout: 10000 })
    const firstScreen = Date.now() - t0
    console.log(`[e2e] first screen ${firstScreen} ms (launch → main shell)`)
    expect(firstScreen).toBeLessThan(process.env.CI ? 10000 : 3000)
    await expect.poll(() => b.page.getByTestId('conn-state').textContent(), { timeout: 20000 }).toMatch(/끊김|연결 중/)
    await go(b.page, '/notices')
    await expect.poll(() => b.page.getByText('캐시 확인 공지E2E').count(), { timeout: 10000 }).toBeGreaterThanOrEqual(1)
  }, 90000)

})
