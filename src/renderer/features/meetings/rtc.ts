import type { RtcData } from '@shared/schemas/meetings'
import { realtime } from '@renderer/lib/realtime'

/** Per-peer media and UI state. */
export interface PeerView {
  id: string
  state: { mic: boolean; cam: boolean; screen: boolean; hand: boolean; screenId: string | null }
  camera: MediaStream | null
  screen: MediaStream | null
  level: number
  connection: RTCPeerConnectionState
}

interface Peer {
  id: string
  pc: RTCPeerConnection
  polite: boolean
  makingOffer: boolean
  ignoreOffer: boolean
  streams: Map<string, MediaStream>
  state: PeerView['state']
  level: number
  screenSenders: RTCRtpSender[]
  /** candidates that arrived before the remote description */
  pendingIce: RTCIceCandidateInit[]
}

export interface ChatLine {
  from: string
  text: string
  at: number
}

type StateMsg = Extract<RtcData, { kind: 'state' }> & { screenId?: string | null }

/** E2E only (`?fakecam=1`, set by main under TEAMHUB_FAKE_MEDIA): an animated canvas as the camera. */
const FAKE_CAMERA = typeof location !== 'undefined' && location.hash.includes('fakecam=1')
function canvasCamera(): MediaStream {
  const c = document.createElement('canvas')
  c.width = 640
  c.height = 360
  const g = c.getContext('2d')!
  let n = 0
  const timer = window.setInterval(() => {
    if (s.getVideoTracks()[0]?.readyState !== 'live') return window.clearInterval(timer)
    n++
    g.fillStyle = `hsl(${(n * 3) % 360} 60% 40%)`
    g.fillRect(0, 0, 640, 360)
    g.fillStyle = '#fff'
    g.fillRect((n * 8) % 640, 150, 60, 60)
  }, 1000 / 24)
  const s = c.captureStream(24)
  return s
}

/**
 * Mesh of RTCPeerConnections, one per other participant (6.17). Uses the "perfect
 * negotiation" pattern so both sides may add tracks at any time (camera, screen).
 * No STUN/TURN: same LAN only (13.1). Signals go through the TeamHub WebSocket.
 */
export class Room {
  readonly peers = new Map<string, Peer>()
  local: MediaStream = new MediaStream()
  screen: MediaStream | null = null
  mic = true
  cam = true
  hand = false
  chat: ChatLine[] = []
  pointer: { from: string; x: number; y: number; at: number } | null = null
  localLevel = 0
  private listeners = new Set<() => void>()
  private audio: AudioContext | null = null
  private analysers = new Map<string, AnalyserNode>()
  private levelTimer: number | null = null
  private offSignal: () => void
  private closed = false
  private lastOpts: { audio: boolean; video: boolean; audioId?: string; videoId?: string } = { audio: true, video: true }
  private queue: Promise<void> = Promise.resolve()
  /** Signal counters, read by diagnostics (E2E). */
  readonly stats: Record<string, number> = {}
  private count(k: string): void {
    this.stats[k] = (this.stats[k] ?? 0) + 1
  }

  constructor(
    readonly meetingId: string,
    readonly me: string
  ) {
    this.offSignal = realtime.on('rtc.signal', (p) => {
      const m = p as { meetingId: string; from: string; data: RtcData }
      // Signals are handled strictly in order (an ICE candidate must not overtake its offer).
      if (m.meetingId === this.meetingId) this.queue = this.queue.then(() => this.onSignal(m.from, m.data)).catch(() => undefined)
    })
    this.levelTimer = window.setInterval(() => this.measure(), 250)
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private emit(): void {
    for (const l of this.listeners) l()
  }

  /** Camera + microphone. Missing devices are not an error: join with what exists. */
  async openMedia(opts: { audio: boolean; video: boolean; audioId?: string; videoId?: string }): Promise<string | null> {
    for (const t of this.local.getTracks()) t.stop()
    this.local = new MediaStream()
    let note: string | null = null
    const tryGet = async (c: MediaStreamConstraints): Promise<MediaStream | null> => {
      if (c.video && FAKE_CAMERA) return canvasCamera()
      try {
        return await navigator.mediaDevices.getUserMedia(c)
      } catch {
        return null
      }
    }
    if (opts.audio) {
      const s = await tryGet({ audio: opts.audioId ? { deviceId: { exact: opts.audioId } } : { echoCancellation: true, noiseSuppression: true } })
      if (s) s.getAudioTracks().forEach((t) => this.local.addTrack(t))
      else note = '마이크를 찾지 못했습니다.'
    }
    if (opts.video) {
      const s = await tryGet({ video: opts.videoId ? { deviceId: { exact: opts.videoId }, width: 640, height: 360 } : { width: 640, height: 360, frameRate: 24 } })
      if (s) s.getVideoTracks().forEach((t) => this.local.addTrack(t))
      else note = note ? '마이크와 카메라를 찾지 못했습니다.' : '카메라를 찾지 못했습니다.'
    }
    this.mic = opts.audio && this.local.getAudioTracks().length > 0
    this.cam = opts.video && this.local.getVideoTracks().length > 0
    this.lastOpts = opts
    for (const t of this.local.getTracks()) this.watchEnded(t)
    this.watchLevel('me', this.local)
    // replace tracks for existing connections (device change)
    for (const p of this.peers.values()) {
      for (const kind of ['audio', 'video'] as const) {
        const track = kind === 'audio' ? this.local.getAudioTracks()[0] : this.local.getVideoTracks()[0]
        const sender = p.pc.getSenders().find((s) => s.track?.kind === kind && !p.screenSenders.includes(s))
        if (sender) void sender.replaceTrack(track ?? null)
        else if (track) p.pc.addTrack(track, this.local)
      }
    }
    this.broadcastState()
    this.emit()
    return note
  }

  /** Signals sent while the WebSocket is not open yet are kept and sent in order later. */
  private outbox: { to: string; data: RtcData | StateMsg }[] = []
  private flushTimer: number | null = null
  /** A device track that ends by itself (camera taken by another app, unplugged) is re-acquired. */
  private watchEnded(t: MediaStreamTrack): void {
    t.addEventListener('ended', () => {
      if (this.closed || !this.local.getTracks().includes(t)) return
      window.setTimeout(() => void this.reacquire(t), 800)
    })
  }
  private async reacquire(old: MediaStreamTrack, attempt = 1): Promise<void> {
    if (this.closed || !this.local.getTracks().includes(old)) return
    const kind = old.kind as 'audio' | 'video'
    const id = kind === 'audio' ? this.lastOpts.audioId : this.lastOpts.videoId
    let track: MediaStreamTrack | undefined
    try {
      const s = kind === 'video' && FAKE_CAMERA ? canvasCamera() : await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: id ? { deviceId: { exact: id } } : true } : { video: id ? { deviceId: { exact: id } } : { width: 640, height: 360 } })
      track = kind === 'audio' ? s.getAudioTracks()[0] : s.getVideoTracks()[0]
    } catch {
      track = undefined
    }
    // The capture service may still be restarting after a crash: try again for a while.
    if (!track || track.readyState === 'ended') {
      track?.stop()
      if (attempt < 8) window.setTimeout(() => void this.reacquire(old, attempt + 1), 1500)
      return
    }
    if (this.closed) return track.stop()
    track.enabled = kind === 'audio' ? this.mic : this.cam
    this.local.removeTrack(old)
    this.local.addTrack(track)
    this.watchEnded(track)
    for (const p of this.peers.values()) {
      const sender = p.pc.getSenders().find((x) => x.track === old) ?? p.pc.getSenders().find((x) => x.track?.kind === kind && x.track.readyState === 'ended' && !p.screenSenders.includes(x))
      if (sender) await sender.replaceTrack(track).catch(() => undefined)
    }
    if (kind === 'audio') this.watchLevel('me', this.local)
    this.emit()
  }

  private send(to: string, data: RtcData | StateMsg): void {
    this.count(`tx:${data.kind}`)
    if (this.outbox.length || !realtime.send({ type: 'rtc', meetingId: this.meetingId, to, data })) {
      this.outbox.push({ to, data })
      this.flushTimer ??= window.setInterval(() => this.flush(), 300)
    }
  }
  private flush(): void {
    while (this.outbox.length) {
      const m = this.outbox[0]
      if (!realtime.send({ type: 'rtc', meetingId: this.meetingId, to: m.to, data: m.data })) return
      this.outbox.shift()
    }
    if (this.flushTimer) window.clearInterval(this.flushTimer)
    this.flushTimer = null
  }

  private peer(id: string): Peer {
    const existing = this.peers.get(id)
    if (existing) return existing
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' })
    const p: Peer = { id, pc, polite: this.me > id, makingOffer: false, ignoreOffer: false, streams: new Map(), state: { mic: false, cam: false, screen: false, hand: false, screenId: null }, level: 0, screenSenders: [], pendingIce: [] }
    this.peers.set(id, p)
    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true
        await pc.setLocalDescription()
        if (pc.localDescription) this.send(id, { kind: 'offer', sdp: pc.localDescription.sdp })
      } catch {
        // retried on the next negotiationneeded
      } finally {
        p.makingOffer = false
      }
    }
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send(id, { kind: 'ice', candidate: { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex } })
    }
    pc.ontrack = (e) => {
      const s = e.streams[0] ?? new MediaStream([e.track])
      p.streams.set(s.id, s)
      e.track.onended = () => this.emit()
      s.onremovetrack = () => {
        if (!s.getTracks().length) p.streams.delete(s.id)
        this.emit()
      }
      if (e.track.kind === 'audio') this.watchLevel(id, s)
      this.emit()
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.sendState(id)
      if (pc.connectionState === 'failed') pc.restartIce()
      this.emit()
    }
    for (const t of this.local.getTracks()) pc.addTrack(t, this.local)
    if (this.screen) for (const t of this.screen.getTracks()) p.screenSenders.push(pc.addTrack(t, this.screen))
    // Watchdog: if a pair never connects (lost signal, both offering), negotiate again.
    // Still nothing after 15 s (e.g. ICE gathering stuck after a media service crash):
    // the impolite side rebuilds the connection and tells the other side to do the same.
    let rounds = 0
    const watch = window.setInterval(() => {
      if (this.peers.get(id) !== p || pc.connectionState === 'closed') return window.clearInterval(watch)
      if (pc.connectionState === 'connected') return window.clearInterval(watch)
      rounds++
      if (rounds >= 3 && !p.polite) {
        window.clearInterval(watch)
        this.count('reset')
        this.send(id, { kind: 'reset' })
        this.rebuild(id)
        return
      }
      if (pc.signalingState === 'have-local-offer' && pc.localDescription) this.send(id, { kind: 'offer', sdp: pc.localDescription.sdp })
      else if (pc.signalingState === 'stable') pc.restartIce()
    }, 5000)
    return p
  }

  /** Replace the connection to one participant with a fresh one (keeps their UI state). */
  private rebuild(id: string): void {
    const old = this.peers.get(id)
    if (!old) return
    old.pc.close()
    this.peers.delete(id)
    this.analysers.delete(id)
    const p = this.peer(id)
    p.state = old.state
    this.emit()
  }

  /** Connect to everyone already in the meeting. */
  connect(ids: string[]): void {
    for (const id of ids) if (id !== this.me) this.peer(id)
    this.emit()
  }

  remove(id: string): void {
    const p = this.peers.get(id)
    if (!p) return
    p.pc.close()
    this.peers.delete(id)
    this.analysers.delete(id)
    this.emit()
  }

  private async onSignal(from: string, data: RtcData | StateMsg): Promise<void> {
    this.count(`rx:${data.kind}`)
    if (data.kind === 'state') {
      const p = this.peer(from)
      p.state = { mic: data.mic, cam: data.cam, screen: data.screen, hand: data.hand, screenId: (data as StateMsg).screenId ?? null }
      this.emit()
      return
    }
    if (data.kind === 'chat') {
      this.chat = [...this.chat, { from, text: data.text.slice(0, 2000), at: data.at }].slice(-300)
      this.emit()
      return
    }
    if (data.kind === 'pointer') {
      this.pointer = { from, x: data.x, y: data.y, at: Date.now() }
      this.emit()
      return
    }
    if (data.kind === 'reset') {
      if (this.peers.has(from)) this.rebuild(from)
      return
    }
    const p = this.peer(from)
    const pc = p.pc
    try {
      if (data.kind === 'offer' || data.kind === 'answer') {
        const collision = data.kind === 'offer' && (p.makingOffer || pc.signalingState !== 'stable')
        p.ignoreOffer = !p.polite && collision
        if (p.ignoreOffer) return this.count('ignored-offer')
        await pc.setRemoteDescription({ type: data.kind, sdp: data.sdp })
        for (const c of p.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined)
        if (data.kind === 'offer') {
          await pc.setLocalDescription()
          if (pc.localDescription) this.send(from, { kind: 'answer', sdp: pc.localDescription.sdp })
        }
      } else if (data.kind === 'ice') {
        if (!pc.remoteDescription) {
          p.pendingIce.push(data.candidate)
          return this.count('ice-pending')
        }
        try {
          await pc.addIceCandidate(data.candidate)
          this.count('ice-added')
        } catch (e) {
          if (!p.ignoreOffer) throw e
        }
      }
    } catch (e) {
      this.count(`err:${data.kind}`)
      console.warn('[rtc] signal failed', e)
    }
  }

  private stateMsg(): StateMsg {
    return { kind: 'state', mic: this.mic, cam: this.cam, screen: !!this.screen, hand: this.hand, screenId: this.screen?.id ?? null }
  }
  private sendState(to: string): void {
    this.send(to, this.stateMsg())
  }
  broadcastState(): void {
    for (const id of this.peers.keys()) this.sendState(id)
  }

  setMic(on: boolean): void {
    this.mic = on && this.local.getAudioTracks().length > 0
    this.local.getAudioTracks().forEach((t) => (t.enabled = this.mic))
    this.broadcastState()
    this.emit()
  }
  setCam(on: boolean): void {
    this.cam = on && this.local.getVideoTracks().length > 0
    this.local.getVideoTracks().forEach((t) => (t.enabled = this.cam))
    this.broadcastState()
    this.emit()
  }
  setHand(on: boolean): void {
    this.hand = on
    this.broadcastState()
    this.emit()
  }

  async shareScreen(stream: MediaStream): Promise<void> {
    this.stopScreen(false)
    this.screen = stream
    stream.getVideoTracks()[0]?.addEventListener('ended', () => this.stopScreen())
    for (const p of this.peers.values()) for (const t of stream.getTracks()) p.screenSenders.push(p.pc.addTrack(t, stream))
    this.broadcastState()
    this.emit()
  }
  stopScreen(notify = true): void {
    if (!this.screen) return
    for (const t of this.screen.getTracks()) t.stop()
    for (const p of this.peers.values()) {
      for (const s of p.screenSenders) {
        try {
          p.pc.removeTrack(s)
        } catch {
          // connection closed
        }
      }
      p.screenSenders = []
    }
    this.screen = null
    if (notify) {
      this.broadcastState()
      this.emit()
    }
  }

  sendChat(text: string): void {
    const line = { from: this.me, text: text.slice(0, 2000), at: Date.now() }
    this.chat = [...this.chat, line].slice(-300)
    for (const id of this.peers.keys()) this.send(id, { kind: 'chat', text: line.text, at: line.at })
    this.emit()
  }
  sendPointer(x: number, y: number): void {
    this.pointer = { from: this.me, x, y, at: Date.now() }
    for (const id of this.peers.keys()) this.send(id, { kind: 'pointer', x, y })
    this.emit()
  }

  private watchLevel(id: string, stream: MediaStream): void {
    if (!stream.getAudioTracks().length) return
    try {
      this.audio ??= new AudioContext()
      const src = this.audio.createMediaStreamSource(stream)
      const a = this.audio.createAnalyser()
      a.fftSize = 256
      src.connect(a)
      this.analysers.set(id, a)
    } catch {
      // audio unavailable
    }
  }
  private measure(): void {
    const buf = new Uint8Array(128)
    let changed = false
    for (const [id, a] of this.analysers) {
      a.getByteTimeDomainData(buf)
      let peak = 0
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
      const level = peak / 128
      if (id === 'me') {
        if (Math.abs(level - this.localLevel) > 0.05) changed = true
        this.localLevel = this.mic ? level : 0
      } else {
        const p = this.peers.get(id)
        if (!p) continue
        if (Math.abs(level - p.level) > 0.05) changed = true
        p.level = level
      }
    }
    if (changed) this.emit()
  }

  views(): PeerView[] {
    return [...this.peers.values()].map((p) => {
      const screen = p.state.screenId ? (p.streams.get(p.state.screenId) ?? null) : null
      const camera = [...p.streams.values()].find((s) => s.id !== p.state.screenId) ?? null
      return { id: p.id, state: p.state, camera, screen, level: p.level, connection: p.pc.connectionState }
    })
  }

  close(): void {
    this.closed = true
    this.offSignal()
    if (this.flushTimer) window.clearInterval(this.flushTimer)
    if (this.levelTimer) window.clearInterval(this.levelTimer)
    this.stopScreen(false)
    for (const p of this.peers.values()) p.pc.close()
    this.peers.clear()
    for (const t of this.local.getTracks()) t.stop()
    void this.audio?.close().catch(() => undefined)
  }
}
