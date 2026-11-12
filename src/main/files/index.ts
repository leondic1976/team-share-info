import { app, BrowserWindow, globalShortcut } from 'electron'
import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { IndexRoot, SearchHit, SearchQuery } from '../../shared/fm'
import { localDb } from '../localdb'
import { FsIndexRepo } from '../localdb/fsindex'
import { getMainWindow, showMainWindow } from '../windows/main-window'

/** Fast file search (6.18 ②): manages the indexer worker; searches run on main's DB connection. */
let worker: Worker | null = null
const scanning = new Map<string, number>()
const repo = (): FsIndexRepo => new FsIndexRepo(localDb().db)
const RESCAN_MS = 6 * 3600_000
export const SEARCH_SHORTCUT = 'CommandOrControl+Alt+F'

const send = (event: 'fsindex:changed', payload: { scanning: boolean; count: number }): void => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(event, payload)
}

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(join(import.meta.dirname, 'fsindexer.js'))
  worker.postMessage({ op: 'init', dbPath: localDb().db.path })
  worker.on('message', (m: { type: 'scan'; root: string; state: string; count?: number; error?: string } | { type: 'changed'; count: number }) => {
    if (m.type === 'scan') {
      if (m.state === 'start' || m.state === 'progress') scanning.set(m.root, m.count ?? 0)
      else {
        scanning.delete(m.root)
        if (m.state === 'error') log.warn(`[fsindex] scan ${m.root} failed: ${m.error}`)
        else log.info(`[fsindex] ${m.root}: ${m.count} entries`)
      }
      if (m.state !== 'progress' || (m.count ?? 0) % 5000 === 0) send('fsindex:changed', { scanning: scanning.size > 0, count: m.count ?? 0 })
    } else send('fsindex:changed', { scanning: scanning.size > 0, count: m.count })
  })
  worker.on('error', (e) => log.warn('[fsindex] worker error', e))
  worker.on('exit', () => (worker = null))
  worker.unref()
  return worker
}

function activeRoots(): string[] {
  return repo()
    .roots()
    .filter((r) => r.enabled && existsSync(r.path))
    .map((r) => r.path)
}

export function indexRoots(): IndexRoot[] {
  return repo()
    .roots(new Set(scanning.keys()))
    .map((r) => ({ ...r, fileCount: scanning.has(r.path) ? (scanning.get(r.path) ?? r.fileCount) : r.fileCount }))
}

export function rescan(root?: string): void {
  const w = ensureWorker()
  for (const r of root ? [root] : activeRoots()) w.postMessage({ op: 'scan', root: r })
}

export function addIndexRoot(path: string): void {
  repo().addRoot(path)
  ensureWorker().postMessage({ op: 'watch', roots: activeRoots() })
  rescan(path)
}

export function removeIndexRoot(path: string): void {
  ensureWorker().postMessage({ op: 'drop', root: path })
  repo().removeRoot(path)
  send('fsindex:changed', { scanning: scanning.size > 0, count: 0 })
}

export function searchFiles(q: SearchQuery): SearchHit[] {
  return repo().search(q)
}

export function startFileIndex(): void {
  const kv = localDb().kv
  // First run: index the usual personal folders (6.18 ② 기본 폴더).
  if (!kv.get<boolean>('fsindex.initialized')) {
    for (const k of ['desktop', 'documents', 'downloads', 'pictures'] as const) {
      try {
        const p = app.getPath(k)
        if (existsSync(p)) repo().addRoot(p)
      } catch {
        // missing known folder
      }
    }
    kv.set('fsindex.initialized', true)
  }
  if (process.env.TEAMHUB_E2E) return // E2E adds its own roots
  setTimeout(() => {
    const w = ensureWorker()
    w.postMessage({ op: 'watch', roots: activeRoots() })
    for (const r of repo().roots()) if (r.enabled && (!r.lastScanAt || Date.now() - r.lastScanAt > RESCAN_MS)) w.postMessage({ op: 'scan', root: r.path })
  }, 30_000)
  setInterval(() => rescan(), RESCAN_MS).unref()
  try {
    globalShortcut.register(SEARCH_SHORTCUT, () => {
      showMainWindow()
      getMainWindow()?.webContents.send('app:navigate', { path: '/myfiles/search' })
    })
  } catch (e) {
    log.warn('[fsindex] shortcut failed', e)
  }
}

/** E2E: start watching right away (the regular start waits 30 s). */
export function watchNow(): void {
  ensureWorker().postMessage({ op: 'watch', roots: activeRoots() })
}
