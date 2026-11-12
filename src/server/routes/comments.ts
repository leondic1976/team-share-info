import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId } from '../../node/sqlite'
import type { Db } from '../../node/sqlite'
import type { CommentDto } from '../../shared/schemas/work'
import type { ServerContext } from '../context'
import { forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'

type Check = (db: Db, ownerId: string, memberId: string) => boolean
type Notify = (ownerId: string) => void

/** Comment owners: how to check visibility and whom to notify (tasks, posts). */
const OWNERS: Record<string, { check: Check; notify: Notify }> = {}

export function registerCommentOwner(type: string, check: Check, notify: Notify): void {
  OWNERS[type] = { check, notify }
}

export function commentCount(db: Db, type: string, id: string): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE owner_type = ? AND owner_id = ? AND deleted_at IS NULL', [type, id])?.n ?? 0
}

export function registerCommentRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db
  const owner = (type: string, id: string, memberId: string) => {
    const o = OWNERS[type]
    if (!o || !o.check(db, id, memberId)) throw notFound('글')
    return o
  }

  app.get('/api/comments/:type/:id', auth, async (req) => {
    const { type, id } = req.params as { type: string; id: string }
    owner(type, id, req.member.id)
    const rows = db.all<{ id: string; body: string; created_by: string; name: string; created_at: number }>(
      `SELECT c.id, c.body, c.created_by, m.name, c.created_at FROM comments c JOIN members m ON m.id = c.created_by
       WHERE c.owner_type = ? AND c.owner_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at`,
      [type, id]
    )
    return ok(rows.map((r): CommentDto => ({ id: r.id, body: r.body, authorId: r.created_by, authorName: r.name, createdAt: r.created_at })))
  })

  app.post('/api/comments/:type/:id', auth, async (req) => {
    const { type, id } = req.params as { type: string; id: string }
    const o = owner(type, id, req.member.id)
    const { body } = parse(z.object({ body: z.string().trim().min(1, '댓글을 입력하세요').max(3000) }), req.body)
    const cid = newId()
    const t = Date.now()
    db.run('INSERT INTO comments (id, owner_type, owner_id, body, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [cid, type, id, body, req.member.id, t, t])
    o.notify(id)
    return ok({ id: cid })
  })

  app.delete('/api/comments/:commentId', auth, async (req) => {
    const { commentId } = req.params as { commentId: string }
    const c = db.get<{ owner_type: string; owner_id: string; created_by: string }>('SELECT owner_type, owner_id, created_by FROM comments WHERE id = ? AND deleted_at IS NULL', [commentId])
    if (!c) throw notFound('댓글')
    const o = owner(c.owner_type, c.owner_id, req.member.id)
    if (c.created_by !== req.member.id && req.member.role !== 'admin') throw forbidden('내가 쓴 댓글만 지울 수 있습니다.')
    db.run('UPDATE comments SET deleted_at = ? WHERE id = ?', [Date.now(), commentId])
    o.notify(c.owner_id)
    return ok({ id: commentId })
  })
}
