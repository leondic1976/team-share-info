import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

/* 식사 신청 1.9.0: departments in 직제순 (지시 146) and 근무현황 absences next to the meals (지시 145-4). */
/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx: Record<string, any> = {}
runInNewContext(readFileSync(join(import.meta.dirname, '../../resources/meal/meal.js'), 'utf8'), ctx)
const M = ctx.Meal
const plain = (v: unknown): any => JSON.parse(JSON.stringify(v))

const at = (date: string, h: number, m = 0): number => {
  const [y, mo, d] = date.split('-').map(Number)
  return new Date(y, mo - 1, d, h, m).getTime()
}
// Monday 2026-11-23
const MON = '2026-11-23'
const TUE = '2026-11-24'
const config = M.cleanConfig({ meals: { lunch: { cutoff: '10:30' }, dinner: { cutoff: '15:30' } }, ahead: 7 })

describe('1.9.0: departments in 직제순 (지시 146)', () => {
  // TeamHub.call('departments'): the org chart top-down (본부 > 총무과, 본부 > 민원팀, 시설팀)
  const departments = [
    { id: 'd1', name: '본부', path: ['본부'], order: 0 },
    { id: 'd2', name: '총무과', path: ['본부', '총무과'], order: 1 },
    { id: 'd3', name: '민원팀', path: ['본부', '민원팀'], order: 2 },
    { id: 'd4', name: '시설팀', path: ['시설팀'], order: 3 }
  ]
  const members = [
    { id: 'kim', name: '김주무', deptName: '민원팀', orgSort: 2 },
    { id: 'lee', name: '이팀장', deptName: '민원팀', orgSort: 1 },
    { id: 'adm', name: '박관리', deptName: '총무과', orgSort: 0 },
    { id: 'han', name: '한가람', deptName: '총무과', orgSort: 0 },
    { id: 'no', name: '나소속', deptName: '' },
    { id: 'fac', name: '최시설', deptName: '시설팀' }
  ]
  const X1 = 'x:park000001'
  const X2 = 'x:jung000002'
  // 미등록 people type their department: one TeamHub does not know, one as a path
  const hand = { [X1]: { name: '박운전', dept: '운전반', at: 1 }, [X2]: { name: '정미화', dept: '본부 > 민원팀', at: 1 } }
  const on = (t = 1): any => ({ lunch: { on: true, at: t } })
  const room = {
    createdBy: 'adm',
    shared: { ...M.cleanConfig(config), people: hand },
    entries: {
      ...Object.fromEntries(members.map((m) => [m.id, { name: m.name, value: { v: 1, days: { [MON]: on() } } }])),
      adm: { name: '박관리', value: { v: 1, days: { [MON]: on() }, for: { [X1]: { name: '박운전', days: { [MON]: on() } }, [X2]: { name: '정미화', days: { [MON]: on() } } } }, at: at(MON, 9) }
    }
  }
  const ORG = ['박관리', '한가람', '이팀장', '김주무', '정미화', '최시설', '박운전', '나소속']
  const DEPTS = ['총무과', '민원팀', '본부 > 민원팀', '시설팀', '운전반', '부서 미지정']
  afterEach(() => M.setDeptOrder(null))

  it('orders departments as the org chart, people inside one as an admin set, unknown departments after, 부서 미지정 last', () => {
    // before TeamHub gives the order (an older TeamHub): by department name, then by name, as always
    expect(M.usesDeptOrder()).toBe(false)
    expect(M.dayList(room, MON, 'lunch', members).map((p: any) => p.name)).toEqual(['나소속', '김주무', '이팀장', '정미화', '최시설', '박운전', '박관리', '한가람'])
    M.setDeptOrder(departments)
    expect(M.usesDeptOrder()).toBe(true)
    // 총무과 (no order given: by name), 민원팀 (orgSort first), the 미등록 person who typed the path
    // of 민원팀, 시설팀, then 운전반 that TeamHub does not know, and nobody's department last
    expect(M.dayList(room, MON, 'lunch', members).map((p: any) => p.name)).toEqual(ORG)
    expect(M.monthTally(room, '2026-11', members, at(MON, 11), false).rows.map((r: any) => r.name)).toEqual(ORG)
    expect(plain(M.deptTally(room, '2026-11', members, at(MON, 11))).map((d: any) => d.dept)).toEqual(DEPTS)
    const s = M.settlement(room, '2026-11', members, at(MON, 11), [{ from: '2026-11-01', lunch: 8000, dinner: 0 }])
    expect(s.rows.map((r: any) => r.name)).toEqual(ORG)
    expect(s.depts.map((d: any) => d.dept)).toEqual(DEPTS)
    // a snapshot saved earlier (rows by name) is put in 직제순 by department, its people kept as they were
    const snapRows = M.mealDates(room, '2026-11', members, at(MON, 11)).reverse()
    expect(M.settle(snapRows, []).depts.map((d: any) => d.dept)).toEqual(DEPTS)
  })

  it('compares department names and sorts any list of people the same way', () => {
    M.setDeptOrder(departments)
    expect(['부서 미지정', '나중팀', '시설팀', '가나팀', '총무과', '본부'].sort(M.deptCompare)).toEqual(['본부', '총무과', '시설팀', '가나팀', '나중팀', '부서 미지정'])
    expect(M.deptCompare('', '부서 미지정')).toBe(0)
    expect([...members].sort(M.orgSorter(members)).map((m: any) => m.id)).toEqual(['adm', 'han', 'lee', 'kim', 'fac', 'no'])
    // an empty list or none: back to the order by name
    M.setDeptOrder([])
    expect(M.usesDeptOrder()).toBe(false)
    expect(['총무과', '민원팀'].sort(M.deptCompare)).toEqual(['민원팀', '총무과'])
  })

  it('groups the pick list of 여러 명 대신 신청 in 직제순, own department first, people as they came', () => {
    const all = M.roster(room, members)
    // without the order: as the list arrives (unchanged)
    expect(M.deptGroups(all, '시설팀').map((g: any) => g.dept)).toEqual(['시설팀', '민원팀', '총무과', '부서 미지정', '운전반', '본부 > 민원팀'])
    M.setDeptOrder(departments)
    expect(M.deptGroups(all, '시설팀').map((g: any) => [g.dept, g.members.map((m: any) => m.id)])).toEqual([
      ['시설팀', ['fac']],
      ['총무과', ['adm', 'han']],
      ['민원팀', ['kim', 'lee']],
      ['본부 > 민원팀', [X2]],
      ['운전반', [X1]],
      ['부서 미지정', ['no']]
    ])
  })
})

describe('1.9.0: 근무현황 absences next to the meals (지시 145-4)', () => {
  const members = [
    { id: 'kim', name: '김주무', deptName: '민원팀' },
    { id: 'lee', name: '이서기', deptName: '민원팀' },
    { id: 'park', name: '박주사', deptName: '총무과' }
  ]
  const X1 = 'x:park000001'
  // TeamHub.call('absences'): kim on 연가 Mon-Tue (all day), park out Monday afternoon then on a trip until Tuesday 11:00
  const absences = [
    { memberId: 'kim', type: '연가', start: at(MON, 0), end: at('2026-11-25', 0), allDay: true },
    { memberId: 'park', type: '외출', start: at(MON, 14), end: at(MON, 16), allDay: false },
    { memberId: 'park', type: '출장', start: at(MON, 16), end: at(TUE, 11), allDay: false }
  ]
  const day = (t = 1): any => ({ lunch: { on: true, at: t }, dinner: { on: true, at: t } })
  const room = {
    createdBy: 'park',
    shared: { ...M.cleanConfig(config), people: { [X1]: { name: '현장직', dept: '시설팀', at: 1 } } },
    entries: {
      kim: { name: '김주무', value: { v: 1, days: { [MON]: day(), [TUE]: { lunch: { on: false, at: 1 } } } } },
      lee: { name: '이서기', value: { v: 1, days: { [MON]: day() } } },
      park: { name: '박주사', value: { v: 1, days: { [MON]: { dinner: { on: true, at: 1 } } }, for: { [X1]: { name: '현장직', days: { [MON]: day() } } } }, at: at(MON, 9) }
    }
  }

  it('tells who is away on a day, with the reason and the time', () => {
    const mon = M.absentOn(absences, MON)
    expect([...mon.keys()].sort()).toEqual(['kim', 'park'])
    expect(plain(mon.get('kim'))).toEqual({ types: ['연가'], parts: ['종일'], allDay: true, text: '연가' })
    expect(plain(mon.get('park'))).toEqual({ types: ['외출', '출장'], parts: ['14:00~16:00', '16:00~'], allDay: false, text: '외출, 출장' })
    const tue = M.absentOn(absences, TUE)
    expect(plain(tue.get('park')).parts).toEqual(['~11:00'])
    expect(tue.get('kim').text).toBe('연가')
    // the day after: nobody; odd input: nobody
    expect(M.absentOn(absences, '2026-11-25').size).toBe(0)
    expect(M.absentOn(null, MON).size).toBe(0)
    expect(M.absentOn([{ memberId: '', type: '연가', start: 0, end: at('2030-01-01', 0) }], MON).size).toBe(0)
    expect(M.absentOn(absences, 'not a date').size).toBe(0)
    expect(M.absentLabel(mon.get('kim'))).toBe('부재(연가)')
    expect(M.absentTime(mon.get('kim'))).toBe('')
    expect(M.absentTime(mon.get('park'))).toBe('14:00~16:00, 16:00~')
  })

  it('warns in plain Korean (로 or 으로), about me or about somebody else', () => {
    expect(['연가', '출장', '교육', '외출', '병가', 'OJT'].map((w) => w + M.ro(w))).toEqual(['연가로', '출장으로', '교육으로', '외출로', '병가로', 'OJT(으)로'])
    expect(M.absenceWarning(M.absentOn(absences, MON).get('kim'))).toBe('이 날은 근무현황에 연가로 부재입니다.')
    expect(M.absenceWarning(M.absentOn(absences, TUE).get('park'), '박주사')).toBe('박주사 님은 이 날 근무현황에 출장으로 부재입니다(~11:00).')
  })

  it('shows the requests of people who are away apart from the counts, which stay as they are', () => {
    const mon = M.absentOn(absences, MON)
    const lunch = M.dayList(room, MON, 'lunch', members)
    // the count is not changed: 김주무 (away), 이서기, 미등록 현장직
    expect(lunch.map((p: any) => p.name)).toEqual(['김주무', '이서기', '현장직'])
    const away = M.absentAmong(lunch, mon)
    expect(plain(away)).toEqual([{ id: 'kim', name: '김주무', deptName: '민원팀', manual: false, text: '연가' }])
    expect(M.absentText(away)).toBe('부재 중 신청 1명: 김주무(연가)')
    expect(M.absentText([])).toBe('부재 중 신청 0명')
    // day by day, for the statistics; the 미등록 person never counts as away
    const got = plain(M.absentRequests(room, members, [MON, TUE], absences))
    expect(got[MON].lunch.map((p: any) => p.name)).toEqual(['김주무'])
    expect(got[MON].dinner.map((p: any) => [p.name, p.text])).toEqual([
      ['김주무', '연가'],
      ['박주사', '외출, 출장']
    ])
    expect(got[TUE]).toEqual({ lunch: [], dinner: [] })
    // the days of a bulk request one person is away
    expect(plain(M.absentDays(absences, 'kim', [MON, TUE, '2026-11-25']))).toEqual([
      { date: MON, text: '연가' },
      { date: TUE, text: '연가' }
    ])
    expect(plain(M.absentDays(absences, X1, [MON]))).toEqual([])
  })
})
