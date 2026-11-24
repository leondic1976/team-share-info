import log from 'electron-log/main'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dpapiProtectAsync, dpapiUnprotectAsync } from './dpapi'
import { userDataPath } from './paths'
import { seal, unseal } from '../node/seal'

/**
 * Key for the team data kept on this PC (offline read cache, outbox). 32 random bytes made
 * once, stored under Windows DPAPI of the signed-in account (cache-key.dpapi). When the key
 * cannot be read or made, nothing is kept on disk: the cache then lives in memory only.
 */
const FILE = (): string => userDataPath('cache-key.dpapi')
let loading: Promise<Buffer | null> | null = null

async function load(): Promise<Buffer | null> {
  try {
    if (existsSync(FILE())) {
      const k = await dpapiUnprotectAsync(readFileSync(FILE()))
      if (k.length === 32) return k
      log.warn('[vault] cache key unreadable; a new one is made (old cache rows are dropped)')
    }
    const k = randomBytes(32)
    writeFileSync(FILE(), await dpapiProtectAsync(k))
    return k
  } catch (e) {
    log.error('[vault] no cache key: team data is not kept on disk', e)
    return null
  }
}

export function vaultKey(): Promise<Buffer | null> {
  loading ??= load()
  return loading
}

export async function vaultSeal(text: string): Promise<string | null> {
  const k = await vaultKey()
  return k ? seal(k, text) : null
}

export async function vaultOpen(sealed: string): Promise<string | null> {
  const k = await vaultKey()
  return k ? unseal(k, sealed) : null
}
