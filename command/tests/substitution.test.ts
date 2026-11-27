import { describe, it, expect } from 'vitest'
import { absenceHints, activeSubstitutions, addDays, atTime, checkSubstitution, coveringIn, daysLabel, effectiveAssignments, effectiveCommon, headcount, mergeAbsences, periodsOverlap, substitutionPhase, teamsOnDuty, uncoveredDays } from '../shared/logic'
import type { CmdAssignment, CmdCommon, CmdException, CmdHostAbsence, CmdOverride, CmdPerson, CmdRole, CmdRotation, CmdSubstitution, CmdTeam } from '../shared/types'

const person = (id: string, name: string, temp = false): CmdPerson => ({ id, name, title: '', dept: '', temp })
const people = [person('kim', '김부재'), person('lee', '이대리'), person('park', '박조원'), person('choi', '최예외'), person('x:t', '정임시', true), person('han', '한바깥')]
const roles: CmdRole[] = [
  { id: 'r1', modeId: 'm1', parentId: null, name: '조장', sort: 0, hasDuty: true },
  { id: 'r2', modeId: 'm1', parentId: null, name: '상황요원', sort: 1, hasDuty: false },
  { id: 'r9', modeId: 'm2', parentId: null, name: '총괄', sort: 0, hasDuty: false }
]
const teams: CmdTeam[] = [
  { id: 'A', name: 'A조', color: '', sort: 0, members: ['kim', 'park', 'x:t'] },
  { id: 'B', name: 'B조', color: '', sort: 1, members: ['lee', 'choi'] }
]
const assignments: CmdAssignment[] = [
  { roleId: 'r1', teamId: 'A', personId: 'kim' },
  { roleId: 'r2', teamId: 'A', personId: 'park' },
  { roleId: 'r9', teamId: 'A', personId: 'kim' },
  { roleId: 'r2', teamId: 'B', personId: 'lee' }
]
const common: CmdCommon[] = [
  { id: 'c1', name: '장비운반차 운전', description: '', perTeam: false, sort: 0, assign: [{ teamId: '', personId: 'kim' }] },
  { id: 'c2', name: '콤비버스 운전', description: '', perTeam: true, sort: 1, assign: [{ teamId: 'A', personId: 'kim' }, { teamId: 'B', personId: 'lee' }] }
]
const exceptions: CmdException[] = [{ id: 'e', personId: 'choi', reason: '장기교육', fromDate: '2026-12-01', toDate: '2026-12-31' }]
const sub = (o: Partial<CmdSubstitution>): CmdSubstitution => ({ id: 's1', personId: 'kim', substituteId: 'lee', reason: '휴가', fromDate: '2026-12-03', toDate: '2026-12-05', ...o })
const ctx = (substitutions: CmdSubstitution[] = []) => ({ substitutions, exceptions, teams, assignments, common, roles, people })

describe('대리자: periods', () => {
  it('in force from the first to the last day, both included; open end goes on', () => {
    const s = sub({})
    expect(['2026-12-02', '2026-12-03', '2026-12-05', '2026-12-06'].map((d) => substitutionPhase(s, d))).toEqual(['later', 'now', 'now', 'past'])
    expect(substitutionPhase(sub({ toDate: null }), '2099-01-01')).toBe('now')
    expect(activeSubstitutions([s], '2026-12-02')).toEqual([])
    expect(activeSubstitutions([s], '2026-12-03')).toEqual([s])
    expect(activeSubstitutions([s], '2026-12-05')).toEqual([s])
    expect(activeSubstitutions([s], '2026-12-06')).toEqual([])
  })
  it('overlap of day periods (touching days overlap, open ends reach everything after)', () => {
    expect(periodsOverlap('2026-12-01', '2026-12-03', '2026-12-03', '2026-12-04')).toBe(true)
    expect(periodsOverlap('2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04')).toBe(false)
    expect(periodsOverlap('2026-12-01', null, '2027-05-01', '2027-05-02')).toBe(true)
    expect(periodsOverlap('2026-12-05', null, '2026-12-01', '2026-12-04')).toBe(false)
  })
  it('one per absent person: should two meet, the later start wins; a self-substitution never applies', () => {
    const a = sub({ id: 'a', fromDate: '2026-12-01', toDate: '2026-12-10' })
    const b = sub({ id: 'b', fromDate: '2026-12-04', toDate: '2026-12-04', substituteId: 'park' })
    expect(activeSubstitutions([a, b], '2026-12-04').map((x) => x.id)).toEqual(['b'])
    expect(activeSubstitutions([sub({ substituteId: 'kim' })], '2026-12-04')).toEqual([])
  })
})

describe('대리자: the roster of a day', () => {
  const active = activeSubstitutions([sub({})], '2026-12-04')
  it('the substitute takes every 분류 of the absent person in their 조, in every 근무 유형, in the same place', () => {
    const eff = effectiveAssignments(assignments, active)
    expect(eff.map((a) => `${a.roleId}/${a.teamId}/${a.personId}${a.cover ? '*' : ''}`)).toEqual(['r1/A/lee*', 'r2/A/park', 'r9/A/lee*', 'r2/B/lee'])
    expect(eff[0].cover?.personId).toBe('kim')
    // out of the period: nothing changes (the same list)
    expect(effectiveAssignments(assignments, activeSubstitutions([sub({})], '2026-12-06'))).toBe(assignments)
  })
  it('the substitute who already held the same place is listed once, as covering', () => {
    const eff = effectiveAssignments([...assignments, { roleId: 'r1', teamId: 'A', personId: 'lee' }], active)
    expect(eff.filter((a) => a.roleId === 'r1' && a.teamId === 'A')).toEqual([{ roleId: 'r1', teamId: 'A', personId: 'lee', cover: active[0] }])
  })
  it('공통업무, fixed and per 조', () => {
    const eff = effectiveCommon(common, active)
    expect(eff[0].assign).toEqual([{ teamId: '', personId: 'lee', cover: active[0] }])
    expect(eff[1].assign.map((a) => `${a.teamId}/${a.personId}${a.cover ? '*' : ''}`)).toEqual(['A/lee*', 'B/lee'])
    expect(effectiveCommon(common, [])).toBe(common)
  })
  it('인원총괄현황: the absent one stays in their 조 and counts as placed; 공통업무 counts who does it that day', () => {
    const hc = (day: string) => headcount({ teams, people, assignments, roles, common, exceptions, substitutions: [sub({})], modeId: 'm1', today: day })
    const on = hc('2026-12-04')
    expect(on.teams.find((t) => t.teamId === 'A')).toEqual({ teamId: 'A', members: 3, temps: 1, placed: 2, unplaced: 1, absent: 1 })
    expect([on.substitutions, on.common]).toEqual([1, 1])
    const off = hc('2026-12-06')
    expect(off.teams.find((t) => t.teamId === 'A')!.absent).toBe(0)
    expect([off.substitutions, off.common]).toEqual([0, 2])
  })
})

describe('대리자: rules', () => {
  it('a plain one is allowed; the substitute = the absent person is refused', () => {
    expect(checkSubstitution(sub({ substituteId: 'han' }), ctx())).toEqual({ error: '', warnings: [] })
    expect(checkSubstitution(sub({ substituteId: 'kim' }), ctx()).error).toBe('대리자는 부재자와 다른 사람이어야 합니다.')
  })
  it('overlapping periods for the same absent person are refused (editing itself is not an overlap)', () => {
    const cur = sub({ id: 'cur', substituteId: 'han' })
    expect(checkSubstitution(sub({ fromDate: '2026-12-05', toDate: '2026-12-07', substituteId: 'park' }), ctx([cur])).error).toContain('기간이 겹치지 않게')
    expect(checkSubstitution(sub({ fromDate: '2026-12-06', toDate: '2026-12-07', substituteId: 'park' }), ctx([cur])).error).toBe('')
    expect(checkSubstitution(sub({ fromDate: '2026-11-01', toDate: null, substituteId: 'park' }), ctx([cur])).error).toContain('기간이 겹치지 않게')
    expect(checkSubstitution({ ...cur, toDate: '2026-12-09' }, ctx([cur])).error).toBe('')
  })
  it('somebody on exception in the period cannot be the substitute', () => {
    expect(checkSubstitution(sub({ substituteId: 'choi' }), ctx()).error).toContain('예외자(장기교육')
    // before the exception starts it is fine
    expect(checkSubstitution(sub({ substituteId: 'choi', fromDate: '2026-11-20', toDate: '2026-11-30' }), ctx()).error).toBe('')
  })
  it('the substitute away themselves, or the absent person covering for somebody else then, is refused', () => {
    const leeAway = sub({ id: 'o', personId: 'lee', substituteId: 'han', fromDate: '2026-12-05', toDate: '2026-12-08' })
    expect(checkSubstitution(sub({}), ctx([leeAway])).error).toContain('이대리도 그 기간에 부재')
    const kimCovers = sub({ id: 'o', personId: 'park', substituteId: 'kim', fromDate: '2026-12-01', toDate: '2026-12-03' })
    expect(checkSubstitution(sub({}), ctx([kimCovers])).error).toContain('박조원의 대리자입니다')
  })
  it('a substitute with duties of their own in that 조 or 공통업무 is allowed, with warnings', () => {
    const r = checkSubstitution(sub({ substituteId: 'park' }), ctx())
    expect(r.error).toBe('')
    expect(r.warnings).toEqual(['박조원은(는) 같은 조(A조)에서 "상황요원"도 맡고 있어, 그 기간에는 두 임무를 함께 맡습니다.'])
    // 이대리 drives the per-조 bus for B조 only: not a duty in A조; the fixed one would be
    expect(checkSubstitution(sub({}), ctx()).warnings).toEqual([])
    const fixed = checkSubstitution(sub({ personId: 'park', substituteId: 'kim' }), ctx())
    expect(fixed.warnings.some((w) => w.includes('공통업무 장비운반차 운전, 콤비버스 운전'))).toBe(true)
  })
  it('a 미등록 substitute and an absent person with nothing to cover get warnings; covering two at once too', () => {
    expect(checkSubstitution(sub({ substituteId: 'x:t' }), ctx()).warnings.some((w) => w.includes('미등록 인원이라 훈련에는 참가하지 못합니다'))).toBe(true)
    expect(checkSubstitution(sub({ personId: 'han', substituteId: 'park' }), ctx()).warnings).toContain('한바깥은(는) 조·공통업무에 들어 있지 않아 대신 맡을 것이 없습니다.')
    const other = sub({ id: 'o', personId: 'park', substituteId: 'han' })
    expect(checkSubstitution(sub({ substituteId: 'han' }), ctx([other])).warnings.some((w) => w.includes('박조원의 대리도 맡고 있습니다'))).toBe(true)
  })
  it('somebody covering in a period cannot be put on exception then', () => {
    const s = sub({})
    expect(coveringIn([s], 'lee', '2026-12-05', null)).toBe(s)
    expect(coveringIn([s], 'lee', '2026-12-06', null)).toBeUndefined()
    expect(coveringIn([s], 'kim', '2026-12-01', null)).toBeUndefined()
  })
})

describe('대리자: hints from the host 근무현황', () => {
  const abs = (o: Partial<CmdHostAbsence>): CmdHostAbsence => ({ personId: 'kim', type: '연가', fromDate: '2026-11-28', toDate: '2026-11-30', ...o })
  // A조 and B조 by turns, a day each, from 09:00 (A조 on 11-27 09:00 ~ 11-28 09:00)
  const rotation: CmdRotation = { baseDate: '2026-11-27', shiftTime: '09:00', periodDays: 1, order: ['A', 'B'] }
  const base = { substitutions: [] as CmdSubstitution[], exceptions: [] as CmdException[], assignments, common, rotation, overrides: [] as CmdOverride[], known: () => true }

  it('days: moved across months, labelled with 오늘 and the year when it is another year', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(daysLabel('2026-11-27', '2026-11-27', '2026-11-27')).toBe('오늘')
    expect(daysLabel('2026-11-28', '2026-11-28', '2026-11-27')).toBe('11월 28일')
    expect(daysLabel('2026-11-28', '2026-11-30', '2026-11-27')).toBe('11월 28일~11월 30일')
    expect(daysLabel('2026-11-27', '2026-11-29', '2026-11-27')).toBe('오늘~11월 29일')
    expect(daysLabel('2026-12-30', '2027-01-02', '2026-11-27')).toBe('12월 30일~2027년 1월 2일')
  })

  it('a repeating absence day after day becomes one period; another reason or a gap stays apart', () => {
    const merged = mergeAbsences([
      abs({ fromDate: '2026-11-29', toDate: '2026-11-29' }),
      abs({ fromDate: '2026-11-28', toDate: '2026-11-28' }),
      abs({ fromDate: '2026-11-30', toDate: '2026-12-01' }),
      abs({ fromDate: '2026-12-03', toDate: '2026-12-03' }),
      abs({ type: '교육', fromDate: '2026-11-29', toDate: '2026-11-29' }),
      abs({ personId: 'park', fromDate: '2026-11-27', toDate: '2026-11-27' })
    ])
    expect(merged).toEqual([
      abs({ personId: 'park', fromDate: '2026-11-27', toDate: '2026-11-27' }),
      abs({ fromDate: '2026-11-28', toDate: '2026-12-01' }),
      abs({ type: '교육', fromDate: '2026-11-29', toDate: '2026-11-29' }),
      abs({ fromDate: '2026-12-03', toDate: '2026-12-03' })
    ])
  })

  it('uncovered days: whole, none, the days left before, between and after; an open end covers the rest', () => {
    expect(uncoveredDays('2026-11-28', '2026-11-30', [])).toEqual([{ fromDate: '2026-11-28', toDate: '2026-11-30' }])
    expect(uncoveredDays('2026-11-28', '2026-11-30', [{ fromDate: '2026-11-20', toDate: '2026-12-02' }])).toEqual([])
    expect(uncoveredDays('2026-11-28', '2026-11-30', [{ fromDate: '2026-11-29', toDate: null }])).toEqual([{ fromDate: '2026-11-28', toDate: '2026-11-28' }])
    expect(
      uncoveredDays('2026-11-28', '2026-12-04', [
        { fromDate: '2026-12-02', toDate: '2026-12-02' },
        { fromDate: '2026-11-29', toDate: '2026-11-30' },
        { fromDate: '2026-12-10', toDate: '2026-12-12' }
      ])
    ).toEqual([
      { fromDate: '2026-11-28', toDate: '2026-11-28' },
      { fromDate: '2026-12-01', toDate: '2026-12-01' },
      { fromDate: '2026-12-03', toDate: '2026-12-04' }
    ])
  })

  it('the 조 on duty in a period by the rotation, a period set by hand included', () => {
    expect([...teamsOnDuty(rotation, [], atTime('2026-11-27', '10:00'), atTime('2026-11-27', '20:00'))]).toEqual(['A'])
    expect([...teamsOnDuty(rotation, [], atTime('2026-11-28', '00:00'), atTime('2026-11-29', '00:00'))].sort()).toEqual(['A', 'B'])
    const o: CmdOverride = { id: 'o', fromAt: atTime('2026-11-27', '12:00'), toAt: atTime('2026-11-27', '13:00'), teamId: 'B', note: '', createdAt: 1 }
    expect([...teamsOnDuty(rotation, [o], atTime('2026-11-27', '10:00'), atTime('2026-11-27', '20:00'))].sort()).toEqual(['A', 'B'])
    expect(teamsOnDuty(null, [], atTime('2026-11-27', '00:00'), atTime('2026-11-28', '00:00')).size).toBe(0)
  })

  it('a hint for the whole absence, none when a substitution or exception covers it, the days left when only some are', () => {
    expect(absenceHints({ ...base, absences: [abs({})] })).toEqual([{ ...abs({}), gaps: [{ fromDate: '2026-11-28', toDate: '2026-11-30' }], partial: false }])
    // covered all through: nothing to say
    expect(absenceHints({ ...base, absences: [abs({})], substitutions: [sub({ fromDate: '2026-11-28', toDate: '2026-11-30' })] })).toEqual([])
    expect(absenceHints({ ...base, absences: [abs({})], substitutions: [sub({ fromDate: '2026-11-28', toDate: '2026-11-28' }), sub({ id: 's2', fromDate: '2026-11-29', toDate: null })] })).toEqual([])
    expect(absenceHints({ ...base, absences: [abs({})], exceptions: [{ id: 'e', personId: 'kim', reason: '', fromDate: '2026-11-01', toDate: null }] })).toEqual([])
    // covered in part: the days left
    const part = absenceHints({ ...base, absences: [abs({})], substitutions: [sub({ fromDate: '2026-11-28', toDate: '2026-11-28' })] })
    expect(part).toEqual([{ ...abs({}), gaps: [{ fromDate: '2026-11-29', toDate: '2026-11-30' }], partial: true }])
    // somebody else's substitution, or one by a substitute no longer there, covers nothing
    expect(absenceHints({ ...base, absences: [abs({})], substitutions: [sub({ personId: 'park', fromDate: '2026-11-28', toDate: '2026-11-30' })] })[0].partial).toBe(false)
    expect(absenceHints({ ...base, absences: [abs({})], substitutions: [sub({ fromDate: '2026-11-28', toDate: '2026-11-30' })], known: () => false })[0].partial).toBe(false)
  })

  it('only for somebody with a place on duty then: in a 조 on duty or with a 공통업무', () => {
    // 박조원 (A조, no 공통업무)
    expect(absenceHints({ ...base, absences: [abs({ personId: 'park', fromDate: '2026-11-27', toDate: '2026-11-27' })] })).toHaveLength(1)
    // a week each: A조 until 12-04 09:00, then B조 — 박조원 away on 12-05 needs nobody
    const weekly = { ...rotation, periodDays: 7 }
    expect(absenceHints({ ...base, rotation: weekly, absences: [abs({ personId: 'park', fromDate: '2026-12-05', toDate: '2026-12-05' })] })).toEqual([])
    expect(absenceHints({ ...base, rotation: weekly, absences: [abs({ personId: 'park', fromDate: '2026-12-04', toDate: '2026-12-05' })] })).toHaveLength(1)
    // no rotation: only a fixed 공통업무 counts (김부재 drives 장비운반차; 박조원 has nothing)
    expect(absenceHints({ ...base, rotation: null, absences: [abs({ personId: 'park' }), abs({})] }).map((x) => x.personId)).toEqual(['kim'])
    // 한바깥 has no place at all
    expect(absenceHints({ ...base, absences: [abs({ personId: 'han' })] })).toEqual([])
  })
})
