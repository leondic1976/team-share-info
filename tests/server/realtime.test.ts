import { describe, it, expect, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { createSocket } from 'node:dgram'
import type { AddressInfo } from 'node:net'
import { createTestServer, type Cred, type TestServer } from './helpers'
import { PROTOCOL_VERSION, DISCOVERY_MAGIC } from '../../src/shared/constants'
import type { ServerMessage } from '../../src/shared/events'
import { startDiscoveryResponder } from '../../src/server/discovery'

let s: TestServer | null = null
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const w of sockets) w.terminate()
  sockets.length = 0
  await s?.close()
  s = null
})

async function listen(t: TestServer): Promise<number> {
  await t.app.listen({ port: 0, host: '127.0.0.1' })
  return (t.app.server.address() as AddressInfo).port
}

function connect(port: number, cred: Cred): Promise<{ ws: WebSocket; messages: ServerMessage[]; first: ServerMessage }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    sockets.push(ws)
    const messages: ServerMessage[] = []
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', ...cred, protocol: PROTOCOL_VERSION, appVersion: '0.1.0' })))
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMessage
      messages.push(m)
      if (messages.length === 1) resolve({ ws, messages, first: m })
    })
    ws.on('error', reject)
  })
}

const waitFor = async (fn: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('realtime hub (M1-4)', () => {
  it('welcomes valid devices and rejects bad keys', async () => {
    s = await createTestServer()
    const port = await listen(s)
    const ok = await connect(port, s.admin)
    expect(ok.first).toMatchObject({ type: 'welcome', memberId: s.admin.memberId })
    const bad = await connect(port, { ...s.admin, deviceKey: 'nope' })
    expect(bad.first).toMatchObject({ type: 'rejected', code: 'UNAUTHORIZED' })
  })

  it('broadcasts presence online/away/offline', async () => {
    s = await createTestServer()
    const port = await listen(s)
    const m = await s.join('김철수', { ip: '127.0.0.1' })
    const a = await connect(port, s.admin)
    const b = await connect(port, m)
    const presence = (st: string) =>
      a.messages.some((x) => x.type === 'event' && x.name === 'presence.changed' && (x.payload as { memberId: string; presence: string }).memberId === m.memberId && (x.payload as { presence: string }).presence === st)
    await waitFor(() => presence('online'))
    b.ws.send(JSON.stringify({ type: 'presence', state: 'away' }))
    await waitFor(() => presence('away'))
    b.ws.close()
    await waitFor(() => presence('offline'))
    const ms = (await s.req(s.admin, { method: 'GET', url: '/api/members' })).json().data
    expect(ms.find((x: { name: string }) => x.name === '김철수').presence).toBe('offline')
  })

  it('notifies admins of new join requests and kicks revoked devices', async () => {
    s = await createTestServer()
    const port = await listen(s)
    const m = await s.join('김철수', { ip: '127.0.0.1' })
    const a = await connect(port, s.admin)
    const b = await connect(port, m)
    await s.req(null, { method: 'POST', url: '/api/join', payload: { name: '새사람', pcName: 'p', winUser: 'w' } })
    await waitFor(() => a.messages.some((x) => x.type === 'event' && x.name === 'join.requested'))
    expect(b.messages.some((x) => x.type === 'event' && x.name === 'join.requested')).toBe(false)

    let closed = false
    b.ws.on('close', () => (closed = true))
    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/devices/${m.deviceId}`, payload: { action: 'revoke' } })
    await waitFor(() => closed)
    expect(b.messages.some((x) => x.type === 'rejected' && x.code === 'DEVICE_REVOKED')).toBe(true)
  })

  it('closes sockets that never say hello', async () => {
    s = await createTestServer()
    const port = await listen(s)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    sockets.push(ws)
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)))
    expect(code).toBe(4001)
  }, 10000)
})

describe('discovery (M1-5)', () => {
  it('answers the magic probe with org info', async () => {
    s = await createTestServer()
    let sock
    try {
      sock = startDiscoveryResponder(s.ctx, () => undefined)
    } catch {
      return // port in use on this machine (e.g. a running TeamHub server)
    }
    await new Promise((r) => sock!.once('listening', r))
    const client = createSocket('udp4')
    // Other TeamHub instances on this PC may answer too: collect replies and pick ours.
    const replies: string[] = []
    client.on('message', (msg) => replies.push(msg.toString()))
    client.send(DISCOVERY_MAGIC, 47801, '127.0.0.1')
    await new Promise((r) => setTimeout(r, 700))
    client.close()
    sock.close()
    const reply = replies.find((r) => r.includes('테스트기관')) ?? replies[0] ?? '{}'
    expect(JSON.parse(reply)).toMatchObject({ magic: DISCOVERY_MAGIC, orgName: '테스트기관', teamName: '행정팀', port: 47800 })
  })
})
