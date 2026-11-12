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
import { listDepartments } from '../repos/members'

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
export function registerDirectoryRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler; requireAdmin: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const admin = { preHandler: [guards.requireAuth, guards.requireAdmin] }
  const db = ctx.db
  const SELECT = `SELECT c.*, m.name AS created_by_name FROM contacts c JOIN members m ON m.id = c.created_by`

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

  // ---- departments (org chart), admin only ----
  app.get('/api/departments', auth, async () => ok(listDepartments(db)))

  app.post('/api/admin/departments', admin, async (req) => {
    const d = parse(z.object({ name: z.string().trim().min(1).max(40), parentId: z.string().nullable().default(null), sort: z.number().int().default(0) }), req.body)
    if (db.get('SELECT 1 FROM departments WHERE name = ?', [d.name])) throw badRequest('같은 이름의 부서가 있습니다.')
    const id = newId()
    const t = Date.now()
    db.run('INSERT INTO departments (id, name, parent_id, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, d.name, d.parentId, d.sort, t, t])
    logActivity(ctx, req, 'department.create', { type: 'department', id }, { name: d.name })
    ctx.hub.broadcast('member.changed', {})
    return ok({ id })
  })

  app.patch('/api/admin/departments/:id', admin, async (req) => {
    const { id } = req.params as { id: string }
    const d = parse(z.object({ name: z.string().trim().min(1).max(40).optional(), parentId: z.string().nullable().optional(), sort: z.number().int().optional() }), req.body)
    if (d.parentId === id) throw badRequest('자기 자신을 상위 부서로 정할 수 없습니다.')
    db.run(`UPDATE departments SET name = COALESCE(?, name), parent_id = CASE WHEN ? THEN ? ELSE parent_id END, sort = COALESCE(?, sort), updated_at = ? WHERE id = ?`, [
      d.name ?? null,
      d.parentId !== undefined ? 1 : 0,
      d.parentId ?? null,
      d.sort ?? null,
      Date.now(),
      id
    ])
    ctx.hub.broadcast('member.changed', {})
    return ok({ id })
  })

  app.delete('/api/admin/departments/:id', admin, async (req) => {
    const { id } = req.params as { id: string }
    if (db.get('SELECT 1 FROM members WHERE dept_id = ?', [id])) throw badRequest('소속 구성원이 있는 부서는 지울 수 없습니다. 먼저 구성원의 부서를 바꾸세요.')
    db.run('UPDATE departments SET parent_id = NULL WHERE parent_id = ?', [id])
    db.run('DELETE FROM departments WHERE id = ?', [id])
    ctx.hub.broadcast('member.changed', {})
    return ok({ id })
  })
}
