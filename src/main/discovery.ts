import { createSocket } from 'node:dgram'
import { DISCOVERY_MAGIC, DISCOVERY_PORT } from '../shared/constants'
import { listIpv4 } from './netinfo'

export interface DiscoveredServer {
  address: string
  port: number
  url: string
  orgName: string
  teamName: string
  version: string
}

/**
 * Probe the LAN for TeamHub servers (M1-5): send the magic string to every
 * IPv4 broadcast address (plus 255.255.255.255 and loopback) and collect replies.
 */
export function discoverServers(timeoutMs = 1500): Promise<DiscoveredServer[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredServer>()
    const sock = createSocket({ type: 'udp4', reuseAddr: true })
    const finish = (): void => {
      try {
        sock.close()
      } catch {
        // closed
      }
      resolve([...found.values()].sort((a, b) => a.address.localeCompare(b.address)))
    }
    sock.on('message', (msg, rinfo) => {
      try {
        const r = JSON.parse(msg.toString('utf8')) as { magic: string; port: number; orgName: string; teamName: string; version: string }
        if (r.magic !== DISCOVERY_MAGIC) return
        const key = `${rinfo.address}:${r.port}`
        found.set(key, {
          address: rinfo.address,
          port: r.port,
          url: `http://${rinfo.address}:${r.port}`,
          orgName: r.orgName,
          teamName: r.teamName,
          version: r.version
        })
      } catch {
        // ignore malformed replies
      }
    })
    sock.on('error', () => finish())
    sock.bind(0, () => {
      sock.setBroadcast(true)
      const targets = new Set<string>(['255.255.255.255', '127.0.0.1'])
      for (const i of listIpv4()) if (i.broadcast) targets.add(i.broadcast)
      const payload = Buffer.from(DISCOVERY_MAGIC)
      for (const t of targets) {
        sock.send(payload, DISCOVERY_PORT, t, () => undefined)
      }
      setTimeout(finish, timeoutMs)
    })
  })
}
