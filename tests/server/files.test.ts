import { describe, it, expect, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { createTestServer, type Cred, type TestServer } from './helpers'
import { runFileJobs } from '../../src/server/routes/files'
import { SERVER_MIGRATIONS } from '../../src/server/db/migrations'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})

const IP = '192.168.10.20'

async function upload(t: TestServer, who: Cred, folderId: string, name: string, data: Buffer, opts: { chunk?: number; fileId?: string; ip?: string } = {}) {
  const ip = opts.ip ?? (who === t.admin ? '127.0.0.1' : IP)
  const c = await t.req(who, { method: 'POST', url: '/api/uploads', ip, payload: { name, size: data.length, folderId, fileId: opts.fileId } })
  if (c.statusCode !== 200) return c
  const id = c.json().data.id
  const chunk = opts.chunk ?? data.length
  for (let off = 0; off < data.length; off += chunk) {
    const r = await t.req(who, { method: 'PUT', url: `/api/uploads/${id}?offset=${off}`, ip, headers: { 'content-type': 'application/octet-stream' }, payload: data.subarray(off, off + chunk) })
    expect(r.statusCode).toBe(200)
  }
  if (data.length === 0) {
    // nothing to send
  }
  return t.req(who, { method: 'POST', url: `/api/uploads/${id}/complete`, ip })
}

async function rootFolder(t: TestServer, who: Cred, name: string, scope: Record<string, unknown> = { type: 'team', groupIds: [], memberIds: [] }, ip = '127.0.0.1') {
  const r = await t.req(who, { method: 'POST', url: '/api/folders', ip, payload: { name, scope } })
  expect(r.statusCode).toBe(200)
  return r.json().data.id as string
}

describe('files (M4)', () => {
  it('resumable upload in chunks, offset check, sha256 and download', async () => {
    s = await createTestServer()
    const root = await rootFolder(s, s.admin, '공용')
    const data = randomBytes(300_000)
    const c = await s.req(s.admin, { method: 'POST', url: '/api/uploads', payload: { name: '보고서.hwp', size: data.length, folderId: root } })
    const id = c.json().data.id
    await s.req(s.admin, { method: 'PUT', url: `/api/uploads/${id}?offset=0`, headers: { 'content-type': 'application/octet-stream' }, payload: data.subarray(0, 100_000) })
    // wrong offset is rejected with the server's position
    const bad = await s.req(s.admin, { method: 'PUT', url: `/api/uploads/${id}?offset=0`, headers: { 'content-type': 'application/octet-stream' }, payload: data.subarray(0, 10) })
    expect(bad.statusCode).toBe(409)
    // "client restarted": ask the server where to continue
    expect((await s.req(s.admin, { method: 'GET', url: `/api/uploads/${id}` })).json().data.received).toBe(100_000)
    expect((await s.req(s.admin, { method: 'POST', url: `/api/uploads/${id}/complete` })).statusCode).toBe(400)
    await s.req(s.admin, { method: 'PUT', url: `/api/uploads/${id}?offset=100000`, headers: { 'content-type': 'application/octet-stream' }, payload: data.subarray(100_000) })
    const done = (await s.req(s.admin, { method: 'POST', url: `/api/uploads/${id}/complete` })).json().data
    expect(done.sha256).toBe(createHash('sha256').update(data).digest('hex'))
    const dl = await s.req(s.admin, { method: 'GET', url: `/api/files/${done.file.id}/download` })
    expect(Buffer.compare(dl.rawPayload, data)).toBe(0)
    expect(dl.headers['content-disposition']).toContain(encodeURIComponent('보고서.hwp'))
    const part = await s.req(s.admin, { method: 'GET', url: `/api/files/${done.file.id}/download`, headers: { range: 'bytes=100-199' } })
    expect(part.statusCode).toBe(206)
    expect(Buffer.compare(part.rawPayload, data.subarray(100, 200))).toBe(0)
  })

  it('same name -> new version; restore old version; dedupes blobs', async () => {
    s = await createTestServer()
    const root = await rootFolder(s, s.admin, '공용')
    const v1 = Buffer.from('version one '.repeat(100))
    const v2 = Buffer.from('version two '.repeat(100))
    const a = (await upload(s, s.admin, root, 'a.txt', v1)).json().data
    const b = (await upload(s, s.admin, root, 'a.txt', v2)).json().data
    expect(b.newVersion).toBe(true)
    expect(b.file.id).toBe(a.file.id)
    const detail = (await s.req(s.admin, { method: 'GET', url: `/api/files/${a.file.id}` })).json().data
    expect(detail.versions.map((v: { versionNo: number }) => v.versionNo)).toEqual([2, 1])
    await s.req(s.admin, { method: 'POST', url: `/api/files/${a.file.id}/restore-version`, payload: { versionId: detail.versions[1].id } })
    const dl = await s.req(s.admin, { method: 'GET', url: `/api/files/${a.file.id}/download` })
    expect(dl.body).toBe(v1.toString())
    expect(s.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blobs')?.n).toBe(2)
  })

  it('folder scope: group-only folder is invisible to non-members everywhere', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const g = (await s.req(a, { method: 'POST', url: '/api/groups', ip: IP, payload: { name: 'TF' } })).json().data
    const root = await rootFolder(s, a, 'TF 자료', { type: 'group', groupIds: [g.id], memberIds: [] }, IP)
    const f = (await upload(s, a, root, 'secret.txt', Buffer.from('x'.repeat(50)))).json().data.file
    const bTop = (await s.req(b, { method: 'GET', url: '/api/files/view', ip: IP })).json().data
    expect(bTop.folders).toEqual([])
    expect((await s.req(b, { method: 'GET', url: `/api/files/view?folderId=${root}`, ip: IP })).statusCode).toBe(404)
    expect((await s.req(b, { method: 'GET', url: `/api/files/${f.id}/download`, ip: IP })).statusCode).toBe(404)
    expect((await s.req(b, { method: 'GET', url: '/api/files/search?q=secret', ip: IP })).json().data).toEqual([])
    expect((await s.req(b, { method: 'POST', url: '/api/uploads', ip: IP, payload: { name: 'x.txt', size: 1, folderId: root } })).statusCode).toBe(404)
    expect((await s.req(a, { method: 'GET', url: '/api/files/search?q=secret', ip: IP })).json().data).toHaveLength(1)
  })

  it('owner-only write policy and edit lock', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const ro = (await s.req(s.admin, { method: 'POST', url: '/api/folders', payload: { name: '양식', writePolicy: 'owner' } })).json().data.id
    expect((await s.req(b, { method: 'POST', url: '/api/uploads', ip: IP, payload: { name: 'x.txt', size: 1, folderId: ro } })).statusCode).toBe(403)
    const shared = await rootFolder(s, s.admin, '공용')
    const f = (await upload(s, b, shared, 'doc.txt', Buffer.from('hello'))).json().data.file
    expect((await s.req(b, { method: 'POST', url: `/api/files/${f.id}/lock`, ip: IP })).statusCode).toBe(200)
    const blocked = await s.req(c, { method: 'POST', url: '/api/uploads', ip: IP, payload: { name: 'doc.txt', size: 3, folderId: shared, fileId: f.id } })
    expect(blocked.statusCode).toBe(423)
    expect((await s.req(c, { method: 'POST', url: `/api/files/${f.id}/lock`, ip: IP })).statusCode).toBe(423)
    expect((await s.req(c, { method: 'DELETE', url: `/api/files/${f.id}/lock`, ip: IP })).statusCode).toBe(403)
    await s.req(b, { method: 'DELETE', url: `/api/files/${f.id}/lock`, ip: IP })
    expect((await upload(s, c, shared, 'doc.txt', Buffer.from('hey'))).json().data.newVersion).toBe(true)
  })

  it('trash: delete, restore, purge; deleted folder hides its files; cleanup job', async () => {
    s = await createTestServer()
    const root = await rootFolder(s, s.admin, '공용')
    const sub = (await s.req(s.admin, { method: 'POST', url: '/api/folders', payload: { name: '하위', parentId: root } })).json().data.id
    const f = (await upload(s, s.admin, sub, 'in-sub.txt', Buffer.from('abc'))).json().data.file
    await s.req(s.admin, { method: 'DELETE', url: `/api/folders/${sub}` })
    expect((await s.req(s.admin, { method: 'GET', url: `/api/files/${f.id}` })).statusCode).toBe(404)
    expect((await s.req(s.admin, { method: 'GET', url: '/api/files/search?q=in-sub' })).json().data).toEqual([])
    let trash = (await s.req(s.admin, { method: 'GET', url: '/api/trash' })).json().data
    expect(trash.map((t: { name: string }) => t.name)).toEqual(['하위'])
    await s.req(s.admin, { method: 'POST', url: `/api/trash/folder/${sub}/restore` })
    expect((await s.req(s.admin, { method: 'GET', url: `/api/files/${f.id}` })).statusCode).toBe(200)

    await s.req(s.admin, { method: 'DELETE', url: `/api/files/${f.id}` })
    trash = (await s.req(s.admin, { method: 'GET', url: '/api/trash' })).json().data
    expect(trash[0]).toMatchObject({ type: 'file', name: 'in-sub.txt', location: '공용 / 하위' })
    await s.req(s.admin, { method: 'DELETE', url: `/api/trash/file/${f.id}` })
    expect((await s.req(s.admin, { method: 'GET', url: '/api/trash' })).json().data).toEqual([])
    runFileJobs(s.ctx, Date.now() + 2 * 86400000)
    expect(s.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blobs')?.n).toBe(0)
  })

  it('enforces size limits and blocked extensions before upload', async () => {
    s = await createTestServer()
    const root = await rootFolder(s, s.admin, '공용')
    await s.req(s.admin, { method: 'PUT', url: '/api/admin/settings', payload: { storage: { maxFileBytes: 1000 } } })
    expect((await s.req(s.admin, { method: 'POST', url: '/api/uploads', payload: { name: 'big.zip', size: 5000, folderId: root } })).json().error.code).toBe('FILE_TOO_LARGE')
    expect((await s.req(s.admin, { method: 'POST', url: '/api/uploads', payload: { name: 'run.exe', size: 10, folderId: root } })).json().error.code).toBe('EXTENSION_BLOCKED')
  })

  it('defaults: 5GB per file, 200GB in all; servers on the former defaults are raised, custom limits kept', async () => {
    s = await createTestServer()
    const GB = 1024 ** 3
    const storage = async (): Promise<{ maxFileBytes: number; quotaBytes: number }> => (await s!.req(s!.admin, { method: 'GET', url: '/api/admin/settings' })).json().data.storage
    expect(await storage()).toMatchObject({ maxFileBytes: 5 * GB, quotaBytes: 200 * GB })
    const m15 = SERVER_MIGRATIONS.find((m) => m.id === 15)!
    // a server set up before: 500MB / 50GB
    await s.req(s.admin, { method: 'PUT', url: '/api/admin/settings', payload: { storage: { maxFileBytes: 500 * 1024 ** 2, quotaBytes: 50 * GB } } })
    s.ctx.db.exec(m15.sql)
    expect(await storage()).toMatchObject({ maxFileBytes: 5 * GB, quotaBytes: 200 * GB })
    // an admin's own choice is not touched
    await s.req(s.admin, { method: 'PUT', url: '/api/admin/settings', payload: { storage: { maxFileBytes: 2 * GB, quotaBytes: 80 * GB } } })
    s.ctx.db.exec(m15.sql)
    expect(await storage()).toMatchObject({ maxFileBytes: 2 * GB, quotaBytes: 80 * GB })
    const root = await rootFolder(s, s.admin, '공용')
    const tooBig = (await s.req(s.admin, { method: 'POST', url: '/api/uploads', payload: { name: 'big.zip', size: 3 * GB, folderId: root } })).json().error
    expect(tooBig).toMatchObject({ code: 'FILE_TOO_LARGE', message: '파일이 너무 큽니다(최대 2GB).' })
  })

  it('an upload completed while the client was cut off is reported as done; a repeated complete does not add a version', async () => {
    s = await createTestServer()
    const root = await rootFolder(s, s.admin, '공용')
    const data = randomBytes(200_000)
    const id = (await s.req(s.admin, { method: 'POST', url: '/api/uploads', payload: { name: 'cut.bin', size: data.length, folderId: root } })).json().data.id
    expect((await s.req(s.admin, { method: 'GET', url: `/api/uploads/${id}` })).json().data).toMatchObject({ state: 'active', received: 0 })
    await s.req(s.admin, { method: 'PUT', url: `/api/uploads/${id}?offset=0`, headers: { 'content-type': 'application/octet-stream' }, payload: data })
    // the client retries "complete" while the first one is still running
    const [a, b] = await Promise.all([
      s.req(s.admin, { method: 'POST', url: `/api/uploads/${id}/complete` }),
      s.req(s.admin, { method: 'POST', url: `/api/uploads/${id}/complete` })
    ])
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)
    const fileId = a.json().data.file.id
    expect(b.json().data.file.id).toBe(fileId)
    expect(a.json().data.file.versionCount).toBe(1)
    // the answer got lost: the client asks where the upload is
    expect((await s.req(s.admin, { method: 'GET', url: `/api/uploads/${id}` })).json().data).toMatchObject({ state: 'done', received: data.length, fileId })
    // nobody else may ask
    const other = await s.join('B')
    expect((await s.req(other, { method: 'GET', url: `/api/uploads/${id}`, ip: IP })).statusCode).toBe(404)
  })

  it('resumed download: If-Range continues the same content and restarts when a new version replaced it', async () => {
    s = await createTestServer()
    const root = await rootFolder(s, s.admin, '공용')
    const v1 = randomBytes(50_000)
    const v2 = randomBytes(60_000)
    const f = (await upload(s, s.admin, root, 'big.bin', v1)).json().data.file
    const first = await s.req(s.admin, { method: 'GET', url: `/api/files/${f.id}/download` })
    const etag = first.headers.etag as string
    expect(etag).toBe(`"${createHash('sha256').update(v1).digest('hex')}"`)
    const rest = await s.req(s.admin, { method: 'GET', url: `/api/files/${f.id}/download`, headers: { range: 'bytes=20000-', 'if-range': etag } })
    expect(rest.statusCode).toBe(206)
    expect(rest.headers['content-range']).toBe(`bytes 20000-49999/50000`)
    expect(Buffer.compare(rest.rawPayload, v1.subarray(20000))).toBe(0)
    // a new version arrives before the client continues: it must get the whole new file, not its tail
    await upload(s, s.admin, root, 'big.bin', v2)
    const changed = await s.req(s.admin, { method: 'GET', url: `/api/files/${f.id}/download`, headers: { range: 'bytes=20000-', 'if-range': etag } })
    expect(changed.statusCode).toBe(200)
    expect(Buffer.compare(changed.rawPayload, v2)).toBe(0)
    // a partial file that is already as long as the content
    const past = await s.req(s.admin, { method: 'GET', url: `/api/files/${f.id}/download`, headers: { range: 'bytes=60000-', 'if-range': changed.headers.etag as string } })
    expect(past.statusCode).toBe(416)
  })

  it('records download history visible to the uploader', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const root = await rootFolder(s, s.admin, '공용')
    const f = (await upload(s, s.admin, root, 'r.txt', Buffer.from('data'))).json().data.file
    await s.req(b, { method: 'GET', url: `/api/files/${f.id}/download`, ip: IP })
    const h = (await s.req(s.admin, { method: 'GET', url: `/api/files/${f.id}/downloads` })).json().data
    expect(h[0]).toMatchObject({ name: 'B', version_no: 1 })
    expect((await s.req(b, { method: 'GET', url: `/api/files/${f.id}/downloads`, ip: IP })).statusCode).toBe(403)
  })
})
