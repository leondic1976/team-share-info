import { describe, it, expect, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createTestServer, type Cred, type TestServer } from './helpers'
import { messageFileUsage, runMessageFileRetention } from '../../src/server/message-files'
import { runChatJobs } from '../../src/server/routes/chat'
import { runFileJobs } from '../../src/server/routes/files'
import { Db } from '../../src/node/sqlite'
import { SERVER_MIGRATIONS } from '../../src/server/db/migrations'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'
const DAY = 86_400_000

async function upload(srv: TestServer, who: Cred, name: string, content: string): Promise<{ id: string }> {
  const r = await srv.req(who, {
    method: 'POST',
    url: `/api/attachments?name=${encodeURIComponent(name)}`,
    ip: IP,
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from(content)
  })
  expect(r.statusCode).toBe(200)
  return r.json().data
}

/** A 1:1 between A and B with one file message from A. */
async function sendFile(
  srv: TestServer,
  a: Cred,
  b: Cred,
  name: string,
  content: string
): Promise<{ conv: string; att: string; msg: string }> {
  const conv = (
    await srv.req(a, {
      method: 'POST',
      url: '/api/conversations',
      ip: IP,
      payload: { memberIds: [b.memberId] }
    })
  ).json().data.id as string
  const att = await upload(srv, a, name, content)
  await srv.req(a, {
    method: 'POST',
    url: `/api/conversations/${conv}/messages`,
    ip: IP,
    payload: { body: '', attachmentIds: [att.id] }
  })
  const msg = srv.ctx.db.get<{ owner_id: string }>('SELECT owner_id FROM attachments WHERE id = ?', [
    att.id
  ])!.owner_id
  return { conv, att: att.id, msg }
}

/** Make a message and its file look `days` old. */
function age(srv: TestServer, attId: string, days: number): void {
  const t = Date.now() - days * DAY
  srv.ctx.db.run('UPDATE attachments SET created_at = ? WHERE id = ?', [t, attId])
  srv.ctx.db.run(
    `UPDATE messages SET created_at = ? WHERE id = (SELECT owner_id FROM attachments WHERE id = ?)`,
    [t, attId]
  )
}

const blobPath = (srv: TestServer, attId: string): string | null => {
  const b = srv.ctx.db.get<{ path: string }>(
    'SELECT b.path FROM attachments a JOIN blobs b ON b.id = a.blob_id WHERE a.id = ?',
    [attId]
  )
  return b ? join(srv.dataDir, 'files', b.path) : null
}

describe('message file retention (지시 109)', () => {
  it('deletes files older than the period from disk, keeps the message, keeps younger files', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const old = await sendFile(s, a, b, '오래된보고서.hwp', 'old content')
    const young = await sendFile(s, a, b, '새보고서.hwp', 'young content')
    const oldPath = blobPath(s, old.att)!
    const youngPath = blobPath(s, young.att)!
    expect(existsSync(oldPath)).toBe(true)
    age(s, old.att, 91)
    age(s, young.att, 89)

    const r = runMessageFileRetention(s.ctx)
    expect(r).toMatchObject({ files: 1, bytes: 'old content'.length, more: false })
    expect(existsSync(oldPath)).toBe(false)
    expect(existsSync(youngPath)).toBe(true)
    const row = s.ctx.db.get<{ blob_id: string | null; expired_at: number | null }>(
      'SELECT blob_id, expired_at FROM attachments WHERE id = ?',
      [old.att]
    )!
    expect(row.blob_id).toBeNull()
    expect(row.expired_at).toBeGreaterThan(0)

    // the message stays and shows the file as expired; the younger one is untouched
    const msgs = (
      await s.req(b, { method: 'GET', url: `/api/conversations/${old.conv}/messages`, ip: IP })
    ).json().data as {
      id: string
      kind: string
      body: string
      attachments: unknown[]
      fileExpired: { name: string; size: number } | null
    }[]
    const gone = msgs.find((m) => m.id === old.msg)!
    expect(gone).toMatchObject({
      kind: 'file',
      body: '오래된보고서.hwp',
      attachments: [],
      fileExpired: { name: '오래된보고서.hwp', size: 'old content'.length }
    })
    const kept = msgs.find((m) => m.id === young.msg)!
    expect(kept.fileExpired).toBeNull()
    expect(kept.attachments).toHaveLength(1)

    // downloading the expired file answers clearly
    const dl = await s.req(b, { method: 'GET', url: `/api/attachments/${old.att}`, ip: IP })
    expect(dl.statusCode).toBe(410)
    expect(dl.json().error).toEqual({
      code: 'FILE_EXPIRED',
      message: '보관 기간이 지나 서버에서 삭제된 파일입니다.'
    })
    // someone outside the conversation still learns nothing
    const c = await s.join('C')
    expect((await s.req(c, { method: 'GET', url: `/api/attachments/${old.att}`, ip: IP })).statusCode).toBe(
      404
    )
    expect((await s.req(b, { method: 'GET', url: `/api/attachments/${young.att}`, ip: IP })).statusCode).toBe(
      200
    )

    // a second run has nothing to do; the admin status shows what is left and the last cleanup
    expect(runMessageFileRetention(s.ctx).files).toBe(0)
    const st = (await s.req(s.admin, { method: 'GET', url: '/api/admin/status' })).json().data
    expect(st.messageFiles).toMatchObject({
      files: 1,
      bytes: 'young content'.length,
      cleanup: { last: { files: 1, bytes: 'old content'.length, days: 90 } }
    })

    // later jobs cope with the expired row: whole-message retention and the unreferenced sweep
    runFileJobs(s.ctx, Date.now() + 2 * DAY)
    expect(runChatJobs(s.ctx, Date.now() + 400 * DAY)).toBeGreaterThan(0)
    expect(s.ctx.db.get('SELECT 1 FROM attachments WHERE id = ?', [old.att])).toBeUndefined()
  })

  it('leaves a stored file on disk while something else uses the same content', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const old = await sendFile(s, a, b, '같은내용.txt', 'same bytes')
    const path = blobPath(s, old.att)!
    // the same content sent again later (stored once, 13.5)
    const again = await sendFile(s, a, b, '같은내용-다시.txt', 'same bytes')
    age(s, old.att, 120)
    const r = runMessageFileRetention(s.ctx)
    expect(r).toMatchObject({ files: 1, bytes: 0 })
    expect(existsSync(path)).toBe(true)
    expect((await s.req(b, { method: 'GET', url: `/api/attachments/${again.att}`, ip: IP })).statusCode).toBe(
      200
    )
    expect(messageFileUsage(s.ctx)).toEqual({ files: 1, bytes: 'same bytes'.length })
  })

  it('does not touch notice attachments or 자료실 files', async () => {
    s = await createTestServer()
    const att = await upload(s, s.admin, '공지첨부.pdf', 'notice file')
    s.ctx.db.run(
      `UPDATE attachments SET owner_type = 'notice', owner_id = 'n1', created_at = ? WHERE id = ?`,
      [Date.now() - 400 * DAY, att.id]
    )
    expect(runMessageFileRetention(s.ctx).files).toBe(0)
    expect(
      s.ctx.db.get<{ blob_id: string | null }>('SELECT blob_id FROM attachments WHERE id = ?', [att.id])!
        .blob_id
    ).not.toBeNull()
  })

  it('follows the setting: longer periods and 무기한, never below 90 days', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const f = await sendFile(s, a, b, '사진.png', 'png bytes')
    age(s, f.att, 200)

    const put = (
      storage: Record<string, unknown>
    ): Promise<{
      statusCode: number
      json: () => {
        data: { storage: { messageFileRetentionDays: number | null } }
        error?: { message: string }
      }
    }> => s!.req(s!.admin, { method: 'PUT', url: '/api/admin/settings', payload: { storage } })
    const cur = (await s.req(s.admin, { method: 'GET', url: '/api/admin/settings' })).json().data.storage
    expect(cur.messageFileRetentionDays).toBe(90)
    const low = await put({ ...cur, messageFileRetentionDays: 89 })
    expect(low.statusCode).toBe(400)
    expect(low.json().error?.message).toContain('90일')
    expect((await put({ ...cur, messageFileRetentionDays: 30 })).statusCode).toBe(400)

    expect(
      (await put({ ...cur, messageFileRetentionDays: 365 })).json().data.storage.messageFileRetentionDays
    ).toBe(365)
    expect(runMessageFileRetention(s.ctx).files).toBe(0)
    expect(
      (await put({ ...cur, messageFileRetentionDays: null })).json().data.storage.messageFileRetentionDays
    ).toBeNull()
    expect(runMessageFileRetention(s.ctx, Date.now() + 5000 * DAY).files).toBe(0)
    expect((await put({ ...cur, messageFileRetentionDays: 180 })).statusCode).toBe(200)
    expect(runMessageFileRetention(s.ctx).files).toBe(1)
  })

  it('migration 25 keeps existing attachments', () => {
    const db = new Db(':memory:')
    try {
      db.migrate(SERVER_MIGRATIONS.filter((m) => m.id < 25))
      const t = Date.now()
      db.run(
        `INSERT INTO blobs (id, sha256, size, path, ref_count, created_at, updated_at) VALUES ('b1', 'abc', 3, 'ab/c/abc', 1, ?, ?)`,
        [t, t]
      )
      db.run(
        `INSERT INTO attachments (id, owner_type, owner_id, blob_id, name, size, created_by, created_at, updated_at) VALUES ('a1', 'notice', 'n1', 'b1', 'x.pdf', 3, NULL, ?, ?)`,
        [t, t]
      )
      expect(db.migrate(SERVER_MIGRATIONS.filter((m) => m.id <= 25))).toEqual([25])
      expect(db.get('SELECT id, blob_id, name, expired_at FROM attachments')).toEqual({
        id: 'a1',
        blob_id: 'b1',
        name: 'x.pdf',
        expired_at: null
      })
      expect(
        db
          .all<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'attachments' AND sql IS NOT NULL ORDER BY name`
          )
          .map((r) => r.name)
      ).toEqual(['idx_attach_message_live', 'idx_attach_owner'])
    } finally {
      db.close()
    }
  })
})
