import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type Cred, type TestServer } from './helpers'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})

const IP = '192.168.10.31'
const UID_A = 'ABCD-EFGH-2345'
const UID_B = 'WXYZ-2345-ABCD'

interface Asked {
  requestId: string
  pollToken: string
}

async function ask(t: TestServer, pc: { name: string; pcName: string; winUser: string; pcUid?: string }): Promise<Asked> {
  const r = await t.req(null, { method: 'POST', url: '/api/join', ip: IP, payload: { name: pc.name, deptName: '행정팀', pcName: pc.pcName, winUser: pc.winUser, appVersion: '1.3.0', pcUid: pc.pcUid } })
  expect(r.statusCode).toBe(200)
  return r.json().data as Asked
}

async function approve(t: TestServer, a: Asked, winUser: string): Promise<Cred> {
  expect((await t.req(t.admin, { method: 'PATCH', url: `/api/admin/join-requests/${a.requestId}`, payload: { action: 'approve' } })).statusCode).toBe(200)
  const d = (await t.req(null, { method: 'GET', url: `/api/join/${a.requestId}?token=${a.pollToken}`, ip: IP })).json().data
  return { deviceId: d.deviceId, deviceKey: d.deviceKey, winUser, memberId: d.memberId }
}

const activeNames = async (t: TestServer): Promise<string[]> =>
  ((await t.req(t.admin, { method: 'GET', url: '/api/admin/members' })).json().data as { name: string; status: string }[])
    .filter((m) => m.status === 'active')
    .map((m) => m.name)
    .sort()

describe('one PC, one account (unique value of the PC)', () => {
  it('a PC that asks again gets its account back; its old key stops working; no second person appears', async () => {
    s = await createTestServer()
    const pc = { name: '김주무', pcName: 'PC-KIM', winUser: 'kim', pcUid: UID_A }
    const first = await approve(s, await ask(s, pc), 'kim')
    expect((await s.req(first, { method: 'GET', url: '/api/me', ip: IP })).statusCode).toBe(200)

    // connection reset on the PC, or a new installation: it asks again (even under another name)
    const again = await ask(s, { ...pc, name: '김주무(재설치)' })
    const list = (await s.req(s.admin, { method: 'GET', url: '/api/admin/join-requests' })).json().data as { id: string; pcUid: string; knownMember: { id: string; name: string } | null }[]
    expect(list.find((r) => r.id === again.requestId)).toMatchObject({ pcUid: UID_A, knownMember: { id: first.memberId, name: '김주무' } })
    const second = await approve(s, again, 'kim')
    expect(second.memberId).toBe(first.memberId)
    expect(second.deviceId).not.toBe(first.deviceId)
    expect((await s.req(first, { method: 'GET', url: '/api/me', ip: IP })).json().error.code).toBe('DEVICE_REVOKED')
    expect((await s.req(second, { method: 'GET', url: '/api/me', ip: IP })).json().data.name).toBe('김주무')
    expect(await activeNames(s)).toEqual(['관리자', '김주무'])

    // another PC is another account
    const other = await approve(s, await ask(s, { name: '이주무', pcName: 'PC-LEE', winUser: 'lee', pcUid: UID_B }), 'lee')
    expect(other.memberId).not.toBe(first.memberId)
    expect(await activeNames(s)).toEqual(['관리자', '김주무', '이주무'])
  })

  it('asking twice before an answer leaves one open request', async () => {
    s = await createTestServer()
    const pc = { name: '박주무', pcName: 'PC-PARK', winUser: 'park', pcUid: UID_A }
    const a = await ask(s, pc)
    const b = await ask(s, pc)
    const open = (await s.req(s.admin, { method: 'GET', url: '/api/admin/join-requests' })).json().data as { id: string }[]
    expect(open.map((r) => r.id)).toEqual([b.requestId])
    expect((await s.req(null, { method: 'GET', url: `/api/join/${a.requestId}?token=${a.pollToken}`, ip: IP })).json().data.state).toBe('rejected')
  })

  it('PCs approved before unique values existed: duplicates of one PC are folded into one account', async () => {
    s = await createTestServer()
    // the old version: the same PC asked three times and became three people
    const old = { name: '최주무', pcName: 'PC-CHOI', winUser: 'choi' }
    const one = await approve(s, await ask(s, old), 'choi')
    // (the fix already recognises it by PC name + Windows account, so make the leftovers the way the old server did)
    const dupMember = s.ctx.db.get<{ id: string }>(`SELECT id FROM members WHERE name = '최주무'`)!.id
    expect(dupMember).toBe(one.memberId)
    const t = Date.now()
    for (const n of ['a', 'b']) {
      s.ctx.db.run(`INSERT INTO members (id, name, role, status, created_at, updated_at) VALUES (?, '최주무', 'member', 'active', ?, ?)`, [`dup-${n}`, t, t])
      s.ctx.db.run(
        `INSERT INTO devices (id, member_id, key_hash, pc_name, win_user, approved_ip, last_ip, approved_at, created_at, updated_at) VALUES (?, ?, 'x', 'pc-choi', 'CHOI', ?, ?, ?, ?, ?)`,
        [`dev-${n}`, `dup-${n}`, IP, IP, t - 1000, t, t]
      )
    }
    expect((await activeNames(s)).filter((n) => n === '최주무')).toHaveLength(3)

    // the updated program on that PC asks again, now with its unique value
    const now = await approve(s, await ask(s, { ...old, pcUid: UID_A }), 'choi')
    expect(now.memberId).toBe(one.memberId) // the newest approval is the account that stays
    expect((await activeNames(s)).filter((n) => n === '최주무')).toHaveLength(1)
    expect(s.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM devices WHERE lower(pc_name) = 'pc-choi' AND revoked_at IS NULL`)?.n).toBe(1)
    expect(s.ctx.db.get<{ pc_uid: string }>('SELECT pc_uid FROM devices WHERE id = ?', [now.deviceId])?.pc_uid).toBe(UID_A)
    // nothing was deleted: the folded accounts are only out of use
    expect(s.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM members WHERE status = 'suspended'`)?.n).toBe(2)
  })

  it('block: the PC is cut off but may ask again; permanent block: it cannot ask until it is taken off the list', async () => {
    s = await createTestServer()
    const pc = { name: '정주무', pcName: 'PC-JUNG', winUser: 'jung', pcUid: UID_A }
    const first = await approve(s, await ask(s, pc), 'jung')

    // ordinary block (차단)
    expect((await s.req(s.admin, { method: 'PATCH', url: `/api/admin/devices/${first.deviceId}`, payload: { action: 'revoke' } })).statusCode).toBe(200)
    expect((await s.req(first, { method: 'GET', url: '/api/me', ip: IP })).json().error.code).toBe('DEVICE_REVOKED')
    const back = await approve(s, await ask(s, pc), 'jung')
    expect(back.memberId).toBe(first.memberId)
    expect((await s.req(back, { method: 'GET', url: '/api/me', ip: IP })).statusCode).toBe(200)

    // permanent block needs a reason
    const noReason = await s.req(s.admin, { method: 'POST', url: '/api/admin/blocked-pcs', payload: { deviceId: back.deviceId, reason: ' ' } })
    expect(noReason.statusCode).toBe(400)
    const waiting = await ask(s, pc) // a request that is still open when the block is made
    const banned = await s.req(s.admin, { method: 'POST', url: '/api/admin/blocked-pcs', payload: { deviceId: back.deviceId, reason: '퇴직자 PC' } })
    expect(banned.statusCode).toBe(200)
    expect((await s.req(back, { method: 'GET', url: '/api/me', ip: IP })).json().error.code).toBe('DEVICE_REVOKED')
    expect((await s.req(null, { method: 'GET', url: `/api/join/${waiting.requestId}?token=${waiting.pollToken}`, ip: IP })).json().data.state).toBe('rejected')
    // it cannot ask again - not with a new unique value (new installation) either
    for (const uid of [UID_A, UID_B, undefined]) {
      const r = await s.req(null, { method: 'POST', url: '/api/join', ip: IP, payload: { name: '정주무', pcName: 'pc-jung', winUser: 'JUNG', pcUid: uid } })
      expect(r.statusCode).toBe(403)
      expect(r.json().error.code).toBe('PC_BLOCKED')
    }
    // and the old entry cannot simply be allowed again
    expect((await s.req(s.admin, { method: 'PATCH', url: `/api/admin/devices/${back.deviceId}`, payload: { action: 'restore' } })).statusCode).toBe(400)
    const list = (await s.req(s.admin, { method: 'GET', url: '/api/admin/blocked-pcs' })).json().data as { id: string; reason: string; memberName: string; pcUid: string; blockedByName: string }[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ reason: '퇴직자 PC', memberName: '정주무', pcUid: UID_A, blockedByName: '관리자' })

    // taken off the list: it may ask, and approval gives the same account back
    expect((await s.req(s.admin, { method: 'DELETE', url: `/api/admin/blocked-pcs/${list[0].id}` })).statusCode).toBe(200)
    const again = await approve(s, await ask(s, pc), 'jung')
    expect(again.memberId).toBe(first.memberId)
    expect((await s.req(again, { method: 'GET', url: '/api/me', ip: IP })).statusCode).toBe(200)
    expect(await activeNames(s)).toEqual(['관리자', '정주무'])
  })

  it('permanent block: not the PC in use, not the server PC, not an admin PC; a waiting request can be blocked too', async () => {
    s = await createTestServer()
    const serverDevice = s.admin.deviceId
    expect((await s.req(s.admin, { method: 'POST', url: '/api/admin/blocked-pcs', payload: { deviceId: serverDevice, reason: '실수' } })).statusCode).toBe(400)
    const boss = await approve(s, await ask(s, { name: '부관리자', pcName: 'PC-BOSS', winUser: 'boss', pcUid: UID_B }), 'boss')
    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/members/${boss.memberId}`, payload: { role: 'admin' } })
    expect((await s.req(s.admin, { method: 'POST', url: '/api/admin/blocked-pcs', payload: { deviceId: boss.deviceId, reason: '실수' } })).json().error.message).toContain('관리자')
    const stranger = await ask(s, { name: '모르는사람', pcName: 'PC-X', winUser: 'x', pcUid: UID_A })
    expect((await s.req(s.admin, { method: 'POST', url: '/api/admin/blocked-pcs', payload: { requestId: stranger.requestId, reason: '모르는 PC의 반복 신청' } })).statusCode).toBe(200)
    expect((await s.req(s.admin, { method: 'GET', url: '/api/admin/join-requests' })).json().data).toEqual([])
    expect((await s.req(null, { method: 'POST', url: '/api/join', ip: IP, payload: { name: '또', pcName: 'PC-X', winUser: 'x', pcUid: UID_A } })).statusCode).toBe(403)
  })

  it('a device approved earlier learns the unique value of its PC; the server PC itself is never matched', async () => {
    s = await createTestServer()
    const kim = await approve(s, await ask(s, { name: '김주무', pcName: 'PC-KIM', winUser: 'kim' }), 'kim')
    await s.req(kim, { method: 'GET', url: '/api/me', ip: IP, headers: { 'x-pc-uid': UID_B } })
    await s.req(kim, { method: 'GET', url: '/api/me', ip: IP, headers: { 'x-pc-uid': UID_A } }) // does not change once known
    expect(s.ctx.db.get<{ pc_uid: string }>('SELECT pc_uid FROM devices WHERE id = ?', [kim.deviceId])?.pc_uid).toBe(UID_B)
    // someone on another PC with the same PC name and account as the server PC is not taken for the admin
    const fake = await approve(s, await ask(s, { name: '가짜', pcName: 'SERVER-PC', winUser: 'admin' }), 'admin')
    expect(fake.memberId).not.toBe(s.admin.memberId)
    expect((await s.req(s.admin, { method: 'GET', url: '/api/me' })).statusCode).toBe(200)
  })
})
