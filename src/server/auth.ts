import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { MIN_CLIENT_PROTOCOL, PC_UID_RE } from '../shared/constants'
import { ipAllowed, normalizeIp } from '../shared/net'
import type { ServerContext } from './context'
import { AppError } from './errors'
import { safeEqualHex, sha256Hex, verifyPin } from './crypto'
import { getDevice, learnPcUid, serverDeviceId, touchDevice, type DeviceRow } from './repos/devices'
import { getMember, type MemberRow } from './repos/members'
import { getSection, readSetting } from './settings'
import { replayIdempotent } from './idempotency'

declare module 'fastify' {
  interface FastifyRequest {
    member: MemberRow
    device: DeviceRow
    clientIp: string
    /** X-Protocol of the calling program (undefined: it did not say, e.g. very old builds) */
    clientProtocol?: number
  }
}

export interface Credentials {
  deviceId: string
  deviceKey: string
  winUser: string
  ip: string
  protocol?: number
  appVersion?: string
}

/** Validate a device credential; shared by HTTP (Authorization header) and WebSocket hello. */
export function authenticate(ctx: ServerContext, c: Credentials): { member: MemberRow; device: DeviceRow } {
  if (c.protocol !== undefined && c.protocol < MIN_CLIENT_PROTOCOL) {
    throw new AppError('UPDATE_REQUIRED', '프로그램 업데이트가 필요합니다.', 426)
  }
  const device = c.deviceId ? getDevice(ctx.db, c.deviceId) : undefined
  if (!device || !safeEqualHex(device.key_hash, sha256Hex(c.deviceKey))) {
    throw new AppError('UNAUTHORIZED', '승인되지 않은 PC입니다.', 401)
  }
  if (device.revoked_at) throw new AppError('DEVICE_REVOKED', '사용이 중지된 PC입니다. 관리자에게 문의하세요.', 403)
  if (device.win_user.toLowerCase() !== c.winUser.toLowerCase()) {
    throw new AppError('UNAUTHORIZED', 'Windows 계정이 승인 당시와 다릅니다.', 401)
  }
  const ip = normalizeIp(c.ip)
  const net = getSection(ctx.db, 'network')
  if (!ipAllowed(ip, net.allowedCidrs)) throw new AppError('IP_NOT_ALLOWED', '허용되지 않은 IP 대역입니다.', 403)
  if (net.reapproveOnIpChange && ip !== device.approved_ip && device.approved_ip !== '127.0.0.1') {
    throw new AppError('DEVICE_REVOKED', 'IP가 바뀌어 다시 승인이 필요합니다.', 403)
  }
  const member = getMember(ctx.db, device.member_id)
  if (!member) throw new AppError('UNAUTHORIZED', '구성원을 찾을 수 없습니다.', 401)
  if (member.status !== 'active') throw new AppError('MEMBER_SUSPENDED', '사용이 중지된 구성원입니다.', 403)
  if (device.last_ip !== ip || c.appVersion) touchDevice(ctx.db, device.id, ip, c.appVersion)
  return { member, device }
}

export function parseAuthHeader(req: FastifyRequest): { deviceId: string; deviceKey: string } | null {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return null
  const token = h.slice(7).trim()
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  return { deviceId: token.slice(0, dot), deviceKey: token.slice(dot + 1) }
}

export function makeRequireAuth(ctx: ServerContext): preHandlerAsyncHookHandler {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
    const cred = parseAuthHeader(req)
    if (!cred) throw new AppError('UNAUTHORIZED', '인증 정보가 없습니다.', 401)
    const protoHeader = req.headers['x-protocol']
    const protocol = protoHeader ? Number(protoHeader) : undefined
    const winUser = decodeURIComponent(String(req.headers['x-win-user'] ?? ''))
    const appVersion = req.headers['x-app-version'] ? String(req.headers['x-app-version']) : undefined
    const r = authenticate(ctx, { ...cred, winUser, ip: req.ip, protocol, appVersion })
    req.member = r.member
    req.device = r.device
    req.clientProtocol = protocol !== undefined && Number.isFinite(protocol) ? protocol : undefined
    const uid = req.headers['x-pc-uid']
    if (!r.device.pc_uid && typeof uid === 'string' && PC_UID_RE.test(uid)) learnPcUid(ctx.db, r.device.id, uid)
    req.clientIp = normalizeIp(req.ip)
    // a change sent again with the same key (outbox of a PC that was offline) gets its first answer
    if (replayIdempotent(ctx, req, reply)) return reply
  }
}

export function makeRequireAdmin(ctx: ServerContext): preHandlerAsyncHookHandler {
  return async function requireAdmin(req: FastifyRequest): Promise<void> {
    if (req.member?.role !== 'admin') throw new AppError('FORBIDDEN', '관리자만 사용할 수 있습니다.', 403)
    const pinHash = readSetting<string>(ctx.db, 'adminPinHash')
    if (pinHash) {
      const pin = String(req.headers['x-admin-pin'] ?? '')
      if (!pin || !verifyPin(pin, pinHash)) throw new AppError('ADMIN_PIN_REQUIRED', '관리 PIN이 필요합니다.', 403)
    }
  }
}

/**
 * Two admin tiers: the 최종관리자 is the server PC itself (its own device entry), every other
 * admin is a 서무. A request counts as the owner's only when it comes from the server PC.
 */
export function isOwnerRequest(ctx: ServerContext, req: FastifyRequest): boolean {
  return req.member?.role === 'admin' && !!req.device && req.device.id === serverDeviceId(ctx.db)
}

export function ownerOnly(message = '최종관리자(서버 PC)만 할 수 있습니다.'): AppError {
  return new AppError('OWNER_ONLY', message, 403)
}

/** After requireAuth and requireAdmin: data storage and critical settings (not open to 서무). */
export function makeRequireOwner(ctx: ServerContext): preHandlerAsyncHookHandler {
  return async function requireOwner(req: FastifyRequest): Promise<void> {
    if (!isOwnerRequest(ctx, req)) throw ownerOnly()
  }
}
