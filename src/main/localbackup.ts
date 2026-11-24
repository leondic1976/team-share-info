import { app } from 'electron'
import log from 'electron-log/main'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import {
  applyPendingRestore,
  autoDue,
  BACKUP_DIR,
  backupBytes,
  clampKeep,
  dbSignature,
  freeBytes,
  listSnapshots,
  makeSnapshot,
  pruneSnapshots,
  readState,
  sameSig,
  snapshotPath,
  spaceNeeded,
  stageRestore,
  verifySnapshot,
  writeState,
  type SnapshotKind
} from '../node/localbackup'
import { fmtBytes } from '../node/datamove'
import type { LocalBackupInfo, LocalBackupResult } from '../shared/ipc'
import { localDb } from './localdb'
import { LOCAL_MIGRATIONS } from './localdb/migrations'
import { localDataPath } from './storage'
import { setQuitting } from './windows/main-window'

/**
 * 내 자료 백업 · 복구 (every PC): daily snapshots of the personal DB next to it, and restore
 * from one of them. On a shared PC this runs inside the signed-in person's session, so it
 * works on that person's DB and folder only. The bookkeeping is in node/localbackup.ts.
 */
const dir = (): string => localDataPath(BACKUP_DIR)
const MAX_MIGRATION = Math.max(...LOCAL_MIGRATIONS.map((m) => m.id))
const HOUR = 3600_000

let busy = false
let timer: NodeJS.Timeout | null = null
let first: NodeJS.Timeout | null = null

/** At start, before the local DB opens: carry out a restore that was staged before the restart. */
export function applyStagedRestore(dbFile: string): void {
  try {
    const r = applyPendingRestore(dir(), dbFile, { maxMigration: MAX_MIGRATION })
    if (!r) return
    writeState(dir(), { ...readState(dir()), restore: r })
    log[r.ok ? 'info' : 'error'](`[backup] staged restore: ${r.ok ? 'done' : r.message}`)
  } catch (e) {
    log.error('[backup] staged restore failed', e)
  }
}

async function snapshot(kind: SnapshotKind, protect?: string): Promise<LocalBackupResult & { space?: boolean }> {
  if (busy) return { ok: false, error: '백업하는 중입니다. 잠시 뒤 다시 해 보세요.' }
  busy = true
  try {
    const db = localDb().db
    const r = await makeSnapshot({ db: db.raw, dbFile: db.path, dir: dir(), kind, now: Date.now(), maxMigration: MAX_MIGRATION })
    if (!r.ok) {
      log.warn(`[backup] ${kind} snapshot not made: ${r.error}`)
      return { ok: false, error: r.reason === 'space' ? r.error : `백업하지 못했습니다: ${r.error}`, space: r.reason === 'space' }
    }
    const st = readState(dir())
    writeState(dir(), { ...st, lastSig: dbSignature(db.path), note: null, lastAutoAt: kind === 'auto' ? Date.now() : st.lastAutoAt })
    const gone = pruneSnapshots(dir(), st.keep, protect)
    log.info(`[backup] ${kind} snapshot ${r.id} (${fmtBytes(r.bytes)})${gone.length ? `, ${gone.length} old removed` : ''}`)
    return { ok: true, id: r.id }
  } finally {
    busy = false
  }
}

/** The daily run: a snapshot unless the DB is as it was at the last one. */
async function daily(): Promise<void> {
  try {
    const st = readState(dir())
    if (!autoDue(st, Date.now()) || busy) return
    const file = localDb().db.path
    if (sameSig(st.lastSig, dbSignature(file)) && listSnapshots(dir()).length) {
      writeState(dir(), { ...st, lastAutoAt: Date.now(), note: null })
      log.info('[backup] daily snapshot skipped: nothing changed since the last one')
      return
    }
    const r = await snapshot('auto')
    // short of room: said in settings, tried again at the next check
    if (!r.ok && r.space) writeState(dir(), { ...readState(dir()), note: r.error ?? null })
  } catch (e) {
    log.warn('[backup] daily snapshot failed', e)
  }
}

/** Once a day: soon after start when the last one is older than a day, then checked every hour. */
export function startLocalBackups(): void {
  // E2E runs make their own snapshots; the daily one only when a test asks for it
  if (process.env.TEAMHUB_E2E && !process.env.TEAMHUB_E2E_AUTOBACKUP) return
  first = setTimeout(() => void daily(), process.env.TEAMHUB_E2E ? 1500 : 60_000)
  timer = setInterval(() => void daily(), HOUR)
  first.unref()
  timer.unref()
}
export function stopLocalBackups(): void {
  if (first) clearTimeout(first)
  if (timer) clearInterval(timer)
  first = timer = null
}

export function backupInfo(): LocalBackupInfo {
  const st = readState(dir())
  const snapshots = listSnapshots(dir())
  return { dir: dir(), keep: st.keep, lastAt: snapshots[0]?.at ?? null, totalBytes: backupBytes(dir()), note: st.note, restore: st.restore, busy, snapshots }
}

export const backupNow = (): Promise<LocalBackupResult> => snapshot('manual').then((r) => ({ ok: r.ok, error: r.error, id: r.id }))

export function deleteSnapshot(id: string): LocalBackupResult {
  const file = snapshotPath(dir(), id)
  if (!file || !existsSync(file)) return { ok: false, error: '백업을 찾을 수 없습니다.' }
  try {
    rmSync(file)
    log.info(`[backup] snapshot ${id} removed by the user`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `지우지 못했습니다: ${(e as Error).message}` }
  }
}

export function setKeep(keep: number): LocalBackupResult {
  const st = readState(dir())
  writeState(dir(), { ...st, keep: clampKeep(keep) })
  pruneSnapshots(dir(), clampKeep(keep))
  return { ok: true }
}

export function dismissRestoreNote(): void {
  const st = readState(dir())
  if (st.restore) writeState(dir(), { ...st, restore: null })
}

export function backupFolder(): string {
  mkdirSync(dir(), { recursive: true })
  return dir()
}

function restart(): void {
  // the swap happens at the next start, before the local DB opens (E2E starts the program itself)
  setTimeout(() => {
    setQuitting(true)
    if (!process.env.TEAMHUB_E2E) app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') })
    app.quit()
  }, 300)
}

/**
 * Restore from `file` (a snapshot, or a file the user picked): check it, save today's data as
 * its own snapshot, stage the swap and restart. Until the restart nothing of the current data
 * is changed, and every failure leaves it as it is.
 */
async function restoreFrom(file: string, from: string): Promise<LocalBackupResult> {
  const bad = verifySnapshot(file, MAX_MIGRATION)
  if (bad) return { ok: false, error: `복구하지 않았습니다: ${bad}` }
  const free = freeBytes(backupFolder())
  const need = spaceNeeded(statSync(file).size + statSync(localDb().db.path).size)
  if (free !== null && free < need) return { ok: false, error: `빈 공간이 모자라 복구하지 않았습니다(필요 ${fmtBytes(need)}, 남은 공간 ${fmtBytes(free)}).` }
  const safety = await snapshot('safety', from)
  if (!safety.ok) return { ok: false, error: `지금 자료를 먼저 백업하지 못해 복구하지 않았습니다. ${safety.error ?? ''}` }
  try {
    await stageRestore(dir(), file, from, Date.now(), MAX_MIGRATION)
  } catch (e) {
    log.error('[backup] restore not staged', e)
    return { ok: false, error: `복구를 준비하지 못했습니다(지금 자료는 그대로입니다): ${(e as Error).message}` }
  }
  log.info(`[backup] restore staged from ${from}; restarting`)
  restart()
  return { ok: true, id: safety.id }
}

export function restoreSnapshot(id: string): Promise<LocalBackupResult> {
  const file = snapshotPath(dir(), id)
  if (!file || !existsSync(file)) return Promise.resolve({ ok: false, error: '백업을 찾을 수 없습니다.' })
  return restoreFrom(file, id)
}

/** 파일에서 가져오기: a file exported earlier (or a snapshot copied from another PC). */
export const restoreFile = (file: string): Promise<LocalBackupResult> => restoreFrom(file, basename(file))
