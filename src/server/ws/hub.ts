import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { ClientMessage, EventName, ServerMessage } from '../../shared/events'
import type { Presence } from '../../shared/schemas/auth'
import { authenticate } from '../auth'
import { AppError } from '../errors'
import type { ServerContext } from '../context'

interface Conn {
  memberId: string
  deviceId: string
  state: 'online' | 'away'
  lastPong: number
}

const HELLO_TIMEOUT_MS = 5000
const PING_INTERVAL_MS = 25000
const DEAD_AFTER_MS = 60000

export type RtcRelay = (fromMemberId: string, msg: Extract<ClientMessage, { type: 'rtc' }>) => void

export class Hub {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  private conns = new Map<WebSocket, Conn>()
  private pingTimer: NodeJS.Timeout | null = null
  private getCtx: () => ServerContext
  rtcRelay: RtcRelay | null = null
  /** Called when a member's last connection closes (meetings: leave). */
  onMemberOffline: ((memberId: string) => void) | null = null
  /** Optional hook (M3): returns true when the member has an absence event now. */
  absenceLookup: ((memberId: string) => boolean) | null = null

  constructor(getCtx: () => ServerContext) {
    this.getCtx = getCtx
  }

  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = req.url ?? ''
      if (!url.startsWith('/ws')) {
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req))
    })
    this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS)
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = req.socket.remoteAddress ?? ''
    const helloTimer = setTimeout(() => ws.close(4001, 'hello timeout'), HELLO_TIMEOUT_MS)

    ws.on('message', (raw: RawData) => {
      let msg: ClientMessage
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage
      } catch {
        return
      }
      const conn = this.conns.get(ws)
      if (!conn) {
        if (msg.type !== 'hello') return
        clearTimeout(helloTimer)
        try {
          const { member, device } = authenticate(this.getCtx(), {
            deviceId: msg.deviceId,
            deviceKey: msg.deviceKey,
            winUser: msg.winUser,
            ip,
            protocol: msg.protocol,
            appVersion: msg.appVersion
          })
          const before = this.presenceOf(member.id)
          this.conns.set(ws, { memberId: member.id, deviceId: device.id, state: 'online', lastPong: Date.now() })
          this.send(ws, { type: 'welcome', memberId: member.id, serverTime: Date.now() })
          this.emitPresenceIfChanged(member.id, before)
        } catch (e) {
          const err = e instanceof AppError ? e : new AppError('UNAUTHORIZED', '인증 실패', 401)
          this.send(ws, { type: 'rejected', code: err.code, message: err.message })
          ws.close(4003, err.code)
        }
        return
      }
      switch (msg.type) {
        case 'ping':
          this.send(ws, { type: 'pong' })
          conn.lastPong = Date.now()
          break
        case 'pong':
          conn.lastPong = Date.now()
          break
        case 'presence': {
          const before = this.presenceOf(conn.memberId)
          conn.state = msg.state === 'away' ? 'away' : 'online'
          conn.lastPong = Date.now()
          this.emitPresenceIfChanged(conn.memberId, before)
          break
        }
        case 'rtc':
          conn.lastPong = Date.now()
          this.rtcRelay?.(conn.memberId, msg)
          break
      }
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      const conn = this.conns.get(ws)
      if (!conn) return
      const before = this.presenceOf(conn.memberId)
      this.conns.delete(ws)
      try {
        this.getCtx().db.run('UPDATE members SET last_seen_at = ? WHERE id = ?', [Date.now(), conn.memberId])
      } catch {
        // db closed during shutdown
      }
      this.emitPresenceIfChanged(conn.memberId, before)
      if (![...this.conns.values()].some((c) => c.memberId === conn.memberId)) {
        try {
          this.onMemberOffline?.(conn.memberId)
        } catch {
          // db closed during shutdown
        }
      }
    })
    ws.on('error', () => ws.terminate())
  }

  private heartbeat(): void {
    const t = Date.now()
    for (const [ws, conn] of this.conns) {
      if (t - conn.lastPong > DEAD_AFTER_MS) {
        ws.terminate()
        continue
      }
      this.send(ws, { type: 'ping' })
    }
  }

  private emitPresenceIfChanged(memberId: string, before: Presence): void {
    const after = this.presenceOf(memberId)
    if (after !== before) this.broadcast('presence.changed', { memberId, presence: after })
  }

  presenceOf(memberId: string): Presence {
    let any = false
    let online = false
    for (const c of this.conns.values()) {
      if (c.memberId !== memberId) continue
      any = true
      if (c.state === 'online') online = true
    }
    if (any) return online ? 'online' : 'away'
    if (this.absenceLookup?.(memberId)) return 'absent'
    return 'offline'
  }

  isDeviceOnline(deviceId: string): boolean {
    for (const c of this.conns.values()) if (c.deviceId === deviceId) return true
    return false
  }

  onlineMemberIds(): Set<string> {
    return new Set([...this.conns.values()].map((c) => c.memberId))
  }

  connectionCount(): number {
    return this.conns.size
  }

  /** Send an event only to the given members (audience computed by the caller via scope.ts). */
  sendTo(memberIds: Iterable<string>, name: EventName, payload: unknown): void {
    const targets = new Set(memberIds)
    if (!targets.size) return
    const msg: ServerMessage = { type: 'event', name, payload, at: Date.now() }
    const data = JSON.stringify(msg)
    for (const [ws, c] of this.conns) {
      if (targets.has(c.memberId) && ws.readyState === WebSocket.OPEN) ws.send(data)
    }
  }

  /** Reserved for presence.changed, update.available, server.shutdown, settings.changed (13.7). */
  broadcast(name: EventName, payload: unknown): void {
    const msg: ServerMessage = { type: 'event', name, payload, at: Date.now() }
    const data = JSON.stringify(msg)
    for (const ws of this.conns.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(data)
  }

  /** Disconnect sockets of a device or member immediately (revocation). */
  kick(filter: { deviceId?: string; memberId?: string }, code = 'DEVICE_REVOKED'): void {
    for (const [ws, c] of this.conns) {
      if ((filter.deviceId && c.deviceId === filter.deviceId) || (filter.memberId && c.memberId === filter.memberId)) {
        this.send(ws, { type: 'rejected', code, message: '관리자가 이 PC의 사용을 중지했습니다. 관리자에게 문의하세요.' })
        ws.close(4003, code)
      }
    }
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    for (const ws of this.conns.keys()) ws.terminate()
    this.conns.clear()
    this.wss.close()
  }
}
