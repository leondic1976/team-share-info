import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createTestServer, type TestServer } from './helpers'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})

describe('join and approval (M1-3)', () => {
  it('runs request -> pending -> approve -> one-time key pickup', async () => {
    s = await createTestServer()
    const r = await s.req(null, {
      method: 'POST',
      url: '/api/join',
      ip: '192.168.10.30',
      payload: { name: '홍길동', deptName: '행정팀', pcName: 'PC-1', winUser: 'hong', appVersion: '0.1.0' }
    })
    const { requestId, pollToken } = r.json().data
    let p = await s.req(null, { method: 'GET', url: `/api/join/${requestId}?token=${pollToken}` })
    expect(p.json().data).toEqual({ state: 'pending' })

    const list = await s.req(s.admin, { method: 'GET', url: '/api/admin/join-requests' })
    expect(list.json().data[0]).toMatchObject({ name: '홍길동', ip: '192.168.10.30', pcName: 'PC-1', winUser: 'hong' })

    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/join-requests/${requestId}`, payload: { action: 'approve' } })
    p = await s.req(null, { method: 'GET', url: `/api/join/${requestId}?token=${pollToken}` })
    const d = p.json().data
    expect(d.state).toBe('approved')
    expect(d.deviceKey).toBeTruthy()
    // key is delivered only once
    const again = await s.req(null, { method: 'GET', url: `/api/join/${requestId}?token=${pollToken}` })
    expect(again.json().data.deviceKey).toBeUndefined()

    const me = await s.req({ deviceId: d.deviceId, deviceKey: d.deviceKey, winUser: 'hong', memberId: d.memberId }, { method: 'GET', url: '/api/me', ip: '192.168.10.30' })
    expect(me.json().data).toMatchObject({ name: '홍길동', role: 'member' })
  })

  it('rejects a wrong poll token', async () => {
    s = await createTestServer()
    const r = await s.req(null, { method: 'POST', url: '/api/join', payload: { name: 'a', pcName: 'p', winUser: 'w' } })
    const { requestId } = r.json().data
    const p = await s.req(null, { method: 'GET', url: `/api/join/${requestId}?token=wrongwrongwrong` })
    expect(p.statusCode).toBe(404)
  })

  it('rejected requests never get a key', async () => {
    s = await createTestServer()
    const r = await s.req(null, { method: 'POST', url: '/api/join', payload: { name: 'a', pcName: 'p', winUser: 'w' } })
    const { requestId, pollToken } = r.json().data
    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/join-requests/${requestId}`, payload: { action: 'reject' } })
    const p = await s.req(null, { method: 'GET', url: `/api/join/${requestId}?token=${pollToken}` })
    expect(p.json().data).toEqual({ state: 'rejected' })
  })

  it('only admins can approve', async () => {
    s = await createTestServer()
    const member = await s.join('김철수')
    const r = await s.req(null, { method: 'POST', url: '/api/join', payload: { name: 'x', pcName: 'p', winUser: 'w' } })
    const res = await s.req(member, { method: 'PATCH', url: `/api/admin/join-requests/${r.json().data.requestId}`, payload: { action: 'approve' }, ip: '192.168.10.20' })
    expect(res.statusCode).toBe(403)
  })

  it('blocks a revoked device immediately and restores it', async () => {
    s = await createTestServer()
    const m = await s.join('김철수')
    const opts = { method: 'GET' as const, url: '/api/me', ip: '192.168.10.20' }
    expect((await s.req(m, opts)).statusCode).toBe(200)
    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/devices/${m.deviceId}`, payload: { action: 'revoke' } })
    const blocked = await s.req(m, opts)
    expect(blocked.statusCode).toBe(403)
    expect(blocked.json().error.code).toBe('DEVICE_REVOKED')
    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/devices/${m.deviceId}`, payload: { action: 'restore' } })
    expect((await s.req(m, opts)).statusCode).toBe(200)
  })

  it('blocks suspended members', async () => {
    s = await createTestServer()
    const m = await s.join('김철수')
    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/members/${m.memberId}`, payload: { status: 'suspended' } })
    const r = await s.req(m, { method: 'GET', url: '/api/me', ip: '192.168.10.20' })
    expect(r.json().error.code).toBe('MEMBER_SUSPENDED')
  })

  it('keeps at least one admin', async () => {
    s = await createTestServer()
    const r = await s.req(s.admin, { method: 'PATCH', url: `/api/admin/members/${s.admin.memberId}`, payload: { role: 'member' } })
    expect(r.statusCode).toBe(400)
  })

  it('enforces allowed IP ranges for join and requests', async () => {
    s = await createTestServer()
    await s.req(s.admin, { method: 'PUT', url: '/api/admin/settings', payload: { network: { allowedCidrs: ['192.168.10.0/24'] } } })
    const outside = await s.req(null, { method: 'POST', url: '/api/join', ip: '10.0.0.5', payload: { name: 'a', pcName: 'p', winUser: 'w' } })
    expect(outside.statusCode).toBe(403)
    const m = await s.join('김철수', { ip: '192.168.10.40' })
    expect((await s.req(m, { method: 'GET', url: '/api/me', ip: '192.168.10.40' })).statusCode).toBe(200)
    const moved = await s.req(m, { method: 'GET', url: '/api/me', ip: '10.0.0.9' })
    expect(moved.json().error.code).toBe('IP_NOT_ALLOWED')
  })

  it('auto-approves inside the allowed range when enabled', async () => {
    s = await createTestServer()
    await s.req(s.admin, { method: 'PUT', url: '/api/admin/settings', payload: { network: { allowedCidrs: ['192.168.10.0/24'], approvalMode: 'auto-in-cidr' } } })
    const r = await s.req(null, { method: 'POST', url: '/api/join', ip: '192.168.10.77', payload: { name: 'auto', pcName: 'p', winUser: 'w' } })
    const { requestId, pollToken } = r.json().data
    const p = await s.req(null, { method: 'GET', url: `/api/join/${requestId}?token=${pollToken}`, ip: '192.168.10.77' })
    expect(p.json().data.state).toBe('approved')
  })

  it('flags devices whose IP changed and can require re-approval', async () => {
    s = await createTestServer()
    const m = await s.join('김철수', { ip: '192.168.10.40' })
    await s.req(m, { method: 'GET', url: '/api/me', ip: '192.168.10.41' })
    const devs = (await s.req(s.admin, { method: 'GET', url: '/api/admin/devices' })).json().data
    expect(devs.find((d: { id: string }) => d.id === m.deviceId)).toMatchObject({ ipChanged: true, lastIp: '192.168.10.41' })
    await s.req(s.admin, { method: 'PUT', url: '/api/admin/settings', payload: { network: { reapproveOnIpChange: true } } })
    expect((await s.req(m, { method: 'GET', url: '/api/me', ip: '192.168.10.41' })).statusCode).toBe(403)
    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/devices/${m.deviceId}`, payload: { action: 'accept-ip' } })
    expect((await s.req(m, { method: 'GET', url: '/api/me', ip: '192.168.10.41' })).statusCode).toBe(200)
  })
})

describe('admin settings and PIN (M1-7)', () => {
  it('updates org notice visible on hello', async () => {
    s = await createTestServer()
    await s.req(s.admin, { method: 'PUT', url: '/api/admin/settings', payload: { org: { noticeText: '새 안내문' } } })
    expect((await s.req(null, { method: 'GET', url: '/api/hello' })).json().data.noticeText).toBe('새 안내문')
  })

  it('validates settings', async () => {
    s = await createTestServer()
    const r = await s.req(s.admin, { method: 'PUT', url: '/api/admin/settings', payload: { network: { allowedCidrs: ['nope'] } } })
    expect(r.statusCode).toBe(400)
  })

  it('requires the admin PIN once set', async () => {
    s = await createTestServer({ adminPin: '1234' })
    const no = await s.req(s.admin, { method: 'GET', url: '/api/admin/settings' })
    expect(no.json().error.code).toBe('ADMIN_PIN_REQUIRED')
    const wrong = await s.req(s.admin, { method: 'GET', url: '/api/admin/settings', headers: { 'x-admin-pin': '9999' } })
    expect(wrong.statusCode).toBe(403)
    const ok = await s.req(s.admin, { method: 'GET', url: '/api/admin/settings', headers: { 'x-admin-pin': '1234' } })
    expect(ok.statusCode).toBe(200)
    expect((await s.req(s.admin, { method: 'GET', url: '/api/me' })).json().data.adminPinSet).toBe(true)
  })

  it('records state-changing actions in the activity log', async () => {
    s = await createTestServer()
    await s.join('김철수')
    const acts = (await s.req(s.admin, { method: 'GET', url: '/api/admin/activity' })).json().data.map((a: { action: string }) => a.action)
    expect(acts).toEqual(expect.arrayContaining(['join.request', 'join.approve']))
  })

  it('lists members with presence and departments', async () => {
    s = await createTestServer()
    await s.join('김철수', { deptName: '기획팀' })
    const ms = (await s.req(s.admin, { method: 'GET', url: '/api/members' })).json().data
    expect(ms.map((m: { name: string }) => m.name).sort()).toEqual(['관리자', '김철수'])
    expect(ms.find((m: { name: string }) => m.name === '김철수')).toMatchObject({ deptName: '기획팀', presence: 'offline' })
  })
})

describe('update distribution (M1-6)', () => {
  it('publishes an installer and writes latest.yml with sha512', async () => {
    s = await createTestServer()
    const body = Buffer.alloc(2 * 1024 * 1024, 7)
    const r = await s.req(s.admin, {
      method: 'POST',
      url: '/api/admin/releases?version=0.2.0&notes=fix&fileName=TeamHub-Setup-0.2.0.exe',
      headers: { 'content-type': 'application/octet-stream' },
      payload: body
    })
    expect(r.statusCode).toBe(200)
    const sha = createHash('sha512').update(body).digest('base64')
    expect(r.json().data).toMatchObject({ version: '0.2.0', sha512: sha, size: body.length })
    const yml = readFileSync(join(s.dataDir, 'updates', 'latest.yml'), 'utf8')
    expect(yml).toContain('version: 0.2.0')
    expect(yml).toContain(`sha512: ${sha}`)
    expect(yml).toContain('path: TeamHub-Setup-0.2.0.exe')

    const feed = await s.req(null, { method: 'GET', url: '/updates/latest.yml' })
    expect(feed.statusCode).toBe(200)
    expect(feed.body).toContain('version: 0.2.0')
    const exe = await s.req(null, { method: 'GET', url: '/updates/TeamHub-Setup-0.2.0.exe' })
    expect(exe.rawPayload.length).toBe(body.length)
    const dl = await s.req(null, { method: 'GET', url: '/download' })
    expect(dl.body).toContain('TeamHub-Setup-0.2.0.exe')

    const dup = await s.req(s.admin, {
      method: 'POST',
      url: '/api/admin/releases?version=0.2.0&fileName=TeamHub-Setup-0.2.0.exe',
      headers: { 'content-type': 'application/octet-stream' },
      payload: body
    })
    expect(dup.statusCode).toBe(409)
  })

  it('keeps latest.yml on the highest published version and supports withdraw', async () => {
    s = await createTestServer()
    const body = Buffer.alloc(1024 * 1024 + 10, 1)
    const up = (v: string) =>
      s!.req(s!.admin, {
        method: 'POST',
        url: `/api/admin/releases?version=${v}&fileName=TeamHub-Setup-${v}.exe`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: body
      })
    await up('0.10.0')
    const r2 = await up('0.9.0')
    let yml = readFileSync(join(s.dataDir, 'updates', 'latest.yml'), 'utf8')
    expect(yml).toContain('version: 0.10.0')
    const list = (await s.req(s.admin, { method: 'GET', url: '/api/admin/releases' })).json().data
    const v10 = list.find((x: { version: string }) => x.version === '0.10.0')
    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/releases/${v10.id}`, payload: { state: 'withdrawn' } })
    yml = readFileSync(join(s.dataDir, 'updates', 'latest.yml'), 'utf8')
    expect(yml).toContain('version: 0.9.0')
    expect(r2.statusCode).toBe(200)
  })

  it('rejects non-exe uploads and non-admins', async () => {
    s = await createTestServer()
    const bad = await s.req(s.admin, {
      method: 'POST',
      url: '/api/admin/releases?version=1.0.0&fileName=evil.bat',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(2 * 1024 * 1024)
    })
    expect(bad.statusCode).toBe(400)
    const m = await s.join('김철수')
    const r = await s.req(m, {
      method: 'POST',
      url: '/api/admin/releases?version=1.0.0&fileName=a.exe',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(10),
      ip: '192.168.10.20'
    })
    expect(r.statusCode).toBe(403)
  })
})
