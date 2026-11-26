import { describe, it, expect } from 'vitest'
import { dutySections } from '../../src/shared/dutySections'
import { DAY_MS, dutyAbsentGroups, dutyDayStat, dutyTotals, entriesByMember } from '../../src/shared/dutyDay'
import type { DutyEntryDto } from '../../src/shared/schemas/duty'

const dept = (id: string, parentId: string | null = null, sort = 0): { id: string; name: string; parentId: string | null; sort: number } => ({ id, name: id, parentId, sort })
const person = (id: string, deptId: string | null): { id: string; name: string; title: string | null; deptId: string | null } => ({ id, name: id, title: null, deptId })

// 본부 > 총무과 (가, 나) ; 본부 has 장 of its own ; 소방서 (다) ; 라 without a department
const depts = [dept('본부', null, 1), dept('총무과', '본부'), dept('소방서', null, 2)]
const people = [person('장', '본부'), person('가', '총무과'), person('나', '총무과'), person('다', '소방서'), person('라', null)]

const DAY0 = new Date(2026, 10, 26).getTime()
let n = 0
const entry = (memberId: string, type: string, start: number, end: number, allDay = true): DutyEntryDto => ({
  id: `e${++n}`,
  key: 0,
  memberId,
  type,
  start,
  end,
  allDay,
  place: '',
  note: '',
  recurring: false,
  registeredByName: null
})

const entries = [
  entry('가', '연가', DAY0, DAY0 + DAY_MS),
  // 가 is also on a trip in the afternoon: two reasons, one person
  entry('가', '출장', DAY0 + 14 * 3600000, DAY0 + 18 * 3600000, false),
  // a week of 교육 that covers the day
  entry('다', '교육', DAY0 - 2 * DAY_MS, DAY0 + 3 * DAY_MS),
  // 라: the day before only
  entry('라', '병가', DAY0 - DAY_MS, DAY0),
  entry('장', '출장', DAY0, DAY0 + DAY_MS)
]

describe('근무현황 of one day', () => {
  const sections = dutySections(depts, people)
  const byMember = entriesByMember(entries)

  it('counts a person once in 사고 but under each reason', () => {
    const st = dutyDayStat(people, byMember, DAY0)
    expect(st.total).toBe(5)
    expect(st.away.map((m) => m.id)).toEqual(['장', '가', '다'])
    expect([...st.byType.keys()]).toEqual(['출장', '연가', '교육'])
    expect(st.byType.get('출장')?.map((x) => x.m.id)).toEqual(['장', '가'])
  })

  it('an entry that ended at midnight is not on the next day', () => {
    expect(dutyDayStat([people[4]], byMember, DAY0).away).toEqual([])
    expect(dutyDayStat([people[4]], byMember, DAY0 - DAY_MS).away.map((m) => m.id)).toEqual(['라'])
  })

  it('총괄표: 계, a 소계 line with a 직속 line, and lines that add up', () => {
    const t = dutyTotals(sections, byMember, DAY0)
    expect(t.types).toEqual(['출장', '연가', '교육'])
    expect(t.all).toEqual({ total: 5, present: 2, away: 3, byType: { 출장: 2, 연가: 1, 교육: 1 } })
    expect(t.rows.map((r) => [r.key, r.depth, r.subtotal, r.own, r.total, r.present, r.away])).toEqual([
      ['본부', 0, true, false, 3, 1, 2],
      ['본부:own', 1, false, true, 1, 0, 1],
      ['총무과', 1, false, false, 2, 1, 1],
      ['소방서', 0, false, false, 1, 0, 1],
      ['none', 0, false, false, 1, 1, 0]
    ])
    expect(t.rows[0].byType).toEqual({ 출장: 2, 연가: 1, 교육: 0 })
  })

  it('the people away by 소속, in org chart order, leaving out departments with nobody away', () => {
    const g = dutyAbsentGroups(sections, byMember, DAY0)
    expect(g.map((x) => [x.section.path.join(' > ') || '부서 미지정', x.people.map((p) => `${p.m.id}:${p.entries.map((e) => e.type).join('+')}`)])).toEqual([
      ['본부', ['장:출장']],
      ['본부 > 총무과', ['가:연가+출장']],
      ['소방서', ['다:교육']]
    ])
    expect(dutyAbsentGroups(sections, byMember, DAY0 + 10 * DAY_MS)).toEqual([])
  })
})
