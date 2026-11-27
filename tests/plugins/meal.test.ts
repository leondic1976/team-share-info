import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { entryRefusal, mealCutoffs, mealEntryGuard, MEAL_LOCK_DAYS, MEAL_TRIM_FLOOR } from '../../src/server/plugin-locks'
import { mealPeopleOf } from '../../src/server/meal-people'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx: Record<string, any> = {}
runInNewContext(readFileSync(join(import.meta.dirname, '../../resources/meal/meal.js'), 'utf8'), ctx)
const M = ctx.Meal

// Monday 2026-11-23
const at = (date: string, h: number, m = 0): number => {
  const [y, mo, d] = date.split('-').map(Number)
  return new Date(y, mo - 1, d, h, m).getTime()
}
const MON = '2026-11-23'
const config = M.cleanConfig({ meals: { lunch: { cutoff: '10:30' }, dinner: { cutoff: '15:30' } }, ahead: 7 })

describe('meal plugin: settings', () => {
  it('fills in defaults and refuses odd values', () => {
    const c = M.cleanConfig({ meals: { lunch: { on: false, cutoff: '9:05' }, dinner: { cutoff: '25:00' } }, ahead: 99, notice: ' 구내식당 ' })
    expect(c.holidays).toBe(true)
    expect(Array.from(c.clerks)).toEqual([])
    expect(c).toMatchObject({ kind: 'meal', meals: { lunch: { on: false, cutoff: '09:05' }, dinner: { on: true, cutoff: '15:30' } }, weekend: false, ahead: 7, notice: '구내식당' })
    expect(M.isConfig(c)).toBe(true)
    expect(M.isConfig({ questions: [] })).toBe(false)
  })
  it('uses the oldest settings room', () => {
    const rooms = [{ id: 'b', createdAt: 20, shared: config }, { id: 'x', createdAt: 5, shared: { other: 1 } }, { id: 'a', createdAt: 10, shared: config }]
    expect(M.pickRoom(rooms).id).toBe('a')
    expect(M.pickRoom([])).toBeNull()
  })
  it('lists the days a request can be made for, without the weekend unless it is on', () => {
    expect(Array.from(M.upcoming(config, at(MON, 9)))).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27'])
    expect(M.upcoming(M.cleanConfig({ ...config, weekend: true }), at(MON, 9))).toHaveLength(7)
    expect(Array.from(M.upcoming(M.cleanConfig({ ...config, ahead: 1 }), at(MON, 9)))).toEqual([MON])
  })
})

describe('meal plugin: request, cancel, request again until the deadline', () => {
  it('is open before the deadline and closed from that minute on', () => {
    expect(M.stateOf(config, MON, 'lunch', at(MON, 10, 29))).toBe('open')
    expect(M.stateOf(config, MON, 'lunch', at(MON, 10, 30))).toBe('closed')
    expect(M.stateOf(config, MON, 'dinner', at(MON, 10, 30))).toBe('open')
    expect(M.stateOf(config, '2026-11-28', 'lunch', at(MON, 9))).toBe('off') // Saturday
    expect(M.stateOf(M.cleanConfig({ meals: { dinner: { on: false } } }), MON, 'dinner', at(MON, 9))).toBe('off')
    expect(M.remaining(M.cutoffAt(config, MON, 'lunch') - at(MON, 9, 10))).toBe('1시간 20분 남음')
    expect(M.remaining(0)).toBe('마감')
  })

  it('requests, cancels and requests again, each time before the deadline', () => {
    let r = M.apply(null, config, MON, 'lunch', true, at(MON, 9))
    expect(M.wants(r.entry, MON, 'lunch')).toBe(true)
    expect(M.wants(r.entry, MON, 'dinner')).toBe(false)
    r = M.apply(r.entry, config, MON, 'lunch', false, at(MON, 9, 30))
    expect(M.wants(r.entry, MON, 'lunch')).toBe(false)
    expect(M.requestedAt(r.entry, MON, 'lunch')).toBe(at(MON, 9, 30))
    r = M.apply(r.entry, config, MON, 'lunch', true, at(MON, 10, 29))
    expect(M.wants(r.entry, MON, 'lunch')).toBe(true)
    // another day and another meal do not disturb it
    r = M.apply(r.entry, config, '2026-11-24', 'dinner', true, at(MON, 10, 29))
    expect(M.wants(r.entry, MON, 'lunch')).toBe(true)
    expect(M.wants(r.entry, '2026-11-24', 'dinner')).toBe(true)
  })

  it('changes nothing after the deadline', () => {
    const before = M.apply(null, config, MON, 'lunch', true, at(MON, 9)).entry
    const late = M.apply(before, config, MON, 'lunch', false, at(MON, 10, 30))
    expect(late.error).toBe('11/23(월) 점심은 마감 시각(10:30)이 지나 바꿀 수 없습니다.')
    expect(late.entry).toBeUndefined()
    expect(M.apply(null, config, MON, 'lunch', true, at(MON, 11)).error).toContain('마감')
    // dinner of the same day is still open, tomorrow's lunch too
    expect(M.apply(before, config, MON, 'dinner', true, at(MON, 11)).entry).toBeTruthy()
    expect(M.apply(before, config, '2026-11-24', 'lunch', true, at(MON, 11)).entry).toBeTruthy()
  })

  it('refuses days that are not served or too far ahead, and drops old days', () => {
    expect(M.apply(null, config, '2026-11-28', 'lunch', true, at(MON, 9)).error).toContain('받지 않는 날')
    expect(M.apply(null, config, '2026-12-07', 'lunch', true, at(MON, 9)).error).toContain('아직')
    expect(M.apply(null, config, 'nonsense', 'lunch', true, at(MON, 9)).error).toBeTruthy()
    const old = { days: { '2026-07-01': { lunch: { on: true, at: 1 } }, '2026-11-20': { lunch: { on: true, at: 2 } } } }
    const r = M.apply(old, config, MON, 'lunch', true, at(MON, 9))
    expect(Object.keys(r.entry.days).sort()).toEqual(['2026-11-20', MON])
  })
})

describe('meal plugin: public holidays', () => {
  // Wednesday 2026-11-25 made a holiday
  const hol = M.withHolidays(config, [{ date: '2026-11-25', name: '임시공휴일' }, { date: 'bad', name: 'x' }])
  it('does not serve a holiday, and says why', () => {
    expect(config.holidays).toBe(true)
    expect(M.stateOf(hol, '2026-11-25', 'lunch', at(MON, 9))).toBe('off')
    expect(Array.from(M.upcoming(hol, at(MON, 9)))).toEqual(['2026-11-23', '2026-11-24', '2026-11-26', '2026-11-27'])
    expect(JSON.parse(JSON.stringify(M.skipped(hol, at(MON, 9))))).toEqual([{ date: '2026-11-25', name: '임시공휴일' }])
    expect(M.apply(null, hol, '2026-11-25', 'lunch', true, at(MON, 9)).error).toContain('공휴일(임시공휴일)')
    expect(M.apply(null, hol, '2026-11-24', 'lunch', true, at(MON, 9)).entry).toBeTruthy()
  })
  it('serves holidays when the admin turns the option off', () => {
    const on = M.withHolidays(M.cleanConfig({ ...config, holidays: false }), [{ date: '2026-11-25', name: '임시공휴일' }])
    expect(M.stateOf(on, '2026-11-25', 'lunch', at(MON, 9))).toBe('open')
    expect(M.skipped(on, at(MON, 9))).toHaveLength(0)
  })
})

describe('meal plugin: anybody requests for somebody else', () => {
  const shared = M.cleanConfig({ ...config, clerks: ['clerk', 'clerk', 5] })
  const members = [{ id: 'adm', name: '관리자', deptName: '' }, { id: 'clerk', name: '서무', deptName: '행정팀' }, { id: 'kim', name: '김주무', deptName: '행정팀' }, { id: 'lee', name: '이주무', deptName: '민원팀' }]
  const room = (entries: Record<string, any>) => ({ createdBy: 'adm', shared, entries })
  const names = (r: any, meal = 'lunch') => M.dayList(r, MON, meal, members).map((p: any) => p.name + (p.by ? `(${p.byName})` : ''))

  it('every member may (1.4.0), not without the settings or an id', () => {
    expect(Array.from(shared.clerks)).toEqual(['clerk'])
    expect([M.canProxy(room({}), 'adm'), M.canProxy(room({}), 'clerk'), M.canProxy(room({}), 'kim'), M.canProxy(null, 'adm'), M.canProxy(room({}), ''), M.canProxy(room({}), undefined)]).toEqual([true, true, true, false, false, false])
  })

  it('requests and cancels for a member, under the same deadline', () => {
    let r = M.applyFor(null, shared, { id: 'kim', name: '김주무' }, MON, 'lunch', true, at(MON, 9))
    expect(names(room({ clerk: { name: '서무', value: r.entry } }))).toEqual(['김주무(서무)'])
    // the clerk's own request stays apart
    r = M.apply(r.entry, shared, MON, 'lunch', true, at(MON, 9, 5))
    expect(names(room({ clerk: { name: '서무', value: r.entry } }))).toEqual(['김주무(서무)', '서무'])
    r = M.applyFor(r.entry, shared, { id: 'kim', name: '김주무' }, MON, 'lunch', false, at(MON, 9, 10))
    expect(names(room({ clerk: { name: '서무', value: r.entry } }))).toEqual(['서무'])
    expect(M.applyFor(r.entry, shared, { id: 'kim', name: '김주무' }, MON, 'lunch', true, at(MON, 10, 30)).error).toContain('마감')
    expect(M.applyFor(r.entry, shared, null, MON, 'lunch', true, at(MON, 9)).error).toContain('고르세요')
  })

  it('the newest of the own request and the one made for the member counts', () => {
    const byClerk = M.applyFor(null, shared, { id: 'kim', name: '김주무' }, MON, 'lunch', true, at(MON, 9)).entry
    const own = (on: boolean, h: number, m: number) => ({ name: '김주무', value: M.apply(null, shared, MON, 'lunch', on, at(MON, h, m)).entry })
    // the member cancels later: not eating
    expect(names(room({ clerk: { name: '서무', value: byClerk }, kim: own(false, 9, 30) }))).toEqual([])
    // the member had cancelled earlier, the clerk requested after that: eating
    const r = room({ clerk: { name: '서무', value: byClerk }, kim: own(false, 8, 0) })
    expect(names(r)).toEqual(['김주무(서무)'])
    expect(M.recordOf(r, members, 'kim', MON, 'lunch')).toMatchObject({ on: true, by: 'clerk', byName: '서무' })
    expect(M.monthTally(r, '2026-11', members, at(MON, 11), false).rows.map((x: any) => [x.deptName, x.name, x.lunch])).toEqual([['행정팀', '김주무', 1]])
  })

  it('counts what a member who is not in charge requested for another, shown as made by them', () => {
    const byLee = M.applyFor(null, shared, { id: 'kim', name: '김주무' }, MON, 'lunch', true, at(MON, 9)).entry
    const r = room({ lee: { name: '이주무', value: byLee } })
    expect(names(r)).toEqual(['김주무(이주무)'])
    expect(M.recordOf(r, members, 'kim', MON, 'lunch')).toMatchObject({ on: true, by: 'lee', byName: '이주무' })
    // a clerk who is no longer one, too
    expect(names({ createdBy: 'adm', shared: M.cleanConfig(config), entries: { clerk: { name: '서무', value: byLee } } })).toEqual(['김주무(서무)'])
    // a member cancels the meal of another: the newest counts, and the member can take it back
    const cancel = M.applyFor(null, shared, { id: 'kim', name: '김주무' }, MON, 'lunch', false, at(MON, 9, 10)).entry
    const kimOwn = { name: '김주무', value: M.apply(null, shared, MON, 'lunch', true, at(MON, 9, 5)).entry }
    expect(names(room({ kim: kimOwn, lee: { name: '이주무', value: cancel } }))).toEqual([])
    const again = { name: '김주무', value: M.apply(null, shared, MON, 'lunch', true, at(MON, 9, 20)).entry }
    expect(names(room({ kim: again, lee: { name: '이주무', value: cancel } }))).toEqual(['김주무'])
  })

  it('ignores a record made by a member for somebody who does not exist; those in charge are trusted as before', () => {
    const ghost = M.applyFor(null, shared, { id: 'ghost', name: '가짜' }, MON, 'lunch', true, at(MON, 9)).entry
    expect(names(room({ lee: { name: '이주무', value: ghost } }))).toEqual([])
    expect(M.monthTally(room({ lee: { name: '이주무', value: ghost } }), '2026-11', members, at(MON, 11), false).rows).toEqual([])
    // somebody with an entry of their own (a member who has left keeps their meals) does count
    const own = { name: '박전임', value: M.apply(null, shared, '2026-11-24', 'lunch', true, at(MON, 9)).entry }
    expect(names(room({ ghost: own, lee: { name: '이주무', value: ghost } }))).toEqual(['박전임(이주무)'])
    // the owner's record for somebody no longer on the list still counts
    expect(names(room({ adm: { name: '관리자', value: ghost } }))).toEqual(['가짜(관리자)'])
  })

  it('keeps requests made for others for a shorter time', () => {
    const old = { days: {}, for: { kim: { name: '김주무', days: { '2026-08-01': { lunch: { on: true, at: 1 } }, '2026-11-20': { lunch: { on: true, at: 2 } } } }, lee: { name: '이주무', days: { '2026-08-01': { lunch: { on: true, at: 1 } } } } } }
    const r = M.applyFor(old, shared, { id: 'kim', name: '김주무' }, MON, 'dinner', true, at(MON, 9))
    expect(Object.keys(r.entry.for)).toEqual(['kim'])
    expect(Object.keys(r.entry.for.kim.days).sort()).toEqual(['2026-11-20', MON])
  })
})

describe('meal plugin: who eats, and the monthly count', () => {
  const entry = (days: Record<string, any>) => ({ v: 1, days })
  const room = {
    shared: config,
    entries: {
      a: { name: '가나', value: entry({ [MON]: { lunch: { on: true, at: at(MON, 9) }, dinner: { on: true, at: at(MON, 9) } }, '2026-11-20': { lunch: { on: true, at: 1 } } }) },
      b: { name: '다라', value: entry({ [MON]: { lunch: { on: true, at: at(MON, 8) } }, '2026-10-30': { lunch: { on: true, at: 1 } } }) },
      c: { name: '마바', value: entry({ [MON]: { lunch: { on: false, at: at(MON, 10) } } }) }
    }
  }
  const members = [{ id: 'a', name: '가나', deptName: '행정팀' }, { id: 'b', name: '다라', deptName: '민원팀' }]

  it('lists who asked for a meal on a day, by department', () => {
    expect(M.dayList(room, MON, 'lunch', members).map((p: any) => `${p.deptName}/${p.name}`)).toEqual(['민원팀/다라', '행정팀/가나'])
    expect(M.dayList(room, MON, 'dinner', members).map((p: any) => p.name)).toEqual(['가나'])
    expect(M.orderText(room, MON, members, MON)).toBe('오늘 11/23(월) 점심 2명: 다라, 가나\n오늘 11/23(월) 저녁 1명: 가나')
  })

  it('counts only meals whose deadline has passed', () => {
    // Monday 11:00: lunch is fixed, dinner still open
    const t = M.monthTally(room, '2026-11', members, at(MON, 11), false)
    expect(t.rows.map((r: any) => [r.name, r.lunch, r.dinner])).toEqual([['다라', 1, 0], ['가나', 2, 0]])
    expect([t.lunch, t.dinner]).toEqual([3, 0])
    expect(M.monthTally(room, '2026-11', members, at(MON, 16), false).dinner).toBe(1)
    expect(M.monthTally(room, '2026-10', members, at(MON, 11), false).rows.map((r: any) => r.name)).toEqual(['다라'])
    const csv = M.monthCsv(room, '2026-11', members, at(MON, 16))
    expect(csv).toContain('부서,이름,점심,저녁,합계')
    expect(csv).toContain('행정팀,가나,2,1,3')
    expect(csv).toContain(',합계,3,1,4')
  })

  it('statistics (지시 90): day by day, by department, the month at a glance, CSV', () => {
    const now = at(MON, 16)
    const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
    const daily = M.dailyTally(room, '2026-11', members, now)
    expect(daily).toHaveLength(30)
    const mon = daily.find((d: any) => d.date === MON)
    expect(plain(mon.meals)).toEqual({ lunch: { count: 2, closed: true, proxied: 0, manual: 0, declined: 0 }, dinner: { count: 1, closed: true, proxied: 0, manual: 0, declined: 0 } })
    expect(daily.find((d: any) => d.date === '2026-11-01').served).toBe(false)
    expect(plain(M.deptTally(room, '2026-11', members, now))).toEqual([
      { dept: '민원팀', people: 1, lunch: 1, dinner: 0 },
      { dept: '행정팀', people: 1, lunch: 2, dinner: 1 }
    ])
    const sm = M.monthSummary(room, '2026-11', members, now)
    // weekdays of November up to Monday the 23rd: 16 days have closed
    expect(plain(sm)).toEqual({ lunch: 3, dinner: 1, total: 4, days: 16, avgLunch: 0.2, avgDinner: 0.1, peak: { date: MON, meal: 'lunch', count: 2 }, people: 2, manualPeople: 0, proxied: 0, pending: { lunch: 0, dinner: 0 }, declined: { lunch: 0, dinner: 0 } })
    // Monday 11:00: the dinner of that day is still open
    expect(plain(M.monthSummary(room, '2026-11', members, at(MON, 11)).pending)).toEqual({ lunch: 0, dinner: 1 })
    const snap = M.statsSnapshot(room, '2026-11', members, now)
    expect(M.dailyCsv(snap)).toContain('날짜,점심,저녁,합계,비고')
    expect(M.dailyCsv(snap)).toContain(`${MON},2,1,3,`)
    expect(M.dailyCsv(snap)).toContain('2026-11-01,,,,받지 않는 날')
    expect(M.deptCsv(snap)).toContain('행정팀,1,2,1,3')
    expect(M.personCsv(snap)).toContain('행정팀,가나,2,1,3')
    // a copy saved earlier counts when it holds more (old records are dropped after 100 days)
    const fuller = { ...snap, summary: { ...snap.summary, total: 9 } }
    expect(M.betterOf(snap, fuller)).toBe(fuller)
    expect(M.betterOf(snap, { ...snap, summary: { ...snap.summary, total: 1 } })).toBe(snap)
    expect(M.betterOf(snap, null)).toBe(snap)
  })

  it('내 기록 (지시 91): a person: the days, final and open counts, the recent months', () => {
    const now = at(MON, 11)
    const a = M.personMonth(room, members, 'a', '2026-11', now)
    expect(a.days.filter((d: any) => d.any).map((d: any) => d.date)).toEqual(['2026-11-20', MON])
    expect([a.done, a.open].map((x: any) => JSON.parse(JSON.stringify(x)))).toEqual([{ lunch: 2, dinner: 0 }, { lunch: 0, dinner: 1 }])
    const c = M.personMonth(room, members, 'c', '2026-11', now)
    expect(JSON.parse(JSON.stringify(c.days.find((d: any) => d.date === MON).meals.lunch))).toEqual({ on: false, by: '', byName: '', at: at(MON, 10), closed: true })
    expect(JSON.parse(JSON.stringify(c.done))).toEqual({ lunch: 0, dinner: 0 })
    expect(JSON.parse(JSON.stringify(M.personMonths(room, members, 'b', at(MON, 16), 2)))).toEqual([
      { month: '2026-11', lunch: 1, dinner: 0 },
      { month: '2026-10', lunch: 1, dinner: 0 }
    ])
  })
})

describe('meal plugin: menus (per day and meal) and the week', () => {
  const TUE = '2026-11-24'
  it('cleans a cell: trimmed lines, no blanks, caps; the note of a day is one line', () => {
    expect(M.cleanMenuText('lunch', '  쌀밥 \r\n\r\n 된장국\t \n김치 ')).toBe('쌀밥\n된장국\n김치')
    expect(M.cleanMenuText('lunch', Array.from({ length: 20 }, (_, i) => `반찬${i}`).join('\n')).split('\n')).toHaveLength(M.LIMITS.menuLines)
    expect(M.cleanMenuText('dinner', '가'.repeat(500))).toHaveLength(M.LIMITS.menuText)
    expect(M.cleanMenuText('note', ' 행사로\n외식 ')).toBe('행사로 외식')
    expect(M.cleanMenuText('note', '가'.repeat(500))).toHaveLength(M.LIMITS.menuNote)
    expect(JSON.parse(JSON.stringify(M.cleanMenus({ [TUE]: { lunch: { t: ' 밥 ', at: 5, by: 'adm' }, dinner: { t: '국' }, snack: { t: 'x', at: 1 } }, bad: { lunch: { t: 'x', at: 1 } } }, true)))).toEqual({ [TUE]: { lunch: { t: '밥', at: 5, by: 'adm' } } })
  })

  it('knows the week of a day and which of its days are served', () => {
    expect([M.weekStart(MON), M.weekStart('2026-11-29'), M.weekStart('2026-11-30')]).toEqual([MON, MON, '2026-11-30'])
    const hol = M.withHolidays(config, [{ date: '2026-11-25', name: '임시공휴일' }])
    expect(M.weekDays(hol, MON).map((d: any) => [d.date.slice(8), d.served, d.why])).toEqual([['23', true, ''], ['24', true, ''], ['25', false, '임시공휴일'], ['26', true, ''], ['27', true, '']])
    expect(M.weekDays(M.cleanConfig({ ...config, weekend: true }), MON)).toHaveLength(7)
    expect(Array.from(M.menuMeals(M.cleanConfig({ meals: { dinner: { on: false } } })))).toEqual(['lunch'])
    expect(JSON.parse(JSON.stringify(M.menuWindow(at(TUE, 9))))).toEqual({ from: '2026-09-28', to: '2027-01-24' })
  })

  it('writes the week as text, with unregistered and unserved days said so', () => {
    const hol = M.withHolidays(config, [{ date: '2026-11-25', name: '임시공휴일' }])
    const menus = { [MON]: { lunch: { t: '쌀밥\n된장국', at: 1 }, note: { t: '행사로 외식', at: 1 } }, [TUE]: { dinner: { t: '', at: 2 } } }
    const text = M.weekText(hol, menus, MON)
    expect(text.split('\n').slice(0, 5)).toEqual(['주간 메뉴 11/23(월)~11/27(금)', '', '11/23(월) (행사로 외식)', '  점심: 쌀밥, 된장국', '  저녁: 메뉴 미등록'])
    expect(text).toContain('11/25(수)\n  공휴일(임시공휴일)')
    expect(M.menuOf(menus, TUE, 'dinner')).toBe('')
    expect(M.menuOf(menus, '2026-12-01', 'lunch')).toBe('')
  })

  it('reads a block copied from a spreadsheet and places it, turning a sheet with the days across', () => {
    expect(JSON.parse(JSON.stringify(M.parseBlock('밥\t"국\n김치"\r\n"그는 ""밥""이라 했다"\t\r\n')))).toEqual([['밥', '국\n김치'], ['그는 "밥"이라 했다', '']])
    // rows = days, columns = lunch, dinner, note
    expect(JSON.parse(JSON.stringify(M.placeBlock([['a', 'b'], ['c', 'd']], 5, 3, 1, 0)))).toEqual([{ r: 1, c: 0, t: 'a' }, { r: 1, c: 1, t: 'b' }, { r: 2, c: 0, t: 'c' }, { r: 2, c: 1, t: 'd' }])
    // a sheet with Monday to Friday across and lunch, dinner down is turned
    const turned = M.placeBlock([['월점', '화점', '수점', '목점', '금점'], ['월저', '화저', '수저', '목저', '금저']], 5, 3, 0, 0)
    expect(turned).toHaveLength(10)
    expect(JSON.parse(JSON.stringify(turned.filter((x: any) => x.r === 1)))).toEqual([{ r: 1, c: 0, t: '화점' }, { r: 1, c: 1, t: '화저' }])
    // what does not fit is left out
    expect(M.placeBlock([['a', 'b', 'c', 'd']], 2, 3, 1, 2).map((x: any) => `${x.r}${x.c}${x.t}`)).toEqual(['12a'])
  })
})

describe('meal plugin: 식수서무 (at most two) share the settings and the menus with the owner', () => {
  const TUE = '2026-11-24'
  const base = (extra: Record<string, any> = {}) => ({ ...M.cleanConfig({ ...config, stewards: ['s1', 's2'] }), since: { s1: 1, s2: 1 }, settingsAt: at(MON, 8), settingsBy: 'adm', ...extra })
  const room = (shared: any, entries: Record<string, any> = {}) => ({ createdBy: 'adm', shared, entries })
  const e = (value: any, stored?: number) => ({ name: '', value, ...(stored ? { at: stored } : {}) })
  const menu = (t: string, when: number) => ({ t, at: when })
  const late = { ...config, meals: { lunch: { on: true, cutoff: '11:00' }, dinner: { on: true, cutoff: '15:30' } } }
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

  it('names at most two, never the owner; the clerks of before are only offered as 식수서무', () => {
    expect(Array.from(M.cleanConfig({ stewards: ['a', 'a', 'b', 'c', 7] }).stewards)).toEqual(['a', 'b'])
    const old = room(M.cleanConfig({ ...config, clerks: ['c1', 'c2', 'c3'] }))
    expect(['adm', 'c1', 'c3', 'kim'].map((id) => [M.canManage(old, id), M.canProxy(old, id)])).toEqual([[true, true], [false, true], [false, true], [false, true]])
    // the owner saves the settings with two 식수서무: the old clerks are replaced
    const saved = M.saveAs(old, 'adm', at(MON, 9), { settings: config, stewards: ['c1', 'c2', 'c3', 'adm'] }).shared
    expect([Array.from(saved.stewards), Array.from(saved.clerks)]).toEqual([['c1', 'c2'], []])
    expect(plain(saved.since)).toEqual({ c1: at(MON, 9), c2: at(MON, 9) })
    const now = room(saved)
    expect(['c1', 'c2', 'c3'].map((id) => [M.canManage(now, id), M.canProxy(now, id)])).toEqual([[true, true], [true, true], [false, true]])
    expect(plain(M.effective(room({ ...saved, stewards: ['adm', 'c1'] })).stewards)).toEqual(['c1'])
  })

  it('a 식수서무 changes the settings in their own entry; the newest of owner and 식수서무 counts as a whole', () => {
    const r0 = room(base())
    const s = M.saveAs(r0, 's1', at(MON, 9), { settings: { ...late, notice: '식권은 서무에게' }, stewards: ['s1', 'kim', 'lee'] })
    expect(s.shared).toBeUndefined()
    expect(s.entry.stewards).toBeUndefined()
    expect(s.entry).toMatchObject({ settingsAt: at(MON, 9), settings: { meals: { lunch: { cutoff: '11:00' } }, notice: '식권은 서무에게' } })
    const r1 = room(base(), { s1: e(s.entry) })
    const eff = M.effective(r1)
    expect(plain([eff.config.meals.lunch.cutoff, eff.config.notice, eff.settingsBy, eff.settingsAt, eff.stewards])).toEqual(['11:00', '식권은 서무에게', 's1', at(MON, 9), ['s1', 's2']])
    // the deadline everybody is judged by follows, and so does the monthly count
    expect(M.stateOf(eff.config, MON, 'lunch', at(MON, 10, 45))).toBe('open')
    const withReq = room(base(), { s1: e(s.entry), kim: e(M.apply(null, eff.config, MON, 'lunch', true, at(MON, 10, 40)).entry) })
    expect(M.monthTally(withReq, '2026-11', [], at(MON, 10, 50), false).lunch).toBe(0)
    expect(M.monthTally(withReq, '2026-11', [], at(MON, 11), false).lunch).toBe(1)
    // an older decision of the owner loses, a newer one wins; at the same moment the owner's
    expect(M.effective(room(base({ settingsAt: at(MON, 9) }), { s1: e(s.entry) })).config.meals.lunch.cutoff).toBe('10:30')
    expect(M.effective(room(base({ settingsAt: at(MON, 9, 1) }), { s1: e(s.entry) })).settingsBy).toBe('adm')
    // a save must offer a meal
    expect(M.saveAs(r0, 's1', at(MON, 9), { settings: { meals: { lunch: { on: false }, dinner: { on: false } } } }).error).toContain('하나는')
  })

  it('two 식수서무 saving close together: the later one wins, whatever the order of the entries', () => {
    const a = M.saveAs(room(base()), 's1', at(MON, 9, 0), { settings: { ...late, notice: 'A' } }).entry
    const b = M.saveAs(room(base()), 's2', at(MON, 9, 0) + 1, { settings: { ...config, notice: 'B' } }).entry
    expect(M.effective(room(base(), { s1: e(a), s2: e(b) })).config.notice).toBe('B')
    expect(M.effective(room(base(), { s2: e(b), s1: e(a) })).config.notice).toBe('B')
    // exactly the same moment: the one named first, on every PC alike
    const c = M.saveAs(room(base()), 's2', at(MON, 9, 0), { settings: { ...config, notice: 'C' } }).entry
    expect(M.effective(room(base(), { s2: e(c), s1: e(a) })).config.notice).toBe('A')
    // menus are merged per day and slot, so both keep what the other did not touch
    const ma = M.saveAs(room(base()), 's1', at(MON, 9), { menus: [{ date: MON, slot: 'lunch', t: '비빔밥' }, { date: TUE, slot: 'lunch', t: '카레' }] }).entry
    const mb = M.saveAs(room(base(), { s1: e(ma) }), 's2', at(MON, 9, 5), { menus: [{ date: MON, slot: 'lunch', t: '제육덮밥' }, { date: MON, slot: 'dinner', t: '국수' }] }).entry
    const eff = M.effective(room(base(), { s1: e(ma), s2: e(mb) }))
    expect([M.menuOf(eff.menus, MON, 'lunch'), M.menuOf(eff.menus, MON, 'dinner'), M.menuOf(eff.menus, TUE, 'lunch')]).toEqual(['제육덮밥', '국수', '카레'])
    expect([eff.menus[MON].lunch.by, eff.menus[TUE].lunch.by]).toEqual(['s2', 's1'])
    expect(plain(M.menuStamp(eff.menus, [MON, TUE]))).toEqual({ at: at(MON, 9, 5), by: 's2' })
    // a cleared cell wins over an older text
    const cleared = M.saveAs(room(base(), { s1: e(ma), s2: e(mb) }), 's1', at(MON, 9, 10), { menus: [{ date: MON, slot: 'dinner', t: '  ' }] }).entry
    expect(M.menuOf(M.effective(room(base(), { s1: e(cleared), s2: e(mb) })).menus, MON, 'dinner')).toBe('')
  })

  it('ignores settings and menus in the entry of somebody the owner did not name', () => {
    const forged = { v: 1, days: {}, settings: { ...late, notice: '가짜' }, settingsAt: at(MON, 23), menus: { [MON]: { lunch: menu('가짜 메뉴', at(MON, 23)) } }, stewards: ['kim'] }
    const r = room(base(), { kim: e(forged) })
    const eff = M.effective(r)
    expect(plain([eff.config.notice, eff.config.meals.lunch.cutoff, M.menuOf(eff.menus, MON, 'lunch'), eff.stewards])).toEqual(['', '10:30', '', ['s1', 's2']])
    expect(M.saveAs(r, 'kim', at(MON, 9), { menus: [{ date: MON, slot: 'lunch', t: '밥' }] }).error).toContain('식수서무만')
    // neither can a 식수서무 name another one: only the owner's shared data says who is in charge
    const byS1 = { ...forged, stewards: ['kim'] }
    expect(plain(M.effective(room(base(), { s1: e(byS1), kim: e(forged) })).stewards)).toEqual(['s1', 's2'])
    expect(M.canManage(room(base(), { s1: e(byS1) }), 'kim')).toBe(false)
  })

  it('a time later than the moment the server stored the entry cannot win (wrong or forged clock)', () => {
    const mine = { settings: { ...late, notice: '미래' }, settingsAt: at('2027-01-01', 0), menus: { [MON]: { lunch: menu('미래 메뉴', at('2027-01-01', 0)) } } }
    const owner = base({ settingsAt: at(MON, 10), menus: { [MON]: { lunch: { t: '관리자 메뉴', at: at(MON, 10), by: 'adm' } } } })
    // stored by the server at 09:00, before the owner's save at 10:00
    const eff = M.effective(room(owner, { s1: e(mine, at(MON, 9)) }))
    expect([eff.config.notice, M.menuOf(eff.menus, MON, 'lunch')]).toEqual(['', '관리자 메뉴'])
    // stored after it: counts, at the server's time
    const eff2 = M.effective(room(owner, { s1: e(mine, at(MON, 11)) }))
    expect([eff2.config.notice, eff2.settingsAt, eff2.menus[MON].lunch.at]).toEqual(['미래', at(MON, 11), at(MON, 11)])
  })

  it('the owner folds the merged state into the shared data, which stays the base', () => {
    const s1 = M.saveAs(room(base()), 's1', at(MON, 9), { settings: { ...late, notice: 'S1' }, menus: [{ date: MON, slot: 'lunch', t: '비빔밥' }] }).entry
    const r = room(base(), { s1: e(s1) })
    // the owner registers a menu only: the 식수서무's settings and menu are kept, with who and when
    const f = M.saveAs(r, 'adm', at(MON, 10), { menus: [{ date: MON, slot: 'dinner', t: '국수' }] })
    expect(f.entry).toBeUndefined()
    expect(plain(f.shared)).toMatchObject({ kind: 'meal', notice: 'S1', settingsBy: 's1', settingsAt: at(MON, 9), stewards: ['s1', 's2'], menus: { [MON]: { lunch: { t: '비빔밥', at: at(MON, 9), by: 's1' }, dinner: { t: '국수', at: at(MON, 10), by: 'adm' } } } })
    expect(f.shared.meals.lunch.cutoff).toBe('11:00')
    // without the entry the state is the same now
    expect(M.effective(room(f.shared)).config.notice).toBe('S1')
    // the 식수서무's next save drops from their entry what the shared data holds
    const next = M.saveAs(room(f.shared, { s1: e(s1) }), 's1', at(MON, 10, 30), { menus: [{ date: TUE, slot: 'lunch', t: '카레' }] }).entry
    expect(next.settings).toBeUndefined()
    expect(plain(next.menus)).toEqual({ [TUE]: { lunch: { t: '카레', at: at(MON, 10, 30) } } })
    // the owner's own settings save takes the time and the name
    const own = M.saveAs(room(f.shared, { s1: e(next) }), 'adm', at(MON, 11), { settings: { ...config, notice: 'ADM' } }).shared
    expect([own.notice, own.settingsBy, own.settingsAt, own.menus[TUE].lunch.t]).toEqual(['ADM', 'adm', at(MON, 11), '카레'])
  })

  it('once removed, a 식수서무 counts no more: only what the owner folded in stays', () => {
    const s1 = M.saveAs(room(base()), 's1', at(MON, 9), { settings: { ...late, notice: 'S1' }, menus: [{ date: MON, slot: 'lunch', t: '비빔밥' }] }).entry
    // the owner saves the settings they see (with the 식수서무's menu) and names only s2
    const removed = M.saveAs(room(base(), { s1: e(s1) }), 'adm', at(MON, 10), { settings: { ...config, notice: 'ADM' }, stewards: ['s2'] }).shared
    expect([Array.from(removed.stewards), removed.menus[MON].lunch.t, removed.notice]).toEqual([['s2'], '비빔밥', 'ADM'])
    expect(plain(removed.since)).toEqual({ s2: 1 })
    // a later edit by the removed one (written by an old screen or by hand) changes nothing
    const later = { ...s1, settings: { ...late, notice: '나중' }, settingsAt: at(MON, 12), menus: { [MON]: { lunch: menu('나중 메뉴', at(MON, 12)) }, [TUE]: { lunch: menu('나중 화요일', at(MON, 12)) } } }
    const eff = M.effective(room(removed, { s1: e(later) }))
    expect([eff.config.notice, M.menuOf(eff.menus, MON, 'lunch'), M.menuOf(eff.menus, TUE, 'lunch')]).toEqual(['ADM', '비빔밥', ''])
    expect(M.saveAs(room(removed, { s1: e(later) }), 's1', at(MON, 13), { menus: [{ date: MON, slot: 'lunch', t: 'x' }] }).error).toBeTruthy()
    // an edit never folded in is gone too (removed without the owner seeing it)
    const blind = { ...base(), stewards: ['s2'], since: { s2: 1 } }
    expect(M.menuOf(M.effective(room(blind, { s1: e(s1) })).menus, MON, 'lunch')).toBe('')
    // named again later: what they wrote while not in charge still does not count
    const again = M.saveAs(room(removed, { s1: e(later) }), 'adm', at(TUE, 9), { stewards: ['s2', 's1'] }).shared
    expect(plain(again.since)).toEqual({ s2: 1, s1: at(TUE, 9) })
    const eff2 = M.effective(room(again, { s1: e(later) }))
    expect([eff2.config.notice, M.menuOf(eff2.menus, MON, 'lunch')]).toEqual(['ADM', '비빔밥'])
    const fresh = M.saveAs(room(again, { s1: e(later) }), 's1', at(TUE, 9, 30), { menus: [{ date: TUE, slot: 'lunch', t: '새 메뉴' }] }).entry
    expect(plain(fresh.menus)).toEqual({ [TUE]: { lunch: { t: '새 메뉴', at: at(TUE, 9, 30) } } })
    expect(fresh.settings).toBeUndefined()
  })

  it('keeps the requests of a 식수서무 apart from their settings and menus', () => {
    const s = M.saveAs(room(base()), 's1', at(MON, 9), { settings: late, menus: [{ date: MON, slot: 'lunch', t: '비빔밥' }] }).entry
    // their own request and one made for a member, saved after that
    let v = M.apply(s, config, MON, 'dinner', true, at(MON, 9, 10)).entry
    v = M.applyFor(v, config, { id: 'kim', name: '김주무' }, MON, 'dinner', true, at(MON, 9, 20)).entry
    expect(plain(v)).toMatchObject({ settingsAt: at(MON, 9), menus: { [MON]: { lunch: { t: '비빔밥' } } }, days: { [MON]: { dinner: { on: true } } }, for: { kim: { days: { [MON]: { dinner: { on: true } } } } } })
    const r = room(base(), { s1: e(v) })
    expect(M.dayList(r, MON, 'dinner', []).map((p: any) => p.id).sort()).toEqual(['kim', 's1'])
    // and a later menu save keeps the requests
    const again = M.saveAs(r, 's1', at(MON, 9, 30), { menus: [{ date: MON, slot: 'note', t: '행사로 외식' }] }).entry
    expect(again.days[MON].dinner.on && again.for.kim.days[MON].dinner.on).toBe(true)
    expect(again.menus[MON].note.t).toBe('행사로 외식')
  })

  it('menus do not move a deadline', () => {
    const s = M.saveAs(room(base()), 's1', at(MON, 9), { menus: [{ date: MON, slot: 'lunch', t: '비빔밥' }, { date: MON, slot: 'note', t: '11시까지 오세요' }] }).entry
    const eff = M.effective(room(base(), { s1: e(s) }))
    expect(plain(M.pickSettings(eff.config))).toEqual(plain(M.pickSettings(config)))
    expect([M.cutoffAt(eff.config, MON, 'lunch'), M.stateOf(eff.config, MON, 'lunch', at(MON, 10, 30)), eff.settingsBy]).toEqual([at(MON, 10, 30), 'closed', 'adm'])
    expect(M.apply(null, eff.config, MON, 'lunch', true, at(MON, 10, 30)).error).toContain('마감')
  })

  it('keeps menus for the current week, 8 weeks back and 8 ahead; older ones go at the next save', () => {
    const menus = { '2026-09-25': { lunch: menu('옛', 5) }, '2026-09-28': { lunch: menu('8주 전', 5) }, '2027-01-24': { lunch: menu('8주 뒤', 5) } }
    const out = M.saveAs(room(base({ menus })), 'adm', at(TUE, 9), { menus: [{ date: '2027-01-25', slot: 'lunch', t: '너무 먼 날' }, { date: TUE, slot: 'lunch', t: '오늘' }, { date: 'x', slot: 'lunch', t: 'x' }, { date: TUE, slot: 'tea', t: 'x' }] }).shared
    expect(Object.keys(out.menus).sort()).toEqual(['2026-09-28', TUE, '2027-01-24'])
  })

  it('too big for the server: the oldest menus go first, the requests never', () => {
    const big = '가'.repeat(M.LIMITS.menuText)
    const days: Record<string, any> = {}
    for (let i = -56; i <= 56; i++) days[M.addDays(MON, i)] = { lunch: menu(big, 5), dinner: menu(big, 5), note: menu('나'.repeat(M.LIMITS.menuNote), 5) }
    const requests: Record<string, any> = {}
    for (let i = -90; i <= 6; i++) requests[M.addDays(MON, i)] = { lunch: { on: true, at: 3 }, dinner: { on: true, at: 3 } }
    const others: Record<string, any> = {}
    for (let p = 0; p < 2; p++) others[`m${p}`] = { name: `팀원${p}`, days: Object.fromEntries(Object.entries(requests).slice(-40)) }
    const mine = { v: 1, days: requests, for: others, menus: days }
    expect(JSON.stringify(mine).length).toBeGreaterThan(64 * 1024)
    const r = M.saveAs(room(base(), { s1: e(mine) }), 's1', at(MON, 9), { menus: [{ date: MON, slot: 'lunch', t: '오늘 메뉴' }] })
    expect(JSON.stringify(r.entry).length).toBeLessThanOrEqual(M.LIMITS.stateMax)
    expect(r.trimmed).toBeGreaterThan(0)
    expect(Object.keys(r.entry.days)).toHaveLength(Object.keys(requests).length)
    expect(Object.keys(r.entry.for)).toHaveLength(2)
    // what was dropped is the past, oldest first; today and the days ahead are there
    const kept = Object.keys(r.entry.menus).sort()
    expect(kept[0] > M.addDays(MON, -56)).toBe(true)
    expect(r.entry.menus[MON].lunch.t).toBe('오늘 메뉴')
    expect(kept[kept.length - 1]).toBe(M.addDays(MON, 56))
    // the owner's shared data is cut the same way
    const s = M.saveAs(room(base({ menus: Object.fromEntries(Object.entries(days).map(([d, v]) => [d, { ...v, lunch: menu(big.slice(10) + d, 5) }])) })), 'adm', at(MON, 9), { settings: { ...config, notice: '다'.repeat(300) } })
    expect(s.trimmed).toBeGreaterThan(0)
    expect(JSON.stringify(s.shared).length).toBeLessThanOrEqual(M.LIMITS.stateMax)
    // when even no menu helps, nothing else is touched
    const obj: Record<string, any> = { days: requests, menus: { [MON]: { lunch: menu('밥', 1) } } }
    expect(M.fitMenus(obj, MON, 100)).toBe(1)
    expect([obj.menus, Object.keys(obj.days).length]).toEqual([undefined, Object.keys(requests).length])
  })
})

describe('meal plugin: requests for many people at once (by department)', () => {
  const TUE = '2026-11-24'
  const shared = { ...M.cleanConfig({ ...config, stewards: ['s1'] }), since: { s1: 1 } }
  const members = [
    { id: 'adm', name: '박관리', deptName: '총무과' },
    { id: 'kim', name: '김주무', deptName: '민원팀' },
    { id: 's1', name: '김서무', deptName: '총무과' },
    { id: 'lee', name: '이주무', deptName: '민원팀' },
    { id: 'choi', name: '최주무', deptName: '' },
    { id: 'han', name: '한주무', deptName: '총무과' }
  ]
  const room = (entries: Record<string, any> = {}, extra: Record<string, any> = {}) => ({ createdBy: 'adm', shared: { ...shared, ...extra }, entries })
  const e = (value: any) => ({ name: '', value })
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
  const who = (ids: string[]) => ids.map((id) => ({ id, name: members.find((m) => m.id === id)!.name }))
  const names = (r: any, date = MON, meal = 'lunch') => M.dayList(r, date, meal, members).map((p: any) => p.name + (p.by ? `(${p.byName})` : '')).sort()

  it('groups the members by department in the order they arrive, the own department first', () => {
    const g = M.deptGroups(members, '민원팀')
    expect(g.map((x: any) => [x.dept, x.own, x.members.map((m: any) => m.id)])).toEqual([['민원팀', true, ['kim', 'lee']], ['총무과', false, ['adm', 's1', 'han']], ['부서 미지정', false, ['choi']]])
    // somebody without a department: that group is theirs; an unknown department changes nothing
    expect(M.deptGroups(members, '').map((x: any) => x.dept)).toEqual(['부서 미지정', '총무과', '민원팀'])
    expect(M.deptGroups(members, '없는 과').map((x: any) => [x.dept, x.own])).toEqual([['총무과', false], ['민원팀', false], ['부서 미지정', false]])
    expect(M.deptGroups(null, 'x')).toHaveLength(0)
  })

  it('tells whether all, some or none of a department are picked', () => {
    expect([M.groupState(['a', 'b'], new Set(['a', 'b', 'c'])), M.groupState(['a', 'b'], new Set(['b'])), M.groupState(['a', 'b'], new Set(['c'])), M.groupState(['a'], ['a']), M.groupState([], new Set(['a']))]).toEqual(['all', 'some', 'none', 'all', 'none'])
  })

  it('lists the days and meals that can be picked, with the reason for the others', () => {
    const hol = M.withHolidays(config, [{ date: '2026-11-25', name: '임시공휴일' }])
    const slots = M.bulkSlots(hol, [MON, TUE, '2026-11-25', '2026-11-28', '2026-12-07'], at(MON, 11))
    expect(slots.map((s: any) => `${s.date.slice(8)} ${s.meal} ${s.open ? 'open' : s.why}`)).toEqual(['23 lunch 10:30 마감됨', '23 dinner open', '24 lunch open', '24 dinner open', '25 lunch 공휴일(임시공휴일)', '25 dinner 공휴일(임시공휴일)', '28 lunch 받지 않는 날', '28 dinner 받지 않는 날', '07 lunch 아직 받지 않는 날짜', '07 dinner 아직 받지 않는 날짜'])
    expect(M.bulkSlots(M.cleanConfig({ meals: { dinner: { on: false } } }), [MON], at(MON, 9)).map((s: any) => s.meal)).toEqual(['lunch'])
  })

  it('requests for many people, days and meals in one entry; those who have it already are skipped', () => {
    const kimOwn = M.apply(null, config, MON, 'lunch', true, at(MON, 8)).entry
    const r0 = room({ kim: e(kimOwn) })
    const slots = [{ date: MON, meal: 'lunch' }, { date: TUE, meal: 'lunch' }, { date: MON, meal: 'lunch' }]
    const out = M.applyBulk(r0, 's1', config, who(['kim', 'lee', 'choi', 's1', 'lee']), slots, true, at(MON, 9), members)
    // 4 people x 2 slots, kim's Monday lunch is there already
    expect(plain(out.result)).toEqual({ applied: 7, already: 1, closed: 0, firm: 0, unfit: 0, trimmed: 0 })
    expect(Object.keys(out.entry.for).sort()).toEqual(['choi', 'kim', 'lee'])
    expect(out.entry.for.kim.days[MON]).toBeUndefined()
    expect(plain(out.entry.for.lee)).toEqual({ name: '이주무', days: { [MON]: { lunch: { on: true, at: at(MON, 9) } }, [TUE]: { lunch: { on: true, at: at(MON, 9) } } } })
    // the one who acts is written as their own request
    expect(plain(out.entry.days)).toEqual({ [MON]: { lunch: { on: true, at: at(MON, 9) } }, [TUE]: { lunch: { on: true, at: at(MON, 9) } } })
    const r1 = room({ kim: e(kimOwn), s1: { name: '김서무', value: out.entry } })
    expect(names(r1)).toEqual(['김서무', '김주무', '이주무(김서무)', '최주무(김서무)'])
    expect(names(r1, TUE)).toEqual(['김서무', '김주무(김서무)', '이주무(김서무)', '최주무(김서무)'])
    expect(M.bulkSummary(out.result, true, true)).toBe('7건 신청, 1건은 이미 신청함')
    // again: nothing left to do, nothing rewritten
    const again = M.applyBulk(r1, 's1', config, who(['kim', 'lee', 'choi', 's1']), slots, true, at(MON, 9, 30), members)
    expect(plain(again.result)).toEqual({ applied: 0, already: 8, closed: 0, firm: 0, unfit: 0, trimmed: 0 })
    expect(again.entry.for.lee.days[MON].lunch.at).toBe(at(MON, 9))
    // alreadySet is what the list uses to mark "신청함"
    const people = M.resolve(r1, members)
    expect([M.alreadySet(people, 'lee', [{ date: MON, meal: 'lunch' }], true), M.alreadySet(people, 'lee', [{ date: MON, meal: 'lunch' }, { date: MON, meal: 'dinner' }], true), M.alreadySet(people, 'han', [{ date: MON, meal: 'lunch' }], false), M.alreadySet(people, 'han', [], true)]).toEqual([true, false, true, false])
  })

  it('cancels for many; the member keeps the last word', () => {
    const first = M.applyBulk(room(), 's1', config, who(['kim', 'lee', 'choi']), [{ date: MON, meal: 'lunch' }], true, at(MON, 9), members).entry
    const r1 = room({ s1: { name: '김서무', value: first } })
    const out = M.applyBulk(r1, 's1', config, who(['kim', 'lee', 'han']), [{ date: MON, meal: 'lunch' }], false, at(MON, 9, 10), members)
    expect(plain(out.result)).toEqual({ applied: 2, already: 1, closed: 0, firm: 0, unfit: 0, trimmed: 0 })
    expect(out.entry.for.han).toBeUndefined()
    expect(M.bulkSummary(out.result, false, false)).toBe('2명 취소, 1명은 신청하지 않아 그대로')
    const leeOwn = M.apply(null, config, MON, 'lunch', true, at(MON, 9, 20)).entry
    const r2 = room({ s1: { name: '김서무', value: out.entry }, lee: e(leeOwn) })
    expect(names(r2)).toEqual(['이주무', '최주무(김서무)'])
    // and a later bulk request does not touch what the member asked for themselves
    const third = M.applyBulk(r2, 's1', config, who(['kim', 'lee']), [{ date: MON, meal: 'lunch' }], true, at(MON, 9, 30), members)
    expect(plain(third.result)).toMatchObject({ applied: 1, already: 1 })
    expect(third.entry.for.lee.days[MON].lunch).toEqual({ on: false, at: at(MON, 9, 10) })
  })

  it('skips what has closed at the moment of saving and says how many', () => {
    const slots = [{ date: MON, meal: 'lunch' }, { date: MON, meal: 'dinner' }, { date: '2026-11-28', meal: 'lunch' }]
    const out = M.applyBulk(room(), 's1', config, who(['kim', 'lee', 'choi']), slots, true, at(MON, 10, 30), members)
    expect(plain(out.result)).toEqual({ applied: 3, already: 0, closed: 6, firm: 0, unfit: 0, trimmed: 0 })
    expect(Object.keys(out.entry.for.kim.days[MON])).toEqual(['dinner'])
    expect(M.bulkSummary(out.result, true, true)).toBe('3건 신청, 6건은 마감되어 제외')
    expect(M.bulkSummary({ applied: 9, already: 2, closed: 1, unfit: 0, trimmed: 0 }, true, false)).toBe('9명 신청, 2명은 이미 신청함, 1명은 마감되어 제외')
    // everything closed: an entry without changes, nothing applied
    const none = M.applyBulk(room(), 's1', config, who(['kim']), [{ date: MON, meal: 'lunch' }], true, at(MON, 11), members)
    expect([none.result.applied, none.result.closed, none.entry.for]).toEqual([0, 1, undefined])
  })

  it('marks who requested or cancelled: the person themselves or somebody for them', () => {
    const lunch = [{ date: MON, meal: 'lunch' }]
    const kimOwn = e(M.apply(null, config, MON, 'lunch', true, at(MON, 9)).entry)
    const leeCancelled = e(M.apply(M.apply(null, config, MON, 'lunch', true, at(MON, 8)).entry, config, MON, 'lunch', false, at(MON, 8, 30)).entry)
    const bySeo = M.applyBulk(room(), 's1', config, who(['choi', 'han']), lunch, true, at(MON, 9), members).entry
    const bySeo2 = M.applyBulk(room({ s1: { name: '김서무', value: bySeo } }), 's1', config, who(['han']), lunch, false, at(MON, 9, 10), members).entry
    const r = room({ kim: kimOwn, lee: leeCancelled, s1: { name: '김서무', value: bySeo2 } })
    const people = M.resolve(r, members)
    const st = (id: string, slots = lunch) => plain(M.pickStatus(people, id, slots))
    expect(st('kim')).toEqual({ kind: 'self' })
    expect(st('lee')).toEqual({ kind: 'cancelSelf' })
    expect(st('choi')).toEqual({ kind: 'proxy', byName: '김서무' })
    expect(st('han')).toEqual({ kind: 'cancelProxy', byName: '김서무' })
    expect(st('s1')).toEqual({ kind: 'none' })
    // two meals that differ
    expect(st('kim', [...lunch, { date: MON, meal: 'dinner' }])).toEqual({ kind: 'mixed' })
    expect(st('kim', [])).toEqual({ kind: 'none' })
  })

  it('anybody can, and a pick is needed', () => {
    // a member who is not in charge (1.4.0)
    const byKim = M.applyBulk(room(), 'kim', config, who(['lee', 'choi']), [{ date: MON, meal: 'lunch' }], true, at(MON, 9), members)
    expect(byKim.result.applied).toBe(2)
    expect(names(room({ kim: { name: '김주무', value: byKim.entry } }))).toEqual(['이주무(김주무)', '최주무(김주무)'])
    expect(M.applyBulk(null, 'kim', config, who(['lee']), [{ date: MON, meal: 'lunch' }], true, at(MON, 9), members).error).toContain('권한')
    expect(M.applyBulk(room(), 's1', config, [], [{ date: MON, meal: 'lunch' }], true, at(MON, 9), members).error).toContain('사람')
    expect(M.applyBulk(room(), 's1', config, who(['lee']), [{ date: 'x', meal: 'lunch' }, { date: MON, meal: 'tea' }], true, at(MON, 9), members).error).toContain('날짜')
    expect(M.applyBulk(room(), 'adm', config, who(['lee']), [{ date: MON, meal: 'lunch' }], true, at(MON, 9), members).result.applied).toBe(1)
    // a clerk named before 1.2.0 still may
    const old = { createdBy: 'adm', shared: M.cleanConfig({ ...config, clerks: ['han'] }), entries: {} }
    expect(M.applyBulk(old, 'han', config, who(['lee']), [{ date: MON, meal: 'lunch' }], true, at(MON, 9), members).result.applied).toBe(1)
    // made by anybody, it counts as theirs
    const byS1 = M.applyBulk(room(), 's1', config, who(['lee']), [{ date: MON, meal: 'lunch' }], true, at(MON, 9), members).entry
    expect(names(room({ kim: { name: '김주무', value: byS1 } }))).toEqual(['이주무(김주무)'])
  })

  it('too big for the server: old records made for others go first, own requests never, the rest is counted', () => {
    const big = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, name: `팀원${String(i).padStart(3, '0')}`, deptName: '큰 부서' }))
    const all = M.cleanConfig({ ...config, weekend: true })
    const week = Array.from({ length: 7 }, (_, i) => M.addDays(MON, i))
    const slots = week.flatMap((date) => [{ date, meal: 'lunch' }, { date, meal: 'dinner' }])
    // the entry already holds 30 past days for 60 people, 90 days of own requests and menus kept from last week
    const past: Record<string, any> = {}
    for (let i = 1; i <= 30; i++) past[M.addDays(MON, -i)] = { lunch: { on: true, at: 5 } }
    const own: Record<string, any> = {}
    for (let i = 1; i <= 90; i++) own[M.addDays(MON, -i)] = { lunch: { on: true, at: 5 }, dinner: { on: true, at: 5 } }
    const mine = { v: 1, days: own, for: Object.fromEntries(big.slice(0, 60).map((m) => [m.id, { name: m.name, days: past }])), menus: { [M.addDays(MON, -3)]: { lunch: { t: '지난 메뉴', at: 5 } }, [TUE]: { lunch: { t: '화요일 메뉴', at: 5 } } } }
    const r = { createdBy: 'adm', shared: { ...shared, weekend: true }, entries: { s1: { name: '김서무', value: mine } } }
    const out = M.applyBulk(r, 's1', all, big, slots, true, at(MON, 9), big)
    expect(JSON.stringify(out.entry).length).toBeLessThanOrEqual(M.LIMITS.stateMax)
    // 31 = the past menu day and all 30 past days of records made for others
    expect(out.result.trimmed).toBe(31)
    expect(out.result.unfit).toBeGreaterThan(0)
    expect(out.result.applied + out.result.unfit).toBe(120 * 14)
    expect(out.result.applied).toBeGreaterThan(500)
    expect(Object.keys(out.entry.days)).toHaveLength(90)
    expect(out.entry.menus[TUE].lunch.t).toBe('화요일 메뉴')
    // what was written counts, in the order of the list: the first people are complete
    const after = { ...r, entries: { s1: { name: '김서무', value: out.entry } } }
    const written = week.reduce((n, d) => n + M.dayList(after, d, 'lunch', big).length + M.dayList(after, d, 'dinner', big).length, 0)
    expect(written).toBe(out.result.applied)
    expect(Object.keys(out.entry.for.m0.days)).toHaveLength(7)
    expect(out.entry.for.m119).toBeUndefined()
    expect(M.bulkSummary(out.result, true, true)).toContain(`${out.result.unfit}건은 저장 공간이 모자라 반영하지 못함, 지난 기록 31일치를 지움`)
    // a small limit: the past goes only as far as needed, oldest first
    const few = M.applyBulk(r, 's1', all, big.slice(0, 2), [{ date: MON, meal: 'lunch' }], true, at(MON, 9), big, JSON.stringify(M.cleanEntry(mine)).length - 4000)
    expect(few.result).toMatchObject({ applied: 2, unfit: 0 })
    expect(few.result.trimmed).toBeGreaterThan(1)
    expect(few.result.trimmed).toBeLessThan(31)
    expect(few.entry.for.m5.days[M.addDays(MON, -1)]).toBeTruthy()
    expect(few.entry.for.m5.days[M.addDays(MON, -30)]).toBeUndefined()
  })
})

describe('meal plugin: people registered by hand (staff who do not use TeamHub)', () => {
  const TUE = '2026-11-24'
  const X1 = 'x:park000001'
  const X2 = 'x:jung000002'
  const members = [
    { id: 'adm', name: '박관리', deptName: '총무과' },
    { id: 's1', name: '김서무', deptName: '총무과' },
    { id: 'kim', name: '김주무', deptName: '민원팀' }
  ]
  const base = (extra: Record<string, any> = {}) => ({ ...M.cleanConfig({ ...config, stewards: ['s1'] }), since: { s1: 1 }, settingsAt: at(MON, 8), settingsBy: 'adm', ...extra })
  const room = (shared: any, entries: Record<string, any> = {}) => ({ createdBy: 'adm', shared, entries })
  const e = (value: any, stored?: number) => ({ name: '김서무', value, ...(stored ? { at: stored } : {}) })
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
  const add = (r: any, by: string, when: number, people: any[]) => M.saveAs(r, by, when, { people })

  it('gives them ids no member has, and cleans what is typed', () => {
    const id = M.newManualId(0.123456, at(MON, 9))
    expect(M.isManualId(id)).toBe(true)
    expect(M.newManualId(0.5, 1)).not.toBe(M.newManualId(0.25, 1))
    expect([M.isManualId('x:abc123'), M.isManualId('adm'), M.isManualId('x:'), M.isManualId('x:ABC 12'), M.isManualId('01HXYZ'), M.isManualId(null)]).toEqual([true, false, false, false, false, false])
    expect(M.isManualId(M.newManualId(0, 0)) && M.isManualId(M.newManualId(0.999999999, 9e15))).toBe(true)
    expect(plain(M.cleanPerson({ name: '  박 \n 운전 ', dept: '가'.repeat(99), title: 5, memo: null }))).toEqual({ name: '박 운전', dept: '가'.repeat(M.LIMITS.personDept), title: '5', memo: '' })
    // a member id, a nameless record and one without a time are not people registered by hand
    expect(Object.keys(M.cleanPeople({ adm: { name: '가', at: 1 }, [X1]: { name: ' ', at: 1 }, [X2]: { name: '정' }, 'x:ok0001': { name: '오', at: 2, as: 'x:other1', gone: 1 } }, true))).toEqual(['x:ok0001'])
    expect(plain(M.cleanPeople({ 'x:ok0001': { name: '오', at: 2, as: 'x:other1', gone: 1, by: 'adm' } }, false))).toEqual({ 'x:ok0001': { name: '오', dept: '', title: '', memo: '', at: 2, gone: true } })
  })

  it('the owner keeps the list in the shared data, a 식수서무 in their own entry; the newest record of a person counts', () => {
    const o = add(room(base()), 'adm', at(MON, 9), [{ id: X1, name: '박운전', dept: '총무과', title: '운전원', memo: '점심만' }])
    expect(plain(o.shared.people)).toEqual({ [X1]: { name: '박운전', dept: '총무과', title: '운전원', memo: '점심만', at: at(MON, 9), by: 'adm' } })
    const r1 = room(o.shared)
    const s = add(r1, 's1', at(MON, 9, 10), [{ id: X2, name: '정미화', dept: '시설팀' }, { id: X1, name: '박운전', dept: '시설팀' }])
    expect(s.shared).toBeUndefined()
    expect(Object.keys(s.entry.people).sort()).toEqual([X2, X1].sort())
    const r2 = room(o.shared, { s1: e(s.entry) })
    const eff = M.effective(r2)
    expect(plain(M.manualList(eff.people))).toEqual([{ id: X1, name: '박운전', deptName: '시설팀', title: '운전원', memo: '점심만', manual: true }, { id: X2, name: '정미화', deptName: '시설팀', title: '', memo: '', manual: true }])
    expect([eff.people[X1].by, eff.people[X2].by]).toEqual(['s1', 's1'])
    expect(M.roster(r2, members).map((m: any) => m.id)).toEqual(['adm', 's1', 'kim', X1, X2])
    // an older record of the 식수서무 loses against a newer one of the owner; the owner's save folds the rest in
    const o2 = add(r2, 'adm', at(MON, 9, 20), [{ id: X1, name: '박운전', dept: '총무과' }])
    expect([o2.shared.people[X1].dept, o2.shared.people[X1].by, o2.shared.people[X2].by, o2.shared.people[X2].at]).toEqual(['총무과', 'adm', 's1', at(MON, 9, 10)])
    expect(M.effective(room(o2.shared, { s1: e(s.entry) })).people[X1].dept).toBe('총무과')
    // the 식수서무's next save drops from their entry what the shared data holds
    expect(add(room(o2.shared, { s1: e(s.entry) }), 's1', at(MON, 9, 30), []).entry.people).toBeUndefined()
    // a time later than the server stored the entry cannot win
    const future = { people: { [X1]: { name: '가짜', at: at('2027-01-01', 0) } } }
    expect(M.effective(room(o2.shared, { s1: e(future, at(MON, 9, 15)) })).people[X1].name).toBe('박운전')
  })

  it('ignores a list in the entry of somebody the owner did not name, and refuses their save', () => {
    const forged = { v: 1, days: {}, people: { [X1]: { name: '가짜 직원', dept: '어디', at: at(MON, 23) } } }
    const r = room(base(), { kim: { name: '김주무', value: forged } })
    expect(M.manualList(M.effective(r).people)).toHaveLength(0)
    expect(add(r, 'kim', at(MON, 9), [{ id: X1, name: '가짜' }]).error).toContain('식수서무만')
    // removed 식수서무: their additions no longer count unless the owner folded them in
    const s = add(room(base()), 's1', at(MON, 9), [{ id: X1, name: '박운전' }]).entry
    expect(M.manualList(M.effective(room({ ...base(), stewards: [] }, { s1: e(s) })).people)).toHaveLength(0)
  })

  it('needs a name and a proper id, and stops at the cap', () => {
    expect(add(room(base()), 'adm', at(MON, 9), [{ id: X1, name: '  ' }]).error).toContain('이름')
    expect(add(room(base()), 'adm', at(MON, 9), [{ id: 'kim', name: '구성원인 척' }, { name: 'id 없음' }]).shared.people).toEqual({})
    const many: Record<string, any> = {}
    for (let i = 0; i < M.LIMITS.peopleMax; i++) many[`x:p${String(i).padStart(6, '0')}`] = { name: `직원${i}`, dept: '현장', at: 5 }
    const full = room(base({ people: many }))
    expect(add(full, 'adm', at(MON, 9), [{ id: X1, name: '한 명 더' }]).error).toContain(`${M.LIMITS.peopleMax}명까지`)
    // editing or removing one of them is still possible, and then there is room for one
    const less = add(full, 'adm', at(MON, 9), [{ id: 'x:p000000', gone: true }])
    expect(less.error).toBeUndefined()
    expect(add(room(less.shared), 'adm', at(MON, 9, 1), [{ id: X1, name: '한 명 더' }]).error).toBeUndefined()
    // the full list fits the server's limit with room to spare, and is never cut to make room for menus
    expect(JSON.stringify(less.shared).length).toBeLessThan(20000)
    const menus: Record<string, any> = {}
    for (let i = -56; i <= 56; i++) menus[M.addDays(MON, i)] = { lunch: { t: '가'.repeat(200), at: 5 }, dinner: { t: '나'.repeat(200), at: 5 }, note: { t: '다'.repeat(60), at: 5 } }
    const tight = M.saveAs(room(base({ people: many, menus })), 'adm', at(MON, 9), { menus: [{ date: MON, slot: 'lunch', t: '오늘' }] })
    expect(tight.trimmed).toBeGreaterThan(0)
    expect(JSON.stringify(tight.shared).length).toBeLessThanOrEqual(M.LIMITS.stateMax)
    expect(Object.keys(tight.shared.people)).toHaveLength(M.LIMITS.peopleMax)
  })

  it('warns about a namesake without refusing', () => {
    const people = M.cleanPeople({ [X1]: { name: '박운전', at: 1 }, [X2]: { name: '정미화', at: 1, gone: true } }, true)
    expect([M.nameClash(' 김주무 ', members, people), M.nameClash('박운전', members, people), M.nameClash('박운전', members, people, X1), M.nameClash('정미화', members, people), M.nameClash('', members, people)]).toEqual(['member', 'manual', '', '', ''])
  })

  it('their meals are requested for them and appear wherever a member does, marked as registered by hand', () => {
    const shared = add(room(base()), 'adm', at(MON, 8), [{ id: X1, name: '박운전', dept: '시설팀' }, { id: X2, name: '정미화', dept: '민원팀' }]).shared
    const r0 = room(shared)
    const all = M.roster(r0, members)
    // inside their department group, after the members
    expect(M.deptGroups(all, '민원팀').map((g: any) => [g.dept, g.members.map((m: any) => m.name + (m.manual ? '*' : ''))])).toEqual([['민원팀', ['김주무', '정미화*']], ['총무과', ['박관리', '김서무']], ['시설팀', ['박운전*']]])
    const out = M.applyBulk(r0, 's1', config, all.filter((m: any) => ['kim', X1, X2].includes(m.id)), [{ date: MON, meal: 'lunch' }], true, at(MON, 9), all)
    expect(plain(out.result)).toMatchObject({ applied: 3, already: 0 })
    const r1 = room(shared, { s1: e(out.entry) })
    const list = M.dayList(r1, MON, 'lunch', members)
    expect(list.map((p: any) => [p.deptName, p.name, p.manual, p.byName])).toEqual([['민원팀', '김주무', false, '김서무'], ['민원팀', '정미화', true, '김서무'], ['시설팀', '박운전', true, '김서무']])
    expect(plain(M.splitCount(list))).toEqual({ total: 3, manual: 2 })
    expect([M.countText(list), M.countText(list.slice(0, 1)), M.countText([])]).toEqual(['3명 (미등록 2명 포함)', '1명', '0명'])
    // the kitchen gets names and a number, without the mark
    expect(M.orderText(r1, MON, members, MON).split('\n')[0]).toBe('오늘 11/23(월) 점심 3명: 김주무, 정미화, 박운전')
    // the month and the file
    const t = M.monthTally(r1, '2026-11', members, at(MON, 11), false)
    expect(t.rows.map((x: any) => [x.name, x.lunch, x.manual, x.gone])).toEqual([['김주무', 1, false, false], ['정미화', 1, true, false], ['박운전', 1, true, false]])
    expect(t.lunch).toBe(3)
    const csv = M.monthCsv(r1, '2026-11', members, at(MON, 11))
    expect(csv).toContain('시설팀,박운전 (미등록),1,0,1')
    expect(csv).toContain('민원팀,김주무,1,0,1')
    // a single request for one of them, and a cancel, work like for a member
    const one = M.applyFor(out.entry, config, { id: X1, name: '박운전' }, MON, 'lunch', false, at(MON, 9, 30)).entry
    expect(M.dayList(room(shared, { s1: e(one) }), MON, 'lunch', members).map((p: any) => p.name)).toEqual(['김주무', '정미화'])
  })

  it('removing keeps the past under the stored name, marked as removed', () => {
    const shared = add(room(base()), 'adm', at(MON, 8), [{ id: X1, name: '박운전', dept: '시설팀' }]).shared
    const req = M.applyFor(null, config, { id: X1, name: '박운전' }, MON, 'lunch', true, at(MON, 9)).entry
    const gone = add(room(shared, { s1: e(req) }), 'adm', at(TUE, 9), [{ id: X1, gone: true }]).shared
    expect(plain(gone.people[X1])).toMatchObject({ name: '박운전', dept: '시설팀', gone: true, at: at(TUE, 9) })
    const r = room(gone, { s1: e(req) })
    expect(M.manualList(M.effective(r).people)).toHaveLength(0)
    expect(M.roster(r, members)).toHaveLength(3)
    expect(M.monthTally(r, '2026-11', members, at(TUE, 9), false).rows.map((x: any) => [x.deptName, x.name, x.lunch, x.manual, x.gone])).toEqual([['시설팀', '박운전', 1, true, true]])
    // an older copy in a 식수서무's entry does not bring the person back
    const stale = { ...req, people: { [X1]: { name: '박운전', dept: '시설팀', at: at(MON, 8, 30) } } }
    expect(M.manualList(M.effective(room(gone, { s1: e(stale) })).people)).toHaveLength(0)
    // a record for an id that was never on a list: shown under the name stored with the record
    const stray = M.applyFor(null, config, { id: 'x:never00001', name: '이름만 남은 사람' }, MON, 'lunch', true, at(MON, 9)).entry
    expect(M.dayList(room(base(), { s1: e(stray) }), MON, 'lunch', members).map((p: any) => [p.name, p.manual])).toEqual([['이름만 남은 사람', true]])
  })

  it('a person who joins TeamHub later is shown under the member: no badge, nothing counted twice', () => {
    const shared = add(room(base()), 'adm', at(MON, 8), [{ id: X1, name: '김주무(임시)', dept: '시설팀' }]).shared
    // requested by hand on Monday (lunch and dinner) and Tuesday
    let req = M.applyFor(null, config, { id: X1, name: '김주무(임시)' }, MON, 'lunch', true, at(MON, 9)).entry
    req = M.applyFor(req, config, { id: X1, name: '김주무(임시)' }, MON, 'dinner', true, at(MON, 9)).entry
    req = M.applyFor(req, config, { id: X1, name: '김주무(임시)' }, TUE, 'lunch', true, at(MON, 9)).entry
    // the member also asked for Monday lunch themselves, and later cancelled Monday dinner
    let own = M.apply(null, config, MON, 'lunch', true, at(MON, 9, 30)).entry
    own = M.apply(own, config, MON, 'dinner', false, at(MON, 9, 40)).entry
    const before = room(shared, { s1: e(req), kim: { name: '김주무', value: own } })
    expect(M.dayList(before, MON, 'lunch', members).map((p: any) => p.name)).toEqual(['김주무', '김주무(임시)'])
    const linked = add(before, 'adm', at(MON, 10), [{ id: X1, as: 'kim' }]).shared
    expect(plain(linked.people[X1])).toMatchObject({ name: '김주무(임시)', as: 'kim' })
    const after = room(linked, { s1: e(req), kim: { name: '김주무', value: own } })
    // one person, once; the entry of the 식수서무 was not rewritten
    expect(M.dayList(after, MON, 'lunch', members).map((p: any) => [p.id, p.name, p.manual, p.by])).toEqual([['kim', '김주무', false, '']])
    expect(M.dayList(after, MON, 'dinner', members)).toHaveLength(0)
    expect(M.dayList(after, TUE, 'lunch', members).map((p: any) => [p.id, p.name, p.manual, p.byName])).toEqual([['kim', '김주무', false, '김서무']])
    expect(M.monthTally(after, '2026-11', members, at(TUE, 11), false).rows.map((x: any) => [x.id, x.name, x.lunch, x.dinner, x.manual])).toEqual([['kim', '김주무', 2, 0, false]])
    expect(M.manualList(M.effective(after).people)).toHaveLength(0)
    expect(Object.keys(req.for)).toEqual([X1])
    // a link to another hand-registered id is not taken; undoing the link brings the person back
    expect(add(after, 'adm', at(MON, 11), [{ id: X1, as: X2 }]).shared.people[X1].as).toBeUndefined()
    const undone = add(after, 'adm', at(MON, 11), [{ id: X1, as: '' }]).shared
    expect(M.manualList(M.effective(room(undone)).people).map((p: any) => p.name)).toEqual(['김주무(임시)'])
  })
})

describe('meal plugin: 확실히 신청안함 — a "no" only the member can take back (1.6.0)', () => {
  const TUE = '2026-11-24'
  const shared = { ...M.cleanConfig({ ...config, stewards: ['s1'] }), since: { s1: 1 } }
  const members = [
    { id: 'adm', name: '박관리', deptName: '총무과' },
    { id: 'kim', name: '김주무', deptName: '민원팀' },
    { id: 's1', name: '김서무', deptName: '총무과' },
    { id: 'lee', name: '이주무', deptName: '민원팀' }
  ]
  const room = (entries: Record<string, any> = {}) => ({ createdBy: 'adm', shared, entries })
  const e = (name: string, value: any) => ({ name, value })
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
  const lunch = [{ date: MON, meal: 'lunch' }]
  const kim = { id: 'kim', name: '김주무' }
  const firmKim = () => M.apply(null, config, MON, 'lunch', false, at(MON, 9), true).entry

  it('is kept only in the member\'s own days, as a "no", under the same deadline', () => {
    const own = firmKim()
    expect(plain(own.days[MON].lunch)).toEqual({ on: false, at: at(MON, 9), firm: true })
    // a "yes" is never firm; somebody else cannot write a firm mark for another
    expect(M.apply(null, config, MON, 'lunch', true, at(MON, 9), true).entry.days[MON].lunch.firm).toBeUndefined()
    const forged = M.cleanEntry({ days: {}, for: { kim: { name: '김주무', days: { [MON]: { lunch: { on: false, at: 5, firm: true } } } } } })
    expect(forged.for.kim.days[MON].lunch.firm).toBeUndefined()
    expect(M.apply(null, config, MON, 'lunch', false, at(MON, 10, 30), true).error).toContain('마감')
    expect(M.isFirm(room({ kim: e('김주무', own) }), 'kim', MON, 'lunch')).toBe(true)
    expect(M.isFirm(room({ kim: e('김주무', own) }), 'kim', MON, 'dinner')).toBe(false)
    expect(M.isFirm(room({ kim: e('김주무', own) }), 'lee', MON, 'lunch')).toBe(false)
  })

  it('refuses a request or cancel made for the member by anybody, also by those in charge', () => {
    const r = room({ kim: e('김주무', firmKim()) })
    for (const on of [true, false]) {
      const out = M.applyFor(null, config, kim, MON, 'lunch', on, at(MON, 9, 10), r)
      expect(out.error).toContain('확실히 신청안함')
      expect(out.error).toContain('김주무 님이')
    }
    // the other meal and another day stay open to them
    expect(M.applyFor(null, config, kim, MON, 'dinner', true, at(MON, 9, 10), r).entry).toBeTruthy()
    expect(M.applyFor(null, config, kim, TUE, 'lunch', true, at(MON, 9, 10), r).entry).toBeTruthy()
  })

  it('ignores a record made for the member while the mark stands, whatever its time (a stale or changed client)', () => {
    // written without looking (no room passed): later than the mark, and one written before it
    const later = M.applyFor(null, config, kim, MON, 'lunch', true, at(MON, 9, 30)).entry
    const before = M.applyFor(null, config, kim, MON, 'lunch', true, at(MON, 8)).entry
    const r = room({ kim: e('김주무', firmKim()), lee: e('이주무', later), s1: e('김서무', before) })
    expect(M.dayList(r, MON, 'lunch', members)).toHaveLength(0)
    expect(plain(M.recordOf(r, members, 'kim', MON, 'lunch'))).toEqual({ on: false, at: at(MON, 9), by: '', byName: '', firm: true })
    expect(M.declinedList(r, MON, 'lunch', members).map((p: any) => p.name)).toEqual(['김주무'])
    expect(M.monthTally(r, '2026-11', members, at(MON, 23), false).rows).toEqual([])
    expect(M.orderText(r, MON, members, MON)).toContain('점심 0명')
  })

  it('the member takes it back themselves: a plain cancel or a request; then others may again', () => {
    const marked = firmKim()
    const undone = M.apply(marked, config, MON, 'lunch', false, at(MON, 9, 20)).entry
    expect(undone.days[MON].lunch.firm).toBeUndefined()
    const r = room({ kim: e('김주무', undone) })
    expect(M.isFirm(r, 'kim', MON, 'lunch')).toBe(false)
    // a record made while it stood (earlier than taking it back) does not come back
    const during = M.applyFor(null, config, kim, MON, 'lunch', true, at(MON, 9, 10)).entry
    expect(M.dayList(room({ kim: e('김주무', undone), lee: e('이주무', during) }), MON, 'lunch', members)).toHaveLength(0)
    // nor one with a clock set ahead: it is never later than when the server stored it
    const ahead = M.applyFor(null, config, kim, MON, 'lunch', true, at(MON, 10)).entry
    expect(M.dayList(room({ kim: e('김주무', undone), lee: { name: '이주무', value: ahead, at: at(MON, 9, 10) } }), MON, 'lunch', members)).toHaveLength(0)
    expect(M.dayList(room({ kim: e('김주무', undone), lee: { name: '이주무', value: ahead, at: at(MON, 9, 25) } }), MON, 'lunch', members)).toHaveLength(1)
    // one made afterwards counts
    const after = M.applyFor(null, config, kim, MON, 'lunch', true, at(MON, 9, 30), r)
    expect(after.error).toBeUndefined()
    expect(M.dayList(room({ kim: e('김주무', undone), lee: e('이주무', after.entry) }), MON, 'lunch', members).map((p: any) => p.byName)).toEqual(['이주무'])
    // or the member requests at once
    const own = M.apply(marked, config, MON, 'lunch', true, at(MON, 9, 20)).entry
    expect(M.dayList(room({ kim: e('김주무', own) }), MON, 'lunch', members).map((p: any) => p.name)).toEqual(['김주무'])
  })

  it('the bulk list marks the member and skips them; the result says so', () => {
    const r = room({ kim: e('김주무', firmKim()) })
    const people = M.resolve(r, members)
    expect(plain(M.pickStatus(people, 'kim', lunch))).toEqual({ kind: 'firm' })
    expect(plain(M.pickStatus(people, 'kim', [...lunch, { date: MON, meal: 'dinner' }]))).toEqual({ kind: 'mixed' })
    expect([M.settled(people, 'kim', lunch, true), M.settled(people, 'kim', lunch, false), M.settled(people, 'lee', lunch, true)]).toEqual([true, true, false])
    expect(M.settled(people, 'kim', [...lunch, { date: MON, meal: 'dinner' }], true)).toBe(false)
    expect(M.firmAny(people, 'kim', [...lunch, { date: MON, meal: 'dinner' }])).toBe(true)
    const out = M.applyBulk(r, 's1', config, [kim, { id: 'lee', name: '이주무' }], [...lunch, { date: MON, meal: 'dinner' }], true, at(MON, 9, 10), members)
    expect(plain(out.result)).toEqual({ applied: 3, already: 0, closed: 0, firm: 1, unfit: 0, trimmed: 0 })
    expect(out.entry.for.kim.days[MON].lunch).toBeUndefined()
    expect(out.entry.for.kim.days[MON].dinner.on).toBe(true)
    expect(M.bulkSummary(out.result, true, true)).toBe("3건 신청, 1건은 본인이 '확실히 신청안함'으로 정해 제외")
  })

  it('counts as a "no" in the statistics and in 내 기록, apart from no answer', () => {
    const r = room({ kim: e('김주무', firmKim()), lee: e('이주무', M.apply(null, config, MON, 'lunch', true, at(MON, 9)).entry) })
    const day = M.dailyTally(r, '2026-11', members, at(MON, 23)).find((d: any) => d.date === MON)
    expect(day.meals.lunch).toMatchObject({ count: 1, declined: 1 })
    const sm = M.monthSummary(r, '2026-11', members, at(MON, 23))
    expect(plain(sm.declined)).toEqual({ lunch: 1, dinner: 0 })
    expect(sm.people).toBe(1)
    const pm = M.personMonth(r, members, 'kim', '2026-11', at(MON, 23))
    expect(plain(pm.declined)).toEqual({ lunch: 1, dinner: 0 })
    expect(pm.days.find((d: any) => d.date === MON).meals.lunch).toMatchObject({ on: false, firm: true, by: '' })
    expect(plain(pm.done)).toEqual({ lunch: 0, dinner: 0 })
  })
})

describe('1.8.0: the people registered by hand are TeamHub\'s one list of 미등록 인원 (지시 134)', () => {
  const X1 = 'x:park000001'
  const X2 = 'x:jung000002'
  const X3 = 'x:gone000003'
  const members = [
    { id: 'adm', name: '박관리', deptName: '총무과' },
    { id: 'kim', name: '김주무', deptName: '민원팀' }
  ]
  const shared = { ...M.cleanConfig({ ...config, stewards: ['s1'] }), since: { s1: 1 }, people: { [X1]: { name: '방의 옛 명단', at: 5, by: 'adm' } } }
  const room = (entries: Record<string, any> = {}) => ({ createdBy: 'adm', shared, entries })
  afterEach(() => M.setCorePeople(null))

  it("the server reads the plugin's old list the way the plugin does (meal-people.ts mirrors effective().people)", () => {
    const steward = { v: 1, days: {}, people: { [X1]: { name: '고친 이름', dept: '시설팀', at: 9 }, [X2]: { name: '정미화', at: 7, as: 'kim' }, [X3]: { name: '지운 사람', at: 8, gone: true }, 'x:late00004': { name: '나중', at: 99 } } }
    const r = room({ s1: { name: '김서무', value: steward, at: 50 }, kim: { name: '김주무', value: { people: { 'x:forged005': { name: '가짜', at: 9 } } }, at: 60 } })
    const fromPlugin = JSON.parse(JSON.stringify(M.effective(r).people))
    const fromServer = mealPeopleOf(r)
    expect(Object.keys(fromServer).sort()).toEqual(Object.keys(fromPlugin).sort())
    for (const id of Object.keys(fromPlugin)) {
      const p = fromServer[id]
      expect({ name: p.name, dept: p.dept, title: p.title, memo: p.memo, at: p.at, by: p.by, ...(p.gone ? { gone: true } : {}), ...(p.as ? { as: p.as } : {}) }).toEqual(fromPlugin[id])
    }
    // the time of a record is never later than the moment the server stored the entry
    expect(fromServer['x:late00004'].at).toBe(50)
  })

  it('with the list from TeamHub, the room\'s own list is not read; old records still name the same person', () => {
    // a request made for X1 before 1.8.0 (the id is the same in TeamHub's list)
    const entry = M.applyFor({ v: 1, days: {} }, config, { id: X1, name: '방의 옛 명단' }, MON, 'lunch', true, at(MON, 9)).entry
    M.setCorePeople([
      { id: X1, name: '박운전', dept: '시설팀', title: '', memo: '', at: 10, by: 'adm' },
      { id: X2, name: '정미화', dept: '민원팀', title: '', memo: '', at: 10, by: 'adm', as: 'kim' },
      { id: X3, name: '지운 사람', dept: '', title: '', memo: '', at: 10, by: 'adm', gone: true },
      { id: 'kim', name: '구성원 id는 아님', at: 10 }
    ])
    expect(M.usesCorePeople()).toBe(true)
    const r = room({ adm: { name: '박관리', value: entry, at: at(MON, 9) } })
    expect(M.manualList(M.effective(r).people).map((p: any) => [p.id, p.name, p.deptName])).toEqual([[X1, '박운전', '시설팀']])
    expect(M.dayList(r, MON, 'lunch', members).map((p: any) => [p.name, p.manual])).toEqual([['박운전', true]])
    expect(M.roster(r, members).map((m: any) => m.id)).toEqual(['adm', 'kim', X1])
    // an older TeamHub without the list: the room's own list as before
    M.setCorePeople(null)
    expect(M.manualList(M.effective(r).people).map((p: any) => p.name)).toEqual(['방의 옛 명단'])
  })
})

describe('server: nothing changes after a deadline, whatever the client (1.7.0, src/server/plugin-locks.ts)', () => {
  const shared = M.cleanConfig({ ...config, stewards: ['s1'] })
  const room = (entries: Record<string, any> = {}) => ({ createdBy: 'adm', shared, entries })
  const check = (before: unknown, after: unknown, now: number, entries: Record<string, any> = {}) => entryRefusal('meal', room(entries), 'kim', before, after, now)
  const copy = (v: any) => JSON.parse(JSON.stringify(v))

  it('own requests: free before the deadline, refused after it by the server clock', () => {
    const e1 = M.apply(null, config, MON, 'lunch', true, at(MON, 9)).entry
    expect(check(null, e1, at(MON, 9))).toBe('')
    // a client whose clock or script is wrong thinks it is still open: the server says no
    const e2 = M.apply(e1, config, MON, 'lunch', false, at(MON, 9, 30)).entry
    expect(check(e1, e2, at(MON, 10, 30))).toBe('11/23(월) 점심은 마감 시각(10:30)이 지나 바꿀 수 없습니다.')
    // a new request after the deadline as well
    const e3 = copy(e1)
    e3.days[MON].dinner = { on: true, at: at(MON, 16) }
    expect(check(e1, e3, at(MON, 16))).toBe('11/23(월) 저녁은 마감 시각(15:30)이 지나 바꿀 수 없습니다.')
    // the dinner of that day is still open at 11:00
    expect(check(e1, M.apply(e1, config, MON, 'dinner', true, at(MON, 11)).entry, at(MON, 11))).toBe('')
    // taking a closed record out (or the whole entry) is a change too
    expect(check(e1, { v: 1, days: {} }, at(MON, 11))).toContain('마감 시각(10:30)')
    expect(check(e1, null, at(MON, 11))).toContain('마감 시각(10:30)')
    // the same records written again are fine (every save writes the whole entry), also without
    // `firm`, which a client older than 1.6.0 drops
    const firm = M.apply(e1, config, MON, 'lunch', false, at(MON, 10), true).entry
    const noFirm = copy(firm)
    delete noFirm.days[MON].lunch.firm
    expect(check(firm, noFirm, at(MON, 12))).toBe('')
    // the rest of an entry (settings, menus, people of those in charge) stays free after a deadline
    expect(check(e1, { ...copy(e1), menus: { [MON]: { note: { t: '외식', at: at(MON, 12) } } } }, at(MON, 12))).toBe('')
  })

  it('requests made for somebody else (대신 신청·취소): refused after the deadline, with the name', () => {
    const lee = { id: 'lee', name: '이주무' }
    const e1 = M.applyFor(null, config, lee, MON, 'lunch', true, at(MON, 9)).entry
    expect(check(null, e1, at(MON, 9))).toBe('')
    const e2 = copy(e1)
    e2.for.lee.days[MON].lunch = { on: false, at: at(MON, 11) }
    expect(check(e1, e2, at(MON, 11))).toBe('이주무 님의 11/23(월) 점심은 마감 시각(10:30)이 지나 바꿀 수 없습니다.')
    // a bulk request worked out with a wrong clock
    const bulk = M.applyBulk(room(), 'kim', config, [lee], [{ date: MON, meal: 'lunch' }], true, at(MON, 9), [])
    expect(check(null, bulk.entry, at(MON, 11))).toContain('이주무 님의 11/23(월) 점심')
  })

  it('reads the deadline that counts: the newest of the owner and the 식수서무 named', () => {
    expect(mealCutoffs(room())).toEqual({ lunch: '10:30', dinner: '15:30' })
    const later = M.saveAs(room(), 's1', at(MON, 8), { settings: { ...config, meals: { lunch: { on: true, cutoff: '12:00' }, dinner: { on: true, cutoff: '15:30' } } } }).entry
    const entries = { s1: { value: later, at: at(MON, 8) } }
    expect(mealCutoffs(room(entries))).toEqual({ lunch: '12:00', dinner: '15:30' })
    const e1 = M.apply(null, config, MON, 'lunch', true, at(MON, 9)).entry
    expect(check(null, e1, at(MON, 11, 59), entries)).toBe('')
    expect(check(null, e1, at(MON, 12), entries)).toBe('11/23(월) 점심은 마감 시각(12:00)이 지나 바꿀 수 없습니다.')
    // somebody not named cannot move it
    expect(mealCutoffs({ createdBy: 'adm', shared: M.cleanConfig(config), entries })).toEqual({ lunch: '10:30', dinner: '15:30' })
    // the price room and other extensions are not touched
    expect(mealCutoffs({ createdBy: 'adm', shared: { kind: 'meal-price', prices: [] }, entries: {} })).toBeNull()
    expect(entryRefusal('ladder', room(), 'kim', null, e1, at(MON, 23))).toBe('')
  })

  it('lets the plugin drop old days, and a save near the size limit drop old records made for others', () => {
    const old = M.addDays(MON, -MEAL_LOCK_DAYS - 1)
    const recent = M.addDays(MON, -3)
    const rec = { lunch: { on: true, at: 1 } }
    const e1 = { v: 1, days: { [old]: rec, [recent]: rec }, for: { lee: { name: '이주무', days: { [old]: rec, [recent]: rec } } } }
    const drop = (scope: 'own' | 'lee', date: string, pad = 0) => {
      const e = copy(e1)
      delete (scope === 'own' ? e.days : e.for.lee.days)[date]
      return pad ? { ...e, pad: 'x'.repeat(pad) } : e
    }
    expect(check(e1, drop('own', old), at(MON, 9))).toBe('')
    expect(check(e1, drop('lee', old), at(MON, 9))).toBe('')
    expect(check(e1, drop('own', recent), at(MON, 9))).toContain('마감 시각')
    expect(check(e1, drop('lee', recent), at(MON, 9))).toContain('이주무 님의')
    // near the size limit (Meal.applyBulk makes room): old records made for others may go, own never
    expect(check(e1, drop('lee', recent, MEAL_TRIM_FLOOR), at(MON, 9))).toBe('')
    expect(check(e1, drop('own', recent, MEAL_TRIM_FLOOR), at(MON, 9))).toContain('마감 시각')
    expect(mealEntryGuard(room(), 'kim', e1, e1, at(MON, 9))).toBe('')
  })
})

describe('meal plugin: 식대 단가 that change over time (1.7.0)', () => {
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
  const shared = M.cleanConfig({ ...config, stewards: ['s1'] })
  const room = { createdBy: 'adm', shared, entries: {} }
  const list = [
    { from: '2026-11-16', lunch: '8,500', dinner: 9000 },
    { from: '2026-10-01', lunch: 8000, dinner: '9000원' },
    { from: 'nope', lunch: 1 }
  ]

  it('keeps a list of price changes, oldest first; a price applies from its date until the next one', () => {
    const p = M.cleanPrices(list)
    expect(plain(p)).toEqual([
      { from: '2026-10-01', lunch: 8000, dinner: 9000 },
      { from: '2026-11-16', lunch: 8500, dinner: 9000 }
    ])
    expect(M.priceAt(p, '2026-09-30', 'lunch')).toBeNull()
    expect(M.priceAt(p, '2026-10-01', 'lunch')).toBe(8000)
    expect(M.priceAt(p, '2026-11-13', 'lunch')).toBe(8000)
    expect(M.priceAt(p, '2026-11-16', 'lunch')).toBe(8500)
    expect(M.priceAt(p, MON, 'dinner')).toBe(9000)
    // a month shows the price in force on the 1st and those starting within it
    expect(plain(M.monthPrices(p, '2026-11')).map((x: any) => x.from)).toEqual(['2026-10-01', '2026-11-16'])
    expect(plain(M.monthPrices(p, '2026-12')).map((x: any) => x.from)).toEqual(['2026-11-16'])
    expect(M.monthPrices(p, '2026-09')).toHaveLength(0)
    // odd amounts are 0, very big ones capped
    expect(plain(M.cleanPrices([{ from: MON, lunch: -5, dinner: 1e12 }]))).toEqual([{ from: MON, lunch: 0, dinner: M.LIMITS.priceMax }])
  })

  it('lives in a room of its own: its creator writes the shared data, the others in charge their entry; the newest counts', () => {
    // nothing yet: the first save makes the room
    const first = M.savePrices(room, null, 'adm', at(MON, 9), list.slice(0, 2))
    expect(first.create).toMatchObject({ kind: 'meal-price', v: 1, at: at(MON, 9) })
    expect(M.savePrices(room, null, 'kim', at(MON, 9), list.slice(0, 2)).error).toContain('식수서무만')
    expect(M.savePrices(room, null, 'adm', at(MON, 9), [{ from: '' }]).error).toContain('적용 시작일')
    expect(M.savePrices(room, null, 'adm', at(MON, 9), [{ from: MON }, { from: MON }]).error).toContain('두 번')
    const pr = { id: 'p', createdBy: 'adm', createdAt: 5, updatedAt: at(MON, 9), shared: first.create, entries: {} as Record<string, any> }
    expect(M.pickPriceRoom([{ id: 'x', createdAt: 1, shared }, pr, { ...pr, id: 'q', createdAt: 9 }]).id).toBe('p')
    // an older version never takes it for the settings room
    expect(M.pickRoom([pr])).toBeNull()
    expect(plain(M.effectivePrices(room, pr))).toMatchObject({ at: at(MON, 9), by: 'adm' })
    expect(M.effectivePrices(room, pr).prices).toHaveLength(2)
    expect(M.savePrices(room, pr, 'adm', at(MON, 10), list.slice(0, 2)).same).toBe(true)
    expect(M.savePrices(room, pr, 'adm', at(MON, 10), [list[1]]).shared.prices).toHaveLength(1)
    // a 식수서무 writes their own entry; the newer list wins
    const mine = M.savePrices(room, pr, 's1', at(MON, 11), [{ from: '2026-10-01', lunch: 7000, dinner: 7000 }])
    expect(mine.entry).toMatchObject({ v: 1, at: at(MON, 11) })
    const withS1 = { ...pr, entries: { s1: { name: '서무', value: mine.entry, at: at(MON, 11) } } }
    expect(plain(M.effectivePrices(room, withS1))).toEqual({ prices: [{ from: '2026-10-01', lunch: 7000, dinner: 7000 }], at: at(MON, 11), by: 's1' })
    // somebody not in charge: ignored; a clock ahead of the server's: taken as when it was stored
    const kim = { name: '김', value: { v: 1, prices: [{ from: MON, lunch: 1, dinner: 1 }], at: at(MON, 12) }, at: at(MON, 12) }
    expect(M.effectivePrices(room, { ...withS1, entries: { ...withS1.entries, kim } }).by).toBe('s1')
    const ahead = { s1: { name: '서무', value: { ...mine.entry, at: at(MON, 23) }, at: at(MON, 8) } }
    expect(M.effectivePrices(room, { ...pr, entries: ahead }).by).toBe('adm')
    // once the 식수서무 is removed, what they wrote no longer counts
    expect(M.effectivePrices({ ...room, shared: M.cleanConfig(config) }, withS1).by).toBe('adm')
  })
})

describe('meal plugin: 식대 정산 (1.7.0)', () => {
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
  const prices = [
    { from: '2026-11-01', lunch: 8000, dinner: 9000 },
    { from: MON, lunch: 8500, dinner: 9000 }
  ]
  const day = (lunch: boolean, dinner?: boolean, t = 1) => ({ lunch: { on: lunch, at: t }, ...(dinner === undefined ? {} : { dinner: { on: dinner, at: t } }) })
  const hand = { 'x:hand0001': { name: '현장직', dept: '시설팀', at: 1 } }
  const room = {
    createdBy: 'adm',
    shared: { ...M.cleanConfig(config), people: hand },
    entries: {
      a: { name: '가나', value: { v: 1, days: { '2026-11-20': day(true, true), [MON]: day(true, true, at(MON, 9)) } } },
      b: { name: '다라', value: { v: 1, days: { '2026-11-19': day(true), '2026-10-30': day(true), [MON]: day(false) } } },
      // the admin requested for somebody registered by hand (미등록 직원)
      adm: { name: '관리', value: { v: 1, days: {}, for: { 'x:hand0001': { name: '현장직', days: { '2026-11-20': day(true), [MON]: day(true, false, at(MON, 9)) } } } }, at: at(MON, 9) }
    }
  }
  const members = [
    { id: 'a', name: '가나', deptName: '행정팀' },
    { id: 'b', name: '다라', deptName: '행정팀' },
    { id: 'adm', name: '관리', deptName: '민원팀' }
  ]

  it('per person: the final meals priced on their own date, subtotals per department and the total', () => {
    // Monday 11:00: Monday's lunch is final, its dinner still open
    const s = M.settlement(room, '2026-11', members, at(MON, 11), prices)
    expect(plain(s.rows).map((r: any) => [r.deptName, r.name, r.manual, r.lunch, r.dinner, r.lunchAmt, r.dinnerAmt, r.amount])).toEqual([
      ['시설팀', '현장직', true, 2, 0, 16500, 0, 16500],
      ['행정팀', '가나', false, 2, 1, 16500, 9000, 25500],
      ['행정팀', '다라', false, 1, 0, 8000, 0, 8000]
    ])
    expect(plain(s.depts)).toEqual([
      { dept: '시설팀', people: 1, lunch: 2, dinner: 0, lunchAmt: 16500, dinnerAmt: 0, amount: 16500 },
      { dept: '행정팀', people: 2, lunch: 3, dinner: 1, lunchAmt: 24500, dinnerAmt: 9000, amount: 33500 }
    ])
    expect(plain(s.total)).toEqual({ people: 3, manual: 1, lunch: 5, dinner: 1, lunchAmt: 41000, dinnerAmt: 9000, amount: 50000 })
    expect(s.unpriced).toBe(0)
    // the counts are those of the statistics (개인별)
    const t = M.monthTally(room, '2026-11', members, at(MON, 11), false)
    expect([t.lunch, t.dinner]).toEqual([s.total.lunch, s.total.dinner])
    // after the dinner deadline it is final too
    expect(M.settlement(room, '2026-11', members, at(MON, 16), prices).total.amount).toBe(59000)
    // October: no price applied yet, counted apart
    const oct = M.settlement(room, '2026-10', members, at(MON, 11), prices)
    expect([oct.total.lunch, oct.total.amount, oct.unpriced]).toEqual([1, 0, 1])
  })

  it('CSV with the subtotals, and a saved month is priced again from its dates', () => {
    const now = at(MON, 11)
    const s = M.settlement(room, '2026-11', members, now, prices)
    const csv = M.settleCsv(s)
    expect(csv.startsWith('﻿부서,이름,점심(회),저녁(회),점심 금액(원),저녁 금액(원),합계(원)\r\n')).toBe(true)
    expect(csv).toContain('시설팀,현장직 (미등록),2,0,16500,0,16500\r\n시설팀,소계 1명,2,0,16500,0,16500')
    expect(csv).toContain('행정팀,소계 2명,3,1,24500,9000,33500')
    expect(csv).toContain(',합계 3명,5,1,41000,9000,50000')
    expect(M.wonText(1234567)).toBe('1,234,567')
    const snap = M.statsSnapshot(room, '2026-11', members, now)
    expect(plain(snap.rows.find((r: any) => r.id === 'a').dates)).toEqual({ lunch: ['2026-11-20', MON], dinner: ['2026-11-20'] })
    expect(plain(M.snapSettlement(snap, prices))).toEqual(plain(s))
    // a corrected price applies to a saved month as well
    expect(M.snapSettlement(snap, [{ from: '2026-11-01', lunch: 1000, dinner: 1000 }]).total.amount).toBe(6000)
    // a copy saved before 1.7.0 has no dates: the screen counts from the records kept now
    expect(M.snapSettlement({ ...snap, rows: snap.rows.map((r: any) => ({ ...r, dates: undefined })) }, prices)).toBeNull()
  })
})
