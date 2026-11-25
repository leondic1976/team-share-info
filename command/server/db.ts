import { join } from 'node:path'
import { CmdDb, newId } from './sqlite'
import { COMMAND_MIGRATIONS } from './migrations'

export const COMMAND_DB_FILE = 'command.db'

/** The three 근무 유형 the module starts with (they can be renamed, hidden and added to). */
const FIRST_MODES = ['긴급구조지휘대', '긴급구조통제단', '풍수해 비상상황근무']

/** Opens command.db in `dataDir` (or in memory), migrates it and puts in the first 근무 유형 once. */
export function openCommandDb(dataDir: string | null): CmdDb {
  const db = new CmdDb(dataDir ? join(dataDir, COMMAND_DB_FILE) : ':memory:')
  try {
    db.migrate(COMMAND_MIGRATIONS)
    if (!db.get('SELECT 1 FROM cmd_settings WHERE key = ?', ['seeded'])) {
      db.tx(() => {
        const t = Date.now()
        FIRST_MODES.forEach((name, i) => db.run('INSERT INTO cmd_modes (id, name, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [newId(), name, i, t, t]))
        db.run('INSERT INTO cmd_settings (key, value) VALUES (?, ?)', ['seeded', '1'])
      })
    }
  } catch (e) {
    db.close()
    throw e
  }
  return db
}
