import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type Cred, type TestServer } from './helpers'
import { ensureServerOwner, serverDeviceId } from '../../src/server/repos/devices'
import { isClerk } from '../../src/shared/schemas/auth'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})

const IP = '192.168.10.20'

/** A member the 최종관리자 (server PC) named 서무. */
async function clerk(t: TestServer, name: string): Promise<Cred> {
  const c = await t.join(name)
  const r = await t.req(t.admin, { method: 'PATCH', url: `/api/admin/members/${c.memberId}`, payload: { role: 'admin' } })
  expect(r.statusCode).toBe(200)
  return c
}

const ownerOnly = (r: { statusCode: number; json: () => { error?: { code: string } } }): void => {
  expect(r.statusCode).toBe(403)
  expect(r.json().error?.code).toBe('OWNER_ONLY')
}

const EXE = { 'content-type': 'application/octet-stream' }

describe('two admin tiers: 최종관리자 (server PC) and 서무', () => {
  it('tells who is who on /api/me and in the member lists', async () => {
    s = await createTestServer()
    const c = await clerk(s, '김서무')
    const m = await s.join('이주무')
    expect((await s.req(s.admin, { method: 'GET', url: '/api/me' })).json().data).toMatchObject({ role: 'admin', isOwner: true })
    expect((await s.req(c, { method: 'GET', url: '/api/me', ip: IP })).json().data).toMatchObject({ role: 'admin', isOwner: false })
    expect((await s.req(m, { method: 'GET', url: '/api/me', ip: IP })).json().data).toMatchObject({ role: 'member', isOwner: false })
    for (const url of ['/api/members', '/api/admin/members']) {
      const list = (await s.req(c, { method: 'GET', url, ip: IP })).json().data as { id: string; role: string; isOwner: boolean }[]
      expect(list.filter((x) => x.isOwner).map((x) => x.id)).toEqual([s.admin.memberId])
      expect(list.find((x) => x.id === c.memberId)).toMatchObject({ role: 'admin', isOwner: false })
      // the client marks exactly the 서무 next to their names: not the 최종관리자, not ordinary members
      expect(list.filter((x) => isClerk(x as Parameters<typeof isClerk>[0])).map((x) => x.id)).toEqual([c.memberId])
    }
  })

  it('a 서무 does the everyday administration', async () => {
    s = await createTestServer()
    const c = await clerk(s, '김서무')
    const m = await s.join('이주무')
    // approving a request
    const asked = (await s.req(null, { method: 'POST', url: '/api/join', ip: '192.168.10.31', payload: { name: '새사람', pcName: 'PC-NEW', winUser: 'new' } })).json().data
    expect((await s.req(c, { method: 'GET', url: '/api/admin/join-requests', ip: IP })).json().data).toHaveLength(1)
    expect((await s.req(c, { method: 'PATCH', url: `/api/admin/join-requests/${asked.requestId}`, ip: IP, payload: { action: 'approve' } })).statusCode).toBe(200)
    // a member's details, suspension, and PC
    expect((await s.req(c, { method: 'PATCH', url: `/api/admin/members/${m.memberId}`, ip: IP, payload: { title: '주무관' } })).statusCode).toBe(200)
    expect((await s.req(c, { method: 'PATCH', url: `/api/admin/members/${m.memberId}`, ip: IP, payload: { status: 'suspended' } })).statusCode).toBe(200)
    expect((await s.req(c, { method: 'PATCH', url: `/api/admin/members/${m.memberId}`, ip: IP, payload: { status: 'active' } })).statusCode).toBe(200)
    expect((await s.req(c, { method: 'PATCH', url: `/api/admin/devices/${m.deviceId}`, ip: IP, payload: { action: 'revoke' } })).statusCode).toBe(200)
    expect((await s.req(c, { method: 'PATCH', url: `/api/admin/devices/${m.deviceId}`, ip: IP, payload: { action: 'restore' } })).statusCode).toBe(200)
    expect((await s.req(c, { method: 'POST', url: '/api/admin/blocked-pcs', ip: IP, payload: { deviceId: m.deviceId, reason: '퇴직자 PC' } })).statusCode).toBe(200)
    // looking: settings, status, activity, devices, releases
    for (const url of ['/api/admin/settings', '/api/admin/status', '/api/admin/activity', '/api/admin/devices', '/api/admin/blocked-pcs', '/api/admin/releases']) {
      expect((await s.req(c, { method: 'GET', url, ip: IP })).statusCode, url).toBe(200)
    }
    // naming who records absences for others
    expect((await s.req(c, { method: 'PUT', url: '/api/duty/clerks', ip: IP, payload: { memberIds: [] } })).statusCode).toBe(200)
  })

  it('a 서무 saves only the settings a 서무 may decide', async () => {
    s = await createTestServer()
    const c = await clerk(s, '김서무')
    const put = (cred: Cred, payload: object) => s!.req(cred, { method: 'PUT', url: '/api/admin/settings', ip: cred === s!.admin ? undefined : IP, payload })
    const ok = await put(c, { ops: { urgentSenders: 'everyone', groupCreators: 'admins' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.ops).toMatchObject({ urgentSenders: 'everyone', groupCreators: 'admins' })

    ownerOnly(await put(c, { org: { teamName: '다른팀' } }))
    ownerOnly(await put(c, { network: { allowedCidrs: ['10.0.0.0/8'] } }))
    ownerOnly(await put(c, { network: { approvalMode: 'auto-in-cidr' } }))
    ownerOnly(await put(c, { network: { port: 50000 } }))
    ownerOnly(await put(c, { storage: { quotaBytes: 1024 } }))
    ownerOnly(await put(c, { backup: { keep: 3 } }))
    ownerOnly(await put(c, { ops: { disabledFeatures: ['chat'] } }))
    ownerOnly(await put(c, { ops: { messageRetentionDays: 30 } }))
    ownerOnly(await put(c, { adminPin: '1234' }))
    ownerOnly(await put(c, { adminPin: '' }))

    // an older client sends the whole form: unchanged owner-only sections do not stand in the way
    const all = (await s.req(c, { method: 'GET', url: '/api/admin/settings', ip: IP })).json().data
    const whole = await put(c, { ...all, ops: { ...all.ops, urgentSenders: 'admins' } })
    expect(whole.statusCode).toBe(200)
    expect(whole.json().data.ops.urgentSenders).toBe('admins')
    ownerOnly(await put(c, { ...all, org: { ...all.org, orgName: '바꾼기관' } }))
    // nothing of the refused requests was stored
    const after = (await s.req(s.admin, { method: 'GET', url: '/api/admin/settings' })).json().data
    expect(after).toMatchObject({ org: { orgName: '테스트기관', teamName: '행정팀' }, network: { allowedCidrs: [], approvalMode: 'manual' }, ops: { disabledFeatures: [], messageRetentionDays: 365 } })
    expect((await s.req(s.admin, { method: 'GET', url: '/api/me' })).json().data.adminPinSet).toBe(false)

    // the 최종관리자 can
    expect((await put(s.admin, { org: { teamName: '총무팀' }, ops: { disabledFeatures: ['chat'] }, backup: { keep: 3 }, storage: { quotaBytes: 1024 ** 3 } })).statusCode).toBe(200)

    // the fields that were not sent are not filled in with defaults: the owner's choices stay, and
    // a 서무 can still save the open fields after the owner changed others (Zod 4 .partial() defaults)
    expect((await put(s.admin, { ops: { messageRetentionDays: 180 } })).statusCode).toBe(200)
    const again = await put(c, { ops: { urgentSenders: 'everyone', groupCreators: 'everyone' } })
    expect(again.statusCode).toBe(200)
    expect(again.json().data).toMatchObject({ org: { teamName: '총무팀' }, backup: { keep: 3 }, ops: { disabledFeatures: ['chat'], messageRetentionDays: 180, urgentSenders: 'everyone', groupCreators: 'everyone' } })
  })

  it('data storage is the 최종관리자’s: backups and restore', async () => {
    s = await createTestServer()
    const c = await clerk(s, '김서무')
    ownerOnly(await s.req(c, { method: 'GET', url: '/api/admin/backups', ip: IP }))
    ownerOnly(await s.req(c, { method: 'POST', url: '/api/admin/backups', ip: IP }))
    ownerOnly(await s.req(c, { method: 'POST', url: '/api/admin/backups/restore', ip: IP, payload: { name: 'TeamHub-20260101-000000' } }))
    expect((await s.req(s.admin, { method: 'GET', url: '/api/admin/backups' })).statusCode).toBe(200)
    expect((await s.req(s.admin, { method: 'POST', url: '/api/admin/backups' })).statusCode).toBe(200)
  })

  it('distributing an update is the 최종관리자’s', async () => {
    s = await createTestServer()
    const c = await clerk(s, '김서무')
    const body = Buffer.alloc(1024 * 1024 + 10, 1)
    const url = '/api/admin/releases?version=0.9.0&fileName=TeamHub-Setup-0.9.0.exe'
    ownerOnly(await s.req(c, { method: 'POST', url, ip: IP, headers: EXE, payload: body }))
    ownerOnly(await s.req(c, { method: 'POST', url: '/api/admin/releases/import-web', ip: IP, payload: {} }))
    const up = await s.req(s.admin, { method: 'POST', url, headers: EXE, payload: body })
    expect(up.statusCode).toBe(200)
    ownerOnly(await s.req(c, { method: 'PATCH', url: `/api/admin/releases/${up.json().data.id}`, ip: IP, payload: { state: 'withdrawn' } }))
    expect((await s.req(s.admin, { method: 'PATCH', url: `/api/admin/releases/${up.json().data.id}`, payload: { state: 'withdrawn' } })).statusCode).toBe(200)
  })

  it('the organisation (departments) is the 최종관리자’s; a 서무 still puts a member in a department', async () => {
    s = await createTestServer()
    const c = await clerk(s, '김서무')
    const m = await s.join('이주무')
    ownerOnly(await s.req(c, { method: 'POST', url: '/api/admin/departments', ip: IP, payload: { name: '기획팀' } }))
    const d = (await s.req(s.admin, { method: 'POST', url: '/api/admin/departments', payload: { name: '기획팀' } })).json().data
    ownerOnly(await s.req(c, { method: 'PATCH', url: `/api/admin/departments/${d.id}`, ip: IP, payload: { name: '기획과' } }))
    ownerOnly(await s.req(c, { method: 'DELETE', url: `/api/admin/departments/${d.id}`, ip: IP }))
    expect((await s.req(c, { method: 'GET', url: '/api/departments', ip: IP })).json().data.map((x: { name: string }) => x.name)).toContain('기획팀')
    const moved = await s.req(c, { method: 'PATCH', url: `/api/admin/members/${m.memberId}`, ip: IP, payload: { deptId: d.id } })
    expect(moved.json().data).toMatchObject({ deptName: '기획팀' })
    expect((await s.req(s.admin, { method: 'PATCH', url: `/api/admin/departments/${d.id}`, payload: { name: '기획과' } })).statusCode).toBe(200)
  })

  it('only the 최종관리자 names or removes a 서무, and a 서무 does not act against another 서무', async () => {
    s = await createTestServer()
    const c = await clerk(s, '김서무')
    const c2 = await clerk(s, '박서무')
    const m = await s.join('이주무')
    const patch = (cred: Cred, id: string, payload: object) => s!.req(cred, { method: 'PATCH', url: `/api/admin/members/${id}`, ip: cred === s!.admin ? undefined : IP, payload })
    ownerOnly(await patch(c, m.memberId, { role: 'admin' }))
    ownerOnly(await patch(c, c2.memberId, { role: 'member' }))
    ownerOnly(await patch(c, c.memberId, { role: 'member' }))
    ownerOnly(await patch(c, c2.memberId, { status: 'suspended' }))
    ownerOnly(await s.req(c, { method: 'PATCH', url: `/api/admin/devices/${c2.deviceId}`, ip: IP, payload: { action: 'revoke' } }))
    // details of another 서무 are everyday work
    expect((await patch(c, c2.memberId, { title: '주무관' })).statusCode).toBe(200)
    // sending the role a member already has changes nothing and is not refused
    expect((await patch(c, m.memberId, { role: 'member', title: '서기' })).statusCode).toBe(200)

    expect((await patch(s.admin, c2.memberId, { status: 'suspended' })).statusCode).toBe(200)
    expect((await patch(s.admin, c2.memberId, { status: 'active', role: 'member' })).statusCode).toBe(200)
    expect((await s.req(c2, { method: 'GET', url: '/api/admin/status', ip: IP })).statusCode).toBe(403)
  })

  it('the 최종관리자 and the server PC cannot be touched by a 서무, nor demoted or stopped by anyone', async () => {
    s = await createTestServer()
    const c = await clerk(s, '김서무')
    const owner = s.admin.memberId
    const patch = (cred: Cred, payload: object) => s!.req(cred, { method: 'PATCH', url: `/api/admin/members/${owner}`, ip: cred === s!.admin ? undefined : IP, payload })
    ownerOnly(await patch(c, { name: '바꾼이름' }))
    expect((await patch(c, { role: 'member' })).statusCode).toBe(400)
    expect((await patch(c, { status: 'suspended' })).statusCode).toBe(400)
    expect((await patch(s.admin, { role: 'member' })).statusCode).toBe(400)
    expect((await patch(s.admin, { status: 'suspended' })).statusCode).toBe(400)
    expect((await patch(s.admin, { title: '팀장' })).statusCode).toBe(200)
    // the server PC itself
    expect((await s.req(c, { method: 'PATCH', url: `/api/admin/devices/${s.admin.deviceId}`, ip: IP, payload: { action: 'revoke' } })).statusCode).toBe(400)
    expect((await s.req(c, { method: 'POST', url: '/api/admin/blocked-pcs', ip: IP, payload: { deviceId: s.admin.deviceId, reason: '실수로' } })).statusCode).toBe(400)
    expect((await s.req(s.admin, { method: 'GET', url: '/api/me' })).json().data).toMatchObject({ role: 'admin', status: 'active', name: '관리자', isOwner: true })
  })

  it('a permanent block is lifted by the 최종관리자 only', async () => {
    s = await createTestServer()
    const c = await clerk(s, '김서무')
    const m = await s.join('이주무')
    const id = (await s.req(s.admin, { method: 'POST', url: '/api/admin/blocked-pcs', payload: { deviceId: m.deviceId, reason: '분실 PC' } })).json().data.id
    ownerOnly(await s.req(c, { method: 'DELETE', url: `/api/admin/blocked-pcs/${id}`, ip: IP }))
    // nor around it: the blocked PC's entry is not restored, its new request not approved
    expect((await s.req(c, { method: 'PATCH', url: `/api/admin/devices/${m.deviceId}`, ip: IP, payload: { action: 'restore' } })).statusCode).toBe(400)
    expect((await s.req(s.admin, { method: 'DELETE', url: `/api/admin/blocked-pcs/${id}` })).statusCode).toBe(200)
  })

  it('the admin PIN comes before the tier: a 서무 without the PIN is asked for it', async () => {
    s = await createTestServer()
    const c = await clerk(s, '김서무')
    expect((await s.req(s.admin, { method: 'PUT', url: '/api/admin/settings', payload: { adminPin: '1234' } })).statusCode).toBe(200)
    expect((await s.req(c, { method: 'POST', url: '/api/admin/backups', ip: IP })).json().error.code).toBe('ADMIN_PIN_REQUIRED')
    ownerOnly(await s.req(c, { method: 'POST', url: '/api/admin/backups', ip: IP, headers: { 'x-admin-pin': '1234' } }))
    expect((await s.req(c, { method: 'GET', url: '/api/admin/status', ip: IP, headers: { 'x-admin-pin': '1234' } })).statusCode).toBe(200)
  })

  it('existing installations: the server PC’s account is found and made the 최종관리자 again when the server starts', async () => {
    s = await createTestServer()
    const c = await clerk(s, '김서무')
    const db = s.ctx.db
    // a database from before the server device was recorded, where the server PC's account was demoted
    db.run(`DELETE FROM settings WHERE key = 'serverDeviceId'`)
    db.run(`UPDATE members SET role = 'member' WHERE id = ?`, [s.admin.memberId])
    expect((await s.req(s.admin, { method: 'GET', url: '/api/me' })).json().data).toMatchObject({ role: 'member', isOwner: false })
    ensureServerOwner(db)
    expect(serverDeviceId(db)).toBe(s.admin.deviceId)
    expect((await s.req(s.admin, { method: 'GET', url: '/api/me' })).json().data).toMatchObject({ role: 'admin', isOwner: true })
    // the other admins simply are 서무
    expect((await s.req(c, { method: 'GET', url: '/api/me', ip: IP })).json().data).toMatchObject({ role: 'admin', isOwner: false })
  })
})
