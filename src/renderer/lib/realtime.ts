import { PROTOCOL_VERSION } from '@shared/constants'
import type { ClientMessage, EventName, ServerMessage } from '@shared/events'
import { useConn } from '@renderer/app/conn-store'
import { queryClient } from './query-client'
import { invoke } from './bridge'
import { authHeaders } from './api'

type Listener = (payload: unknown, name: EventName) => void

/** Query keys refreshed for each event ("events say what changed", 13.7). */
const INVALIDATE: Partial<Record<EventName, string[][]>> = {
  'presence.changed': [['members']],
  // 근무현황 carries the member list too (the home widget 오늘 부재자 keeps it loaded)
  'member.changed': [['members'], ['me'], ['admin'], ['events', 'duty']],
  'device.changed': [['admin', 'devices']],
  'join.requested': [['admin', 'join-requests'], ['admin', 'status'], ['me']],
  'settings.changed': [['me'], ['hello'], ['admin', 'settings'], ['collect', 'summary']],
  'group.changed': [['groups'], ['me']],
  'group.membership': [['groups'], ['me']],
  'notice.changed': [['notices']],
  'notice.receipt': [['notices']],
  'event.changed': [['events']],
  'worklog.changed': [['worklogs']],
  'file.changed': [['files']],
  'folder.changed': [['files']],
  'message.new': [['chat']],
  'message.changed': [['chat']],
  'conversation.changed': [['chat']],
  'conversation.read': [['chat']],
  'note.new': [['chat']],
  'note.changed': [['chat']],
  'post.changed': [['boards']],
  'board.changed': [['boards']],
  'contact.changed': [['contacts']],
  'doc.changed': [['docs']],
  'memo.changed': [['shared-memos'], ['team-alarms']],
  'launcher.changed': [['launcher']],
  'meeting.changed': [['meetings']],
  'collect.changed': [['collect']],
  'unregistered.changed': [['unregistered']],
  'update.available': [['updates']]
}

// The server PC may be off for hours; when it comes back every PC should notice within seconds.
const RETRY_STEPS = [1000, 2000, 5000, 10000]
/** A powered-off PC does not refuse the connection, it just never answers: do not wait for the OS timeout (~20s). */
const CONNECT_TIMEOUT_MS = 6000
/** Member PCs look for the server at a new address after this many failed tries (its IP may have changed). */
const REDISCOVER_AFTER = 3
const REDISCOVER_EVERY_MS = 60_000
const AWAY_AFTER_SEC = 5 * 60

class RealtimeClient {
  private ws: WebSocket | null = null
  private retry = 0
  private retryTimer: number | null = null
  private pingTimer: number | null = null
  private idleTimer: number | null = null
  private stopped = true
  private listeners = new Map<string, Set<Listener>>()
  private awayState: 'online' | 'away' = 'online'
  private reconnectHooks = new Set<() => void>()
  private wakeTimer: number | null = null
  private lastTick = Date.now()
  private lastRediscover = 0
  private readonly onNetworkBack = (): void => this.retryNow()

  start(): void {
    this.stopped = false
    this.connect()
    if (this.idleTimer === null) this.idleTimer = window.setInterval(() => void this.checkIdle(), 30000)
    // Cable plugged back in, Wi-Fi back, PC woken from sleep: try at once instead of waiting for the retry timer.
    window.addEventListener('online', this.onNetworkBack)
    if (this.wakeTimer === null) {
      this.lastTick = Date.now()
      this.wakeTimer = window.setInterval(() => {
        const gap = Date.now() - this.lastTick
        this.lastTick = Date.now()
        if (gap > 20_000) this.retryNow()
      }, 5000)
    }
  }

  /** Try to connect now when not connected (no effect while online). */
  retryNow(): void {
    if (this.stopped || this.ws?.readyState === WebSocket.OPEN) return
    this.retry = 0
    if (this.retryTimer) window.clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.ws) this.ws.close()
    else this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) window.clearTimeout(this.retryTimer)
    if (this.pingTimer) window.clearInterval(this.pingTimer)
    if (this.idleTimer) window.clearInterval(this.idleTimer)
    if (this.wakeTimer) window.clearInterval(this.wakeTimer)
    window.removeEventListener('online', this.onNetworkBack)
    this.retryTimer = this.pingTimer = this.idleTimer = this.wakeTimer = null
    this.ws?.close()
    this.ws = null
  }

  /** Force a reconnect now (e.g. after the server address changed). */
  reconnect(): void {
    this.retry = 0
    this.ws?.close()
    if (this.stopped) return
    if (this.retryTimer) window.clearTimeout(this.retryTimer)
    this.connect()
  }

  on(name: EventName | '*', cb: Listener): () => void {
    let set = this.listeners.get(name)
    if (!set) this.listeners.set(name, (set = new Set()))
    set.add(cb)
    return () => set!.delete(cb)
  }

  onReconnect(cb: () => void): () => void {
    this.reconnectHooks.add(cb)
    return () => this.reconnectHooks.delete(cb)
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  private connect(): void {
    const c = useConn.getState()
    if (!c.serverUrl || !c.deviceId || !c.deviceKey) return
    // once known to be off it stays "off" until the server answers: no flicker on every retry
    if (useConn.getState().state !== 'online' && useConn.getState().state !== 'offline') useConn.getState().setState('connecting')
    const url = c.serverUrl.replace(/^http/, 'ws') + '/ws'
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    let rejected = false
    const giveUp = window.setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) ws.close()
    }, CONNECT_TIMEOUT_MS)
    ws.onopen = () => {
      window.clearTimeout(giveUp)
      const hello: ClientMessage = {
        type: 'hello',
        deviceId: c.deviceId!,
        deviceKey: c.deviceKey!,
        winUser: c.winUser,
        protocol: PROTOCOL_VERSION,
        appVersion: c.appVersion
      }
      ws.send(JSON.stringify(hello))
    }
    ws.onmessage = (ev) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage
      } catch {
        return
      }
      switch (msg.type) {
        case 'welcome':
          this.retry = 0
          useConn.getState().setState('online')
          this.awayState = 'online'
          // After (re)connecting, refetch everything and pick up pending notices (13.7).
          void queryClient.invalidateQueries()
          for (const h of this.reconnectHooks) h()
          if (this.pingTimer) window.clearInterval(this.pingTimer)
          this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), 25000)
          void this.checkIdle()
          break
        case 'rejected':
          rejected = true
          if (msg.code === 'UPDATE_REQUIRED') useConn.getState().setState('update-required', msg.message)
          else useConn.getState().setState('rejected', msg.message)
          break
        case 'ping':
          this.send({ type: 'pong' })
          break
        case 'event':
          this.dispatch(msg.name, msg.payload)
          break
      }
    }
    ws.onclose = () => {
      window.clearTimeout(giveUp)
      if (this.ws === ws) this.ws = null
      if (this.pingTimer) window.clearInterval(this.pingTimer)
      this.pingTimer = null
      if (rejected || this.stopped) return
      useConn.getState().setState('offline')
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      /* onclose follows */
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = RETRY_STEPS[Math.min(this.retry, RETRY_STEPS.length - 1)]
    this.retry++
    if (this.retryTimer) window.clearTimeout(this.retryTimer)
    this.retryTimer = window.setTimeout(() => this.connect(), delay)
    if (this.retry >= REDISCOVER_AFTER) void this.rediscover()
  }

  /**
   * The server PC got another IP address (DHCP, moved to another socket): look for TeamHub
   * servers on the network and move to the one that accepts this PC's key as the same member.
   * A different team's server answers 401 and is left alone.
   */
  private async rediscover(): Promise<void> {
    const c = useConn.getState()
    if (c.mode !== 'client' || !c.serverUrl || !c.memberId || Date.now() - this.lastRediscover < REDISCOVER_EVERY_MS) return
    this.lastRediscover = Date.now()
    try {
      for (const s of await invoke('discovery:scan')) {
        if (s.url === c.serverUrl) continue
        const r = await fetch(`${s.url}/api/me`, { headers: authHeaders(), signal: AbortSignal.timeout(4000) }).catch(() => null)
        if (!r?.ok) continue
        const me = ((await r.json().catch(() => null)) as { data?: { id?: string } } | null)?.data
        if (me?.id !== c.memberId || this.ws?.readyState === WebSocket.OPEN || useConn.getState().serverUrl !== c.serverUrl) continue
        await invoke('conn:updateServerUrl', { serverUrl: s.url })
        useConn.setState({ serverUrl: s.url })
        this.retryNow()
        return
      }
    } catch {
      // no network at all: the retry timer goes on
    }
  }

  private dispatch(name: EventName, payload: unknown): void {
    // Group membership changes what I can see everywhere: refetch all shared data.
    if (name === 'group.membership') void queryClient.invalidateQueries()
    for (const key of INVALIDATE[name] ?? []) void queryClient.invalidateQueries({ queryKey: key })
    for (const cb of this.listeners.get(name) ?? []) cb(payload, name)
    for (const cb of this.listeners.get('*') ?? []) cb(payload, name)
  }

  private async checkIdle(): Promise<void> {
    if (useConn.getState().state !== 'online') return
    let idle: number
    try {
      idle = await invoke('app:idleSeconds')
    } catch {
      return
    }
    const next = idle >= AWAY_AFTER_SEC ? 'away' : 'online'
    if (next !== this.awayState) {
      this.awayState = next
      this.send({ type: 'presence', state: next })
    }
  }
}

export const realtime = new RealtimeClient()
