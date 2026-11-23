import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx: Record<string, any> = {}
runInNewContext(readFileSync(join(import.meta.dirname, '../../plugins/meal/meal.js'), 'utf8'), ctx)
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
    expect(late.error).toContain('10:30에 마감')
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
})
