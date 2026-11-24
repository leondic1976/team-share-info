import { app } from 'electron'
import log from 'electron-log/main'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join, relative } from 'node:path'
import { checkTarget, copyEntries, isInside, removeEntries, samePath, treeSize, verifyCopy, verifySqlite, type MoveProgress, type TargetCheck } from '../node/datamove'
import { Db } from '../node/sqlite'
import { readSetting, writeSetting } from '../server/settings'
import { isProtected } from './files/fm'
import { driveUsable } from './netinfo'
import { PROFILE, seatSubPath } from './paths'

/**
 * Where data lives (6.20 저장 위치 변경).
 * - Personal data (local DB, installed plugins) lives in `localDir`, by default the app
 *   data folder. The pointer and the device key stay in the app data folder.
 *   Changing it is staged and applied on the next start, before the local DB opens.
 * - The server's data folder (`serverConfig.dataDir`) is moved while the server is
 *   stopped for a moment; members reconnect by themselves.
 */

interface StorageFile {
  localDir?: string
  pending?: { to: string; mode: 'move' | 'use'; at: number }
  last?: { ok: boolean; message: string; at: number }
}

/** Top-level entries of the personal data folder (backups: snapshots of the local DB, localbackup.ts). */
export const LOCAL_ENTRIES = ['local.db', 'plugins', 'backups']

const FILE = (): string => join(app.getPath('userData'), 'storage.json')
function read(): StorageFile {
  try {
    return JSON.parse(readFileSync(FILE(), 'utf8')) as StorageFile
  } catch {
    return {}
  }
}
function write(s: StorageFile): void {
  writeFileSync(FILE(), JSON.stringify(s, null, 2))
}

export const defaultLocalDir = (): string => app.getPath('userData')

/**
 * Where personal data is put on the D: drive: D:\\TeamHub\\<Windows account> (one folder per
 * account, so two people sharing a PC do not share personal data). null when there is no
 * usable D: drive, and in test runs with their own data folder.
 */
export function driveLocalDir(): string | null {
  if (process.env.TEAMHUB_USERDATA || !driveUsable('D:\\')) return null
  let user = 'user'
  try {
    user = userInfo().username.replace(/[\\/:*?"<>|.]+/g, '_').trim() || 'user'
  } catch {
    // keep the generic name
  }
  const dir = join('D:\\', PROFILE ? `TeamHub-${PROFILE}` : 'TeamHub', user)
  // shared PC: the people share the Windows account, so everyone but the first user gets a folder below it
  const seat = seatSubPath()
  return seat ? join(dir, seat) : dir
}

/** A new installation keeps personal data on the D: drive when there is one, else in the app data folder. */
function firstLocalDir(): string {
  const d = app.isPackaged ? driveLocalDir() : null
  if (!d) return defaultLocalDir()
  try {
    mkdirSync(d, { recursive: true })
    // the folder has to take files (a read-only or full drive falls back to the app data folder)
    const probe = join(d, '.teamhub-write-test')
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    const s = read()
    s.localDir = d
    write(s)
    log.info(`storage: new installation, personal data in ${d}`)
    return d
  } catch (e) {
    log.warn(`storage: cannot use ${d}, using the app data folder`, e)
    return defaultLocalDir()
  }
}
let resolved: string | null = null
/** Fixed for the life of the process (decided at start, see `resolveLocalDir`). */
export function localDir(): string {
  return resolved ?? resolveLocalDir()
}
/**
 * Decide the personal data folder once at start. A configured folder that is gone
 * (removed drive) falls back to the default folder with a warning; the setting is kept,
 * so the next start uses it again when the drive is back.
 */
export function resolveLocalDir(): string {
  const d = read().localDir
  const fresh = !existsSync(join(defaultLocalDir(), 'local.db'))
  // installations that already have data in the app data folder stay there until the user moves them
  if (!d) return (resolved = fresh ? firstLocalDir() : defaultLocalDir())
  // (a folder chosen at the first start may still be empty if that start did not get far)
  if (existsSync(join(d, 'local.db')) || (fresh && existsSync(d))) return (resolved = d)
  const s = read()
  s.last = { ok: false, message: `설정한 저장 위치(${d})를 찾을 수 없어 기본 위치를 씁니다. 드라이브가 연결되어 있는지 확인하고 프로그램을 다시 시작하세요.`, at: Date.now() }
  write(s)
  log.warn(`storage: local folder missing: ${d}`)
  return (resolved = defaultLocalDir())
}
export function localDataPath(...parts: string[]): string {
  return join(localDir(), ...parts)
}
export function lastStorageResult(): NonNullable<StorageFile['last']> | null {
  return read().last ?? null
}
export function clearLastStorageResult(): void {
  const s = read()
  delete s.last
  write(s)
}

export function checkLocalTarget(to: string): TargetCheck {
  const from = localDir()
  const need = treeSize(from, LOCAL_ENTRIES).bytes
  const back = samePath(to, defaultLocalDir())
  // back to the default folder: it is the app data folder itself, which always exists
  const c = back
    ? { ok: !samePath(from, to), error: samePath(from, to) ? '지금 쓰는 폴더와 같습니다.' : undefined, hasData: existsSync(join(to, 'local.db')), needBytes: need, freeBytes: null }
    : checkTarget({ from, to, marker: 'local.db', needBytes: need, isProtected })
  const taken = c.ok && !c.hasData ? ['plugins', 'backups'].find((n) => existsSync(join(to, n))) : undefined
  if (taken) return { ...c, ok: false, error: `그 폴더에 이미 ${taken} 폴더가 있습니다. 빈 폴더를 고르세요.` }
  if (c.ok && c.hasData) {
    const bad = verifySqlite(join(to, 'local.db'))
    if (bad) return { ...c, ok: false, error: `그 폴더의 자료를 열 수 없습니다(${bad}).` }
  }
  return c
}

/** Stage the change; the caller restarts the app. */
export function stageLocalChange(to: string, mode: 'move' | 'use'): void {
  const s = read()
  s.pending = { to, mode, at: Date.now() }
  write(s)
  log.info(`storage: staged local ${mode} → ${to}`)
}

/** On start, before the local DB opens: carry out a staged change. Never throws. */
export async function applyPendingLocalChange(): Promise<void> {
  const s = read()
  const p = s.pending
  if (!p) return
  delete s.pending
  write(s)
  const from = localDir()
  const setDir = (dir: string): void => {
    const cur = read()
    if (samePath(dir, defaultLocalDir())) delete cur.localDir
    else cur.localDir = dir
    write(cur)
    resolved = null
  }
  const done = (ok: boolean, message: string): void => {
    const cur = read()
    cur.last = { ok, message, at: Date.now() }
    write(cur)
    log[ok ? 'info' : 'error'](`storage: ${message}`)
  }
  try {
    const c = checkLocalTarget(p.to)
    if (!c.ok) return done(false, `저장 위치를 바꾸지 못했습니다: ${c.error}`)
    if (p.mode === 'use') {
      if (!c.hasData) return done(false, '저장 위치를 바꾸지 못했습니다: 그 폴더에 TeamHub 자료가 없습니다.')
      setDir(p.to)
      return done(true, `저장 위치를 바꿨습니다: ${p.to} (그 폴더에 있던 자료 사용, 이전 폴더의 자료는 그대로 둠)`)
    }
    if (c.hasData) return done(false, '저장 위치를 바꾸지 못했습니다: 그 폴더에 이미 TeamHub 자료가 있습니다.')
    let copied: string[] = []
    try {
      copied = await copyEntries(from, p.to, LOCAL_ENTRIES)
      const bad = verifyCopy(from, p.to, copied)
      if (bad) throw new Error(bad)
    } catch (e) {
      removeEntries(p.to, LOCAL_ENTRIES)
      return done(false, `저장 위치를 바꾸지 못했습니다(이전 위치 그대로 사용): ${(e as Error).message}`)
    }
    setDir(p.to)
    const left = removeEntries(from, LOCAL_ENTRIES)
    done(true, `내 자료를 ${p.to}(으)로 옮겼습니다.${left.length ? ` 이전 폴더에서 지우지 못한 파일이 있습니다: ${left.join(', ')}` : ''}`)
  } catch (e) {
    done(false, `저장 위치를 바꾸지 못했습니다: ${(e as Error).message}`)
  }
}

// ---------- server data folder ----------

export function checkServerTarget(from: string, to: string): TargetCheck {
  const c = checkTarget({ from, to, marker: 'teamhub.db', needBytes: treeSize(from).bytes, isProtected })
  if (!c.ok) return c
  if (c.hasData) return { ...c, ok: false, error: '그 폴더에 이미 TeamHub 서버 자료가 있습니다. 빈 폴더를 고르세요(백업에서 되살리려면 관리 → 백업의 "이 백업으로 복구"를 쓰세요).' }
  const clash = existsSync(from) ? readdirSync(from).filter((n) => existsSync(join(to, n))) : []
  if (clash.length) return { ...c, ok: false, error: `그 폴더에 같은 이름의 항목이 있습니다(${clash.slice(0, 3).join(', ')}). 빈 폴더를 고르세요.` }
  return c
}

/**
 * Copy the server folder to `to` and verify it. Starting the server on the new folder and
 * removing the old files is the caller's job (it owns the server process).
 */
export async function copyServerData(from: string, to: string, onProgress: (p: MoveProgress) => void): Promise<{ names: string[] }> {
  const names = readdirSync(from).filter((n) => !n.startsWith('.teamhub-write-test'))
  try {
    const copied = await copyEntries(from, to, names, onProgress)
    onProgress({ phase: 'verify', doneBytes: 0, totalBytes: 0 })
    const bad = verifyCopy(from, to, copied)
    if (bad) throw new Error(bad)
    // a custom backup folder inside the old data folder follows the data
    const dbFile = join(to, 'teamhub.db')
    if (existsSync(dbFile)) {
      const db = new Db(dbFile)
      try {
        const b = readSetting<{ dir?: string }>(db, 'backup')
        if (b?.dir && isInside(b.dir, from)) writeSetting(db, 'backup', { ...b, dir: join(to, relative(from, b.dir)) })
      } finally {
        db.close()
      }
    }
    return { names }
  } catch (e) {
    removeEntries(to, names)
    throw e
  }
}

export function removeOldServerData(from: string, names: string[]): string[] {
  const left = removeEntries(from, names)
  try {
    if (!readdirSync(from).length) rmdirSync(from)
  } catch {
    // keep the folder
  }
  return left
}
