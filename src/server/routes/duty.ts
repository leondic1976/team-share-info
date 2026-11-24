import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId, parseJson } from '../../node/sqlite'
import type { Db } from '../../node/sqlite'
import { dutyInputSchema, type DutyBoardDto, type DutyEntryDto } from '../../shared/schemas/duty'
import { expand } from '../../shared/recurrence'
import type { ServerContext } from '../context'
import { badRequest, forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { setScope } from '../scope'
import { readSetting, writeSetting } from '../settings'
import { getMember, listDepartments, listMembers } from '../repos/members'

interface AbsenceRow {
  id: string
  title: string
  start_at: number
  end_at: number
  all_day: number
  rrule: string | null
  exdates: string
  location: string | null
  absence_type: string | null
  created_by: string
  registered_by: string | null
  registered_by_name: string | null
}

const CLERKS_KEY = 'dutyClerks'
const MAX_RANGE_MS = 100 * 86400000

/** Members an admin named 대리 등록자 (once labelled 서무): they record absences for others. Gone members drop out. */
export function dutyClerks(db: Db): string[] {
  const ids = readSetting<string[]>(db, CLERKS_KEY)
  if (!Array.isArray(ids)) return []
  return ids.filter((id) => typeof id === 'string' && getMember(db, id)?.status === 'active')
}

/**
 * 근무현황. Entries are the calendar's absence events, read and written here in the shape
 * of a duty board: by member and day, and recordable for someone else by an admin or a 서무.
 */
export function registerDutyRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db

  const canManage = (req: FastifyRequest): boolean => req.member.role === 'admin' || dutyClerks(db).includes(req.member.id)
  const changed = (id: string, memberId: string): void => {
    ctx.hub.broadcast('event.changed', { id })
    ctx.hub.broadcast('presence.changed', { memberId, presence: ctx.hub.presenceOf(memberId) })
  }
  const load = (req: FastifyRequest, id: string): AbsenceRow => {
    const r = db.get<AbsenceRow>(`SELECT e.*, NULL AS registered_by_name FROM events e WHERE e.id = ? AND e.kind = 'absence' AND e.deleted_at IS NULL`, [id])
    if (!r) throw notFound('근무상황')
    if (r.created_by !== req.member.id && !canManage(req)) throw forbidden('본인이나 대리 등록자·관리자(최종관리자·서무)만 고칠 수 있습니다.')
    if (r.rrule) throw badRequest('반복되는 부재 일정입니다. 일정 화면에서 고치거나 지우세요.')
    return r
  }

  app.get('/api/duty', auth, async (req) => {
    const q = parse(z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() }), req.query)
    if (q.to <= q.from || q.to - q.from > MAX_RANGE_MS) throw badRequest('조회 기간이 올바르지 않습니다(100일까지).')
    const rows = db.all<AbsenceRow>(
      `SELECT e.*, CASE WHEN IFNULL(LENGTH(r.nickname), 0) = 0 THEN r.name ELSE r.name || char(40) || r.nickname || char(41) END AS registered_by_name FROM events e
         JOIN members m ON m.id = e.created_by AND m.status = 'active'
         LEFT JOIN members r ON r.id = e.registered_by
        WHERE e.kind = 'absence' AND e.deleted_at IS NULL AND e.start_at < ? AND (e.rrule IS NOT NULL OR e.end_at > ?)`,
      [q.to, q.from]
    )
    const entries: DutyEntryDto[] = []
    for (const r of rows) {
      const type = r.absence_type ?? '기타'
      for (const o of expand({ startAt: r.start_at, endAt: r.end_at, allDay: !!r.all_day, rrule: r.rrule, exdates: parseJson<number[]>(r.exdates, []) }, q.from, q.to, 200)) {
        entries.push({
          id: r.id,
          key: o.key,
          memberId: r.created_by,
          type,
          start: o.start,
          end: o.end,
          allDay: !!r.all_day,
          place: r.location ?? '',
          // the calendar asks for a title; an entry made here uses the type when no note was given
          note: r.title === type ? '' : r.title,
          recurring: !!r.rrule,
          registeredByName: r.registered_by && r.registered_by !== r.created_by ? r.registered_by_name : null
        })
      }
    }
    entries.sort((a, b) => a.start - b.start)
    const board: DutyBoardDto = {
      departments: listDepartments(db),
      members: listMembers(db).map((m) => ({ id: m.id, name: m.name, title: m.title, deptId: m.dept_id })),
      entries,
      clerkIds: dutyClerks(db),
      canManage: canManage(req)
    }
    return ok(board)
  })

  app.post('/api/duty', auth, async (req) => {
    const input = parse(dutyInputSchema, req.body)
    const memberId = input.memberId ?? req.member.id
    if (memberId !== req.member.id) {
      if (!canManage(req)) throw forbidden('다른 사람의 근무상황은 대리 등록자나 관리자(최종관리자·서무)만 올릴 수 있습니다.')
      if (getMember(db, memberId)?.status !== 'active') throw badRequest('없는 구성원입니다.')
    }
    const id = newId()
    const t = Date.now()
    db.tx(() => {
      db.run(
        `INSERT INTO events (id, kind, title, body_html, start_at, end_at, all_day, rrule, exdates, location, absence_type, reminders, scope_type, created_by, registered_by, created_at, updated_at)
         VALUES (?, 'absence', ?, '', ?, ?, ?, NULL, '[]', ?, ?, '[]', 'team', ?, ?, ?, ?)`,
        [id, input.note || input.type, input.startAt, input.endAt, input.allDay ? 1 : 0, input.place || null, input.type, memberId, memberId === req.member.id ? null : req.member.id, t, t]
      )
      // an absence is always for the whole team, like the ones made in the calendar
      setScope(db, 'event', id, { type: 'team', groupIds: [], memberIds: [] }, req.member)
    })
    logActivity(ctx, req, 'duty.create', { type: 'event', id }, { memberId, type: input.type })
    changed(id, memberId)
    return ok({ id })
  })

  app.patch('/api/duty/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    const input = parse(dutyInputSchema, req.body)
    // whose entry it is does not change; make a new one for another member
    db.run(`UPDATE events SET title = ?, start_at = ?, end_at = ?, all_day = ?, location = ?, absence_type = ?, updated_at = ? WHERE id = ?`, [
      input.note || input.type,
      input.startAt,
      input.endAt,
      input.allDay ? 1 : 0,
      input.place || null,
      input.type,
      Date.now(),
      id
    ])
    logActivity(ctx, req, 'duty.update', { type: 'event', id }, { memberId: r.created_by, type: input.type })
    changed(id, r.created_by)
    return ok({ id })
  })

  app.delete('/api/duty/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    db.run('UPDATE events SET deleted_at = ?, updated_at = ? WHERE id = ?', [Date.now(), Date.now(), id])
    logActivity(ctx, req, 'duty.delete', { type: 'event', id }, { memberId: r.created_by, type: r.absence_type })
    changed(id, r.created_by)
    return ok({ id })
  })

  /**
   * 대리 등록자 지정: admins (최종관리자 and 서무) choose who else may record for others.
   * Not the admin tier called 서무: these members get no admin rights.
   */
  app.put('/api/duty/clerks', auth, async (req) => {
    if (req.member.role !== 'admin') throw forbidden('최종관리자·서무만 대리 등록자를 지정할 수 있습니다.')
    const { memberIds } = parse(z.object({ memberIds: z.array(z.string()).max(50) }), req.body)
    const ids = [...new Set(memberIds)].filter((m) => getMember(db, m)?.status === 'active')
    writeSetting(db, CLERKS_KEY, ids)
    logActivity(ctx, req, 'duty.clerks', null, { count: ids.length })
    // everyone refetches the board, which carries the list and their own right
    ctx.hub.broadcast('event.changed', { duty: true })
    return ok({ clerkIds: ids })
  })
}
