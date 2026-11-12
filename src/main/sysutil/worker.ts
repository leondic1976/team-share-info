import { parentPort } from 'node:worker_threads'
import os from 'node:os'
import si from 'systeminformation'
import type { SysInfo, SysResources } from '../../shared/schemas/sysutil'

/**
 * systeminformation calls (networkStats, networkInterfaces...) block the event loop for
 * hundreds of ms on Windows, so they run here instead of the Electron main thread.
 */
let topCache: { at: number; top: SysResources['top'] } = { at: 0, top: [] }
let netCache: { at: number; rx: number; tx: number } = { at: 0, rx: 0, tx: 0 }
const arr = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v])

async function topProcesses(): Promise<SysResources['top']> {
  if (Date.now() - topCache.at < 8000) return topCache.top
  const p = await si.processes()
  const top = p.list
    .filter((x) => x.name && x.pid > 4 && !/^(System Idle Process|Idle)$/i.test(x.name))
    .sort((a, b) => b.cpu - a.cpu || b.memRss - a.memRss)
    .slice(0, 8)
    .map((x) => ({ name: x.name, pid: x.pid, cpu: Math.round(x.cpu * 10) / 10, memMB: Math.round(x.memRss / 1024) }))
  topCache = { at: Date.now(), top }
  return top
}

async function net(): Promise<{ rx: number; tx: number }> {
  if (Date.now() - netCache.at < 4000) return netCache
  const n = await si.networkStats('*')
  netCache = { at: Date.now(), rx: Math.max(0, Math.round(n.reduce((s, x) => s + (x.rx_sec ?? 0), 0))), tx: Math.max(0, Math.round(n.reduce((s, x) => s + (x.tx_sec ?? 0), 0))) }
  return netCache
}

async function resources(): Promise<SysResources> {
  const [load, mem, fs, n, top] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize(), net(), topProcesses().catch(() => topCache.top)])
  return {
    at: Date.now(),
    cpu: Math.round(load.currentLoad),
    mem: { used: mem.active, total: mem.total },
    disks: fs.filter((d) => d.size > 0).map((d) => ({ mount: d.mount, size: d.size, used: d.used })),
    net: n,
    uptime: os.uptime(),
    top
  }
}

async function info(): Promise<SysInfo> {
  const [osi, cpu, ifs] = await Promise.all([si.osInfo(), si.cpu(), si.networkInterfaces()])
  return {
    pcName: os.hostname(),
    user: os.userInfo().username,
    os: `${osi.distro} ${osi.release} (${osi.build})`,
    cpu: `${cpu.manufacturer} ${cpu.brand}`.trim(),
    cores: cpu.cores,
    ramTotal: os.totalmem(),
    ips: arr(ifs)
      .filter((i) => i.ip4 && !i.internal && !i.virtual)
      .map((i) => ({ iface: i.ifaceName || i.iface, ip: i.ip4, mac: i.mac })),
    bootAt: Date.now() - os.uptime() * 1000
  }
}

async function disks(): Promise<{ mount: string; size: number; used: number }[]> {
  return (await si.fsSize()).map((d) => ({ mount: d.mount, size: d.size, used: d.used }))
}

const handlers: Record<string, () => Promise<unknown>> = { resources, info, disks }

parentPort?.on('message', (m: { id: number; op: string }) => {
  const fn = handlers[m.op]
  if (!fn) return parentPort?.postMessage({ id: m.id, error: 'unknown op' })
  fn().then(
    (data) => parentPort?.postMessage({ id: m.id, data }),
    (e: unknown) => parentPort?.postMessage({ id: m.id, error: (e as Error).message })
  )
})
