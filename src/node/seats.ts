import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SEAT_IDLE_DEFAULT, SEAT_IDLE_MAX, SEAT_IDLE_MIN, SEAT_MAX, SEAT_NAME_MAX } from '../shared/constants'
import { FREE_TRIES, newPinProblem, newRecoveryCode, normRecoveryCode, pinMatches, sealPin, waitAfter } from './pin'

/**
 * People of a shared PC ("공용 PC 사용"): several people use TeamHub on one member PC under
 * one Windows account. Each person ("seat") has a name, an own data folder and - if they want
 * one - a PIN, so each has an own server approval, account and personal data.
 *
 * This file is the registry only (names, salted PIN hashes, wrong-try counters) and knows
 * nothing about Electron. It lives in the base app data folder as seats.json.
 *  - The person who turns the mode on is the PC 책임자 (owner) and keeps the base folder.
 *  - Everybody else gets <base>/users/<id>.
 *  - Adding a person, removing one and resetting a forgotten PIN need the owner's PIN.
 *
 * PINs: a new or changed PIN has exactly 4 digits (pin.ts). PINs made before that rule (6 to 12
 * digits) keep working until they are changed. A PIN is each person's own choice: without one
 * the name alone opens that person's TeamHub. "No PIN" is said by null in both hash fields and
 * by nothing else; a person who has a PIN is never opened by an empty or missing one. When the
 * PC 책임자 has no PIN, the management actions ask for nothing (the settings card says so).
 */
export { SEAT_IDLE_MAX, SEAT_IDLE_MIN }
export const SEAT_ID_RE = /^[a-f0-9]{12}$/

export interface SeatRecord {
  id: string
  name: string
  /** PC 책임자: turned the mode on, uses the base folder, cannot be removed. */
  owner: boolean
  /** Salted hash of the PIN. Both null: this person uses no PIN. */
  salt: string | null
  hash: string | null
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
  /** Recovery code of the owner's PIN (shown once when that PIN was made); null while the owner has no PIN. */
  recoverySalt: string | null
  recoveryHash: string | null
  recoveryFails: number
  recoveryLockUntil: number
  seats: SeatRecord[]
}

export interface SeatPublic {
  id: string
  name: string
  owner: boolean
  /** False: the name alone signs this person in. */
  hasPin: boolean
  lastUsedAt: number
  waitMs: number
}

export interface SeatOutcome {
  ok: boolean
  error?: string
  waitMs?: number
  /** Shown once after the owner made a PIN (turning the mode on, or later) or replaced it with the code. */
  recovery?: string
  /** The seat that was made or removed. */
  id?: string
}

const WRONG_PIN = 'PIN이 맞지 않습니다.'
const WAIT = '여러 번 틀려 잠시 입력할 수 없습니다.'

const NEED_PIN = 'PIN을 입력하세요.'
const NO_PIN = { salt: null, hash: null } as const

/** null when the PIN may be made; otherwise what is wrong with it (exactly 4 digits, not an obvious one). */
export const seatPinProblem = newPinProblem

/** Whether a person has a PIN. Only null in both fields means "none": a damaged record counts as a PIN that nothing matches. */
export function seatHasPin(seat: { salt: unknown; hash: unknown }): boolean {
  return !(seat.salt === null && seat.hash === null)
}

export function cleanSeatName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Name for a person who is put back: their own, or "<name> (복구)", "<name> (복구 2)"... when
 * somebody else has it now.
 */
export function restoredSeatName(name: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()))
  const base = name || '사용자'
  if (!used.has(base.toLowerCase()) && base.length <= SEAT_NAME_MAX) return base
  for (let i = 1; i < 1000; i++) {
    const mark = i === 1 ? ' (복구)' : ` (복구 ${i})`
    const n = base.slice(0, SEAT_NAME_MAX - mark.length).trimEnd() + mark
    if (!used.has(n.toLowerCase())) return n
  }
  return base
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
      .map((s) => ({ id: s.id, name: s.name, owner: s.owner, hasPin: seatHasPin(s), lastUsedAt: s.lastUsedAt, waitMs: Math.max(0, s.lockUntil - t) }))
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

  /**
   * Check a PIN against one seat, counting wrong tries (saved at once, so a restart does not
   * reset them). A person without a PIN has nothing to check. For a person with a PIN an empty
   * one is never right; it is not a guess either, so it is refused without being counted. Old
   * PINs longer than 4 digits are checked like any other.
   */
  private check(f: SeatsFile, seat: SeatRecord, pin: string, label = ''): SeatOutcome {
    if (!seatHasPin(seat)) return { ok: true }
    const t = this.now()
    if (seat.lockUntil > t) return { ok: false, waitMs: seat.lockUntil - t, error: WAIT }
    if (typeof pin !== 'string' || pin === '') return { ok: false, error: `${label}${NEED_PIN}` }
    if (!/^\d{1,20}$/.test(pin) || typeof seat.salt !== 'string' || typeof seat.hash !== 'string' || !seat.hash || !pinMatches(pin, seat.salt, seat.hash)) {
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

  /**
   * Turn the mode on. Whoever does it becomes the PC 책임자 and keeps the data that is on the PC
   * now. An empty PIN: the PC 책임자 uses none (then there is no recovery code either).
   */
  enable(rawName: string, pin: string): SeatOutcome {
    let before: SeatsFile | null
    try {
      before = this.load()
    } catch {
      return { ok: false, error: '사용자 목록을 읽을 수 없습니다.' }
    }
    if (before?.enabled) return { ok: false, error: '공용 PC 사용이 이미 켜져 있습니다.' }
    const name = cleanSeatName(rawName)
    const bad = this.nameProblem(null, name) ?? (pin === '' ? null : seatPinProblem(pin))
    if (bad) return { ok: false, error: bad }
    const recovery = pin === '' ? undefined : newRecoveryCode()
    const r = recovery ? sealPin(normRecoveryCode(recovery)) : NO_PIN
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
      seats: [{ id, name, owner: true, ...(pin === '' ? NO_PIN : sealPin(pin)), createdAt: t, lastUsedAt: t, fails: 0, lockUntil: 0 }]
    })
    return { ok: true, recovery, id }
  }

  /** Sign-in and unlock: the PIN of that one seat (nothing to check for a person without a PIN). */
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

  /** A new person on this PC: allowed by the PC 책임자's PIN. An empty PIN: the new person uses none. */
  add(ownerPin: string, rawName: string, pin: string): SeatOutcome {
    const o = this.open()
    if ('fail' in o) return o.fail
    const { f } = o
    const name = cleanSeatName(rawName)
    const bad = this.nameProblem(f, name) ?? (pin === '' ? null : seatPinProblem(pin))
    if (bad) return { ok: false, error: bad }
    if (f.seats.length >= SEAT_MAX) return { ok: false, error: `한 PC에는 ${SEAT_MAX}명까지 등록할 수 있습니다.` }
    const auth = this.checkOwner(f, ownerPin)
    if (!auth.ok) return auth
    const t = this.now()
    const id = randomBytes(6).toString('hex')
    f.seats.push({ id, name, owner: false, ...(pin === '' ? NO_PIN : sealPin(pin)), createdAt: t, lastUsedAt: 0, fails: 0, lockUntil: 0 })
    this.save(f)
    return { ok: true, id }
  }

  /**
   * Check that a person may be taken off this PC (that person's own PIN, or the PC 책임자's)
   * without doing it yet: the caller first puts the person's data aside (removed-seats.ts)
   * and only then drops the registry entry. The record is what puts the person back later.
   */
  authRemove(id: string, pin: string, by: 'self' | 'owner'): SeatOutcome & { record?: SeatRecord } {
    const o = this.open()
    if ('fail' in o) return o.fail
    const { f } = o
    const seat = f.seats.find((s) => s.id === id)
    if (!seat) return { ok: false, error: '사용자를 찾을 수 없습니다.' }
    if (seat.owner) return { ok: false, error: 'PC 책임자는 지울 수 없습니다. 다른 사용자를 모두 지운 뒤 공용 PC 사용을 끄세요.' }
    const auth = by === 'self' ? this.check(f, seat, pin) : this.checkOwner(f, pin)
    if (!auth.ok) return auth
    return { ok: true, id, record: { ...seat } }
  }

  /** Drop the registry entry of somebody who is not the PC 책임자 (after `authRemove`). */
  drop(id: string): boolean {
    try {
      const o = this.open()
      if ('fail' in o) return false
      const seat = o.f.seats.find((s) => s.id === id)
      if (!seat || seat.owner) return false
      o.f.seats = o.f.seats.filter((s) => s.id !== id)
      this.save(o.f)
      return true
    } catch {
      return false
    }
  }

  /**
   * Take a person off this PC: with that person's own PIN, or with the PC 책임자's.
   * Only the registry entry goes here; the caller looks after the data folder.
   */
  remove(id: string, pin: string, by: 'self' | 'owner'): SeatOutcome {
    const auth = this.authRemove(id, pin, by)
    if (!auth.ok) return auth
    return this.drop(id) ? { ok: true, id } : { ok: false, error: '사용자 목록을 저장하지 못했습니다.' }
  }

  /** The PC 책임자's PIN alone (erasing a kept backup of a removed person for good). */
  verifyOwner(pin: string): SeatOutcome {
    const o = this.open()
    if ('fail' in o) return o.fail
    return this.checkOwner(o.f, pin)
  }

  /** Ids of everybody registered now; null when the registry cannot be read. */
  ids(): string[] | null {
    try {
      return (this.load()?.seats ?? []).map((s) => s.id)
    } catch {
      return null
    }
  }

  /** What stands in the way of putting a removed person back, before any PIN is asked. */
  restoreProblem(record: SeatRecord): string | null {
    const o = this.open()
    if ('fail' in o) return o.fail.error ?? '공용 PC 사용이 꺼져 있습니다.'
    if (!SEAT_ID_RE.test(record.id) || record.owner) return '보관된 사용자 정보가 올바르지 않습니다.'
    if (o.f.seats.some((s) => s.id === record.id)) return '같은 사용자가 이미 등록되어 있습니다.'
    if (o.f.seats.length >= SEAT_MAX) return `한 PC에는 ${SEAT_MAX}명까지 등록할 수 있습니다. 다른 사용자를 지운 뒤 복구하세요.`
    return null
  }

  /**
   * Put a removed person back with the PIN they had - or without one, if they had none (PC
   * 책임자's PIN needed). When somebody
   * with the same name was added meanwhile, the restored person gets a marked name: names
   * are how people pick themselves at the sign-in window and must stay distinct.
   */
  restore(ownerPin: string, record: SeatRecord): SeatOutcome & { name?: string } {
    const bad = this.restoreProblem(record)
    if (bad) return { ok: false, error: bad }
    const o = this.open()
    if ('fail' in o) return o.fail
    const { f } = o
    const auth = this.checkOwner(f, ownerPin)
    if (!auth.ok) return auth
    const name = restoredSeatName(
      cleanSeatName(record.name),
      f.seats.map((s) => s.name)
    )
    const pin = seatHasPin(record) ? { salt: record.salt, hash: record.hash } : NO_PIN
    f.seats.push({ id: record.id, name, owner: false, ...pin, createdAt: record.createdAt, lastUsedAt: record.lastUsedAt, fails: 0, lockUntil: 0 })
    this.save(f)
    return { ok: true, id: record.id, name }
  }

  /** Forgotten PIN of somebody else: the PC 책임자 sets a new one, or none (empty). That person's data stays. */
  resetPin(ownerPin: string, id: string, newPin: string): SeatOutcome {
    const o = this.open()
    if ('fail' in o) return o.fail
    const { f } = o
    const seat = f.seats.find((s) => s.id === id)
    if (!seat) return { ok: false, error: '사용자를 찾을 수 없습니다.' }
    if (seat.owner) return { ok: false, error: 'PC 책임자의 PIN은 복구 코드로 새로 만듭니다.' }
    const bad = newPin === '' ? null : seatPinProblem(newPin)
    if (bad) return { ok: false, error: bad }
    const auth = this.checkOwner(f, ownerPin)
    if (!auth.ok) return auth
    Object.assign(seat, newPin === '' ? NO_PIN : sealPin(newPin), { fails: 0, lockUntil: 0 })
    this.save(f)
    return { ok: true, id }
  }

  /**
   * A person makes or changes their own PIN. With a PIN: the old one is needed. Without: nothing
   * is (anybody at the PC could open that seat anyway). The PC 책임자 making a PIN gets a
   * recovery code for it.
   */
  changePin(id: string, oldPin: string, newPin: string): SeatOutcome {
    const o = this.open()
    if ('fail' in o) return o.fail
    const { f } = o
    const seat = f.seats.find((s) => s.id === id)
    if (!seat) return { ok: false, error: WRONG_PIN }
    const bad = seatPinProblem(newPin)
    if (bad) return { ok: false, error: bad }
    const had = seatHasPin(seat)
    const auth = this.check(f, seat, oldPin)
    if (!auth.ok) return auth
    Object.assign(seat, sealPin(newPin), { fails: 0, lockUntil: 0 })
    let recovery: string | undefined
    if (seat.owner && (!had || typeof f.recoveryHash !== 'string')) {
      recovery = newRecoveryCode()
      const r = sealPin(normRecoveryCode(recovery))
      Object.assign(f, { recoverySalt: r.salt, recoveryHash: r.hash, recoveryFails: 0, recoveryLockUntil: 0 })
    }
    this.save(f)
    return { ok: true, id, recovery }
  }

  /** A person stops using a PIN (their current PIN is needed). The PC 책임자's recovery code goes with it. */
  removePin(id: string, pin: string): SeatOutcome {
    const o = this.open()
    if ('fail' in o) return o.fail
    const { f } = o
    const seat = f.seats.find((s) => s.id === id)
    if (!seat) return { ok: false, error: WRONG_PIN }
    if (!seatHasPin(seat)) return { ok: false, error: '지금 PIN을 쓰고 있지 않습니다.' }
    const auth = this.check(f, seat, pin)
    if (!auth.ok) return auth
    Object.assign(seat, NO_PIN, { fails: 0, lockUntil: 0 })
    if (seat.owner) Object.assign(f, { recoverySalt: null, recoveryHash: null, recoveryFails: 0, recoveryLockUntil: 0 })
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
    if (!seatHasPin(owner) || typeof f.recoverySalt !== 'string' || typeof f.recoveryHash !== 'string' || !f.recoveryHash) return { ok: false, error: 'PC 책임자가 PIN을 쓰지 않아 복구 코드가 없습니다.' }
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
    if (!Number.isInteger(minutes) || minutes < SEAT_IDLE_MIN || minutes > SEAT_IDLE_MAX) return { ok: false, error: `자동 로그아웃 시간은 ${SEAT_IDLE_MIN}~${SEAT_IDLE_MAX}분입니다.` }
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
