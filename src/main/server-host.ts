import { app, powerSaveBlocker, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { HostToServer, ServerStatus, ServerToHost } from '../shared/server-host'
import { feedbackRelayConfig } from './feedback'
import { resourcePath } from './paths'

/**
 * Runs the embedded server in an Electron utilityProcess, watches it and
 * restarts it after crashes (13.3, M1-1).
 */
let child: UtilityProcess | null = null
let config: { dataDir: string } | null = null
let status: ServerStatus = { state: 'stopped', restarts: 0 }
let stopping = false
let blockerId: number | null = null
const listeners = new Set<(s: ServerStatus) => void>()
let readyWaiters: { failFast: boolean; resolve: (s: ServerStatus) => void }[] = []
/** set while the data folder is moved (ipc/storage.ts): nobody else may start the server meanwhile */
let held: string | null = null

/**
 * Keep the server stopped for the data-folder move: while held, starts and restarts from
 * anywhere else (the 서버 다시 시작 button, an update that resumes the server, a restart the
 * server asked for) are refused, so the server never runs on the old folder while it is copied.
 * The holder starts it itself with `{ holder: true }`.
 */
export function holdServer(reason: string | null): void {
  held = reason
}
export const serverHeld = (): boolean => held !== null

function setStatus(s: Partial<ServerStatus>): void {
  status = { ...status, ...s }
  for (const l of listeners) l(status)
  const settled = status.state === 'running' || (status.state === 'error' && status.restarts > 10)
  const failed = status.state === 'error'
  if (settled || failed) {
    const keep: typeof readyWaiters = []
    for (const w of readyWaiters) {
      if (settled || (failed && w.failFast)) w.resolve(status)
      else keep.push(w)
    }
    readyWaiters = keep
  }
}

export function onServerStatus(cb: (s: ServerStatus) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function serverStatus(): ServerStatus {
  return status
}

function spawn(): void {
  // (a restart scheduled after a crash must not start a second process, nor one after a stop)
  if (!config || child || stopping) return
  const entry = join(import.meta.dirname, 'server.js')
  setStatus({ state: 'starting', message: undefined })
  const proc = utilityProcess.fork(entry, [], { serviceName: 'TeamHub Server', stdio: 'pipe' })
  child = proc
  proc.stdout?.on('data', (d: Buffer) => log.info(`[server] ${d.toString().trimEnd()}`))
  proc.stderr?.on('data', (d: Buffer) => {
    const text = d.toString().trimEnd()
    if (!text.includes('ExperimentalWarning') && !text.includes('--trace-warnings')) log.warn(`[server] ${text}`)
  })
  proc.on('message', (msg: ServerToHost) => {
    switch (msg.type) {
      case 'ready':
        log.info(`[server] listening on ${msg.bindIp}:${msg.port}`)
        setStatus({ state: 'running', port: msg.port, restarts: 0 })
        break
      case 'error':
        log.error(`[server] ${msg.message}`)
        // Fatal start errors are followed by an exit and an automatic restart.
        if (msg.fatal) setStatus({ state: 'error', message: msg.message })
        break
      case 'log':
        log[msg.level](`[server] ${msg.message}`)
        break
      case 'restart-requested':
        log.info(`[server] restart requested: ${msg.reason}`)
        void restartServer()
        break
      case 'stopped':
        break
    }
  })
  proc.on('exit', (code) => {
    child = null
    if (stopping) {
      setStatus({ state: 'stopped' })
      return
    }
    log.error(`[server] exited unexpectedly (code ${code})`)
    const restarts = status.restarts + 1
    setStatus({ state: 'error', message: `서버 프로세스가 종료되었습니다(code ${code}). 다시 시작합니다.`, restarts })
    if (restarts <= 10) setTimeout(spawn, Math.min(30000, 1000 * 2 ** Math.min(restarts, 5)))
    else setStatus({ state: 'error', restarts })
  })
  const start: HostToServer = { type: 'start', dataDir: config.dataDir, version: app.getVersion(), feedback: feedbackRelayConfig(), formsDir: resourcePath('forms') }
  proc.postMessage(start)
}

export function startServer(dataDir: string, opts: { preventSleep: boolean; failFast?: boolean; holder?: boolean }): Promise<ServerStatus> {
  if (held && !opts.holder) {
    log.warn(`[server] start refused: ${held}`)
    return Promise.resolve({ ...status, message: '서버 자료를 옮기는 중입니다. 끝나면 서버가 다시 켜집니다.' })
  }
  config = { dataDir }
  stopping = false
  if (opts.preventSleep && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension')
  if (!opts.preventSleep && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
  const p = new Promise<ServerStatus>((resolve) => readyWaiters.push({ failFast: !!opts.failFast, resolve }))
  if (!child) spawn()
  else setStatus({})
  return p
}

export async function stopServer(): Promise<void> {
  stopping = true
  const proc = child
  if (!proc) return
  await new Promise<void>((resolve) => {
    // after a forced kill, still wait (up to 5 s) for the process to be gone, so its
    // database files are closed before anyone (data-folder move, restore) touches them
    let hard: NodeJS.Timeout | null = null
    const timer = setTimeout(() => {
      proc.kill()
      hard = setTimeout(resolve, 5000)
    }, 3000)
    proc.once('exit', () => {
      clearTimeout(timer)
      if (hard) clearTimeout(hard)
      resolve()
    })
    const msg: HostToServer = { type: 'stop' }
    proc.postMessage(msg)
  })
  child = null
  if (blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
  setStatus({ state: 'stopped' })
}

export async function restartServer(): Promise<ServerStatus> {
  if (held) {
    log.warn(`[server] restart refused: ${held}`)
    return status
  }
  const dataDir = config?.dataDir
  await stopServer()
  if (!dataDir) return status
  return startServer(dataDir, { preventSleep: blockerId !== null })
}
