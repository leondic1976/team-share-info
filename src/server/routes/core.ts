import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION } from '../../shared/constants'
import { joinRequestInputSchema, mePatchSchema, type Hello, type JoinPoll, type MeDto } from '../../shared/schemas/auth'
import { ipAllowed, normalizeIp } from '../../shared/net'
import { newId } from '../../node/sqlite'
import type { ServerContext } from '../context'
import { AppError, notFound } from '../errors'
import { randomKey, safeEqualHex, sha256Hex } from '../crypto'
import { parse, ok } from '../validate'
import { getSection, isInitialized, readSetting } from '../settings'
import { adminFieldsOf, getMember, listDepartments, listMembers, toMemberDto, updateMember } from '../repos/members'
import { blockedPc } from '../repos/devices'
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
    // one PC, one open request: asking again replaces the request that is still waiting
    if (input.pcUid) ctx.db.run(`UPDATE join_requests SET state = 'rejected', decided_at = ?, decided_by = 'replaced', updated_at = ? WHERE pc_uid = ? AND state = 'pending'`, [t, t, input.pcUid])
    ctx.db.run(
      `INSERT INTO join_requests (id, poll_token_hash, name, dept_name, title, ext, pc_name, win_user, ip, app_version, state, created_at, updated_at, pc_uid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [id, sha256Hex(token), input.name, input.deptName || null, input.title || null, input.ext || null, input.pcName, input.winUser, ip, input.appVersion || null, t, t, input.pcUid ?? null]
    )
    logActivity(ctx, null, 'join.request', { type: 'join_request', id }, { name: input.name, ip, pcName: input.pcName })
    // Auto approval only inside configured ranges (3.2).
    if (net.approvalMode === 'auto-in-cidr' && net.allowedCidrs.length > 0 && ipAllowed(ip, net.allowedCidrs)) {
      approveJoinRequest(ctx, id, null)
    } else {
      const admins = listMembers(ctx.db).filter((m) => m.role === 'admin').map((m) => m.id)
      ctx.hub.sendTo(admins, 'join.requested', { id, name: input.name, deptName: input.deptName || null, pcName: input.pcName, ip })
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
      deviceId: req.device.id,
      groups: myGroups(ctx.db, m.id),
      disabledFeatures: ops.disabledFeatures,
      adminPinSet: !!readSetting<string>(ctx.db, 'adminPinHash'),
      // Only the count, so the menu badge and alerts work before the admin PIN is entered.
      pendingJoins: m.role === 'admin' ? (ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM join_requests WHERE state = 'pending'`)?.n ?? 0) : 0,
      ledgerUnseen: ledgerUnseen(m.id)
    }
    return ok(me)
  })

  app.patch('/api/me', { preHandler: requireAuth }, async (req) => {
    const patch: Record<string, string | null | undefined> = parse(mePatchSchema, req.body)
    // what an admin set stays: the member's own change to those details is not taken
    for (const f of adminFieldsOf(req.member)) delete patch[f]
    if (patch.nickname === '') patch.nickname = null
    updateMember(ctx.db, req.member.id, patch)
    logActivity(ctx, req, 'member.update.self', { type: 'member', id: req.member.id })
    ctx.hub.broadcast('member.changed', { id: req.member.id })
    return ok(toMemberDto(getMember(ctx.db, req.member.id)!, ctx.hub.presenceOf(req.member.id)))
  })

  app.get('/api/members', { preHandler: requireAuth }, async () => {
    return ok(listMembers(ctx.db).map((m) => toMemberDto(m, ctx.hub.presenceOf(m.id))))
  })

  app.get('/api/org', { preHandler: requireAuth }, async () => {
    const org = getSection(ctx.db, 'org')
    return ok({ ...org, departments: listDepartments(ctx.db) })
  })
}
