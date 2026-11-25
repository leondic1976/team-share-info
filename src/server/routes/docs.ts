import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId, parseJson } from '../../node/sqlite'
import {
  annualInputSchema,
  BUILTIN_TEMPLATES,
  docInputSchema,
  docPatchSchema,
  STALE_AFTER_MS,
  templateInputSchema,
  type AnnualTaskDto,
  type DocDto,
  type DocKind,
  type DocRevisionDto,
  type DocSummaryDto,
  type TemplateDto
} from '../../shared/schemas/docs'
import type { ServerContext } from '../context'
import { badRequest, forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { audienceOf, canSee, inGroupWhere, scopeDto, setScope, visibleWhere } from '../scope'
import { cleanHtml } from '../html'
import { deleteAttachmentsOf, linkAttachments, listAttachments, registerAttachmentOwner } from './attachments'

interface DocRow {
  id: string
  kind: DocKind
  parent_id: string | null
  title: string
  body_html: string
  tags: string
  scope_type: string
  event_id: string | null
  sort: number
  reviewed_at: number | null
  created_by: string
  author_name: string
  updated_by: string | null
  updated_by_name: string | null
  created_at: number
  updated_at: number
}

const SELECT = `SELECT d.*, CASE WHEN IFNULL(LENGTH(a.nickname), 0) = 0 THEN a.name ELSE a.name || char(40) || a.nickname || char(41) END AS author_name, CASE WHEN IFNULL(LENGTH(u.nickname), 0) = 0 THEN u.name ELSE u.name || char(40) || u.nickname || char(41) END AS updated_by_name FROM docs d JOIN members a ON a.id = d.created_by LEFT JOIN members u ON u.id = d.updated_by`

/** Team knowledge: must-read notes, manuals, handovers, minutes, FAQ, annual calendar (6.11). */
export function registerDocRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler; requireAdmin: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const admin = { preHandler: [guards.requireAuth, guards.requireAdmin] }
  const db = ctx.db
  registerAttachmentOwner('doc', (d, id, m) => canSee(d, 'docs', 'doc', id, m))

  const notify = (id: string, payload: Record<string, unknown> = {}, extra: Iterable<string> = []): void =>
    ctx.hub.sendTo([...audienceOf(db, 'docs', 'doc', id), ...extra], 'doc.changed', { id, ...payload })

  /** Read status of a must-read note, not counting its author. */
  const readStats = (id: string): { read: number; total: number } => {
    const author = db.get<{ created_by: string }>('SELECT created_by FROM docs WHERE id = ?', [id])?.created_by
    const audience = [...audienceOf(db, 'docs', 'doc', id)].filter((m) => m !== author)
    const reads = new Set(db.all<{ member_id: string }>('SELECT member_id FROM doc_reads WHERE doc_id = ?', [id]).map((r) => r.member_id))
    return { read: audience.filter((m) => reads.has(m)).length, total: audience.length }
  }

  const summary = (r: DocRow, req: FastifyRequest): DocSummaryDto => {
    const reviewed = r.reviewed_at ?? r.updated_at
    return {
      id: r.id,
      kind: r.kind,
      parentId: r.parent_id,
      title: r.title,
      tags: parseJson<string[]>(r.tags, []),
      scope: scopeDto(db, 'doc', r.id, r.scope_type),
      sort: r.sort,
      eventId: r.event_id,
      authorId: r.created_by,
      authorName: r.author_name,
      updatedById: r.updated_by,
      updatedByName: r.updated_by_name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      reviewedAt: r.reviewed_at,
      stale: r.kind !== 'minutes' && Date.now() - reviewed > STALE_AFTER_MS,
      read: !!db.get('SELECT 1 FROM doc_reads WHERE doc_id = ? AND member_id = ?', [r.id, req.member.id]),
      readStats: r.kind === 'mustread' && (r.created_by === req.member.id || req.member.role === 'admin') ? readStats(r.id) : null
    }
  }

  // Must-read notes are edited by their author/admins; other documents are team wikis.
  const canEdit = (r: DocRow, req: FastifyRequest): boolean => (r.kind === 'mustread' ? r.created_by === req.member.id || req.member.role === 'admin' : true)
  const canDelete = (r: DocRow, req: FastifyRequest): boolean => r.created_by === req.member.id || req.member.role === 'admin'

  const load = (req: FastifyRequest, id: string): DocRow => {
    const r = db.get<DocRow>(`${SELECT} WHERE d.id = ? AND d.deleted_at IS NULL`, [id])
    if (!r || !canSee(db, 'docs', 'doc', id, req.member.id)) throw notFound('문서')
    return r
  }

  app.get('/api/docs', auth, async (req) => {
    const q = parse(z.object({ kind: z.enum(['mustread', 'manual', 'handover', 'minutes', 'faq']).optional(), q: z.string().max(100).default(''), groupId: z.string().optional(), unread: z.coerce.boolean().default(false) }), req.query)
    const w = visibleWhere('d', 'doc', req.member.id)
    const where = ['d.deleted_at IS NULL', w.sql]
    const params: (string | number)[] = [...w.params]
    if (q.kind) {
      where.push('d.kind = ?')
      params.push(q.kind)
    }
    if (q.q.trim()) {
      where.push('(d.title LIKE ? OR d.body_html LIKE ? OR d.tags LIKE ?)')
      const like = `%${q.q.trim()}%`
      params.push(like, like, like)
    }
    if (q.groupId) {
      where.push(inGroupWhere('d', 'doc'))
      params.push(q.groupId)
    }
    if (q.unread) {
      where.push(`d.kind = 'mustread' AND d.created_by != ? AND NOT EXISTS (SELECT 1 FROM doc_reads r WHERE r.doc_id = d.id AND r.member_id = ?)`)
      params.push(req.member.id, req.member.id)
    }
    const rows = db.all<DocRow>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY d.sort, d.updated_at DESC LIMIT 1000`, params)
    return ok(rows.map((r) => summary(r, req)))
  })

  app.get('/api/docs/:id', auth, async (req) => {
    const r = load(req, (req.params as { id: string }).id)
    const dto: DocDto = {
      ...summary(r, req),
      bodyHtml: r.body_html,
      attachments: listAttachments(db, 'doc', r.id),
      revisionCount: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM doc_revisions WHERE doc_id = ?', [r.id])?.n ?? 0,
      canEdit: canEdit(r, req),
      canDelete: canDelete(r, req)
    }
    return ok(dto)
  })

  app.post('/api/docs', auth, async (req) => {
    const input = parse(docInputSchema, req.body)
    if (input.parentId) load(req, input.parentId)
    const id = newId()
    const t = Date.now()
    db.tx(() => {
      db.run(
        `INSERT INTO docs (id, kind, parent_id, title, body_html, tags, scope_type, event_id, sort, reviewed_at, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.kind, input.parentId, input.title, cleanHtml(input.bodyHtml), JSON.stringify(input.tags), input.scope.type, input.eventId, input.sort, t, req.member.id, req.member.id, t, t]
      )
      setScope(db, 'doc', id, input.scope, req.member)
      linkAttachments(ctx, input.attachmentIds, 'doc', id, req.member.id)
    })
    logActivity(ctx, req, 'doc.create', { type: 'doc', id }, { kind: input.kind, title: input.title })
    notify(id, input.kind === 'mustread' ? { mustread: true, title: input.title, authorId: req.member.id, authorName: req.member.name } : {})
    return ok({ id })
  })

  /** Every content change keeps the previous version as a revision (6.11 변경 이력). */
  app.patch('/api/docs/:id', auth, async (req) => {
    const r = load(req, (req.params as { id: string }).id)
    if (!canEdit(r, req)) throw forbidden('작성자만 고칠 수 있습니다.')
    const p = parse(docPatchSchema, req.body)
    if (p.parentId) {
      if (p.parentId === r.id) throw badRequest('자기 자신 아래로 옮길 수 없습니다.')
      load(req, p.parentId)
    }
    const before = audienceOf(db, 'docs', 'doc', r.id)
    const t = Date.now()
    db.tx(() => {
      if ((p.bodyHtml !== undefined && cleanHtml(p.bodyHtml) !== r.body_html) || (p.title !== undefined && p.title !== r.title)) {
        db.run('INSERT INTO doc_revisions (id, doc_id, title, body_html, edited_by, edited_at) VALUES (?, ?, ?, ?, ?, ?)', [newId(), r.id, r.title, r.body_html, req.member.id, t])
      }
      db.run(
        `UPDATE docs SET title = COALESCE(?, title), body_html = COALESCE(?, body_html), tags = COALESCE(?, tags), parent_id = CASE WHEN ? THEN ? ELSE parent_id END,
         sort = COALESCE(?, sort), reviewed_at = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
        [
          p.title ?? null,
          p.bodyHtml !== undefined ? cleanHtml(p.bodyHtml) : null,
          p.tags ? JSON.stringify(p.tags) : null,
          p.parentId !== undefined ? 1 : 0,
          p.parentId ?? null,
          p.sort ?? null,
          t,
          req.member.id,
          t,
          r.id
        ]
      )
      if (p.scope) {
        if (!canDelete(r, req)) throw forbidden('공개 범위는 작성자만 바꿀 수 있습니다.')
        db.run('UPDATE docs SET scope_type = ? WHERE id = ?', [p.scope.type, r.id])
        setScope(db, 'doc', r.id, p.scope, req.member)
      }
      // Changing a must-read note asks everyone to read it again.
      if (r.kind === 'mustread' && p.bodyHtml !== undefined) db.run('DELETE FROM doc_reads WHERE doc_id = ?', [r.id])
    })
    logActivity(ctx, req, 'doc.update', { type: 'doc', id: r.id })
    notify(r.id, r.kind === 'mustread' && p.bodyHtml !== undefined ? { mustread: true, title: p.title ?? r.title, authorId: req.member.id, authorName: req.member.name, updated: true } : {}, before)
    return ok({ id: r.id })
  })

  app.delete('/api/docs/:id', auth, async (req) => {
    const r = load(req, (req.params as { id: string }).id)
    if (!canDelete(r, req)) throw forbidden('작성자만 지울 수 있습니다.')
    if (db.get('SELECT 1 FROM docs WHERE parent_id = ? AND deleted_at IS NULL', [r.id])) throw badRequest('하위 문서가 있는 문서는 지울 수 없습니다. 하위 문서를 먼저 옮기거나 지우세요.')
    const audience = audienceOf(db, 'docs', 'doc', r.id)
    db.run('UPDATE docs SET deleted_at = ? WHERE id = ?', [Date.now(), r.id])
    deleteAttachmentsOf(ctx, 'doc', r.id)
    logActivity(ctx, req, 'doc.delete', { type: 'doc', id: r.id }, { title: r.title })
    ctx.hub.sendTo(audience, 'doc.changed', { id: r.id, deleted: true })
    return ok({ id: r.id })
  })

  app.post('/api/docs/:id/read', auth, async (req) => {
    const r = load(req, (req.params as { id: string }).id)
    const res = db.run('INSERT INTO doc_reads (doc_id, member_id, read_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [r.id, req.member.id, Date.now()])
    if (res.changes && r.kind === 'mustread') ctx.hub.sendTo([r.created_by, req.member.id], 'doc.changed', { id: r.id })
    return ok({ id: r.id })
  })

  app.get('/api/docs/:id/reads', auth, async (req) => {
    const r = load(req, (req.params as { id: string }).id)
    if (!canDelete(r, req)) throw forbidden()
    const reads = new Map(db.all<{ member_id: string; read_at: number }>('SELECT member_id, read_at FROM doc_reads WHERE doc_id = ?', [r.id]).map((x) => [x.member_id, x.read_at]))
    const audience = [...audienceOf(db, 'docs', 'doc', r.id)].filter((m) => m !== r.created_by)
    const rows = audience.length ? db.all<{ id: string; name: string }>(`SELECT id, name FROM members WHERE id IN (${audience.map(() => '?').join(',')}) ORDER BY name`, audience) : []
    return ok(rows.map((m) => ({ memberId: m.id, name: m.name, readAt: reads.get(m.id) ?? null })))
  })

  /** Ask members who have not read a must-read note to read it (Windows notification). */
  app.post('/api/docs/:id/remind', auth, async (req) => {
    const r = load(req, (req.params as { id: string }).id)
    if (!canDelete(r, req)) throw forbidden()
    const reads = new Set(db.all<{ member_id: string }>('SELECT member_id FROM doc_reads WHERE doc_id = ?', [r.id]).map((x) => x.member_id))
    const targets = [...audienceOf(db, 'docs', 'doc', r.id)].filter((m) => !reads.has(m) && m !== r.created_by)
    ctx.hub.sendTo(targets, 'doc.changed', { id: r.id, mustread: true, remind: true, title: r.title, authorName: req.member.name })
    logActivity(ctx, req, 'doc.remind', { type: 'doc', id: r.id }, { count: targets.length })
    return ok({ count: targets.length })
  })

  app.post('/api/docs/:id/review', auth, async (req) => {
    const r = load(req, (req.params as { id: string }).id)
    if (!canEdit(r, req)) throw forbidden()
    db.run('UPDATE docs SET reviewed_at = ? WHERE id = ?', [Date.now(), r.id])
    notify(r.id)
    return ok({ id: r.id })
  })

  app.get('/api/docs/:id/revisions', auth, async (req) => {
    const r = load(req, (req.params as { id: string }).id)
    const rows = db.all<{ id: string; title: string; body_html: string; name: string; edited_at: number }>(
      'SELECT v.id, v.title, v.body_html, m.name, v.edited_at FROM doc_revisions v JOIN members m ON m.id = v.edited_by WHERE v.doc_id = ? ORDER BY v.edited_at DESC LIMIT 100',
      [r.id]
    )
    return ok(rows.map((v): DocRevisionDto => ({ id: v.id, title: v.title, bodyHtml: v.body_html, editedByName: v.name, editedAt: v.edited_at })))
  })

  app.post('/api/docs/:id/restore', auth, async (req) => {
    const r = load(req, (req.params as { id: string }).id)
    if (!canEdit(r, req)) throw forbidden()
    const { revisionId } = parse(z.object({ revisionId: z.string() }), req.body)
    const v = db.get<{ title: string; body_html: string }>('SELECT title, body_html FROM doc_revisions WHERE id = ? AND doc_id = ?', [revisionId, r.id])
    if (!v) throw notFound('이전 버전')
    const t = Date.now()
    db.tx(() => {
      db.run('INSERT INTO doc_revisions (id, doc_id, title, body_html, edited_by, edited_at) VALUES (?, ?, ?, ?, ?, ?)', [newId(), r.id, r.title, r.body_html, req.member.id, t])
      db.run('UPDATE docs SET title = ?, body_html = ?, updated_by = ?, updated_at = ?, reviewed_at = ? WHERE id = ?', [v.title, v.body_html, req.member.id, t, t, r.id])
    })
    logActivity(ctx, req, 'doc.restore', { type: 'doc', id: r.id })
    notify(r.id)
    return ok({ id: r.id })
  })

  // ---- templates ----
  app.get('/api/doc-templates', auth, async () => {
    const custom = db.all<{ id: string; kind: string; name: string; body_html: string }>('SELECT id, kind, name, body_html FROM doc_templates ORDER BY name')
    const list: TemplateDto[] = [...BUILTIN_TEMPLATES, ...custom.map((c) => ({ id: c.id, kind: c.kind, name: c.name, bodyHtml: c.body_html, builtin: false }))]
    return ok(list)
  })
  app.post('/api/doc-templates', admin, async (req) => {
    const t = parse(templateInputSchema, req.body)
    const id = newId()
    db.run('INSERT INTO doc_templates (id, kind, name, body_html, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, t.kind, t.name, cleanHtml(t.bodyHtml), req.member.id, Date.now(), Date.now()])
    return ok({ id })
  })
  app.delete('/api/doc-templates/:id', admin, async (req) => {
    db.run('DELETE FROM doc_templates WHERE id = ?', [(req.params as { id: string }).id])
    return ok({})
  })

  // ---- annual work calendar ----
  const annualDto = (r: { id: string; month: number; day: number | null; title: string; body_html: string; remind_days_before: number; scope_type: string; created_by: string; author_name: string }, req: FastifyRequest): AnnualTaskDto => ({
    authorId: r.created_by,
    id: r.id,
    month: r.month,
    day: r.day,
    title: r.title,
    bodyHtml: r.body_html,
    remindDaysBefore: r.remind_days_before,
    scope: scopeDto(db, 'annual', r.id, r.scope_type),
    authorName: r.author_name,
    canEdit: r.created_by === req.member.id || req.member.role === 'admin'
  })
  app.get('/api/annual-tasks', auth, async (req) => {
    const w = visibleWhere('t', 'annual', req.member.id)
    const rows = db.all<Parameters<typeof annualDto>[0]>(`SELECT t.*, CASE WHEN IFNULL(LENGTH(m.nickname), 0) = 0 THEN m.name ELSE m.name || char(40) || m.nickname || char(41) END AS author_name FROM annual_tasks t JOIN members m ON m.id = t.created_by WHERE t.deleted_at IS NULL AND ${w.sql} ORDER BY t.month, t.day`, w.params)
    return ok(rows.map((r) => annualDto(r, req)))
  })
  app.post('/api/annual-tasks', auth, async (req) => {
    const a = parse(annualInputSchema, req.body)
    const id = newId()
    const t = Date.now()
    db.tx(() => {
      db.run('INSERT INTO annual_tasks (id, month, day, title, body_html, remind_days_before, scope_type, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        a.month,
        a.day,
        a.title,
        cleanHtml(a.bodyHtml),
        a.remindDaysBefore,
        a.scope.type,
        req.member.id,
        t,
        t
      ])
      setScope(db, 'annual', id, a.scope, req.member)
    })
    ctx.hub.sendTo(audienceOf(db, 'annual_tasks', 'annual', id), 'doc.changed', { annual: true })
    return ok({ id })
  })
  app.patch('/api/annual-tasks/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = db.get<{ created_by: string }>('SELECT created_by FROM annual_tasks WHERE id = ? AND deleted_at IS NULL', [id])
    if (!r || !canSee(db, 'annual_tasks', 'annual', id, req.member.id)) throw notFound('연간 업무')
    if (r.created_by !== req.member.id && req.member.role !== 'admin') throw forbidden()
    const a = parse(annualInputSchema.partial(), req.body)
    db.tx(() => {
      db.run(
        'UPDATE annual_tasks SET month = COALESCE(?, month), day = CASE WHEN ? THEN ? ELSE day END, title = COALESCE(?, title), body_html = COALESCE(?, body_html), remind_days_before = COALESCE(?, remind_days_before), updated_at = ? WHERE id = ?',
        [a.month ?? null, a.day !== undefined ? 1 : 0, a.day ?? null, a.title ?? null, a.bodyHtml !== undefined ? cleanHtml(a.bodyHtml) : null, a.remindDaysBefore ?? null, Date.now(), id]
      )
      if (a.scope) {
        db.run('UPDATE annual_tasks SET scope_type = ? WHERE id = ?', [a.scope.type, id])
        setScope(db, 'annual', id, a.scope, req.member)
      }
    })
    ctx.hub.sendTo(audienceOf(db, 'annual_tasks', 'annual', id), 'doc.changed', { annual: true })
    return ok({ id })
  })
  app.delete('/api/annual-tasks/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = db.get<{ created_by: string }>('SELECT created_by FROM annual_tasks WHERE id = ? AND deleted_at IS NULL', [id])
    if (!r || !canSee(db, 'annual_tasks', 'annual', id, req.member.id)) throw notFound('연간 업무')
    if (r.created_by !== req.member.id && req.member.role !== 'admin') throw forbidden()
    const audience = audienceOf(db, 'annual_tasks', 'annual', id)
    db.run('UPDATE annual_tasks SET deleted_at = ? WHERE id = ?', [Date.now(), id])
    ctx.hub.sendTo(audience, 'doc.changed', { annual: true })
    return ok({ id })
  })

}
