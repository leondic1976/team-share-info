import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type Cred, type TestServer } from './helpers'
import type { DepartmentDto } from '../../src/shared/schemas/org'
import type { JoinRequestDto, MemberDto } from '../../src/shared/schemas/auth'
import { DEPT_ENTERED_PER_DAY, DEPT_MAX_DEPTH, deptPath } from '../../src/shared/org'

const IP = '192.168.10.20'
let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})

const depts = async (): Promise<DepartmentDto[]> => (await s!.req(s!.admin, { method: 'GET', url: '/api/departments' })).json().data
const members = async (): Promise<MemberDto[]> => (await s!.req(s!.admin, { method: 'GET', url: '/api/members' })).json().data
const member = async (id: string): Promise<MemberDto> => (await members()).find((m) => m.id === id)!
const addDept = async (name: string, parentId: string | null = null): Promise<string> => {
  const r = await s!.req(s!.admin, { method: 'POST', url: '/api/admin/departments', payload: { name, parentId } })
  expect(r.statusCode).toBe(200)
  return r.json().data.id
}
const setDept = (c: Cred, payload: Record<string, unknown>) => s!.req(c, { method: 'PUT', url: '/api/me/dept', ip: IP, payload })
const byPath = async (path: string[]): Promise<DepartmentDto | undefined> => {
  const all = await depts()
  return all.find((d) => deptPath(all, d.id).join('|') === path.join('|'))
}

describe('affiliation (소속): a path through the department tree', () => {
  it('a member picks an existing department or types the path; missing levels are created and marked', async () => {
    s = await createTestServer()
    const kim = await s.join('김주무')
    const hq = await addDept('행정지원본부')
    const dept = await addDept('총무과', hq)

    // an existing department by id
    let r = await setDept(kim, { deptId: dept })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({ created: 0, member: { deptId: dept, deptName: '총무과', deptPath: ['행정지원본부', '총무과'] } })
    expect((await setDept(kim, { deptId: 'nope' })).statusCode).toBe(404)

    // typed: the existing levels are matched whatever the case and spacing, the rest is made
    r = await setDept(kim, { path: [' 행정 지원본부 ', '총무과', '서무팀', '문서 파트'] })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.created).toBe(2)
    const me = await member(kim.memberId)
    expect(me.deptPath).toEqual(['행정지원본부', '총무과', '서무팀', '문서 파트'])
    expect(me.deptName).toBe('문서 파트')
    expect(me.adminFields).toEqual([])
    const all = await depts()
    expect(all.filter((d) => d.name === '행정지원본부')).toHaveLength(1)
    const team = all.find((d) => d.name === '서무팀')!
    const part = all.find((d) => d.name === '문서 파트')!
    expect(team).toMatchObject({ parentId: dept, enteredBy: kim.memberId })
    expect(team.enteredAt).toBeGreaterThan(0)
    expect(part).toMatchObject({ parentId: team.id, enteredBy: kim.memberId })
    expect(all.find((d) => d.id === dept)).toMatchObject({ enteredBy: null, enteredAt: null })
    // /api/me carries the path too
    expect((await s.req(kim, { method: 'GET', url: '/api/me', ip: IP })).json().data.deptPath).toEqual(me.deptPath)

    // typing a path that exists creates nothing
    r = await setDept(kim, { path: ['행정지원본부', '총무과'] })
    expect(r.json().data).toMatchObject({ created: 0, member: { deptId: dept } })
    // none
    r = await setDept(kim, { deptId: null })
    expect(r.json().data.member).toMatchObject({ deptId: null, deptName: null, deptPath: [] })

    // the same name under another parent is another department
    r = await setDept(kim, { path: ['감사실', '서무팀'] })
    expect(r.json().data.created).toBe(2)
    expect((await depts()).filter((d) => d.name === '서무팀')).toHaveLength(2)
  })

  it('refuses bad names, too many levels and more new departments than the daily limit', async () => {
    s = await createTestServer()
    const kim = await s.join('김주무')
    const before = (await depts()).length
    expect((await setDept(kim, { path: [] })).statusCode).toBe(400)
    expect((await setDept(kim, { path: ['과', ' '] })).statusCode).toBe(400)
    expect((await setDept(kim, { path: ['가'.repeat(41)] })).statusCode).toBe(400)
    expect((await setDept(kim, { path: ['과\u0007'] })).statusCode).toBe(400)
    expect((await setDept(kim, { path: ['과 > 팀'] })).statusCode).toBe(400)
    expect((await setDept(kim, { path: ['과'], deptId: null })).statusCode).toBe(400)
    const deep = Array.from({ length: DEPT_MAX_DEPTH + 1 }, (_, i) => `단계${i + 1}`)
    expect((await setDept(kim, { path: deep })).statusCode).toBe(400)
    expect((await depts()).length).toBe(before)

    // exactly the depth cap and the daily limit (both 6) pass ...
    expect(DEPT_ENTERED_PER_DAY).toBe(DEPT_MAX_DEPTH)
    expect((await setDept(kim, { path: deep.slice(0, DEPT_MAX_DEPTH) })).statusCode).toBe(200)
    expect((await depts()).length).toBe(before + DEPT_MAX_DEPTH)
    // ... one more new department on the same day does not, and nothing is half-made
    const over = await setDept(kim, { path: ['단계1', '새팀'] })
    expect(over.statusCode).toBe(400)
    expect(over.json().error.message).toContain('하루')
    expect((await depts()).length).toBe(before + DEPT_MAX_DEPTH)
    // removing them on the server PC does not give the day's allowance back
    const leaf = (await byPath(deep.slice(0, DEPT_MAX_DEPTH)))!
    await setDept(kim, { deptId: null })
    expect((await s.req(s.admin, { method: 'DELETE', url: `/api/admin/departments/${leaf.id}` })).statusCode).toBe(200)
    expect((await setDept(kim, { path: ['단계1', '새팀'] })).statusCode).toBe(400)
    // existing departments can still be chosen, by id or by typing, and another person has an own allowance
    expect((await setDept(kim, { path: ['단계1', '단계2'] })).statusCode).toBe(200)
    const lee = await s.join('이주무', { winUser: 'lee', ip: '192.168.10.21' })
    expect((await setDept(lee, { path: ['단계1', '새팀'] })).statusCode).toBe(200)
  })

  it('what the server PC set stays: the member cannot change the affiliation', async () => {
    s = await createTestServer()
    const kim = await s.join('김주무')
    const team = await addDept('기획팀')
    expect((await s.req(s.admin, { method: 'PATCH', url: `/api/admin/org/members/${kim.memberId}`, payload: { deptId: team } })).statusCode).toBe(200)
    for (const payload of [{ deptId: null }, { path: ['다른과'] }]) {
      const r = await setDept(kim, payload)
      expect(r.statusCode).toBe(403)
      expect(r.json().error.message).toContain('서버 PC에서 정한 항목')
    }
    expect(await member(kim.memberId)).toMatchObject({ deptId: team, deptPath: ['기획팀'] })
    expect((await depts()).some((d) => d.name === '다른과')).toBe(false)
    // the 최종관리자 typing an own affiliation on the server PC makes plain departments: no mark
    expect((await setDept(s.admin, { path: ['본부', '운영과'] })).statusCode).toBe(200)
    expect((await depts()).filter((d) => ['본부', '운영과'].includes(d.name)).map((d) => d.enteredBy)).toEqual([null, null])
    // needs an approved PC
    expect((await s.req(null, { method: 'PUT', url: '/api/me/dept', ip: IP, payload: { deptId: null } })).statusCode).toBe(401)
  })

  it('the join screen takes the affiliation as a path; it is resolved when the request is approved', async () => {
    s = await createTestServer()
    const hq = await addDept('행정지원본부')
    const before = (await depts()).length
    const ask = await s.req(null, { method: 'POST', url: '/api/join', ip: IP, payload: { name: '박신규', deptName: '서무팀', deptPath: ['행정지원본부', '총무과', '서무팀'], pcName: 'PC-P', winUser: 'park', appVersion: '0.1.0' } })
    expect(ask.statusCode).toBe(200)
    // nothing is created for a PC that is not approved
    expect((await depts()).length).toBe(before)
    const list = (await s.req(s.admin, { method: 'GET', url: '/api/admin/join-requests' })).json().data as JoinRequestDto[]
    expect(list[0]).toMatchObject({ name: '박신규', deptName: '행정지원본부 > 총무과 > 서무팀', deptPath: ['행정지원본부', '총무과', '서무팀'] })
    expect((await s.req(s.admin, { method: 'PATCH', url: `/api/admin/join-requests/${list[0].id}`, payload: { action: 'approve' } })).statusCode).toBe(200)
    const park = (await members()).find((m) => m.name === '박신규')!
    expect(park.deptPath).toEqual(['행정지원본부', '총무과', '서무팀'])
    expect(park.adminFields).toEqual([])
    const all = await depts()
    expect(all.length).toBe(before + 2)
    expect(all.find((d) => d.name === '총무과')).toMatchObject({ parentId: hq, enteredBy: park.id })
    expect(all.find((d) => d.name === '서무팀')).toMatchObject({ enteredBy: park.id })

    // an older client sends one name: a one-level path (matched at the top, made there when missing)
    const old = await s.join('최옛날', { winUser: 'choi', ip: '192.168.10.22', deptName: '행정지원본부' })
    expect(await member(old.memberId)).toMatchObject({ deptId: hq, deptName: '행정지원본부', deptPath: ['행정지원본부'] })
    const old2 = await s.join('정옛날', { winUser: 'jung', ip: '192.168.10.23', deptName: '민원실' })
    expect((await member(old2.memberId)).deptPath).toEqual(['민원실'])
    expect((await depts()).find((d) => d.name === '민원실')).toMatchObject({ parentId: null, enteredBy: old2.memberId })
    // no affiliation at all
    const none = await s.join('무소속', { winUser: 'none', ip: '192.168.10.24', deptName: '' })
    expect(await member(none.memberId)).toMatchObject({ deptId: null, deptPath: [] })
    // the helper's path form
    const viaPath = await s.join('한경로', { winUser: 'han', ip: '192.168.10.25', deptPath: ['행정지원본부', '총무과'] })
    expect((await member(viaPath.memberId)).deptPath).toEqual(['행정지원본부', '총무과'])
    // the organisation is not shown to a PC that is not approved
    const hello = (await s.req(null, { method: 'GET', url: '/api/hello', ip: IP })).body
    expect(hello).not.toContain('행정지원본부')
    expect((await s.req(null, { method: 'GET', url: '/api/departments', ip: IP })).statusCode).toBe(401)
  })

  it('the 최종관리자 tidies what members typed: confirm, rename or move clears the mark', async () => {
    s = await createTestServer()
    const kim = await s.join('김주무')
    await setDept(kim, { path: ['본부', '과', '팀'] })
    const find = async (name: string): Promise<DepartmentDto> => (await depts()).find((d) => d.name === name)!
    const patch = (id: string, payload: Record<string, unknown>) => s!.req(s!.admin, { method: 'PATCH', url: `/api/admin/departments/${id}`, payload })
    const [hq, dept, team] = [await find('본부'), await find('과'), await find('팀')]
    expect([hq, dept, team].every((d) => d.enteredBy === kim.memberId)).toBe(true)
    // other details do not clear it
    await patch(hq.id, { phone: '1234' })
    expect((await find('본부')).enteredBy).toBe(kim.memberId)
    await patch(hq.id, { confirmed: true })
    expect(await find('본부')).toMatchObject({ enteredBy: null, enteredAt: null, phone: '1234' })
    await patch(dept.id, { name: '총무과' })
    expect((await find('총무과')).enteredBy).toBeNull()
    await patch(team.id, { parentId: hq.id })
    expect(await find('팀')).toMatchObject({ enteredBy: null, parentId: hq.id })
    // the member's path follows at once
    expect((await member(kim.memberId)).deptPath).toEqual(['본부', '팀'])
  })

  it('keeps the tree within the depth cap when a department is added or moved', async () => {
    s = await createTestServer()
    let parent: string | null = null
    const chain: string[] = []
    for (let i = 1; i <= DEPT_MAX_DEPTH; i++) {
      parent = await addDept(`L${i}`, parent)
      chain.push(parent)
    }
    const post = await s.req(s.admin, { method: 'POST', url: '/api/admin/departments', payload: { name: 'L7', parentId: parent } })
    expect(post.statusCode).toBe(400)
    // a department with two levels below it cannot go under the fourth level
    const a = await addDept('A')
    const a1 = await addDept('A1', a)
    await addDept('A11', a1)
    const move = (parentId: string) => s!.req(s!.admin, { method: 'PATCH', url: `/api/admin/departments/${a}`, payload: { parentId } })
    expect((await move(chain[3])).statusCode).toBe(400)
    expect((await move(chain[2])).statusCode).toBe(200)
  })

  it('merges a department into another: members and departments below move, then it is gone', async () => {
    s = await createTestServer()
    const kim = await s.join('김주무')
    const lee = await s.join('이주무', { winUser: 'lee', ip: '192.168.10.21' })
    const hq = await addDept('본부')
    const real = await addDept('총무과', hq)
    const realTeam = await addDept('서무팀', real)
    // kim typed the department a little differently, at the top
    await setDept(kim, { path: ['총무 1과', '문서팀'] })
    await setDept(lee, { path: ['총무 1과'] })
    const typed = (await depts()).find((d) => d.name === '총무 1과')!
    const docs = (await depts()).find((d) => d.name === '문서팀')!
    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/departments/${typed.id}`, payload: { phone: '02-1', headId: lee.memberId } })
    const merge = (id: string, targetId: string, cred: Cred = s!.admin) => s!.req(cred, { method: 'POST', url: `/api/admin/departments/${id}/merge`, ip: cred === s!.admin ? undefined : IP, payload: { targetId } })

    expect((await merge(typed.id, typed.id)).statusCode).toBe(400)
    expect((await merge(typed.id, 'nope')).statusCode).toBe(400)
    expect((await merge('nope', real)).statusCode).toBe(404)
    expect((await merge(typed.id, docs.id)).statusCode).toBe(400) // into its own child
    // owner only: a 서무 and a member get 403
    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/members/${lee.memberId}`, payload: { role: 'admin' } })
    const bySec = await merge(typed.id, real, lee)
    expect(bySec.statusCode).toBe(403)
    expect(bySec.json().error.code).toBe('OWNER_ONLY')
    expect((await merge(typed.id, real, kim)).statusCode).toBe(403)

    // a department below with a name the target already has: refused, nothing moved
    const clash = await addDept('서무팀', typed.id)
    expect((await merge(typed.id, real)).statusCode).toBe(400)
    expect((await member(lee.memberId)).deptId).toBe(typed.id)
    expect((await s.req(s.admin, { method: 'DELETE', url: `/api/admin/departments/${clash}` })).statusCode).toBe(200)

    const r = await merge(typed.id, real)
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({ id: real, members: 1, departments: 1 })
    const all = await depts()
    expect(all.some((d) => d.id === typed.id)).toBe(false)
    expect(all.find((d) => d.id === docs.id)!.parentId).toBe(real)
    // after the departments the target already had
    expect(all.find((d) => d.id === docs.id)!.sort).toBeGreaterThan(all.find((d) => d.id === realTeam)!.sort)
    // what the target had not set comes over
    expect(all.find((d) => d.id === real)).toMatchObject({ phone: '02-1', headId: lee.memberId })
    expect(await member(lee.memberId)).toMatchObject({ deptId: real, deptPath: ['본부', '총무과'], orgSort: 0 })
    expect((await member(kim.memberId)).deptPath).toEqual(['본부', '총무과', '문서팀'])
    const log = s.ctx.db.get<{ detail: string }>(`SELECT detail FROM activity_logs WHERE action = 'department.merge'`)
    expect(JSON.parse(log!.detail)).toMatchObject({ from: '총무 1과', into: '총무과', members: 1, departments: 1 })
  })

  it('a department is not deleted when one below it would collide with a name one level up', async () => {
    s = await createTestServer()
    const top = await addDept('과')
    await addDept('팀', top)
    const mid = await addDept('중간', top)
    await addDept('팀', mid)
    expect((await s.req(s.admin, { method: 'DELETE', url: `/api/admin/departments/${mid}` })).statusCode).toBe(400)
    expect((await depts()).some((d) => d.id === mid)).toBe(true)
  })

  it('search finds people by a department above theirs and shows the full affiliation', async () => {
    s = await createTestServer()
    const kim = await s.join('김주무')
    await setDept(kim, { path: ['행정지원본부', '총무과', '서무팀'] })
    const r = await s.req(s.admin, { method: 'GET', url: `/api/search?q=${encodeURIComponent('총무과')}` })
    expect(r.statusCode).toBe(200)
    const hit = (r.json().data as { type: string; title: string; snippet: string }[]).find((x) => x.type === 'member' && x.title === '김주무')
    expect(hit?.snippet).toContain('행정지원본부 > 총무과 > 서무팀')
  })
})
