import { app, BrowserWindow, dialog, session } from 'electron'
import log from 'electron-log/main'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInside, removeEntries, samePath } from '../node/datamove'
import { SeatRegistry, type SeatOutcome, type SeatPublic } from '../node/seats'
import type { SeatResult, SeatState } from '../shared/ipc'
import { baseDataPath, enterSeatFolder, resourcePath } from './paths'
import { isQuitting, loadRenderer, secureWebContents, setQuitting, showMainWindow } from './windows/main-window'

/**
 * Shared PC ("공용 PC 사용", member PCs only): several people use TeamHub on one PC under one
 * Windows account. Each person signs in with a name and a PIN and gets an own userData folder
 * (see node/seats.ts and paths.ts), so the device key, the server account, the personal DB,
 * the offline cache and the remembered servers are all per person without any of that code
 * knowing about it.
 *
 * One process works for one person: the folder is chosen once, after the PIN check and before
 * the session starts. Changing the person restarts the program, so nothing of the previous
 * person stays in memory.
 */
const reg = (): SeatRegistry => new SeatRegistry(baseDataPath())

let active: SeatPublic | null = null
let sessionUp = false
let entering = false
let starter: ((fromPicker: boolean) => Promise<void>) | null = null
const listeners: (() => void)[] = []

/** What starts the session (local DB, IPC, windows...) once it is known whose it is. */
export function setSessionStarter(fn: (fromPicker: boolean) => Promise<void>): void {
  starter = fn
}
export function onSeatsChanged(fn: () => void): void {
  listeners.push(fn)
}
const changed = (): void => listeners.forEach((fn) => fn())

export function sharedEnabled(): boolean {
  return reg().enabled()
}
/** The person this process works for; null without shared mode and while nobody is signed in. */
export function activeSeat(): SeatPublic | null {
  return active
}
export function sessionStarted(): boolean {
  return sessionUp
}
export function markSessionStarted(): void {
  sessionUp = true
  changed()
}
export function seatIdleMinutes(): number {
  return reg().idleMinutes()
}
export function activeSeatWaitMs(): number {
  return active ? (reg().get(active.id)?.waitMs ?? 0) : 0
}
/** Unlock after the idle lock: the PIN of the signed-in person only. */
export function verifyActiveSeat(pin: string): SeatOutcome {
  return active ? reg().verify(active.id, pin) : { ok: false, error: 'PIN이 맞지 않습니다.' }
}

export function seatState(allowed: boolean): SeatState {
  const r = reg()
  return {
    enabled: r.enabled(),
    damaged: r.damaged(),
    signedIn: sessionUp,
    allowed,
    active: active ? { id: active.id, name: active.name, owner: active.owner } : null,
    idleMinutes: r.idleMinutes(),
    seats: r.list()
  }
}

/** A new person's folder starts as a member PC: the choice "use this PC as the server" is not theirs. */
function prepareSeatFolder(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const id = join(dir, 'pc-identity.json')
  if (!existsSync(id)) writeFileSync(id, JSON.stringify({ role: 'client', roleAt: Date.now() }, null, 2))
}

/**
 * The browser side (page storage, HTTP cache of what the server sent) is one profile per
 * Windows account and cannot be switched after start, so it is emptied before each person's
 * session. Nothing the program needs is kept there.
 */
async function wipeBrowserData(): Promise<void> {
  try {
    await session.defaultSession.clearStorageData()
    await session.defaultSession.clearCache()
  } catch (e) {
    log.warn('[seats] cannot clear the browser data', e)
  }
}

/** Sign-in window: PIN checked here, then this process becomes that person's. */
export async function signIn(id: string, pin: string): Promise<SeatResult> {
  if (sessionUp || entering) return { ok: false, error: '이미 사용 중입니다. 사용자를 바꾸려면 "사용자 바꾸기"를 쓰세요.' }
  const r = reg()
  const v = r.verify(id, pin)
  if (!v.ok) return v
  const seat = r.get(id)
  if (!seat || !starter) return { ok: false, error: 'PIN이 맞지 않습니다.' }
  entering = true
  try {
    const dir = r.dirOf(seat)
    if (!seat.owner) prepareSeatFolder(dir)
    enterSeatFolder(dir, seat.owner ? null : join('users', seat.id))
    await wipeBrowserData()
    active = seat
    r.touch(id)
    log.info(`[seats] signed in: ${seat.owner ? 'first user' : `user ${seat.id}`}`)
    await starter(true)
  } catch (e) {
    log.error('[seats] session did not start', e)
    return { ok: false, error: '시작하지 못했습니다. TeamHub를 종료한 뒤 다시 실행하세요.' }
  } finally {
    entering = false
  }
  // the answer goes out first; then the sign-in window makes way for the main window
  setImmediate(() => closeSeatPicker())
  return { ok: true }
}

/** Turn shared mode on from the settings of the person using the PC now, who becomes the PC 책임자. */
export function enableShared(name: string, pin: string): SeatResult {
  const r = reg().enable(name, pin)
  if (!r.ok || !r.id) return r
  active = reg().get(r.id)
  log.info('[seats] shared PC mode turned on')
  changed()
  return r
}

export function disableShared(ownerPin: string): SeatResult {
  const r = reg().disable(ownerPin)
  if (!r.ok) return r
  active = null
  log.info('[seats] shared PC mode turned off')
  changed()
  return r
}

export function addSeat(ownerPin: string, name: string, pin: string): SeatResult {
  const r = reg().add(ownerPin, name, pin)
  if (r.ok && r.id) {
    try {
      prepareSeatFolder(reg().dirOf({ id: r.id, owner: false }))
    } catch (e) {
      log.warn('[seats] folder of the new user is made at the first sign-in', e)
    }
    log.info(`[seats] user ${r.id} added`)
    changed()
  }
  return r
}

/** Where a seat keeps its personal data: its folder, or the one chosen in 내 자료 저장 위치. */
function dataDirOf(dir: string): string {
  try {
    const s = JSON.parse(readFileSync(join(dir, 'storage.json'), 'utf8')) as { localDir?: string }
    if (s.localDir) return s.localDir
  } catch {
    // no storage.json: the data is in the seat folder
  }
  return dir
}

/**
 * Take a person off this PC and erase what the PC kept for them (device key, personal DB,
 * cache, installed plugins). The account on the server is not touched: that is the admin's.
 */
export function removeSeat(id: string, pin: string, by: 'self' | 'owner'): SeatResult {
  if (active?.id === id) return { ok: false, error: '지금 사용 중인 사용자는 지울 수 없습니다. "사용자 바꾸기"로 나간 뒤 시작 화면에서 지우세요.' }
  const r = reg()
  const seat = r.get(id)
  const dir = seat && !seat.owner ? r.dirOf(seat) : null
  const res = r.remove(id, pin, by)
  if (!res.ok || !dir) return res
  const left: string[] = []
  try {
    const data = dataDirOf(dir)
    if (!samePath(data, dir) && !isInside(data, dir)) {
      left.push(...removeEntries(data, ['local.db', 'plugins']))
      try {
        if (existsSync(data) && !readdirSync(data).length) rmdirSync(data)
      } catch {
        // the folder stays
      }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch (e) {
    left.push((e as Error).message)
  }
  log.info(`[seats] user ${id} removed${left.length ? ' (some files could not be removed)' : ''}`)
  changed()
  return left.length ? { ...res, warning: `지우지 못한 파일이 있습니다. TeamHub를 종료한 뒤 폴더를 직접 지우세요: ${dir}` } : res
}

export function resetSeatPin(ownerPin: string, id: string, newPin: string): SeatResult {
  const r = reg().resetPin(ownerPin, id, newPin)
  if (r.ok) log.info(`[seats] PIN of user ${id} was reset by the owner`)
  return r
}
export function changeSeatPin(oldPin: string, newPin: string): SeatResult {
  if (!active) return { ok: false, error: '공용 PC 사용이 꺼져 있습니다.' }
  return reg().changePin(active.id, oldPin, newPin)
}
export function recoverOwnerPin(code: string, newPin: string): SeatResult {
  const r = reg().recoverOwner(code, newPin)
  if (r.ok) log.info('[seats] owner PIN replaced with the recovery code')
  return r
}
export function setSeatIdle(ownerPin: string, minutes: number): SeatResult {
  const r = reg().setIdleMinutes(ownerPin, minutes)
  if (r.ok) changed()
  return r
}

/** 내 자료 저장 위치: a folder that holds another person's data of this PC cannot be chosen. */
export function otherSeatDataProblem(to: string): string | null {
  const r = reg()
  if (!r.enabled()) return null
  for (const s of r.list()) {
    if (s.id === active?.id) continue
    const dir = r.dirOf(s)
    const data = dataDirOf(dir)
    // (the first user's folder holds everybody's folders: only the folder itself counts there)
    if (samePath(to, data) || samePath(to, dir) || (!s.owner && isInside(to, dir))) return '그 폴더는 이 PC의 다른 사용자가 쓰는 자료 폴더입니다. 다른 폴더를 고르세요.'
  }
  return null
}

/** End this person's session: the program starts again at the sign-in window. */
export function switchUser(): void {
  log.info('[seats] switching user: restart')
  setQuitting(true)
  // not hidden: whoever asked for it wants to sign in now. E2E starts the program itself.
  if (!process.env.TEAMHUB_E2E) app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') })
  app.quit()
}

/** From the tray: asks first, because writing that was not saved is lost with the restart. */
export async function askSwitchUser(): Promise<void> {
  const r = await dialog.showMessageBox({
    type: 'question',
    title: '사용자 바꾸기',
    message: `${active?.name ?? ''} 님의 사용을 마치고 사용자 선택 화면으로 돌아갑니다.`,
    detail: 'TeamHub가 다시 시작됩니다. 저장하지 않은 내용은 사라집니다.',
    buttons: ['사용자 바꾸기', '취소'],
    defaultId: 0,
    cancelId: 1
  })
  if (r.response === 0) switchUser()
}

// ---------- sign-in window ----------
let picker: BrowserWindow | null = null

export function openSeatPicker(show: boolean): void {
  if (picker && !picker.isDestroyed()) {
    if (show) {
      if (picker.isMinimized()) picker.restore()
      picker.show()
      picker.focus()
    }
    return
  }
  const win = new BrowserWindow({
    width: 460,
    height: 640,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'TeamHub',
    icon: resourcePath('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  win.setMenu(null)
  secureWebContents(win)
  loadRenderer(win, '/popup/seat')
  win.once('ready-to-show', () => {
    if (show) win.show()
  })
  // like the main window: closing hides it to the tray
  win.on('close', (e) => {
    if (!isQuitting() && !sessionUp) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    if (picker === win) picker = null
  })
  picker = win
}

function closeSeatPicker(): void {
  if (picker && !picker.isDestroyed()) picker.destroy()
  picker = null
}

/** Tray, second start of the program: the main window, or the sign-in window while nobody is signed in. */
export function showFront(): void {
  if (sessionUp) showMainWindow()
  else if (sharedEnabled()) openSeatPicker(true)
}
