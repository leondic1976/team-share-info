import { describe, it, expect } from 'vitest'
import { activeExceptions, answerRefusal, applyMarkChanges, atTime, drillElapsedMs, drillSummary, headcount, marksAt, msgDone, nextShifts, resolveTargets, roleTree, roleWithChildren, rolePath, teamAt, waitsFor } from '../shared/logic'
import type { CmdOverride, CmdRole, CmdRotation, DrillMember, DrillMsg, Mark } from '../shared/types'

const rot: CmdRotation = { baseDate: '2026-11-02', shiftTime: '09:00', periodDays: 7, order: ['A', 'B', 'C', 'D'] }
const at = (date: string, hm: string): number => atTime(date, hm)

describe('조 순환', () => {
  it('weeks follow the order from the base day, changing at the shift time', () => {
    expect(teamAt(rot, [], at('2026-11-02', '09:00'))!.teamId).toBe('A')
    expect(teamAt(rot, [], at('2026-11-09', '08:59'))!.teamId).toBe('A')
    expect(teamAt(rot, [], at('2026-11-09', '09:00'))!.teamId).toBe('B')
    expect(teamAt(rot, [], at('2026-11-25', '12:00'))!.teamId).toBe('D')
    expect(teamAt(rot, [], at('2026-11-30', '09:00'))!.teamId).toBe('A')
    const s = teamAt(rot, [], at('2026-11-25', '12:00'))!
    expect([s.from, s.to]).toEqual([at('2026-11-23', '09:00'), at('2026-11-30', '09:00')])
  })
  it('also before the base day (backwards)', () => {
    expect(teamAt(rot, [], at('2026-11-01', '12:00'))!.teamId).toBe('D')
    expect(teamAt(rot, [], at('2026-10-26', '09:00'))!.teamId).toBe('D')
    expect(teamAt(rot, [], at('2026-10-26', '08:59'))!.teamId).toBe('C')
  })
  it('a period set by hand wins; the one made last when they overlap', () => {
    const o: CmdOverride[] = [
      { id: '1', fromAt: at('2026-11-24', '09:00'), toAt: at('2026-11-26', '09:00'), teamId: 'B', note: '맞교대', createdAt: 1 },
      { id: '2', fromAt: at('2026-11-25', '09:00'), toAt: at('2026-11-25', '18:00'), teamId: 'C', note: '', createdAt: 2 }
    ]
    expect(teamAt(rot, o, at('2026-11-24', '12:00'))).toMatchObject({ teamId: 'B', manual: true, note: '맞교대' })
    expect(teamAt(rot, o, at('2026-11-25', '12:00'))!.teamId).toBe('C')
    expect(teamAt(rot, o, at('2026-11-26', '09:00'))!.teamId).toBe('D')
    expect(teamAt(null, [], Date.now())).toBeNull()
  })
  it('the next periods of one 조', () => {
    const n = nextShifts(rot, [], 'B', at('2026-11-25', '12:00'), 2)
    expect(n.map((s) => s.from)).toEqual([at('2026-12-07', '09:00'), at('2027-01-04', '09:00')])
  })
})

const roles: CmdRole[] = [
  { id: 'r1', modeId: 'm', parentId: null, name: '조장', sort: 0, hasDuty: false },
  { id: 'r2', modeId: 'm', parentId: null, name: '현장지휘팀', sort: 1, hasDuty: false },
  { id: 'r3', modeId: 'm', parentId: 'r2', name: '통신지원요원', sort: 0, hasDuty: true },
  { id: 'r4', modeId: 'm2', parentId: null, name: '총괄지휘부', sort: 0, hasDuty: false }
]

describe('분류 트리', () => {
  it('tree order, children, path', () => {
    expect(roleTree(roles, 'm').map((x) => `${x.depth}:${x.role.name}`)).toEqual(['0:조장', '0:현장지휘팀', '1:통신지원요원'])
    expect([...roleWithChildren(roles, 'r2')].sort()).toEqual(['r2', 'r3'])
    expect(rolePath(roles, 'r3')).toBe('현장지휘팀 > 통신지원요원')
  })
})

describe('인원총괄현황', () => {
  it('counts per 조, the common duties, exceptions and members outside', () => {
    const h = headcount({
      teams: [
        { id: 'A', name: 'A조', color: '', sort: 0, members: ['p1', 'p2', 'x:t'] },
        { id: 'B', name: 'B조', color: '', sort: 1, members: ['p3'] }
      ],
      people: [
        { id: 'p1', name: '', title: '', dept: '', temp: false },
        { id: 'p2', name: '', title: '', dept: '', temp: false },
        { id: 'p3', name: '', title: '', dept: '', temp: false },
        { id: 'p4', name: '', title: '', dept: '', temp: false },
        { id: 'p5', name: '', title: '', dept: '', temp: false },
        { id: 'x:t', name: '', title: '', dept: '', temp: true }
      ],
      assignments: [{ roleId: 'r1', teamId: 'A', personId: 'p1' }],
      roles,
      common: [{ id: 'c', name: '운전', description: '', perTeam: false, sort: 0, assign: [{ teamId: '', personId: 'p1' }, { teamId: '', personId: 'p4' }] }],
      exceptions: [{ id: 'e', personId: 'p5', reason: '교육', fromDate: '2026-11-01', toDate: '2026-11-30' }],
      modeId: 'm',
      today: '2026-11-25'
    })
    expect(h.teams).toEqual([
      { teamId: 'A', members: 3, temps: 1, placed: 1, unplaced: 2, absent: 0 },
      { teamId: 'B', members: 1, temps: 0, placed: 0, unplaced: 1, absent: 0 }
    ])
    expect([h.common, h.exceptions, h.outside, h.total]).toEqual([2, 1, 1, 6])
    expect(activeExceptions([{ id: 'e', personId: 'p', reason: '', fromDate: '2026-11-01', toDate: '2026-11-24' }], '2026-11-25')).toEqual([])
  })
  it("people of the host's list (미등록 인원) count only once they have a place", () => {
    const g = (id: string) => ({ id, name: '', title: '', dept: '', temp: true, source: '미등록 인원' })
    const h = headcount({
      teams: [{ id: 'A', name: 'A조', color: '', sort: 0, members: ['p1', 'g:1'] }],
      people: [{ id: 'p1', name: '', title: '', dept: '', temp: false }, g('g:1'), g('g:2'), g('g:3'), g('g:4')],
      assignments: [],
      roles,
      common: [{ id: 'c', name: '운전', description: '', perTeam: false, sort: 0, assign: [{ teamId: '', personId: 'g:2' }] }],
      exceptions: [{ id: 'e', personId: 'g:3', reason: '교육', fromDate: '2026-11-01', toDate: null }],
      modeId: 'm',
      today: '2026-11-25'
    })
    // g:4 is on the list but nowhere here
    expect([h.teams[0].temps, h.outside, h.total]).toEqual([1, 0, 4])
  })
})

const members: DrillMember[] = [
  { memberId: 'a', name: '가', title: '소방장', teamId: 'A', roleIds: ['r1'], common: false },
  { memberId: 'b', name: '나', title: '소방교', teamId: 'A', roleIds: ['r3'], common: false },
  { memberId: 'c', name: '다', title: '소방사', teamId: 'A', roleIds: [], common: true }
]
const msg = (o: Partial<DrillMsg>): DrillMsg => ({ id: 'm1', sort: 0, offsetMin: 0, title: '', bodyHtml: '', targetKind: 'role', targetIds: ['r2'], handling: 'assigned', answerKind: 'text', choices: [], correctIndex: null, limitMin: 5, popup: true, mapChanges: [], targets: [], sentAt: 1000, skipped: false, answers: [], done: false, adHoc: false, ...o })

describe('훈련', () => {
  it('targets by role (with what is under it), by person, everybody', () => {
    expect(resolveTargets(msg({}), members, roles)).toEqual(['b'])
    expect(resolveTargets(msg({ targetKind: 'person', targetIds: ['c', 'z'] }), members, roles)).toEqual(['c'])
    expect(resolveTargets(msg({ handling: 'all' }), members, roles)).toEqual(['a', 'b', 'c'])
  })
  it('who may answer, when it is done, who still has to', () => {
    const answer = (memberId: string) => ({ id: memberId, msgId: 'm1', memberId, name: '', body: 'x', choiceIndex: null, attachments: [], answeredAt: 2000, seconds: 1, late: false, grade: null, comment: '', gradedByName: null })
    const assigned = msg({ targets: ['b'] })
    expect(answerRefusal(assigned, 'a', true)).toContain('처리 담당이 아닙니다')
    expect(answerRefusal(assigned, 'b', true)).toBe('')
    expect(answerRefusal(assigned, 'b', false)).toContain('참가자가 아닙니다')
    expect(answerRefusal({ ...assigned, sentAt: null }, 'b', true)).toContain('보내지 않은')
    const first = msg({ handling: 'first', targets: ['b'], answers: [answer('a')] })
    expect(answerRefusal(first, 'c', true)).toContain('이미 처리')
    expect(msgDone(first)).toBe(true)
    expect(waitsFor(first, 'b')).toBe(false)
    const all = msg({ handling: 'all', targets: ['a', 'b', 'c'], answers: [answer('a')] })
    expect(msgDone(all)).toBe(false)
    expect([waitsFor(all, 'a'), waitsFor(all, 'b')]).toEqual([false, true])
  })
  it('the clock leaves pauses out', () => {
    expect(drillElapsedMs({ state: 'running', startedAt: 1000, pausedAt: null, pausedMs: 200, endedAt: null }, 2000)).toBe(800)
    expect(drillElapsedMs({ state: 'paused', startedAt: 1000, pausedAt: 1500, pausedMs: 100, endedAt: null }, 9999)).toBe(400)
    expect(drillElapsedMs({ state: 'scheduled', startedAt: null, pausedAt: null, pausedMs: 0, endedAt: null }, 9999)).toBe(0)
  })
  it('map changes: add, move (a new version), remove; and the map at any moment', () => {
    let n = 0
    const nid = (): string => `v${++n}`
    const cur: Mark[] = [{ id: 'v0', key: 'k1', kind: 'pin', icon: 'fire', color: '#dc2626', label: '화점', points: [[0.5, 0.5]], createdAt: 0, removedAt: null }]
    const r = applyMarkChanges(cur, [{ op: 'move', key: 'k1', points: [[0.6, 0.5]] }, { op: 'add', mark: { key: 'k2', kind: 'text', color: '#2563eb', label: '지휘소', points: [[0.1, 0.1]] } }, { op: 'remove', key: 'nope' }], nid)
    expect(r.close).toEqual(['v0'])
    expect(r.add.map((m) => [m.id, m.key, m.points[0]])).toEqual([
      ['v1', 'k1', [0.6, 0.5]],
      ['v2', 'k2', [0.1, 0.1]]
    ])
    const all: Mark[] = [{ ...cur[0], removedAt: 100 }, { ...r.add[0], createdAt: 100 }, { ...r.add[1], createdAt: 100 }]
    expect(marksAt(all, 50).map((m) => m.id)).toEqual(['v0'])
    expect(marksAt(all, 100).map((m) => m.id)).toEqual(['v1', 'v2'])
  })
  it('the summary by person and by role', () => {
    const a = (memberId: string, seconds: number, late: boolean, grade: 'good' | null, choiceIndex: number | null = null) => ({ id: memberId + seconds, msgId: '', memberId, name: '', body: '', choiceIndex, attachments: [], answeredAt: 0, seconds, late, grade, comment: '', gradedByName: null })
    const s = drillSummary(
      {
        members,
        messages: [
          msg({ id: 'm1', targets: ['b'], answers: [a('b', 60, false, 'good')] }),
          msg({ id: 'm2', handling: 'all', targets: ['a', 'b', 'c'], answers: [a('a', 30, false, null), a('b', 400, true, null)] }),
          msg({ id: 'm3', answerKind: 'choice', choices: ['1', '2'], correctIndex: 1, targets: ['b'], answers: [a('b', 10, false, null, 1)] }),
          msg({ id: 'm4', sentAt: null, targets: ['a'] })
        ]
      },
      roles
    )
    const b = s.people.find((p) => p.key === 'b')!
    expect([b.received, b.answered, b.late, b.avgSeconds, b.grades.good, b.choiceAsked, b.choiceRight]).toEqual([3, 3, 1, 157, 1, 1, 1])
    expect(s.people.find((p) => p.key === 'c')).toMatchObject({ received: 1, answered: 0 })
    expect(s.total).toMatchObject({ received: 5, answered: 4 })
    expect(s.roles.find((r) => r.key === 'r3')).toMatchObject({ name: '현장지휘팀 > 통신지원요원', received: 3 })
  })
})
