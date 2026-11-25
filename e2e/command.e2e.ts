import { describe, it, expect, afterAll } from 'vitest'
import type { ElectronApplication, Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47948'
const SHOTS = process.env.TEAMHUB_SHOT_DIR ?? 'out'

async function windowWith(app: ElectronApplication, frag: string, timeout = 25000): Promise<Page> {
  await expect.poll(() => app.windows().some((w) => w.url().includes(frag) && !w.isClosed()), { timeout, interval: 400 }).toBe(true)
  const w = app.windows().find((x) => x.url().includes(frag) && !x.isClosed())!
  await w.waitForLoadState('domcontentloaded')
  w.on('dialog', (d) => void d.accept())
  return w
}

/** A call to the server with this PC's own credentials (setup only). */
function call<T>(p: Page, method: string, path: string, body?: unknown): Promise<T> {
  return p.evaluate(
    async ({ method, path, body }) => {
      const c = await window.teamhub.invoke('conn:get', undefined as never)
      const r = await fetch(`${c.serverUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1' },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
      const j = await r.json()
      if (!r.ok) throw new Error(JSON.stringify(j))
      return j.data
    },
    { method, path, body }
  ) as Promise<T>
}

async function ask(p: Page, value: string): Promise<void> {
  await p.getByTestId('ask-input').fill(value)
  await p.getByTestId('ask-ok').click()
}

async function shot(p: Page, name: string): Promise<void> {
  await p.waitForTimeout(400)
  await p.screenshot({ path: `${SHOTS}/${name}-light.png` })
  await p.evaluate(() => document.documentElement.classList.add('dark'))
  await p.waitForTimeout(300)
  await p.screenshot({ path: `${SHOTS}/${name}-dark.png` })
  await p.evaluate(() => document.documentElement.classList.remove('dark'))
}

/** 긴급구조지휘대 (지시 79, 93~98): 편성, 훈련 창, 통제실, 실시간 지도 표식, 결과. */
describe('긴급구조지휘대', () => {
  let a: Launched
  let b: Launched
  let drillId = ''
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup: the server PC and one member', async () => {
    a = await launch({ profile: 'e2e-cmda' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-cmdb' })
    await joinAndApprove(a.page, b.page, PORT, '이훈련')
    a.page.on('dialog', (d) => void d.accept())
    b.page.on('dialog', (d) => void d.accept())
  }, 180000)

  it('sits under 기록 in red; nothing is pre-filled but the three 근무 유형', async () => {
    const nav = a.page.getByRole('navigation', { name: '주 메뉴' })
    const labels = await nav.getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    expect(labels.indexOf('긴급구조지휘대')).toBe(labels.indexOf('기록') + 1)
    await nav.getByRole('link', { name: '긴급구조지휘대' }).click()
    await a.page.getByTestId('command-page').waitFor({ timeout: 10000 })
    const modes = await a.page.getByTestId('cmd-mode').locator('option').allTextContents()
    expect(modes).toEqual(['긴급구조지휘대', '긴급구조통제단', '풍수해 비상상황근무'])
    await a.page.locator('[data-tab="settings"]').click()
    await a.page.getByTestId('cmd-settings').waitFor()
    expect(await a.page.getByTestId('cmd-role-row').count()).toBe(0)
  }, 60000)

  it('the server PC sets up a 조, its rotation, 분류 and 배치', async () => {
    const p = a.page
    await p.getByTestId('cmd-team-add').click()
    await ask(p, 'A조')
    const row = p.getByTestId('cmd-team-row').filter({ hasText: 'A조' })
    await row.waitFor()
    await row.getByRole('button', { name: '조원' }).click()
    await p.getByRole('checkbox', { name: '서버관리자' }).check()
    await p.getByRole('checkbox', { name: '이훈련' }).check()
    await p.getByTestId('picker-save').click()
    await expect.poll(() => row.textContent()).toContain('2명')
    await p.getByTestId('cmd-rotation-save').click()
    await expect.poll(() => p.getByTestId('cmd-rotation-preview').textContent()).toContain('A조')

    await p.getByTestId('cmd-role-add').click()
    await ask(p, '조장')
    await p.getByTestId('cmd-role-add').click()
    await ask(p, '상황요원')
    await expect.poll(() => p.getByTestId('cmd-assign-row').count()).toBe(2)
    await p.getByTestId('cmd-assign-row').filter({ hasText: '조장' }).getByTestId('cmd-assign-pick').click()
    await p.getByRole('dialog').getByRole('checkbox', { name: '서버관리자' }).check()
    await p.getByTestId('picker-save').click()
    await p.getByTestId('cmd-assign-row').filter({ hasText: '상황요원' }).getByTestId('cmd-assign-pick').click()
    await p.getByRole('dialog').getByRole('checkbox', { name: '이훈련' }).check()
    await p.getByTestId('picker-save').click()
    await expect.poll(() => p.getByTestId('cmd-assign-row').filter({ hasText: '상황요원' }).textContent()).toContain('이훈련')
    await shot(p, 'command-settings')

    await p.locator('[data-tab="overview"]').click()
    await expect.poll(() => p.getByTestId('cmd-today-team').textContent()).toBe('A조')
    await shot(p, 'command-overview')
  }, 90000)

  it('a member sees the 편성 and 내 임무 but not 설정', async () => {
    const p = b.page
    await go(p, '/command')
    await p.getByTestId('command-page').waitFor({ timeout: 10000 })
    expect(await p.locator('[data-tab="settings"]').count()).toBe(0)
    await expect.poll(() => p.getByTestId('cmd-today-team').textContent(), { timeout: 10000 }).toBe('A조')
    await p.locator('[data-tab="mine"]').click()
    await expect.poll(() => p.getByTestId('command-page').textContent()).toContain('상황요원')
  }, 60000)

  it('a drill: the 훈련 창 pops up for the member, who reports from it', async () => {
    const st = await call<{ modes: { id: string; name: string }[]; roles: { id: string; name: string }[] }>(a.page, 'GET', '/api/command')
    const modeId = st.modes.find((x) => x.name === '긴급구조지휘대')!.id
    const role = st.roles.find((x) => x.name === '상황요원')!.id
    await call(a.page, 'POST', '/api/command/scenarios', {
      modeId,
      title: 'E2E 화재훈련',
      summaryHtml: '<p>공장 화재 대응</p>',
      targetHtml: '<p>대상물: E2E빌딩 지상 5층</p>',
      messages: [{ offsetMin: 0, title: '첫 상황 보고', bodyHtml: '<p>3층 연기 확산</p>', targetKind: 'role', targetIds: [role], handling: 'assigned', limitMin: 5 }]
    })
    const p = a.page
    await p.locator('[data-tab="drills"]').click()
    await p.getByTestId('cmd-drill-new').click()
    const dlg = p.getByRole('dialog', { name: '훈련 시작' })
    await dlg.getByLabel('시나리오').selectOption({ label: 'E2E 화재훈련 (메시지 1개)' })
    expect(await dlg.getByRole('checkbox', { name: 'A조' }).isChecked()).toBe(true)
    await dlg.getByTestId('cmd-drill-start').click()
    await p.getByTestId('cmd-drill-view').waitFor({ timeout: 10000 })
    drillId = (await p.evaluate(() => window.location.hash)).split('/').pop()!

    // the member: a window of its own, orange, with who handles the message
    const pop = await windowWith(b.app, '/popup/drill/')
    await expect.poll(() => pop.getByTestId('drill-popup-title').textContent(), { timeout: 20000 }).toBe('첫 상황 보고')
    expect(await pop.getByTestId('drill-popup-handler').textContent()).toContain('상황요원')
    expect(await pop.getByTestId('drill-popup').textContent()).toContain('훈련')
    await shot(pop, 'command-drill-popup')
    await pop.getByLabel('처리 답변').fill('3층 진입 금지, 배연 요청')
    await pop.getByTestId('cmd-answer-send').click()
    await expect.poll(() => pop.isClosed(), { timeout: 10000 }).toBe(true)
  }, 120000)

  it('the 통제실: the answer, grading, a live mark the member sees, the end and the results', async () => {
    await a.page.getByTestId('cmd-open-control').click()
    const c = await windowWith(a.app, '/popup/drill-control/')
    await c.getByTestId('cmd-control').waitFor({ timeout: 15000 })
    const ans = c.getByTestId('cmd-board-answer').filter({ hasText: '배연 요청' })
    await ans.waitFor({ timeout: 10000 })
    await c.getByTestId('cmd-grade').locator('[data-grade="good"]').click()
    await expect.poll(() => c.getByTestId('cmd-control-board').textContent()).toContain('우수')
    expect(await c.getByTestId('cmd-participants').textContent()).toContain('1/1')
    await shot(c, 'command-control')

    // a live mark on the map
    await c.getByRole('button', { name: '지도 크게' }).click()
    await c.locator('[data-map-tool="pin"]').click()
    await c.getByLabel('이름표').fill('전진지휘소')
    const map = c.getByLabel('훈련 대상물 지도')
    const box = (await map.boundingBox())!
    await c.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5)
    await expect.poll(() => c.locator('[data-mark]').count()).toBe(1)

    await go(b.page, `/command/drill/${drillId}`)
    await b.page.getByTestId('cmd-drill-view').waitFor({ timeout: 10000 })
    await expect.poll(() => b.page.getByTestId('cmd-drill-view').locator('[data-mark]').count(), { timeout: 10000 }).toBe(1)
    expect(await b.page.getByTestId('cmd-drill-view').textContent()).toContain('E2E빌딩')
    await shot(b.page, 'command-drill-view')

    await c.getByTestId('cmd-end').click()
    await c.getByTestId('cmd-results-block').waitFor({ timeout: 10000 })
    expect(await c.getByTestId('cmd-results').first().textContent()).toContain('이훈련')
    await expect.poll(() => b.page.getByTestId('cmd-results-block').count(), { timeout: 10000 }).toBe(1)
    expect(await b.page.getByTestId('cmd-drill-view').textContent()).toContain('우수')
    await c.close()
  }, 120000)
})
