import { describe, it, expect } from 'vitest'
import holidayData from '../../resources/data/holidays-kr.json'
import { KR_LUNAR, holidayMap, koreanHolidays } from '../../src/shared/holidays'

const builtin = holidayData as unknown as Record<string, [string, string][]>
const names = (year: number): Record<string, string> => Object.fromEntries(koreanHolidays(year))

describe('Korean public holidays', () => {
  it('the rules give exactly the built-in list of every year it covers', () => {
    for (const y of Object.keys(builtin)) expect(koreanHolidays(Number(y)), y).toEqual(builtin[y])
  })

  it('covers the years ahead (through 2030), and nothing for an unknown year', () => {
    expect(Object.keys(builtin)).toEqual(['2025', '2026', '2027', '2028', '2029', '2030'])
    expect(Object.keys(KR_LUNAR).map(Number)).toEqual([2025, 2026, 2027, 2028, 2029, 2030])
    expect(koreanHolidays(2040)).toEqual([])
  })

  it('lunar holidays: 설날 and 추석 are three days, 부처님오신날 one', () => {
    const h = names(2026)
    expect([h['2026-02-16'], h['2026-02-17'], h['2026-02-18']]).toEqual(['설날 연휴', '설날', '설날 연휴'])
    expect([h['2026-09-24'], h['2026-09-25'], h['2026-09-26']]).toEqual(['추석 연휴', '추석', '추석 연휴'])
    expect(h['2026-05-24']).toBe('부처님오신날')
    // 2028: 설날 in KST is 1/27, a day after the Chinese new year (1/26)
    expect(names(2028)['2028-01-27']).toBe('설날')
    expect(names(2028)['2028-01-26']).toBe('설날 연휴')
  })

  it('대체공휴일: Saturday or Sunday for the national days, only Sunday or a clash for 설날·추석', () => {
    // 2026-03-01 is a Sunday, 2026-08-15 a Saturday
    expect(names(2026)['2026-03-02']).toBe('대체공휴일(삼일절)')
    expect(names(2026)['2026-08-17']).toBe('대체공휴일(광복절)')
    // 추석 2026 ends on a Saturday: no extra day
    expect(names(2026)['2026-09-28']).toBeUndefined()
    // 설날 2027 takes a Sunday (2/7): the Tuesday after the three days
    expect(names(2027)['2027-02-09']).toBe('대체공휴일(설날)')
    // 한글날 2027 on a Saturday: Monday 10/11 (Sunday 10/10 is skipped)
    expect(names(2027)['2027-10-11']).toBe('대체공휴일(한글날)')
    // 현충일 and 신정 never move
    expect(names(2027)['2027-06-07']).toBeUndefined()
    expect(names(2028)['2028-01-03']).toBeUndefined()
  })

  it('one clash gives one day', () => {
    // 2025: 어린이날 and 부처님오신날 on Monday 5/5
    expect(names(2025)['2025-05-05']).toBe('어린이날·부처님오신날')
    expect(names(2025)['2025-05-06']).toBe('대체공휴일')
    expect(names(2025)['2025-05-07']).toBeUndefined()
    // 2028: 추석 (10/2~10/4) takes 개천절 (10/3): Thursday 10/5 only
    const h = names(2028)
    expect(h['2028-10-03']).toBe('개천절·추석')
    expect(h['2028-10-05']).toBe('대체공휴일')
    expect(h['2028-10-06']).toBeUndefined()
    // 2029: 어린이날 Saturday and 부처님오신날 Sunday, two weeks apart: two days
    expect(names(2029)['2029-05-07']).toBe('대체공휴일(어린이날)')
    expect(names(2029)['2029-05-21']).toBe('대체공휴일(부처님오신날)')
    // 2030: 설날 on Sunday 2/3
    expect(names(2030)['2030-02-05']).toBe('대체공휴일(설날)')
  })

  it('election days are in, a substitute never lands on a weekend or another holiday', () => {
    expect(names(2028)['2028-04-12']).toBe('제23대 국회의원선거')
    expect(names(2030)['2030-06-05']).toBe('전국동시지방선거')
    for (const y of Object.keys(KR_LUNAR).map(Number)) {
      const list = koreanHolidays(y)
      expect(new Set(list.map(([d]) => d)).size).toBe(list.length)
      for (const [d, n] of list) if (n.startsWith('대체공휴일')) expect([0, 6], `${d} ${n}`).not.toContain(new Date(`${d}T00:00:00Z`).getUTCDay())
    }
  })

  it('holidayMap looks a date up', () => {
    const m = holidayMap([{ date: '2026-12-25', name: '성탄절' }])
    expect(m.get('2026-12-25')).toBe('성탄절')
    expect(m.get('2026-12-24')).toBeUndefined()
  })
})
