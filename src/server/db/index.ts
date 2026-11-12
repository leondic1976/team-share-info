import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Db } from '../../node/sqlite'
import { SERVER_MIGRATIONS } from './migrations'

export function serverDbPath(dataDir: string): string {
  return join(dataDir, 'teamhub.db')
}

/**
 * Open the server DB and migrate. Before applying pending migrations on an
 * existing DB, copy it to backups/pre-migrate-<version>.db (13.5).
 */
export function openServerDb(dataDir: string, version = 'dev'): Db {
  mkdirSync(dataDir, { recursive: true })
  const path = serverDbPath(dataDir)
  const existed = existsSync(path)
  const db = new Db(path)
  try {
    if (existed && db.pendingMigrations(SERVER_MIGRATIONS) > 0) {
      const dir = join(dataDir, 'backups')
      mkdirSync(dir, { recursive: true })
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      copyFileSync(path, join(dir, `pre-migrate-${version}-${Date.now()}.db`))
    }
    db.migrate(SERVER_MIGRATIONS)
  } catch (e) {
    db.close()
    throw e
  }
  return db
}

export function openMemoryServerDb(): Db {
  const db = new Db(':memory:')
  db.migrate(SERVER_MIGRATIONS)
  return db
}
