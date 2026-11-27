import { describe, it, expect } from 'vitest'
import { absenceTitle, myAbsencesForPersonal, shownAsPersonal } from '../../src/shared/absenceLink'
import { absencesOn } from '../../src/shared/dutyDay'
import type { EventOccurrenceDto } from '../../src/shared/schemas/events'
import type { PersonalOccurrenceDto } from '../../src/shared/schemas/personal'
import type { DutyEntryDto } from '../../src/shared/schemas/duty'

const ev = (id: string, authorId: string, start: number, end: number, kind: EventOccurrenceDto['kind'] = 'absence'): EventOccurrenceDto => ({
  id,
  key: start,
  start,
  end,
  allDay: true,
  title: '연가',
  kind,
  location: null,
  absenceType: kind === 'absence' ? '연가' : null,
  recurring: false,
  authorId,
  authorName: authorId,
  color: null,
  scope: { type: 'team', groups: [], members: [] } as unknown as EventOccurrenceDto['scope'],
  attendeeCount: 0,
  myResponse: null,
  reminders: []
})
const pe = (id: string, start: number, end: number, absenceEventId: string | null = null): PersonalOccurrenceDto => ({
  id,
  key: start,
  start,
  end,
  allDay: true,
  title: '개인',
  location: null,
  recurring: false,
  reminders: [],
  busyEventId: null,
  absenceEventId
})

describe('근무현황 사고 in the personal schedule', () => {
  it('lists my own 사고 only, once: a personal event that filed it stands for it while the times match', () => {
    const server = [ev('a', 'me', 0, 10), ev('b', 'me', 20, 30), ev('c', 'you', 0, 10), ev('d', 'me', 0, 10, 'team')]
    expect(myAbsencesForPersonal(server, [], 'me').map((e) => e.id)).toEqual(['a', 'b'])
    expect(myAbsencesForPersonal(server, [pe('p', 0, 10, 'a')], 'me').map((e) => e.id)).toEqual(['b'])
    // someone moved the 사고 in 근무현황: both show until they match again
    expect(myAbsencesForPersonal(server, [pe('p', 0, 5, 'a')], 'me').map((e) => e.id)).toEqual(['a', 'b'])
    expect(myAbsencesForPersonal(server, [], null)).toEqual([])
    expect(shownAsPersonal(server[0]!, [pe('p', 0, 10, 'a')], 'me')).toBe(true)
    expect(shownAsPersonal(server[2]!, [pe('p', 0, 10, 'c')], 'me')).toBe(false)
    expect(absenceTitle(server[0]!)).toBe('[연가] 근무현황')
  })
})

describe('사고명 badge next to names (absencesOn)', () => {
  const day = new Date(2026, 11, 3).getTime()
  const h = (n: number): number => day + n * 3600000
  const entry = (memberId: string, type: string, start: number, end: number, allDay = false): DutyEntryDto => ({ id: `${memberId}${type}`, key: start, memberId, type, start, end, allDay, place: '', note: '', recurring: false, registeredByName: null })
  it('shows today’s reasons while they last', () => {
    const list = [entry('a', '연가', day, day + 86400000, true), entry('b', '외출', h(9), h(10)), entry('b', '출장', h(14), h(18)), entry('c', '연가', day + 86400000, day + 2 * 86400000, true)]
    const at11 = absencesOn(list, day, h(11))
    expect(at11.get('a')?.types).toEqual(['연가'])
    // 외출 is over at 11:00, 출장 is still to come
    expect(at11.get('b')?.types).toEqual(['출장'])
    expect(at11.get('b')?.title).toContain('출장 14:00~18:00')
    expect(at11.has('c')).toBe(false)
  })
})
