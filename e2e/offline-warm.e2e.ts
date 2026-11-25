import { describe, it, expect, afterAll } from 'vitest'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47949'
const TEAM = { type: 'team', groupIds: [], memberIds: [] }

/** Calls the server as the member signed in on that PC. */
async function call(p: Page, method: string, url: string, body?: unknown): Promise<{ status: number; data: { id?: string } & Record<string, unknown> }> {
  return p.evaluate(
    async ({ method, url, body }) => {
      const c = await window.teamhub.invoke('conn:get', undefined as never)
      const r = await fetch(`${c.serverUrl}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1' },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
      const j = (await r.json().catch(() => ({}))) as { data?: unknown }
      return { status: r.status, data: (j.data ?? {}) as { id?: string } & Record<string, unknown> }
    },
    { method, url, body }
  )
}

/**
 * 지시 81: with the server PC off, a member still reads the shared screens - also the ones they
 * never opened while connected - because the program loads them quietly in the background.
 */
describe('server PC off: the shared screens are still readable from what was kept', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup: content on the server; the member only sits on 홈 while connected', async () => {
    a = await launch({ profile: 'e2e-owa' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-owb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    const members = (await call(a.page, 'GET', '/api/members')).data as unknown as { id: string; name: string }[]
    const bId = members.find((m) => m.name === '팀원B')!.id
    expect((await call(a.page, 'POST', '/api/notices', { level: 'normal', title: '캐시공지E2E', bodyHtml: '<p>공지 본문E2E</p>', scope: TEAM, requireAck: false, replyOptions: [], pinned: false, publishAt: null, expiresAt: null, renotifyMinutes: null, attachmentIds: [] })).status).toBe(200)
    const board = await call(a.page, 'POST', '/api/boards', { name: '캐시게시판E2E', scope: TEAM })
    expect((await call(a.page, 'POST', '/api/posts', { boardId: board.data.id, title: '캐시게시글E2E' })).status).toBe(200)
    const start = Date.now() + 3600_000
    expect((await call(a.page, 'POST', '/api/events', { title: '캐시일정E2E', startAt: start, endAt: start + 3600_000, scope: TEAM })).status).toBe(200)
    const conv = await call(a.page, 'POST', '/api/conversations', { memberIds: [bId] })
    expect((await call(a.page, 'POST', `/api/conversations/${conv.data.id}/messages`, { body: '캐시메시지E2E' })).status).toBe(200)
    expect((await call(a.page, 'POST', '/api/docs', { kind: 'manual', title: '캐시매뉴얼E2E', bodyHtml: '<p>본문</p>', scope: TEAM })).status).toBeLessThan(300)
    expect((await call(a.page, 'POST', '/api/plugins/meal/rooms', { title: '식사 신청', scope: TEAM, shared: { kind: 'meal', v: 1, meals: { lunch: { on: true, cutoff: '23:58' }, dinner: { on: true, cutoff: '23:59' } }, weekend: true, ahead: 2, notice: '캐시식당E2E' } })).status).toBe(200)
    // the member stays on 홈; the background loading runs a few seconds after connecting
    await go(b.page, '/home')
    await b.page.waitForTimeout(15000)
  }, 180000)

  it('server off: 공지, 게시판, 일정, 메신저, 기록, 자료실, 근무현황, 식사 신청 show what was kept', async () => {
    await a.close({ keepData: true })
    const p = b.page
    await p.getByTestId('conn-state').filter({ hasNotText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    const offline = '서버에 연결되어 있지 않습니다'
    const main = (): Promise<string> => p.locator('main').innerText()
    const check = async (route: string, expected: string): Promise<void> => {
      await go(p, route)
      await expect.poll(main, { timeout: 15000, message: route }).toContain(expected)
      expect(await main(), route).not.toContain(offline)
    }
    await check('/notices', '캐시공지E2E')
    await p.getByText('캐시공지E2E').first().click()
    await expect.poll(main, { timeout: 10000 }).toContain('공지 본문E2E')
    await check('/boards', '캐시게시글E2E')
    await check('/calendar', '캐시일정E2E')
    await check('/chat', '서버관리자')
    await p.getByTestId('conv-서버관리자').click()
    await expect.poll(() => p.getByTestId('message-list').textContent(), { timeout: 10000 }).toContain('캐시메시지E2E')
    await check('/docs/manual', '캐시매뉴얼E2E')
    await go(p, '/files')
    await p.waitForTimeout(1500)
    expect(await main()).not.toContain(offline)
    await check('/duty', '팀원B')
    // the extension shows its last state (reads are kept)
    await go(p, '/meal')
    await expect.poll(() => p.frameLocator('[data-testid="plugin-frame"]').locator('body').innerText(), { timeout: 20000 }).toContain('캐시식당E2E')
    // nobody's presence is claimed while the server cannot say
    await go(p, '/home')
    expect(await main()).not.toContain('온라인')
  }, 180000)
})
