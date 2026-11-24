import { backup, DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LOCAL_BACKUP_KEEP_DEFAULT, LOCAL_BACKUP_KEEP_MAX, LOCAL_BACKUP_KEEP_MIN } from '../shared/constants'
import { fmtBytes } from './datamove'

/**
 * 내 자료 백업 · 복구: snapshots of the personal DB (local.db) of this PC.
 *
 * Snapshots are whole SQLite files made with the online backup, kept in `backups/` next to
 * the DB (so they follow 내 자료 저장 위치) and named by local date and time:
 *   local-20261124-093000-auto.db     the daily one (the newest N are kept)
 *   local-20261124-141500-manual.db   지금 백업 (kept until the user removes it)
 *   local-20261124-141730-safety.db   made right before a restore (the newest few are kept)
 * A restore is staged (restore-pending.db/.json) and swapped in at the next start, before
 * the DB is opened. Bookkeeping only; knows nothing about Electron.
 */
export const BACKUP_DIR = 'backups'
export type SnapshotKind = 'auto' | 'manual' | 'safety'
export interface Snapshot {
  id: string
  kind: SnapshotKind
  at: number
  bytes: number
}

/** The only names a snapshot can have: this is what the renderer may send as an id. */
export const SNAPSHOT_ID_RE = /^local-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(auto|manual|safety)\.db$/
/** Snapshots made right before a restore that are kept. */
export const SAFETY_KEEP = 3
const DAY = 86400_000
const PENDING_DB = 'restore-pending.db'
const PENDING_JSON = 'restore-pending.json'
const STATE = 'state.json'

const p2 = (n: number): string => String(n).padStart(2, '0')

export function snapshotName(at: number, kind: SnapshotKind): string {
  const d = new Date(at)
  return `local-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${kind}.db`
}

/** Time and kind of a snapshot from its name; null for anything that is not a snapshot name. */
export function parseSnapshotId(id: unknown): { at: number; kind: SnapshotKind } | null {
  if (typeof id !== 'string') return null
  const m = SNAPSHOT_ID_RE.exec(id)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number)
  const date = new Date(y, mo - 1, d, h, mi, s)
  // (an impossible date such as 20261340 rolls over: refused)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi || date.getSeconds() !== s) return null
  return { at: date.getTime(), kind: m[7] as SnapshotKind }
}

/** Full path of a snapshot inside `dir`; null unless the id is a snapshot name (no path can be passed). */
export function snapshotPath(dir: string, id: unknown): string | null {
  return parseSnapshotId(id) ? join(dir, id as string) : null
}

/** Snapshots in the folder, newest first. Anything else in the folder is ignored. */
export function listSnapshots(dir: string): Snapshot[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: Snapshot[] = []
  for (const id of names) {
    const p = parseSnapshotId(id)
    if (!p) continue
    try {
      const st = statSync(join(dir, id))
      if (st.isFile()) out.push({ id, kind: p.kind, at: p.at, bytes: st.size })
    } catch {
      // gone meanwhile
    }
  }
  return out.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
}

export function clampKeep(n: unknown): number {
  const v = Math.round(Number(n))
  return Number.isFinite(v) ? Math.min(LOCAL_BACKUP_KEEP_MAX, Math.max(LOCAL_BACKUP_KEEP_MIN, v)) : LOCAL_BACKUP_KEEP_DEFAULT
}

/**
 * Which snapshots go: daily ones beyond the newest `keep`, and snapshots made before a
 * restore beyond the newest few. Manual ones are the user's and never go by themselves.
 */
export function snapshotsToPrune(snaps: Snapshot[], keep: number): string[] {
  const sorted = [...snaps].sort((a, b) => b.at - a.at)
  const over = (kind: SnapshotKind, n: number): string[] =>
    sorted
      .filter((s) => s.kind === kind)
      .slice(n)
      .map((s) => s.id)
  return [...over('auto', clampKeep(keep)), ...over('safety', SAFETY_KEEP)]
}

/** `except`: a snapshot that stays whatever the rules say (the one being restored). */
export function pruneSnapshots(dir: string, keep: number, except?: string): string[] {
  const gone: string[] = []
  for (const id of snapshotsToPrune(listSnapshots(dir), keep)) {
    if (id === except) continue
    try {
      rmSync(join(dir, id), { force: true })
      gone.push(id)
    } catch {
      // tried again after the next backup
    }
  }
  return gone
}

// ---------- "did the DB change since the last snapshot" ----------

/** Size and time of the DB file and its write-ahead log: cheap, and different after any write. */
export interface DbSig {
  size: number
  mtimeMs: number
  walSize: number
  walMtimeMs: number
}
export function dbSignature(dbFile: string): DbSig {
  const of = (p: string): { size: number; mtimeMs: number } => {
    try {
      const st = statSync(p)
      return { size: st.size, mtimeMs: Math.round(st.mtimeMs) }
    } catch {
      return { size: 0, mtimeMs: 0 }
    }
  }
  const a = of(dbFile)
  const w = of(`${dbFile}-wal`)
  return { size: a.size, mtimeMs: a.mtimeMs, walSize: w.size, walMtimeMs: w.mtimeMs }
}
export const sameSig = (a: DbSig | null | undefined, b: DbSig | null | undefined): boolean => !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.walSize === b.walSize && a.walMtimeMs === b.walMtimeMs

// ---------- state kept next to the snapshots ----------

export interface BackupState {
  keep: number
  /** Last daily run that made a snapshot or found nothing changed. */
  lastAutoAt: number
  /** The DB as it was at the last snapshot. */
  lastSig: DbSig | null
  /** Why the last daily run was skipped (shown in settings). */
  note: string | null
  /** Result of the last restore (shown once). */
  restore: { ok: boolean; message: string; at: number } | null
}

export function readState(dir: string): BackupState {
  let raw: Partial<BackupState> = {}
  try {
    raw = JSON.parse(readFileSync(join(dir, STATE), 'utf8')) as Partial<BackupState>
  } catch {
    // first run, or an unreadable file: defaults
  }
  const sig = raw.lastSig
  const r = raw.restore
  return {
    keep: clampKeep(raw.keep ?? LOCAL_BACKUP_KEEP_DEFAULT),
    lastAutoAt: typeof raw.lastAutoAt === 'number' && Number.isFinite(raw.lastAutoAt) ? raw.lastAutoAt : 0,
    lastSig: sig && [sig.size, sig.mtimeMs, sig.walSize, sig.walMtimeMs].every((n) => typeof n === 'number') ? sig : null,
    note: typeof raw.note === 'string' && raw.note ? raw.note : null,
    restore: r && typeof r.message === 'string' ? { ok: !!r.ok, message: r.message, at: Number(r.at) || 0 } : null
  }
}
export function writeState(dir: string, s: BackupState): void {
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `${STATE}.tmp`)
  writeFileSync(tmp, JSON.stringify(s, null, 2))
  renameSync(tmp, join(dir, STATE))
}

/** The daily run is due: none in the last 24 hours (a clock set back counts as due). */
export function autoDue(state: BackupState, now: number): boolean {
  return !state.lastAutoAt || now - state.lastAutoAt >= DAY || state.lastAutoAt > now
}

// ---------- making and checking snapshots ----------

/** Free bytes of the drive that holds `dir`; null when it cannot be told. */
export function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** Room a copy of `bytes` needs: the file, 10% and 50 MB of headroom (as for a storage move). */
export const spaceNeeded = (bytes: number): number => Math.ceil(bytes * 1.1) + 50 * 1024 * 1024

/**
 * null when the file is a personal DB that can be used: it opens, passes
 * `PRAGMA integrity_check`, has the tables of a TeamHub local DB and was not made by a
 * newer program than this one (`maxMigration`: the newest migration this program knows).
 */
export function verifySnapshot(file: string, maxMigration?: number): string | null {
  // reading a file that was in WAL mode makes -wal/-shm files next to it: they are not left behind
  const side = ['-wal', '-shm'].map((e) => file + e).filter((f) => !existsSync(f))
  try {
    return check(file, maxMigration)
  } finally {
    for (const f of side) {
      try {
        rmSync(f, { force: true })
      } catch {
        // an empty side file is harmless
      }
    }
  }
}
function check(file: string, maxMigration?: number): string | null {
  let db: DatabaseSync
  try {
    if (!statSync(file).isFile() || statSync(file).size < 100) return '백업 파일이 비어 있거나 손상되었습니다.'
    db = new DatabaseSync(file, { readOnly: true })
  } catch {
    return '백업 파일을 열 수 없습니다.'
  }
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Record<string, string>[]
    const first = rows[0] ? Object.values(rows[0])[0] : 'no result'
    if (rows.length !== 1 || first !== 'ok') return '백업 파일이 손상되었습니다(검사 실패).'
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name))
    if (!tables.has('_migrations') || !tables.has('kv')) return 'TeamHub 개인 자료 파일이 아닙니다.'
    if (maxMigration !== undefined) {
      const top = (db.prepare('SELECT MAX(id) AS id FROM _migrations').get() as { id: number | null }).id ?? 0
      if (top > maxMigration) return '이 프로그램보다 새 버전에서 만든 자료입니다. 프로그램을 업데이트한 뒤 다시 해 보세요.'
    }
    return null
  } catch {
    return '백업 파일이 손상되었습니다(읽을 수 없음).'
  } finally {
    db.close()
  }
}

export type SnapshotResult = { ok: true; id: string; bytes: number } | { ok: false; reason: 'space' | 'error'; error: string }

/**
 * Snapshot of the open DB into `dir`. The online backup copies in small steps on its own
 * and does not hold up the caller's thread; the file gets its name only once it is complete
 * and verified. Skipped (reason `space`) when the drive is short of room.
 */
export async function makeSnapshot(opts: { db: DatabaseSync; dbFile: string; dir: string; kind: SnapshotKind; now: number; free?: (dir: string) => number | null; maxMigration?: number }): Promise<SnapshotResult> {
  const { db, dbFile, dir, kind } = opts
  let tmp = ''
  try {
    mkdirSync(dir, { recursive: true })
    const sig = dbSignature(dbFile)
    const need = spaceNeeded(sig.size + sig.walSize)
    const free = (opts.free ?? freeBytes)(dir)
    if (free !== null && free < need) return { ok: false, reason: 'space', error: `빈 공간이 모자라 백업하지 못했습니다(필요 ${fmtBytes(need)}, 남은 공간 ${fmtBytes(free)}).` }
    // two snapshots of one kind within a second: the later one gets the next free second
    let at = opts.now
    while (existsSync(join(dir, snapshotName(at, kind)))) at += 1000
    const id = snapshotName(at, kind)
    tmp = join(dir, `${id}.tmp`)
    rmSync(tmp, { force: true })
    await backup(db, tmp)
    // one self-contained file: the copy leaves the write-ahead mode of the live DB behind
    const copy = new DatabaseSync(tmp)
    try {
      copy.exec('PRAGMA journal_mode = DELETE')
    } finally {
      copy.close()
    }
    const bad = verifySnapshot(tmp, opts.maxMigration)
    if (bad) throw new Error(bad)
    renameSync(tmp, join(dir, id))
    return { ok: true, id, bytes: statSync(join(dir, id)).size }
  } catch (e) {
    if (tmp) rmSync(tmp, { force: true })
    return { ok: false, reason: 'error', error: (e as Error).message }
  }
}

// ---------- restore: staged now, swapped in at the next start ----------

export interface PendingRestore {
  /** What is restored: a snapshot id, or the name of an imported file. */
  from: string
  at: number
}

/**
 * Stage `srcFile` (already verified) as the DB to start with next time. The current DB is
 * not touched here; throws when the copy cannot be made.
 */
export async function stageRestore(dir: string, srcFile: string, from: string, now: number, maxMigration?: number): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const staged = join(dir, PENDING_DB)
  rmSync(join(dir, PENDING_JSON), { force: true })
  rmSync(staged, { force: true })
  try {
    await copyFile(srcFile, staged)
    const bad = verifySnapshot(staged, maxMigration)
    if (bad) throw new Error(bad)
    const pending: PendingRestore = { from, at: now }
    writeFileSync(join(dir, PENDING_JSON), JSON.stringify(pending))
  } catch (e) {
    rmSync(staged, { force: true })
    throw e
  }
}

export function restorePending(dir: string): boolean {
  return existsSync(join(dir, PENDING_JSON))
}

/**
 * At start, before the DB is opened: put a staged restore in place. The staged file is
 * checked again; the current DB (and its write-ahead log, which must never be applied to
 * another DB) is set aside and comes back if the swap fails. Never throws.
 * Returns null when nothing was staged.
 */
export function applyPendingRestore(dir: string, dbFile: string, opts: { maxMigration?: number; now?: number; rename?: (a: string, b: string) => void } = {}): { ok: boolean; message: string; at: number } | null {
  const json = join(dir, PENDING_JSON)
  const staged = join(dir, PENDING_DB)
  const at = opts.now ?? Date.now()
  if (!existsSync(json)) {
    rmSync(staged, { force: true })
    return null
  }
  const rename = opts.rename ?? renameSync
  const SIDE = ['', '-wal', '-shm']
  const aside = (ext: string): string => `${dbFile}.replaced${ext}`
  const result = (ok: boolean, message: string): { ok: boolean; message: string; at: number } => {
    try {
      rmSync(json, { force: true })
      rmSync(staged, { force: true })
    } catch {
      // a leftover is handled at the next start
    }
    return { ok, message, at }
  }
  try {
    let label = ''
    try {
      label = String((JSON.parse(readFileSync(json, 'utf8')) as PendingRestore).from ?? '')
    } catch {
      // the note is unreadable; the staged file decides
    }
    const p = parseSnapshotId(label)
    const what = p ? `${fmtTime(p.at)} 백업` : '가져온 파일'
    if (!existsSync(staged)) {
      // the swap was done and the program stopped before tidying up
      for (const ext of SIDE) rmSync(aside(ext), { force: true })
      return result(true, `${what}(으)로 복구했습니다.`)
    }
    const bad = verifySnapshot(staged, opts.maxMigration)
    if (bad) return result(false, `복구하지 못했습니다(지금 자료를 그대로 씁니다): ${bad}`)
    for (const ext of SIDE) rmSync(aside(ext), { force: true })
    const moved: string[] = []
    try {
      for (const ext of SIDE) {
        if (!existsSync(dbFile + ext)) continue
        rename(dbFile + ext, aside(ext))
        moved.push(ext)
      }
      rename(staged, dbFile)
    } catch (e) {
      for (const ext of moved.reverse()) {
        try {
          renameSync(aside(ext), dbFile + ext)
        } catch {
          // reported below
        }
      }
      return result(false, `복구하지 못했습니다(지금 자료를 그대로 씁니다): ${(e as Error).message}`)
    }
    for (const ext of SIDE) rmSync(aside(ext), { force: true })
    return result(true, `${what}(으)로 복구했습니다. 복구 직전의 자료는 백업 목록의 "복구 직전" 항목에 있습니다.`)
  } catch (e) {
    return result(false, `복구하지 못했습니다(지금 자료를 그대로 씁니다): ${(e as Error).message}`)
  }
}

export function fmtTime(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** Bytes of everything in the backups folder. */
export function backupBytes(dir: string): number {
  return listSnapshots(dir).reduce((n, s) => n + s.bytes, 0)
}
