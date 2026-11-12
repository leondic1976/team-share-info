import type { Db } from '../../node/sqlite'

export class KvRepo {
  constructor(private readonly db: Db) {}

  get<T = unknown>(key: string): T | undefined {
    const row = this.db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key])
    if (!row) return undefined
    try {
      return JSON.parse(row.value) as T
    } catch {
      return undefined
    }
  }

  set(key: string, value: unknown): void {
    if (value === undefined) {
      this.delete(key)
      return
    }
    this.db.run(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, JSON.stringify(value), Date.now()]
    )
  }

  delete(key: string): void {
    this.db.run('DELETE FROM kv WHERE key = ?', [key])
  }

  all(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const r of this.db.all<{ key: string; value: string }>('SELECT key, value FROM kv')) {
      try {
        out[r.key] = JSON.parse(r.value)
      } catch {
        // skip corrupt value
      }
    }
    return out
  }
}
