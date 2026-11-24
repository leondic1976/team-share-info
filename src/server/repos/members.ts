import type { Db } from '../../node/sqlite'
import { newId } from '../../node/sqlite'
import type { MemberDto, Presence, Role } from '../../shared/schemas/auth'
import type { DepartmentDto } from '../../shared/schemas/org'

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
  return db.get<MemberRow>(`${SELECT} WHERE m.id = ?`, [id])
}

export function listMembers(db: Db, opts: { includeSuspended?: boolean } = {}): MemberRow[] {
  const where = opts.includeSuspended ? '' : `WHERE m.status = 'active'`
  return db.all<MemberRow>(`${SELECT} ${where} ORDER BY d.sort, d.name, m.name`)
}

export function ensureDepartment(db: Db, name: string): string | null {
  const n = name.trim()
  if (!n) return null
  const found = db.get<{ id: string }>('SELECT id FROM departments WHERE name = ?', [n])
  if (found) return found.id
  const id = newId()
  const t = Date.now()
  db.run('INSERT INTO departments (id, name, sort, created_at, updated_at) VALUES (?, ?, 0, ?, ?)', [id, n, t, t])
  return id
}

export function createMember(
  db: Db,
  input: { name: string; deptName?: string; title?: string; ext?: string; role?: Role }
): string {
  const id = newId()
  const t = Date.now()
  const deptId = ensureDepartment(db, input.deptName ?? '')
  db.run(
    `INSERT INTO members (id, name, dept_id, title, ext, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [id, input.name, deptId, input.title || null, input.ext || null, input.role ?? 'member', t, t]
  )
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
    .all<{ id: string; name: string; parent_id: string | null; sort: number; head_id: string | null; phone: string | null; duties: string | null; location: string | null }>(
      'SELECT id, name, parent_id, sort, head_id, phone, duties, location FROM departments ORDER BY sort, name'
    )
    .map((d) => ({ id: d.id, name: d.name, parentId: d.parent_id, sort: d.sort, headId: d.head_id, phone: d.phone, duties: d.duties, location: d.location }))
}
