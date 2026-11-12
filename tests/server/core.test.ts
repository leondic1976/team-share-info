import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type TestServer } from './helpers'
import { openServerDb } from '../../src/server/db'
import { buildApp } from '../../src/server/app'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})

describe('server core (M1-1)', () => {
  it('answers hello before initialization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamhub-hello-'))
    const db = openServerDb(dir, 'test')
    const { app } = await buildApp({ db, dataDir: dir, version: '9.9.9' })
    const r = await app.inject({ method: 'GET', url: '/api/hello' })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({ name: 'TeamHub', version: '9.9.9', initialized: false })
    await app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('answers hello with org info after setup', async () => {
    s = await createTestServer()
    const r = await s.req(null, { method: 'GET', url: '/api/hello' })
    expect(r.json().data).toMatchObject({ orgName: '테스트기관', teamName: '행정팀', initialized: true })
  })

  it('backs up the db before applying new migrations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamhub-mig-'))
    const db = openServerDb(dir, 'a')
    db.exec('DELETE FROM _migrations WHERE id = 1; DROP TABLE settings;')
    db.exec(`CREATE TABLE settings_tmp (x)`)
    db.close()
    // Re-open: migration 1 is pending again -> backup taken, then migrate fails because tables exist.
    expect(() => openServerDb(dir, 'b')).toThrow()
    expect(readdirSync(join(dir, 'backups')).some((f) => f.startsWith('pre-migrate-b'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the admin profile on /api/me', async () => {
    s = await createTestServer()
    const r = await s.req(s.admin, { method: 'GET', url: '/api/me' })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({ name: '관리자', role: 'admin', deptName: '행정팀' })
  })

  it('rejects missing or wrong credentials', async () => {
    s = await createTestServer()
    expect((await s.req(null, { method: 'GET', url: '/api/me' })).statusCode).toBe(401)
    const bad = { ...s.admin, deviceKey: 'wrong' }
    expect((await s.req(bad, { method: 'GET', url: '/api/me' })).statusCode).toBe(401)
    const otherUser = { ...s.admin, winUser: 'someone-else' }
    expect((await s.req(otherUser, { method: 'GET', url: '/api/me' })).statusCode).toBe(401)
  })

  it('requires an update for old protocol clients', async () => {
    s = await createTestServer()
    const r = await s.req(s.admin, { method: 'GET', url: '/api/me', headers: { 'x-protocol': '0' } })
    expect(r.statusCode).toBe(426)
    expect(r.json().error.code).toBe('UPDATE_REQUIRED')
  })

  it('returns JSON 404 for unknown routes', async () => {
    s = await createTestServer()
    const r = await s.req(null, { method: 'GET', url: '/api/nope' })
    expect(r.statusCode).toBe(404)
    expect(r.json().error.code).toBe('NOT_FOUND')
  })
})
