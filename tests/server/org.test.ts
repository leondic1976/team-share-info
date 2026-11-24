import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type Cred, type TestServer } from './helpers'
import type { DepartmentDto } from '../../src/shared/schemas/org'
import type { MemberDto } from '../../src/shared/schemas/auth'

const IP = '192.168.10.20'
let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})

const depts = async (): Promise<DepartmentDto[]> => (await s!.req(s!.admin, { method: 'GET', url: '/api/departments' })).json().data
const members = async (): Promise<MemberDto[]> => (await s!.req(s!.admin, { method: 'GET', url: '/api/members' })).json().data
const addDept = async (payload: Record<string, unknown>): Promise<string> => {
  const r = await s!.req(s!.admin, { method: 'POST', url: '/api/admin/departments', payload })
  expect(r.statusCode).toBe(200)
  return r.json().data.id
}
/** A member the 최종관리자 named 서무: an admin, but not on the server PC. */
const clerk = async (name: string): Promise<Cred> => {
  const c = await s!.join(name)
  const r = await s!.req(s!.admin, { method: 'PATCH', url: `/api/admin/members/${c.memberId}`, payload: { role: 'admin' } })
  expect(r.statusCode).toBe(200)
  return c
}

describe('organisation management (조직 관리)', () => {
  it('keeps the details of a department and puts a new one after its siblings', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const top = await addDept({ name: '총무과', headId: b.memberId, phone: '02-123-4567', duties: '서무, 회계', location: '본관 2층' })
    const t1 = await addDept({ name: '서무팀', parentId: top })
    const t2 = await addDept({ name: '회계팀', parentId: top, phone: '' })
    const list = await depts()
    expect(list.find((d) => d.id === top)).toMatchObject({ name: '총무과', parentId: null, headId: b.memberId, phone: '02-123-4567', duties: '서무, 회계', location: '본관 2층' })
    expect(list.find((d) => d.id === t1)!.sort).toBeLessThan(list.find((d) => d.id === t2)!.sort)
    expect(list.find((d) => d.id === t2)).toMatchObject({ parentId: top, headId: null, phone: null })

    // change some details, leave the others as they are; an empty text clears
    const p = await s.req(s.admin, { method: 'PATCH', url: `/api/admin/departments/${top}`, payload: { name: '운영지원과', headId: null, duties: '' } })
    expect(p.statusCode).toBe(200)
    expect((await depts()).find((d) => d.id === top)).toMatchObject({ name: '운영지원과', headId: null, duties: null, phone: '02-123-4567', location: '본관 2층' })
  })

  it('refuses a duplicate name, an unknown parent or head, and a parent below itself', async () => {
    s = await createTestServer()
    const a = await addDept({ name: 'A과' })
    const a1 = await addDept({ name: 'A1팀', parentId: a })
    const a11 = await addDept({ name: 'A11계', parentId: a1 })
    const post = (payload: Record<string, unknown>) => s!.req(s!.admin, { method: 'POST', url: '/api/admin/departments', payload })
    const patch = (id: string, payload: Record<string, unknown>) => s!.req(s!.admin, { method: 'PATCH', url: `/api/admin/departments/${id}`, payload })
    expect((await post({ name: 'A과' })).statusCode).toBe(400)
    expect((await post({ name: ' a 과 ' })).statusCode).toBe(400) // case and spacing do not make it another name
    expect((await post({ name: 'A>B' })).statusCode).toBe(400)
    expect((await post({ name: 'X', parentId: 'nope' })).statusCode).toBe(400)
    expect((await post({ name: 'X', headId: 'nope' })).statusCode).toBe(400)
    // a name is unique among the departments of one parent, not in the whole tree
    const b = (await post({ name: 'B과' })).json().data.id as string
    expect((await post({ name: 'A1팀', parentId: b })).statusCode).toBe(200)
    expect((await post({ name: 'A1팀', parentId: a })).statusCode).toBe(400)
    expect((await post({ name: '서무팀', parentId: a })).statusCode).toBe(200)
    expect((await patch(a1, { name: '서무팀' })).statusCode).toBe(400)
    expect((await patch(a1, { parentId: b })).statusCode).toBe(400) // B과 has an A1팀 already
    expect((await patch(a1, { name: 'A과' })).statusCode).toBe(200) // under A과, not beside it
    expect((await patch(a1, { parentId: null })).statusCode).toBe(400) // beside A과 it is taken
    expect((await patch(a1, { name: 'A1팀' })).statusCode).toBe(200)
    expect((await patch(a1, { name: 'A1팀', phone: '1' })).statusCode).toBe(200) // its own name is not a duplicate
    expect((await patch(a, { parentId: a })).statusCode).toBe(400)
    expect((await patch(a, { parentId: a11 })).statusCode).toBe(400)
    expect((await patch('nope', { name: 'Y' })).statusCode).toBe(404)
    expect((await patch(a11, { parentId: null })).statusCode).toBe(200)
    expect((await depts()).find((d) => d.id === a11)!.parentId).toBeNull()
  })

  it('orders the departments of one parent', async () => {
    s = await createTestServer()
    const top = await addDept({ name: '과' })
    const ids = [await addDept({ name: '가팀', parentId: top }), await addDept({ name: '나팀', parentId: top }), await addDept({ name: '다팀', parentId: top })]
    const order = (payload: Record<string, unknown>) => s!.req(s!.admin, { method: 'PUT', url: '/api/admin/departments/order', payload })
    expect((await order({ parentId: top, ids: [ids[2], ids[0], ids[1]] })).statusCode).toBe(200)
    const under = (await depts()).filter((d) => d.parentId === top).sort((x, y) => x.sort - y.sort)
    expect(under.map((d) => d.name)).toEqual(['다팀', '가팀', '나팀'])
    // only departments of that parent, each once
    expect((await order({ parentId: null, ids: [ids[0]] })).statusCode).toBe(400)
    expect((await order({ parentId: top, ids: [ids[0], ids[0]] })).statusCode).toBe(400)
  })

  it('does not delete a department with members; departments below a deleted one move up', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const top = await addDept({ name: '과' })
    const mid = await addDept({ name: '팀', parentId: top })
    const leaf = await addDept({ name: '계', parentId: mid })
    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/org/members/${b.memberId}`, payload: { deptId: mid } })
    const del = (id: string) => s!.req(s!.admin, { method: 'DELETE', url: `/api/admin/departments/${id}` })
    expect((await del(mid)).statusCode).toBe(400)
    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/org/members/${b.memberId}`, payload: { deptId: null } })
    expect((await del(mid)).statusCode).toBe(200)
    const list = await depts()
    expect(list.some((d) => d.id === mid)).toBe(false)
    expect(list.find((d) => d.id === leaf)!.parentId).toBe(top)
    expect((await del(mid)).statusCode).toBe(404)
  })

  it('sets department, 직위, 직급 and order of members', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C', { winUser: 'c', ip: '192.168.10.21' })
    const team = await addDept({ name: '기획팀' })
    const set = (id: string, payload: Record<string, unknown>) => s!.req(s!.admin, { method: 'PATCH', url: `/api/admin/org/members/${id}`, payload })
    expect((await set(b.memberId, { deptId: team, title: '팀장', rank: '6급' })).statusCode).toBe(200)
    expect((await set(c.memberId, { deptId: team, rank: '8급' })).statusCode).toBe(200)
    expect((await set(c.memberId, { deptId: 'nope' })).statusCode).toBe(404)
    expect((await set('nope', { rank: 'x' })).statusCode).toBe(404)
    let list = await members()
    expect(list.find((m) => m.id === b.memberId)).toMatchObject({ deptId: team, deptName: '기획팀', title: '팀장', rank: '6급', orgSort: 0 })
    // what the server PC set stays: the member cannot change it in 내 정보
    expect(list.find((m) => m.id === b.memberId)!.adminFields).toEqual(expect.arrayContaining(['deptId', 'title']))

    const order = (payload: Record<string, unknown>) => s!.req(s!.admin, { method: 'PUT', url: '/api/admin/org/members/order', payload })
    expect((await order({ deptId: team, ids: [c.memberId, b.memberId] })).statusCode).toBe(200)
    list = await members()
    expect(list.find((m) => m.id === c.memberId)!.orgSort).toBe(1)
    expect(list.find((m) => m.id === b.memberId)!.orgSort).toBe(2)
    expect((await order({ deptId: team, ids: [s.admin.memberId] })).statusCode).toBe(400) // not in that department

    // moved to another department: no place there yet
    const other = await addDept({ name: '운영팀' })
    await set(c.memberId, { deptId: other })
    expect((await members()).find((m) => m.id === c.memberId)).toMatchObject({ deptId: other, orgSort: 0, rank: '8급' })
    // an empty 직급 clears it
    await set(c.memberId, { rank: '' })
    expect((await members()).find((m) => m.id === c.memberId)!.rank).toBeNull()
  })

  it('is for the 최종관리자 (server PC) only: a 서무 and a member get 403', async () => {
    s = await createTestServer()
    const member = await s.join('B')
    const sec = await clerk('서무')
    const team = await addDept({ name: '기획팀' })
    const other = await addDept({ name: '운영팀' })
    const calls: { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; url: string; payload?: Record<string, unknown> }[] = [
      { method: 'POST', url: '/api/admin/departments', payload: { name: 'x' } },
      { method: 'PATCH', url: `/api/admin/departments/${team}`, payload: { name: 'y', headId: member.memberId } },
      { method: 'PUT', url: '/api/admin/departments/order', payload: { parentId: null, ids: [other, team] } },
      { method: 'DELETE', url: `/api/admin/departments/${other}` },
      { method: 'PATCH', url: `/api/admin/org/members/${member.memberId}`, payload: { deptId: team, rank: '7급' } }
    ]
    for (const call of calls) {
      const bySec = await s.req(sec, { ...call, ip: IP })
      expect(bySec.statusCode, `서무 ${call.method} ${call.url}`).toBe(403)
      expect(bySec.json().error.code).toBe('OWNER_ONLY')
      expect((await s.req(member, { ...call, ip: IP })).statusCode, `member ${call.method} ${call.url}`).toBe(403)
    }
    // the order of people within a department is not owner-only: the 서무 sets it, a member cannot
    const dept = (await members()).find((m) => m.id === member.memberId)!.deptId ?? null
    const inDept = async (): Promise<string[]> => (await members()).filter((m) => (m.deptId ?? null) === dept).map((m) => m.id)
    const wanted = [...(await inDept())].reverse()
    const order = { method: 'PUT' as const, url: '/api/admin/org/members/order', payload: { deptId: dept, ids: wanted } }
    expect((await s.req(member, { ...order, ip: IP })).statusCode).toBe(403)
    expect((await s.req(sec, { ...order, ip: IP })).statusCode).toBe(200)
    // and every list of members follows it
    expect(await inDept()).toEqual(wanted)
    // nothing else changed
    expect((await depts()).map((d) => d.name).sort()).toEqual(['기획팀', '운영팀', '행정팀'].sort())
    expect((await members()).find((m) => m.id === member.memberId)!.rank).toBeNull()
    // everybody reads the organisation
    expect((await s.req(member, { method: 'GET', url: '/api/departments', ip: IP })).statusCode).toBe(200)
  })
})
