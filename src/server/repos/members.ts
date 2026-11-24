import type { Db } from '../../node/sqlite'
import { newId } from '../../node/sqlite'
import type { MemberDto, Presence, Role } from '../../shared/schemas/auth'
import type { DepartmentDto } from '../../shared/schemas/org'
import { DEPT_MAX_DEPTH, cleanDeptName, deptPath, matchDeptPath } from '../../shared/org'

export interface MemberRow {
  id: string
  name: string
  dept_id: string | null
  dept_name: string | null
  title: string | null
  ext: string | null
  mobile: string | null
  duty: string | null
  role: Role
  status: 'active' | 'suspended'
  status_message: string | null
  last_seen_at: number | null
  nickname: string | null
  admin_fields: string
  rank: string | null
  org_sort: number
  /** the names from the top department down to the member's own; filled by getMember / listMembers */
  dept_path?: string[]
}

const SELECT = `SELECT m.*, d.name AS dept_name FROM members m LEFT JOIN departments d ON d.id = m.dept_id`

/** `ownerId`: the server PC's account (ownerMemberId), which marks the 최종관리자. */
export function toMemberDto(r: MemberRow, presence: Presence = 'offline', ownerId = ''): MemberDto {
  return {
    isOwner: !!ownerId && r.id === ownerId,
    id: r.id,
    name: r.name,
    deptId: r.dept_id,
    deptName: r.dept_name,
    deptPath: r.dept_path ?? (r.dept_name ? [r.dept_name] : []),
    title: r.title,
    ext: r.ext,
    mobile: r.mobile,
    duty: r.duty,
    role: r.role,
    status: r.status,
    statusMessage: r.status_message,
    lastSeenAt: r.last_seen_at,
    presence,
    nickname: r.nickname,
    adminFields: adminFieldsOf(r),
    rank: r.rank ?? null,
    orgSort: r.org_sort ?? 0
  }
}

/** Details an admin set for this member (they win over what the member types). */
export function adminFieldsOf(r: Pick<MemberRow, 'admin_fields'>): string[] {
  try {
    const v = JSON.parse(r.admin_fields || '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function setAdminFields(db: Db, id: string, fields: string[]): void {
  db.run('UPDATE members SET admin_fields = ? WHERE id = ?', [JSON.stringify([...new Set(fields)]), id])
}

export function getMember(db: Db, id: string): MemberRow | undefined {
  const r = db.get<MemberRow>(`${SELECT} WHERE m.id = ?`, [id])
  if (r) r.dept_path = r.dept_id ? deptPathOf(db, r.dept_id) : []
  return r
}

/** The names from the top department down to this one. */
export function deptPathOf(db: Db, deptId: string): string[] {
  return db
    .all<{ name: string }>(
      `WITH RECURSIVE up(id, name, parent_id, lvl) AS (
         SELECT id, name, parent_id, 0 FROM departments WHERE id = ?
         UNION ALL
         SELECT p.id, p.name, p.parent_id, up.lvl + 1 FROM departments p JOIN up ON p.id = up.parent_id WHERE up.lvl < 20
       ) SELECT name FROM up ORDER BY lvl DESC`,
      [deptId]
    )
    .map((r) => r.name)
}

export function listMembers(db: Db, opts: { includeSuspended?: boolean } = {}): MemberRow[] {
  const where = opts.includeSuspended ? '' : `WHERE m.status = 'active'`
  // within a department: the order an admin set (org_sort, 관리 → 구성원 순서), then by name
  const rows = db.all<MemberRow>(`${SELECT} ${where} ORDER BY d.sort, d.name, CASE WHEN m.org_sort > 0 THEN m.org_sort ELSE 2147483647 END, m.name`)
  const depts = listDepartments(db)
  const paths = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.dept_id) r.dept_path = []
    else {
      if (!paths.has(r.dept_id)) paths.set(r.dept_id, deptPath(depts, r.dept_id))
      r.dept_path = paths.get(r.dept_id)
    }
  }
  return rows
}

/**
 * The department an affiliation names (top level first): every level is matched among the
 * departments of the level before it, ignoring case and spacing; levels that do not exist are
 * created there. `enteredBy` marks the created ones as typed by that person (see migration 22).
 * The path is cut at the depth cap. Returns null for an empty path.
 */
export function ensureDeptPath(db: Db, path: string[], enteredBy: string | null = null): { id: string; created: { id: string; name: string }[] } | null {
  const names = path.map(cleanDeptName).filter(Boolean).slice(0, DEPT_MAX_DEPTH)
  if (!names.length) return null
  const m = matchDeptPath(listDepartments(db), names)
  let parent = m.ids.length ? m.ids[m.ids.length - 1] : null
  const created: { id: string; name: string }[] = []
  const t = Date.now()
  for (const name of m.missing) {
    const id = newId()
    const last = db.get<{ n: number | null }>('SELECT MAX(sort) AS n FROM departments WHERE parent_id IS ?', [parent])?.n ?? 0
    db.run('INSERT INTO departments (id, name, parent_id, sort, entered_by, entered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, name, parent, last + 1, enteredBy, enteredBy ? t : null, t, t])
    created.push({ id, name })
    parent = id
  }
  return { id: parent!, created }
}

/** A top-level department by name (made when missing): the server setup and one-level entries. */
export function ensureDepartment(db: Db, name: string): string | null {
  return ensureDeptPath(db, [name])?.id ?? null
}

export function createMember(
  db: Db,
  input: { name: string; deptName?: string; title?: string; ext?: string; role?: Role; /** the affiliation the person typed themselves (join screen): new levels are marked as theirs */ deptPath?: string[] }
): string {
  const id = newId()
  const t = Date.now()
  db.run(
    `INSERT INTO members (id, name, dept_id, title, ext, role, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, 'active', ?, ?)`,
    [id, input.name, input.title || null, input.ext || null, input.role ?? 'member', t, t]
  )
  const dept = input.deptPath?.length ? ensureDeptPath(db, input.deptPath, id) : ensureDeptPath(db, [input.deptName ?? ''])
  if (dept) db.run('UPDATE members SET dept_id = ? WHERE id = ?', [dept.id, id])
  return id
}

export function updateMember(db: Db, id: string, patch: Record<string, string | number | null | undefined>): void {
  const map: Record<string, string> = {
    name: 'name',
    role: 'role',
    status: 'status',
    deptId: 'dept_id',
    title: 'title',
    ext: 'ext',
    mobile: 'mobile',
    duty: 'duty',
    statusMessage: 'status_message',
    nickname: 'nickname',
    rank: 'rank',
    orgSort: 'org_sort'
  }
  const sets: string[] = []
  const vals: (string | number | null)[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !map[k]) continue
    sets.push(`${map[k]} = ?`)
    vals.push(v)
  }
  if (!sets.length) return
  sets.push('updated_at = ?')
  vals.push(Date.now(), id)
  db.run(`UPDATE members SET ${sets.join(', ')} WHERE id = ?`, vals)
}

export function countAdmins(db: Db): number {
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND status = 'active'`)?.n ?? 0
}

export function listDepartments(db: Db): DepartmentDto[] {
  return db
    .all<{ id: string; name: string; parent_id: string | null; sort: number; head_id: string | null; phone: string | null; duties: string | null; location: string | null; entered_by: string | null; entered_at: number | null }>(
      'SELECT id, name, parent_id, sort, head_id, phone, duties, location, entered_by, entered_at FROM departments ORDER BY sort, name'
    )
    .map((d) => ({ id: d.id, name: d.name, parentId: d.parent_id, sort: d.sort, headId: d.head_id, phone: d.phone, duties: d.duties, location: d.location, enteredBy: d.entered_by, enteredAt: d.entered_at }))
}
