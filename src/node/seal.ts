import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Text sealed with AES-256-GCM for data kept on this PC that came from (or is on its way to)
 * the server: the offline read cache and the outbox. The key never leaves the main process
 * and is itself kept under Windows DPAPI (src/main/vault.ts), so the local DB file copied to
 * another PC or read by another Windows account shows nothing of the team's data.
 */
const TAG = 'v1:'

export const isSealed = (s: string): boolean => s.startsWith(TAG)

export function seal(key: Buffer, text: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return TAG + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')
}

/** null when the text was not sealed with this key (another PC's data, a damaged row). */
export function unseal(key: Buffer, sealed: string): string | null {
  if (!isSealed(sealed)) return null
  try {
    const raw = Buffer.from(sealed.slice(TAG.length), 'base64')
    if (raw.length < 28) return null
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
    d.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
  } catch {
    return null
  }
}
