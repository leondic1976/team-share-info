import { buildOrgTree, deptPath, findOrgNode, pruneOrg, type OrgNode, type OrgPerson } from './org'
import type { DepartmentDto } from './schemas/org'

/** Department filter of 근무현황: every 소속, or the people with no department. */
export const DUTY_ALL_DEPTS = 'all'
export const DUTY_NO_DEPT = 'none'

type Dept = Pick<DepartmentDto, 'id' | 'name' | 'parentId' | 'sort'> & { headId?: string | null }

/**
 * One 소속 of the 근무현황 body, in the order of the org chart: a department comes before the
 * departments below it, siblings in the order an admin set, "부서 미지정" last.
 */
export interface DutySection<M> {
  /** null: the people with no department (부서 미지정) */
  dept: Dept | null
  /** levels below the top of what is shown (0 = a top 소속, or the filtered department) */
  depth: number
  /** names from the top department down to this one ("본부", "과", "팀"); [] for 부서 미지정 */
  path: string[]
  /** people of this department itself: the head first, then the order an admin set */
  members: M[]
  /** people of this department and of every department below it (for the subtotals) */
  all: M[]
  /** departments with people shown right below this one */
  childCount: number
}

interface Wrapped<M> extends OrgPerson {
  item: M
}

/**
 * The people of the board grouped by 소속, top-down through the department tree. Departments
 * with nobody in them or below them are left out; a department whose people all sit in the
 * departments below it stays, so those keep their 소속 heading. `only` narrows to one department
 * and everything under it (or to {@link DUTY_NO_DEPT}).
 *
 * The members come in the server's order (within a department: the order an admin set, then by
 * name), which is kept; only the department head is moved first, as in the org chart.
 */
export function dutySections<M extends { id: string; name: string; deptId: string | null }>(
  departments: Dept[],
  members: M[],
  only: string = DUTY_ALL_DEPTS
): DutySection<M>[] {
  const people: Wrapped<M>[] = members.map((m, i) => ({
    id: m.id,
    name: m.name,
    deptId: m.deptId,
    orgSort: i + 1,
    item: m
  }))
  const tree = buildOrgTree(departments as DepartmentDto[], people)
  const out: DutySection<M>[] = []
  const walk = (n: OrgNode<Wrapped<M>>, path: string[], depth: number): M[] => {
    const p = [...path, n.dept.name]
    const sec: DutySection<M> = {
      dept: n.dept,
      depth,
      path: p,
      members: n.members.map((x) => x.item),
      all: [],
      childCount: n.children.length
    }
    out.push(sec)
    sec.all = [...sec.members, ...n.children.flatMap((c) => walk(c, p, depth + 1))]
    return sec.all
  }
  const none = (): void => {
    const list = tree.unassigned.map((x) => x.item)
    if (list.length) out.push({ dept: null, depth: 0, path: [], members: list, all: list, childCount: 0 })
  }
  if (only === DUTY_NO_DEPT) {
    none()
    return out
  }
  if (only === DUTY_ALL_DEPTS) {
    for (const n of pruneOrg(tree.roots, () => true)) walk(n, [], 0)
    none()
    return out
  }
  const node = findOrgNode(tree.roots, only)
  if (!node) return out
  for (const n of pruneOrg([node], () => true)) walk(n, deptPath(departments, node.dept.parentId), 0)
  return out
}
