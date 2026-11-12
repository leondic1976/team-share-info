import type { Db } from '../node/sqlite'
import {
  allSettingsSchema,
  backupSettingsSchema,
  networkSettingsSchema,
  opsSettingsSchema,
  orgSettingsSchema,
  storageSettingsSchema,
  type AllSettings
} from '../shared/schemas/settings'
import { DEFAULT_NOTICE_TEXT } from '../shared/constants'

type SectionKey = keyof AllSettings

const SECTION_SCHEMAS = {
  org: orgSettingsSchema,
  network: networkSettingsSchema,
  storage: storageSettingsSchema,
  backup: backupSettingsSchema,
  ops: opsSettingsSchema
} as const

function readRaw(db: Db, key: string): unknown {
  const row = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
  if (!row) return undefined
  try {
    return JSON.parse(row.value)
  } catch {
    return undefined
  }
}

export function writeSetting(db: Db, key: string, value: unknown): void {
  db.run(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [key, JSON.stringify(value), Date.now()]
  )
}

export function readSetting<T>(db: Db, key: string): T | undefined {
  return readRaw(db, key) as T | undefined
}

export function getSection<K extends SectionKey>(db: Db, key: K): AllSettings[K] {
  const raw = readRaw(db, key) ?? {}
  const schema = SECTION_SCHEMAS[key]
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data as AllSettings[K]
  if (key === 'org') return { orgName: '', teamName: '', noticeText: DEFAULT_NOTICE_TEXT } as AllSettings[K]
  return schema.parse({}) as AllSettings[K]
}

export function getAllSettings(db: Db): AllSettings {
  return {
    org: getSection(db, 'org'),
    network: getSection(db, 'network'),
    storage: getSection(db, 'storage'),
    backup: getSection(db, 'backup'),
    ops: getSection(db, 'ops')
  }
}

export function patchSection<K extends SectionKey>(db: Db, key: K, patch: Partial<AllSettings[K]>): AllSettings[K] {
  const merged = { ...getSection(db, key), ...patch }
  const parsed = SECTION_SCHEMAS[key].parse(merged) as AllSettings[K]
  writeSetting(db, key, parsed)
  return parsed
}

export function isInitialized(db: Db): boolean {
  return readSetting<boolean>(db, 'initialized') === true
}

export { allSettingsSchema }
