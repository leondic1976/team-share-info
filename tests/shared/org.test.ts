import { describe, it, expect } from 'vitest'
import {
  DEPT_SEP,
  affiliationText,
  buildOrgTree,
  cleanDeptName,
  deptDepth,
  deptHeight,
  deptKey,
  deptNameError,
  deptOptions,
  deptPath,
  deptPathText,
  findDeptByPath,
  findOrgNode,
  flattenOrg,
  matchDeptPath,
  memberColumns,
  parseDeptPath,
  pruneOrg,
  siblingNameTaken,
  sortPeople,
  subtreeIds,
  type OrgPerson
} from '../../src/shared/org'
import type { DepartmentDto } from '../../src/shared/schemas/org'

const dept = (id: string, parentId: string | null = null, sort = 0, headId: string | null = null): DepartmentDto => ({ id, name: id, parentId, sort, headId })
const person = (id: string, deptId: string | null, orgSort = 0): OrgPerson => ({ id, name: id, deptId, orgSort })

describe('org chart tree', () => {
  const depts = [dept('과', null, 1, 'p1'), dept('나팀', '과', 2), dept('가팀', '과', 1, 'p3'), dept('계', '가팀', 1), dept('다른과', null, 2)]
  const people = [person('p1', '과'), person('p2', '과'), person('p3', '가팀', 3), person('p4', '가팀', 1), person('p5', '가팀'), person('p6', '계'), person('p7', null), person('p8', 'gone')]

  it('nests departments by parent in their order and counts people below', () => {
    const t = buildOrgTree(depts, people)
    expect(t.roots.map((n) => n.dept.id)).toEqual(['과', '다른과'])
    const top = t.roots[0]
    expect(top.children.map((n) => n.dept.id)).toEqual(['가팀', '나팀'])
    expect(top.children[0].children.map((n) => n.dept.id)).toEqual(['계'])
    expect([top.depth, top.children[0].depth, top.children[0].children[0].depth]).toEqual([0, 1, 2])
    expect(top.total).toBe(6)
    expect(top.children[0].total).toBe(4)
    expect(t.roots[1].total).toBe(0)
    expect(flattenOrg(t.roots).map((n) => n.dept.id)).toEqual(['과', '가팀', '계', '나팀', '다른과'])
    expect(findOrgNode(t.roots, '계')?.members.map((m) => m.id)).toEqual(['p6'])
    expect(findOrgNode(t.roots, 'x')).toBeNull()
  })

  it('lists the head first, then the given order, then names; people without a department apart', () => {
    const t = buildOrgTree(depts, people)
    const team = findOrgNode(t.roots, '가팀')!
    expect(team.head?.id).toBe('p3')
    expect(team.members.map((m) => m.id)).toEqual(['p3', 'p4', 'p5'])
    expect(t.roots[0].members.map((m) => m.id)).toEqual(['p1', 'p2'])
    expect(t.unassigned.map((m) => m.id)).toEqual(['p7', 'p8'])
    expect(sortPeople([person('b', null), person('a', null), person('c', null, 2), person('d', null, 1)]).map((m) => m.id)).toEqual(['d', 'c', 'a', 'b'])
  })

  it('a head from another department is named but stays listed where they belong', () => {
    const t = buildOrgTree([dept('a', null, 1, 'x'), dept('b', null, 2)], [person('x', 'b'), person('y', 'a')])
    expect(t.roots[0].head?.id).toBe('x')
    expect(t.roots[0].members.map((m) => m.id)).toEqual(['y'])
    expect(t.roots[1].members.map((m) => m.id)).toEqual(['x'])
    // a head that is no longer in the list
    expect(buildOrgTree([dept('a', null, 1, 'gone')], []).roots[0].head).toBeNull()
  })

  it('shows departments with a missing parent or in a loop at the top instead of losing them', () => {
    const t = buildOrgTree([dept('orphan', 'gone'), dept('x', 'y'), dept('y', 'x')], [person('p', 'y')])
    const ids = flattenOrg(t.roots).map((n) => n.dept.id)
    expect(ids.sort()).toEqual(['orphan', 'x', 'y'])
    expect(t.roots.map((n) => n.dept.id)).toContain('orphan')
    expect(t.roots.reduce((n, r) => n + r.total, 0)).toBe(1)
    expect(t.unassigned).toEqual([])
  })

  it('finds everything below a department', () => {
    expect([...subtreeIds(depts, '과')].sort()).toEqual(['가팀', '계', '과', '나팀'].sort())
    expect([...subtreeIds(depts, '계')]).toEqual(['계'])
    // a loop ends
    expect(subtreeIds([dept('x', 'y'), dept('y', 'x')], 'x').size).toBe(2)
  })

  it('prunes to the people kept, dropping departments left empty', () => {
    const t = buildOrgTree(depts, people)
    const kept = pruneOrg(t.roots, (m) => m.id === 'p6')
    expect(flattenOrg(kept).map((n) => n.dept.id)).toEqual(['과', '가팀', '계'])
    expect(kept[0].total).toBe(1)
    expect(kept[0].members).toEqual([])
    // a department asked for by name stays even when empty
    const named = pruneOrg(
      t.roots,
      () => false,
      (d) => d.id === '나팀'
    )
    expect(flattenOrg(named).map((n) => n.dept.id)).toEqual(['과', '나팀'])
    expect(pruneOrg(t.roots, () => false)).toEqual([])
  })

  it('wraps people into a grid that grows with the head count', () => {
    expect([0, 1, 2, 4, 5, 9, 10, 100].map(memberColumns)).toEqual([1, 1, 2, 2, 3, 3, 4, 4])
  })
})

describe('affiliation: a path through the department tree', () => {
  const d = (id: string, name: string, parentId: string | null = null, sort = 0): DepartmentDto => ({ id, name, parentId, sort })
  // 본부 > (총무과 > (서무팀, 회계팀), 기획과 > 서무팀), 감사실
  const depts = [d('hq', '본부', null, 1), d('audit', '감사실', null, 2), d('ga', '총무과', 'hq', 1), d('plan', '기획과', 'hq', 2), d('ga1', '서무팀', 'ga', 1), d('ga2', '회계팀', 'ga', 2), d('plan1', '서무팀', 'plan', 1)]

  it('gives the path, its text and the depth of a department', () => {
    expect(deptPath(depts, 'ga1')).toEqual(['본부', '총무과', '서무팀'])
    expect(deptPath(depts, 'hq')).toEqual(['본부'])
    expect(deptPath(depts, 'gone')).toEqual([])
    expect(deptPath(depts, null)).toEqual([])
    expect(deptPathText(deptPath(depts, 'plan1'))).toBe('본부 > 기획과 > 서무팀')
    expect(DEPT_SEP).toBe(' > ')
    expect(deptPathText([])).toBe('')
    expect([deptDepth(depts, 'hq'), deptDepth(depts, 'ga'), deptDepth(depts, 'ga1'), deptDepth(depts, 'x')]).toEqual([1, 2, 3, 0])
    expect([deptHeight(depts, 'hq'), deptHeight(depts, 'ga'), deptHeight(depts, 'ga1')]).toEqual([3, 2, 1])
    // a loop of parents ends
    const loop = [d('x', 'X', 'y'), d('y', 'Y', 'x')]
    expect(deptPath(loop, 'x')).toEqual(['Y', 'X'])
    expect(deptHeight(loop, 'x')).toBe(2)
  })

  it('shows a person in full, or by the plain name from an older server', () => {
    expect(affiliationText({ deptPath: ['본부', '총무과'], deptName: '총무과' })).toBe('본부 > 총무과')
    expect(affiliationText({ deptName: '총무과' })).toBe('총무과')
    expect(affiliationText({ deptPath: [], deptName: null })).toBe('')
  })

  it('lists the departments in tree order with indentation', () => {
    const o = deptOptions(depts)
    expect(o.map((x) => x.id)).toEqual(['hq', 'ga', 'ga1', 'ga2', 'plan', 'plan1', 'audit'])
    expect(o.map((x) => x.depth)).toEqual([0, 1, 2, 2, 1, 2, 0])
    expect(o[2].path).toEqual(['본부', '총무과', '서무팀'])
    expect(o[0].label).toBe('본부')
    expect(o[2].label.endsWith('서무팀')).toBe(true)
    expect(o[2].label.length).toBeGreaterThan(o[1].label.length - 1)
    // a missing parent or a loop: still listed, at the top
    expect(deptOptions([d('o', '고아', 'gone'), d('x', 'X', 'y'), d('y', 'Y', 'x')]).map((x) => x.id).sort()).toEqual(['o', 'x', 'y'])
  })

  it('reads a typed affiliation and cleans its levels', () => {
    expect(parseDeptPath('본부 > 총무과>서무팀')).toEqual(['본부', '총무과', '서무팀'])
    expect(parseDeptPath(' 본부 / 총무과 /  서무   1팀 ')).toEqual(['본부', '총무과', '서무 1팀'])
    expect(parseDeptPath('본부 > > / 팀 >')).toEqual(['본부', '팀'])
    expect(parseDeptPath('  ')).toEqual([])
    expect(cleanDeptName('  총무\t 과\n')).toBe('총무 과')
    expect(deptNameError('총무과')).toBeNull()
    expect(deptNameError('   ')).not.toBeNull()
    expect(deptNameError('가'.repeat(40))).toBeNull()
    expect(deptNameError('가'.repeat(41))).not.toBeNull()
    expect(deptNameError('과\u0001')).not.toBeNull()
    expect(deptNameError('과 > 팀')).not.toBeNull()
  })

  it('matches names among siblings only, whatever the case and spacing', () => {
    expect(deptKey(' Ga 팀 ')).toBe(deptKey('ga팀'))
    expect(siblingNameTaken(depts, 'ga', '서무 팀')).toBe(true)
    expect(siblingNameTaken(depts, 'ga', '서무팀', 'ga1')).toBe(false) // itself
    expect(siblingNameTaken(depts, 'hq', '서무팀')).toBe(false) // only below 총무과 and 기획과
    expect(siblingNameTaken(depts, null, '본부')).toBe(true)
    expect(siblingNameTaken(depts, null, '총무과')).toBe(false)
  })

  it('walks a typed path down the tree: what exists is found, the rest is missing', () => {
    expect(matchDeptPath(depts, ['본부', '기획과', '서무팀'])).toEqual({ ids: ['hq', 'plan', 'plan1'], missing: [] })
    expect(matchDeptPath(depts, ['본 부', '총무과', '문서팀', '1파트'])).toEqual({ ids: ['hq', 'ga'], missing: ['문서팀', '1파트'] })
    // a name that exists deeper is not matched at the top
    expect(matchDeptPath(depts, ['서무팀'])).toEqual({ ids: [], missing: ['서무팀'] })
    expect(matchDeptPath(depts, [])).toEqual({ ids: [], missing: [] })
    expect(findDeptByPath(depts, ['본부', '총무과', '서무팀'])).toBe('ga1')
    expect(findDeptByPath(depts, ['본부', '기획과', '서무팀'])).toBe('plan1')
    expect(findDeptByPath(depts, ['본부', '없는과'])).toBeNull()
    expect(findDeptByPath(depts, [])).toBeNull()
  })
})
