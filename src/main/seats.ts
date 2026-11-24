import { app, BrowserWindow, dialog, powerMonitor, screen, session } from 'electron'
import log from 'electron-log/main'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SEAT_LOGOUT_WARN_SECONDS, SEAT_REMOVED_KEEP_DAYS } from '../shared/constants'
import { isInside, samePath } from '../node/datamove'
import { RemovedSeats, removeOutsideData } from '../node/removed-seats'
import { SeatRegistry, type SeatOutcome, type SeatPublic } from '../node/seats'
import type { LogoutWarning, RemovedSeatInfo, SeatResult, SeatState } from '../shared/ipc'
import { baseDataPath, enterSeatFolder, resourcePath } from './paths'
import { isQuitting, loadRenderer, secureWebContents, setQuitting, showMainWindow } from './windows/main-window'

/**
 * Shared PC ("공용 PC 사용", member PCs only): several people use TeamHub on one PC under one
 * Windows account. Each person signs in with a name (and a PIN, if they use one) and gets an own userData folder
 * (see node/seats.ts and paths.ts), so the device key, the server account, the personal DB,
 * the offline cache and the remembered servers are all per person without any of that code
 * knowing about it.
 *
 * One process works for one person: the folder is chosen once, after the PIN check and before
 * the session starts. Changing the person restarts the program, so nothing of the previous
 * person stays in memory. A session ends by "사용자 바꾸기", after the PC was not touched for the
 * 자동 로그아웃 시간 (with a minute of warning), or when Windows is locked.
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
/** Unlock after "지금 잠그기": the PIN of the signed-in person only (there is no second, separate lock PIN). */
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
    active: active ? { id: active.id, name: active.name, owner: active.owner, hasPin: active.hasPin } : null,
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

/** Sign-in window: PIN checked here (a person without a PIN has none to check), then this process becomes that person's. */
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

/** Personal data that 내 자료 저장 위치 may have put outside the seat folder. */
const DATA_ENTRIES = ['local.db', 'plugins', 'backups']
const removed = (): RemovedSeats => new RemovedSeats(baseDataPath())
let removing = false

/**
 * Take a person off this PC. What the PC kept for them (device key, personal DB, cache,
 * installed plugins) is not erased at once: it is moved to the holding area and kept for 30
 * days, so the PC 책임자 can put the person back (node/removed-seats.ts). When that backup
 * cannot be made, nothing is removed. The account on the server is not touched: that is the admin's.
 */
export async function removeSeat(id: string, pin: string, by: 'self' | 'owner'): Promise<SeatResult> {
  if (active?.id === id) return { ok: false, error: '지금 사용 중인 사용자는 지울 수 없습니다. "사용자 바꾸기"로 나간 뒤 시작 화면에서 지우세요.' }
  if (removing) return { ok: false, error: '다른 사용자를 지우는 중입니다. 잠시 뒤 다시 해 보세요.' }
  const r = reg()
  const auth = r.authRemove(id, pin, by)
  if (!auth.ok || !auth.record) return { ok: false, error: auth.error, waitMs: auth.waitMs }
  removing = true
  try {
    const dir = r.dirOf(auth.record)
    const data = dataDirOf(dir)
    const outside = !samePath(data, dir) && !isInside(data, dir) ? data : null
    const held = await removed().hold({ record: auth.record, by, seatDir: dir, data: outside ? { dir: outside, entries: DATA_ENTRIES } : null })
    if (!held.ok) {
      log.error(`[seats] user ${id} not removed: the backup could not be made`, held.error)
      return { ok: false, error: `자료를 보관(백업)하지 못해 지우지 않았습니다. 아무것도 지워지지 않았습니다. 디스크의 빈 공간을 확인하고 다시 해 보세요. (${held.error ?? ''})` }
    }
    if (!r.drop(id)) {
      try {
        removed().unhold(id, dir)
      } catch (e) {
        log.error('[seats] could not undo the backup of a removal that failed', e)
      }
      return { ok: false, error: '사용자 목록을 저장하지 못해 지우지 않았습니다.' }
    }
    const left: string[] = held.warning ? [held.warning] : []
    if (outside && held.copiedData) left.push(...removeOutsideData(outside, DATA_ENTRIES))
    log.info(`[seats] user ${id} removed, data kept for ${SEAT_REMOVED_KEEP_DAYS} days${left.length ? ' (some original files could not be removed)' : ''}`)
    changed()
    if (!left.length) return { ok: true }
    return { ok: true, warning: `${auth.record.name} 님을 지우고 자료를 보관했지만, 원래 자리에서 지우지 못한 파일이 있습니다. TeamHub를 종료한 뒤 폴더를 직접 지우세요: ${held.warning || !outside ? dir : outside}` }
  } finally {
    removing = false
  }
}

/** People removed from this PC whose data is still kept (30 days). */
export function removedSeats(): RemovedSeatInfo[] {
  return removed().list(reg().ids() ?? [])
}

/**
 * Put a removed person back (PC 책임자's PIN): the registry record with the PIN they had,
 * and their folder. An existing seat is never overwritten.
 */
export function restoreSeat(ownerPin: string, id: string): SeatResult {
  if (removing) return { ok: false, error: '다른 작업을 하는 중입니다. 잠시 뒤 다시 해 보세요.' }
  const r = reg()
  const held = removed()
  const meta = held.meta(id)
  if (!meta) return { ok: false, error: '보관된 자료를 찾을 수 없습니다(보관 기간이 지났거나 이미 지워졌습니다).' }
  let dir: string
  try {
    dir = r.dirOf({ id, owner: false })
  } catch {
    return { ok: false, error: '보관된 사용자 정보가 올바르지 않습니다.' }
  }
  const bad = r.restoreProblem(meta.record) ?? held.restoreProblem(id, dir)
  if (bad) return { ok: false, error: bad }
  const res = r.restore(ownerPin, meta.record)
  if (!res.ok) return { ok: false, error: res.error, waitMs: res.waitMs }
  try {
    held.restoreFiles(id, dir, DATA_ENTRIES)
  } catch (e) {
    r.drop(id)
    log.error(`[seats] user ${id} not restored`, e)
    return { ok: false, error: `자료를 되돌리지 못해 복구하지 않았습니다. 보관된 자료는 그대로 있습니다. (${(e as Error).message})` }
  }
  log.info(`[seats] user ${id} restored from the kept backup`)
  changed()
  const renamed = !!res.name && res.name !== meta.name
  return { ok: true, name: res.name, warning: renamed ? `같은 이름의 사용자가 있어 "${res.name}"(으)로 복구했습니다. 시작 화면에서 이 이름을 고르고 전과 같은 방법(PIN이 있었다면 예전 PIN)으로 들어갑니다.` : undefined }
}

/** Erase a kept backup for good (PC 책임자's PIN). */
export function purgeRemovedSeat(ownerPin: string, id: string): SeatResult {
  const auth = reg().verifyOwner(ownerPin)
  if (!auth.ok) return { ok: false, error: auth.error, waitMs: auth.waitMs }
  const res = removed().purge(id)
  if (res.ok) log.info(`[seats] kept backup of removed user ${id} erased`)
  return res
}

let cleanupTimer: NodeJS.Timeout | null = null
function cleanupRemoved(): void {
  try {
    const r = reg()
    const gone = removed().cleanup(r.ids(), (id) => r.dirOf({ id, owner: false }))
    if (gone.length) log.info(`[seats] kept backups past ${SEAT_REMOVED_KEEP_DAYS} days erased: ${gone.length}`)
  } catch (e) {
    log.warn('[seats] cleanup of removed users failed', e)
  }
}
/** Kept backups of removed people are erased after 30 days: checked at start and through the day. */
export function startRemovedCleanup(): void {
  cleanupRemoved()
  cleanupTimer ??= setInterval(cleanupRemoved, 6 * 3600_000)
  cleanupTimer.unref()
}

export function resetSeatPin(ownerPin: string, id: string, newPin: string): SeatResult {
  const r = reg().resetPin(ownerPin, id, newPin)
  if (r.ok) {
    log.info(`[seats] PIN of user ${id} was reset by the owner`)
    refreshActive()
  }
  return r
}
/** The signed-in person as the registry has them now (after their PIN was made or removed). */
function refreshActive(): void {
  if (active) active = reg().get(active.id) ?? active
  changed()
}
/** The signed-in person makes or changes their own PIN (the old one is asked only when there is one). */
export function changeSeatPin(oldPin: string, newPin: string): SeatResult {
  if (!active) return { ok: false, error: '공용 PC 사용이 꺼져 있습니다.' }
  const r = reg().changePin(active.id, oldPin, newPin)
  if (r.ok) refreshActive()
  return r
}
/** The signed-in person stops using a PIN (their current PIN is asked). */
export function removeSeatPin(pin: string): SeatResult {
  if (!active) return { ok: false, error: '공용 PC 사용이 꺼져 있습니다.' }
  const r = reg().removePin(active.id, pin)
  if (r.ok) {
    log.info(`[seats] ${active.owner ? 'first user' : `user ${active.id}`} uses no PIN now`)
    refreshActive()
  }
  return r
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

export type LogoutReason = 'switch' | 'idle' | 'windows-lock'
let leaving = false

/**
 * End this person's session (log out): the program starts again at the sign-in window, so
 * nothing of the person stays in memory. Unsaved writing is lost, which is why the automatic
 * logout warns first.
 */
export function switchUser(reason: LogoutReason = 'switch'): void {
  if (leaving) return
  leaving = true
  log.info(`[seats] session ends (${reason}): restart at the sign-in window`)
  warn = null
  closeWarning()
  setQuitting(true)
  if (process.env.TEAMHUB_E2E) {
    // E2E starts the program itself; what it can check is that the logout was asked for, and why
    try {
      writeFileSync(join(baseDataPath(), 'e2e-logout.json'), JSON.stringify({ reason, at: Date.now() }))
    } catch (e) {
      log.warn('[seats] cannot record the logout', e)
    }
  } else {
    // not hidden: the sign-in window is what the next person at this PC has to see
    app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') })
  }
  app.quit()
}

// ---------- automatic logout ----------
/**
 * Shared PC: the next person may sit down without anybody pressing "사용자 바꾸기". When the PC
 * was not touched for the 자동 로그아웃 시간 the session ends, for everybody (with or without a
 * PIN). Logging out discards writing that was not saved, so a small always-on-top window says
 * so one minute before; any input, or its 계속 사용 button, cancels that round. Locking Windows
 * logs out at once: the person has left.
 *
 * E2E runs unattended, so the idle time is 0 there unless a test sets it (globalThis.__teamhubIdle,
 * seconds) or asks for the real one (TEAMHUB_E2E_IDLE).
 */
let warn: { until: number; idle: number } | null = null
let warnWin: BrowserWindow | null = null
/** System idle seconds at the moment 계속 사용 was pressed: idle time counts from there. */
let idleBase = 0
let ticks = 0

function rawIdle(): number {
  if (!process.env.TEAMHUB_E2E) return powerMonitor.getSystemIdleTime()
  const fake = (globalThis as unknown as { __teamhubIdle?: number }).__teamhubIdle
  if (typeof fake === 'number') return fake
  return process.env.TEAMHUB_E2E_IDLE ? powerMonitor.getSystemIdleTime() : 0
}
function idleSeconds(): number {
  const raw = rawIdle()
  if (raw < idleBase) idleBase = 0 // real input since then
  return raw - idleBase
}

/** What the warning window shows; null when no logout is coming. */
export function logoutWarning(): LogoutWarning | null {
  if (!warn || !active || leaving) return null
  return { seconds: Math.max(0, Math.ceil((warn.until - Date.now()) / 1000)), name: active.name }
}

/** 계속 사용 (or closing the warning): this round is over, the idle time starts again. */
export function stayLoggedIn(): void {
  if (!warn) return
  idleBase = rawIdle()
  warn = null
  closeWarning()
}

function openWarning(): void {
  if (warnWin && !warnWin.isDestroyed()) return
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = 440
  const height = 230
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    title: 'TeamHub 자동 로그아웃',
    icon: resourcePath('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })
  win.setMenu(null)
  // also while the main window is hidden in the tray, and above full-screen apps
  win.setAlwaysOnTop(true, 'screen-saver')
  secureWebContents(win)
  loadRenderer(win, '/popup/logout')
  win.once('ready-to-show', () => {
    // not focused: whatever the person may be doing elsewhere is not interrupted
    win.showInactive()
    win.flashFrame(true)
  })
  // closing the notice is an answer too: somebody is there
  win.on('close', () => {
    if (warnWin === win && !leaving) stayLoggedIn()
  })
  win.on('closed', () => {
    if (warnWin === win) warnWin = null
  })
  warnWin = win
}

function closeWarning(): void {
  const w = warnWin
  warnWin = null
  if (w && !w.isDestroyed()) w.destroy()
}

function idleTick(): void {
  if (!active || !sessionUp || leaving) return
  if (warn) {
    // somebody touched the PC: this round is over
    if (idleSeconds() < warn.idle) {
      warn = null
      closeWarning()
    } else if (Date.now() >= warn.until) switchUser('idle')
    return
  }
  // (the limit is read from the registry file: not every second)
  if (ticks++ % 5) return
  const limit = reg().idleMinutes() * 60
  const idle = idleSeconds()
  if (idle < limit - SEAT_LOGOUT_WARN_SECONDS) return
  warn = { until: Date.now() + Math.max(0, limit - idle) * 1000, idle }
  openWarning()
}

let idleTimer: NodeJS.Timeout | null = null
/** Started with the session; does nothing while shared mode is off. */
export function startAutoLogout(): void {
  if (idleTimer) return
  idleTimer = setInterval(idleTick, 1000)
  idleTimer.unref()
  powerMonitor.on('lock-screen', () => {
    if (active && sessionUp) switchUser('windows-lock')
  })
}

/** From the tray: asks first, because writing that was not saved is lost with the restart. */
export async function askSwitchUser(): Promise<void> {
  const r = await dialog.showMessageBox({
    type: 'question',
    title: '사용자 바꾸기',
    message: `${active?.name ?? ''} 님의 사용을 마치고(로그아웃) 사용자 선택 화면으로 돌아갑니다.`,
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
