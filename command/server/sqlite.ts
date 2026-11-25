/**
 * 긴급구조지휘대: its own small wrapper over Node's built-in `node:sqlite`, so the command module
 * keeps its data in its own file (command.db) and does not depend on the host's DB code.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export type Params = SQLInputValue[]

export interface CmdMigration {
  id: number
  name: string
  sql: string
}

export class CmdDb {
  readonly raw: DatabaseSync
  private depth = 0

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.raw = new DatabaseSync(path)
    this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;')
  }

  run(sql: string, params: Params = []): { changes: number } {
    return { changes: Number(this.raw.prepare(sql).run(...params).changes) }
  }
  get<T>(sql: string, params: Params = []): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined
  }
  all<T>(sql: string, params: Params = []): T[] {
    return this.raw.prepare(sql).all(...params) as T[]
  }
  exec(sql: string): void {
    this.raw.exec(sql)
  }
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.raw.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const r = fn()
      this.raw.exec('COMMIT')
      return r
    } catch (e) {
      this.raw.exec('ROLLBACK')
      throw e
    } finally {
      this.depth--
    }
  }
  /** Apply pending migrations in order; applied ones are never edited. */
  migrate(list: CmdMigration[]): number[] {
    this.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
    const done = new Set(this.all<{ id: number }>('SELECT id FROM _migrations').map((r) => r.id))
    const applied: number[] = []
    for (const m of [...list].sort((a, b) => a.id - b.id)) {
      if (done.has(m.id)) continue
      this.tx(() => {
        this.exec(m.sql)
        this.run('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)', [m.id, m.name, Date.now()])
      })
      applied.push(m.id)
    }
    return applied
  }
  close(): void {
    try {
      this.raw.close()
    } catch {
      // already closed
    }
  }
}

export const newId = (): string => randomUUID()
export function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}
