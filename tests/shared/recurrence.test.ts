import { describe, it, expect } from 'vitest'
import { buildRule, describeRule, expand, isEmptyRule, parseRule, truncateRule } from '../../src/shared/recurrence'

const local = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m - 1, d, h, min).getTime()
const hm = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

describe('recurrence expansion', () => {
  const weekly = { startAt: local(2026, 11, 2, 9), endAt: local(2026, 11, 2, 10), allDay: false, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE', exdates: [] as number[] }

  it('expands a weekly rule at the same local time', () => {
    const occ = expand(weekly, local(2026, 11, 1), local(2026, 11, 15))
    expect(occ.map((o) => hm(o.start))).toEqual(['11/2 09:00', '11/4 09:00', '11/9 09:00', '11/11 09:00'])
    expect(occ.every((o) => o.end - o.start === 3600000)).toBe(true)
  })

  it('skips exception dates', () => {
    const occ = expand({ ...weekly, exdates: [local(2026, 11, 4, 9)] }, local(2026, 11, 1), local(2026, 11, 8))
    expect(occ.map((o) => hm(o.start))).toEqual(['11/2 09:00'])
  })

  it('includes an occurrence that started before the range but is still running', () => {
    const occ = expand(weekly, local(2026, 11, 2, 9, 30), local(2026, 11, 2, 23))
    expect(occ.map((o) => hm(o.start))).toEqual(['11/2 09:00'])
  })

  it('handles non-recurring events by overlap', () => {
    const one = { ...weekly, rrule: null }
    expect(expand(one, local(2026, 11, 2), local(2026, 11, 3))).toHaveLength(1)
    expect(expand(one, local(2026, 11, 3), local(2026, 11, 4))).toHaveLength(0)
  })

  it('respects COUNT and UNTIL', () => {
    expect(expand({ ...weekly, rrule: 'FREQ=DAILY;COUNT=3' }, local(2026, 11, 1), local(2026, 12, 1))).toHaveLength(3)
    const trunc = truncateRule('FREQ=DAILY', local(2026, 11, 5, 9))!
    const occ = expand({ ...weekly, rrule: trunc }, local(2026, 11, 1), local(2026, 12, 1))
    expect(occ.map((o) => hm(o.start))).toEqual(['11/2 09:00', '11/3 09:00', '11/4 09:00'])
    expect(isEmptyRule({ ...weekly, rrule: truncateRule('FREQ=DAILY', weekly.startAt) })).toBe(true)
  })

  it('monthly on the 31st skips short months (RFC 5545)', () => {
    const ev = { startAt: local(2026, 1, 31, 10), endAt: local(2026, 1, 31, 11), allDay: false, rrule: 'FREQ=MONTHLY', exdates: [] }
    const occ = expand(ev, local(2026, 1, 1), local(2026, 6, 1))
    expect(occ.map((o) => hm(o.start))).toEqual(['1/31 10:00', '3/31 10:00', '5/31 10:00'])
  })

  it('all-day multi-day events keep their duration', () => {
    const ev = { startAt: local(2026, 12, 24), endAt: local(2026, 12, 27), allDay: true, rrule: 'FREQ=YEARLY', exdates: [] }
    const occ = expand(ev, local(2027, 12, 1), local(2028, 1, 1))
    expect(occ).toHaveLength(1)
    expect(hm(occ[0].start)).toBe('12/24 00:00')
    expect(hm(occ[0].end)).toBe('12/27 00:00')
  })
})

describe('simple rule editor model', () => {
  it('round-trips common patterns', () => {
    const r = buildRule({ freq: 'weekly', interval: 2, byWeekday: [0, 2], end: { type: 'count', count: 5 } })
    expect(r).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5')
    expect(parseRule(r)).toMatchObject({ freq: 'weekly', interval: 2, byWeekday: [0, 2], end: { type: 'count', count: 5 } })
    expect(parseRule(buildRule({ freq: 'weekdays', interval: 1, byWeekday: [], end: { type: 'never' } })).freq).toBe('weekdays')
    expect(buildRule({ freq: 'none', interval: 1, byWeekday: [], end: { type: 'never' } })).toBeNull()
  })
  it('describes rules in Korean', () => {
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO,WE')).toBe('매주 월·수')
    expect(describeRule('FREQ=DAILY;COUNT=3')).toBe('매일, 3회')
    expect(describeRule(null)).toBe('반복 안 함')
  })
})
