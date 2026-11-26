/**
 * Server entry point, run inside an Electron utilityProcess (13.3).
 * Talks to the main process only through process.parentPort messages.
 */
import type { Socket } from 'node:dgram'
import type { FeedbackRelayConfig, HostToServer, ServerToHost } from '../shared/server-host'
import type { Db } from '../node/sqlite'
import { openServerDb } from './db'
import { applyPendingRestore } from './backup'
import { buildApp, type BuiltApp } from './app'
import { getSection } from './settings'
import { startDiscoveryResponder } from './discovery'
import { writeLatestYml } from './routes/updates'
import { seedForms } from './forms-seed'

process.removeAllListeners('warning')

interface ParentPort {
  on(event: 'message', cb: (e: { data: HostToServer }) => void): void
  postMessage(msg: ServerToHost): void
}
const parent = (process as unknown as { parentPort?: ParentPort }).parentPort

let built: BuiltApp | null = null
let db: Db | null = null
let udp: Socket | null = null

function post(msg: ServerToHost): void {
  parent?.postMessage(msg)
}

/** Where the server listens: the office network only for the installed app (HostToServer `lan`), else this PC. */
const LOOPBACK = '127.0.0.1'
function listenHost(lan: boolean, bindIp: string): string {
  return lan ? bindIp || '0.0.0.0' : LOOPBACK
}

async function start(dataDir: string, version: string, feedback?: FeedbackRelayConfig, formsDir?: string, lan = false): Promise<void> {
  const restored = applyPendingRestore(dataDir)
  if (restored) post({ type: 'log', level: 'info', message: `restored backup ${restored}` })
  db = openServerDb(dataDir, version)
  built = await buildApp({ db, dataDir, version, feedback, log: (level, message) => post({ type: 'log', level, message }) })
  try {
    const forms = seedForms(built.ctx, formsDir)
    if (forms.folderId) post({ type: 'log', level: 'info', message: `forms library: ${forms.added} added, ${forms.updated} updated` })
  } catch (e) {
    // the server must start even when the shipped forms cannot be read
    post({ type: 'log', level: 'warn', message: `forms library skipped: ${String(e)}` })
  }
  const net = getSection(db, 'network')
  let lastPort = net.port
  built.ctx.onSettingsChanged = () => {
    const n = getSection(db!, 'network')
    if (n.port !== lastPort) {
      lastPort = n.port
      post({ type: 'restart-requested', reason: 'port changed' })
    }
  }
  built.ctx.requestRestart = (reason) => post({ type: 'restart-requested', reason })
  writeLatestYml(built.ctx)
  const host = listenHost(lan, net.bindIp)
  await built.app.listen({ port: net.port, host })
  try {
    udp = startDiscoveryResponder(built.ctx, (m) => post({ type: 'log', level: 'warn', message: m }), lan ? undefined : LOOPBACK)
  } catch (e) {
    post({ type: 'log', level: 'warn', message: `discovery disabled: ${String(e)}` })
  }
  post({ type: 'ready', port: net.port, bindIp: host })
}

async function stop(): Promise<void> {
  try {
    built?.ctx.hub.broadcast('server.shutdown', {})
    udp?.close()
    await built?.app.close()
  } catch {
    // ignore
  }
  db?.close()
  built = null
  db = null
  post({ type: 'stopped' })
}

parent?.on('message', (e) => {
  const msg = e.data
  if (msg.type === 'start') {
    start(msg.dataDir, msg.version, msg.feedback, msg.formsDir, msg.lan === true).catch((err: unknown) => {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err), fatal: true })
      // Exit so the host restarts us with back-off (e.g. the port is still held by a dying process).
      db?.close()
      setTimeout(() => process.exit(1), 200)
    })
  } else if (msg.type === 'stop') {
    void stop().then(() => process.exit(0))
  }
})

process.on('uncaughtException', (err) => post({ type: 'error', message: `uncaught: ${err.message}`, fatal: false }))
process.on('unhandledRejection', (err) => post({ type: 'error', message: `unhandled: ${String(err)}`, fatal: false }))
