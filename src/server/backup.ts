import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Db } from '../node/sqlite'
import { BACKUP_STALE_MS, type BackupAlert, type BackupHealth } from '../shared/schemas/settings'
import type { ServerContext } from './context'
import { getSection } from './settings'

/**
 * Server backup (6.16, M8-1). A backup is a folder with a consistent DB snapshot
 * (VACUUM INTO) and a manifest. Files are content-addressed and never change, so they
 * go into a shared `blobs/` store next to the backups and only new ones are copied.
 */

export interface BackupInfo {
  name: string
  path: string
  createdAt: number
  version: string
  dbBytes: number
  fileCount: number
  fileBytes: number
}

export interface BackupState {
  lastAt: number | null
  lastPath: string | null
  lastError: string | null
  lastErrorAt?: number | null
  /** scheduled time of the last automatic run (so each day's slot runs once) */
  lastAutoDue?: number | null
}

const MANIFEST = 'manifest.json'
const pad = (n: number): string => String(n).padStart(2, '0')
const stamp = (d = new Date()): string => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

export function backupRoot(db: Db, dataDir: string): string {
  const dir = getSection(db, 'backup').dir.trim()
  return dir || join(dataDir, 'backups', 'auto')
}

/**
 * The volume a path is on, for telling whether backups share a disk with the data: the drive
 * (`c:`) or the network share root (`\\server\share`), lower case; '' when there is none.
 */
export function volumeOf(p: string): string {
  let s = p.trim().replace(/\//g, '\\')
  if (/^\\\\\?\\UNC\\/i.test(s)) s = `\\\\${s.slice(8)}`
  else if (/^\\\\[?.]\\/.test(s)) s = s.slice(4)
  const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(s)
  if (unc) return `\\\\${unc[1]}\\${unc[2]}`.toLowerCase()
  const drive = /^([a-z]):/i.exec(s)
  return drive ? `${drive[1].toLowerCase()}:` : ''
}

/** True when `backupDir` is on the same drive or network share as `dataDir`. */
export function sameVolume(backupDir: string, dataDir: string): boolean {
  return volumeOf(backupDir) === volumeOf(dataDir)
}

export function readState(db: Db): BackupState {
  const r = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'backupState'`)
  try {
    return r ? (JSON.parse(r.value) as BackupState) : { lastAt: null, lastPath: null, lastError: null }
  } catch {
    return { lastAt: null, lastPath: null, lastError: null }
  }
}
function writeState(db: Db, s: BackupState): void {
  db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('backupState', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [JSON.stringify(s), Date.now()])
}

/** Copy blobs referenced by `dbFile` from `filesDir` into `store` when missing. */
function copyBlobs(dbFile: string, filesDir: string, store: string): { count: number; bytes: number } {
  const ro = new DatabaseSync(dbFile, { readOnly: true })
  let count = 0
  let bytes = 0
  try {
    for (const b of ro.prepare('SELECT path, size FROM blobs').all() as { path: string; size: number }[]) {
      const src = join(filesDir, b.path)
      const dst = join(store, b.path)
      count++
      bytes += b.size
      if (existsSync(dst) || !existsSync(src)) continue
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(src, dst)
    }
  } finally {
    ro.close()
  }
  return { count, bytes }
}

export function listBackups(root: string): BackupInfo[] {
  if (!existsSync(root)) return []
  const out: BackupInfo[] = []
  for (const name of readdirSync(root)) {
    const m = join(root, name, MANIFEST)
    if (!existsSync(m)) continue
    try {
      out.push({ ...(JSON.parse(readFileSync(m, 'utf8')) as Omit<BackupInfo, 'name' | 'path'>), name, path: join(root, name) })
    } catch {
      // damaged manifest
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

/** Keep the newest `keep` backups and drop blobs no kept backup refers to. */
export function prune(root: string, keep: number): number {
  const all = listBackups(root)
  const drop = all.slice(keep)
  for (const b of drop) rmSync(b.path, { recursive: true, force: true })
  const store = join(root, 'blobs')
  if (!existsSync(store)) return drop.length
  const keepPaths = new Set<string>()
  for (const b of all.slice(0, keep)) {
    const ro = new DatabaseSync(join(b.path, 'teamhub.db'), { readOnly: true })
    try {
      for (const r of ro.prepare('SELECT path FROM blobs').all() as { path: string }[]) keepPaths.add(r.path.replace(/\\/g, '/'))
    } finally {
      ro.close()
    }
  }
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(dir, e.name), r)
      else if (!keepPaths.has(r)) rmSync(join(dir, e.name), { force: true })
    }
  }
  walk(store, '')
  return drop.length
}

export function runBackup(ctx: ServerContext, root = backupRoot(ctx.db, ctx.dataDir)): BackupInfo {
  try {
    mkdirSync(root, { recursive: true })
    let name = `TeamHub-${stamp()}`
    for (let i = 2; existsSync(join(root, name)); i++) name = `TeamHub-${stamp()}-${i}`
    const folder = join(root, name)
    mkdirSync(folder)
    const dbFile = join(folder, 'teamhub.db')
    ctx.db.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`)
    // 긴급구조지휘대 keeps its data in a file of its own next to teamhub.db
    const cmdSrc = join(ctx.dataDir, 'command.db')
    if (existsSync(cmdSrc)) {
      const cmd = new DatabaseSync(cmdSrc)
      try {
        cmd.exec(`VACUUM INTO '${join(folder, 'command.db').replace(/'/g, "''")}'`)
      } finally {
        cmd.close()
      }
    }
    const { count, bytes } = copyBlobs(dbFile, join(ctx.dataDir, 'files'), join(root, 'blobs'))
    const info = { createdAt: Date.now(), version: ctx.version, dbBytes: statSync(dbFile).size, fileCount: count, fileBytes: bytes }
    writeFileSync(join(folder, MANIFEST), JSON.stringify(info, null, 2))
    prune(root, getSection(ctx.db, 'backup').keep)
    writeState(ctx.db, { ...readState(ctx.db), lastAt: info.createdAt, lastPath: folder, lastError: null, lastErrorAt: null })
    return { ...info, name, path: folder }
  } catch (e) {
    writeState(ctx.db, { ...readState(ctx.db), lastError: (e as Error).message, lastErrorAt: Date.now() })
    throw e
  }
}

/**
 * Whether the daily job runs at its next check: today's slot is due and has not run yet, or the
 * last successful backup is stale (the server PC was off at the backup time, e.g. over a weekend),
 * which runs a catch-up at once and takes today's slot.
 */
function jobDue(db: Db, now: Date): { due: number; run: boolean } {
  const [h, m] = getSection(db, 'backup').time.split(':').map(Number)
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).getTime()
  const st = readState(db)
  if ((st.lastAutoDue ?? 0) >= due) return { due, run: false }
  const stale = st.lastAt != null && now.getTime() - st.lastAt > BACKUP_STALE_MS
  return { due, run: now.getTime() >= due || stale }
}

/** Daily automatic backup at the configured time (checked every minute). */
export function runBackupJob(ctx: ServerContext, now = new Date()): BackupInfo | null {
  const { due, run } = jobDue(ctx.db, now)
  if (!run) return null
  try {
    return runBackup(ctx)
  } finally {
    writeState(ctx.db, { ...readState(ctx.db), lastAutoDue: due })
  }
}

/** Where backups go and whether they can be relied on (same disk as the data, stale, failed). */
export function backupHealth(db: Db, dataDir: string, now = Date.now()): BackupHealth {
  const dir = getSection(db, 'backup').dir.trim()
  const root = backupRoot(db, dataDir)
  const st = readState(db)
  // never backed up: counted from when the team began
  const since = st.lastAt ?? db.get<{ at: number | null }>('SELECT MIN(created_at) AS at FROM members')?.at ?? null
  return {
    root,
    isDefault: !dir,
    sameDrive: !dir || sameVolume(root, dataDir),
    lastAt: st.lastAt,
    lastError: st.lastError,
    lastErrorAt: st.lastErrorAt ?? null,
    stale: since != null && now - since > BACKUP_STALE_MS,
    failed: !!st.lastError,
    pending: jobDue(db, new Date(now)).run
  }
}

/** The 최종관리자's reminder: failing or stale backups, unless the daily job is about to run. */
export function backupAlert(h: BackupHealth): BackupAlert | null {
  if (h.pending || (!h.failed && !h.stale)) return null
  return { kind: h.failed ? 'failed' : 'stale', lastAt: h.lastAt, lastError: h.lastError }
}

function isBackupFolder(p: string): boolean {
  return existsSync(join(p, MANIFEST)) && existsSync(join(p, 'teamhub.db'))
}

/**
 * Put a backup in place of the server data in `dataDir` (restore, or moving the server
 * to another PC). The current DB is kept as backups/before-restore-<time>.db.
 */
export function installBackup(backupPath: string, dataDir: string): void {
  if (!isBackupFolder(backupPath)) throw new Error('TeamHub 백업 폴더가 아닙니다(manifest.json, teamhub.db 없음).')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'teamhub.db')
  if (existsSync(dbPath)) {
    const keep = join(dataDir, 'backups')
    mkdirSync(keep, { recursive: true })
    renameSync(dbPath, join(keep, `before-restore-${stamp()}.db`))
  }
  for (const ext of ['-wal', '-shm']) rmSync(dbPath + ext, { force: true })
  copyFileSync(join(backupPath, 'teamhub.db'), dbPath)
  // 긴급구조지휘대 (command.db): the backup's copy, the current one kept aside like teamhub.db
  const cmdPath = join(dataDir, 'command.db')
  if (existsSync(join(backupPath, 'command.db'))) {
    if (existsSync(cmdPath)) {
      mkdirSync(join(dataDir, 'backups'), { recursive: true })
      renameSync(cmdPath, join(dataDir, 'backups', `before-restore-${stamp()}-command.db`))
    }
    for (const ext of ['-wal', '-shm']) rmSync(cmdPath + ext, { force: true })
    copyFileSync(join(backupPath, 'command.db'), cmdPath)
  }
  // files: from the shared store next to the backup folder
  copyBlobs(dbPath, join(dirname(backupPath), 'blobs'), join(dataDir, 'files'))
}

const PENDING = 'restore-pending.json'
export function stageRestore(dataDir: string, backupPath: string): void {
  if (!isBackupFolder(backupPath)) throw new Error('백업을 찾을 수 없습니다.')
  writeFileSync(join(dataDir, PENDING), JSON.stringify({ backupPath, at: Date.now() }))
}
/** Called by the server process before opening the DB. */
export function applyPendingRestore(dataDir: string): string | null {
  const f = join(dataDir, PENDING)
  if (!existsSync(f)) return null
  const { backupPath } = JSON.parse(readFileSync(f, 'utf8')) as { backupPath: string }
  rmSync(f, { force: true })
  installBackup(backupPath, dataDir)
  return backupPath
}
