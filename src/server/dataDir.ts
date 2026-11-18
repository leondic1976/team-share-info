import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { serverDbPath } from './db'

/**
 * What a data folder already holds. The wizard uses it to tell "new folder" from
 * "a team was set up here before" (the server DB stays behind when a connection is reset or forgotten).
 */
export interface DataDirInfo {
  initialized: boolean
  orgName?: string
  teamName?: string
}

export function inspectDataDir(dataDir: string): DataDirInfo {
  const dbFile = serverDbPath(dataDir)
  if (!existsSync(dbFile)) return { initialized: false }
  let ro: DatabaseSync
  try {
    ro = new DatabaseSync(dbFile, { readOnly: true })
  } catch {
    return { initialized: false }
  }
  try {
    const read = (key: string): unknown => {
      const r = ro.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
      return r ? JSON.parse(r.value) : undefined
    }
    if (read('initialized') !== true) return { initialized: false }
    const org = (read('org') ?? {}) as { orgName?: string; teamName?: string }
    return { initialized: true, orgName: org.orgName, teamName: org.teamName }
  } catch {
    // no settings table or unreadable: not a set-up server
    return { initialized: false }
  } finally {
    ro.close()
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')
const stamp = (d = new Date()): string => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

/**
 * Move the server data of the previous team (DB and files) into `previous-<stamp>/` inside
 * the data folder so a new team can be set up there. Nothing is deleted.
 * The server must not be running on this folder. Returns the folder the data went to.
 */
export function archiveDataDir(dataDir: string): string | null {
  const dbFile = serverDbPath(dataDir)
  if (!existsSync(dbFile)) return null
  // fold the WAL into the DB file so the moved copy is complete on its own
  try {
    const db = new DatabaseSync(dbFile)
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }
  } catch {
    // a DB that cannot be opened is still moved aside as it is
  }
  let target = join(dataDir, `previous-${stamp()}`)
  for (let i = 2; existsSync(target); i++) target = join(dataDir, `previous-${stamp()}-${i}`)
  mkdirSync(target, { recursive: true })
  // the DB goes first: if it is locked nothing has been moved yet
  renameSync(dbFile, join(target, 'teamhub.db'))
  for (const name of ['teamhub.db-wal', 'teamhub.db-shm', 'files', 'restore-pending.json']) {
    const src = join(dataDir, name)
    if (existsSync(src)) renameSync(src, join(target, name))
  }
  return target
}
