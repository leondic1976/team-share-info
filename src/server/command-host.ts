/**
 * TeamHub as the host of the 긴급구조지휘대 module (command/): authentication, members, files,
 * realtime events and errors come from TeamHub; the module keeps its data in command.db next
 * to teamhub.db (the server PC stores and manages everything).
 */
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { registerCommandRoutes, type CommandServer } from '../../command/server/routes'
import type { CommandServerHost } from '../../command/server/host'
import type { ServerContext } from './context'
import { AppError } from './errors'
import { ERROR_CODES, type ErrorCode } from '../shared/constants'
import { ok } from './validate'
import { isOwnerRequest } from './auth'
import { listMembers } from './repos/members'
import { serverDeviceId } from './repos/devices'
import { deleteAttachmentsOf, linkAttachments, listAttachments, registerAttachmentOwner } from './routes/attachments'
import { logActivity } from './activity'
import { recordError } from './context'
import { addUnregistered, listUnregistered, onUnregisteredChange } from './unregistered'
import { getSection } from './settings'
import { parseJson } from '../node/sqlite'
import { expand } from '../shared/recurrence'

const pad = (n: number): string => String(n).padStart(2, '0')
/** Local calendar day of a moment (YYYY-MM-DD, as the command post's period fields). */
const dayOf = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * The days an absence occurrence covers, from `today0` (local midnight of today) at the
 * earliest. All-day events end at the next midnight (exclusive), so their last day is the day
 * before `end`; a timed one lasts to the day of its end (one ending exactly at midnight, to the
 * day before).
 */
export function absenceDays(o: { start: number; end: number }, today0: number): { fromDate: string; toDate: string } {
  return { fromDate: dayOf(Math.max(o.start, today0)), toDate: dayOf(Math.max(o.start, o.end - 1)) }
}

/**
 * Who is away by 근무현황 (the calendar's absence events, recurring ones expanded, each
 * occurrence on its own) from today through the next `days` days, with each absence's days.
 */
export function absencesAhead(ctx: ServerContext, days: number, now = Date.now()): { memberId: string; type: string; fromDate: string; toDate: string }[] {
  if (getSection(ctx.db, 'ops').disabledFeatures.includes('duty')) return []
  const d = new Date(now)
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + Math.max(1, Math.min(31, Math.floor(days)))).getTime()
  const rows = ctx.db.all<{ created_by: string; absence_type: string | null; start_at: number; end_at: number; all_day: number; rrule: string | null; exdates: string }>(
    `SELECT e.created_by, e.absence_type, e.start_at, e.end_at, e.all_day, e.rrule, e.exdates FROM events e JOIN members m ON m.id = e.created_by AND m.status = 'active'
      WHERE e.kind = 'absence' AND e.deleted_at IS NULL AND e.start_at < ? AND (e.rrule IS NOT NULL OR e.end_at > ?)`,
    [to, from]
  )
  const out: { memberId: string; type: string; fromDate: string; toDate: string }[] = []
  for (const r of rows) {
    const type = r.absence_type ?? '기타'
    for (const o of expand({ startAt: r.start_at, endAt: r.end_at, allDay: !!r.all_day, rrule: r.rrule, exdates: parseJson<number[]>(r.exdates, []) }, from, to, 100)) {
      out.push({ memberId: r.created_by, type, ...absenceDays(o, from) })
    }
  }
  return out
}

export function registerCommand(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }, opts: { memory?: boolean } = {}): CommandServer {
  const host: CommandServerHost = {
    dataDir: opts.memory ? null : ctx.dataDir,
    requireAuth: guards.requireAuth,
    user: (req) => ({ id: req.member.id, name: req.member.name, isOwner: isOwnerRequest(ctx, req) }),
    members: () => {
      const owners = new Set(host.ownerIds())
      return listMembers(ctx.db).map((m) => ({
        id: m.id,
        name: m.nickname ? `${m.name}(${m.nickname})` : m.name,
        title: m.title ?? '',
        dept: (m.dept_path?.length ? m.dept_path.join(' > ') : m.dept_name) ?? '',
        // the 서무 mark everywhere a name is shown (an admin who is not the server PC's account)
        ...(m.role === 'admin' && !owners.has(m.id) ? { mark: '서무' } : {})
      }))
    },
    // 미등록 인원 (지시 134): the one list of staff who do not use TeamHub, kept in 관리
    guests: {
      label: '미등록 인원',
      where: '관리 → 구성원·PC → 미등록 인원',
      list: () => listUnregistered(ctx.db).map((p) => ({ id: p.id, name: p.name, title: p.title, dept: p.dept, memo: p.memo, ...(p.deleted ? { gone: true } : {}), ...(p.mergedInto ? { as: p.mergedInto } : {}) })),
      add: (p, o) => {
        // the command post's 임시 인원 of before: registered as the server PC's account did it
        const r = addUnregistered(ctx.db, { name: p.name, dept: p.dept, title: p.title, memo: p.memo }, host.ownerIds()[0] ?? '', { key: o.key })
        if ('id' in r && !r.existed) {
          logActivity(ctx, null, 'unregistered.create', { type: 'unregistered', id: r.id }, { from: 'command' })
          ctx.hub.broadcast('unregistered.changed', {})
        }
        return r
      },
      onChange: (cb) => void onUnregisteredChange(ctx, cb)
    },
    ownerIds: () => {
      const id = serverDeviceId(ctx.db)
      const r = id ? ctx.db.get<{ member_id: string }>('SELECT member_id FROM devices WHERE id = ?', [id]) : undefined
      return r ? [r.member_id] : []
    },
    attachments: {
      link: (ids, ownerType, ownerId, memberId) => linkAttachments(ctx, ids, ownerType, ownerId, memberId),
      list: (ownerType, ownerId) => listAttachments(ctx.db, ownerType, ownerId),
      remove: (ownerType, ownerId) => deleteAttachmentsOf(ctx, ownerType, ownerId),
      registerOwner: (ownerType, check) => registerAttachmentOwner(ownerType, (_db, ownerId, memberId) => check(ownerId, memberId))
    },
    emit: (memberIds, event, payload) => (memberIds ? ctx.hub.sendTo(memberIds, event, payload) : ctx.hub.broadcast(event, payload)),
    fail: (status, code, message) => new AppError((code in ERROR_CODES ? code : status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST') as ErrorCode, message, status),
    ok: (data) => ok(data),
    absencesAhead: (days) => absencesAhead(ctx, days),
    log: (req, action, detail) => logActivity(ctx, req, action, null, detail),
    report: (message) => recordError(ctx, `command: ${message}`)
  }
  return registerCommandRoutes(app, host)
}
