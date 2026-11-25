import { describe, it, expect } from 'vitest'
import { DUTY_NO_DEPT, dutySections } from '../../src/shared/dutySections'

const dept = (
  id: string,
  parentId: string | null = null,
  sort = 0,
  headId: string | null = null
): { id: string; name: string; parentId: string | null; sort: number; headId: string | null } => ({
  id,
  name: id,
  parentId,
  sort,
  headId
})
const person = (id: string, deptId: string | null): { id: string; name: string; deptId: string | null } => ({
  id,
  name: id,
  deptId
})

// 본부 (no one of its own) > 총무과 (2) > 인사팀 (1); 본부 > 기획과 (1); 소방서 (1); an empty 감사실; one person without a department
const depts = [
  dept('소방서', null, 2),
  dept('본부', null, 1),
  dept('기획과', '본부', 2),
  dept('총무과', '본부', 1),
  dept('인사팀', '총무과'),
  dept('감사실', null, 3)
]
// the server's order: within a department the order an admin set (here: 나, 가)
const people = [
  person('나', '총무과'),
  person('가', '총무과'),
  person('라', '인사팀'),
  person('다', '기획과'),
  person('마', '소방서'),
  person('바', null)
]

const view = (list: ReturnType<typeof dutySections<ReturnType<typeof person>>>): string[] =>
  list.map(
    (s) =>
      `${'  '.repeat(s.depth)}${s.path.join(' > ') || '부서 미지정'} ${s.members.map((m) => m.id).join('')}/${s.all.length}`
  )

describe('근무현황 by 소속', () => {
  it('walks the department tree from the top, keeps a 소속 whose people sit below it, puts 부서 미지정 last', () => {
    expect(view(dutySections(depts, people))).toEqual([
      '본부 /4',
      '  본부 > 총무과 나가/3',
      '    본부 > 총무과 > 인사팀 라/1',
      '  본부 > 기획과 다/1',
      '소방서 마/1',
      '부서 미지정 바/1'
    ])
  })

  it('subtotals count everyone below, each person once', () => {
    const s = dutySections(depts, people)
    expect(s[0].all.map((m) => m.id)).toEqual(['나', '가', '라', '다'])
    expect(s[0].childCount).toBe(2)
    expect(s.find((x) => x.dept?.id === '감사실')).toBeUndefined()
    expect(s.flatMap((x) => x.members).length).toBe(people.length)
  })

  it('keeps the order the server gives inside a department, the head first', () => {
    expect(dutySections(depts, people)[1].members.map((m) => m.id)).toEqual(['나', '가'])
    const withHead = depts.map((d) => (d.id === '총무과' ? { ...d, headId: '가' } : d))
    expect(dutySections(withHead, people)[1].members.map((m) => m.id)).toEqual(['가', '나'])
  })

  it('one department with what is under it, depth from 0, full path kept', () => {
    expect(view(dutySections(depts, people, '총무과'))).toEqual([
      '본부 > 총무과 나가/3',
      '  본부 > 총무과 > 인사팀 라/1'
    ])
    expect(dutySections(depts, people, '감사실')).toEqual([])
    expect(view(dutySections(depts, people, DUTY_NO_DEPT))).toEqual(['부서 미지정 바/1'])
  })

  it('a department whose parent is gone, and a person in a removed department, still show', () => {
    const s = dutySections([dept('팀', 'gone')], [person('a', '팀'), person('b', 'removed')])
    expect(view(s)).toEqual(['팀 a/1', '부서 미지정 b/1'])
  })
})
