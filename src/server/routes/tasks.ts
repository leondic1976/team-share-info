import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId } from '../../node/sqlite'
import { assigneeIdsOf, canTransition, taskCreateSchema, taskPatchSchema, type TaskAssignee, type TaskDto, type TaskState } from '../../shared/schemas/work'
import type { ScopeInput } from '../../shared/schemas/scope'
import type { ServerContext } from '../context'
import { badRequest, forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { audienceOf, canSee, inGroupWhere, scopeDto, setScope, visibleWhere } from '../scope'
import { cleanHtml } from '../html'
import { deleteAttachmentsOf, linkAttachments, listAttachments, registerAttachmentOwner } from './attachments'
import { commentCount, registerCommentOwner } from './comments'

interface TaskRow {
  id: string
  title: string
  body_html: string
  assignee_id: string
  due_at: number | null
  priority: TaskDto['priority']
  state: TaskState
  scope_type: string
  created_by: string
  requester_name: string
  created_at: number
  updated_at: number
  done_at: number | null
  confirmed_at: number | null
}

const SELECT = `SELECT t.*, r.name AS requester_name FROM tasks t JOIN members r ON r.id = t.created_by`
const IS_ASSIGNEE = 'EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.member_id = ?)'

/**
 * Work requests between members (6.8). Requester and assignees always see the task.
 * A task may have several assignees who share one state: any of them can move it.
 */
export function registerTaskRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db

  const notify = (id: string, extra: Iterable<string> = []): void => ctx.hub.sendTo([...audienceOf(db, 'tasks', 'task', id), ...extra], 'task.changed', { id })
  registerAttachmentOwner('task', (d, id, m) => canSee(d, 'tasks', 'task', id, m))
  registerCommentOwner('task', (d, id, m) => !!d.get('SELECT 1 FROM tasks WHERE id = ? AND deleted_at IS NULL', [id]) && canSee(d, 'tasks', 'task', id, m), (id) => notify(id))

  const assigneesOf = (id: string): TaskAssignee[] =>
    db.all<TaskAssignee>('SELECT m.id, m.name FROM task_assignees ta JOIN members m ON m.id = ta.member_id WHERE ta.task_id = ? ORDER BY ta.position', [id])
  const isAssignee = (id: string, memberId: string): boolean => !!db.get('SELECT 1 FROM task_assignees WHERE task_id = ? AND member_id = ?', [id, memberId])

  const toDto = (r: TaskRow, withBody = false): TaskDto => {
    const assignees = assigneesOf(r.id)
    return {
      id: r.id,
      title: r.title,
      ...(withBody ? { bodyHtml: r.body_html } : {}),
      requesterId: r.created_by,
      requesterName: r.requester_name,
      assigneeId: r.assignee_id,
      assigneeName: assignees.map((a) => a.name).join(', '),
      assignees,
      dueAt: r.due_at,
      priority: r.priority,
      state: r.state,
      scope: scopeDto(db, 'task', r.id, r.scope_type),
      commentCount: commentCount(db, 'task', r.id),
      attachmentCount: listAttachments(db, 'task', r.id).length,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      doneAt: r.done_at,
      confirmedAt: r.confirmed_at
    }
  }

  const load = (req: FastifyRequest, id: string): TaskRow => {
    const r = db.get<TaskRow>(`${SELECT} WHERE t.id = ? AND t.deleted_at IS NULL`, [id])
    if (!r || !canSee(db, 'tasks', 'task', id, req.member.id)) throw notFound('업무')
    return r
  }

  /** Assignees are always member targets so they can see the task whatever the scope. */
  const showTo = (id: string, scopeType: string, memberIds: string[]): void => {
    if (scopeType === 'team') return
    for (const m of memberIds) db.run(`INSERT INTO scope_targets (item_type, item_id, target_type, target_id) VALUES ('task', ?, 'member', ?) ON CONFLICT DO NOTHING`, [id, m])
  }

  const checkAssignees = (ids: string[]): void => {
    for (const m of ids) if (!db.get(`SELECT 1 FROM members WHERE id = ? AND status = 'active'`, [m])) throw badRequest('담당자를 찾을 수 없습니다.')
  }

  const setAssignees = (id: string, ids: string[]): void => {
    db.run('DELETE FROM task_assignees WHERE task_id = ?', [id])
    ids.forEach((m, i) => db.run('INSERT INTO task_assignees (task_id, member_id, position) VALUES (?, ?, ?)', [id, m, i]))
  }

  app.get('/api/tasks', auth, async (req) => {
    const q = parse(
      z.object({
        filter: z.enum(['received', 'requested', 'all']).default('received'),
        state: z.enum(['open', 'all', 'requested', 'doing', 'done', 'confirmed']).default('all'),
        groupId: z.string().optional(),
        dueFrom: z.coerce.number().optional(),
        dueTo: z.coerce.number().optional()
      }),
      req.query
    )
    const w = visibleWhere('t', 'task', req.member.id)
    const where = ['t.deleted_at IS NULL', w.sql]
    const params: (string | number)[] = [...w.params]
    if (q.filter === 'received') {
      where.push(IS_ASSIGNEE)
      params.push(req.member.id)
    } else if (q.filter === 'requested') {
      where.push('t.created_by = ?')
      params.push(req.member.id)
    }
    if (q.state === 'open') where.push(`t.state IN ('requested','doing','done')`)
    else if (q.state !== 'all') {
      where.push('t.state = ?')
      params.push(q.state)
    }
    if (q.groupId) {
      where.push(inGroupWhere('t', 'task'))
      params.push(q.groupId)
    }
    if (q.dueFrom !== undefined) {
      where.push('t.due_at >= ?')
      params.push(q.dueFrom)
    }
    if (q.dueTo !== undefined) {
      where.push('t.due_at < ?')
      params.push(q.dueTo)
    }
    const rows = db.all<TaskRow>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY t.due_at IS NULL, t.due_at, t.created_at DESC LIMIT 500`, params)
    return ok(rows.map((r) => toDto(r)))
  })

  app.get('/api/tasks/:id', auth, async (req) => {
    const r = load(req, (req.params as { id: string }).id)
    return ok({ ...toDto(r, true), attachments: listAttachments(db, 'task', r.id) })
  })

  app.post('/api/tasks', auth, async (req) => {
    const input = parse(taskCreateSchema, req.body)
    const assignees = assigneeIdsOf(input)!
    checkAssignees(assignees)
    const scope: ScopeInput = input.scope ?? { type: 'members', groupIds: [], memberIds: assignees }
    const id = newId()
    const t = Date.now()
    db.tx(() => {
      db.run(
        `INSERT INTO tasks (id, title, body_html, assignee_id, due_at, priority, state, scope_type, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)`,
        [id, input.title, cleanHtml(input.bodyHtml), assignees[0], input.dueAt, input.priority, scope.type, req.member.id, t, t]
      )
      setAssignees(id, assignees)
      setScope(db, 'task', id, scope, req.member)
      showTo(id, scope.type, assignees)
      linkAttachments(ctx, input.attachmentIds, 'task', id, req.member.id)
    })
    logActivity(ctx, req, 'task.create', { type: 'task', id }, { title: input.title })
    notify(id)
    ctx.hub.sendTo(assignees.filter((m) => m !== req.member.id), 'task.changed', { id, assigned: true, title: input.title, requesterName: req.member.name })
    return ok(toDto(db.get<TaskRow>(`${SELECT} WHERE t.id = ?`, [id])!))
  })

  app.patch('/api/tasks/:id', auth, async (req) => {
    const r = load(req, (req.params as { id: string }).id)
    const p = parse(taskPatchSchema, req.body)
    const role = { assignee: isAssignee(r.id, req.member.id), requester: r.created_by === req.member.id }
    const assignees = assigneeIdsOf(p)
    const editsContent = p.title !== undefined || p.bodyHtml !== undefined || p.dueAt !== undefined || p.priority !== undefined || assignees !== null
    if (editsContent && !role.requester && req.member.role !== 'admin') throw forbidden('요청한 사람만 내용을 고칠 수 있습니다.')
    const t = Date.now()
    const before = audienceOf(db, 'tasks', 'task', r.id)
    const added = (assignees ?? []).filter((m) => !isAssignee(r.id, m))
    db.tx(() => {
      if (p.state && p.state !== r.state) {
        if (!canTransition(r.state, p.state, role)) throw forbidden('이 단계로 바꿀 권한이 없습니다.')
        db.run(
          `UPDATE tasks SET state = ?, done_at = CASE WHEN ? = 'done' THEN ? ELSE done_at END, confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE NULL END, updated_at = ? WHERE id = ?`,
          [p.state, p.state, t, p.state, t, t, r.id]
        )
      }
      if (editsContent) {
        checkAssignees(added)
        db.run(
          `UPDATE tasks SET title = COALESCE(?, title), body_html = COALESCE(?, body_html), due_at = CASE WHEN ? THEN ? ELSE due_at END,
           priority = COALESCE(?, priority), assignee_id = COALESCE(?, assignee_id), updated_at = ? WHERE id = ?`,
          [p.title ?? null, p.bodyHtml !== undefined ? cleanHtml(p.bodyHtml) : null, p.dueAt !== undefined ? 1 : 0, p.dueAt ?? null, p.priority ?? null, assignees?.[0] ?? null, t, r.id]
        )
        if (assignees) {
          setAssignees(r.id, assignees)
          showTo(r.id, r.scope_type, assignees)
        }
      }
    })
    logActivity(ctx, req, 'task.update', { type: 'task', id: r.id }, p)
    notify(r.id, before)
    ctx.hub.sendTo(added.filter((m) => m !== req.member.id), 'task.changed', { id: r.id, assigned: true, title: p.title ?? r.title, requesterName: req.member.name })
    return ok(toDto(db.get<TaskRow>(`${SELECT} WHERE t.id = ?`, [r.id])!))
  })

  app.delete('/api/tasks/:id', auth, async (req) => {
    const r = load(req, (req.params as { id: string }).id)
    if (r.created_by !== req.member.id && req.member.role !== 'admin') throw forbidden('요청한 사람만 지울 수 있습니다.')
    const audience = audienceOf(db, 'tasks', 'task', r.id)
    db.run('UPDATE tasks SET deleted_at = ? WHERE id = ?', [Date.now(), r.id])
    deleteAttachmentsOf(ctx, 'task', r.id)
    logActivity(ctx, req, 'task.delete', { type: 'task', id: r.id }, { title: r.title })
    ctx.hub.sendTo(audience, 'task.changed', { id: r.id, deleted: true })
    return ok({ id: r.id })
  })
}
