import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { statfsSync } from 'node:fs'
import { z } from 'zod'
import { adminMemberPatchSchema, type DeviceDto, type JoinRequestDto } from '../../shared/schemas/auth'
import { settingsPatchSchema } from '../../shared/schemas/settings'
import { ipAllowed } from '../../shared/net'
import type { ServerContext } from '../context'
import { badRequest, notFound } from '../errors'
import { hashPin } from '../crypto'
import { parse, ok } from '../validate'
import { getAllSettings, getSection, patchSection, writeSetting } from '../settings'
import { countAdmins, createMember, getMember, toMemberDto, updateMember, listMembers } from '../repos/members'
import { createDevice, listDevices, setDeviceRevoked } from '../repos/devices'
import { logActivity } from '../activity'
import type { FastifyRequest } from 'fastify'

interface JoinRow {
  id: string
  name: string
  dept_name: string | null
  title: string | null
  ext: string | null
  pc_name: string
  win_user: string
  ip: string
  app_version: string | null
  state: JoinRequestDto['state']
  created_at: number
  decided_at: number | null
}

/** Approve a join request: create member + device and keep the key for one-time pickup. */
export function approveJoinRequest(ctx: ServerContext, id: string, req: FastifyRequest | null): string {
  const row = ctx.db.get<JoinRow>('SELECT * FROM join_requests WHERE id = ?', [id])
  if (!row) throw notFound('신청')
  if (row.state !== 'pending') throw badRequest('이미 처리된 신청입니다.')
  const deviceId = ctx.db.tx(() => {
    const memberId = createMember(ctx.db, { name: row.name, deptName: row.dept_name ?? '', title: row.title ?? '', ext: row.ext ?? '' })
    const dev = createDevice(ctx.db, {
      memberId,
      pcName: row.pc_name,
      winUser: row.win_user,
      ip: row.ip,
      appVersion: row.app_version,
      approvedBy: req?.member?.id ?? null
    })
    ctx.db.run(
      `UPDATE join_requests SET state = 'approved', decided_at = ?, decided_by = ?, device_id = ?, pending_key = ?, updated_at = ? WHERE id = ?`,
      [Date.now(), req?.member?.id ?? 'auto', dev.deviceId, dev.deviceKey, Date.now(), id]
    )
    return dev.deviceId
  })
  logActivity(ctx, req, req ? 'join.approve' : 'join.auto-approve', { type: 'join_request', id }, { name: row.name, ip: row.ip })
  ctx.hub.broadcast('member.changed', { joinRequestId: id })
  return deviceId
}

export function registerAdminRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  guards: { requireAuth: preHandlerAsyncHookHandler; requireAdmin: preHandlerAsyncHookHandler }
): void {
  const pre = { preHandler: [guards.requireAuth, guards.requireAdmin] }

  app.get('/api/admin/join-requests', pre, async (req) => {
    const { state } = parse(z.object({ state: z.enum(['pending', 'all']).default('pending') }), req.query)
    const rows = ctx.db.all<JoinRow>(
      `SELECT * FROM join_requests ${state === 'pending' ? "WHERE state = 'pending'" : ''} ORDER BY created_at DESC LIMIT 200`
    )
    const net = getSection(ctx.db, 'network')
    const list: JoinRequestDto[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      deptName: r.dept_name,
      title: r.title,
      ext: r.ext,
      pcName: r.pc_name,
      winUser: r.win_user,
      ip: r.ip,
      appVersion: r.app_version,
      state: r.state,
      inAllowedRange: net.allowedCidrs.length === 0 || ipAllowed(r.ip, net.allowedCidrs),
      createdAt: r.created_at,
      decidedAt: r.decided_at
    }))
    return ok(list)
  })

  app.patch('/api/admin/join-requests/:id', pre, async (req) => {
    const { id } = req.params as { id: string }
    const { action } = parse(z.object({ action: z.enum(['approve', 'reject']) }), req.body)
    if (action === 'approve') {
      approveJoinRequest(ctx, id, req)
    } else {
      const r = ctx.db.run(
        `UPDATE join_requests SET state = 'rejected', decided_at = ?, decided_by = ?, updated_at = ? WHERE id = ? AND state = 'pending'`,
        [Date.now(), req.member.id, Date.now(), id]
      )
      if (!r.changes) throw badRequest('이미 처리된 신청입니다.')
      logActivity(ctx, req, 'join.reject', { type: 'join_request', id })
      // Other admins drop the request from their list and pending count.
      ctx.hub.sendTo(listMembers(ctx.db).filter((m) => m.role === 'admin').map((m) => m.id), 'member.changed', { joinRequestId: id })
    }
    return ok({ id, action })
  })

  app.get('/api/admin/devices', pre, async () => {
    const list: DeviceDto[] = listDevices(ctx.db).map((d) => ({
      id: d.id,
      memberId: d.member_id,
      memberName: d.member_name,
      pcName: d.pc_name,
      winUser: d.win_user,
      approvedIp: d.approved_ip,
      lastIp: d.last_ip,
      ipChanged: !!d.last_ip && d.last_ip !== d.approved_ip && d.approved_ip !== '127.0.0.1',
      appVersion: d.app_version,
      approvedAt: d.approved_at,
      revokedAt: d.revoked_at,
      lastSeenAt: d.last_seen_at,
      online: ctx.hub.isDeviceOnline(d.id)
    }))
    return ok(list)
  })

  app.patch('/api/admin/devices/:id', pre, async (req) => {
    const { id } = req.params as { id: string }
    const { action } = parse(z.object({ action: z.enum(['revoke', 'restore', 'accept-ip']) }), req.body)
    if (id === req.device.id && action === 'revoke') throw badRequest('지금 사용 중인 PC는 중지할 수 없습니다.')
    if (action === 'accept-ip') {
      ctx.db.run('UPDATE devices SET approved_ip = COALESCE(last_ip, approved_ip), updated_at = ? WHERE id = ?', [Date.now(), id])
    } else {
      setDeviceRevoked(ctx.db, id, action === 'revoke')
      if (action === 'revoke') ctx.hub.kick({ deviceId: id })
    }
    logActivity(ctx, req, `device.${action}`, { type: 'device', id })
    ctx.hub.broadcast('device.changed', { id })
    return ok({ id, action })
  })

  app.get('/api/admin/members', pre, async () => {
    return ok(listMembers(ctx.db, { includeSuspended: true }).map((m) => toMemberDto(m, ctx.hub.presenceOf(m.id))))
  })

  app.patch('/api/admin/members/:id', pre, async (req) => {
    const { id } = req.params as { id: string }
    const patch = parse(adminMemberPatchSchema, req.body)
    const m = getMember(ctx.db, id)
    if (!m) throw notFound('구성원')
    const losingAdmin = m.role === 'admin' && (patch.role === 'member' || patch.status === 'suspended')
    if (losingAdmin && countAdmins(ctx.db) <= 1) throw badRequest('관리자가 최소 1명은 있어야 합니다.')
    updateMember(ctx.db, id, patch)
    if (patch.status === 'suspended') ctx.hub.kick({ memberId: id }, 'MEMBER_SUSPENDED')
    logActivity(ctx, req, 'member.update', { type: 'member', id }, patch)
    ctx.hub.broadcast('member.changed', { id })
    return ok(toMemberDto(getMember(ctx.db, id)!, ctx.hub.presenceOf(id)))
  })

  app.get('/api/admin/settings', pre, async () => ok(getAllSettings(ctx.db)))

  app.put('/api/admin/settings', pre, async (req) => {
    const patch = parse(settingsPatchSchema, req.body)
    try {
      if (patch.org) patchSection(ctx.db, 'org', patch.org)
      if (patch.network) patchSection(ctx.db, 'network', patch.network)
      if (patch.storage) patchSection(ctx.db, 'storage', patch.storage)
      if (patch.backup) patchSection(ctx.db, 'backup', patch.backup)
      if (patch.ops) patchSection(ctx.db, 'ops', patch.ops)
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : '설정 값이 올바르지 않습니다.')
    }
    if (patch.adminPin !== undefined) {
      if (patch.adminPin === '') ctx.db.run(`DELETE FROM settings WHERE key = 'adminPinHash'`)
      else writeSetting(ctx.db, 'adminPinHash', hashPin(patch.adminPin))
    }
    logActivity(ctx, req, 'settings.update', null, { sections: Object.keys(patch).filter((k) => k !== 'adminPin'), pinChanged: patch.adminPin !== undefined })
    ctx.hub.broadcast('settings.changed', { sections: Object.keys(patch) })
    ctx.onSettingsChanged?.()
    return ok(getAllSettings(ctx.db))
  })

  app.get('/api/admin/status', pre, async () => {
    let disk: { free: number; total: number } | null
    try {
      const s = statfsSync(ctx.dataDir)
      disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
    } catch {
      disk = null
    }
    return ok({
      version: ctx.version,
      startedAt: ctx.startedAt,
      dataDir: ctx.dataDir,
      connections: ctx.hub.connectionCount(),
      onlineMembers: ctx.hub.onlineMemberIds().size,
      members: listMembers(ctx.db).length,
      pendingJoins: ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM join_requests WHERE state = 'pending'`)?.n ?? 0,
      disk,
      recentErrors: ctx.recentErrors.slice(0, 20)
    })
  })

  app.get('/api/admin/activity', pre, async (req) => {
    const q = parse(z.object({ before: z.coerce.number().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }), req.query)
    const rows = ctx.db.all<{
      id: string
      at: number
      member_id: string | null
      member_name: string | null
      ip: string | null
      action: string
      target_type: string | null
      target_id: string | null
      detail: string | null
    }>(
      `SELECT a.*, m.name AS member_name FROM activity_logs a LEFT JOIN members m ON m.id = a.member_id
       WHERE (? IS NULL OR a.at < ?) ORDER BY a.at DESC LIMIT ?`,
      [q.before ?? null, q.before ?? null, q.limit]
    )
    return ok(
      rows.map((r) => ({
        id: r.id,
        at: r.at,
        memberId: r.member_id,
        memberName: r.member_name,
        ip: r.ip,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        detail: r.detail ? (JSON.parse(r.detail) as unknown) : null
      }))
    )
  })

  // Verify the admin PIN without changing anything (used by the UI before opening admin pages).
  app.post('/api/admin/pin-check', pre, async () => ok({ ok: true }))

}
