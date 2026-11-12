import { parentPort } from 'node:worker_threads'
import { watch, type FSWatcher } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Db } from '../../node/sqlite'
import { FsIndexRepo, type IndexedFile } from '../localdb/fsindex'

/**
 * File-name indexer (6.18 ②) in a worker thread with its own connection to local.db
 * (WAL allows main to read while this writes). Full scans + fs.watch for changes.
 */
let repo: FsIndexRepo | null = null
const watchers = new Map<string, FSWatcher>()
const queue = new Map<string, string>() // path -> root
let flushTimer: NodeJS.Timeout | null = null
const scanning = new Set<string>()

const SKIP = new Set(['$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)', 'programdata', 'appdata', 'node_modules', '.git', '$windows.~bt', '$winreagent', 'recovery', 'msocache'])
const MAX_PER_ROOT = 500_000

const post = (m: unknown): void => parentPort?.postMessage(m)

async function scan(root: string): Promise<void> {
  if (!repo || scanning.has(root)) return
  scanning.add(root)
  post({ type: 'scan', root, state: 'start' })
  const gen = Date.now()
  let batch: IndexedFile[] = []
  let total = 0
  const flush = (): void => {
    if (!batch.length) return
    repo!.upsert(root, gen, batch)
    total += batch.length
    batch = []
    post({ type: 'scan', root, state: 'progress', count: total })
  }
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 30 || total + batch.length >= MAX_PER_ROOT) return
    let d: Awaited<ReturnType<typeof opendir>>
    try {
      d = await opendir(dir)
    } catch {
      return
    }
    const subdirs: string[] = []
    for await (const e of d) {
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) continue
      const isDir = e.isDirectory()
      if (isDir && SKIP.has(e.name.toLowerCase())) continue
      try {
        const s = await lstat(p)
        batch.push({ path: p, name: e.name, dir, size: isDir ? 0 : s.size, mtime: s.mtimeMs, isDir })
      } catch {
        continue
      }
      if (isDir) subdirs.push(p)
      if (batch.length >= 500) flush()
    }
    for (const s of subdirs) await walk(s, depth + 1)
  }
  try {
    await walk(root, 0)
    flush()
    const n = repo.finishScan(root, gen)
    post({ type: 'scan', root, state: 'done', count: n })
  } catch (e) {
    post({ type: 'scan', root, state: 'error', error: (e as Error).message })
  } finally {
    scanning.delete(root)
  }
}

async function flushQueue(): Promise<void> {
  flushTimer = null
  if (!repo) return
  const items = [...queue.entries()]
  queue.clear()
  const add: Record<string, IndexedFile[]> = {}
  for (const [p, root] of items) {
    if (basename(p).toLowerCase() === 'desktop.ini') continue
    try {
      const s = await lstat(p)
      ;(add[root] ??= []).push({ path: p, name: basename(p), dir: dirname(p), size: s.isDirectory() ? 0 : s.size, mtime: s.mtimeMs, isDir: s.isDirectory() })
    } catch {
      repo.removePath(p)
    }
  }
  for (const [root, files] of Object.entries(add)) repo.upsert(root, Date.now(), files)
  if (items.length) post({ type: 'changed', count: items.length })
}

function setWatches(roots: string[]): void {
  for (const [r, w] of watchers) {
    if (!roots.includes(r)) {
      w.close()
      watchers.delete(r)
    }
  }
  for (const r of roots) {
    if (watchers.has(r)) continue
    try {
      const w = watch(r, { recursive: true }, (_ev, file) => {
        if (!file) return
        const rel = file.toString()
        if (rel.split(/[\\/]/).some((part) => SKIP.has(part.toLowerCase()))) return
        queue.set(join(r, rel), r)
        if (!flushTimer) flushTimer = setTimeout(() => void flushQueue(), 800)
      })
      w.on('error', () => {
        w.close()
        watchers.delete(r)
      })
      watchers.set(r, w)
    } catch {
      // folder missing or not watchable
    }
  }
}

parentPort?.on('message', (m: { op: 'init'; dbPath: string } | { op: 'scan'; root: string } | { op: 'watch'; roots: string[] } | { op: 'drop'; root: string }) => {
  if (m.op === 'init') {
    const db = new Db(m.dbPath)
    repo = new FsIndexRepo(db)
  } else if (m.op === 'scan') void scan(m.root)
  else if (m.op === 'watch') setWatches(m.roots)
  else if (m.op === 'drop') {
    watchers.get(m.root)?.close()
    watchers.delete(m.root)
  }
})
