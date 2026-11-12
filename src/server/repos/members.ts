import type { Db } from '../../node/sqlite'
import { newId } from '../../node/sqlite'
import type { MemberDto, Presence, Role } from '../../shared/schemas/auth'

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
}

const SELECT = `SELECT m.*, d.name AS dept_name FROM members m LEFT JOIN departments d ON d.id = m.dept_id`

export function toMemberDto(r: MemberRow, presence: Presence = 'offline'): MemberDto {
  return {
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
    presence
  }
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
    statusMessage: 'status_message'
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

export function listDepartments(db: Db): { id: string; name: string; parentId: string | null; sort: number }[] {
  return db
    .all<{ id: string; name: string; parent_id: string | null; sort: number }>(
      'SELECT id, name, parent_id, sort FROM departments ORDER BY sort, name'
    )
    .map((d) => ({ id: d.id, name: d.name, parentId: d.parent_id, sort: d.sort }))
}
