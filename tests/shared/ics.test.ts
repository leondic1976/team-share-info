import { describe, it, expect } from 'vitest'
import { parseIcs, toIcs } from '../../src/shared/ics'

describe('ics', () => {
  it('round-trips timed, all-day and recurring events with escaping', () => {
    const ev = [
      { uid: 'a', title: '회의, 주간; 팀', description: '줄1\n줄2', location: '3층', startAt: Date.UTC(2026, 10, 16, 1, 0), endAt: Date.UTC(2026, 10, 16, 2, 0), allDay: false, rrule: 'FREQ=WEEKLY;BYDAY=MO' },
      { uid: 'b', title: '연차', startAt: new Date(2026, 11, 24).getTime(), endAt: new Date(2026, 11, 26).getTime(), allDay: true }
    ]
    const text = toIcs(ev)
    expect(text).toContain('BEGIN:VCALENDAR')
    expect(text).toContain('DTSTART;VALUE=DATE:20261224')
    const back = parseIcs(text)
    expect(back).toHaveLength(2)
    expect(back[0]).toMatchObject({ title: '회의, 주간; 팀', description: '줄1\n줄2', location: '3층', startAt: ev[0].startAt, endAt: ev[0].endAt, allDay: false, rrule: 'FREQ=WEEKLY;BYDAY=MO' })
    expect(back[1]).toMatchObject({ title: '연차', allDay: true, startAt: ev[1].startAt, endAt: ev[1].endAt })
  })

  it('parses folded lines, TZID local times and DURATION', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:x',
      'SUMMARY:아주 긴 제목',
      ' 이어짐',
      'DTSTART;TZID=Asia/Seoul:20261120T140000',
      'DURATION:PT1H30M',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n')
    const [e] = parseIcs(text)
    expect(e.title).toBe('아주 긴 제목이어짐')
    expect(e.startAt).toBe(new Date(2026, 10, 20, 14, 0).getTime())
    expect(e.endAt - e.startAt).toBe(90 * 60000)
  })
})
