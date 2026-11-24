import type { DepartmentDto } from './schemas/org'

/** What the tree needs to know about a person; MemberDto fits. */
export interface OrgPerson {
  id: string
  name: string
  deptId: string | null
  orgSort?: number
}

export interface OrgNode<M extends OrgPerson> {
  dept: DepartmentDto
  depth: number
  /** the department head, wherever they belong; null when none is set or they are not in the list */
  head: M | null
  /** people of this department itself: the head first (when they belong here), then by order, then by name */
  members: M[]
  children: OrgNode<M>[]
  /** people in this department and all below it */
  total: number
}

export interface OrgTree<M extends OrgPerson> {
  roots: OrgNode<M>[]
  /** people with no department (or one that no longer exists) */
  unassigned: M[]
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'ko')
/** 0 means "no order given": those come after the ordered ones. */
const orderOf = (m: OrgPerson): number => (m.orgSort && m.orgSort > 0 ? m.orgSort : Number.MAX_SAFE_INTEGER)

export function sortPeople<M extends OrgPerson>(list: M[], headId?: string | null): M[] {
  return [...list].sort((a, b) => Number(b.id === headId) - Number(a.id === headId) || orderOf(a) - orderOf(b) || byName(a, b))
}

export const sortDepartments = <D extends { sort: number; name: string }>(list: D[]): D[] => [...list].sort((a, b) => a.sort - b.sort || byName(a, b))

/**
 * Departments nested by parent with their people. A department whose parent is missing, or that
 * sits in a loop of parents, is shown at the top so that nobody disappears from the chart.
 */
export function buildOrgTree<M extends OrgPerson>(depts: DepartmentDto[], people: M[]): OrgTree<M> {
  const ids = new Set(depts.map((d) => d.id))
  const byId = new Map(people.map((p) => [p.id, p]))
  const seen = new Set<string>()
  const build = (d: DepartmentDto, depth: number): OrgNode<M> => {
    seen.add(d.id)
    const children = sortDepartments(depts.filter((c) => c.parentId === d.id && !seen.has(c.id))).map((c) => build(c, depth + 1))
    const members = sortPeople(
      people.filter((p) => p.deptId === d.id),
      d.headId
    )
    return { dept: d, depth, head: (d.headId && byId.get(d.headId)) || null, members, children, total: members.length + children.reduce((n, c) => n + c.total, 0) }
  }
  const roots = sortDepartments(depts.filter((d) => !d.parentId || !ids.has(d.parentId))).map((d) => build(d, 0))
  // what is left sits in a loop (a -> b -> a): show each loop from one of its departments
  for (const d of sortDepartments(depts)) if (!seen.has(d.id)) roots.push(build(d, 0))
  return { roots, unassigned: sortPeople(people.filter((p) => !p.deptId || !ids.has(p.deptId))) }
}

/** The tree top-down, parents before children (for lists and select boxes). */
export function flattenOrg<M extends OrgPerson>(nodes: OrgNode<M>[]): OrgNode<M>[] {
  return nodes.flatMap((n) => [n, ...flattenOrg(n.children)])
}

/** A department and everything below it. */
export function subtreeIds(depts: { id: string; parentId: string | null }[], rootId: string): Set<string> {
  const out = new Set<string>([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const d of depts) {
      if (d.parentId && out.has(d.parentId) && !out.has(d.id)) {
        out.add(d.id)
        grew = true
      }
    }
  }
  return out
}

/** The node of one department, searched through the whole tree. */
export function findOrgNode<M extends OrgPerson>(nodes: OrgNode<M>[], deptId: string): OrgNode<M> | null {
  for (const n of nodes) {
    if (n.dept.id === deptId) return n
    const hit = findOrgNode(n.children, deptId)
    if (hit) return hit
  }
  return null
}

/**
 * Keep only the people `keep` accepts; departments left with nobody in them or below them go
 * (unless `keepDept` asks to keep them, e.g. a department whose name matches a search).
 */
export function pruneOrg<M extends OrgPerson>(nodes: OrgNode<M>[], keep: (m: M) => boolean, keepDept: (d: DepartmentDto) => boolean = () => false, depth = 0): OrgNode<M>[] {
  const out: OrgNode<M>[] = []
  for (const n of nodes) {
    const children = pruneOrg(n.children, keep, keepDept, depth + 1)
    const members = n.members.filter(keep)
    if (!members.length && !children.length && !keepDept(n.dept)) continue
    out.push({ ...n, depth, members, children, total: members.length + children.reduce((s, c) => s + c.total, 0) })
  }
  return out
}

/** People cards under one department wrap into a grid this wide, so a big department stays compact. */
export function memberColumns(count: number): number {
  if (count <= 1) return 1
  if (count <= 4) return 2
  if (count <= 9) return 3
  return 4
}
