import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId } from '../../node/sqlite'
import { contactInputSchema, type ContactDto } from '../../shared/schemas/work'
import type { ScopeInput } from '../../shared/schemas/scope'
import type { ServerContext } from '../context'
import { badRequest, forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { audienceOf, canSee, inGroupWhere, scopeDto, setScope, visibleWhere } from '../scope'
import { adminFieldsOf, getMember, listDepartments, setAdminFields, updateMember } from '../repos/members'
import { subtreeIds } from '../../shared/org'
import { departmentCreateSchema, departmentOrderSchema, departmentPatchSchema, orgMemberOrderSchema, orgMemberPatchSchema } from '../../shared/schemas/org'
import { ADMIN_SET_FIELDS } from '../../shared/schemas/auth'

interface ContactRow {
  id: string
  org: string
  name: string
  title: string | null
  phone: string | null
  mobile: string | null
  email: string | null
  memo: string | null
  scope_type: string
  created_by: string
  created_by_name: string
}

const TEAM: ScopeInput = { type: 'team', groupIds: [], memberIds: [] }

/** Shared external contacts (6.10) and the department tree used by the org chart. */
export function registerDirectoryRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler; requireAdmin: preHandlerAsyncHookHandler; requireOwner: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  // the organisation (departments) is the 최종관리자's (server PC); a 서무 gets 403 OWNER_ONLY
  const owner = { preHandler: [guards.requireAuth, guards.requireAdmin, guards.requireOwner] }
  const db = ctx.db
  const SELECT = `SELECT c.*, CASE WHEN IFNULL(LENGTH(m.nickname), 0) = 0 THEN m.name ELSE m.name || char(40) || m.nickname || char(41) END AS created_by_name FROM contacts c JOIN members m ON m.id = c.created_by`

  const toDto = (r: ContactRow, req: FastifyRequest): ContactDto => ({
    id: r.id,
    org: r.org,
    name: r.name,
    title: r.title,
    phone: r.phone,
    mobile: r.mobile,
    email: r.email,
    memo: r.memo,
    scope: scopeDto(db, 'contact', r.id, r.scope_type),
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    canEdit: r.created_by === req.member.id || req.member.role === 'admin'
  })
  const load = (req: FastifyRequest, id: string): ContactRow => {
    const r = db.get<ContactRow>(`${SELECT} WHERE c.id = ? AND c.deleted_at IS NULL`, [id])
    if (!r || !canSee(db, 'contacts', 'contact', id, req.member.id)) throw notFound('연락처')
    return r
  }
  const insert = (req: FastifyRequest, input: z.infer<typeof contactInputSchema>): string => {
    const id = newId()
    const t = Date.now()
    const scope = input.scope ?? TEAM
    db.run(
      `INSERT INTO contacts (id, org, name, title, phone, mobile, email, memo, scope_type, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.org, input.name, input.title || null, input.phone || null, input.mobile || null, input.email || null, input.memo || null, scope.type, req.member.id, t, t]
    )
    setScope(db, 'contact', id, scope, req.member)
    return id
  }

  app.get('/api/contacts', auth, async (req) => {
    const q = parse(z.object({ q: z.string().max(100).default(''), groupId: z.string().optional() }), req.query)
    const w = visibleWhere('c', 'contact', req.member.id)
    const where = ['c.deleted_at IS NULL', w.sql]
    const params: string[] = [...w.params]
    if (q.q.trim()) {
      const like = `%${q.q.trim()}%`
      where.push('(c.name LIKE ? OR c.org LIKE ? OR c.title LIKE ? OR c.phone LIKE ? OR c.mobile LIKE ? OR c.memo LIKE ?)')
      params.push(like, like, like, like, like, like)
    }
    if (q.groupId) {
      where.push(inGroupWhere('c', 'contact'))
      params.push(q.groupId)
    }
    return ok(db.all<ContactRow>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY c.org, c.name LIMIT 2000`, params).map((r) => toDto(r, req)))
  })

  app.post('/api/contacts', auth, async (req) => {
    const input = parse(contactInputSchema, req.body)
    const id = db.tx(() => insert(req, input))
    logActivity(ctx, req, 'contact.create', { type: 'contact', id }, { name: input.name })
    ctx.hub.sendTo(audienceOf(db, 'contacts', 'contact', id), 'contact.changed', { id })
    return ok({ id })
  })

  /** CSV import: many contacts at once (rows validated one by one). */
  app.post('/api/contacts/bulk', auth, async (req) => {
    const { rows, scope } = parse(z.object({ rows: z.array(z.unknown()).min(1).max(5000), scope: contactInputSchema.shape.scope }), req.body)
    let added = 0
    const errors: string[] = []
    db.tx(() => {
      rows.forEach((raw, i) => {
        const r = contactInputSchema.safeParse({ ...(raw as object), scope })
        if (!r.success) {
          errors.push(`${i + 1}행: ${r.error.issues[0]?.message ?? '형식 오류'}`)
          return
        }
        insert(req, r.data)
        added++
      })
    })
    logActivity(ctx, req, 'contact.import', null, { added, errors: errors.length })
    ctx.hub.sendTo(audienceOf(db, 'contacts', 'contact', db.get<{ id: string }>('SELECT id FROM contacts WHERE created_by = ? ORDER BY created_at DESC LIMIT 1', [req.member.id])?.id ?? ''), 'contact.changed', {})
    return ok({ added, errors: errors.slice(0, 50) })
  })

  app.patch('/api/contacts/:id', auth, async (req) => {
    const r = load(req, (req.params as { id: string }).id)
    if (r.created_by !== req.member.id && req.member.role !== 'admin') throw forbidden('등록한 사람만 고칠 수 있습니다.')
    const p = parse(contactInputSchema.partial(), req.body)
    const before = audienceOf(db, 'contacts', 'contact', r.id)
    db.tx(() => {
      db.run(
        `UPDATE contacts SET org = COALESCE(?, org), name = COALESCE(?, name), title = COALESCE(?, title), phone = COALESCE(?, phone), mobile = COALESCE(?, mobile),
         email = COALESCE(?, email), memo = COALESCE(?, memo), updated_at = ? WHERE id = ?`,
        [p.org ?? null, p.name ?? null, p.title ?? null, p.phone ?? null, p.mobile ?? null, p.email ?? null, p.memo ?? null, Date.now(), r.id]
      )
      if (p.scope) {
        db.run('UPDATE contacts SET scope_type = ? WHERE id = ?', [p.scope.type, r.id])
        setScope(db, 'contact', r.id, p.scope, req.member)
      }
    })
    ctx.hub.sendTo([...before, ...audienceOf(db, 'contacts', 'contact', r.id)], 'contact.changed', { id: r.id })
    return ok({ id: r.id })
  })

  app.delete('/api/contacts/:id', auth, async (req) => {
    const r = load(req, (req.params as { id: string }).id)
    if (r.created_by !== req.member.id && req.member.role !== 'admin') throw forbidden('등록한 사람만 지울 수 있습니다.')
    const audience = audienceOf(db, 'contacts', 'contact', r.id)
    db.run('UPDATE contacts SET deleted_at = ? WHERE id = ?', [Date.now(), r.id])
    ctx.hub.sendTo(audience, 'contact.changed', { id: r.id })
    return ok({ id: r.id })
  })

  // ---- organisation (departments, who belongs where): read by everyone, changed only by the 최종관리자 (server PC) ----
  app.get('/api/departments', auth, async () => ok(listDepartments(db)))

  interface DeptRow {
    id: string
    name: string
    parent_id: string | null
  }
  const deptRow = (id: string): DeptRow => {
    const r = db.get<DeptRow>('SELECT id, name, parent_id FROM departments WHERE id = ?', [id])
    if (!r) throw notFound('부서')
    return r
  }
  const checkName = (name: string, selfId = ''): void => {
    if (db.get('SELECT 1 FROM departments WHERE name = ? AND id <> ?', [name, selfId])) throw badRequest('같은 이름의 부서가 있습니다.')
  }
  const checkParent = (parentId: string | null | undefined, selfId?: string): void => {
    if (!parentId) return
    if (!db.get('SELECT 1 FROM departments WHERE id = ?', [parentId])) throw badRequest('상위 부서를 찾을 수 없습니다.')
    if (selfId && subtreeIds(listDepartments(db), selfId).has(parentId)) throw badRequest('자기 자신이나 하위 부서를 상위 부서로 정할 수 없습니다.')
  }
  const checkHead = (headId: string | null | undefined): void => {
    if (headId && !getMember(db, headId)) throw badRequest('부서장으로 정한 구성원을 찾을 수 없습니다.')
  }
  const orgChanged = (): void => ctx.hub.broadcast('member.changed', {})

  app.post('/api/admin/departments', owner, async (req) => {
    const d = parse(departmentCreateSchema, req.body)
    checkName(d.name)
    checkParent(d.parentId)
    checkHead(d.headId)
    const id = newId()
    const t = Date.now()
    const last = db.get<{ n: number | null }>('SELECT MAX(sort) AS n FROM departments WHERE parent_id IS ?', [d.parentId])?.n ?? 0
    db.run('INSERT INTO departments (id, name, parent_id, sort, head_id, phone, duties, location, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      d.name,
      d.parentId,
      d.sort ?? last + 1,
      d.headId ?? null,
      d.phone ?? null,
      d.duties ?? null,
      d.location ?? null,
      t,
      t
    ])
    logActivity(ctx, req, 'department.create', { type: 'department', id }, { name: d.name })
    orgChanged()
    return ok({ id })
  })

  /** The departments of one parent in a new order (조직 관리: 위로/아래로). */
  app.put('/api/admin/departments/order', owner, async (req) => {
    const o = parse(departmentOrderSchema, req.body)
    const siblings = new Set(db.all<{ id: string }>('SELECT id FROM departments WHERE parent_id IS ?', [o.parentId]).map((r) => r.id))
    if (new Set(o.ids).size !== o.ids.length || o.ids.some((id) => !siblings.has(id))) throw badRequest('같은 상위 부서에 속한 부서만 순서를 바꿀 수 있습니다.')
    const t = Date.now()
    db.tx(() => o.ids.forEach((id, i) => db.run('UPDATE departments SET sort = ?, updated_at = ? WHERE id = ?', [i + 1, t, id])))
    logActivity(ctx, req, 'department.order', null, { parentId: o.parentId, count: o.ids.length })
    orgChanged()
    return ok({ count: o.ids.length })
  })

  app.patch('/api/admin/departments/:id', owner, async (req) => {
    const { id } = req.params as { id: string }
    const d = parse(departmentPatchSchema, req.body)
    deptRow(id)
    if (d.name !== undefined) checkName(d.name, id)
    checkParent(d.parentId, id)
    checkHead(d.headId)
    const cols: Record<string, string | number | null | undefined> = {
      name: d.name,
      parent_id: d.parentId,
      sort: d.sort,
      head_id: d.headId,
      phone: d.phone,
      duties: d.duties,
      location: d.location
    }
    const set = Object.entries(cols).filter(([, v]) => v !== undefined) as [string, string | number | null][]
    if (set.length) db.run(`UPDATE departments SET ${set.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...set.map(([, v]) => v), Date.now(), id])
    logActivity(ctx, req, 'department.update', { type: 'department', id }, d)
    orgChanged()
    return ok({ id })
  })

  /**
   * A department with people in it cannot be removed (move them first). Departments below it
   * are kept: they move up to the parent of the removed one.
   */
  app.delete('/api/admin/departments/:id', owner, async (req) => {
    const { id } = req.params as { id: string }
    const r = deptRow(id)
    if (db.get('SELECT 1 FROM members WHERE dept_id = ?', [id])) throw badRequest('소속 구성원이 있는 부서는 지울 수 없습니다. 먼저 구성원의 부서를 바꾸세요.')
    db.tx(() => {
      db.run('UPDATE departments SET parent_id = ?, updated_at = ? WHERE parent_id = ?', [r.parent_id, Date.now(), id])
      db.run('DELETE FROM departments WHERE id = ?', [id])
    })
    logActivity(ctx, req, 'department.delete', { type: 'department', id }, { name: r.name })
    orgChanged()
    return ok({ id })
  })

  /** The members of one department in a new order (the chart lists the head first, then this order). */
  app.put('/api/admin/org/members/order', owner, async (req) => {
    const o = parse(orgMemberOrderSchema, req.body)
    const inDept = new Set(db.all<{ id: string }>('SELECT id FROM members WHERE dept_id IS ?', [o.deptId]).map((r) => r.id))
    if (new Set(o.ids).size !== o.ids.length || o.ids.some((id) => !inDept.has(id))) throw badRequest('그 부서에 속한 구성원만 순서를 바꿀 수 있습니다.')
    const t = Date.now()
    db.tx(() => o.ids.forEach((id, i) => db.run('UPDATE members SET org_sort = ?, updated_at = ? WHERE id = ?', [i + 1, t, id])))
    logActivity(ctx, req, 'org.member-order', null, { deptId: o.deptId, count: o.ids.length })
    orgChanged()
    return ok({ count: o.ids.length })
  })

  /** Where a member belongs and how they are listed: department, 직위, 직급, order. */
  app.patch('/api/admin/org/members/:id', owner, async (req) => {
    const { id } = req.params as { id: string }
    const p = parse(orgMemberPatchSchema, req.body)
    const m = getMember(db, id)
    if (!m) throw notFound('구성원')
    if (p.deptId) deptRow(p.deptId)
    // in a new department the member goes to the end until an order is given there
    const moved = p.deptId !== undefined && p.deptId !== m.dept_id
    updateMember(db, id, {
      deptId: p.deptId,
      title: p.title === undefined ? undefined : p.title || null,
      rank: p.rank === undefined ? undefined : p.rank || null,
      orgSort: p.orgSort ?? (moved ? 0 : undefined)
    })
    // like 관리 → 구성원 → 정보 수정: what the server PC set stays as set
    const fixed = ADMIN_SET_FIELDS.filter((f) => (p as Record<string, unknown>)[f] !== undefined)
    if (fixed.length) setAdminFields(db, id, [...adminFieldsOf(m), ...fixed])
    logActivity(ctx, req, 'org.member-update', { type: 'member', id }, p)
    ctx.hub.broadcast('member.changed', { id })
    return ok({ id })
  })
}
