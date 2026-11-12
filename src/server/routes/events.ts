import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId, parseJson } from '../../node/sqlite'
import type { Db } from '../../node/sqlite'
import { eventInputSchema, eventPatchSchema, type EventDto, type EventOccurrenceDto } from '../../shared/schemas/events'
import type { ScopeInput } from '../../shared/schemas/scope'
import { expand, isEmptyRule, truncateRule } from '../../shared/recurrence'
import type { ServerContext } from '../context'
import { badRequest, forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { audienceOf, canSee, inGroupWhere, scopeDto, setScope, visibleWhere } from '../scope'
import { cleanHtml } from '../html'
import holidayData from '../../../resources/data/holidays-kr.json'

interface EventRow {
  id: string
  kind: 'team' | 'absence' | 'busy'
  title: string
  body_html: string
  start_at: number
  end_at: number
  all_day: number
  rrule: string | null
  exdates: string
  location: string | null
  absence_type: string | null
  reminders: string
  scope_type: string
  created_by: string
  author_name: string
  created_at: number
  attendee_count: number
  my_response: EventOccurrenceDto['myResponse']
}

const SELECT = `SELECT e.*, m.name AS author_name,
  (SELECT COUNT(*) FROM event_attendees a WHERE a.event_id = e.id) AS attendee_count,
  (SELECT response FROM event_attendees a WHERE a.event_id = e.id AND a.member_id = ?) AS my_response
  FROM events e JOIN members m ON m.id = e.created_by`

const asRecurring = (r: EventRow) => ({ startAt: r.start_at, endAt: r.end_at, allDay: !!r.all_day, rrule: r.rrule, exdates: parseJson<number[]>(r.exdates, []) })

/** Is the member inside an absence event right now? (presence = 'absent') */
export function isAbsentNow(db: Db, memberId: string, now = Date.now()): boolean {
  const rows = db.all<EventRow>(
    `SELECT * FROM events WHERE created_by = ? AND kind = 'absence' AND deleted_at IS NULL AND start_at <= ? AND (rrule IS NOT NULL OR end_at > ?)`,
    [memberId, now, now]
  )
  return rows.some((r) => expand(asRecurring(r), now, now + 1).length > 0)
}

/** Seed built-in holidays (admins may edit; edited rows are kept). */
export function seedHolidays(db: Db): void {
  for (const [, days] of Object.entries(holidayData as unknown as Record<string, [string, string][]>)) {
    for (const [date, name] of days) db.run(`INSERT INTO holidays (date, name, source) VALUES (?, ?, 'builtin') ON CONFLICT(date) DO NOTHING`, [date, name])
  }
}

function setAttendees(db: Db, eventId: string, ids: string[], keep = new Map<string, string>()): void {
  db.run('DELETE FROM event_attendees WHERE event_id = ?', [eventId])
  for (const id of new Set(ids)) {
    if (!db.get(`SELECT 1 FROM members WHERE id = ? AND status = 'active'`, [id])) continue
    db.run('INSERT INTO event_attendees (event_id, member_id, response) VALUES (?, ?, ?)', [eventId, id, keep.get(id) ?? 'none'])
  }
}

/** Attendees must always be able to see the event: they are added as member targets. */
function applyScope(db: Db, id: string, scope: ScopeInput, attendees: string[], actor: { id: string; role: string }): void {
  setScope(db, 'event', id, scope, actor)
  if (scope.type !== 'team') {
    for (const a of new Set(attendees)) {
      db.run(`INSERT INTO scope_targets (item_type, item_id, target_type, target_id) VALUES ('event', ?, 'member', ?) ON CONFLICT DO NOTHING`, [id, a])
    }
  }
}

function eventColor(db: Db, r: EventRow): string | null {
  if (r.kind === 'absence') return '#64748b'
  if (r.scope_type !== 'group') return null
  return db.get<{ color: string }>(`SELECT g.color FROM scope_targets st JOIN groups g ON g.id = st.target_id WHERE st.item_type = 'event' AND st.item_id = ? AND st.target_type = 'group' LIMIT 1`, [r.id])?.color ?? null
}

export function registerEventRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler; requireAdmin: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db
  seedHolidays(db)
  ctx.hub.absenceLookup = (memberId) => isAbsentNow(db, memberId)

  const load = (req: FastifyRequest, id: string): EventRow => {
    const r = db.get<EventRow>(`${SELECT} WHERE e.id = ? AND e.deleted_at IS NULL`, [req.member.id, id])
    if (!r || !canSee(db, 'events', 'event', id, req.member.id)) throw notFound('일정')
    return r
  }
  const canEdit = (req: FastifyRequest, r: EventRow): void => {
    if (r.created_by !== req.member.id && req.member.role !== 'admin') throw forbidden('작성자만 수정할 수 있습니다.')
  }
  const notify = (id: string, extra: Iterable<string> = []): void => {
    ctx.hub.sendTo([...audienceOf(db, 'events', 'event', id), ...extra], 'event.changed', { id })
  }

  app.get('/api/events', auth, async (req) => {
    const q = parse(z.object({ from: z.coerce.number(), to: z.coerce.number(), groupId: z.string().optional(), memberId: z.string().optional() }), req.query)
    if (q.to - q.from > 400 * 86400000) throw badRequest('조회 기간이 너무 깁니다.')
    const w = visibleWhere('e', 'event', req.member.id)
    const where = [`e.deleted_at IS NULL`, `e.start_at < ?`, `(e.rrule IS NOT NULL OR e.end_at > ?)`, w.sql]
    const params: (string | number)[] = [req.member.id, q.to, q.from, ...w.params]
    if (q.groupId) {
      where.push(inGroupWhere('e', 'event'))
      params.push(q.groupId)
    }
    if (q.memberId) {
      where.push('e.created_by = ?')
      params.push(q.memberId)
    }
    const rows = db.all<EventRow>(`${SELECT} WHERE ${where.join(' AND ')}`, params)
    const out: EventOccurrenceDto[] = []
    for (const r of rows) {
      const scope = scopeDto(db, 'event', r.id, r.scope_type)
      const color = eventColor(db, r)
      for (const o of expand(asRecurring(r), q.from, q.to, 500)) {
        out.push({
          id: r.id,
          key: o.key,
          start: o.start,
          end: o.end,
          allDay: !!r.all_day,
          title: r.title,
          kind: r.kind,
          location: r.location,
          absenceType: r.absence_type,
          recurring: !!r.rrule,
          authorId: r.created_by,
          authorName: r.author_name,
          color,
          scope,
          attendeeCount: r.attendee_count,
          myResponse: r.my_response,
          reminders: parseJson<number[]>(r.reminders, [])
        })
      }
    }
    out.sort((a, b) => a.start - b.start)
    return ok(out)
  })

  app.get('/api/events/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    const attendees = db.all<{ member_id: string; name: string; response: EventDto['attendees'][number]['response'] }>(
      'SELECT a.member_id, m.name, a.response FROM event_attendees a JOIN members m ON m.id = a.member_id WHERE a.event_id = ? ORDER BY m.name',
      [id]
    )
    const dto: EventDto = {
      id: r.id,
      kind: r.kind,
      title: r.title,
      bodyHtml: r.body_html,
      startAt: r.start_at,
      endAt: r.end_at,
      allDay: !!r.all_day,
      rrule: r.rrule,
      exdates: parseJson<number[]>(r.exdates, []),
      location: r.location,
      absenceType: r.absence_type,
      reminders: parseJson<number[]>(r.reminders, []),
      scope: scopeDto(db, 'event', id, r.scope_type),
      authorId: r.created_by,
      authorName: r.author_name,
      attendees: attendees.map((a) => ({ memberId: a.member_id, name: a.name, response: a.response })),
      createdAt: r.created_at
    }
    return ok(dto)
  })

  const insert = (req: FastifyRequest, input: z.infer<typeof eventInputSchema>, kind: EventRow['kind'], seriesId: string | null = null): string => {
    const id = newId()
    const t = Date.now()
    // Absence is visible to the whole team so presence and the calendar show it (6.4).
    const scope: ScopeInput = kind === 'absence' ? { type: 'team', groupIds: [], memberIds: [] } : input.scope
    db.run(
      `INSERT INTO events (id, kind, title, body_html, start_at, end_at, all_day, rrule, exdates, location, absence_type, reminders, scope_type, series_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        kind,
        input.title,
        cleanHtml(input.bodyHtml),
        input.startAt,
        input.endAt,
        input.allDay ? 1 : 0,
        input.rrule,
        input.location || null,
        kind === 'absence' ? input.absenceType ?? '기타' : null,
        JSON.stringify(input.reminders),
        scope.type,
        seriesId,
        req.member.id,
        t,
        t
      ]
    )
    applyScope(db, id, scope, input.attendeeIds, req.member)
    setAttendees(db, id, input.attendeeIds)
    return id
  }

  app.post('/api/events', auth, async (req) => {
    const input = parse(eventInputSchema, req.body)
    if (input.rrule) {
      try {
        expand({ startAt: input.startAt, endAt: input.endAt, allDay: input.allDay, rrule: input.rrule, exdates: [] }, input.startAt, input.startAt + 86400000)
      } catch {
        throw badRequest('반복 규칙이 올바르지 않습니다.')
      }
    }
    const id = db.tx(() => insert(req, input, input.kind))
    logActivity(ctx, req, 'event.create', { type: 'event', id }, { title: input.title, kind: input.kind })
    notify(id)
    if (input.kind === 'absence') ctx.hub.broadcast('presence.changed', { memberId: req.member.id, presence: ctx.hub.presenceOf(req.member.id) })
    return ok({ id })
  })

  /** "바쁨으로만 표시": a time block without details, visible to the team (13.10). */
  app.post('/api/events/busy', auth, async (req) => {
    const b = parse(z.object({ startAt: z.number().int(), endAt: z.number().int(), allDay: z.boolean().default(false), rrule: z.string().max(300).nullable().default(null) }), req.body)
    const id = db.tx(() =>
      insert(
        req,
        { kind: 'team', title: '바쁨', bodyHtml: '', startAt: b.startAt, endAt: b.endAt, allDay: b.allDay, rrule: b.rrule, location: '', absenceType: null, reminders: [], scope: { type: 'team', groupIds: [], memberIds: [] }, attendeeIds: [] },
        'busy'
      )
    )
    notify(id)
    return ok({ id })
  })

  app.patch('/api/events/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    canEdit(req, r)
    const p = parse(eventPatchSchema, req.body)
    const before = audienceOf(db, 'events', 'event', id)
    const merged = {
      kind: r.kind === 'busy' ? 'team' : r.kind,
      title: p.title ?? r.title,
      bodyHtml: p.bodyHtml ?? r.body_html,
      startAt: p.startAt ?? r.start_at,
      endAt: p.endAt ?? r.end_at,
      allDay: p.allDay ?? !!r.all_day,
      rrule: p.rrule !== undefined ? p.rrule : r.rrule,
      location: p.location ?? r.location ?? '',
      absenceType: p.absenceType !== undefined ? p.absenceType : r.absence_type,
      reminders: p.reminders ?? parseJson<number[]>(r.reminders, []),
      scope: p.scope ?? { type: r.scope_type as ScopeInput['type'], groupIds: scopeDto(db, 'event', id, r.scope_type).groups.map((g) => g.id), memberIds: scopeDto(db, 'event', id, r.scope_type).members.map((m) => m.id) },
      attendeeIds: p.attendeeIds ?? db.all<{ member_id: string }>('SELECT member_id FROM event_attendees WHERE event_id = ?', [id]).map((a) => a.member_id)
    }
    if (merged.endAt < merged.startAt) throw badRequest('끝나는 시각이 시작보다 빠릅니다.')
    let resultId = id
    db.tx(() => {
      if (p.mode === 'this' && r.rrule && p.occurrenceStart !== undefined) {
        // Exception: hide this occurrence from the series and create a standalone copy.
        const ex = [...parseJson<number[]>(r.exdates, []), p.occurrenceStart]
        db.run('UPDATE events SET exdates = ?, updated_at = ? WHERE id = ?', [JSON.stringify(ex), Date.now(), id])
        const dur = merged.endAt - merged.startAt
        const start = p.startAt ?? p.occurrenceStart
        resultId = insert(req, { ...merged, rrule: null, startAt: start, endAt: p.endAt ?? start + dur } as z.infer<typeof eventInputSchema>, r.kind, id)
      } else if (p.mode === 'following' && r.rrule && p.occurrenceStart !== undefined && p.occurrenceStart > r.start_at) {
        // Split: the old series ends before this occurrence; a new series starts here.
        db.run('UPDATE events SET rrule = ?, updated_at = ? WHERE id = ?', [truncateRule(r.rrule, p.occurrenceStart), Date.now(), id])
        // For this/following, startAt/endAt are the edited occurrence's times (13.4 UI contract).
        const start = p.startAt ?? p.occurrenceStart
        const end = p.endAt ?? start + (r.end_at - r.start_at)
        resultId = insert(req, { ...merged, startAt: start, endAt: end } as z.infer<typeof eventInputSchema>, r.kind, id)
      } else {
        db.run(
          `UPDATE events SET title = ?, body_html = ?, start_at = ?, end_at = ?, all_day = ?, rrule = ?, location = ?, absence_type = ?, reminders = ?, scope_type = ?, updated_at = ? WHERE id = ?`,
          [
            merged.title,
            cleanHtml(merged.bodyHtml),
            merged.startAt,
            merged.endAt,
            merged.allDay ? 1 : 0,
            merged.rrule,
            merged.location || null,
            merged.absenceType,
            JSON.stringify(merged.reminders),
            r.kind === 'absence' ? 'team' : merged.scope.type,
            Date.now(),
            id
          ]
        )
        const keep = new Map(db.all<{ member_id: string; response: string }>('SELECT member_id, response FROM event_attendees WHERE event_id = ?', [id]).map((a) => [a.member_id, a.response]))
        if (r.kind !== 'absence') applyScope(db, id, merged.scope, merged.attendeeIds, req.member)
        setAttendees(db, id, merged.attendeeIds, keep)
      }
    })
    logActivity(ctx, req, 'event.update', { type: 'event', id }, { mode: p.mode })
    notify(id, before)
    if (resultId !== id) notify(resultId)
    return ok({ id: resultId })
  })

  app.delete('/api/events/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const q = parse(z.object({ mode: z.enum(['all', 'this', 'following']).default('all'), occurrence: z.coerce.number().optional() }), req.query)
    const r = load(req, id)
    canEdit(req, r)
    const audience = audienceOf(db, 'events', 'event', id)
    if (q.mode === 'this' && r.rrule && q.occurrence !== undefined) {
      const ex = [...parseJson<number[]>(r.exdates, []), q.occurrence]
      db.run('UPDATE events SET exdates = ?, updated_at = ? WHERE id = ?', [JSON.stringify(ex), Date.now(), id])
    } else if (q.mode === 'following' && r.rrule && q.occurrence !== undefined && q.occurrence > r.start_at) {
      const rule = truncateRule(r.rrule, q.occurrence)
      if (isEmptyRule({ ...asRecurring(r), rrule: rule })) db.run('UPDATE events SET deleted_at = ? WHERE id = ?', [Date.now(), id])
      else db.run('UPDATE events SET rrule = ?, updated_at = ? WHERE id = ?', [rule, Date.now(), id])
    } else {
      db.run('UPDATE events SET deleted_at = ?, updated_at = ? WHERE id = ?', [Date.now(), Date.now(), id])
    }
    logActivity(ctx, req, 'event.delete', { type: 'event', id }, { mode: q.mode, title: r.title })
    ctx.hub.sendTo(audience, 'event.changed', { id, deleted: true })
    return ok({ id })
  })

  app.post('/api/events/:id/respond', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    const { response } = parse(z.object({ response: z.enum(['yes', 'no', 'maybe']) }), req.body)
    const res = db.run('UPDATE event_attendees SET response = ? WHERE event_id = ? AND member_id = ?', [response, id, req.member.id])
    if (!res.changes) throw badRequest('참석자로 지정된 일정이 아닙니다.')
    ctx.hub.sendTo([r.created_by, req.member.id], 'event.changed', { id })
    return ok({ id, response })
  })

  app.get('/api/holidays', auth, async (req) => {
    const { from, to } = parse(z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.query)
    return ok(db.all<{ date: string; name: string }>(`SELECT date, name FROM holidays WHERE date >= ? AND date <= ? AND source != 'deleted' ORDER BY date`, [from, to]))
  })

  const adminPre = { preHandler: [guards.requireAuth, guards.requireAdmin] }
  app.put('/api/admin/holidays/:date', adminPre, async (req) => {
    const { date } = req.params as { date: string }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('날짜 형식: 2026-01-01')
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(40) }), req.body)
    db.run(`INSERT INTO holidays (date, name, source) VALUES (?, ?, 'admin') ON CONFLICT(date) DO UPDATE SET name = excluded.name, source = 'admin'`, [date, name])
    logActivity(ctx, req, 'holiday.set', { type: 'holiday', id: date }, { name })
    ctx.hub.broadcast('event.changed', { holidays: true })
    return ok({ date, name })
  })
  app.delete('/api/admin/holidays/:date', adminPre, async (req) => {
    const { date } = req.params as { date: string }
    // Keep a tombstone so the built-in list does not bring it back on restart.
    db.run(`INSERT INTO holidays (date, name, source) VALUES (?, '', 'deleted') ON CONFLICT(date) DO UPDATE SET source = 'deleted'`, [date])
    logActivity(ctx, req, 'holiday.delete', { type: 'holiday', id: date })
    ctx.hub.broadcast('event.changed', { holidays: true })
    return ok({ date })
  })
}
