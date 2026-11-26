import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { statfsSync } from 'node:fs'
import { z } from 'zod'
import { ADMIN_SET_FIELDS, adminMemberPatchSchema, blockPcSchema, type BlockedPcDto, type DeviceDto, type JoinRequestDto } from '../../shared/schemas/auth'
import { settingsPatchSchema } from '../../shared/schemas/settings'
import { ipAllowed } from '../../shared/net'
import type { ServerContext } from '../context'
import { badRequest, notFound } from '../errors'
import { hashPin } from '../crypto'
import { parse, ok } from '../validate'
import { getAllSettings, getSection, patchSection, writeSetting } from '../settings'
import { adminFieldsOf, countAdmins, createMember, getMember, setAdminFields, toMemberDto, updateMember, listMembers } from '../repos/members'
import { blockedPc, createDevice, devicesOfPc, findPc, getDevice, listDevices, ownerMemberId, serverDeviceId, setDeviceRevoked } from '../repos/devices'
import { isOwnerRequest, makeRequireOwner, ownerOnly } from '../auth'
import { newId } from '../../node/sqlite'
import { logActivity } from '../activity'
import { usedBytes } from '../storage/blobs'
import { messageFileCleanupState, messageFileUsage } from '../message-files'
import type { FastifyRequest } from 'fastify'
import { checkBackupDir } from '../backupDir'

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
  pc_uid: string | null
  shared_pc: number
  dept_path: string | null
}

/** The affiliation of a join request, top level first (requests from before paths: the one name). */
function joinDeptPath(r: Pick<JoinRow, 'dept_name' | 'dept_path'>): string[] {
  try {
    const v = JSON.parse(r.dept_path || 'null') as unknown
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && !!x.trim())
  } catch {
    // fall through to the plain name
  }
  return r.dept_name ? [r.dept_name] : []
}

/**
 * Approve a join request: create member + device and keep the key for one-time pickup.
 * A PC that already has an account (same unique value) gets that account back with a new key;
 * its former keys stop working. No second account for one PC.
 */
export function approveJoinRequest(ctx: ServerContext, id: string, req: FastifyRequest | null): string {
  const row = ctx.db.get<JoinRow>('SELECT * FROM join_requests WHERE id = ?', [id])
  if (!row) throw notFound('신청')
  if (row.state !== 'pending') throw badRequest('이미 처리된 신청입니다.')
  if (blockedPc(ctx.db, { pcUid: row.pc_uid, pcName: row.pc_name, winUser: row.win_user })) throw badRequest('영구 차단한 PC입니다. 차단 목록에서 해제한 뒤 승인하세요.')
  let reused: string | null = null
  const replaced: string[] = []
  const suspended: string[] = []
  const deviceId = ctx.db.tx(() => {
    // (a person of a shared PC is recognised by the unique value only: see findPc)
    const known = findPc(ctx.db, { pcUid: row.pc_uid, pcName: row.pc_name, winUser: row.win_user, sharedPc: !!row.shared_pc })
    reused = known?.member.id ?? null
    if (known) {
      // the PC's former entries stop working; it continues with the new key only
      for (const d of known.devices) {
        if (d.revoked_at) continue
        setDeviceRevoked(ctx.db, d.id, true)
        replaced.push(d.id)
      }
      // accounts that existed only because this same PC had asked before (one PC shown as
      // several people) are put out of use; nothing of theirs is deleted
      for (const other of new Set(known.devices.map((d) => d.member_id))) {
        if (other === known.member.id) continue
        const m = getMember(ctx.db, other)
        if (!m || m.role === 'admin' || m.status !== 'active') continue
        const elsewhere = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM devices WHERE member_id = ? AND revoked_at IS NULL`, [other])?.n ?? 0
        if (elsewhere > 0) continue
        updateMember(ctx.db, other, { status: 'suspended' })
        suspended.push(other)
      }
    }
    const memberId = known?.member.id ?? createMember(ctx.db, { name: row.name, deptPath: joinDeptPath(row), title: row.title ?? '', ext: row.ext ?? '' })
    const dev = createDevice(ctx.db, {
      memberId,
      pcUid: row.pc_uid,
      pcName: row.pc_name,
      winUser: row.win_user,
      ip: row.ip,
      appVersion: row.app_version,
      approvedBy: req?.member?.id ?? null,
      sharedPc: !!row.shared_pc
    })
    ctx.db.run(
      `UPDATE join_requests SET state = 'approved', decided_at = ?, decided_by = ?, device_id = ?, pending_key = ?, updated_at = ? WHERE id = ?`,
      [Date.now(), req?.member?.id ?? 'auto', dev.deviceId, dev.deviceKey, Date.now(), id]
    )
    return dev.deviceId
  })
  for (const d of replaced) ctx.hub.kick({ deviceId: d })
  for (const m of suspended) ctx.hub.kick({ memberId: m }, 'MEMBER_SUSPENDED')
  logActivity(
    ctx,
    req,
    req ? 'join.approve' : 'join.auto-approve',
    { type: 'join_request', id },
    { name: row.name, ip: row.ip, ...(reused ? { sameAccount: reused, replacedDevices: replaced.length } : {}), ...(suspended.length ? { duplicatesSuspended: suspended } : {}) }
  )
  ctx.hub.broadcast('member.changed', { joinRequestId: id })
  return deviceId
}

/** The settings a 서무 may change; everything else in 조직·운영 설정 is the 최종관리자's. */
const SECRETARY_OPS_FIELDS = ['urgentSenders', 'groupCreators']

export function registerAdminRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  guards: { requireAuth: preHandlerAsyncHookHandler; requireAdmin: preHandlerAsyncHookHandler }
): void {
  const pre = { preHandler: [guards.requireAuth, guards.requireAdmin] }
  // 최종관리자 (the server PC) only; a 서무 gets 403 OWNER_ONLY
  const ownerPre = { preHandler: [guards.requireAuth, guards.requireAdmin, makeRequireOwner(ctx)] }

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
      deptPath: joinDeptPath(r),
      title: r.title,
      ext: r.ext,
      pcName: r.pc_name,
      winUser: r.win_user,
      ip: r.ip,
      appVersion: r.app_version,
      state: r.state,
      inAllowedRange: net.allowedCidrs.length === 0 || ipAllowed(r.ip, net.allowedCidrs),
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      pcUid: r.pc_uid,
      knownMember: r.state === 'pending' ? (findPc(ctx.db, { pcUid: r.pc_uid, pcName: r.pc_name, winUser: r.win_user, sharedPc: !!r.shared_pc })?.member ?? null) : null,
      sharedPc: !!r.shared_pc
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

  // ---- PCs shut out for good ----
  app.get('/api/admin/blocked-pcs', pre, async () => {
    const rows = ctx.db.all<{ id: string; pc_uid: string | null; pc_name: string; win_user: string; member_name: string | null; reason: string; by_name: string | null; created_at: number }>(
      `SELECT b.*, m.name AS by_name FROM blocked_pcs b LEFT JOIN members m ON m.id = b.blocked_by ORDER BY b.created_at DESC`
    )
    const list: BlockedPcDto[] = rows.map((r) => ({ id: r.id, pcUid: r.pc_uid, pcName: r.pc_name, winUser: r.win_user, memberName: r.member_name, reason: r.reason, blockedByName: r.by_name, createdAt: r.created_at }))
    return ok(list)
  })

  /**
   * Shut a PC out for good: its connections end, what it has asked for is refused and it cannot
   * ask again until it is taken off the list. The account and everything it wrote stay.
   */
  app.post('/api/admin/blocked-pcs', pre, async (req) => {
    const input = parse(blockPcSchema, req.body)
    let pc: { pcUid: string | null; pcName: string; winUser: string }
    let memberName: string | null = null
    if (input.deviceId) {
      const d = getDevice(ctx.db, input.deviceId)
      if (!d) throw notFound('PC')
      if (d.id === req.device.id) throw badRequest('지금 사용 중인 PC는 차단할 수 없습니다.')
      if (d.id === serverDeviceId(ctx.db)) throw badRequest('서버 PC는 차단할 수 없습니다.')
      const m = getMember(ctx.db, d.member_id)
      if (m?.role === 'admin') throw badRequest('서무의 PC는 영구 차단할 수 없습니다. 먼저 최종관리자가 서무 지정을 해제해야 합니다.')
      pc = { pcUid: d.pc_uid, pcName: d.pc_name, winUser: d.win_user }
      memberName = m?.name ?? null
    } else {
      const r = ctx.db.get<JoinRow>('SELECT * FROM join_requests WHERE id = ?', [input.requestId!])
      if (!r) throw notFound('신청')
      pc = { pcUid: r.pc_uid, pcName: r.pc_name, winUser: r.win_user }
      memberName = r.name
    }
    if (blockedPc(ctx.db, pc)) throw badRequest('이미 영구 차단한 PC입니다.')
    const id = newId()
    const t = Date.now()
    const cut: string[] = []
    ctx.db.tx(() => {
      ctx.db.run('INSERT INTO blocked_pcs (id, pc_uid, pc_name, win_user, member_name, reason, blocked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, pc.pcUid, pc.pcName, pc.winUser, memberName, input.reason, req.member.id, t])
      for (const d of devicesOfPc(ctx.db, pc)) {
        if (d.revoked_at) continue
        setDeviceRevoked(ctx.db, d.id, true)
        cut.push(d.id)
      }
      ctx.db.run(
        `UPDATE join_requests SET state = 'rejected', decided_at = ?, decided_by = ?, updated_at = ?
         WHERE state = 'pending' AND ((? IS NOT NULL AND pc_uid = ?) OR (lower(pc_name) = lower(?) AND lower(win_user) = lower(?)))`,
        [t, req.member.id, t, pc.pcUid, pc.pcUid, pc.pcName, pc.winUser]
      )
    })
    for (const d of cut) ctx.hub.kick({ deviceId: d })
    logActivity(ctx, req, 'pc.block', { type: 'pc', id }, { pcName: pc.pcName, winUser: pc.winUser, pcUid: pc.pcUid, reason: input.reason })
    ctx.hub.broadcast('member.changed', { blockedPc: id })
    return ok({ id })
  })

  /** Off the list: the PC may ask for access again, and the request can be approved. Owner only. */
  app.delete('/api/admin/blocked-pcs/:id', ownerPre, async (req) => {
    const { id } = req.params as { id: string }
    const row = ctx.db.get<{ pc_name: string; win_user: string; pc_uid: string | null }>('SELECT pc_name, win_user, pc_uid FROM blocked_pcs WHERE id = ?', [id])
    if (!row) throw notFound('차단한 PC')
    ctx.db.run('DELETE FROM blocked_pcs WHERE id = ?', [id])
    logActivity(ctx, req, 'pc.unblock', { type: 'pc', id }, { pcName: row.pc_name, winUser: row.win_user, pcUid: row.pc_uid })
    return ok({ id })
  })

  app.get('/api/admin/devices', pre, async () => {
    const server = serverDeviceId(ctx.db)
    const rows = listDevices(ctx.db)
    // 공용 PC: also the entry of the person who used the PC before the others were added
    const pcKey = (d: { pc_name: string; win_user: string }): string => `${d.pc_name.toLowerCase()}\n${d.win_user.toLowerCase()}`
    const shared = new Set(rows.filter((d) => d.shared_pc && !d.revoked_at).map(pcKey))
    const list: DeviceDto[] = rows.map((d) => ({
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
      online: ctx.hub.isDeviceOnline(d.id),
      pcUid: d.pc_uid,
      isServer: d.id === server,
      sharedPc: d.id !== server && (!!d.shared_pc || shared.has(pcKey(d)))
    }))
    return ok(list)
  })

  app.patch('/api/admin/devices/:id', pre, async (req) => {
    const { id } = req.params as { id: string }
    const { action } = parse(z.object({ action: z.enum(['revoke', 'restore', 'accept-ip']) }), req.body)
    if (id === req.device.id && action === 'revoke') throw badRequest('지금 사용 중인 PC는 차단할 수 없습니다.')
    if (action === 'revoke') {
      if (id === serverDeviceId(ctx.db)) throw badRequest('서버 PC는 차단할 수 없습니다.')
      // a 서무 does not cut off another 서무
      const target = getDevice(ctx.db, id)
      if (target && !isOwnerRequest(ctx, req) && getMember(ctx.db, target.member_id)?.role === 'admin') throw ownerOnly('서무의 PC는 최종관리자(서버 PC)만 차단할 수 있습니다.')
    }
    if (action === 'restore') {
      const d = getDevice(ctx.db, id)
      if (d && blockedPc(ctx.db, { pcUid: d.pc_uid, pcName: d.pc_name, winUser: d.win_user })) throw badRequest('영구 차단한 PC입니다. 차단 목록에서 먼저 해제하세요.')
    }
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
    const owner = ownerMemberId(ctx.db)
    return ok(listMembers(ctx.db, { includeSuspended: true }).map((m) => toMemberDto(m, ctx.hub.presenceOf(m.id), owner)))
  })

  app.patch('/api/admin/members/:id', pre, async (req) => {
    const { id } = req.params as { id: string }
    const patch = parse(adminMemberPatchSchema, req.body)
    const m = getMember(ctx.db, id)
    if (!m) throw notFound('구성원')
    const byOwner = isOwnerRequest(ctx, req)
    if (id === ownerMemberId(ctx.db)) {
      // the server PC's account stays what it is, whoever asks
      if (patch.role === 'member' || patch.status === 'suspended') throw badRequest('최종관리자(서버 PC)는 권한을 해제하거나 사용 중지할 수 없습니다.')
      if (!byOwner) throw ownerOnly('최종관리자의 정보는 최종관리자(서버 PC)만 바꿀 수 있습니다.')
    }
    if (!byOwner) {
      // the real name identifies the person: only the server PC sets (and thereby fixes) it
      if (patch.name !== undefined && patch.name !== m.name) throw ownerOnly('본명은 최종관리자(서버 PC)만 고칠 수 있습니다.')
      if (patch.role !== undefined && patch.role !== m.role) throw ownerOnly('서무 지정·해제는 최종관리자(서버 PC)만 할 수 있습니다.')
      if (patch.status !== undefined && patch.status !== m.status && m.role === 'admin') throw ownerOnly('서무의 사용 중지는 최종관리자(서버 PC)만 할 수 있습니다.')
    }
    const losingAdmin = m.role === 'admin' && (patch.role === 'member' || patch.status === 'suspended')
    if (losingAdmin && countAdmins(ctx.db) <= 1) throw badRequest('관리자가 최소 1명은 있어야 합니다.')
    updateMember(ctx.db, id, patch)
    // details set here take priority from now on: the member's own edits no longer change them
    const set = ADMIN_SET_FIELDS.filter((f) => patch[f] !== undefined)
    if (set.length) setAdminFields(ctx.db, id, [...adminFieldsOf(m), ...set])
    if (patch.status === 'suspended') ctx.hub.kick({ memberId: id }, 'MEMBER_SUSPENDED')
    logActivity(ctx, req, 'member.update', { type: 'member', id }, patch)
    ctx.hub.broadcast('member.changed', { id })
    return ok(toMemberDto(getMember(ctx.db, id)!, ctx.hub.presenceOf(id), ownerMemberId(ctx.db)))
  })

  app.get('/api/admin/settings', pre, async () => ok(getAllSettings(ctx.db)))

  app.put('/api/admin/settings', pre, async (req) => {
    const patch = onlySent(parse(settingsPatchSchema, req.body), req.body)
    if (!isOwnerRequest(ctx, req)) {
      // A 서무 may save the form, but only what a 서무 may decide can differ from what is stored
      // (an older client sends every section at once).
      const cur = getAllSettings(ctx.db)
      const differs = (stored: object, sent: object | undefined, open: string[] = []): boolean =>
        !!sent && Object.entries(sent).some(([k, v]) => v !== undefined && !open.includes(k) && JSON.stringify(v) !== JSON.stringify((stored as Record<string, unknown>)[k]))
      if (
        patch.adminPin !== undefined ||
        differs(cur.org, patch.org) ||
        differs(cur.network, patch.network) ||
        differs(cur.storage, patch.storage) ||
        differs(cur.backup, patch.backup) ||
        differs(cur.ops, patch.ops, SECRETARY_OPS_FIELDS)
      ) {
        throw ownerOnly('조직 정보·네트워크·저장 공간·백업·사용할 기능·관리 PIN 등 중요 설정은 최종관리자(서버 PC)만 바꿀 수 있습니다.')
      }
    }
    // a new backup folder is tried before it is kept (every later backup would fail in a bad one)
    if (patch.backup?.dir !== undefined && patch.backup.dir.trim() !== getAllSettings(ctx.db).backup.dir) {
      const bad = await checkBackupDir(patch.backup.dir, ctx.dataDir)
      if (bad) throw badRequest(`백업 위치: ${bad}`)
    }
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
      storageUsed: usedBytes(ctx),
      // 메신저 파일 보관 기간: what conversation files take now and what the last cleanup did
      messageFiles: { ...messageFileUsage(ctx), cleanup: messageFileCleanupState(ctx) },
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

/**
 * Zod 4 fills in the defaults of the fields of a `.partial()` section that were not sent, so
 * `{ ops: { urgentSenders } }` came out as the whole ops section with default values: it would
 * overwrite what is stored, and a 서무's save of the open fields was refused whenever the stored
 * values were not the defaults. Keep only the fields that were really in the request.
 */
export function onlySent<T extends Record<string, unknown>>(patch: T, body: unknown): T {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [section, value] of Object.entries(patch)) {
    if (!(section in raw)) continue
    const sent = raw[section]
    if (value && typeof value === 'object' && !Array.isArray(value) && sent && typeof sent === 'object') {
      out[section] = Object.fromEntries(Object.entries(value).filter(([k]) => k in (sent as Record<string, unknown>)))
    } else out[section] = value
  }
  return out as T
}
