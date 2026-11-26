import { app, BrowserWindow, nativeTheme } from 'electron'
import log from 'electron-log/main'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join, relative } from 'node:path'
import {
  checkTarget,
  copyEntries,
  finishCopy,
  isInside,
  MOVE_MARK,
  removeEntries,
  samePath,
  treeSizeAsync,
  unfinishedCopy,
  verifyCopy,
  verifySqlite,
  type MoveProgress,
  type TargetCheck
} from '../node/datamove'
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
  /** set while a staged move copies (cleared at the end): still there at the next start = it was cut off */
  moving?: { to: string; at: number }
  last?: { ok: boolean; message: string; at: number }
}

/** Top-level entries of the personal data folder (backups: snapshots of the local DB, localbackup.ts). */
export const LOCAL_ENTRIES = ['local.db', 'plugins', 'backups']
/** What a move has to copy, for the space check (the WAL file is folded into the copied DB). */
const LOCAL_SIZE_ENTRIES = [...LOCAL_ENTRIES, 'local.db-wal']

const FILE = (): string => join(app.getPath('userData'), 'storage.json')
function read(): StorageFile {
  try {
    return JSON.parse(readFileSync(FILE(), 'utf8')) as StorageFile
  } catch {
    return {}
  }
}
function write(s: StorageFile): void {
  // written whole and then renamed: a power cut never leaves a half-written pointer
  const tmp = `${FILE()}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2))
  renameSync(tmp, FILE())
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

export async function checkLocalTarget(to: string): Promise<TargetCheck> {
  const from = localDir()
  const need = (await treeSizeAsync(from, LOCAL_SIZE_ENTRIES)).bytes
  const back = samePath(to, defaultLocalDir())
  // back to the default folder: it is the app data folder itself, which always exists
  const c = back
    ? { ok: !samePath(from, to), error: samePath(from, to) ? '지금 쓰는 폴더와 같습니다.' : undefined, hasData: existsSync(join(to, 'local.db')) && !unfinishedCopy(to), needBytes: need, freeBytes: null }
    : checkTarget({ from, to, marker: 'local.db', needBytes: need, isProtected })
  // (what an unfinished earlier copy left there is cleared by the move itself)
  const taken = c.ok && !c.hasData && !unfinishedCopy(to) ? ['plugins', 'backups'].find((n) => existsSync(join(to, n))) : undefined
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

/**
 * A small window that says the data is being moved: the copy runs before the main window
 * exists, and a large folder takes a while. Shown only when the copy is not over at once.
 */
function moveSplash(): { close: () => void } {
  let win: BrowserWindow | null = null
  let closed = false
  const timer = setTimeout(() => {
    if (closed) return
    try {
      // the app's colours (styles.css), light or dark like Windows
      const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>TeamHub</title><style>
        :root{--bg:#ffffff;--fg:#0f172a;--sub:#64748b;--track:#e2e8f0;--bar:#2563eb}
        @media (prefers-color-scheme: dark){:root{--bg:#0f172a;--fg:#e2e8f0;--sub:#94a3b8;--track:#1e293b;--bar:#3b82f6}}
        body{margin:0;height:100vh;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:10px;padding:0 28px;background:var(--bg);color:var(--fg);font:14px "Pretendard","Malgun Gothic",sans-serif;-webkit-user-select:none;user-select:none}
        b{font-size:15px;font-weight:600}p{margin:0;color:var(--sub);font-size:12.5px;line-height:1.55}
        .t{height:4px;border-radius:2px;background:var(--track);overflow:hidden}.t i{display:block;height:100%;width:35%;background:var(--bar);border-radius:2px;animation:m 1.2s ease-in-out infinite}
        @keyframes m{0%{margin-left:-35%}100%{margin-left:100%}}</style></head>
        <body><b>내 자료를 새 위치로 옮기는 중입니다</b><div class="t"><i></i></div><p>자료 양에 따라 몇 초에서 몇 분 걸립니다. 끝나면 TeamHub가 열립니다.<br>프로그램을 끄거나 PC를 끄지 마세요.</p></body></html>`
      win = new BrowserWindow({
        width: 440,
        height: 170,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        closable: false,
        frame: false,
        show: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f172a' : '#ffffff',
        title: 'TeamHub',
        webPreferences: { sandbox: true, contextIsolation: true, javascript: false }
      })
      win.once('ready-to-show', () => win?.show())
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined)
    } catch (e) {
      log.warn('storage: move window not shown', e)
    }
  }, Number(process.env.TEAMHUB_E2E_SPLASH_MS ?? 800))
  return {
    close: () => {
      closed = true
      clearTimeout(timer)
      if (win && !win.isDestroyed()) win.destroy()
    }
  }
}

/** On start, before the local DB opens: carry out a staged change. Never throws. */
export async function applyPendingLocalChange(): Promise<void> {
  let s = read()
  // the last start was cut off while copying (closed, PC off): the old folder was never left
  if (s.moving) {
    try {
      const cut = s.moving
      delete s.moving
      // (only what that copy left: the folder still has the unfinished-copy mark)
      if (unfinishedCopy(cut.to)) removeEntries(cut.to, [...LOCAL_ENTRIES, MOVE_MARK])
      if (!s.pending) s.last = { ok: false, message: `지난번에 내 자료를 옮기는 도중 프로그램이 닫혀 옮기지 못했습니다. 이전 위치(${localDir()})의 자료를 그대로 씁니다. 다시 옮겨 보세요.`, at: Date.now() }
      write(s)
      log.warn(`storage: the move to ${cut.to} was cut off; staying in the old folder`)
    } catch (e) {
      log.error('storage: could not clear an unfinished move', e)
    }
  }
  s = read()
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
    const c = await checkLocalTarget(p.to)
    if (!c.ok) return done(false, `저장 위치를 바꾸지 못했습니다: ${c.error}`)
    if (p.mode === 'use') {
      if (!c.hasData) return done(false, '저장 위치를 바꾸지 못했습니다: 그 폴더에 TeamHub 자료가 없습니다.')
      setDir(p.to)
      return done(true, `저장 위치를 바꿨습니다: ${p.to} (그 폴더에 있던 자료 사용, 이전 폴더의 자료는 그대로 둠)`)
    }
    if (c.hasData) return done(false, '저장 위치를 바꾸지 못했습니다: 그 폴더에 이미 TeamHub 자료가 있습니다.')
    let copied: string[] = []
    const splash = moveSplash()
    try {
      const cur = read()
      cur.moving = { to: p.to, at: Date.now() }
      write(cur)
      // leftovers of a copy that was cut off earlier
      if (unfinishedCopy(p.to)) removeEntries(p.to, LOCAL_ENTRIES)
      copied = await copyEntries(from, p.to, LOCAL_ENTRIES, undefined, { mark: true })
      const bad = verifyCopy(from, p.to, copied)
      if (bad) throw new Error(bad)
      finishCopy(p.to)
    } catch (e) {
      removeEntries(p.to, [...LOCAL_ENTRIES, MOVE_MARK])
      removeIfEmpty(p.to)
      return done(false, `저장 위치를 바꾸지 못했습니다(이전 위치 그대로 사용): ${moveErrorText(e)}`)
    } finally {
      splash.close()
      const now = read()
      delete now.moving
      write(now)
    }
    setDir(p.to)
    const left = removeEntries(from, LOCAL_ENTRIES)
    done(true, `내 자료를 ${p.to}(으)로 옮겼습니다.${left.length ? ` 이전 폴더에서 지우지 못한 파일이 있습니다: ${left.join(', ')}` : ''}`)
  } catch (e) {
    done(false, `저장 위치를 바꾸지 못했습니다: ${(e as Error).message}`)
  }
}

/** A folder a failed move created and left empty goes again (one with anything else in it stays). */
function removeIfEmpty(dir: string): void {
  try {
    if (!readdirSync(dir).length) rmdirSync(dir)
  } catch {
    // kept
  }
}

/** A copy error in words a person can act on (a file another program holds, a full drive...). */
export function moveErrorText(e: unknown): string {
  const err = e as NodeJS.ErrnoException
  const msg = String(err?.message ?? e)
  const file = err?.path ? ` (${err.path})` : ''
  if (err?.code === 'ENOSPC' || /disk is full|SQLITE_FULL/i.test(msg)) return `새 위치에 빈 공간이 모자랍니다.${file}`
  if (err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES' || /locked|busy/i.test(msg))
    return `다른 프로그램이 쓰고 있는 파일이 있어 복사하지 못했습니다. 그 파일을 연 프로그램(한글·엑셀·탐색기 미리 보기, 백신 검사)을 닫고 다시 해 보세요.${file}`
  if (err?.code === 'ENOENT') return `복사하는 도중 폴더나 드라이브가 사라졌습니다(USB·외장 드라이브 연결 확인).${file}`
  return msg
}

// ---------- server data folder ----------

export async function checkServerTarget(from: string, to: string): Promise<TargetCheck> {
  const c = checkTarget({ from, to, marker: 'teamhub.db', needBytes: (await treeSizeAsync(from)).bytes, isProtected })
  if (!c.ok) return c
  if (c.hasData) return { ...c, ok: false, error: '그 폴더에 이미 TeamHub 서버 자료가 있습니다. 빈 폴더를 고르세요(백업에서 되살리려면 관리 → 백업의 "이 백업으로 복구"를 쓰세요).' }
  // (what an unfinished earlier copy left there is cleared by the move itself)
  const clash = existsSync(from) && !unfinishedCopy(to) ? readdirSync(from).filter((n) => existsSync(join(to, n))) : []
  if (clash.length) return { ...c, ok: false, error: `그 폴더에 같은 이름의 항목이 있습니다(${clash.slice(0, 3).join(', ')}). 빈 폴더를 고르세요.` }
  return c
}

/**
 * Copy the server folder to `to` and verify it. Starting the server on the new folder and
 * removing the old files is the caller's job (it owns the server process).
 */
export async function copyServerData(from: string, to: string, onProgress: (p: MoveProgress) => void): Promise<{ names: string[] }> {
  const names = readdirSync(from).filter((n) => !n.startsWith('.teamhub-write-test') && n !== MOVE_MARK)
  try {
    if (unfinishedCopy(to)) removeEntries(to, names)
    const copied = await copyEntries(from, to, names, onProgress, { mark: true })
    onProgress({ phase: 'verify', doneBytes: 0, totalBytes: 0 })
    const bad = verifyCopy(from, to, copied)
    if (bad) throw new Error(bad)
    // paths kept in the server's settings that point into the old folder follow the data:
    // a backup folder inside it (the setup wizard suggests <data folder>\backups) and the last backup
    const dbFile = join(to, 'teamhub.db')
    if (existsSync(dbFile)) {
      const db = new Db(dbFile)
      try {
        const moved = (p: string | null | undefined): string | null => (p && (isInside(p, from) || samePath(p, from)) ? join(to, relative(from, p)) : null)
        const b = readSetting<{ dir?: string }>(db, 'backup')
        const dir = moved(b?.dir)
        if (b && dir) writeSetting(db, 'backup', { ...b, dir })
        const st = readSetting<{ lastPath?: string | null }>(db, 'backupState')
        const last = moved(st?.lastPath)
        if (st && last) writeSetting(db, 'backupState', { ...st, lastPath: last })
      } finally {
        db.close()
      }
    }
    finishCopy(to)
    return { names }
  } catch (e) {
    removeEntries(to, [...names, MOVE_MARK])
    removeIfEmpty(to)
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
