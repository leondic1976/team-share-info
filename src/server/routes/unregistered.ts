import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import type { ServerContext } from '../context'
import { badRequest, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { requirePiiAck } from '../pii'
import { addUnregistered, getUnregistered, listUnregistered, listedCount, unregisteredChanged } from '../unregistered'
import { UNREG_LIMITS, unregisteredInputSchema, unregisteredMergeSchema, unregisteredPatchSchema } from '../../shared/schemas/unregistered'

/**
 * 미등록 인원 (지시 134): everybody reads the list (the pickers of 식사 신청 and 긴급구조지휘대 need
 * the names); the server PC and the 서무 (admins) change it.
 */
export function registerUnregisteredRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler; requireAdmin: preHandlerAsyncHookHandler }): void {
  const db = ctx.db
  const read = { preHandler: guards.requireAuth }
  const admin = { preHandler: [guards.requireAuth, guards.requireAdmin] }
  const idParam = z.object({ id: z.string().min(1).max(40) })
  const find = (id: string) => {
    const p = getUnregistered(db, id)
    if (!p) throw notFound('미등록 인원')
    return p
  }

  app.get('/api/unregistered', read, async () => ok(listUnregistered(db)))

  app.post('/api/unregistered', admin, async (req) => {
    const input = parse(unregisteredInputSchema, req.body)
    requirePiiAck(ctx, req, 'unregistered', [input.memo])
    const r = addUnregistered(db, input, req.member.id)
    if ('error' in r) throw badRequest(r.error)
    logActivity(ctx, req, 'unregistered.create', { type: 'unregistered', id: r.id })
    unregisteredChanged(ctx)
    return ok(find(r.id))
  })

  app.patch('/api/unregistered/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params)
    const cur = find(id)
    if (cur.deleted) throw badRequest('지운 사람은 고칠 수 없습니다.')
    const p = parse(unregisteredPatchSchema, req.body)
    requirePiiAck(ctx, req, 'unregistered.update', [p.memo])
    db.run('UPDATE unregistered_people SET name = COALESCE(?, name), dept = COALESCE(?, dept), title = COALESCE(?, title), memo = COALESCE(?, memo), updated_by = ?, updated_at = ? WHERE id = ?', [
      p.name ?? null,
      p.dept ?? null,
      p.title ?? null,
      p.memo ?? null,
      req.member.id,
      Date.now(),
      id
    ])
    logActivity(ctx, req, 'unregistered.update', { type: 'unregistered', id })
    unregisteredChanged(ctx)
    return ok(find(id))
  })

  /** Taken off the list: kept (deleted) so the records of before still name the person. */
  app.delete('/api/unregistered/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params)
    find(id)
    db.run('UPDATE unregistered_people SET deleted_at = COALESCE(deleted_at, ?), updated_by = ?, updated_at = ? WHERE id = ?', [Date.now(), req.member.id, Date.now(), id])
    logActivity(ctx, req, 'unregistered.delete', { type: 'unregistered', id })
    unregisteredChanged(ctx)
    return ok({ id })
  })

  /** 구성원과 합치기 (the person joined TeamHub) or 합치기 취소 (memberId null). */
  app.put('/api/unregistered/:id/merge', admin, async (req) => {
    const { id } = parse(idParam, req.params)
    const cur = find(id)
    if (cur.deleted) throw badRequest('지운 사람은 합칠 수 없습니다.')
    const { memberId } = parse(unregisteredMergeSchema, req.body)
    if (memberId && !db.get("SELECT 1 FROM members WHERE id = ? AND status = 'active'", [memberId])) throw notFound('구성원')
    if (!memberId && cur.mergedInto && listedCount(db) >= UNREG_LIMITS.max) throw badRequest(`미등록 인원은 ${UNREG_LIMITS.max}명까지 등록할 수 있습니다.`)
    db.run('UPDATE unregistered_people SET merged_into = ?, updated_by = ?, updated_at = ? WHERE id = ?', [memberId, req.member.id, Date.now(), id])
    logActivity(ctx, req, memberId ? 'unregistered.merge' : 'unregistered.unmerge', { type: 'unregistered', id }, memberId ? { memberId } : undefined)
    unregisteredChanged(ctx)
    return ok(find(id))
  })
}
