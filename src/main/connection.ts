import { safeStorage } from 'electron'
import log from 'electron-log/main'
import { dpapiProtect, dpapiUnprotect } from './dpapi'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { userDataPath } from './paths'
import { localDb } from './localdb'

/**
 * Connection identity of this PC. The device key is stored encrypted with
 * Windows DPAPI in userData/device.dpapi (13.5), never in the DB.
 */
export type AppMode = 'server' | 'client'

export interface DeviceCredential {
  serverUrl: string
  deviceId: string
  deviceKey: string
  memberId: string
}

export interface PendingJoin {
  serverUrl: string
  requestId: string
  pollToken: string
  name: string
}

export interface ServerLocalConfig {
  dataDir: string
  port: number
  preventSleep: boolean
}

const KEY_FILE = (): string => userDataPath('device.key')
const DPAPI_FILE = (): string => userDataPath('device.dpapi')
let cached: DeviceCredential | null | undefined

export function getMode(): AppMode | null {
  return localDb().kv.get<AppMode>('mode') ?? null
}

export function setMode(mode: AppMode | null): void {
  if (mode) localDb().kv.set('mode', mode)
  else localDb().kv.delete('mode')
}

export function getServerConfig(): ServerLocalConfig | null {
  return localDb().kv.get<ServerLocalConfig>('serverConfig') ?? null
}

export function setServerConfig(c: ServerLocalConfig): void {
  localDb().kv.set('serverConfig', c)
}

/**
 * Device credential storage (13.5). Primary: Windows DPAPI file (survives crashes).
 * Legacy: safeStorage file from earlier versions, migrated on first read.
 */
export function readCredential(): DeviceCredential | null {
  if (cached !== undefined) return cached
  cached = null
  try {
    if (existsSync(DPAPI_FILE())) {
      cached = JSON.parse(dpapiUnprotect(readFileSync(DPAPI_FILE())).toString('utf8')) as DeviceCredential
      return cached
    }
  } catch (e) {
    log.error('[connection] cannot read device.dpapi', e)
  }
  try {
    if (existsSync(KEY_FILE())) {
      const buf = readFileSync(KEY_FILE())
      const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
      cached = JSON.parse(text) as DeviceCredential
      writeCredential(cached)
    }
  } catch (e) {
    log.error('[connection] cannot read device.key', e)
  }
  return cached
}

export function writeCredential(c: DeviceCredential): void {
  const text = JSON.stringify(c)
  try {
    writeFileSync(DPAPI_FILE(), dpapiProtect(Buffer.from(text, 'utf8')))
    rmSync(KEY_FILE(), { force: true })
  } catch (e) {
    log.warn('[connection] DPAPI unavailable, falling back to safeStorage', e)
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8')
    writeFileSync(KEY_FILE(), data)
  }
  cached = c
}

export function clearCredential(): void {
  rmSync(KEY_FILE(), { force: true })
  rmSync(DPAPI_FILE(), { force: true })
  cached = null
}

export function getPendingJoin(): PendingJoin | null {
  return localDb().kv.get<PendingJoin>('pendingJoin') ?? null
}

export function setPendingJoin(p: PendingJoin | null): void {
  if (p) localDb().kv.set('pendingJoin', p)
  else localDb().kv.delete('pendingJoin')
}

/** Update the server address after rediscovery without changing identity. */
export function updateServerUrl(serverUrl: string): void {
  const c = readCredential()
  if (c) writeCredential({ ...c, serverUrl })
}
