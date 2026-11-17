import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Thin wrapper over Node's built-in `node:sqlite` shared by the local DB (main
 * process) and the server DB (utility process). See 13.14 for why this replaced
 * better-sqlite3 + Drizzle.
 */

export type Params = Record<string, SQLInputValue | boolean | undefined> | SQLInputValue[]
export type Row = Record<string, unknown>

export interface Migration {
  id: number
  name: string
  sql: string
}

function normalize(params?: Params): SQLInputValue[] | Record<string, SQLInputValue> {
  if (!params) return []
  if (Array.isArray(params)) return params
  const out: Record<string, SQLInputValue> = {}
  for (const [k, v] of Object.entries(params)) {
    out[k] = v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v
  }
  return out
}

export class Db {
  readonly raw: DatabaseSync
  readonly path: string

  constructor(path: string) {
    this.path = path
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.raw = new DatabaseSync(path)
    this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;')
  }

  run(sql: string, params?: Params): { changes: number; lastId: number } {
    const p = normalize(params)
    const stmt = this.raw.prepare(sql)
    const r = Array.isArray(p) ? stmt.run(...p) : stmt.run(p)
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }
  }

  get<T = Row>(sql: string, params?: Params): T | undefined {
    const p = normalize(params)
    const stmt = this.raw.prepare(sql)
    return (Array.isArray(p) ? stmt.get(...p) : stmt.get(p)) as T | undefined
  }

  all<T = Row>(sql: string, params?: Params): T[] {
    const p = normalize(params)
    const stmt = this.raw.prepare(sql)
    return (Array.isArray(p) ? stmt.all(...p) : stmt.all(p)) as T[]
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  private depth = 0

  /** One transaction; a tx started inside another joins the outer one. */
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

  /** Apply pending migrations in order. Applied migrations are never edited (13.5). */
  migrate(migrations: Migration[]): number[] {
    this.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
    const done = new Set(this.all<{ id: number }>('SELECT id FROM _migrations').map((r) => r.id))
    const applied: number[] = []
    for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
      if (done.has(m.id)) continue
      this.tx(() => {
        this.exec(m.sql)
        this.run('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)', [m.id, m.name, Date.now()])
      })
      applied.push(m.id)
    }
    return applied
  }

  pendingMigrations(migrations: Migration[]): number {
    try {
      const done = new Set(this.all<{ id: number }>('SELECT id FROM _migrations').map((r) => r.id))
      return migrations.filter((m) => !done.has(m.id)).length
    } catch {
      return migrations.length
    }
  }

  close(): void {
    try {
      this.raw.close()
    } catch {
      // already closed
    }
  }
}

export function newId(): string {
  return crypto.randomUUID()
}

export function now(): number {
  return Date.now()
}

export function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}
