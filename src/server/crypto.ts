import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export function sha256Hex(v: string): string {
  return createHash('sha256').update(v).digest('hex')
}

export function randomKey(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(pin, salt, 32)
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`
}

export function verifyPin(pin: string, stored: string): boolean {
  const [alg, saltHex, hashHex] = stored.split(':')
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(pin, Buffer.from(saltHex, 'hex'), expected.length)
  return timingSafeEqual(expected, actual)
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}
