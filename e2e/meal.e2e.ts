import { describe, it, expect, afterAll } from 'vitest'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const SHOTS = process.env.TEAMHUB_SHOT_DIR

const PORT = '47919'
const frame = (p: Page) => p.frameLocator('[data-testid="plugin-frame"]')
/** The frame itself, to run code in it (the extension's own Meal and TeamHub). */
const frameOf = async (p: Page) => (await (await p.locator('[data-testid="plugin-frame"]').elementHandle())!.contentFrame())!
/** With TEAMHUB_SHOT_DIR set: a screenshot in the light and in the dark theme (the program and the frame). */
const shot = async (p: Page, name: string): Promise<void> => {
  if (!SHOTS) return
  const f = await frameOf(p)
  await p.waitForTimeout(400)
  await p.screenshot({ path: `${SHOTS}/${name}-light.png` })
  await p.evaluate(() => document.documentElement.classList.add('dark'))
  await f.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await p.waitForTimeout(300)
  await p.screenshot({ path: `${SHOTS}/${name}-dark.png` })
  await p.evaluate(() => document.documentElement.classList.remove('dark'))
  await f.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
}
const open = async (p: Page, ready: string): Promise<void> => {
  await go(p, '/plugins/meal')
  await frame(p).locator(ready).first().waitFor({ timeout: 20000 })
}

describe('식사 신청 extension: request, cancel, request again until the deadline; menus and 식수서무', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup: both PCs install it', async () => {
    a = await launch({ profile: 'e2e-meala' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-mealb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    for (const l of [a, b]) {
      const r = await l.page.evaluate(() => window.teamhub.invoke('plugins:installCatalog', { id: 'meal', builtin: true }))
      expect(r.ok, r.error ?? '').toBe(true)
    }
  }, 120000)

  it('nothing can be requested until the admin (server PC) sets the deadlines', async () => {
    await open(b.page, '.empty')
    const fb = frame(b.page)
    expect(await fb.locator('.empty').textContent()).toContain('아직 식사 신청을 받지 않습니다')
    expect(await fb.locator('#settingsTab').isVisible()).toBe(false)
    // the look of the program reaches the frame (__ui.css): the same header as the other pages
    // no "update TeamHub" notice any more (지시 89): built-in extensions come with the program
    expect(await fb.getByText('최신 버전으로 업데이트해야').count()).toBe(0)
    expect(await fb.locator('.th-page-header').evaluate((el) => [getComputedStyle(el).borderBottomWidth, getComputedStyle(document.documentElement).getPropertyValue('--th-ui').trim()])).toEqual(['1px', '1'])

    await open(a.page, '.empty')
    const fa = frame(a.page)
    await fa.locator('#settingsTab').click()
    // lunch is over for today, dinner stays open all day; weekends on so the test runs any day
    await fa.locator('#cut-lunch').fill('00:01')
    await fa.locator('#cut-dinner').fill('23:59')
    await fa.locator('#ahead').fill('2')
    await fa.locator('#weekend').check()
    await fa.locator('#notice').fill('구내식당E2E')
    expect(await fa.locator('#holidays').isChecked()).toBe(true)
    await fa.locator('#settings button[type=submit]').click()
    await fa.locator('.day.today').waitFor({ timeout: 15000 })

    // the member's screen follows at once: two days, today's lunch already closed
    await expect.poll(() => fb.locator('.day').count(), { timeout: 15000 }).toBe(2)
    expect(await fb.locator('.notice').textContent()).toBe('구내식당E2E')
    const lunch = fb.locator('.day.today [data-tile$=":lunch"]')
    expect(await lunch.textContent()).toContain('00:01 마감됨')
    expect(await lunch.locator('button').count()).toBe(0)
  }, 90000)

  it('before the deadline: request, cancel and request again; the admin sees each change', async () => {
    const fa = frame(a.page)
    const fb = frame(b.page)
    await fa.locator('nav [data-tab="status"]').click()
    const dinnerA = fa.locator('[data-status="dinner"]')
    await expect.poll(() => dinnerA.textContent(), { timeout: 10000 }).toContain('0명')
    expect(await fa.locator('[data-status="lunch"]').textContent()).toContain('마감 · 확정')

    const dinner = fb.locator('.day.today [data-tile$=":dinner"]')
    await dinner.getByRole('button', { name: '신청', exact: true }).click()
    await expect.poll(() => dinner.textContent(), { timeout: 10000 }).toContain('신청함')
    await expect.poll(() => dinnerA.textContent(), { timeout: 15000 }).toContain('1명')
    expect(await dinnerA.textContent()).toContain('팀원B')

    await dinner.getByRole('button', { name: '취소' }).click()
    await expect.poll(() => dinner.textContent(), { timeout: 10000 }).toContain('신청 안 함')
    await expect.poll(() => dinnerA.textContent(), { timeout: 15000 }).toContain('0명')

    await dinner.getByRole('button', { name: '다시 신청' }).click()
    await expect.poll(() => dinnerA.textContent(), { timeout: 15000 }).toContain('팀원B')

    // tomorrow's lunch is still open
    const tomorrow = fb.locator('.day:not(.today) [data-tile$=":lunch"]')
    await tomorrow.getByRole('button', { name: '신청', exact: true }).click()
    await expect.poll(() => tomorrow.textContent(), { timeout: 10000 }).toContain('신청함')
  }, 90000)

  it('the admin requests and cancels for a member; the member can still change it', async () => {
    const fa = frame(a.page)
    const fb = frame(b.page)
    const dinnerA = fa.locator('[data-status="dinner"]')
    const dinner = fb.locator('.day.today [data-tile$=":dinner"]')

    // cancel for 팀원B, then request again for them
    await dinnerA.locator('button[data-unproxy]').click()
    await expect.poll(() => dinnerA.textContent(), { timeout: 15000 }).toContain('0명')
    await expect.poll(() => dinner.textContent(), { timeout: 15000 }).toContain('대신')
    expect(await dinner.textContent()).toContain('신청 안 함')

    await dinnerA.locator('select').selectOption({ index: 1 })
    await dinnerA.getByRole('button', { name: '대신 신청', exact: true }).click()
    await expect.poll(() => dinnerA.textContent(), { timeout: 15000 }).toContain('1명')
    expect(await dinnerA.locator('.who').textContent()).toContain('대신')
    await expect.poll(() => dinner.textContent(), { timeout: 15000 }).toContain('신청함')

    // the member's own later change wins
    await dinner.getByRole('button', { name: '취소' }).click()
    await expect.poll(() => dinnerA.textContent(), { timeout: 15000 }).toContain('0명')
  }, 90000)

  it('a member who is not in charge requests and cancels for somebody else too (1.4.0)', async () => {
    const fa = frame(a.page)
    const fb = frame(b.page)
    const wait = { timeout: 15000 }
    const mineA = fa.locator('.day.today [data-tile$=":dinner"]')
    await fa.locator('nav [data-tab="apply"]').click()
    await mineA.waitFor(wait)
    await fb.locator('nav [data-tab="status"]').click()
    const dinnerB = fb.locator('[data-status="dinner"]')
    await dinnerB.locator('.proxy select').waitFor(wait)
    // 팀원B picks the admin (the only other one) and requests their dinner
    await dinnerB.locator('.proxy select').selectOption({ index: 1 })
    await dinnerB.getByRole('button', { name: '대신 신청', exact: true }).click()
    await expect.poll(() => dinnerB.textContent(), wait).toContain('1명')
    expect(await dinnerB.locator('.who').textContent()).toContain('대신')
    // the admin's own tile says who did it
    await expect.poll(() => mineA.textContent(), wait).toContain('신청함')
    expect(await mineA.textContent()).toContain('팀원B 대신')
    // and 팀원B cancels it again for them
    await dinnerB.locator('button[data-unproxy]').click()
    await expect.poll(() => dinnerB.textContent(), wait).toContain('0명')
    await expect.poll(() => mineA.textContent(), wait).toContain('신청 안 함')
    await fb.locator('nav [data-tab="apply"]').click()
    await fa.locator('nav [data-tab="status"]').click()
  }, 90000)

  it('a 식수서무 named by the admin registers the menu and changes a deadline; everybody sees it at once', async () => {
    const fa = frame(a.page)
    const fb = frame(b.page)
    const wait = { timeout: 15000 }
    // not in charge yet: no settings tab, nothing to register a menu with
    expect(await fb.locator('#settingsTab').isVisible()).toBe(false)
    expect(await fb.locator('#editWeek, [data-menu-day]').count()).toBe(0)
    expect(await fb.locator('[data-today-menu="dinner"]').textContent()).toContain('메뉴 미등록')

    // the admin who made the settings names 팀원B (two at most)
    await fa.locator('#settingsTab').click()
    await fa.locator('#stewards label', { hasText: '팀원B' }).locator('input').check()
    await fa.locator('#settings button[type=submit]').click()
    await fa.locator('.day.today').waitFor(wait)
    expect(await fa.locator('[data-charge]').first().textContent()).toContain('식수서무 팀원B')
    await expect.poll(() => fb.locator('#settingsTab').isVisible(), wait).toBe(true)
    expect(await fb.locator('[data-charge]').first().textContent()).toContain('식수서무 팀원B')

    // 팀원B registers today's dinner and a note in the week table
    await fb.locator('#editWeek').click()
    const row = fb.locator('#menuForm tr.today')
    await row.locator('textarea[data-slot="dinner"]').fill('김치찌개\n계란말이')
    await row.locator('input[data-slot="note"]').fill('메모E2E')
    await fb.locator('#saveWeek').click()
    await fb.locator('section[data-week]').waitFor(wait)
    expect(await fb.locator('#menuStamp').textContent()).toContain('마지막으로 고친 사람: 팀원B')
    expect(await fb.locator('table.week tr.today').textContent()).toContain('계란말이')

    // the admin's open screen shows it without reopening: today's menu, the day's row and the note
    await expect.poll(() => fa.locator('[data-today-menu="dinner"]').textContent(), wait).toContain('김치찌개')
    expect(await fa.locator('.day.today [data-tile$=":dinner"] .menu').textContent()).toBe('김치찌개, 계란말이')
    expect(await fa.locator('.day.today .day-note').textContent()).toBe('메모E2E')
    await fa.locator('nav [data-tab="menu"]').click()
    expect(await fa.locator('table.week tr.today').textContent()).toContain('메모E2E')
    await fa.locator('nav [data-tab="apply"]').click()

    // 팀원B changes a deadline but cannot name a 식수서무
    await fb.locator('#settingsTab').click()
    expect(await fb.locator('#stewards input').count()).toBeGreaterThan(0)
    expect(await fb.locator('#stewards input:not(:disabled)').count()).toBe(0)
    await fb.locator('#cut-dinner').fill('23:58')
    await fb.locator('#settings button[type=submit]').click()
    await fb.locator('.day.today').waitFor(wait)
    await expect.poll(() => fa.locator('.day.today [data-tile$=":dinner"]').textContent(), wait).toContain('23:58 마감')

    // removed again: the tab goes at once, the menu and the deadline they saved stay
    await fa.locator('#settingsTab').click()
    expect(await fa.locator('#setStamp').textContent()).toContain('마지막 저장: 팀원B')
    expect(await fa.locator('#cut-dinner').inputValue()).toBe('23:58')
    await fa.locator('#stewards label', { hasText: '팀원B' }).locator('input').uncheck()
    await fa.locator('#settings button[type=submit]').click()
    await fa.locator('.day.today').waitFor(wait)
    await expect.poll(() => fb.locator('#settingsTab').isVisible(), wait).toBe(false)
    expect(await fb.locator('#editWeek, [data-menu-day]').count()).toBe(0)
    expect(await fb.locator('[data-today-menu="dinner"]').textContent()).toContain('김치찌개')
    expect(await fb.locator('.day.today [data-tile$=":dinner"]').textContent()).toContain('23:58 마감')
    await fa.locator('nav [data-tab="status"]').click()
  }, 120000)

  it('requests for many at once by department, including somebody registered by hand (not a TeamHub member)', async () => {
    const fa = frame(a.page)
    const fb = frame(b.page)
    const wait = { timeout: 15000 }
    // a member who is not in charge has the button too, but cannot register people by hand
    await fb.locator('#bulkOpen').click()
    await fb.locator('#bulkPeople .bulk-group').first().waitFor(wait)
    expect(await fb.locator('#bulkAddPerson').isVisible()).toBe(false)
    await fb.locator('#bulkClose').click()

    // the server PC registers a colleague who does not use TeamHub in 관리 → 미등록 인원 (1.8.0, 지시 134)
    const card = a.page.locator('[data-testid="unregistered-card"]')
    await go(a.page, '/admin/members')
    await card.getByTestId('unregistered-add').click()
    await a.page.getByLabel('미등록 인원 이름').fill('팀원B')
    await expect.poll(() => a.page.getByText('같은 이름의 구성원이 있습니다').count(), wait).toBe(1)
    await a.page.getByLabel('미등록 인원 이름').fill('미등록E2E')
    await a.page.getByLabel('미등록 인원 부서').fill('현장E2E')
    await a.page.getByTestId('unregistered-save').click()
    await card.getByTestId('unregistered-row-미등록E2E').waitFor(wait)
    expect(await card.getByTestId('unregistered-row-미등록E2E').textContent()).toContain('미등록')
    if (SHOTS) {
      await card.scrollIntoViewIfNeeded()
      await a.page.waitForTimeout(400)
      await a.page.screenshot({ path: `${SHOTS}/admin-unregistered-light.png` })
      await a.page.evaluate(() => document.documentElement.classList.add('dark'))
      await a.page.waitForTimeout(300)
      await a.page.screenshot({ path: `${SHOTS}/admin-unregistered-dark.png` })
      await a.page.evaluate(() => document.documentElement.classList.remove('dark'))
    }
    // 식사 신청 shows the same list, read only, with the mark
    await open(a.page, '#main')
    await fa.locator('#settingsTab').click()
    await fa.locator('#peopleCard tr[data-person]').waitFor(wait)
    expect(await fa.locator('#peopleCard tbody').textContent()).toContain('미등록E2E')
    expect(await fa.locator('#peopleCard tbody .th-badge').first().textContent()).toBe('미등록')
    expect(await fa.locator('#personAdd').count()).toBe(0)

    // 여러 명 대신 신청: today's dinner is ticked (lunch is past its deadline and cannot be)
    await fa.locator('nav [data-tab="apply"]').click()
    await fa.locator('#bulkOpen').click()
    await fa.locator('#bulkPeople .bulk-group').first().waitFor(wait)
    expect(await fa.locator('[data-bslot$="|lunch"]').first().isDisabled()).toBe(true)
    expect(await fa.locator('[data-bslot$="|dinner"]').first().isChecked()).toBe(true)
    // who requested or cancelled today's dinner shows next to the name: 팀원B cancelled their own,
    // and 팀원B cancelled the admin's for them (지시 78)
    await expect.poll(() => fa.locator('#bulkPeople [data-bstatus="cancelSelf"]').count(), wait).toBe(1)
    expect(await fa.locator('#bulkPeople label:has([data-bstatus="cancelSelf"]) > span').first().textContent()).toBe('팀원B')
    expect(await fa.locator('#bulkPeople [data-bstatus="cancelSelf"]').textContent()).toBe('본인 취소')
    expect(await fa.locator('#bulkPeople [data-bstatus="cancelProxy"]').textContent()).toBe('팀원B 대신 취소')
    // the hand-registered person sits in their department group, marked
    await fa.locator('[data-btoggle="현장E2E"]').click()
    expect(await fa.locator('.bulk-group[data-bgroup="현장E2E"] .bulk-list').textContent()).toContain('미등록')
    await fa.locator('[data-bdept="현장E2E"]').check()
    expect(await fa.locator('#bulkCount').textContent()).toBe('1명 선택')
    await fa.locator('#bulkAll').click()
    expect(await fa.locator('#bulkCount').textContent()).toBe('3명 선택')
    await fa.locator('#bulkGo').click()
    await expect.poll(() => fa.locator('#bulkResult').textContent(), wait).toBe('3명 신청')
    // now each of them carries the mark of the request made for them
    await expect.poll(() => fa.locator('#bulkPeople [data-bstatus="proxy"]').count(), wait).toBeGreaterThanOrEqual(1)
    // again: everybody has it already, nobody can be picked
    await fa.locator('#bulkAll').click()
    expect(await fa.locator('#bulkCount').textContent()).toBe('0명 선택')
    expect(await fa.locator('#bulkGo').isDisabled()).toBe(true)
    await fa.locator('#bulkClose').click()

    // the member sees the request made for them and can still change it
    const dinner = fb.locator('.day.today [data-tile$=":dinner"]')
    await expect.poll(() => dinner.textContent(), wait).toContain('신청함')
    expect(await dinner.textContent()).toContain('대신')

    // 현황: the count says how many are not members, the name carries the mark
    await fa.locator('nav [data-tab="status"]').click()
    const dinnerA = fa.locator('[data-status="dinner"]')
    await expect.poll(() => dinnerA.locator('.th-card-header').textContent(), wait).toContain('3명 (미등록 1명 포함)')
    expect(await dinnerA.locator('[data-who^="x:"]').textContent()).toContain('미등록E2E')
    expect(await dinnerA.locator('[data-who^="x:"] .th-badge').textContent()).toBe('미등록')

    // removed from the list in 관리: no longer offered, the request already made stays under the name
    await go(a.page, '/admin/members')
    a.page.once('dialog', (d) => void d.accept())
    await card.getByTestId('unregistered-row-미등록E2E').getByRole('button', { name: '삭제' }).click()
    await expect.poll(() => card.getByTestId('unregistered-row-미등록E2E').count(), wait).toBe(0)
    await open(a.page, '#main')
    await fa.locator('#settingsTab').click()
    await expect.poll(() => fa.locator('#peopleCard tr[data-person]').count(), wait).toBe(0)
    await fa.locator('nav [data-tab="status"]').click()
    await expect.poll(() => dinnerA.textContent(), wait).toContain('미등록E2E')
  }, 120000)

  it('통계 only for those in charge and the server PC; 내 기록 for everybody (지시 90·91)', async () => {
    const fa = frame(a.page)
    const fb = frame(b.page)
    const wait = { timeout: 15000 }
    // the member (not in charge): no 통계, but their own record
    await open(b.page, '.day.today')
    expect(await fb.locator('#statsTab').isVisible()).toBe(false)
    await fb.locator('nav [data-tab="mine"]').click()
    await fb.locator('[data-mine="summary"]').waitFor(wait)
    // today's dinner was requested for them by the admin (여러 명 대신 신청)
    await expect.poll(() => fb.locator('table[data-mine="days"] tr.today').textContent(), wait).toContain('서버관리자 대신')
    expect(await fb.locator('table[data-mine="months"] tbody tr').count()).toBe(4)
    // the server PC (the admin who made the settings): the four views
    await open(a.page, '.day.today')
    expect(await fa.locator('#statsTab').isVisible()).toBe(true)
    await fa.locator('#statsTab').click()
    await fa.locator('[data-stats="summary"]').waitFor(wait)
    expect(await fa.locator('[data-stats="summary"]').textContent()).toContain('신청 받는 중')
    await fa.locator('[data-stats-view="daily"]').click()
    await fa.locator('[data-stats="daily"] tr.today').waitFor(wait)
    await fa.locator('[data-stats-view="person"]').click()
    await fa.locator('[data-stats="person"]').waitFor(wait)
    await fa.locator('[data-stats-view="dept"]').click()
    await fa.locator('[data-stats="dept"]').waitFor(wait)
    await fa.locator('nav [data-tab="apply"]').click()
  }, 90000)

  it('a public holiday is not served', async () => {
    const fb = frame(b.page)
    const d = new Date(Date.now() + 86400000)
    const tomorrow = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const r = await a.page.evaluate(async (date) => {
      const c = await window.teamhub.invoke('conn:get', undefined as never)
      const res = await fetch(`${c.serverUrl}/api/admin/holidays/${date}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1' },
        body: JSON.stringify({ name: '임시공휴일E2E' })
      })
      return res.status
    }, tomorrow)
    expect(r).toBe(200)
    // the list of holidays is read when the extension opens
    await go(b.page, '/plugins')
    await expect.poll(() => b.page.locator('[data-testid="plugin-frame"]').count(), { timeout: 10000 }).toBe(0)
    await open(b.page, '.day.today')
    await expect.poll(() => fb.locator('.day').count(), { timeout: 15000 }).toBe(1)
    expect(await fb.locator(`[data-holiday="${tomorrow}"]`).textContent()).toContain('임시공휴일E2E')
  }, 90000)
  it('확실히 신청안함: once the member marks it, nobody else can request or cancel that meal for them; only they take it back (1.6.0)', async () => {
    const fa = frame(a.page)
    const fb = frame(b.page)
    const wait = { timeout: 15000 }
    // 팀원B's dinner today was requested for them by the admin; they mark it 확실히 신청안함
    const dinner = fb.locator('.day.today [data-tile$=":dinner"]')
    await expect.poll(() => dinner.textContent(), wait).toContain('신청함')
    await shot(b.page, 'meal-firm-button')
    // it asks once more first (지시 120): 닫기 leaves the meal as it was
    await dinner.getByRole('button', { name: '확실히 신청안함' }).click()
    const ask = fb.locator('#firmDlg')
    await expect.poll(() => ask.isVisible(), wait).toBe(true)
    expect(await ask.textContent()).toContain('바로 취소됩니다')
    await shot(b.page, 'meal-firm-ask')
    await ask.getByRole('button', { name: '닫기' }).click()
    await expect.poll(() => ask.isVisible(), wait).toBe(false)
    expect(await dinner.textContent()).toContain('신청함')
    await dinner.getByRole('button', { name: '확실히 신청안함' }).click()
    await ask.getByRole('button', { name: '확실히 신청안함' }).click()
    await expect.poll(() => dinner.textContent(), wait).toContain('대신 신청 불가')
    expect(await dinner.locator('.state').textContent()).toContain('확실히 신청안함')
    expect(await dinner.getByRole('button', { name: '표시 풀기' }).isVisible()).toBe(true)
    await shot(b.page, 'meal-firm-tile')

    // 현황 on the admin's PC: not among those eating, listed apart, and cannot be picked for 대신 신청
    await open(a.page, '.day.today')
    await fa.locator('nav [data-tab="status"]').click()
    const dinnerA = fa.locator('[data-status="dinner"]')
    await expect.poll(() => dinnerA.locator('[data-declined="dinner"]').textContent(), wait).toContain('팀원B')
    const eating = dinnerA.locator('[data-who]', { hasText: '팀원B' })
    expect(await eating.count()).toBe(0)
    const opt = dinnerA.locator('.proxy select option', { hasText: '팀원B' })
    expect(await opt.isDisabled()).toBe(true)
    expect(await opt.textContent()).toContain('대신 신청 불가')
    await shot(a.page, 'meal-firm-status')

    // 여러 명 대신 신청: the mark with the reason, the box cannot be ticked, for a cancel neither
    await fa.locator('#bulkOpen').click()
    await fa.locator('#bulkPeople .bulk-group').first().waitFor(wait)
    const row = fa.locator('#bulkPeople label:has([data-bstatus="firm"])')
    await expect.poll(() => row.count(), wait).toBe(1)
    expect(await row.locator('> span').first().textContent()).toBe('팀원B')
    expect(await row.locator('[data-bstatus="firm"]').textContent()).toContain('본인 신청안함')
    expect(await row.textContent()).toContain('대신 신청 불가')
    expect(await row.locator('input[data-bid]').isDisabled()).toBe(true)
    await shot(a.page, 'meal-firm-bulk')
    await fa.locator('input[name="bulkAct"][value="off"]').check()
    expect(await row.locator('input[data-bid]').isDisabled()).toBe(true)
    await fa.locator('#bulkClose').click()

    // a client that does not look (an older screen, a changed script) writes a request for them
    // anyway: the save is refused by the extension, and a record written regardless does not count
    const fr = await frameOf(a.page)
    const forced = await fr.evaluate(async () => {
      // the extension's own globals, untyped here
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any
      const M = w.Meal
      const all = await w.TeamHub.call('rooms.list')
      const room = M.pickRoom(all)
      const me = await w.TeamHub.call('me')
      const target = (await w.TeamHub.call('members')).find((m: { name: string }) => m.name === '팀원B')
      const d = new Date()
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const config = M.withHolidays(M.effective(room).config, [])
      const mine = room.entries[me.id] ? room.entries[me.id].value : null
      const refused = M.applyFor(mine, config, { id: target.id, name: target.name }, today, 'dinner', true, Date.now(), room).error || ''
      const r = M.applyFor(mine, config, { id: target.id, name: target.name }, today, 'dinner', true, Date.now() + 60000)
      await w.TeamHub.call('rooms.setEntry', { roomId: room.id, value: r.entry })
      return refused
    })
    expect(forced).toContain('확실히 신청안함')
    await a.page.waitForTimeout(1500)
    expect(await dinnerA.locator('[data-declined="dinner"]').textContent()).toContain('팀원B')
    expect(await eating.count()).toBe(0)
    expect(await dinner.textContent()).toContain('대신 신청 불가')

    // 내 기록 shows it as the member's own certain "no"
    await fb.locator('nav [data-tab="mine"]').click()
    await expect.poll(() => fb.locator('table[data-mine="days"] tr.today').textContent(), wait).toContain('신청안함')
    expect(await fb.locator('table[data-mine="days"] tr.today').textContent()).toContain('본인 확정')
    await fb.locator('nav [data-tab="apply"]').click()

    // only the member takes it back; what was written while it stood does not come back
    await dinner.getByRole('button', { name: '표시 풀기' }).click()
    await expect.poll(() => dinner.textContent(), wait).toContain('신청 안 함')
    expect(await dinner.textContent()).not.toContain('대신 신청 불가')
    await expect.poll(() => dinnerA.locator('[data-declined="dinner"]').count(), wait).toBe(0)
    // (the record forced in carried a clock one minute ahead: it still counts as written when the server stored it)
    expect(await eating.count()).toBe(0)
    // from now on anybody may again: the admin requests it for them through the list
    await expect.poll(() => opt.isDisabled(), wait).toBe(false)
    await dinnerA.locator('.proxy select').selectOption((await opt.getAttribute('value'))!)
    await dinnerA.getByRole('button', { name: '대신 신청', exact: true }).click()
    await expect.poll(() => eating.count(), wait).toBe(1)
    await expect.poll(() => dinner.textContent(), wait).toContain('신청함')
    expect(await dinner.textContent()).toContain('서버관리자 대신')
  }, 120000)

  it('the server keeps the deadline even when the screen is bypassed; 식대 단가 and the 식대 정산 table (1.7.0)', async () => {
    const fa = frame(a.page)
    const fb = frame(b.page)
    const wait = { timeout: 15000 }
    const pad = (n: number) => String(n).padStart(2, '0')
    const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const now = new Date()
    const today = ymd(now)
    // the price of the month, and a new one from today (from the month before when today is the 1st)
    const first = ymd(now.getDate() === 1 ? new Date(now.getFullYear(), now.getMonth() - 1, 1) : new Date(now.getFullYear(), now.getMonth(), 1))

    // the admin opens today's lunch for a while and sets the prices
    await open(a.page, '.day.today')
    await fa.locator('#settingsTab').click()
    await fa.locator('#cut-lunch').fill('23:59')
    expect(await fa.locator('#priceEmpty').isVisible()).toBe(true)
    await fa.locator('#priceAdd').click()
    const row = fa.locator('#priceRows tr').first()
    await row.locator('[data-price="from"]').fill(first)
    await row.locator('[data-price="lunch"]').fill('8000')
    await row.locator('[data-price="dinner"]').fill('9000')
    await fa.locator('#priceAdd').click()
    // a new row starts from the prices of the newest one
    expect(await row.locator('[data-price="dinner"]').inputValue()).toBe('9000')
    await row.locator('[data-price="from"]').fill(today)
    await row.locator('[data-price="lunch"]').fill('8500')
    await fa.locator('#settings button[type=submit]').click()
    await fa.locator('.day.today').waitFor(wait)
    await fa.locator('#settingsTab').click()
    await expect.poll(() => fa.locator('#priceRows tr').count(), wait).toBe(2)
    expect(await fa.locator('#priceRows tr').first().locator('[data-price="lunch"]').inputValue()).toBe('8500')
    expect(await fa.locator('#priceStamp').textContent()).toContain('마지막 저장: 서버관리자')
    await fa.locator('#priceCard').scrollIntoViewIfNeeded()
    await shot(a.page, 'meal-prices')
    await fa.locator('nav [data-tab="apply"]').click()

    // today's lunch: 팀원B, the admin and somebody registered by hand
    const lunchB = fb.locator('.day.today [data-tile$=":lunch"]')
    await lunchB.getByRole('button', { name: '신청', exact: true }).click()
    await expect.poll(() => lunchB.textContent(), wait).toContain('신청함')
    const lunchA = fa.locator('.day.today [data-tile$=":lunch"]')
    await lunchA.getByRole('button', { name: '신청', exact: true }).click()
    await expect.poll(() => lunchA.textContent(), wait).toContain('신청함')
    const fra = await frameOf(a.page)
    await fra.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any
      const M = w.Meal
      const t = (await w.TeamHub.call('time')).now
      const me = await w.TeamHub.call('me')
      const room = M.pickRoom(await w.TeamHub.call('rooms.list'))
      const id = M.newManualId(Math.random(), t)
      const saved = M.saveAs(room, me.id, t, { people: [{ id, name: '정산E2E', dept: '현장E2E' }] })
      const cur = await w.TeamHub.call('rooms.setShared', { roomId: room.id, shared: saved.shared })
      const config = M.withHolidays(M.effective(cur).config, [])
      const r = M.applyFor(cur.entries[me.id].value, config, { id, name: '정산E2E' }, M.ymd(t), 'lunch', true, t, cur)
      await w.TeamHub.call('rooms.setEntry', { roomId: cur.id, value: r.entry })
    })

    // 팀원B's PC believes it is still early morning (its clock and the server clock it read are both off)
    const frb = await frameOf(b.page)
    await frb.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any
      const d = new Date()
      const skew = Date.now() - new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 30).getTime()
      w.__realNow = Date.now
      w.__realCall = w.TeamHub.call
      Date.now = () => w.__realNow.call(Date) - skew
      w.TeamHub.call = (m: string, p: unknown) => (m === 'time' ? w.__realCall('time').then((r: { now: number }) => ({ ...r, now: r.now - skew })) : w.__realCall(m, p))
    })
    // the admin closes today's lunch (00:05, long past by the server's clock)
    await fa.locator('#settingsTab').click()
    await fa.locator('#cut-lunch').fill('00:05')
    await fa.locator('#settings button[type=submit]').click()
    await fa.locator('.day.today').waitFor(wait)
    await expect.poll(() => lunchA.textContent(), wait).toContain('00:05 마감됨')
    // 팀원B's screen still offers 취소; the server refuses it and the screen says why
    await expect.poll(() => lunchB.textContent(), wait).toContain('00:05 마감 ·')
    await lunchB.getByRole('button', { name: '취소', exact: true }).click()
    await expect.poll(() => fb.locator('#toast').textContent(), wait).toMatch(/점심은 마감 시각\(00:05\)이 지나 바꿀 수 없습니다\.$/)
    await shot(b.page, 'meal-server-refusal')
    expect(await lunchB.textContent()).toContain('신청함')

    // writing the entry straight from the frame, without the extension's checks: refused as well
    const direct = await frb.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any
      w.Date.now = w.__realNow
      w.TeamHub.call = w.__realCall
      const M = w.Meal
      const room = M.pickRoom(await w.TeamHub.call('rooms.list'))
      const me = await w.TeamHub.call('me')
      const mine = JSON.parse(JSON.stringify(room.entries[me.id].value))
      mine.days[M.ymd(Date.now())].lunch = { on: false, at: Date.now() }
      try {
        await w.TeamHub.call('rooms.setEntry', { roomId: room.id, value: mine })
        return 'saved'
      } catch (e) {
        return (e as Error).message
      }
    })
    expect(direct).toMatch(/^\d+\/\d+\(.\) 점심은 마감 시각\(00:05\)이 지나 바꿀 수 없습니다\.$/)
    // and so is a cancel for 팀원B by somebody else (대신 취소)
    const proxy = await fra.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any
      const M = w.Meal
      const room = M.pickRoom(await w.TeamHub.call('rooms.list'))
      const me = await w.TeamHub.call('me')
      const target = (await w.TeamHub.call('members')).find((m: { name: string }) => m.name === '팀원B')
      const mine = JSON.parse(JSON.stringify(room.entries[me.id].value))
      const others = mine.for || (mine.for = {})
      others[target.id] = others[target.id] || { name: target.name, days: {} }
      others[target.id].days[M.ymd(Date.now())] = { ...others[target.id].days[M.ymd(Date.now())], lunch: { on: false, at: Date.now() } }
      try {
        await w.TeamHub.call('rooms.setEntry', { roomId: room.id, value: mine })
        return 'saved'
      } catch (e) {
        return (e as Error).message
      }
    })
    expect(proxy).toContain('팀원B 님의')
    expect(proxy).toContain('마감 시각(00:05)이 지나 바꿀 수 없습니다.')

    // 통계 → 식대 정산: three lunches of today at today's price, the person registered by hand included
    await fa.locator('#statsTab').click()
    await fa.locator('[data-stats-view="settle"]').click()
    const settle = fa.locator('[data-stats="settle"]')
    await settle.waitFor(wait)
    expect(await settle.locator('.th-card-header').textContent()).toContain('점심 8,500원')
    const hand = settle.locator('tr[data-settle^="x:"]', { hasText: '정산E2E' })
    expect(await hand.textContent()).toContain('미등록')
    expect(await hand.locator('td').allTextContents()).toEqual(['현장E2E', '정산E2E 미등록', '1', '0', '8,500', '0', '8,500'])
    expect(await settle.locator('tr[data-settle-dept="현장E2E"]').textContent()).toContain('소계 1명')
    const total = settle.locator('tr[data-settle-total] td')
    expect(await total.allTextContents()).toEqual(['합계', '3명 (미등록 1명 포함)', '3', '0', '25,500', '0', '25,500'])
    expect(await a.page.locator('[data-testid="plugin-frame"]').count()).toBe(1)
    expect(await fa.locator('#printSettle').isEnabled()).toBe(true)
    await shot(a.page, 'meal-settle')
    await fa.locator('nav [data-tab="apply"]').click()
  }, 150000)
})
