import { describe, it, expect } from 'vitest'
import { alarmTimes, nextAlarmTime } from '../../src/shared/schemas/tools'

const L = (y: number, m: number, d: number, h = 0, mi = 0): number => new Date(y, m - 1, d, h, mi).getTime()
const base = { enabled: true, snoozeUntil: null, rrule: null, leadDays: [] as number[] }

describe('alarm time calculation (6.12, 13.12 M6-8 required test)', () => {
  it('once and timer ring exactly once in range', () => {
    const a = { ...base, kind: 'once' as const, fireAt: L(2026, 11, 20, 9) }
    expect(alarmTimes(a, L(2026, 11, 20), L(2026, 11, 21))).toEqual([L(2026, 11, 20, 9)])
    expect(alarmTimes(a, L(2026, 11, 21), L(2026, 11, 22))).toEqual([])
    expect(nextAlarmTime({ ...a, kind: 'timer' }, L(2026, 11, 20, 8))).toBe(L(2026, 11, 20, 9))
  })

  it('weekday repeat at local 08:50', () => {
    const a = { ...base, kind: 'repeat' as const, fireAt: L(2026, 11, 16, 8, 50), rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' }
    const t = alarmTimes(a, L(2026, 11, 20), L(2026, 11, 24, 23))
    expect(t).toEqual([L(2026, 11, 20, 8, 50), L(2026, 11, 23, 8, 50), L(2026, 11, 24, 8, 50)])
  })

  it('deadline rings 09:00 N days before and at the deadline', () => {
    const a = { ...base, kind: 'deadline' as const, fireAt: L(2026, 12, 10, 18), leadDays: [7, 3, 1, 0] }
    expect(alarmTimes(a, L(2026, 11, 1), L(2026, 12, 31))).toEqual([L(2026, 12, 3, 9), L(2026, 12, 7, 9), L(2026, 12, 9, 9), L(2026, 12, 10, 18)])
  })

  it('disabled alarms only ring when snoozed', () => {
    const a = { ...base, kind: 'once' as const, fireAt: L(2026, 11, 20, 9), enabled: false, snoozeUntil: L(2026, 11, 20, 9, 10) }
    expect(alarmTimes(a, L(2026, 11, 20), L(2026, 11, 21))).toEqual([L(2026, 11, 20, 9, 10)])
  })

  it('invalid rules never ring', () => {
    expect(alarmTimes({ ...base, kind: 'repeat', fireAt: 0, rrule: 'BAD' }, 0, Date.now())).toEqual([])
  })
})
