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

// ---- affiliation (소속): where a person belongs is a path through the department tree ----

/** Between the levels of an affiliation, everywhere it is shown or typed: "본부 > 과 > 팀". */
export const DEPT_SEP = ' > '
/** How deep the tree may go (본부 > 국 > 과 > 팀 > 파트 > 반). */
export const DEPT_MAX_DEPTH = 6
export const DEPT_NAME_MAX = 40
/** New departments one person may add by typing their own affiliation, per 24 hours. */
export const DEPT_ENTERED_PER_DAY = 6

type DeptLike = { id: string; name: string; parentId: string | null }

/** Two names are the same department name when they differ only in case or spacing. */
export function deptKey(name: string): string {
  return name.normalize('NFC').replace(/\s+/g, '').toLowerCase()
}

/** One level as it is stored: no control characters, single spaces, trimmed. */
export function cleanDeptName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Why a typed level cannot be a department name, or null when it can. */
export function deptNameError(name: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return '소속 이름에 쓸 수 없는 문자가 있습니다.'
  const n = cleanDeptName(name)
  if (!n) return '소속 이름을 입력하세요.'
  if (n.length > DEPT_NAME_MAX) return `소속 이름은 한 단계에 ${DEPT_NAME_MAX}자까지입니다.`
  if (n.includes('>')) return "소속 이름에는 '>'를 쓸 수 없습니다."
  return null
}

/** "본부 > 과 / 팀" as typed on one line → ['본부', '과', '팀'] (split on '>' and '/'). */
export function parseDeptPath(text: string): string[] {
  return text
    .split(/[>/]/)
    .map(cleanDeptName)
    .filter(Boolean)
}

/** The names from the top department down to this one; [] when it is not in the list. A loop of parents ends. */
export function deptPath(depts: DeptLike[], id: string | null | undefined): string[] {
  const byId = new Map(depts.map((d) => [d.id, d]))
  const out: string[] = []
  const seen = new Set<string>()
  let cur = id ? byId.get(id) : undefined
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    out.unshift(cur.name)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return out
}

/** How many levels down a department sits: 1 at the top, 0 when unknown. */
export const deptDepth = (depts: DeptLike[], id: string | null | undefined): number => deptPath(depts, id).length

/** Levels in a department and below it: 1 when it has no departments below. */
export function deptHeight(depts: DeptLike[], id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0
  seen.add(id)
  return 1 + depts.filter((d) => d.parentId === id).reduce((n, c) => Math.max(n, deptHeight(depts, c.id, seen)), 0)
}

export const deptPathText = (path: string[] | null | undefined): string => (path ?? []).join(DEPT_SEP)

/** A person's affiliation in full ("본부 > 과 > 팀"); the plain department name from servers that send no path. */
export function affiliationText(m: { deptPath?: string[] | null; deptName?: string | null }): string {
  return m.deptPath?.length ? deptPathText(m.deptPath) : (m.deptName ?? '')
}

export interface DeptOption {
  id: string
  name: string
  depth: number
  path: string[]
  /** the name indented by its depth, for a select box */
  label: string
}

/** Every department in tree order (parents before children, siblings in their order) for pickers. */
export function deptOptions<D extends DeptLike & { sort: number }>(depts: D[]): DeptOption[] {
  const ids = new Set(depts.map((d) => d.id))
  const seen = new Set<string>()
  const out: DeptOption[] = []
  const walk = (list: D[], path: string[]): void => {
    for (const d of sortDepartments(list)) {
      if (seen.has(d.id)) continue
      seen.add(d.id)
      const p = [...path, d.name]
      out.push({ id: d.id, name: d.name, depth: path.length, path: p, label: `${'\u00a0\u00a0\u00a0'.repeat(path.length)}${d.name}` })
      walk(
        depts.filter((c) => c.parentId === d.id),
        p
      )
    }
  }
  walk(
    depts.filter((d) => !d.parentId || !ids.has(d.parentId)),
    []
  )
  // departments in a loop of parents: listed at the top, like in the chart
  for (const d of sortDepartments(depts)) if (!seen.has(d.id)) walk([d], [])
  return out
}

/**
 * 직제순: each department's place in the org order the server PC sets (tree order, siblings by
 * their order then name). Lists sort by it so a sub-department never lands among another
 * parent's departments.
 */
export function deptRank<D extends DeptLike & { sort: number }>(depts: D[]): Map<string, number> {
  return new Map(deptOptions(depts).map((o, i) => [o.id, i]))
}

/** Names are unique among the departments of one parent, not in the whole tree. */
export function siblingNameTaken(depts: DeptLike[], parentId: string | null, name: string, selfId?: string): boolean {
  const key = deptKey(name)
  return depts.some((d) => d.id !== selfId && (d.parentId ?? null) === (parentId ?? null) && deptKey(d.name) === key)
}

/**
 * Walk a typed affiliation down the tree: each level is matched among the departments of the
 * level before it (ignoring case and spacing). `ids` are the departments found, `missing` the
 * levels from the first one that does not exist yet.
 */
export function matchDeptPath(depts: DeptLike[], path: string[]): { ids: string[]; missing: string[] } {
  const ids: string[] = []
  let parent: string | null = null
  for (let i = 0; i < path.length; i++) {
    const key = deptKey(path[i])
    const hit = depts.find((d) => (d.parentId ?? null) === parent && deptKey(d.name) === key)
    if (!hit) return { ids, missing: path.slice(i) }
    ids.push(hit.id)
    parent = hit.id
  }
  return { ids, missing: [] }
}

/** The department a full path names, or null when a level of it does not exist. */
export function findDeptByPath(depts: DeptLike[], path: string[]): string | null {
  const m = matchDeptPath(depts, path)
  return path.length > 0 && m.missing.length === 0 ? m.ids[m.ids.length - 1] : null
}

/** The chart's layout decisions (rows, compact stacks, member columns, zoom floors). */
export * from './orgLayout'
