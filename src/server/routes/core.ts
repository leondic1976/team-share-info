import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION } from '../../shared/constants'
import { joinRequestInputSchema, meDeptSchema, mePatchSchema, type Hello, type JoinPoll, type MeDto } from '../../shared/schemas/auth'
import { DEPT_ENTERED_PER_DAY, DEPT_MAX_DEPTH, DEPT_SEP, cleanDeptName, deptNameError, deptPathText, matchDeptPath } from '../../shared/org'
import { ipAllowed, normalizeIp } from '../../shared/net'
import { newId } from '../../node/sqlite'
import type { ServerContext } from '../context'
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { randomKey, safeEqualHex, sha256Hex } from '../crypto'
import { parse, ok } from '../validate'
import { getSection, isInitialized, readSetting } from '../settings'
import { adminFieldsOf, ensureDeptPath, getMember, listDepartments, listMembers, toMemberDto, updateMember } from '../repos/members'
import { blockedPc, ownerMemberId } from '../repos/devices'
import { isOwnerRequest } from '../auth'
import { logActivity } from '../activity'
import { approveJoinRequest } from './admin'
import { myGroups } from '../repos/groups'
import { visibleWhere } from '../scope'

export function registerCoreRoutes(app: FastifyInstance, ctx: ServerContext, requireAuth: preHandlerAsyncHookHandler): void {
  app.get('/api/hello', async () => {
    const org = getSection(ctx.db, 'org')
    const hello: Hello = {
      name: 'TeamHub',
      orgName: org.orgName,
      teamName: org.teamName,
      noticeText: org.noticeText,
      version: ctx.version,
      protocol: PROTOCOL_VERSION,
      minProtocol: MIN_CLIENT_PROTOCOL,
      // 'seats': a join request marked sharedPc is kept apart from the other people of that PC
      // 'deptpath': multi-level affiliations (PUT /api/me/dept, deptPath in the join request)
      caps: ['idem', 'seats', 'deptpath'],
      initialized: isInitialized(ctx.db)
    }
    return ok(hello)
  })

  app.post('/api/join', async (req) => {
    const input = parse(joinRequestInputSchema, req.body)
    const ip = normalizeIp(req.ip)
    const net = getSection(ctx.db, 'network')
    if (!ipAllowed(ip, net.allowedCidrs)) throw new AppError('IP_NOT_ALLOWED', '허용되지 않은 IP 대역에서의 신청입니다.', 403)
    // a PC shut out for good cannot even ask; the admin has to take it off the list first
    if (blockedPc(ctx.db, input)) throw new AppError('PC_BLOCKED', '이 PC는 관리자가 영구 차단했습니다. 사용하려면 관리자에게 차단 해제를 요청하세요.', 403)
    const id = newId()
    const token = randomKey(24)
    const t = Date.now()
    // the affiliation as typed, top level first; an older client sends one level in deptName.
    // Nothing is created now: the levels are matched or made when the request is approved.
    const path = (input.deptPath?.length ? input.deptPath : [input.deptName]).map((n) => cleanDeptName(n).replaceAll('>', ' ').trim()).filter(Boolean).slice(0, DEPT_MAX_DEPTH)
    const deptText = path.length ? path.join(DEPT_SEP) : null
    // one PC, one open request: asking again replaces the request that is still waiting
    if (input.pcUid) ctx.db.run(`UPDATE join_requests SET state = 'rejected', decided_at = ?, decided_by = 'replaced', updated_at = ? WHERE pc_uid = ? AND state = 'pending'`, [t, t, input.pcUid])
    ctx.db.run(
      `INSERT INTO join_requests (id, poll_token_hash, name, dept_name, title, ext, pc_name, win_user, ip, app_version, state, created_at, updated_at, pc_uid, shared_pc, dept_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [id, sha256Hex(token), input.name, deptText, input.title || null, input.ext || null, input.pcName, input.winUser, ip, input.appVersion || null, t, t, input.pcUid ?? null, input.sharedPc ? 1 : 0, path.length ? JSON.stringify(path) : null]
    )
    logActivity(ctx, null, 'join.request', { type: 'join_request', id }, { name: input.name, ip, pcName: input.pcName })
    // Auto approval only inside configured ranges (3.2).
    if (net.approvalMode === 'auto-in-cidr' && net.allowedCidrs.length > 0 && ipAllowed(ip, net.allowedCidrs)) {
      approveJoinRequest(ctx, id, null)
    } else {
      const admins = listMembers(ctx.db).filter((m) => m.role === 'admin').map((m) => m.id)
      ctx.hub.sendTo(admins, 'join.requested', { id, name: input.name, deptName: deptText, pcName: input.pcName, ip })
    }
    return ok({ requestId: id, pollToken: token })
  })

  app.get('/api/join/:id', async (req) => {
    const { id } = req.params as { id: string }
    const { token } = parse(z.object({ token: z.string().min(10) }), req.query)
    const row = ctx.db.get<{ poll_token_hash: string; state: JoinPoll['state']; device_id: string | null; pending_key: string | null }>(
      'SELECT poll_token_hash, state, device_id, pending_key FROM join_requests WHERE id = ?',
      [id]
    )
    if (!row || !safeEqualHex(row.poll_token_hash, sha256Hex(token))) throw notFound('신청')
    const res: JoinPoll = { state: row.state }
    if (row.state === 'approved' && row.device_id && row.pending_key) {
      // The device key is handed over exactly once.
      res.deviceId = row.device_id
      res.deviceKey = row.pending_key
      res.memberId = ctx.db.get<{ member_id: string }>('SELECT member_id FROM devices WHERE id = ?', [row.device_id])?.member_id
      ctx.db.run('UPDATE join_requests SET pending_key = NULL, updated_at = ? WHERE id = ?', [Date.now(), id])
    }
    return ok(res)
  })

  const ledgerUnseen = (memberId: string): number => {
    const w = visibleWhere('l', 'ledger', memberId)
    return (
      ctx.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ledgers l LEFT JOIN ledger_seen s ON s.ledger_id = l.id AND s.member_id = ?
         WHERE l.deleted_at IS NULL AND (l.updated_by IS NULL OR l.updated_by <> ?) AND l.version > COALESCE(s.version, 0) AND ${w.sql}`,
        [memberId, memberId, ...w.params]
      )?.n ?? 0
    )
  }

  app.get('/api/me', { preHandler: requireAuth }, async (req) => {
    const m = req.member
    const ops = getSection(ctx.db, 'ops')
    const me: MeDto = {
      ...toMemberDto(m, ctx.hub.presenceOf(m.id)),
      isOwner: isOwnerRequest(ctx, req),
      deviceId: req.device.id,
      groups: myGroups(ctx.db, m.id),
      disabledFeatures: ops.disabledFeatures,
      adminPinSet: !!readSetting<string>(ctx.db, 'adminPinHash'),
      // Only the count, so the menu badge and alerts work before the admin PIN is entered.
      pendingJoins: m.role === 'admin' ? (ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM join_requests WHERE state = 'pending'`)?.n ?? 0) : 0,
      canSendUrgent: m.role === 'admin' || ops.urgentSenders === 'everyone',
      ledgerUnseen: ledgerUnseen(m.id)
    }
    return ok(me)
  })

  app.patch('/api/me', { preHandler: requireAuth }, async (req) => {
    const patch: Record<string, string | null | undefined> = parse(mePatchSchema, req.body)
    // what an admin set stays: the member's own change to those details is not taken
    for (const f of adminFieldsOf(req.member)) delete patch[f]
    if (patch.nickname === '') patch.nickname = null
    if (patch.deptId && !ctx.db.get('SELECT 1 FROM departments WHERE id = ?', [patch.deptId])) throw notFound('부서')
    updateMember(ctx.db, req.member.id, patch)
    logActivity(ctx, req, 'member.update.self', { type: 'member', id: req.member.id })
    ctx.hub.broadcast('member.changed', { id: req.member.id })
    return ok(toMemberDto(getMember(ctx.db, req.member.id)!, ctx.hub.presenceOf(req.member.id), ownerMemberId(ctx.db)))
  })

  /**
   * 내 정보 → 소속: I choose where I belong, or type it level by level. Typed levels that exist are
   * matched; the others are created under the last matched one and marked as typed by me, so the
   * 최종관리자 can tidy them in 조직 관리. What the server PC set for me stays as set.
   */
  app.put('/api/me/dept', { preHandler: requireAuth }, async (req) => {
    const input = parse(meDeptSchema, req.body)
    const me = req.member
    if (adminFieldsOf(me).includes('deptId')) throw forbidden('소속은 서버 PC에서 정한 항목이라 직접 바꿀 수 없습니다. 바꾸려면 최종관리자(서버 PC)에게 요청하세요.')
    // the 최종관리자 on the server PC makes departments as in 조직 관리: no mark, no daily limit
    const byOwner = isOwnerRequest(ctx, req)
    let deptId: string | null
    let created: { id: string; name: string }[] = []
    let path: string[] = []
    if ('deptId' in input) {
      deptId = input.deptId
      if (deptId && !ctx.db.get('SELECT 1 FROM departments WHERE id = ?', [deptId])) throw notFound('부서')
    } else {
      for (const n of input.path) {
        const err = deptNameError(n)
        if (err) throw badRequest(err)
      }
      path = input.path.map(cleanDeptName)
      if (path.length > DEPT_MAX_DEPTH) throw badRequest(`소속은 ${DEPT_MAX_DEPTH}단계까지 입력할 수 있습니다.`)
      const missing = matchDeptPath(listDepartments(ctx.db), path).missing.length
      if (missing > 0 && !byOwner) {
        const since = Date.now() - 24 * 60 * 60 * 1000
        const made = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM activity_logs WHERE action = 'department.enter' AND member_id = ? AND at > ?`, [me.id, since])?.n ?? 0
        if (made + missing > DEPT_ENTERED_PER_DAY) throw badRequest(`목록에 없는 소속은 하루에 ${DEPT_ENTERED_PER_DAY}개까지 새로 입력할 수 있습니다. 목록에서 고르거나 최종관리자(서버 PC)에게 요청하세요.`)
      }
      const r = ctx.db.tx(() => ensureDeptPath(ctx.db, path, byOwner ? null : me.id))!
      deptId = r.id
      created = r.created
    }
    // in a new department I go to the end until an order is given there
    updateMember(ctx.db, me.id, { deptId, ...(deptId !== me.dept_id ? { orgSort: 0 } : {}) })
    // one entry per new department: the daily limit counts these, whatever happens to the departments later
    for (const d of created) logActivity(ctx, req, byOwner ? 'department.create' : 'department.enter', { type: 'department', id: d.id }, { name: d.name, path: deptPathText(path) })
    logActivity(ctx, req, 'member.dept.self', { type: 'member', id: me.id }, { deptId, ...(path.length ? { path: deptPathText(path), created: created.length } : {}) })
    ctx.hub.broadcast('member.changed', { id: me.id })
    return ok({ member: toMemberDto(getMember(ctx.db, me.id)!, ctx.hub.presenceOf(me.id), ownerMemberId(ctx.db)), created: created.length })
  })

  app.get('/api/members', { preHandler: requireAuth }, async () => {
    const owner = ownerMemberId(ctx.db)
    return ok(listMembers(ctx.db).map((m) => toMemberDto(m, ctx.hub.presenceOf(m.id), owner)))
  })

  /** The server clock, for deadlines that must be the same on every PC. */
  app.get('/api/time', { preHandler: requireAuth }, async () => ok({ now: Date.now() }))

  app.get('/api/org', { preHandler: requireAuth }, async () => {
    const org = getSection(ctx.db, 'org')
    return ok({ ...org, departments: listDepartments(ctx.db) })
  })
}
