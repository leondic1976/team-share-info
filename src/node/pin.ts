import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

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

export const FREE_TRIES = 5

/** How long nothing is accepted after this many wrong tries in a row (from the fifth on: 30s, 1min, ... 10min). */
export function waitAfter(fails: number): number {
  return fails >= FREE_TRIES ? Math.min(600_000, 30_000 * 2 ** (fails - FREE_TRIES)) : 0
}
