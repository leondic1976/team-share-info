import { describe, it, expect, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestServer, type TestServer } from './helpers'
import { checkBackupDir } from '../../src/server/backupDir'
import { installBackup, listBackups, runBackup } from '../../src/server/backup'

/** Changing the server backup folder and restoring right after (instruction 132). */
let s: TestServer | null = null
const dirs: string[] = []
afterEach(async () => {
  await s?.close()
  s = null
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'teamhub-bkdir-'))
  dirs.push(d)
  return d
}

describe('backup folder check', () => {
  it('refuses what every later backup would fail in, and says why', async () => {
    const data = tmp()
    const t = tmp()
    expect(await checkBackupDir('', data)).toBeNull()
    expect(await checkBackupDir('백업', data)).toMatch(/전체 경로/)
    const missing = ['Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y'].find((l) => !existsSync(`${l}:\\`))
    if (missing) expect(await checkBackupDir(`${missing}:\\TeamHub 백업`, data)).toMatch(/드라이브를 찾을 수 없습니다/)
    writeFileSync(join(t, 'a.txt'), 'x')
    expect(await checkBackupDir(join(t, 'a.txt'), data)).toMatch(/파일/)
    expect(await checkBackupDir(join(data, 'files', 'x'), data)).toMatch(/files 폴더/)
    expect(await checkBackupDir('C:\\Windows\\TeamHub', data)).toMatch(/시스템 폴더/)
    expect(await checkBackupDir('D:\\', data, { isProtected: () => true })).toMatch(/드라이브 맨 위/)
    // a folder with spaces and Korean is made and accepted
    const ok = join(t, '팀 백업 폴더', '새 위치')
    expect(await checkBackupDir(ok, data)).toBeNull()
    expect(existsSync(ok)).toBe(true)
    expect(readdirSync(ok)).toEqual([]) // the write test leaves nothing
  })

  it('a network folder that is not there is refused within the time limit', async () => {
    const t0 = Date.now()
    const r = await checkBackupDir('\\\\teamhub-no-such-host-e2e\\share\\backup', tmp(), { timeoutMs: 3000 })
    expect(r).toMatch(/네트워크 폴더/)
    expect(Date.now() - t0).toBeLessThan(8000)
  }, 15000)

  it('the settings API refuses a bad folder and keeps the old one', async () => {
    s = await createTestServer()
    const bad = await s.req(s.admin, { method: 'PUT', url: '/api/admin/settings', payload: { backup: { dir: '상대경로' } } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.message).toMatch(/백업 위치/)
    const good = join(tmp(), '백업 위치 바꿈')
    const r = await s.req(s.admin, { method: 'PUT', url: '/api/admin/settings', payload: { backup: { dir: good } } })
    expect(r.statusCode).toBe(200)
    // back up into the new folder, then restore from it right away
    const b = await s.req(s.admin, { method: 'POST', url: '/api/admin/backups' })
    expect(b.statusCode).toBe(200)
    expect(listBackups(good)).toHaveLength(1)
  })
})

describe('restore leaves the data as it was when the backup cannot be used', () => {
  function dataDir(rows: number): string {
    const d = tmp()
    const db = new DatabaseSync(join(d, 'teamhub.db'))
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE blobs (path TEXT, size INTEGER); CREATE TABLE t (v TEXT)')
    for (let i = 0; i < rows; i++) db.prepare('INSERT INTO t VALUES (?)').run(`행 ${i}`)
    db.close()
    return d
  }
  it('a damaged backup DB changes nothing', () => {
    const data = dataDir(5)
    const bk = join(tmp(), 'TeamHub-20261126-120000')
    mkdirSync(bk, { recursive: true })
    writeFileSync(join(bk, 'manifest.json'), '{}')
    writeFileSync(join(bk, 'teamhub.db'), 'this is not a database'.repeat(100))
    expect(() => installBackup(bk, data)).toThrow(/백업의 자료를 읽을 수 없습니다/)
    const db = new DatabaseSync(join(data, 'teamhub.db'), { readOnly: true })
    expect((db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(5)
    db.close()
    expect(existsSync(join(data, 'teamhub.db.restoring'))).toBe(false)
  })

  it('a missing backup folder (removed USB drive) changes nothing', () => {
    const data = dataDir(3)
    expect(() => installBackup(join(tmp(), 'gone', 'TeamHub-1'), data)).toThrow(/백업 폴더가 아닙니다/)
    expect(existsSync(join(data, 'teamhub.db'))).toBe(true)
  })

  it('the data kept aside before a restore is complete (its WAL folded in)', async () => {
    s = await createTestServer()
    const root = tmp()
    const b = runBackup(s.ctx, root)
    // the server was cut off: its newest rows are only in the WAL file next to the DB
    const live = tmp()
    const conn = new DatabaseSync(join(live, 'teamhub.db'))
    conn.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (v TEXT)')
    for (let i = 0; i < 40; i++) conn.prepare('INSERT INTO t VALUES (?)').run(`최근 ${i}`)
    const data = tmp()
    copyFileSync(join(live, 'teamhub.db'), join(data, 'teamhub.db'))
    copyFileSync(join(live, 'teamhub.db-wal'), join(data, 'teamhub.db-wal'))
    conn.close()
    installBackup(b.path, data)
    const kept = readdirSync(join(data, 'backups')).find((n) => n.startsWith('before-restore-'))!
    const db = new DatabaseSync(join(data, 'backups', kept), { readOnly: true })
    expect((db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(40)
    db.close()
  })
})
