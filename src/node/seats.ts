import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SEAT_IDLE_DEFAULT, SEAT_IDLE_MAX, SEAT_IDLE_MIN, SEAT_MAX, SEAT_NAME_MAX, SEAT_PIN_MAX, SEAT_PIN_MIN } from '../shared/constants'
import { FREE_TRIES, newRecoveryCode, normRecoveryCode, pinMatches, sealPin, waitAfter } from './pin'

/**
 * People of a shared PC ("공용 PC 사용"): several people use TeamHub on one member PC under
 * one Windows account. Each person ("seat") has a name, a PIN and an own data folder, so each
 * has an own server approval, account and personal data.
 *
 * This file is the registry only (names, salted PIN hashes, wrong-try counters) and knows
 * nothing about Electron. It lives in the base app data folder as seats.json.
 *  - The person who turns the mode on is the PC 책임자 (owner) and keeps the base folder.
 *  - Everybody else gets <base>/users/<id>.
 *  - Adding a person, removing one and resetting a forgotten PIN need the owner's PIN.
 */
export { SEAT_IDLE_MAX, SEAT_IDLE_MIN }
export const SEAT_ID_RE = /^[a-f0-9]{12}$/

export interface SeatRecord {
  id: string
  name: string
  /** PC 책임자: turned the mode on, uses the base folder, cannot be removed. */
  owner: boolean
  salt: string
  hash: string
  createdAt: number
  lastUsedAt: number
  /** Wrong tries in a row. */
  fails: number
  /** No try is accepted before this time. */
  lockUntil: number
}

export interface SeatsFile {
  version: 1
  enabled: boolean
  idleMinutes: number
  /** Recovery code of the owner's PIN (shown once when the mode was turned on). */
  recoverySalt: string
  recoveryHash: string
  recoveryFails: number
  recoveryLockUntil: number
  seats: SeatRecord[]
}

export interface SeatPublic {
  id: string
  name: string
  owner: boolean
  lastUsedAt: number
  waitMs: number
}

export interface SeatOutcome {
  ok: boolean
  error?: string
  waitMs?: number
  /** Shown once after the mode was turned on or the owner's PIN was replaced with the code. */
  recovery?: string
  /** The seat that was made or removed. */
  id?: string
}

const WRONG_PIN = 'PIN이 맞지 않습니다.'
const WAIT = '여러 번 틀려 잠시 입력할 수 없습니다.'

/** null when the PIN may be used; otherwise what is wrong with it. */
export function seatPinProblem(pin: string): string | null {
  if (!new RegExp(`^\\d{${SEAT_PIN_MIN},${SEAT_PIN_MAX}}$`).test(pin)) return `PIN은 숫자 ${SEAT_PIN_MIN}자리 이상입니다.`
  if (/^(\d)\1+$/.test(pin)) return '같은 숫자만 이어진 PIN은 쓸 수 없습니다.'
  const steps = [...pin].slice(1).map((c, i) => Number(c) - Number(pin[i]))
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return '123456처럼 이어지는 숫자는 PIN으로 쓸 수 없습니다.'
  return null
}

export function cleanSeatName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
}

export class SeatRegistry {
  constructor(
    private readonly baseDir: string,
    private readonly now: () => number = Date.now
  ) {}

  private file(): string {
    return join(this.baseDir, 'seats.json')
  }

  /** The registry; null when the mode was never turned on. Throws when the file cannot be read. */
  private load(): SeatsFile | null {
    const parse = (p: string): SeatsFile => {
      const f = JSON.parse(readFileSync(p, 'utf8')) as SeatsFile
      if (!f || !Array.isArray(f.seats)) throw new Error('not a seat registry')
      return f
    }
    if (!existsSync(this.file())) return null
    try {
      return parse(this.file())
    } catch {
      // a write cut short (power loss): the copy of the last good state
      return parse(`${this.file()}.bak`)
    }
  }

  private save(f: SeatsFile): void {
    const text = JSON.stringify(f, null, 2)
    const tmp = `${this.file()}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, this.file())
    writeFileSync(`${this.file()}.bak`, text)
  }

  /** The registry cannot be read (both the file and its copy are damaged). */
  damaged(): boolean {
    try {
      this.load()
      return false
    } catch {
      return true
    }
  }

  /** Shared mode is on. A damaged registry counts as on: nobody gets in without a PIN check. */
  enabled(): boolean {
    try {
      return !!this.load()?.enabled
    } catch {
      return true
    }
  }

  idleMinutes(): number {
    try {
      const m = this.load()?.idleMinutes ?? SEAT_IDLE_DEFAULT
      return Math.min(SEAT_IDLE_MAX, Math.max(SEAT_IDLE_MIN, Math.round(m) || SEAT_IDLE_DEFAULT))
    } catch {
      return SEAT_IDLE_DEFAULT
    }
  }

  list(): SeatPublic[] {
    let f: SeatsFile | null
    try {
      f = this.load()
    } catch {
      return []
    }
    if (!f?.enabled) return []
    const t = this.now()
    return f.seats
      .map((s) => ({ id: s.id, name: s.name, owner: s.owner, lastUsedAt: s.lastUsedAt, waitMs: Math.max(0, s.lockUntil - t) }))
      .sort((a, b) => Number(b.owner) - Number(a.owner) || a.name.localeCompare(b.name, 'ko'))
  }

  get(id: string): SeatPublic | null {
    return this.list().find((s) => s.id === id) ?? null
  }

  /** Data folder of a seat: the owner keeps the base folder, everybody else has an own one below it. */
  dirOf(seat: { id: string; owner: boolean }): string {
    if (seat.owner) return this.baseDir
    if (!SEAT_ID_RE.test(seat.id)) throw new Error('bad seat id')
    return join(this.baseDir, 'users', seat.id)
  }

  private open(): { f: SeatsFile } | { fail: SeatOutcome } {
    try {
      const f = this.load()
      if (!f?.enabled) return { fail: { ok: false, error: '공용 PC 사용이 꺼져 있습니다.' } }
      return { f }
    } catch {
      return { fail: { ok: false, error: '사용자 목록을 읽을 수 없습니다.' } }
    }
  }

  /** Check a PIN against one seat, counting wrong tries (saved at once, so a restart does not reset them). */
  private check(f: SeatsFile, seat: SeatRecord, pin: string, label = ''): SeatOutcome {
    const t = this.now()
    if (seat.lockUntil > t) return { ok: false, waitMs: seat.lockUntil - t, error: WAIT }
    if (!/^\d{1,20}$/.test(pin) || !pinMatches(pin, seat.salt, seat.hash)) {
      seat.fails += 1
      const waitMs = waitAfter(seat.fails)
      seat.lockUntil = waitMs ? t + waitMs : 0
      this.save(f)
      const left = Math.max(0, FREE_TRIES - seat.fails)
      return { ok: false, waitMs: waitMs || undefined, error: waitMs ? WAIT : `${label}${WRONG_PIN} (${left}번 더 틀리면 잠시 입력할 수 없습니다)` }
    }
    if (seat.fails || seat.lockUntil) {
      seat.fails = 0
      seat.lockUntil = 0
      this.save(f)
    }
    return { ok: true }
  }

  private checkOwner(f: SeatsFile, pin: string): SeatOutcome {
    const owner = f.seats.find((s) => s.owner)
    if (!owner) return { ok: false, error: 'PC 책임자가 없습니다.' }
    return this.check(f, owner, pin, 'PC 책임자 ')
  }

  private nameProblem(f: SeatsFile | null, name: string, exceptId?: string): string | null {
    if (!name) return '이름을 입력하세요.'
    if (name.length > SEAT_NAME_MAX) return `이름은 ${SEAT_NAME_MAX}자까지입니다.`
    if (f?.seats.some((s) => s.id !== exceptId && s.name.toLowerCase() === name.toLowerCase())) return '같은 이름의 사용자가 이미 있습니다. 구분할 수 있게 다르게 적으세요.'
    return null
  }

  /** Turn the mode on. Whoever does it becomes the PC 책임자 and keeps the data that is on the PC now. */
  enable(rawName: string, pin: string): SeatOutcome {
    let before: SeatsFile | null
    try {
      before = this.load()
    } catch {
      return { ok: false, error: '사용자 목록을 읽을 수 없습니다.' }
    }
    if (before?.enabled) return { ok: false, error: '공용 PC 사용이 이미 켜져 있습니다.' }
    const name = cleanSeatName(rawName)
    const bad = this.nameProblem(null, name) ?? seatPinProblem(pin)
    if (bad) return { ok: false, error: bad }
    const recovery = newRecoveryCode()
    const r = sealPin(normRecoveryCode(recovery))
    const t = this.now()
    const id = randomBytes(6).toString('hex')
    this.save({
      version: 1,
      enabled: true,
      idleMinutes: SEAT_IDLE_DEFAULT,
      recoverySalt: r.salt,
      recoveryHash: r.hash,
      recoveryFails: 0,
      recoveryLockUntil: 0,
      seats: [{ id, name, owner: true, ...sealPin(pin), createdAt: t, lastUsedAt: t, fails: 0, lockUntil: 0 }]
    })
    return { ok: true, recovery, id }
  }

  /** Sign-in and unlock: the PIN of that one seat. */
  verify(id: string, pin: string): SeatOutcome {
    const o = this.open()
    if ('fail' in o) return o.fail
    const seat = o.f.seats.find((s) => s.id === id)
    // an unknown id gets the same answer as a wrong PIN
    if (!seat) return { ok: false, error: WRONG_PIN }
    return this.check(o.f, seat, pin)
  }

  touch(id: string): void {
    const o = this.open()
    if ('fail' in o) return
    const seat = o.f.seats.find((s) => s.id === id)
    if (!seat) return
    seat.lastUsedAt = this.now()
    this.save(o.f)
  }

  /** A new person on this PC: allowed by the PC 책임자's PIN. */
  add(ownerPin: string, rawName: string, pin: string): SeatOutcome {
    const o = this.open()
    if ('fail' in o) return o.fail
    const { f } = o
    const name = cleanSeatName(rawName)
    const bad = this.nameProblem(f, name) ?? seatPinProblem(pin)
    if (bad) return { ok: false, error: bad }
    if (f.seats.length >= SEAT_MAX) return { ok: false, error: `한 PC에는 ${SEAT_MAX}명까지 등록할 수 있습니다.` }
    const auth = this.checkOwner(f, ownerPin)
    if (!auth.ok) return auth
    const t = this.now()
    const id = randomBytes(6).toString('hex')
    f.seats.push({ id, name, owner: false, ...sealPin(pin), createdAt: t, lastUsedAt: 0, fails: 0, lockUntil: 0 })
    this.save(f)
    return { ok: true, id }
  }

  /**
   * Take a person off this PC: with that person's own PIN, or with the PC 책임자's.
   * Only the registry entry goes here; the caller removes the data folder.
   */
  remove(id: string, pin: string, by: 'self' | 'owner'): SeatOutcome {
    const o = this.open()
    if ('fail' in o) return o.fail
    const { f } = o
    const seat = f.seats.find((s) => s.id === id)
    if (!seat) return { ok: false, error: '사용자를 찾을 수 없습니다.' }
    if (seat.owner) return { ok: false, error: 'PC 책임자는 지울 수 없습니다. 다른 사용자를 모두 지운 뒤 공용 PC 사용을 끄세요.' }
    const auth = by === 'self' ? this.check(f, seat, pin) : this.checkOwner(f, pin)
    if (!auth.ok) return auth
    f.seats = f.seats.filter((s) => s.id !== id)
    this.save(f)
    return { ok: true, id }
  }

  /** Forgotten PIN of somebody else: the PC 책임자 sets a new one. That person's data stays. */
  resetPin(ownerPin: string, id: string, newPin: string): SeatOutcome {
    const o = this.open()
    if ('fail' in o) return o.fail
    const { f } = o
    const seat = f.seats.find((s) => s.id === id)
    if (!seat) return { ok: false, error: '사용자를 찾을 수 없습니다.' }
    if (seat.owner) return { ok: false, error: 'PC 책임자의 PIN은 복구 코드로 새로 만듭니다.' }
    const bad = seatPinProblem(newPin)
    if (bad) return { ok: false, error: bad }
    const auth = this.checkOwner(f, ownerPin)
    if (!auth.ok) return auth
    Object.assign(seat, sealPin(newPin), { fails: 0, lockUntil: 0 })
    this.save(f)
    return { ok: true, id }
  }

  changePin(id: string, oldPin: string, newPin: string): SeatOutcome {
    const o = this.open()
    if ('fail' in o) return o.fail
    const { f } = o
    const seat = f.seats.find((s) => s.id === id)
    if (!seat) return { ok: false, error: WRONG_PIN }
    const bad = seatPinProblem(newPin)
    if (bad) return { ok: false, error: bad }
    const auth = this.check(f, seat, oldPin)
    if (!auth.ok) return auth
    Object.assign(seat, sealPin(newPin), { fails: 0, lockUntil: 0 })
    this.save(f)
    return { ok: true, id }
  }

  /** Forgotten PIN of the PC 책임자: the recovery code allows a new PIN and is replaced by a new code. */
  recoverOwner(code: string, newPin: string): SeatOutcome {
    const o = this.open()
    if ('fail' in o) return o.fail
    const { f } = o
    const owner = f.seats.find((s) => s.owner)
    if (!owner) return { ok: false, error: 'PC 책임자가 없습니다.' }
    const bad = seatPinProblem(newPin)
    if (bad) return { ok: false, error: bad }
    const t = this.now()
    if (f.recoveryLockUntil > t) return { ok: false, waitMs: f.recoveryLockUntil - t, error: WAIT }
    if (!pinMatches(normRecoveryCode(code), f.recoverySalt, f.recoveryHash)) {
      f.recoveryFails += 1
      const waitMs = waitAfter(f.recoveryFails)
      f.recoveryLockUntil = waitMs ? t + waitMs : 0
      this.save(f)
      return { ok: false, waitMs: waitMs || undefined, error: '복구 코드가 맞지 않습니다.' }
    }
    const recovery = newRecoveryCode()
    const r = sealPin(normRecoveryCode(recovery))
    Object.assign(owner, sealPin(newPin), { fails: 0, lockUntil: 0 })
    Object.assign(f, { recoverySalt: r.salt, recoveryHash: r.hash, recoveryFails: 0, recoveryLockUntil: 0 })
    this.save(f)
    return { ok: true, recovery, id: owner.id }
  }

  setIdleMinutes(ownerPin: string, minutes: number): SeatOutcome {
    const o = this.open()
    if ('fail' in o) return o.fail
    if (!Number.isInteger(minutes) || minutes < SEAT_IDLE_MIN || minutes > SEAT_IDLE_MAX) return { ok: false, error: `자동 잠금 시간은 ${SEAT_IDLE_MIN}~${SEAT_IDLE_MAX}분입니다.` }
    const auth = this.checkOwner(o.f, ownerPin)
    if (!auth.ok) return auth
    o.f.idleMinutes = minutes
    this.save(o.f)
    return { ok: true }
  }

  /** Turn the mode off: only when the PC 책임자 is the one person left (nobody's data is orphaned). */
  disable(ownerPin: string): SeatOutcome {
    const o = this.open()
    if ('fail' in o) return o.fail
    if (o.f.seats.length > 1) return { ok: false, error: '다른 사용자가 남아 있습니다. 먼저 다른 사용자를 모두 지우세요.' }
    const auth = this.checkOwner(o.f, ownerPin)
    if (!auth.ok) return auth
    rmSync(this.file(), { force: true })
    rmSync(`${this.file()}.bak`, { force: true })
    return { ok: true }
  }
}
