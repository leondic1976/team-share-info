import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestServer, type TestServer } from './helpers'
import { backupAlert, backupHealth, installBackup, listBackups, readState, runBackup, runBackupJob, sameVolume, volumeOf } from '../../src/server/backup'
import { openServerDb } from '../../src/server/db'
import { patchSection } from '../../src/server/settings'
import type { Db } from '../../src/node/sqlite'

const DAY = 24 * 3600_000
const setState = (db: Db, st: object): void => {
  db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('backupState', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(st), Date.now()])
}

let s: TestServer | null = null
const dirs: string[] = []
afterEach(async () => {
  await s?.close()
  s = null
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'teamhub-bk-'))
  dirs.push(d)
  return d
}

describe('backup and restore (M8-1)', () => {
  it('backs up DB and files incrementally, keeps N, restores into a new data folder', async () => {
    s = await createTestServer({ backup: { dir: '', time: '12:30', keep: 2 } } as never)
    const root = tmp()
    await s.req(s.admin, { method: 'POST', url: '/api/notices', payload: { title: '백업 확인 공지', bodyHtml: '<p>x</p>', level: 'normal', scope: { type: 'team', groupIds: [], memberIds: [] } } })
    const up = await s.req(s.admin, { method: 'POST', url: '/api/attachments?name=a.txt', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('FILE-A') })
    expect(up.statusCode).toBe(200)
    const b1 = runBackup(s.ctx, root)
    expect(b1.fileCount).toBe(1)
    expect(existsSync(join(root, 'blobs'))).toBe(true)
    runBackup(s.ctx, root)
    await new Promise((r) => setTimeout(r, 1100))
    runBackup(s.ctx, root)
    expect(listBackups(root)).toHaveLength(2) // keep = 2

    // restore into another data folder (moving the server to another PC)
    const newData = tmp()
    installBackup(listBackups(root)[0].path, newData)
    const db = openServerDb(newData, 'test')
    try {
      expect(db.get<{ title: string }>(`SELECT title FROM notices WHERE title = '백업 확인 공지'`)?.title).toBe('백업 확인 공지')
      const blob = db.get<{ path: string }>('SELECT path FROM blobs')
      expect(existsSync(join(newData, 'files', blob!.path))).toBe(true)
    } finally {
      db.close()
    }
  })

  it('daily job runs once after the configured time; admin API lists backups', async () => {
    s = await createTestServer()
    const t = new Date()
    const before = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 12, 0)
    const after = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 13, 0)
    expect(runBackupJob(s.ctx, before)).toBeNull()
    expect(runBackupJob(s.ctx, after)).not.toBeNull()
    expect(runBackupJob(s.ctx, new Date(after.getTime() + 60_000))).toBeNull()
    const r = (await s.req(s.admin, { method: 'GET', url: '/api/admin/backups' })).json().data
    expect(r.backups).toHaveLength(1)
    expect(r.state.lastError).toBeNull()
    const b = await s.join('B')
    expect((await s.req(b, { method: 'GET', url: '/api/admin/backups', ip: '192.168.10.20' })).statusCode).toBe(403)
  })
})

describe('backup health (same drive, stale, failed)', () => {
  it('tells drives and network shares apart', () => {
    expect(volumeOf('C:\\TeamHub\\data')).toBe('c:')
    expect(volumeOf('d:/backup')).toBe('d:')
    expect(volumeOf('\\\\NAS\\Share\\TeamHub')).toBe('\\\\nas\\share')
    expect(volumeOf('\\\\?\\E:\\long\\path')).toBe('e:')
    expect(volumeOf('\\\\?\\UNC\\nas\\share\\x')).toBe('\\\\nas\\share')
    expect(sameVolume('C:\\backup', 'c:\\Users\\a\\AppData\\TeamHub')).toBe(true)
    expect(sameVolume('E:\\TeamHub 백업', 'C:\\TeamHub')).toBe(false)
    expect(sameVolume('\\\\nas\\share\\a', '\\\\NAS\\Share\\b')).toBe(true)
    expect(sameVolume('\\\\nas\\other', '\\\\nas\\share')).toBe(false)
    expect(sameVolume('\\\\nas\\share\\TeamHub', 'C:\\TeamHub')).toBe(false)
  })

  it('the default folder and a folder on the data drive count as the same drive; another drive does not', async () => {
    s = await createTestServer()
    const h = backupHealth(s.ctx.db, s.ctx.dataDir)
    expect(h).toMatchObject({ isDefault: true, sameDrive: true, failed: false, stale: false, lastAt: null })
    const drive = volumeOf(s.ctx.dataDir).toUpperCase()
    patchSection(s.ctx.db, 'backup', { dir: `${drive}\\Somewhere\\TeamHub 백업` })
    expect(backupHealth(s.ctx.db, s.ctx.dataDir)).toMatchObject({ isDefault: false, sameDrive: true })
    const other = drive === 'Q:' ? 'R:' : 'Q:'
    patchSection(s.ctx.db, 'backup', { dir: `${other}\\TeamHub 백업` })
    expect(backupHealth(s.ctx.db, s.ctx.dataDir)).toMatchObject({ isDefault: false, sameDrive: false })
    patchSection(s.ctx.db, 'backup', { dir: '\\\\nas\\share\\TeamHub' })
    expect(backupHealth(s.ctx.db, s.ctx.dataDir).sameDrive).toBe(false)
    // the admin backup tab and the status tab carry it, for the server PC only
    const list = (await s.req(s.admin, { method: 'GET', url: '/api/admin/backups' })).json().data
    expect(list.health).toMatchObject({ sameDrive: false, root: '\\\\nas\\share\\TeamHub' })
    const st = (await s.req(s.admin, { method: 'GET', url: '/api/admin/status' })).json().data
    expect(st.backup).toMatchObject({ sameDrive: false })
  })

  it('a failed run is reported (with when) until the next successful one; the server PC gets the reminder, a 서무 does not', async () => {
    s = await createTestServer()
    const blocker = join(tmp(), 'a-file')
    writeFileSync(blocker, 'x')
    expect(() => runBackup(s!.ctx, join(blocker, 'sub'))).toThrow()
    const h = backupHealth(s.ctx.db, s.ctx.dataDir)
    expect(h.failed).toBe(true)
    expect(h.lastError).toBeTruthy()
    expect(h.lastErrorAt).toBeGreaterThan(Date.now() - 60_000)
    // today's slot already taken, so nothing is about to retry it
    setState(s.ctx.db, { ...readState(s.ctx.db), lastAutoDue: Date.now() + DAY })
    expect(backupAlert(backupHealth(s.ctx.db, s.ctx.dataDir))).toMatchObject({ kind: 'failed', lastAt: null })
    const me = (await s.req(s.admin, { method: 'GET', url: '/api/me' })).json().data
    expect(me.backupAlert).toMatchObject({ kind: 'failed' })

    // a 서무 (admin on another PC): no reminder, no backup state in the status tab
    const sec = await s.join('서무')
    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/members/${sec.memberId}`, payload: { role: 'admin' } })
    expect((await s.req(sec, { method: 'GET', url: '/api/me', ip: '192.168.10.20' })).json().data.backupAlert).toBeNull()
    const st = await s.req(sec, { method: 'GET', url: '/api/admin/status', ip: '192.168.10.20' })
    expect(st.statusCode).toBe(200)
    expect(st.json().data.backup).toBeUndefined()

    runBackup(s.ctx, tmp())
    expect(backupHealth(s.ctx.db, s.ctx.dataDir)).toMatchObject({ failed: false, lastError: null, lastErrorAt: null, stale: false })
    expect((await s.req(s.admin, { method: 'GET', url: '/api/me' })).json().data.backupAlert).toBeNull()
  })

  it("older than 2 days is stale; the job catches up at once (taking today's slot) and the reminder waits for it", async () => {
    s = await createTestServer({ backup: { dir: '', time: '23:59', keep: 3 } } as never)
    const t = new Date()
    const morning = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 9, 0)
    // a new team without any backup yet is not stale; one that began 3 days ago is
    expect(backupHealth(s.ctx.db, s.ctx.dataDir).stale).toBe(false)
    expect(backupHealth(s.ctx.db, s.ctx.dataDir, Date.now() + 3 * DAY).stale).toBe(true)

    // last success on Friday, server PC off over the weekend, on again on Monday morning
    setState(s.ctx.db, { lastAt: morning.getTime() - 2 * DAY - 3600_000, lastPath: null, lastError: null, lastAutoDue: morning.getTime() - 3 * DAY })
    const h = backupHealth(s.ctx.db, s.ctx.dataDir, morning.getTime())
    expect(h).toMatchObject({ stale: true, failed: false, pending: true })
    expect(backupAlert(h)).toBeNull() // the catch-up runs within a minute
    expect(runBackupJob(s.ctx, morning)).not.toBeNull()
    expect(runBackupJob(s.ctx, new Date(morning.getTime() + 60_000))).toBeNull()
    expect(runBackupJob(s.ctx, new Date(t.getFullYear(), t.getMonth(), t.getDate(), 23, 59, 30))).toBeNull() // today's slot was taken
    expect(backupHealth(s.ctx.db, s.ctx.dataDir).stale).toBe(false)

    // stale with today's slot already used: the reminder says so
    setState(s.ctx.db, { ...readState(s.ctx.db), lastAt: Date.now() - 3 * DAY })
    const h2 = backupHealth(s.ctx.db, s.ctx.dataDir)
    expect(h2).toMatchObject({ stale: true, pending: false })
    expect(backupAlert(h2)).toMatchObject({ kind: 'stale' })
  })
})
