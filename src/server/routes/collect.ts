import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { newId } from '../../node/sqlite'
import type { Db } from '../../node/sqlite'
import { zipSize, zipStream, ZipTooLargeError, type ZipEntry } from '../../node/zip'
import {
  collectCreateSchema,
  collectCsvName,
  collectCsvRows,
  collectNaSchema,
  collectPatchSchema,
  collectSubmitSchema,
  collectZipName,
  canWithdraw,
  countStatuses,
  dueReminder,
  isAccepting,
  statusOf,
  uniqueNames,
  zipEntryName,
  type CollectChangedPayload,
  type CollectDto,
  type CollectFileDto,
  type CollectStatus,
  type CollectStatusDto,
  type CollectStatusRow,
  type CollectSummaryDto
} from '../../shared/schemas/collect'
import { toCsv } from '../../shared/csv'
import type { ServerContext } from '../context'
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { getSection } from '../settings'
import { audienceOf, canSee, scopeDto, setScope, visibleWhere } from '../scope'
import { ownerMemberId } from '../repos/devices'
import { listMembers } from '../repos/members'
import { addRef, blobAbsPath, contentDisposition, type BlobRow } from '../storage/blobs'
import { deleteAttachmentsOf, linkAttachments, listAttachments, registerAttachmentOwner } from './attachments'

/**
 * 자료 취합 (지시 127). The people asked are the audience of the request's scope minus the
 * requester. Only the requester and the 최종관리자 see what others handed in; a target sees
 * only their own. Items the viewer cannot see answer 404 (13.9).
 */

const ITEM = 'collect'
const TABLE = 'collect_requests'
const SUB_FILES = 'collect_sub'

interface RequestRow {
  id: string
  title: string
  description: string
  deadline_at: number
  deadline_set_at: number
  allow_late: number
  submit_mode: 'file' | 'text' | 'both'
  scope_type: string
  closed_at: number | null
  created_by: string
  created_at: number
  updated_at: number
  deleted_at: number | null
  author_name: string
}

interface SubRow {
  id: string
  request_id: string
  member_id: string
  kind: 'submitted' | 'na'
  body: string
  submitted_at: number
}

const AUTHOR = `CASE WHEN IFNULL(LENGTH(m.nickname), 0) = 0 THEN m.name ELSE m.name || char(40) || m.nickname || char(41) END`
const SELECT = `SELECT r.*, ${AUTHOR} AS author_name FROM collect_requests r JOIN members m ON m.id = r.created_by`

const state = (r: RequestRow): { deadlineAt: number; allowLate: boolean; closedAt: number | null; deadlineSetAt: number } => ({
  deadlineAt: r.deadline_at,
  allowLate: !!r.allow_late,
  closedAt: r.closed_at,
  deadlineSetAt: r.deadline_set_at
})

/** The 최종관리자 (the server PC's account) oversees every request it can see. */
const isOverseer = (db: Db, memberId: string): boolean => !!memberId && memberId === ownerMemberId(db)
const canManage = (db: Db, r: Pick<RequestRow, 'created_by'>, memberId: string): boolean => r.created_by === memberId || isOverseer(db, memberId)

/** The people asked: everyone the scope reaches except the requester. */
export function targetsOf(db: Db, r: Pick<RequestRow, 'id' | 'created_by'>): Set<string> {
  const ids = audienceOf(db, TABLE, ITEM, r.id)
  ids.delete(r.created_by)
  return ids
}

function submissionsOf(db: Db, requestId: string): Map<string, SubRow> {
  return new Map(db.all<SubRow>('SELECT * FROM collect_submissions WHERE request_id = ?', [requestId]).map((s) => [s.member_id, s]))
}

const subStatus = (s: SubRow | undefined, r: RequestRow): CollectStatus => statusOf(s ? { kind: s.kind, submittedAt: s.submitted_at } : null, r.deadline_at)

function filesOf(db: Db, subId: string): CollectFileDto[] {
  return listAttachments(db, SUB_FILES, subId)
}

/** Every row of the 제출 현황: the people asked (in the order of the organisation) and anyone who handed in and left the scope since. */
function statusRows(ctx: ServerContext, r: RequestRow): CollectStatusRow[] {
  const db = ctx.db
  const targets = targetsOf(db, r)
  const subs = submissionsOf(db, r.id)
  const online = ctx.hub.onlineMemberIds()
  const rows: CollectStatusRow[] = []
  for (const m of listMembers(db, { includeSuspended: true })) {
    const s = subs.get(m.id)
    if (!targets.has(m.id) && !s) continue
    rows.push({
      memberId: m.id,
      name: m.name,
      deptName: m.dept_name ?? '',
      deptPath: m.dept_path ?? [],
      title: m.title ?? '',
      status: subStatus(s, r),
      submittedAt: s?.submitted_at ?? null,
      text: s?.kind === 'submitted' ? s.body : '',
      reason: s?.kind === 'na' ? s.body : '',
      files: s?.kind === 'submitted' ? filesOf(db, s.id) : [],
      online: online.has(m.id)
    })
  }
  return rows
}

function countsOf(db: Db, r: RequestRow): CollectStatusDto['counts'] {
  const targets = targetsOf(db, r)
  const subs = submissionsOf(db, r.id)
  const ids = new Set([...targets, ...subs.keys()])
  return countStatuses([...ids].map((id) => subStatus(subs.get(id), r)))
}

function toSummary(ctx: ServerContext, r: RequestRow, meId: string): CollectSummaryDto {
  const db = ctx.db
  const manage = canManage(db, r, meId)
  const isTarget = r.created_by !== meId
  const mine = isTarget ? db.get<SubRow>('SELECT * FROM collect_submissions WHERE request_id = ? AND member_id = ?', [r.id, meId]) : undefined
  return {
    id: r.id,
    title: r.title,
    deadlineAt: r.deadline_at,
    allowLate: !!r.allow_late,
    submitMode: r.submit_mode,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    authorId: r.created_by,
    authorName: r.author_name,
    scope: scopeDto(db, ITEM, r.id, r.scope_type),
    canManage: manage,
    isTarget,
    myStatus: isTarget ? subStatus(mine, r) : null,
    mySubmittedAt: mine?.submitted_at ?? null,
    counts: manage ? countsOf(db, r) : null,
    formCount: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM attachments WHERE owner_type = 'collect' AND owner_id = ?`, [r.id])?.n ?? 0
  }
}

/** Remove one attachment and give its stored file's reference back. */
function dropAttachment(ctx: ServerContext, id: string): void {
  const a = ctx.db.get<{ blob_id: string | null }>('SELECT blob_id FROM attachments WHERE id = ?', [id])
  if (!a) return
  if (a.blob_id) addRef(ctx, a.blob_id, -1)
  ctx.db.run('DELETE FROM attachments WHERE id = ?', [id])
}

/**
 * Make the attachments of an owner exactly `ids`: its own ones listed stay, the others go,
 * my pending uploads listed are linked. Returns how many it has afterwards.
 */
function setAttachments(ctx: ServerContext, ownerType: string, ownerId: string, ids: string[], memberId: string, dryRun = false): number {
  const want = new Set(ids)
  const own = ctx.db.all<{ id: string }>('SELECT id FROM attachments WHERE owner_type = ? AND owner_id = ?', [ownerType, ownerId]).map((a) => a.id)
  const kept = own.filter((id) => want.has(id))
  const pending = [...want].filter((id) => !own.includes(id) && ctx.db.get(`SELECT 1 FROM attachments WHERE id = ? AND owner_type = 'pending' AND created_by = ?`, [id, memberId]))
  if (!dryRun) {
    for (const id of own) if (!want.has(id)) dropAttachment(ctx, id)
    linkAttachments(ctx, pending, ownerType, ownerId, memberId)
  }
  return kept.length + pending.length
}

/** Who hears about a change of the request: the people asked, the requester, the 최종관리자 and whoever handed in. */
function everyoneOf(db: Db, r: RequestRow): Set<string> {
  const ids = audienceOf(db, TABLE, ITEM, r.id)
  ids.add(r.created_by)
  const owner = ownerMemberId(db)
  if (owner && canSee(db, TABLE, ITEM, r.id, owner)) ids.add(owner)
  for (const id of submissionsOf(db, r.id).keys()) ids.add(id)
  return ids
}

/**
 * Alert the people asked who have not handed in (new request, 다시 알림, automatic reminder).
 * Who is offline gets the card when the PC connects next (`/api/collects/pending`).
 */
function alertTargets(ctx: ServerContext, r: RequestRow, who: string[], extra: Partial<CollectChangedPayload>): { count: number; online: number } {
  const db = ctx.db
  const online = ctx.hub.onlineMemberIds()
  const now = Date.now()
  const on = who.filter((m) => online.has(m))
  const payload: CollectChangedPayload = { id: r.id, title: r.title, deadlineAt: r.deadline_at, byId: r.created_by, byName: r.author_name, ...extra }
  ctx.hub.sendTo(on, 'collect.changed', payload)
  for (const m of who) {
    if (online.has(m)) db.run('INSERT INTO collect_notified (request_id, member_id, at) VALUES (?, ?, ?) ON CONFLICT(request_id, member_id) DO UPDATE SET at = excluded.at', [r.id, m, now])
    else db.run('DELETE FROM collect_notified WHERE request_id = ? AND member_id = ?', [r.id, m])
  }
  return { count: who.length, online: on.length }
}

function notSubmitted(db: Db, r: RequestRow): string[] {
  const subs = submissionsOf(db, r.id)
  return [...targetsOf(db, r)].filter((m) => !subs.has(m))
}

/**
 * Automatic reminders (one day and one hour before the deadline) to those who have not handed
 * in. Each is sent once per request and deadline: the row in collect_reminders is written
 * first (INSERT OR IGNORE), so a restart or a second run never sends it twice.
 */
export function runCollectJobs(ctx: ServerContext, now = Date.now()): number {
  const db = ctx.db
  if (getSection(db, 'ops').disabledFeatures.includes('collect')) return 0
  let sent = 0
  const open = db.all<RequestRow>(`${SELECT} WHERE r.deleted_at IS NULL AND r.closed_at IS NULL AND r.deadline_at > ? AND r.deadline_at <= ?`, [now, now + 25 * 3600_000])
  for (const r of open) {
    const kind = dueReminder(state(r), now)
    if (!kind) continue
    const ins = db.run('INSERT OR IGNORE INTO collect_reminders (request_id, kind, deadline_at, sent_at, sent_count) VALUES (?, ?, ?, ?, 0)', [r.id, kind, r.deadline_at, now])
    if (!ins.changes) continue
    const who = notSubmitted(db, r)
    const res = alertTargets(ctx, r, who, { remind: kind })
    db.run('UPDATE collect_reminders SET sent_count = ? WHERE request_id = ? AND kind = ? AND deadline_at = ?', [res.count, r.id, kind, r.deadline_at])
    if (res.count) sent++
  }
  return sent
}

export function registerCollectRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db

  // 양식 files: whoever can see the request; handed-in files: the one who handed in, the requester, the 최종관리자
  registerAttachmentOwner('collect', (d, id, m) => !!d.get(`SELECT 1 FROM collect_requests WHERE id = ? AND deleted_at IS NULL`, [id]) && canSee(d, TABLE, ITEM, id, m))
  registerAttachmentOwner(SUB_FILES, (d, subId, m) => {
    const s = d.get<{ member_id: string; request_id: string; created_by: string }>(
      `SELECT s.member_id, s.request_id, r.created_by FROM collect_submissions s JOIN collect_requests r ON r.id = s.request_id WHERE s.id = ? AND r.deleted_at IS NULL`,
      [subId]
    )
    if (!s) return false
    if (s.member_id === m || s.created_by === m) return true
    return isOverseer(d, m) && canSee(d, TABLE, ITEM, s.request_id, m)
  })

  const load = (req: FastifyRequest, id: string): RequestRow => {
    const r = db.get<RequestRow>(`${SELECT} WHERE r.id = ? AND r.deleted_at IS NULL`, [id])
    if (!r || !canSee(db, TABLE, ITEM, id, req.member.id)) throw notFound('자료 취합 요청')
    return r
  }
  const manage = (req: FastifyRequest, r: RequestRow): void => {
    if (!canManage(db, r, req.member.id)) throw forbidden('요청한 사람만 할 수 있습니다.')
  }
  const asTarget = (req: FastifyRequest, r: RequestRow): void => {
    if (r.created_by === req.member.id) throw forbidden('요청한 사람은 제출하지 않습니다.')
  }
  const canCreate = (req: FastifyRequest): boolean => req.member.role === 'admin' || getSection(db, 'ops').collectCreators === 'everyone'
  const changed = (r: RequestRow, extra: Partial<CollectChangedPayload> = {}): void => ctx.hub.sendTo(everyoneOf(db, r), 'collect.changed', { id: r.id, ...extra })
  /** after a submission changed: the requester, the 최종관리자 and the person themself */
  const subChanged = (r: RequestRow, memberId: string): void => {
    const to = new Set([r.created_by, memberId])
    const owner = ownerMemberId(db)
    if (owner && canSee(db, TABLE, ITEM, r.id, owner)) to.add(owner)
    ctx.hub.sendTo(to, 'collect.changed', { id: r.id })
  }

  app.get('/api/collects', auth, async (req) => {
    const w = visibleWhere('r', ITEM, req.member.id)
    const rows = db.all<RequestRow>(`${SELECT} WHERE r.deleted_at IS NULL AND ${w.sql} ORDER BY r.created_at DESC LIMIT 300`, w.params)
    return ok(rows.map((r) => toSummary(ctx, r, req.member.id)))
  })

  /** The menu count (requests waiting for me) and whether I may ask for one. */
  app.get('/api/collects/summary', auth, async (req) => {
    const w = visibleWhere('r', ITEM, req.member.id)
    const now = Date.now()
    const rows = db.all<RequestRow>(
      `${SELECT} WHERE r.deleted_at IS NULL AND r.closed_at IS NULL AND r.created_by <> ? AND ${w.sql}
         AND NOT EXISTS (SELECT 1 FROM collect_submissions s WHERE s.request_id = r.id AND s.member_id = ?)`,
      [req.member.id, ...w.params, req.member.id]
    )
    return ok({ todo: rows.filter((r) => isAccepting(state(r), now)).length, canCreate: canCreate(req) })
  })

  /** Called after (re)connecting: requests for me whose alert card has not reached this person yet. */
  app.get('/api/collects/pending', auth, async (req) => {
    const w = visibleWhere('r', ITEM, req.member.id)
    const now = Date.now()
    const rows = db.all<RequestRow>(
      `${SELECT} WHERE r.deleted_at IS NULL AND r.closed_at IS NULL AND r.created_by <> ? AND ${w.sql}
         AND NOT EXISTS (SELECT 1 FROM collect_submissions s WHERE s.request_id = r.id AND s.member_id = ?)
         AND NOT EXISTS (SELECT 1 FROM collect_notified n WHERE n.request_id = r.id AND n.member_id = ?)
       ORDER BY r.created_at`,
      [req.member.id, ...w.params, req.member.id, req.member.id]
    ).filter((r) => isAccepting(state(r), now))
    for (const r of rows) db.run('INSERT OR IGNORE INTO collect_notified (request_id, member_id, at) VALUES (?, ?, ?)', [r.id, req.member.id, now])
    return ok(rows.map((r): CollectChangedPayload => ({ id: r.id, title: r.title, deadlineAt: r.deadline_at, byId: r.created_by, byName: r.author_name, created: true })))
  })

  app.post('/api/collects', auth, async (req) => {
    if (!canCreate(req)) throw forbidden('최종관리자·서무만 자료 취합을 요청할 수 있습니다.')
    const input = parse(collectCreateSchema, req.body)
    const now = Date.now()
    if (input.deadlineAt <= now) throw badRequest('마감 일시는 지금보다 뒤로 정하세요.')
    const id = newId()
    const r = db.tx(() => {
      db.run(
        `INSERT INTO collect_requests (id, title, description, deadline_at, deadline_set_at, allow_late, submit_mode, scope_type, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.title, input.description, input.deadlineAt, now, input.allowLate ? 1 : 0, input.submitMode, input.scope.type, req.member.id, now, now]
      )
      setScope(db, ITEM, id, input.scope, req.member)
      if (!targetsOf(db, { id, created_by: req.member.id }).size) throw badRequest('요청할 사람이 없습니다. 대상을 다시 고르세요.')
      linkAttachments(ctx, input.attachmentIds, 'collect', id, req.member.id)
      return db.get<RequestRow>(`${SELECT} WHERE r.id = ?`, [id])!
    })
    logActivity(ctx, req, 'collect.create', { type: ITEM, id }, { title: input.title, deadlineAt: input.deadlineAt })
    const res = alertTargets(ctx, r, [...targetsOf(db, r)], { created: true })
    ctx.hub.sendTo([req.member.id], 'collect.changed', { id })
    return ok({ id, targets: res.count })
  })

  app.get('/api/collects/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    const mine = r.created_by !== req.member.id ? db.get<SubRow>('SELECT * FROM collect_submissions WHERE request_id = ? AND member_id = ?', [id, req.member.id]) : undefined
    const dto: CollectDto = {
      ...toSummary(ctx, r, req.member.id),
      description: r.description,
      forms: listAttachments(db, 'collect', id),
      mine: mine
        ? {
            status: subStatus(mine, r),
            submittedAt: mine.submitted_at,
            text: mine.kind === 'submitted' ? mine.body : '',
            reason: mine.kind === 'na' ? mine.body : '',
            files: mine.kind === 'submitted' ? filesOf(db, mine.id) : []
          }
        : null
    }
    return ok(dto)
  })

  app.patch('/api/collects/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    manage(req, r)
    const p = parse(collectPatchSchema, req.body)
    const now = Date.now()
    const deadlineMoved = p.deadlineAt !== undefined && p.deadlineAt !== r.deadline_at
    if (deadlineMoved && p.deadlineAt! <= now) throw badRequest('마감 일시는 지금보다 뒤로 정하세요.')
    db.tx(() => {
      db.run(
        `UPDATE collect_requests SET title = ?, description = ?, deadline_at = ?, deadline_set_at = ?, allow_late = ?, updated_at = ? WHERE id = ?`,
        [
          p.title ?? r.title,
          p.description ?? r.description,
          p.deadlineAt ?? r.deadline_at,
          deadlineMoved ? now : r.deadline_set_at,
          p.allowLate === undefined ? r.allow_late : p.allowLate ? 1 : 0,
          now,
          id
        ]
      )
      if (p.attachmentIds) setAttachments(ctx, 'collect', id, p.attachmentIds, req.member.id)
    })
    logActivity(ctx, req, 'collect.update', { type: ITEM, id }, deadlineMoved ? { deadlineAt: p.deadlineAt } : undefined)
    changed(r)
    return ok({ id })
  })

  /** 일찍 마감: no more submissions from now on. */
  app.post('/api/collects/:id/close', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    manage(req, r)
    db.run('UPDATE collect_requests SET closed_at = COALESCE(closed_at, ?), updated_at = ? WHERE id = ?', [Date.now(), Date.now(), id])
    logActivity(ctx, req, 'collect.close', { type: ITEM, id })
    changed(r)
    return ok({ id })
  })

  app.delete('/api/collects/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    manage(req, r)
    const to = everyoneOf(db, r)
    db.tx(() => {
      db.run('UPDATE collect_requests SET deleted_at = ?, updated_at = ? WHERE id = ?', [Date.now(), Date.now(), id])
      deleteAttachmentsOf(ctx, 'collect', id)
      for (const s of submissionsOf(db, id).values()) deleteAttachmentsOf(ctx, SUB_FILES, s.id)
    })
    logActivity(ctx, req, 'collect.delete', { type: ITEM, id }, { title: r.title })
    ctx.hub.sendTo(to, 'collect.changed', { id, deleted: true })
    return ok({ id })
  })

  app.get('/api/collects/:id/status', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    manage(req, r)
    const rows = statusRows(ctx, r)
    const dto: CollectStatusDto = { counts: countStatuses(rows.map((x) => x.status)), rows }
    return ok(dto)
  })

  /** 미제출자에게 다시 알림 */
  app.post('/api/collects/:id/remind', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    manage(req, r)
    if (!isAccepting(state(r), Date.now())) throw conflict('마감되어 더 받지 않는 요청입니다.')
    const res = alertTargets(ctx, r, notSubmitted(db, r), { remind: 'manual' })
    logActivity(ctx, req, 'collect.remind', { type: ITEM, id }, { count: res.count })
    return ok(res)
  })

  app.get('/api/collects/:id/csv', auth, async (req, reply) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    manage(req, r)
    const csv = toCsv(collectCsvRows(statusRows(ctx, r)))
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', contentDisposition(collectCsvName(r.title, Date.now())))
      .send(csv)
  })

  /** 한꺼번에 내려받기: every handed-in file as `<부서>_<이름>_<파일>`, text answers, and the 제출 현황 as CSV. */
  app.get('/api/collects/:id/zip', auth, async (req, reply) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    manage(req, r)
    const rows = statusRows(ctx, r)
    const parts: (Omit<ZipEntry, 'size'> & { size: number })[] = []
    for (const row of rows) {
      if (row.status !== 'submitted' && row.status !== 'late') continue
      for (const f of row.files) {
        const a = db.get<{ blob_id: string | null; created_at: number }>('SELECT blob_id, created_at FROM attachments WHERE id = ?', [f.id])
        const blob = a?.blob_id ? db.get<BlobRow>('SELECT * FROM blobs WHERE id = ?', [a.blob_id]) : undefined
        if (!blob || !existsSync(blobAbsPath(ctx, blob))) continue
        parts.push({ name: zipEntryName(row.deptName, row.name, f.name), path: blobAbsPath(ctx, blob), size: blob.size, mtime: new Date(row.submittedAt ?? a!.created_at) })
      }
      if (row.text.trim()) {
        const data = Buffer.from('﻿' + row.text.replace(/\r?\n/g, '\r\n'), 'utf8')
        parts.push({ name: zipEntryName(row.deptName, row.name, '제출내용.txt'), data, size: data.length, mtime: new Date(row.submittedAt ?? Date.now()) })
      }
    }
    const csv = Buffer.from(toCsv(collectCsvRows(rows)), 'utf8')
    parts.push({ name: '제출현황.csv', data: csv, size: csv.length })
    const names = uniqueNames(parts.map((p) => p.name))
    const entries = parts.map((p, i) => ({ ...p, name: names[i] }))
    let length: number
    try {
      length = zipSize(entries)
    } catch (e) {
      if (e instanceof ZipTooLargeError) throw new AppError('FILE_TOO_LARGE', `${e.message} 파일을 나누어 내려받으세요.`, 413)
      throw e
    }
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Length', String(length))
      .header('Content-Disposition', contentDisposition(collectZipName(r.title, Date.now())))
      .send(Readable.from(zipStream(entries)))
  })

  /** Hand in, or replace what I handed in. */
  app.put('/api/collects/:id/submission', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    asTarget(req, r)
    const now = Date.now()
    if (!isAccepting(state(r), now)) throw conflict(r.closed_at ? '요청한 사람이 마감해서 더 받지 않습니다.' : '마감이 지나 제출할 수 없습니다.')
    const input = parse(collectSubmitSchema, req.body)
    const text = input.text.trim() ? input.text : ''
    const prev = db.get<SubRow>('SELECT * FROM collect_submissions WHERE request_id = ? AND member_id = ?', [id, req.member.id])
    const subId = prev?.id ?? newId()
    const fileCount = setAttachments(ctx, SUB_FILES, subId, input.attachmentIds, req.member.id, true)
    if (r.submit_mode === 'file' && !fileCount) throw badRequest('제출할 파일을 올리세요.')
    if (r.submit_mode === 'text' && !text) throw badRequest('제출할 내용을 적으세요.')
    if (r.submit_mode === 'both' && !text && !fileCount) throw badRequest('파일을 올리거나 내용을 적으세요.')
    if (r.submit_mode === 'text' && fileCount) throw badRequest('이 요청은 글로만 받습니다.')
    if (r.submit_mode === 'file' && text) throw badRequest('이 요청은 파일로만 받습니다.')
    db.tx(() => {
      if (prev) db.run(`UPDATE collect_submissions SET kind = 'submitted', body = ?, submitted_at = ?, updated_at = ? WHERE id = ?`, [text, now, now, subId])
      else
        db.run(`INSERT INTO collect_submissions (id, request_id, member_id, kind, body, submitted_at, created_at, updated_at) VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?)`, [subId, id, req.member.id, text, now, now, now])
      setAttachments(ctx, SUB_FILES, subId, input.attachmentIds, req.member.id)
    })
    logActivity(ctx, req, prev ? 'collect.resubmit' : 'collect.submit', { type: ITEM, id }, { files: fileCount, late: now > r.deadline_at })
    subChanged(r, req.member.id)
    return ok({ id, status: statusOf({ kind: 'submitted', submittedAt: now }, r.deadline_at) })
  })

  /** 해당 없음 (with an optional reason): replaces anything handed in. */
  app.post('/api/collects/:id/na', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    asTarget(req, r)
    const now = Date.now()
    if (!isAccepting(state(r), now)) throw conflict(r.closed_at ? '요청한 사람이 마감해서 더 받지 않습니다.' : '마감이 지나 바꿀 수 없습니다.')
    const { reason } = parse(collectNaSchema, req.body ?? {})
    const prev = db.get<SubRow>('SELECT * FROM collect_submissions WHERE request_id = ? AND member_id = ?', [id, req.member.id])
    db.tx(() => {
      if (prev) {
        deleteAttachmentsOf(ctx, SUB_FILES, prev.id)
        db.run(`UPDATE collect_submissions SET kind = 'na', body = ?, submitted_at = ?, updated_at = ? WHERE id = ?`, [reason, now, now, prev.id])
      } else
        db.run(`INSERT INTO collect_submissions (id, request_id, member_id, kind, body, submitted_at, created_at, updated_at) VALUES (?, ?, ?, 'na', ?, ?, ?, ?)`, [newId(), id, req.member.id, reason, now, now, now])
    })
    logActivity(ctx, req, 'collect.na', { type: ITEM, id })
    subChanged(r, req.member.id)
    return ok({ id, status: 'na' as const })
  })

  /** Take back what I handed in (or 해당 없음), before the deadline. */
  app.delete('/api/collects/:id/submission', auth, async (req) => {
    const { id } = req.params as { id: string }
    const r = load(req, id)
    asTarget(req, r)
    if (!canWithdraw(state(r), Date.now())) throw conflict('마감이 지나 되돌릴 수 없습니다.')
    const prev = db.get<SubRow>('SELECT * FROM collect_submissions WHERE request_id = ? AND member_id = ?', [id, req.member.id])
    if (!prev) throw notFound('제출한 자료')
    db.tx(() => {
      deleteAttachmentsOf(ctx, SUB_FILES, prev.id)
      db.run('DELETE FROM collect_submissions WHERE id = ?', [prev.id])
    })
    logActivity(ctx, req, 'collect.withdraw', { type: ITEM, id })
    subChanged(r, req.member.id)
    return ok({ id, status: 'none' as const })
  })
}
