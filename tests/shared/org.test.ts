import { describe, it, expect } from 'vitest'
import { buildOrgTree, findOrgNode, flattenOrg, memberColumns, pruneOrg, sortPeople, subtreeIds, type OrgPerson } from '../../src/shared/org'
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
