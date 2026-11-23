import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId } from '../../node/sqlite'
import { sendAlarmSchema, sharedMemoInputSchema, type AlarmFirePayload, type MemoColor, type SentAlarmDto, type SharedMemoDto } from '../../shared/schemas/tools'
import type { ServerContext } from '../context'
import { badRequest, forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { audienceOf, inGroupWhere, scopeDto, setScope, visibleWhere } from '../scope'

interface SharedMemoRow {
  id: string
  body: string
  color: MemoColor
  scope_type: string
  created_by: string
  author_name: string
  checked_at: number | null
  checked_name: string | null
  created_at: number
}

interface SentAlarmRow {
  id: string
  from_id: string
  to_id: string
  from_name: string
  to_name: string
  fire_at: number
  title: string
  body: string
  delivered_at: number | null
  dismissed_at: number | null
}

const MEMO_SELECT = `SELECT s.*, m.name AS author_name, c.name AS checked_name FROM shared_memos s
  JOIN members m ON m.id = s.created_by LEFT JOIN members c ON c.id = s.checked_by`
const ALARM_SELECT = `SELECT a.*, f.name AS from_name, t.name AS to_name FROM sent_alarms a
  JOIN members f ON f.id = a.from_id JOIN members t ON t.id = a.to_id`

/** Undismissed alarms are re-delivered on reconnect for this long (6.12). */
export const ALARM_PENDING_MS = 24 * 3600_000

const firePayload = (r: SentAlarmRow): AlarmFirePayload => ({ id: r.id, fromName: r.from_name, title: r.title, body: r.body, fireAt: r.fire_at })
const alarmDto = (r: SentAlarmRow): SentAlarmDto => ({
  id: r.id,
  fromName: r.from_name,
  toName: r.to_name,
  fireAt: r.fire_at,
  title: r.title,
  body: r.body,
  deliveredAt: r.delivered_at,
  dismissedAt: r.dismissed_at
})

/** Push due team alarms to recipients that are online (runs every 15 s). */
export function runAlarmJobs(ctx: ServerContext, now = Date.now()): number {
  const online = ctx.hub.onlineMemberIds()
  const due = ctx.db.all<SentAlarmRow>(`${ALARM_SELECT} WHERE a.fire_at <= ? AND a.fire_at > ? AND a.delivered_at IS NULL AND a.dismissed_at IS NULL`, [now, now - ALARM_PENDING_MS])
  let n = 0
  for (const r of due) {
    if (!online.has(r.to_id)) continue
    ctx.db.run('UPDATE sent_alarms SET delivered_at = ? WHERE id = ?', [now, r.id])
    ctx.hub.sendTo([r.to_id], 'alarm.fire', firePayload(r))
    ctx.hub.sendTo([r.from_id], 'memo.changed', { alarm: r.id })
    n++
  }
  return n
}

/** Shared memo board and alarms sent to teammates (6.12 ①②). */
export function registerToolRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db
  const memoDto = (r: SharedMemoRow): SharedMemoDto => ({
    id: r.id,
    body: r.body,
    color: r.color,
    scope: scopeDto(db, 'shared_memo', r.id, r.scope_type),
    authorId: r.created_by,
    authorName: r.author_name,
    createdAt: r.created_at,
    checkedAt: r.checked_at,
    checkedByName: r.checked_name
  })
  const visibleMemo = (id: string, memberId: string): SharedMemoRow => {
    const w = visibleWhere('s', 'shared_memo', memberId)
    const r = db.get<SharedMemoRow>(`${MEMO_SELECT} WHERE s.id = ? AND s.deleted_at IS NULL AND ${w.sql}`, [id, ...w.params])
    if (!r) throw notFound('공유 메모')
    return r
  }

  app.get('/api/shared-memos', auth, async (req) => {
    const q = parse(z.object({ groupId: z.string().optional() }), req.query)
    const w = visibleWhere('s', 'shared_memo', req.member.id)
    const where = ['s.deleted_at IS NULL', w.sql]
    const params: (string | number)[] = [...w.params]
    if (q.groupId) {
      where.push(inGroupWhere('s', 'shared_memo'))
      params.push(q.groupId)
    }
    // Checked memos fall off after 7 days.
    where.push('(s.checked_at IS NULL OR s.checked_at > ?)')
    params.push(Date.now() - 7 * 86400000)
    return ok(db.all<SharedMemoRow>(`${MEMO_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.checked_at IS NOT NULL, s.created_at DESC LIMIT 200`, params).map(memoDto))
  })

  app.post('/api/shared-memos', auth, async (req) => {
    const input = parse(sharedMemoInputSchema, req.body)
    const id = newId()
    const t = Date.now()
    db.tx(() => {
      db.run('INSERT INTO shared_memos (id, body, color, scope_type, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, input.body, input.color, input.scope.type, req.member.id, t, t])
      setScope(db, 'shared_memo', id, input.scope, req.member)
    })
    logActivity(ctx, req, 'shared_memo.create', { type: 'shared_memo', id })
    ctx.hub.sendTo(audienceOf(db, 'shared_memos', 'shared_memo', id), 'memo.changed', { id, created: true, authorId: req.member.id, authorName: req.member.name, body: input.body.slice(0, 80) })
    return ok(memoDto(visibleMemo(id, req.member.id)))
  })

  app.post('/api/shared-memos/:id/check', auth, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params)
    const { checked } = parse(z.object({ checked: z.boolean() }), req.body)
    visibleMemo(id, req.member.id)
    db.run('UPDATE shared_memos SET checked_at = ?, checked_by = ?, updated_at = ? WHERE id = ?', [checked ? Date.now() : null, checked ? req.member.id : null, Date.now(), id])
    logActivity(ctx, req, checked ? 'shared_memo.check' : 'shared_memo.uncheck', { type: 'shared_memo', id })
    ctx.hub.sendTo(audienceOf(db, 'shared_memos', 'shared_memo', id), 'memo.changed', { id })
    return ok(memoDto(visibleMemo(id, req.member.id)))
  })

  app.delete('/api/shared-memos/:id', auth, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params)
    const r = visibleMemo(id, req.member.id)
    if (r.created_by !== req.member.id && req.member.role !== 'admin') throw forbidden('작성자와 관리자만 지울 수 있습니다.')
    const audience = audienceOf(db, 'shared_memos', 'shared_memo', id)
    db.run('UPDATE shared_memos SET deleted_at = ? WHERE id = ?', [Date.now(), id])
    logActivity(ctx, req, 'shared_memo.delete', { type: 'shared_memo', id })
    ctx.hub.sendTo(audience, 'memo.changed', { id, deleted: true })
    return ok({ id })
  })

  // ---------- alarms sent to teammates ----------
  app.post('/api/alarms', auth, async (req) => {
    const input = parse(sendAlarmSchema, req.body)
    const now = Date.now()
    const fireAt = input.immediate ? now : input.fireAt
    if (fireAt < now - 60_000) throw badRequest('지난 시각으로는 보낼 수 없습니다.')
    if (fireAt > now + 366 * 86400000) throw badRequest('1년 이내의 시각만 정할 수 있습니다.')
    const ids: string[] = []
    db.tx(() => {
      for (const to of new Set(input.toIds)) {
        if (!db.get(`SELECT 1 FROM members WHERE id = ? AND status = 'active'`, [to])) throw badRequest('없는 구성원이 포함되어 있습니다.')
        const id = newId()
        db.run('INSERT INTO sent_alarms (id, from_id, to_id, fire_at, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, req.member.id, to, fireAt, input.title, input.body, now])
        ids.push(id)
      }
    })
    logActivity(ctx, req, 'alarm.send', null, { count: ids.length, fireAt })
    runAlarmJobs(ctx)
    return ok({ ids })
  })

  app.get('/api/alarms/sent', auth, async (req) => {
    return ok(db.all<SentAlarmRow>(`${ALARM_SELECT} WHERE a.from_id = ? AND a.created_at > ? ORDER BY a.fire_at DESC LIMIT 200`, [req.member.id, Date.now() - 30 * 86400000]).map(alarmDto))
  })

  app.get('/api/alarms/received', auth, async (req) => {
    return ok(db.all<SentAlarmRow>(`${ALARM_SELECT} WHERE a.to_id = ? AND a.created_at > ? ORDER BY a.fire_at DESC LIMIT 200`, [req.member.id, Date.now() - 30 * 86400000]).map(alarmDto))
  })

  /** Due alarms not yet dismissed: the client shows them on (re)connect. */
  app.get('/api/alarms/pending', auth, async (req) => {
    const now = Date.now()
    const rows = db.all<SentAlarmRow>(`${ALARM_SELECT} WHERE a.to_id = ? AND a.fire_at <= ? AND a.fire_at > ? AND a.dismissed_at IS NULL ORDER BY a.fire_at`, [req.member.id, now, now - ALARM_PENDING_MS])
    for (const r of rows) if (!r.delivered_at) db.run('UPDATE sent_alarms SET delivered_at = ? WHERE id = ?', [now, r.id])
    return ok(rows.map(firePayload))
  })

  app.post('/api/alarms/:id/dismiss', auth, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params)
    const r = db.get<SentAlarmRow>(`${ALARM_SELECT} WHERE a.id = ? AND a.to_id = ?`, [id, req.member.id])
    if (!r) throw notFound('알람')
    if (!r.dismissed_at) db.run('UPDATE sent_alarms SET dismissed_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?', [Date.now(), Date.now(), id])
    ctx.hub.sendTo([r.from_id, r.to_id], 'memo.changed', { alarm: id })
    return ok({ id })
  })

  app.delete('/api/alarms/:id', auth, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params)
    const r = db.get<SentAlarmRow>(`${ALARM_SELECT} WHERE a.id = ? AND a.from_id = ?`, [id, req.member.id])
    if (!r) throw notFound('알람')
    if (r.delivered_at) throw badRequest('이미 전달된 알람은 취소할 수 없습니다.')
    db.run('DELETE FROM sent_alarms WHERE id = ?', [id])
    logActivity(ctx, req, 'alarm.cancel', { type: 'alarm', id })
    return ok({ id })
  })
}
