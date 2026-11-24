import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId } from '../../node/sqlite'
import { assigneeIdsOf, canTransition, taskCreateSchema, taskPatchSchema, type TaskAssignee, type TaskDoneMode, type TaskDto, type TaskState } from '../../shared/schemas/work'
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
  done_mode: TaskDoneMode
  scope_type: string
  created_by: string
  requester_name: string
  created_at: number
  updated_at: number
  done_at: number | null
  confirmed_at: number | null
}

const SELECT = `SELECT t.*, CASE WHEN IFNULL(LENGTH(r.nickname), 0) = 0 THEN r.name ELSE r.name || char(40) || r.nickname || char(41) END AS requester_name FROM tasks t JOIN members r ON r.id = t.created_by`
const IS_ASSIGNEE = 'EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.member_id = ?)'

/**
 * Work requests between members (6.8). Requester and assignees always see the task.
 * A task may have several assignees. done_mode 'any': they share one state and any of them
 * moves it. done_mode 'each': every assignee finishes their own part (task_assignees.done_at)
 * and the task is done when all have.
 */
export function registerTaskRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db

  const notify = (id: string, extra: Iterable<string> = []): void => ctx.hub.sendTo([...audienceOf(db, 'tasks', 'task', id), ...extra], 'task.changed', { id })
  registerAttachmentOwner('task', (d, id, m) => canSee(d, 'tasks', 'task', id, m))
  registerCommentOwner('task', (d, id, m) => !!d.get('SELECT 1 FROM tasks WHERE id = ? AND deleted_at IS NULL', [id]) && canSee(d, 'tasks', 'task', id, m), (id) => notify(id))

  const assigneesOf = (id: string): TaskAssignee[] =>
    db.all<TaskAssignee>('SELECT m.id, m.name, ta.done_at AS doneAt FROM task_assignees ta JOIN members m ON m.id = ta.member_id WHERE ta.task_id = ? ORDER BY ta.position', [id])
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
      assignees: r.done_mode === 'each' ? assignees : assignees.map((a) => ({ id: a.id, name: a.name })),
      doneMode: r.done_mode,
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

  /** Replace the assignees; those who stay keep what they finished. */
  const setAssignees = (id: string, ids: string[]): void => {
    const done = new Map(db.all<{ member_id: string; done_at: number | null }>('SELECT member_id, done_at FROM task_assignees WHERE task_id = ?', [id]).map((x) => [x.member_id, x.done_at]))
    db.run('DELETE FROM task_assignees WHERE task_id = ?', [id])
    ids.forEach((m, i) => db.run('INSERT INTO task_assignees (task_id, member_id, position, done_at) VALUES (?, ?, ?, ?)', [id, m, i, done.get(m) ?? null]))
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
        `INSERT INTO tasks (id, title, body_html, assignee_id, due_at, priority, state, done_mode, scope_type, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?)`,
        [id, input.title, cleanHtml(input.bodyHtml), assignees[0], input.dueAt, input.priority, assignees.length > 1 ? input.doneMode : 'any', scope.type, req.member.id, t, t]
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
    const editsContent = p.title !== undefined || p.bodyHtml !== undefined || p.dueAt !== undefined || p.priority !== undefined || assignees !== null || p.doneMode !== undefined
    if (editsContent && !role.requester && req.member.role !== 'admin') throw forbidden('요청한 사람만 내용을 고칠 수 있습니다.')
    const t = Date.now()
    const before = audienceOf(db, 'tasks', 'task', r.id)
    const added = (assignees ?? []).filter((m) => !isAssignee(r.id, m))
    const setState = (to: TaskState): void =>
      void db.run(`UPDATE tasks SET state = ?, done_at = CASE WHEN ? = 'done' THEN ? ELSE done_at END, confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE NULL END, updated_at = ? WHERE id = ?`, [to, to, t, to, t, t, r.id])
    const marks = (): { n: number; d: number } => db.get<{ n: number; d: number }>('SELECT COUNT(*) AS n, COUNT(done_at) AS d FROM task_assignees WHERE task_id = ?', [r.id])!
    db.tx(() => {
      let mode = r.done_mode
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
        if (p.doneMode && p.doneMode !== mode) {
          mode = p.doneMode
          db.run('UPDATE tasks SET done_mode = ? WHERE id = ?', [mode, r.id])
          // a task already finished stays finished for everyone; otherwise everybody starts over
          db.run('UPDATE task_assignees SET done_at = ? WHERE task_id = ?', [mode === 'each' && (r.state === 'done' || r.state === 'confirmed') ? (r.done_at ?? t) : null, r.id])
        }
      }
      if (mode !== 'each') {
        if (p.state && p.state !== r.state) {
          if (!canTransition(r.state, p.state, role)) throw forbidden('이 단계로 바꿀 권한이 없습니다.')
          setState(p.state)
        }
        return
      }
      // ---- every assignee finishes on their own ----
      const acts = p.myDone !== undefined || (!!p.state && p.state !== r.state)
      if (acts && role.requester && p.state === 'doing' && (r.state === 'done' || r.state === 'confirmed')) {
        // sent back by the requester: everybody's part is open again
        db.run('UPDATE task_assignees SET done_at = NULL WHERE task_id = ?', [r.id])
        return setState('doing')
      }
      if (acts && role.requester && p.state === 'confirmed' && p.myDone === undefined) {
        if (r.state !== 'done') throw forbidden('담당자가 모두 완료한 뒤에 확인할 수 있습니다.')
        return setState('confirmed')
      }
      if (acts) {
        if (!role.assignee) throw forbidden('이 단계로 바꿀 권한이 없습니다.')
        if (r.state === 'confirmed') throw forbidden('확인이 끝난 업무입니다. 요청한 사람이 다시 열 수 있습니다.')
        // "완료" from an assignee means their own part; taking a finished task back means unmarking it
        const mark = p.myDone ?? (p.state === 'done' ? true : p.state && r.state === 'done' ? false : undefined)
        if (mark !== undefined) db.run('UPDATE task_assignees SET done_at = ? WHERE task_id = ? AND member_id = ?', [mark ? t : null, r.id, req.member.id])
      }
      // the state follows what the assignees finished (also after assignees or the mode changed)
      if (r.state === 'confirmed' && !acts) return
      const c = marks()
      const next: TaskState = c.n > 0 && c.d === c.n ? 'done' : p.state === 'requested' && c.d === 0 ? 'requested' : r.state === 'done' || c.d > 0 || p.state === 'doing' ? 'doing' : r.state
      if (next !== r.state) setState(next)
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
