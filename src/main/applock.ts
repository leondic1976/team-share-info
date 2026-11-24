import { BrowserWindow, powerMonitor } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import log from 'electron-log/main'
import type { LockState } from '../shared/ipc'
import { FREE_TRIES, newRecoveryCode, normRecoveryCode as normCode, pinMatches as matches, sealPin as sealed, waitAfter } from '../node/pin'
import { userDataPath } from './paths'
import { activeSeat, activeSeatWaitMs, seatIdleMinutes, verifyActiveSeat } from './seats'

/**
 * Program lock (optional, off until the user makes a PIN in the settings): a 4-digit PIN is
 * asked when the program starts and after Windows was locked. Only salted hashes are kept
 * (app data folder); a forgotten PIN is replaced with the recovery code shown once when the
 * PIN was made. The server of a server PC keeps running while the screen is locked.
 */
interface LockFile {
  salt: string
  hash: string
  recoverySalt: string
  recoveryHash: string
  /** Wrong tries in a row. */
  fails: number
  /** No try is accepted before this time (after too many wrong ones). */
  waitUntil: number
  createdAt: number
}

const FILE = (): string => userDataPath('app-lock.json')
export const PIN_RE = /^\d{4}$/

let file: LockFile | null | undefined
let locked = true
/**
 * Shared PC (seats.ts): the lock is not optional and uses the PIN of the signed-in person;
 * the optional PIN above is not asked while that mode is on. Starts unlocked: the person
 * has just typed the PIN to sign in.
 */
let seatLocked = false
const SEAT_ONLY = '공용 PC 사용 중에는 사용자 PIN으로 잠급니다. PIN은 설정의 "공용 PC 사용"에서 바꿉니다.'

function load(): LockFile | null {
  if (file !== undefined) return file
  file = null
  try {
    if (existsSync(FILE())) file = JSON.parse(readFileSync(FILE(), 'utf8')) as LockFile
  } catch (e) {
    log.error('[lock] cannot read app-lock.json', e)
  }
  return file
}

function save(next: LockFile): void {
  file = next
  writeFileSync(FILE(), JSON.stringify(next))
}

export function lockState(): LockState {
  const seat = activeSeat()
  if (seat) return { hasPin: true, locked: seatLocked, waitMs: activeSeatWaitMs(), seat: { name: seat.name, owner: seat.owner } }
  const f = load()
  return { hasPin: !!f, locked: !!f && locked, waitMs: Math.max(0, (f?.waitUntil ?? 0) - Date.now()) }
}

function changed(): void {
  const st = lockState()
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('lock:changed', st)
}

/** Shared mode was turned on or off: every window learns which lock applies now. */
export function lockModeChanged(): void {
  seatLocked = false
  // the optional PIN was not asked while the shared mode was on; it is not asked out of the blue now
  locked = false
  changed()
}

/** Turn the lock on: make the PIN. Returns the recovery code, which is shown once and not kept readable. */
export function createPin(pin: string): { ok: boolean; recovery?: string; error?: string } {
  if (activeSeat()) return { ok: false, error: SEAT_ONLY }
  if (load()) return { ok: false, error: 'PIN이 이미 있습니다.' }
  if (!PIN_RE.test(pin)) return { ok: false, error: 'PIN은 숫자 4자리입니다.' }
  const recovery = newRecoveryCode()
  const p = sealed(pin)
  const r = sealed(normCode(recovery))
  save({ salt: p.salt, hash: p.hash, recoverySalt: r.salt, recoveryHash: r.hash, fails: 0, waitUntil: 0, createdAt: Date.now() })
  locked = false
  log.info('[lock] PIN created')
  changed()
  return { ok: true, recovery }
}

/** Count a wrong try; from the fifth on, each one makes the wait longer (30s, 1min, ... 10min). */
function wrong(f: LockFile): { waitMs: number; left: number } {
  const fails = f.fails + 1
  const waitMs = waitAfter(fails)
  save({ ...f, fails, waitUntil: waitMs ? Date.now() + waitMs : 0 })
  return { waitMs, left: Math.max(0, FREE_TRIES - fails) }
}

function check(pin: string): { ok: boolean; error?: string; waitMs?: number; left?: number } {
  const f = load()
  if (!f) return { ok: false, error: 'PIN이 없습니다.' }
  const waitMs = f.waitUntil - Date.now()
  if (waitMs > 0) return { ok: false, waitMs, error: '잠시 뒤에 다시 입력하세요.' }
  if (!PIN_RE.test(pin) || !matches(pin, f.salt, f.hash)) {
    const w = wrong(f)
    return { ok: false, ...w, error: w.waitMs ? '여러 번 틀려 잠시 입력할 수 없습니다.' : `PIN이 맞지 않습니다. (${w.left}번 더 틀리면 잠시 입력할 수 없습니다)` }
  }
  if (f.fails || f.waitUntil) save({ ...f, fails: 0, waitUntil: 0 })
  return { ok: true }
}

export function unlock(pin: string): { ok: boolean; error?: string; waitMs?: number } {
  if (activeSeat()) {
    const s = verifyActiveSeat(pin)
    if (s.ok) {
      seatLocked = false
      changed()
    }
    return { ok: s.ok, error: s.error, waitMs: s.waitMs }
  }
  const r = check(pin)
  if (r.ok) {
    locked = false
    changed()
  }
  return r
}

export function changePin(oldPin: string, newPin: string): { ok: boolean; error?: string; waitMs?: number } {
  if (activeSeat()) return { ok: false, error: SEAT_ONLY }
  if (!PIN_RE.test(newPin)) return { ok: false, error: '새 PIN은 숫자 4자리입니다.' }
  const r = check(oldPin)
  if (!r.ok) return r
  const f = load()!
  save({ ...f, ...sealed(newPin), fails: 0, waitUntil: 0 })
  log.info('[lock] PIN changed')
  return { ok: true }
}

/** Forgotten PIN: the recovery code allows a new PIN and is replaced by a new code. */
export function recoverPin(code: string, newPin: string): { ok: boolean; recovery?: string; error?: string; waitMs?: number } {
  if (activeSeat()) return { ok: false, error: SEAT_ONLY }
  const f = load()
  if (!f) return { ok: false, error: 'PIN이 없습니다.' }
  if (!PIN_RE.test(newPin)) return { ok: false, error: '새 PIN은 숫자 4자리입니다.' }
  const waitMs = f.waitUntil - Date.now()
  if (waitMs > 0) return { ok: false, waitMs, error: '잠시 뒤에 다시 입력하세요.' }
  if (!matches(normCode(code), f.recoverySalt, f.recoveryHash)) {
    const w = wrong(f)
    return { ok: false, waitMs: w.waitMs, error: '복구 코드가 맞지 않습니다.' }
  }
  const recovery = newRecoveryCode()
  const r = sealed(normCode(recovery))
  save({ ...f, ...sealed(newPin), recoverySalt: r.salt, recoveryHash: r.hash, fails: 0, waitUntil: 0 })
  locked = false
  log.info('[lock] PIN replaced with the recovery code')
  changed()
  return { ok: true, recovery }
}

/** Turn the lock off again (needs the PIN). */
export function removePin(pin: string): { ok: boolean; error?: string; waitMs?: number } {
  if (activeSeat()) return { ok: false, error: SEAT_ONLY }
  const r = check(pin)
  if (!r.ok) return r
  file = null
  rmSync(FILE(), { force: true })
  locked = false
  log.info('[lock] PIN removed')
  changed()
  return { ok: true }
}

export function lockNow(): void {
  if (activeSeat()) {
    if (seatLocked) return
    seatLocked = true
    changed()
    return
  }
  if (!load() || locked) return
  locked = true
  changed()
}

/** After the shared-PC lock was opened with the PC 책임자's recovery code (seats.ts made the new PIN). */
export function seatUnlocked(): void {
  seatLocked = false
  changed()
}

export function startAppLock(): void {
  // whoever sits down after Windows was locked has to know the PIN of the program too
  powerMonitor.on('lock-screen', () => lockNow())
  // Shared PC: the next person may sit down without Windows being locked in between, so the
  // program locks itself when the PC was not touched for a while. Only the screen is covered;
  // nothing is closed, so writing in progress is kept. (E2E runs unattended: see app:idleSeconds.)
  if (process.env.TEAMHUB_E2E && !process.env.TEAMHUB_E2E_IDLE) return
  setInterval(() => {
    if (!activeSeat() || seatLocked) return
    if (powerMonitor.getSystemIdleTime() >= seatIdleMinutes() * 60) lockNow()
  }, 15_000).unref()
}
