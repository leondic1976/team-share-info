import { describe, it, expect } from 'vitest'
import { Db } from '../../src/node/sqlite'
import { LOCAL_MIGRATIONS } from '../../src/main/localdb/migrations'
import { KvRepo } from '../../src/main/localdb/kv'

describe('local db', () => {
  it('applies migrations once', () => {
    const db = new Db(':memory:')
    expect(db.migrate(LOCAL_MIGRATIONS)).toEqual(LOCAL_MIGRATIONS.map((m) => m.id))
    expect(db.migrate(LOCAL_MIGRATIONS)).toEqual([])
    expect(db.pendingMigrations(LOCAL_MIGRATIONS)).toBe(0)
  })

  it('kv stores json values and overwrites', () => {
    const db = new Db(':memory:')
    db.migrate(LOCAL_MIGRATIONS)
    const kv = new KvRepo(db)
    kv.set('prefs', { theme: 'dark', fontSize: 15 })
    expect(kv.get('prefs')).toEqual({ theme: 'dark', fontSize: 15 })
    kv.set('prefs', { theme: 'light' })
    expect(kv.get('prefs')).toEqual({ theme: 'light' })
    kv.set('n', 3)
    expect(kv.all()).toEqual({ prefs: { theme: 'light' }, n: 3 })
    kv.delete('n')
    expect(kv.get('n')).toBeUndefined()
  })

  it('rolls back failed transactions', () => {
    const db = new Db(':memory:')
    db.migrate(LOCAL_MIGRATIONS)
    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO kv (key, value, updated_at) VALUES ('a', '1', 0)")
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(db.get('SELECT * FROM kv')).toBeUndefined()
  })
})
