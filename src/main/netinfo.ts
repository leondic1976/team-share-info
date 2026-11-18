import { networkInterfaces, hostname, homedir } from 'node:os'
import { existsSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { cidrOf } from '../shared/net'

export interface NetIface {
  name: string
  address: string
  netmask: string
  cidr: string | null
  broadcast: string | null
  virtual: boolean
}

const VIRTUAL_RE = /(vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|tap|tun|vpn|zerotier|tailscale|bluetooth)/i

function broadcastOf(address: string, netmask: string): string | null {
  const a = address.split('.').map(Number)
  const m = netmask.split('.').map(Number)
  if (a.length !== 4 || m.length !== 4) return null
  return a.map((v, i) => (v & m[i]) | (~m[i] & 255)).join('.')
}

/** IPv4 adapters, physical-looking ones first (13.13: multiple adapters). */
export function listIpv4(): NetIface[] {
  const out: NetIface[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      out.push({
        name,
        address: a.address,
        netmask: a.netmask,
        cidr: cidrOf(a.address, a.netmask),
        broadcast: broadcastOf(a.address, a.netmask),
        virtual: VIRTUAL_RE.test(name) || a.address.startsWith('169.254.')
      })
    }
  }
  return out.sort((x, y) => Number(x.virtual) - Number(y.virtual))
}

export function pcName(): string {
  return process.env.COMPUTERNAME || hostname()
}

/** A drive that exists and can take data (an empty card reader or a disc in D: does not count). */
export function driveUsable(root: string): boolean {
  try {
    if (!existsSync(root)) return false
    const s = statfsSync(root)
    return s.bavail * s.bsize > 0
  } catch {
    return false
  }
}

/** Server data goes to D: by default, to C: when there is no usable D: drive. */
export function suggestedDataDir(): string {
  if (process.env.TEAMHUB_USERDATA) return join(process.env.TEAMHUB_USERDATA, 'server-data')
  if (driveUsable('D:\\')) return 'D:\\TeamHubData'
  if (driveUsable('C:\\')) return 'C:\\TeamHubData'
  return join(homedir(), 'TeamHubData')
}
