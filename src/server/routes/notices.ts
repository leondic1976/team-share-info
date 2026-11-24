import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId, parseJson } from '../../node/sqlite'
import { noticeCreateSchema, noticePatchSchema, type NoticeDto, type NoticeSummaryDto, type ReceiptDto, type UrgentPayload } from '../../shared/schemas/notices'
import type { ServerContext } from '../context'
import { badRequest, forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { getSection } from '../settings'
import { audienceOf, canSee, inGroupWhere, scopeDto, setScope, visibleWhere } from '../scope'
import { cleanHtml } from '../html'
import { deleteAttachmentsOf, linkAttachments, listAttachments } from './attachments'

interface NoticeRow {
  id: string
  level: NoticeSummaryDto['level']
  title: string
  body_html: string
  scope_type: string
  require_ack: number
  reply_options: string | null
  pinned: number
  publish_at: number
  published_at: number | null
  expires_at: number | null
  renotify_minutes: number | null
  created_by: string
  author_name: string
  created_at: number
  deleted_at?: number | null
  r_read_at: number | null
  r_acked_at: number | null
  r_reply: string | null
  r_exists: number | null
  att_count: number
}

const SELECT = `SELECT n.*, CASE WHEN IFNULL(LENGTH(m.nickname), 0) = 0 THEN m.name ELSE m.name || char(40) || m.nickname || char(41) END AS author_name, r.read_at AS r_read_at, r.acked_at AS r_acked_at, r.reply AS r_reply,
  CASE WHEN r.member_id IS NULL THEN NULL ELSE 1 END AS r_exists,
  (SELECT COUNT(*) FROM attachments a WHERE a.owner_type = 'notice' AND a.owner_id = n.id) AS att_count
  FROM notices n JOIN members m ON m.id = n.created_by
  LEFT JOIN notice_receipts r ON r.notice_id = n.id AND r.member_id = ?`

function stats(ctx: ServerContext, id: string): { total: number; read: number; acked: number } {
  return (
    ctx.db.get<{ total: number; read: number; acked: number }>(
      `SELECT COUNT(*) AS total, COUNT(read_at) AS read, COUNT(acked_at) AS acked FROM notice_receipts WHERE notice_id = ?`,
      [id]
    ) ?? { total: 0, read: 0, acked: 0 }
  )
}

function toSummary(ctx: ServerContext, r: NoticeRow, viewer: { id: string; role: string }): NoticeSummaryDto {
  const isAuthor = r.created_by === viewer.id
  return {
    id: r.id,
    level: r.level,
    title: r.title,
    authorId: r.created_by,
    authorName: r.author_name,
    scope: scopeDto(ctx.db, 'notice', r.id, r.scope_type),
    requireAck: !!r.require_ack,
    replyOptions: parseJson<string[]>(r.reply_options, []),
    pinned: !!r.pinned,
    publishAt: r.publish_at,
    publishedAt: r.published_at,
    expiresAt: r.expires_at,
    renotifyMinutes: r.renotify_minutes,
    createdAt: r.created_at,
    my: r.r_exists ? { readAt: r.r_read_at, ackedAt: r.r_acked_at, reply: r.r_reply } : null,
    stats: isAuthor || viewer.role === 'admin' ? stats(ctx, r.id) : null,
    attachmentCount: r.att_count
  }
}

export function urgentPayload(r: Pick<NoticeRow, 'id' | 'title' | 'body_html' | 'author_name' | 'require_ack' | 'reply_options' | 'published_at' | 'level'>): UrgentPayload {
  return {
    id: r.id,
    title: r.title,
    bodyHtml: r.body_html,
    authorName: r.author_name,
    requireAck: !!r.require_ack,
    replyOptions: parseJson<string[]>(r.reply_options, []),
    publishedAt: r.published_at ?? Date.now(),
    level: r.level
  }
}

/** Publish: create receipts for the audience, mark online members delivered, push events. */
export function publishNotice(ctx: ServerContext, id: string): void {
  const db = ctx.db
  const n = db.get<NoticeRow>(`SELECT n.*, CASE WHEN IFNULL(LENGTH(m.nickname), 0) = 0 THEN m.name ELSE m.name || char(40) || m.nickname || char(41) END AS author_name FROM notices n JOIN members m ON m.id = n.created_by WHERE n.id = ?`, [id])
  if (!n || n.deleted_at) return
  const t = Date.now()
  const audience = audienceOf(db, 'notices', 'notice', id)
  const recipients = [...audience].filter((m) => m !== n.created_by)
  const online = ctx.hub.onlineMemberIds()
  db.tx(() => {
    db.run('UPDATE notices SET published_at = ?, updated_at = ? WHERE id = ?', [t, t, id])
    for (const m of recipients) {
      db.run(
        `INSERT INTO notice_receipts (notice_id, member_id, delivered_at, last_notified_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [id, m, online.has(m) ? t : null, online.has(m) ? t : null]
      )
    }
  })
  n.published_at = t
  if (n.level === 'urgent') ctx.hub.sendTo(recipients, 'notice.urgent', urgentPayload(n))
  const groupIds = n.scope_type === 'group' ? scopeDto(ctx.db, 'notice', id, 'group').groups.map((g) => g.id) : []
  ctx.hub.sendTo(audience, 'notice.changed', { id, level: n.level, title: n.title, authorName: n.author_name, authorId: n.created_by, published: true, groupIds })
}

/** Background jobs: scheduled publishing and automatic re-notification of unacked urgent notices. */
export function runNoticeJobs(ctx: ServerContext, now = Date.now()): void {
  const db = ctx.db
  for (const r of db.all<{ id: string }>('SELECT id FROM notices WHERE published_at IS NULL AND deleted_at IS NULL AND publish_at <= ?', [now])) {
    publishNotice(ctx, r.id)
  }
  const online = ctx.hub.onlineMemberIds()
  if (!online.size) return
  const due = db.all<NoticeRow & { member_id: string }>(
    `SELECT n.*, CASE WHEN IFNULL(LENGTH(m.nickname), 0) = 0 THEN m.name ELSE m.name || char(40) || m.nickname || char(41) END AS author_name, r.member_id FROM notices n
     JOIN members m ON m.id = n.created_by
     JOIN notice_receipts r ON r.notice_id = n.id
     WHERE n.level = 'urgent' AND n.deleted_at IS NULL AND n.published_at IS NOT NULL AND n.renotify_minutes IS NOT NULL
       AND (n.expires_at IS NULL OR n.expires_at > ?)
       AND ((n.require_ack = 1 AND r.acked_at IS NULL) OR (n.require_ack = 0 AND r.read_at IS NULL))
       AND (r.last_notified_at IS NULL OR r.last_notified_at <= ? - n.renotify_minutes * 60000)`,
    [now, now]
  )
  for (const d of due) {
    if (!online.has(d.member_id)) continue
    ctx.hub.sendTo([d.member_id], 'notice.urgent', urgentPayload(d))
    db.run('UPDATE notice_receipts SET last_notified_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE notice_id = ? AND member_id = ?', [now, now, d.id, d.member_id])
  }
}

export function registerNoticeRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db

  const load = (req: FastifyRequest, id: string): NoticeRow => {
    const r = db.get<NoticeRow>(`${SELECT} WHERE n.id = ? AND n.deleted_at IS NULL`, [req.member.id, id])
    if (!r || !canSee(db, 'notices', 'notice', id, req.member.id)) throw notFound('공지')
    if (!r.published_at && r.created_by !== req.member.id && req.member.role !== 'admin') throw notFound('공지')
    return r
  }
  const canManage = (req: FastifyRequest, r: NoticeRow): void => {
    if (r.created_by !== req.member.id && req.member.role !== 'admin') throw forbidden('작성자만 할 수 있습니다.')
  }

  app.get('/api/notices', auth, async (req) => {
    const q = parse(
      z.object({
        groupId: z.string().optional(),
        filter: z.enum(['all', 'unread', 'mine']).default('all'),
        before: z.coerce.number().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50)
      }),
      req.query
    )
    const w = visibleWhere('n', 'notice', req.member.id)
    const where = [`n.deleted_at IS NULL`, w.sql, `(n.published_at IS NOT NULL OR n.created_by = ?)`]
    const params: (string | number)[] = [req.member.id, ...w.params, req.member.id]
    if (q.groupId) {
      where.push(inGroupWhere('n', 'notice'))
      params.push(q.groupId)
    }
    if (q.filter === 'unread') where.push('r.member_id IS NOT NULL AND r.read_at IS NULL')
    if (q.filter === 'mine') {
      where.push('n.created_by = ?')
      params.push(req.member.id)
    }
    if (q.before) {
      where.push('COALESCE(n.published_at, n.publish_at) < ?')
      params.push(q.before)
    }
    const rows = db.all<NoticeRow>(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY (n.pinned = 1 AND (n.expires_at IS NULL OR n.expires_at > ${Date.now()})) DESC, COALESCE(n.published_at, n.publish_at) DESC LIMIT ?`,
      [...params, q.limit]
    )
    return ok(rows.map((r) => toSummary(ctx, r, req.member)))
  })

  app.get('/api/notices/unread-count', auth, async (req) => {
    const r = db.get<{ n: number; urgent: number }>(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN n.level = 'urgent' THEN 1 ELSE 0 END) AS urgent
       FROM notice_receipts r JOIN notices n ON n.id = r.notice_id
       WHERE r.member_id = ? AND r.read_at IS NULL AND n.deleted_at IS NULL AND n.published_at IS NOT NULL`,
      [req.member.id]
    )
    return ok({ unread: r?.n ?? 0, urgent: r?.urgent ?? 0 })
  })

  /** Called right after (re)connecting: notices not yet delivered to me (13.7). */
  app.get('/api/notices/pending', auth, async (req) => {
    const rows = db.all<NoticeRow>(
      `SELECT n.*, CASE WHEN IFNULL(LENGTH(m.nickname), 0) = 0 THEN m.name ELSE m.name || char(40) || m.nickname || char(41) END AS author_name FROM notice_receipts r JOIN notices n ON n.id = r.notice_id JOIN members m ON m.id = n.created_by
       WHERE r.member_id = ? AND r.delivered_at IS NULL AND n.deleted_at IS NULL AND n.published_at IS NOT NULL
         AND (n.expires_at IS NULL OR n.expires_at > ?) ORDER BY n.published_at`,
      [req.member.id, Date.now()]
    )
    const t = Date.now()
    for (const r of rows) db.run('UPDATE notice_receipts SET delivered_at = ?, last_notified_at = ? WHERE notice_id = ? AND member_id = ?', [t, t, r.id, req.member.id])
    // Unacknowledged urgent notices are shown again after reconnecting, even if delivered before.
    const unacked = db.all<NoticeRow>(
      `SELECT n.*, CASE WHEN IFNULL(LENGTH(m.nickname), 0) = 0 THEN m.name ELSE m.name || char(40) || m.nickname || char(41) END AS author_name FROM notice_receipts r JOIN notices n ON n.id = r.notice_id JOIN members m ON m.id = n.created_by
       WHERE r.member_id = ? AND r.delivered_at IS NOT NULL AND n.level = 'urgent' AND n.deleted_at IS NULL
         AND ((n.require_ack = 1 AND r.acked_at IS NULL) OR (n.require_ack = 0 AND r.read_at IS NULL))
         AND (n.expires_at IS NULL OR n.expires_at > ?)`,
      [req.member.id, t]
    )
    const seen = new Set(rows.map((r) => r.id))
    const all = [...rows, ...unacked.filter((u) => !seen.has(u.id))]
    return ok(all.map((r) => ({ ...urgentPayload(r), level: r.level })))
  })

  app.get('/api/notices/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    db.run('UPDATE notice_receipts SET delivered_at = COALESCE(delivered_at, ?) WHERE notice_id = ? AND member_id = ?', [Date.now(), id, req.member.id])
    const dto: NoticeDto = { ...toSummary(ctx, r, req.member), bodyHtml: r.body_html, attachments: listAttachments(db, 'notice', id) }
    return ok(dto)
  })

  app.post('/api/notices', auth, async (req) => {
    const input = parse(noticeCreateSchema, req.body)
    if (input.level === 'urgent' && getSection(db, 'ops').urgentSenders === 'admins' && req.member.role !== 'admin') {
      throw forbidden('긴급 공지는 관리자만 보낼 수 있습니다.')
    }
    if (input.expiresAt && input.expiresAt <= Date.now()) throw badRequest('만료 시각은 현재보다 뒤여야 합니다.')
    const id = newId()
    const t = Date.now()
    const publishAt = input.publishAt && input.publishAt > t ? input.publishAt : t
    db.tx(() => {
      db.run(
        `INSERT INTO notices (id, level, title, body_html, scope_type, require_ack, reply_options, pinned, publish_at, expires_at, renotify_minutes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.level,
          input.title,
          cleanHtml(input.bodyHtml),
          input.scope.type,
          input.requireAck ? 1 : 0,
          input.replyOptions.length ? JSON.stringify(input.replyOptions) : null,
          input.pinned ? 1 : 0,
          publishAt,
          input.expiresAt,
          input.level === 'urgent' ? input.renotifyMinutes : null,
          req.member.id,
          t,
          t
        ]
      )
      setScope(db, 'notice', id, input.scope, req.member)
      linkAttachments(ctx, input.attachmentIds, 'notice', id, req.member.id)
    })
    logActivity(ctx, req, 'notice.create', { type: 'notice', id }, { level: input.level, title: input.title })
    if (publishAt <= t) publishNotice(ctx, id)
    else ctx.hub.sendTo([req.member.id], 'notice.changed', { id })
    return ok(toSummary(ctx, db.get<NoticeRow>(`${SELECT} WHERE n.id = ?`, [req.member.id, id])!, req.member))
  })

  app.patch('/api/notices/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    canManage(req, r)
    const p = parse(noticePatchSchema, req.body)
    db.run(
      `UPDATE notices SET title = COALESCE(?, title), body_html = COALESCE(?, body_html), pinned = COALESCE(?, pinned),
       expires_at = CASE WHEN ? THEN ? ELSE expires_at END, updated_at = ? WHERE id = ?`,
      [p.title ?? null, p.bodyHtml !== undefined ? cleanHtml(p.bodyHtml) : null, p.pinned === undefined ? null : p.pinned ? 1 : 0, p.expiresAt !== undefined ? 1 : 0, p.expiresAt ?? null, Date.now(), id]
    )
    logActivity(ctx, req, 'notice.update', { type: 'notice', id })
    ctx.hub.sendTo(audienceOf(db, 'notices', 'notice', id), 'notice.changed', { id })
    return ok({ id })
  })

  app.delete('/api/notices/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    canManage(req, r)
    const audience = audienceOf(db, 'notices', 'notice', id)
    db.run('UPDATE notices SET deleted_at = ?, updated_at = ? WHERE id = ?', [Date.now(), Date.now(), id])
    deleteAttachmentsOf(ctx, 'notice', id)
    logActivity(ctx, req, 'notice.delete', { type: 'notice', id }, { title: r.title })
    ctx.hub.sendTo(audience, 'notice.changed', { id, deleted: true })
    return ok({ id })
  })

  app.post('/api/notices/:id/read', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    const t = Date.now()
    const res = db.run(
      'UPDATE notice_receipts SET delivered_at = COALESCE(delivered_at, ?), read_at = COALESCE(read_at, ?) WHERE notice_id = ? AND member_id = ?',
      [t, t, id, req.member.id]
    )
    if (res.changes) ctx.hub.sendTo([r.created_by, req.member.id], 'notice.receipt', { id })
    return ok({ id, readAt: t })
  })

  app.post('/api/notices/:id/ack', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    const { reply } = parse(z.object({ reply: z.string().max(20).optional() }), req.body ?? {})
    const options = parseJson<string[]>(r.reply_options, [])
    if (options.length && (!reply || !options.includes(reply))) throw badRequest('회신 항목을 선택하세요.')
    const t = Date.now()
    const res = db.run(
      `UPDATE notice_receipts SET delivered_at = COALESCE(delivered_at, ?), read_at = COALESCE(read_at, ?), acked_at = ?, reply = ? WHERE notice_id = ? AND member_id = ?`,
      [t, t, t, reply ?? null, id, req.member.id]
    )
    if (!res.changes) throw badRequest('수신 대상이 아닙니다.')
    logActivity(ctx, req, 'notice.ack', { type: 'notice', id }, reply ? { reply } : undefined)
    ctx.hub.sendTo([r.created_by, req.member.id], 'notice.receipt', { id })
    return ok({ id, ackedAt: t })
  })

  app.get('/api/notices/:id/receipts', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    canManage(req, r)
    const online = ctx.hub.onlineMemberIds()
    const rows = db.all<{ member_id: string; name: string; dept_name: string | null; delivered_at: number | null; read_at: number | null; acked_at: number | null; reply: string | null }>(
      `SELECT r.member_id, m.name, d.name AS dept_name, r.delivered_at, r.read_at, r.acked_at, r.reply
       FROM notice_receipts r JOIN members m ON m.id = r.member_id LEFT JOIN departments d ON d.id = m.dept_id
       WHERE r.notice_id = ? ORDER BY r.acked_at IS NOT NULL, r.read_at IS NOT NULL, m.name`,
      [id]
    )
    const list: ReceiptDto[] = rows.map((x) => ({
      memberId: x.member_id,
      name: x.name,
      deptName: x.dept_name,
      deliveredAt: x.delivered_at,
      readAt: x.read_at,
      ackedAt: x.acked_at,
      reply: x.reply,
      online: online.has(x.member_id)
    }))
    return ok(list)
  })

  /** Re-notify everyone who has not read (or acknowledged, when required) yet. */
  app.post('/api/notices/:id/renotify', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    canManage(req, r)
    if (!r.published_at) throw badRequest('아직 게시되지 않은 공지입니다.')
    const targets = db
      .all<{ member_id: string }>(
        `SELECT member_id FROM notice_receipts WHERE notice_id = ? AND ${r.require_ack ? 'acked_at IS NULL' : 'read_at IS NULL'}`,
        [id]
      )
      .map((x) => x.member_id)
    const t = Date.now()
    const online = ctx.hub.onlineMemberIds()
    const payload = urgentPayload(r)
    if (r.level === 'urgent') ctx.hub.sendTo(targets, 'notice.urgent', payload)
    else ctx.hub.sendTo(targets, 'notice.changed', { id, level: r.level, title: r.title, authorName: r.author_name, renotify: true })
    for (const m of targets) {
      if (online.has(m)) db.run('UPDATE notice_receipts SET last_notified_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE notice_id = ? AND member_id = ?', [t, t, id, m])
      else db.run('UPDATE notice_receipts SET delivered_at = NULL WHERE notice_id = ? AND member_id = ? AND read_at IS NULL', [id, m])
    }
    logActivity(ctx, req, 'notice.renotify', { type: 'notice', id }, { count: targets.length })
    return ok({ count: targets.length, online: targets.filter((m) => online.has(m)).length })
  })
}
