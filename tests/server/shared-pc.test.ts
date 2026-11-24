import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type Cred, type TestServer } from './helpers'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})

const IP = '192.168.10.41'
// one PC, one Windows account, several people: each has an own unique value (own data folder)
const PC = { pcName: 'PC-MINWON', winUser: 'office' }
const UID_HONG = 'ABCD-EFGH-2345'
const UID_KIM = 'WXYZ-2345-ABCD'
const UID_LEE = 'MNPQ-6789-RSTU'

interface Asked {
  requestId: string
  pollToken: string
}

async function ask(t: TestServer, p: { name: string; pcUid?: string; sharedPc?: boolean }): Promise<Asked> {
  const r = await t.req(null, { method: 'POST', url: '/api/join', ip: IP, payload: { name: p.name, deptName: '민원실', ...PC, appVersion: '1.6.0', pcUid: p.pcUid, sharedPc: p.sharedPc } })
  expect(r.statusCode).toBe(200)
  return r.json().data as Asked
}

async function approve(t: TestServer, a: Asked): Promise<Cred> {
  expect((await t.req(t.admin, { method: 'PATCH', url: `/api/admin/join-requests/${a.requestId}`, payload: { action: 'approve' } })).statusCode).toBe(200)
  const d = (await t.req(null, { method: 'GET', url: `/api/join/${a.requestId}?token=${a.pollToken}`, ip: IP })).json().data
  return { deviceId: d.deviceId, deviceKey: d.deviceKey, winUser: PC.winUser, memberId: d.memberId }
}

const me = async (t: TestServer, c: Cred): Promise<{ statusCode: number; name?: string; code?: string }> => {
  const r = await t.req(c, { method: 'GET', url: '/api/me', ip: IP })
  const j = r.json()
  return { statusCode: r.statusCode, name: j.data?.name, code: j.error?.code }
}

type JoinRow = { id: string; sharedPc?: boolean; knownMember: { id: string; name: string } | null }
type DeviceRow = { id: string; memberName: string; sharedPc?: boolean; revokedAt: number | null; isServer: boolean }
const joins = async (t: TestServer): Promise<JoinRow[]> => (await t.req(t.admin, { method: 'GET', url: '/api/admin/join-requests' })).json().data as JoinRow[]
const devices = async (t: TestServer): Promise<DeviceRow[]> => (await t.req(t.admin, { method: 'GET', url: '/api/admin/devices' })).json().data as DeviceRow[]
const activeNames = async (t: TestServer): Promise<string[]> =>
  ((await t.req(t.admin, { method: 'GET', url: '/api/admin/members' })).json().data as { name: string; status: string }[])
    .filter((m) => m.status === 'active')
    .map((m) => m.name)
    .sort()

describe('shared PC: several people on one PC name + Windows account', () => {
  it('the server says it can tell the people of a shared PC apart', async () => {
    s = await createTestServer()
    expect((await s.req(null, { method: 'GET', url: '/api/hello' })).json().data.caps).toContain('seats')
  })

  it('a second person gets an own account; the first person keeps theirs and stays connected', async () => {
    s = await createTestServer()
    // 홍길동 used the PC alone, before shared mode was turned on
    const hong = await approve(s, await ask(s, { name: '홍길동', pcUid: UID_HONG }))
    // 김주무 is added on that PC and asks for access
    const asked = await ask(s, { name: '김주무', pcUid: UID_KIM, sharedPc: true })
    const row = (await joins(s)).find((r) => r.id === asked.requestId)!
    expect(row.sharedPc).toBe(true)
    expect(row.knownMember).toBeNull() // not "this PC already has an account"
    const kim = await approve(s, asked)

    expect(kim.memberId).not.toBe(hong.memberId)
    expect(await me(s, hong)).toMatchObject({ statusCode: 200, name: '홍길동' }) // not cut off
    expect(await me(s, kim)).toMatchObject({ statusCode: 200, name: '김주무' })
    expect(await activeNames(s)).toEqual(['관리자', '김주무', '홍길동'])

    // a third person: still nobody merged, nobody cut off
    const lee = await approve(s, await ask(s, { name: '이주무', pcUid: UID_LEE, sharedPc: true }))
    expect(new Set([hong.memberId, kim.memberId, lee.memberId]).size).toBe(3)
    for (const c of [hong, kim, lee]) expect((await me(s, c)).statusCode).toBe(200)

    // the admin sees that several accounts on this PC are intended - also on the first person's entry
    const list = (await devices(s)).filter((d) => !d.isServer)
    expect(list).toHaveLength(3)
    expect(list.every((d) => d.sharedPc)).toBe(true)
    expect((await devices(s)).find((d) => d.isServer)?.sharedPc).toBe(false)
  })

  it('the first person was approved before unique values existed (no value on the server): still not merged', async () => {
    s = await createTestServer()
    // old approval: recognised only by PC name + Windows account - the same for everybody on this PC
    const hong = await approve(s, await ask(s, { name: '홍길동' }))
    expect(s.ctx.db.get<{ pc_uid: string | null }>('SELECT pc_uid FROM devices WHERE id = ?', [hong.deviceId])?.pc_uid).toBeNull()

    const asked = await ask(s, { name: '김주무', pcUid: UID_KIM, sharedPc: true })
    expect((await joins(s)).find((r) => r.id === asked.requestId)?.knownMember).toBeNull()
    const kim = await approve(s, asked)
    expect(kim.memberId).not.toBe(hong.memberId)
    expect(await me(s, hong)).toMatchObject({ statusCode: 200, name: '홍길동' })
    expect(await me(s, kim)).toMatchObject({ statusCode: 200, name: '김주무' })
    expect(s.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM members WHERE status = 'suspended'`)?.n).toBe(0)

    // without the mark the old rule applies (one PC, one account) - which is why the mark is sent
    const unmarked = await ask(s, { name: '표시없음', pcUid: UID_LEE })
    expect((await joins(s)).find((r) => r.id === unmarked.requestId)?.knownMember).toMatchObject({ id: hong.memberId })
  })

  it('the same person asks again (connection reset, folder made anew with the same value): same account, only their own old key stops', async () => {
    s = await createTestServer()
    const hong = await approve(s, await ask(s, { name: '홍길동', pcUid: UID_HONG, sharedPc: true }))
    const kim = await approve(s, await ask(s, { name: '김주무', pcUid: UID_KIM, sharedPc: true }))

    const asked = await ask(s, { name: '김주무(다시)', pcUid: UID_KIM, sharedPc: true })
    expect((await joins(s)).find((r) => r.id === asked.requestId)?.knownMember).toMatchObject({ id: kim.memberId, name: '김주무' })
    const kim2 = await approve(s, asked)
    expect(kim2.memberId).toBe(kim.memberId)
    expect(kim2.deviceId).not.toBe(kim.deviceId)
    expect((await me(s, kim)).code).toBe('DEVICE_REVOKED')
    expect(await me(s, kim2)).toMatchObject({ statusCode: 200, name: '김주무' })
    // the other person of the PC is untouched
    expect(await me(s, hong)).toMatchObject({ statusCode: 200, name: '홍길동' })
    expect(await activeNames(s)).toEqual(['관리자', '김주무', '홍길동'])
  })

  it('two people asking at the same time are two open requests', async () => {
    s = await createTestServer()
    const a = await ask(s, { name: '홍길동', pcUid: UID_HONG, sharedPc: true })
    const b = await ask(s, { name: '김주무', pcUid: UID_KIM, sharedPc: true })
    expect((await joins(s)).map((r) => r.id).sort()).toEqual([a.requestId, b.requestId].sort())
  })

  it('blocking one person\'s entry (차단) leaves the others; a permanent block shuts the whole PC out', async () => {
    s = await createTestServer()
    const hong = await approve(s, await ask(s, { name: '홍길동', pcUid: UID_HONG, sharedPc: true }))
    const kim = await approve(s, await ask(s, { name: '김주무', pcUid: UID_KIM, sharedPc: true }))

    expect((await s.req(s.admin, { method: 'PATCH', url: `/api/admin/devices/${kim.deviceId}`, payload: { action: 'revoke' } })).statusCode).toBe(200)
    expect((await me(s, kim)).code).toBe('DEVICE_REVOKED')
    expect((await me(s, hong)).statusCode).toBe(200)
    expect((await s.req(s.admin, { method: 'PATCH', url: `/api/admin/devices/${kim.deviceId}`, payload: { action: 'restore' } })).statusCode).toBe(200)
    expect((await me(s, kim)).statusCode).toBe(200)

    // permanent block is by PC (unique value, PC name + Windows account): everybody on it
    expect((await s.req(s.admin, { method: 'POST', url: '/api/admin/blocked-pcs', payload: { deviceId: kim.deviceId, reason: '분실 PC' } })).statusCode).toBe(200)
    expect((await me(s, kim)).code).toBe('DEVICE_REVOKED')
    expect((await me(s, hong)).code).toBe('DEVICE_REVOKED')
    const r = await s.req(null, { method: 'POST', url: '/api/join', ip: IP, payload: { name: '이주무', ...PC, pcUid: UID_LEE, sharedPc: true } })
    expect(r.json().error.code).toBe('PC_BLOCKED')
  })
})
