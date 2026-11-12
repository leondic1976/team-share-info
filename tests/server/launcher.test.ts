import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type TestServer } from './helpers'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'

describe('team launcher and security programs (M7-2, M7-4)', () => {
  it('admins manage items; members read; executables and bad URLs are refused', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const add = (payload: Record<string, unknown>, cred = s!.admin) => s!.req(cred, { method: 'POST', url: '/api/admin/launcher', payload })
    expect((await add({ kind: 'url', name: '전자결재', target: 'https://intra.example/approval', groupName: '업무 사이트' })).statusCode).toBe(200)
    expect((await add({ kind: 'path', name: '공용 폴더', target: String.raw`\\FS01\공용` })).statusCode).toBe(200)
    expect((await add({ kind: 'path', name: '설치', target: String.raw`\\FS01\공용\setup.exe` })).statusCode).toBe(400)
    expect((await add({ kind: 'url', name: 'x', target: 'javascript:alert(1)' })).statusCode).toBe(400)
    expect((await add({ kind: 'template', name: '빈 양식' })).statusCode).toBe(400)
    expect((await s.req(b, { method: 'POST', url: '/api/admin/launcher', ip: IP, payload: { kind: 'url', name: 'y', target: 'https://a.b' } })).statusCode).toBe(403)

    // template: upload, then register; members can download it
    const up = await s.req(s.admin, { method: 'POST', url: '/api/attachments?name=' + encodeURIComponent('출장 신청서.hwp'), headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('HWP-DATA') })
    const attId = up.json().data.id
    const t = await add({ kind: 'template', name: '출장 신청서', attachmentId: attId, groupName: '양식' })
    expect(t.json().data).toMatchObject({ kind: 'template', fileName: '출장 신청서.hwp', attachmentId: attId })
    const list = (await s.req(b, { method: 'GET', url: '/api/launcher', ip: IP })).json().data
    expect(list.map((i: { name: string }) => i.name).sort()).toEqual(['공용 폴더', '전자결재', '출장 신청서'])
    const dl = await s.req(b, { method: 'GET', url: `/api/attachments/${attId}`, ip: IP })
    expect(dl.statusCode).toBe(200)
    expect(dl.body).toBe('HWP-DATA')

    const id = t.json().data.id
    expect((await s.req(s.admin, { method: 'DELETE', url: `/api/admin/launcher/${id}` })).statusCode).toBe(200)
    expect((await s.req(b, { method: 'GET', url: `/api/attachments/${attId}`, ip: IP })).statusCode).toBe(404)
  })

  it('security program list: names validated, readable by members', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    expect((await s.req(s.admin, { method: 'POST', url: '/api/admin/security-programs', payload: { name: '문서보안', processNames: ['agent.exe; rm -rf'] } })).statusCode).toBe(400)
    expect((await s.req(s.admin, { method: 'POST', url: '/api/admin/security-programs', payload: { name: '빈 항목' } })).statusCode).toBe(400)
    expect((await s.req(s.admin, { method: 'POST', url: '/api/admin/security-programs', payload: { name: '문서보안', processNames: ['DSAgent.exe'], serviceNames: ['DSService'] } })).statusCode).toBe(200)
    const list = (await s.req(b, { method: 'GET', url: '/api/security-programs', ip: IP })).json().data
    expect(list).toEqual([expect.objectContaining({ name: '문서보안', processNames: ['DSAgent.exe'], serviceNames: ['DSService'] })])
  })
})
