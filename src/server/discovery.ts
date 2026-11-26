import { createSocket, type Socket } from 'node:dgram'
import { DISCOVERY_MAGIC, DISCOVERY_PORT } from '../shared/constants'
import type { ServerContext } from './context'
import { getSection, isInitialized } from './settings'

export interface DiscoveryReply {
  magic: typeof DISCOVERY_MAGIC
  orgName: string
  teamName: string
  port: number
  version: string
}

/**
 * Answers LAN discovery probes on UDP 47801 (M1-5). `host` 127.0.0.1 keeps it on this PC
 * (development, tests, E2E); left out, it answers on every network of the installed app.
 */
export function startDiscoveryResponder(ctx: ServerContext, onError: (msg: string) => void, host?: string): Socket {
  const sock = createSocket({ type: 'udp4', reuseAddr: true })
  sock.on('message', (msg, rinfo) => {
    if (msg.toString('utf8').trim() !== DISCOVERY_MAGIC) return
    if (!isInitialized(ctx.db)) return
    const org = getSection(ctx.db, 'org')
    const reply: DiscoveryReply = {
      magic: DISCOVERY_MAGIC,
      orgName: org.orgName,
      teamName: org.teamName,
      port: getSection(ctx.db, 'network').port,
      version: ctx.version
    }
    sock.send(Buffer.from(JSON.stringify(reply)), rinfo.port, rinfo.address)
  })
  sock.on('error', (e) => onError(`discovery: ${e.message}`))
  sock.bind(DISCOVERY_PORT, host)
  return sock
}
