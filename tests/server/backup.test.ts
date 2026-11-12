import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestServer, type TestServer } from './helpers'
import { installBackup, listBackups, runBackup, runBackupJob } from '../../src/server/backup'
import { openServerDb } from '../../src/server/db'

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
