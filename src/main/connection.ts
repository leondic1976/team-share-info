import { safeStorage } from 'electron'
import log from 'electron-log/main'
import { dpapiProtect, dpapiUnprotect } from './dpapi'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { userDataPath } from './paths'
import { localDb } from './localdb'
import { lockRole } from './pcid'
import type { SavedConnInfo } from '../shared/ipc'

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
  // the first setup decides whether this is a server PC or a member PC, for good (pcid.ts)
  if (mode && !lockRole(mode)) throw new Error('role of this PC is fixed')
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

// ---------- remembered connections (settings: switch between server / member PC) ----------

/** A connection this PC used before; kept so it can be used again without a new approval. */
export interface SavedConnection {
  id: string
  mode: AppMode
  label: string
  savedAt: number
  credential: DeviceCredential
  serverConfig?: ServerLocalConfig
}

const SAVED_FILE = (): string => userDataPath('connections.dpapi')
let savedCache: SavedConnection[] | undefined

function readSaved(): SavedConnection[] {
  if (savedCache) return savedCache
  savedCache = []
  try {
    if (existsSync(SAVED_FILE())) savedCache = JSON.parse(dpapiUnprotect(readFileSync(SAVED_FILE())).toString('utf8')) as SavedConnection[]
  } catch (e) {
    log.error('[connection] cannot read connections.dpapi', e)
  }
  return savedCache
}

/** Device keys are secrets: the list is stored DPAPI-encrypted like device.dpapi. Throws when it cannot be written. */
function writeSaved(list: SavedConnection[]): void {
  if (list.length === 0) rmSync(SAVED_FILE(), { force: true })
  else writeFileSync(SAVED_FILE(), dpapiProtect(Buffer.from(JSON.stringify(list), 'utf8')))
  savedCache = list
}

export function listSaved(): SavedConnInfo[] {
  return readSaved()
    .map((s) => ({ id: s.id, mode: s.mode, label: s.label, savedAt: s.savedAt, serverUrl: s.mode === 'client' ? s.credential.serverUrl : null, dataDir: s.serverConfig?.dataDir ?? null }))
    .sort((a, b) => b.savedAt - a.savedAt)
}

/**
 * Put the connection in use away (remembered) and leave this PC unconfigured.
 * Returns false when there is nothing to remember. The caller stops the embedded server first.
 */
export function archiveCurrent(): boolean {
  const credential = readCredential()
  const mode = getMode()
  if (!credential || !mode) return false
  const hello = localDb().kv.get<{ orgName?: string; teamName?: string }>('lastHello')
  const label = [hello?.orgName, hello?.teamName].filter(Boolean).join(' ') || (mode === 'server' ? '이 PC의 서버' : credential.serverUrl.replace(/^https?:\/\//, ''))
  const entry: SavedConnection = { id: `${mode}:${credential.deviceId}`, mode, label, savedAt: Date.now(), credential, serverConfig: mode === 'server' ? (getServerConfig() ?? undefined) : undefined }
  // written before anything is cleared: a failure here must leave the current connection intact
  writeSaved([entry, ...readSaved().filter((s) => s.id !== entry.id)])
  clearCredential()
  setPendingJoin(null)
  setMode(null)
  return true
}

/** Make a remembered connection the one in use (it leaves the remembered list). */
export function restoreSaved(id: string): SavedConnection | null {
  const entry = readSaved().find((s) => s.id === id)
  if (!entry) return null
  writeCredential(entry.credential)
  setPendingJoin(null)
  setMode(entry.mode)
  if (entry.mode === 'server' && entry.serverConfig) setServerConfig(entry.serverConfig)
  writeSaved(readSaved().filter((s) => s.id !== id))
  return entry
}

export function forgetSaved(id: string): void {
  writeSaved(readSaved().filter((s) => s.id !== id))
}
