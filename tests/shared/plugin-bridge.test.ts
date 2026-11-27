import { describe, expect, it } from 'vitest'
import { ABSENCE_RANGE_DAYS, BRIDGE_NEEDS, absenceRange, bridgeRefusal, orderedDepartments, pluginAbsences } from '../../src/shared/plugin-bridge'
import { PLUGIN_PERMISSIONS } from '../../src/shared/schemas/plugins'
import type { DutyEntryDto } from '../../src/shared/schemas/duty'

describe('plugin bridge: permissions of TeamHub.call', () => {
  it('lets the absences of 근무현황 through only with the duty permission', () => {
    expect(bridgeRefusal('absences', new Set(['members', 'rooms']))).toBe('권한이 없습니다(duty). 확장 기능 정보에 권한이 선언되어야 합니다.')
    expect(bridgeRefusal('absences', new Set(['duty']))).toBeNull()
    // the org order goes with the names of the members
    expect(bridgeRefusal('departments', new Set())).toContain('권한이 없습니다(members)')
    expect(bridgeRefusal('departments', new Set(['members']))).toBeNull()
  })
  it('refuses unknown methods and lets the free ones through', () => {
    expect(bridgeRefusal('toString', new Set(['members']))).toBe('알 수 없는 기능: toString')
    expect(bridgeRefusal('db.dump', new Set(Object.keys(PLUGIN_PERMISSIONS)))).toBe('알 수 없는 기능: db.dump')
    expect(bridgeRefusal('me', new Set())).toBeNull()
    expect(bridgeRefusal('time', new Set())).toBeNull()
  })
  it('only names permissions that exist (and that a manifest can declare)', () => {
    for (const need of Object.values(BRIDGE_NEEDS)) if (need) expect(Object.keys(PLUGIN_PERMISSIONS)).toContain(need)
    expect(PLUGIN_PERMISSIONS.duty).toBe('근무현황의 부재(사유·기간) 보기')
  })
})

describe('plugin bridge: absences', () => {
  const midnight = (y: number, m: number, d: number): number => new Date(y, m - 1, d).getTime()
  it('turns two dates (both included) into the range of GET /api/duty, 100 days at most', () => {
    expect(absenceRange('2026-11-01', '2026-11-30')).toEqual({ from: midnight(2026, 11, 1), to: midnight(2026, 12, 1) })
    expect(absenceRange('2026-11-23', '2026-11-23')).toEqual({ from: midnight(2026, 11, 23), to: midnight(2026, 11, 24) })
    // 100 days: 2026-11-01 .. 2027-02-08
    expect(absenceRange('2026-11-01', '2027-02-08').to).toBe(midnight(2027, 2, 9))
    expect(() => absenceRange('2026-11-01', '2027-02-09')).toThrow(`${ABSENCE_RANGE_DAYS}일까지`)
    for (const [a, b] of [
      ['2026-11-30', '2026-11-01'],
      ['2026-02-30', '2026-03-01'],
      ['20261101', '2026-11-02'],
      ['', '']
    ])
      expect(() => absenceRange(a, b)).toThrow('조회 기간이 올바르지 않습니다.')
  })
  it('hands the frame only who, why and when (no place, note or who recorded it)', () => {
    const e: DutyEntryDto = { id: 'e1', key: 1, memberId: 'kim', type: '출장', start: 1, end: 2, allDay: false, place: '세종청사', note: '회의', recurring: true, registeredByName: '박서무' }
    expect(pluginAbsences([e])).toEqual([{ memberId: 'kim', type: '출장', start: 1, end: 2, allDay: false }])
  })
})

describe('plugin bridge: departments in 직제순', () => {
  it('walks the org tree top-down, siblings by their order then by name, and gives the path', () => {
    const depts = [
      { id: 'c', name: '시설팀', parentId: null, sort: 2 },
      { id: 'b2', name: '민원팀', parentId: 'a', sort: 1 },
      { id: 'b1', name: '총무과', parentId: 'a', sort: 0 },
      { id: 'a', name: '본부', parentId: null, sort: 1 },
      { id: 'b3', name: '가나팀', parentId: 'a', sort: 1 },
      { id: 'x', name: '고아팀', parentId: 'gone', sort: 0 },
      { id: 'd', name: '운영반', parentId: 'b1', sort: 0 }
    ]
    expect(orderedDepartments(depts).map((d) => [d.order, d.name, d.path.join(' > ')])).toEqual([
      [0, '고아팀', '고아팀'],
      [1, '본부', '본부'],
      [2, '총무과', '본부 > 총무과'],
      [3, '운영반', '본부 > 총무과 > 운영반'],
      [4, '가나팀', '본부 > 가나팀'],
      [5, '민원팀', '본부 > 민원팀'],
      [6, '시설팀', '시설팀']
    ])
    expect(orderedDepartments([])).toEqual([])
  })
})
