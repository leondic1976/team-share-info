import { describe, it, expect, afterAll } from 'vitest'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47919'
const frame = (p: Page) => p.frameLocator('[data-testid="plugin-frame"]')
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
    expect(await fb.locator('#oldApp').isVisible()).toBe(false)
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

    // the admin registers a colleague who does not use TeamHub
    await fa.locator('#settingsTab').click()
    await fa.locator('#personAdd').click()
    await fa.locator('#p-name').fill('팀원B')
    expect(await fa.locator('#personWarn').textContent()).toContain('같은 이름의 구성원')
    await fa.locator('#p-name').fill('미등록E2E')
    await fa.locator('#p-dept').fill('현장E2E')
    await fa.locator('#personSave').click()
    await fa.locator('#peopleCard tr[data-person]').waitFor(wait)
    expect(await fa.locator('#peopleCard tbody').textContent()).toContain('미등록E2E')
    expect(await fa.locator('#peopleCard tbody .th-badge').first().textContent()).toBe('미등록')

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

    // removed from the list: no longer offered, the request already made stays under the name
    await fa.locator('#settingsTab').click()
    await fa.locator('#peopleCard [data-person-del]').click()
    expect(await fa.locator('#peopleCard [data-person-del]').textContent()).toBe('정말 삭제')
    await fa.locator('#peopleCard [data-person-del]').click()
    await expect.poll(() => fa.locator('#peopleCard tr[data-person]').count(), wait).toBe(0)
    await fa.locator('nav [data-tab="status"]').click()
    expect(await dinnerA.textContent()).toContain('미등록E2E')
  }, 120000)

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
})
