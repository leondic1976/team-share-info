import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { PIN_LEN } from '../shared/constants'

/**
 * PIN and recovery-code hashing shared by the program lock (applock) and the people of a
 * shared PC (seats). Only salted scrypt hashes are ever stored.
 */
export interface Sealed {
  salt: string
  hash: string
}

const digest = (secret: string, salt: string): Buffer => scryptSync(secret, Buffer.from(salt, 'hex'), 32)

export function pinMatches(secret: string, salt: string, hash: string): boolean {
  const want = Buffer.from(hash, 'hex')
  const got = digest(secret, salt)
  return want.length === got.length && timingSafeEqual(want, got)
}

export function sealPin(secret: string): Sealed {
  const salt = randomBytes(16).toString('hex')
  return { salt, hash: digest(secret, salt).toString('hex') }
}

export const normRecoveryCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

export function newRecoveryCode(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const c = [...randomBytes(8)].map((b) => abc[b % abc.length]).join('')
  return `${c.slice(0, 4)}-${c.slice(4)}`
}

/**
 * null when a PIN may be made; otherwise what is wrong with it. Asked for every new or changed
 * PIN (never for checking an existing one). Four digits are 10,000 combinations, so the handful
 * everybody tries first is refused: one digit repeated (10) and straight runs up or down (14).
 * What really limits guessing is the wait after wrong tries (below).
 */
export function newPinProblem(pin: string): string | null {
  if (!new RegExp(`^\\d{${PIN_LEN}}$`).test(pin)) return `PIN은 숫자 ${PIN_LEN}자리입니다.`
  if (/^(\d)\1+$/.test(pin)) return '1111처럼 같은 숫자만 이어진 PIN은 쓸 수 없습니다.'
  const steps = [...pin].slice(1).map((c, i) => Number(c) - Number(pin[i]))
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return '1234처럼 이어지는 숫자는 PIN으로 쓸 수 없습니다.'
  return null
}

export const FREE_TRIES = 5

/** How long nothing is accepted after this many wrong tries in a row (from the fifth on: 30s, 1min, ... 10min). */
export function waitAfter(fails: number): number {
  return fails >= FREE_TRIES ? Math.min(600_000, 30_000 * 2 ** (fails - FREE_TRIES)) : 0
}
