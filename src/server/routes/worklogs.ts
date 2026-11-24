import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId } from '../../node/sqlite'
import { worklogInputSchema, type WorklogDto } from '../../shared/schemas/events'
import type { ServerContext } from '../context'
import { notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { audienceOf, inGroupWhere, scopeDto, setScope, visibleWhere } from '../scope'
import { cleanHtml } from '../html'

interface WorklogRow {
  id: string
  member_id: string
  member_name: string
  dept_name: string | null
  date: string
  done_html: string
  todo_html: string
  notes_html: string
  scope_type: string
  updated_at: number
}

const SELECT = `SELECT w.*, CASE WHEN IFNULL(LENGTH(m.nickname), 0) = 0 THEN m.name ELSE m.name || char(40) || m.nickname || char(41) END AS member_name, d.name AS dept_name FROM worklogs w
  JOIN members m ON m.id = w.member_id LEFT JOIN departments d ON d.id = m.dept_id`

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** Shared work logs (6.4). Personal diaries are never sent to the server. */
export function registerWorklogRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db
  const toDto = (r: WorklogRow): WorklogDto => ({
    id: r.id,
    memberId: r.member_id,
    memberName: r.member_name,
    deptName: r.dept_name,
    date: r.date,
    doneHtml: r.done_html,
    todoHtml: r.todo_html,
    notesHtml: r.notes_html,
    scope: scopeDto(db, 'worklog', r.id, r.scope_type),
    updatedAt: r.updated_at
  })

  app.get('/api/worklogs', auth, async (req) => {
    const q = parse(z.object({ from: DATE, to: DATE, memberId: z.string().optional(), groupId: z.string().optional() }), req.query)
    const w = visibleWhere('w', 'worklog', req.member.id)
    const where = ['w.date >= ?', 'w.date <= ?', w.sql]
    const params: string[] = [q.from, q.to, ...w.params]
    if (q.memberId) {
      where.push('w.member_id = ?')
      params.push(q.memberId)
    }
    if (q.groupId) {
      where.push(inGroupWhere('w', 'worklog'))
      params.push(q.groupId)
    }
    return ok(db.all<WorklogRow>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY w.date DESC, m.name LIMIT 1000`, params).map(toDto))
  })

  app.get('/api/worklogs/mine/:date', auth, async (req) => {
    const { date } = parse(z.object({ date: DATE }), req.params)
    const r = db.get<WorklogRow>(`${SELECT} WHERE w.member_id = ? AND w.date = ?`, [req.member.id, date])
    return ok(r ? toDto(r) : null)
  })

  app.put('/api/worklogs/mine/:date', auth, async (req) => {
    const { date } = parse(z.object({ date: DATE }), req.params)
    const input = parse(worklogInputSchema, req.body)
    const existing = db.get<{ id: string }>('SELECT id FROM worklogs WHERE member_id = ? AND date = ?', [req.member.id, date])
    const before = existing ? audienceOf(db, 'worklogs', 'worklog', existing.id) : new Set<string>()
    const id = existing?.id ?? newId()
    const t = Date.now()
    db.tx(() => {
      if (existing) {
        db.run('UPDATE worklogs SET done_html = ?, todo_html = ?, notes_html = ?, scope_type = ?, updated_at = ? WHERE id = ?', [
          cleanHtml(input.doneHtml),
          cleanHtml(input.todoHtml),
          cleanHtml(input.notesHtml),
          input.scope.type,
          t,
          id
        ])
      } else {
        db.run(
          `INSERT INTO worklogs (id, member_id, date, done_html, todo_html, notes_html, scope_type, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, req.member.id, date, cleanHtml(input.doneHtml), cleanHtml(input.todoHtml), cleanHtml(input.notesHtml), input.scope.type, req.member.id, t, t]
        )
      }
      setScope(db, 'worklog', id, input.scope, req.member)
    })
    logActivity(ctx, req, existing ? 'worklog.update' : 'worklog.create', { type: 'worklog', id }, { date })
    ctx.hub.sendTo([...before, ...audienceOf(db, 'worklogs', 'worklog', id)], 'worklog.changed', { id })
    return ok(toDto(db.get<WorklogRow>(`${SELECT} WHERE w.id = ?`, [id])!))
  })

  app.delete('/api/worklogs/mine/:date', auth, async (req) => {
    const { date } = parse(z.object({ date: DATE }), req.params)
    const r = db.get<{ id: string }>('SELECT id FROM worklogs WHERE member_id = ? AND date = ?', [req.member.id, date])
    if (!r) throw notFound('업무일지')
    const audience = audienceOf(db, 'worklogs', 'worklog', r.id)
    db.run('DELETE FROM worklogs WHERE id = ?', [r.id])
    db.run(`DELETE FROM scope_targets WHERE item_type = 'worklog' AND item_id = ?`, [r.id])
    logActivity(ctx, req, 'worklog.delete', { type: 'worklog', id: r.id }, { date })
    ctx.hub.sendTo(audience, 'worklog.changed', { id: r.id })
    return ok({ id: r.id })
  })
}
