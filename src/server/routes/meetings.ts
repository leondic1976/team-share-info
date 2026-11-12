import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId } from '../../node/sqlite'
import { meetingInputSchema, type MeetingDto, type MeetingInvitePayload, type MeetingParticipantDto } from '../../shared/schemas/meetings'
import type { ServerContext } from '../context'
import { badRequest, forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { audienceOf, scopeDto, setScope, visibleWhere } from '../scope'

interface Row {
  id: string
  title: string
  mode: 'video' | 'screen'
  host_id: string
  host_name: string
  state: 'live' | 'ended'
  scope_type: string
  conversation_id: string | null
  event_id: string | null
  created_by: string
  started_at: number
  ended_at: number | null
}

const SELECT = 'SELECT m.*, h.name AS host_name FROM meetings m JOIN members h ON h.id = m.host_id'

/** Members currently in a meeting (joined and not left). */
export function activeParticipants(ctx: ServerContext, meetingId: string): string[] {
  return ctx.db.all<{ member_id: string }>('SELECT member_id FROM meeting_participants WHERE meeting_id = ? AND left_at IS NULL', [meetingId]).map((r) => r.member_id)
}

/**
 * Meetings (6.17): create / join / leave / end, and the rtc.signal relay that only
 * passes signals between two active participants of the same live meeting (13.7).
 */
export function registerMeetingRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db

  const dto = (r: Row): MeetingDto => ({
    id: r.id,
    title: r.title,
    mode: r.mode,
    hostId: r.host_id,
    hostName: r.host_name,
    state: r.state,
    scope: scopeDto(db, 'meeting', r.id, r.scope_type),
    conversationId: r.conversation_id,
    eventId: r.event_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    participants: db.all<{ member_id: string; name: string; joined_at: number; left_at: number | null }>(
      'SELECT p.member_id, m.name, p.joined_at, p.left_at FROM meeting_participants p JOIN members m ON m.id = p.member_id WHERE p.meeting_id = ? ORDER BY p.joined_at',
      [r.id]
    ).map((p): MeetingParticipantDto => ({ memberId: p.member_id, name: p.name, joinedAt: p.joined_at, leftAt: p.left_at }))
  })

  const visible = (id: string, memberId: string): Row => {
    const w = visibleWhere('m', 'meeting', memberId)
    const r = db.get<Row>(`${SELECT} WHERE m.id = ? AND ${w.sql}`, [id, ...w.params])
    if (!r) throw notFound('회의')
    return r
  }
  const notify = (id: string, extra: Record<string, unknown> = {}): void => {
    ctx.hub.sendTo([...audienceOf(db, 'meetings', 'meeting', id), ...activeParticipants(ctx, id)], 'meeting.changed', { id, ...extra })
  }
  const end = (id: string): void => {
    const t = Date.now()
    db.run(`UPDATE meetings SET state = 'ended', ended_at = ? WHERE id = ? AND state = 'live'`, [t, id])
    db.run('UPDATE meeting_participants SET left_at = ? WHERE meeting_id = ? AND left_at IS NULL', [t, id])
  }

  // Signals pass only between two active participants of a live meeting.
  ctx.hub.rtcRelay = (from, msg) => {
    if (!msg.meetingId || !msg.to || from === msg.to) return
    const live = db.get(`SELECT 1 FROM meetings WHERE id = ? AND state = 'live'`, [msg.meetingId])
    if (!live) return
    const active = new Set(activeParticipants(ctx, msg.meetingId))
    if (!active.has(from) || !active.has(msg.to)) return
    if (JSON.stringify(msg.data ?? null).length > 200_000) return
    ctx.hub.sendTo([msg.to], 'rtc.signal', { meetingId: msg.meetingId, from, data: msg.data })
  }

  app.get('/api/meetings', auth, async (req) => {
    const q = parse(z.object({ state: z.enum(['live', 'ended', 'all']).default('live'), conversationId: z.string().optional(), eventId: z.string().optional() }), req.query)
    const w = visibleWhere('m', 'meeting', req.member.id)
    const where = [w.sql]
    const params: (string | number)[] = [...w.params]
    if (q.state !== 'all') {
      where.push('m.state = ?')
      params.push(q.state)
    }
    if (q.conversationId) {
      where.push('m.conversation_id = ?')
      params.push(q.conversationId)
    }
    if (q.eventId) {
      where.push('m.event_id = ?')
      params.push(q.eventId)
    }
    return ok(db.all<Row>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY m.started_at DESC LIMIT 100`, params).map(dto))
  })

  app.get('/api/meetings/:id', auth, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params)
    return ok(dto(visible(id, req.member.id)))
  })

  app.post('/api/meetings', auth, async (req) => {
    const input = parse(meetingInputSchema, req.body)
    const id = newId()
    const t = Date.now()
    db.tx(() => {
      db.run('INSERT INTO meetings (id, title, host_id, conversation_id, event_id, mode, scope_type, created_by, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        input.title,
        req.member.id,
        input.conversationId,
        input.eventId,
        input.mode,
        input.scope.type,
        req.member.id,
        t
      ])
      setScope(db, 'meeting', id, input.scope, req.member)
      db.run('INSERT INTO meeting_participants (meeting_id, member_id, joined_at) VALUES (?, ?, ?)', [id, req.member.id, t])
    })
    logActivity(ctx, req, 'meeting.start', { type: 'meeting', id }, { mode: input.mode })
    const invite: MeetingInvitePayload = { id, title: input.title, mode: input.mode, hostName: req.member.name }
    // Invite pop-ups go to people named directly or through a group; a team-wide meeting is only listed.
    const audience = audienceOf(db, 'meetings', 'meeting', id)
    audience.delete(req.member.id)
    if (input.scope.type !== 'team') ctx.hub.sendTo(audience, 'meeting.invite', invite)
    notify(id)
    return ok(dto(visible(id, req.member.id)))
  })

  app.post('/api/meetings/:id/join', auth, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params)
    const r = visible(id, req.member.id)
    if (r.state !== 'live') throw badRequest('이미 끝난 회의입니다.')
    db.run('INSERT INTO meeting_participants (meeting_id, member_id, joined_at) VALUES (?, ?, ?) ON CONFLICT(meeting_id, member_id) DO UPDATE SET joined_at = excluded.joined_at, left_at = NULL', [id, req.member.id, Date.now()])
    logActivity(ctx, req, 'meeting.join', { type: 'meeting', id })
    notify(id, { joined: req.member.id })
    return ok(dto(visible(id, req.member.id)))
  })

  app.post('/api/meetings/:id/leave', auth, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params)
    visible(id, req.member.id)
    db.run('UPDATE meeting_participants SET left_at = ? WHERE meeting_id = ? AND member_id = ? AND left_at IS NULL', [Date.now(), id, req.member.id])
    // The meeting ends when the last person leaves.
    if (!activeParticipants(ctx, id).length) end(id)
    notify(id, { left: req.member.id })
    return ok({ id })
  })

  app.post('/api/meetings/:id/end', auth, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params)
    const r = visible(id, req.member.id)
    if (r.host_id !== req.member.id && req.member.role !== 'admin') throw forbidden('회의를 연 사람과 관리자만 끝낼 수 있습니다.')
    const before = activeParticipants(ctx, id)
    end(id)
    logActivity(ctx, req, 'meeting.end', { type: 'meeting', id })
    ctx.hub.sendTo(before, 'meeting.changed', { id, ended: true })
    notify(id, { ended: true })
    return ok({ id })
  })

  app.post('/api/meetings/:id/decline', auth, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params)
    const r = visible(id, req.member.id)
    ctx.hub.sendTo([r.host_id], 'meeting.changed', { id, declined: req.member.id, declinedName: req.member.name })
    return ok({ id })
  })
}

/** A member whose last connection closed leaves the meetings they were in. */
export function leaveAllMeetings(ctx: ServerContext, memberId: string): void {
  const live = ctx.db.all<{ meeting_id: string }>(
    `SELECT p.meeting_id FROM meeting_participants p JOIN meetings m ON m.id = p.meeting_id WHERE p.member_id = ? AND p.left_at IS NULL AND m.state = 'live'`,
    [memberId]
  )
  for (const { meeting_id: id } of live) {
    ctx.db.run('UPDATE meeting_participants SET left_at = ? WHERE meeting_id = ? AND member_id = ?', [Date.now(), id, memberId])
    const rest = activeParticipants(ctx, id)
    if (!rest.length) ctx.db.run(`UPDATE meetings SET state = 'ended', ended_at = ? WHERE id = ?`, [Date.now(), id])
    ctx.hub.sendTo([...rest, memberId], 'meeting.changed', { id, left: memberId })
  }
}
