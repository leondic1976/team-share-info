import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type TestServer, type Cred } from './helpers'
import { importMealPeople, keyedUnregId } from '../../src/server/unregistered'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'
type Body = Record<string, unknown>
const call = async (who: Cred, method: string, url: string, payload?: Body) => {
  const r = await s!.req(who, { method: method as 'GET', url, ip: who === s!.admin ? undefined : IP, payload })
  return { status: r.statusCode, data: r.json().data, error: r.json().error?.message as string | undefined }
}
const mealSettings = (extra: Body = {}) => ({ kind: 'meal', v: 1, meals: { lunch: { on: true, cutoff: '10:30' }, dinner: { on: true, cutoff: '15:30' } }, weekend: false, holidays: true, stewards: [], clerks: [], ahead: 7, notice: '', ...extra })

describe('미등록 인원: one list for the whole program (지시 134)', () => {
  it('the server PC and the 서무 keep it; everybody reads it; merge, undo, delete', async () => {
    s = await createTestServer()
    const b = await s.join('팀원')
    const c = await s.join('김가입')
    // a member cannot change it
    expect((await call(b, 'POST', '/api/unregistered', { name: '홍미등' })).status).toBe(403)
    const add = await call(s.admin, 'POST', '/api/unregistered', { name: '  홍   미등 ', dept: '현장대응단', title: '주무관', memo: '운전' })
    expect(add.status).toBe(200)
    expect(add.data).toMatchObject({ name: '홍 미등', dept: '현장대응단', title: '주무관', memo: '운전', mergedInto: null, deleted: false, createdByName: '관리자' })
    expect(add.data.id).toMatch(/^x:[a-z0-9]{6,24}$/)
    expect((await call(s.admin, 'POST', '/api/unregistered', { name: '   ' })).status).toBe(400)
    // everybody reads it
    expect((await call(b, 'GET', '/api/unregistered')).data.map((p: { name: string }) => p.name)).toEqual(['홍 미등'])
    const id = add.data.id as string
    expect((await call(b, 'PATCH', `/api/unregistered/${id}`, { title: '팀장' })).status).toBe(403)
    expect((await call(s.admin, 'PATCH', `/api/unregistered/${id}`, { title: '팀장' })).data).toMatchObject({ title: '팀장', dept: '현장대응단' })
    // a 서무 (admin who is not the server PC) may too
    await call(s.admin, 'PATCH', `/api/admin/members/${b.memberId}`, { role: 'admin' })
    expect((await call(b, 'PATCH', `/api/unregistered/${id}`, { memo: '대형 운전' })).status).toBe(200)
    // merged into the member who joined; undone; then deleted (kept, marked)
    expect((await call(s.admin, 'PUT', `/api/unregistered/${id}/merge`, { memberId: 'nobody' })).status).toBe(404)
    expect((await call(s.admin, 'PUT', `/api/unregistered/${id}/merge`, { memberId: c.memberId })).data).toMatchObject({ mergedInto: c.memberId, mergedIntoName: '김가입' })
    expect((await call(s.admin, 'PUT', `/api/unregistered/${id}/merge`, { memberId: null })).data.mergedInto).toBeNull()
    expect((await call(s.admin, 'DELETE', `/api/unregistered/${id}`)).status).toBe(200)
    expect((await call(b, 'GET', '/api/unregistered')).data[0]).toMatchObject({ id, deleted: true })
    expect((await call(s.admin, 'PATCH', `/api/unregistered/${id}`, { name: 'x' })).status).toBe(400)
  })

  it("takes over the 식사 신청 plugin's own list with the same ids, once, without overwriting later changes", async () => {
    s = await createTestServer()
    const st = await s.join('식수서무')
    const joined = await s.join('박가입')
    const t = Date.now() - 1000
    const shared = mealSettings({
      stewards: [st.memberId],
      people: {
        'x:aaaaaa01': { name: '갑미등', dept: '행정팀', title: '', memo: '', at: t },
        'x:aaaaaa02': { name: '을미등', dept: '', title: '', memo: '', at: t, gone: true },
        'x:aaaaaa03': { name: '박가입', dept: '', title: '', memo: '', at: t, as: joined.memberId },
        'bad-id': { name: '무시', at: t }
      }
    })
    const room = (await call(s.admin, 'POST', '/api/plugins/meal/rooms', { title: '식사 신청', scope: { type: 'team', groupIds: [], memberIds: [] }, shared })).data
    // a 식수서무 registered one in their own entry (the newest record wins)
    await call(st, 'PUT', `/api/plugins/meal/rooms/${room.id}/entry`, { value: { v: 1, days: {}, people: { 'x:aaaaaa04': { name: '병미등', dept: '119', title: '', memo: '', at: Date.now() } } } })
    let list = (await call(st, 'GET', '/api/unregistered')).data as { id: string; name: string; deleted: boolean; mergedInto: string | null; createdBy: string }[]
    expect(list.map((p) => p.id).sort()).toEqual(['x:aaaaaa01', 'x:aaaaaa02', 'x:aaaaaa03', 'x:aaaaaa04'])
    expect(list.find((p) => p.id === 'x:aaaaaa02')!.deleted).toBe(true)
    expect(list.find((p) => p.id === 'x:aaaaaa03')!.mergedInto).toBe(joined.memberId)
    expect(list.find((p) => p.id === 'x:aaaaaa04')!.createdBy).toBe(st.memberId)
    expect(list.find((p) => p.id === 'x:aaaaaa01')!.createdBy).toBe(s.admin.memberId)
    // safe again: nothing new, and what the 서무 changed since stays
    await call(s.admin, 'PATCH', '/api/unregistered/x:aaaaaa01', { name: '갑고침' })
    expect(importMealPeople(s.ctx.db)).toBe(0)
    await call(st, 'PUT', `/api/plugins/meal/rooms/${room.id}/entry`, { value: { v: 1, days: {} } })
    list = (await call(st, 'GET', '/api/unregistered')).data
    expect(list.find((p) => p.id === 'x:aaaaaa01')!.name).toBe('갑고침')
    expect(list).toHaveLength(4)
  })

  it('긴급구조지휘대 uses the list: 미등록 people are placed, follow a merge, and the old 임시 인원 move over', async () => {
    s = await createTestServer()
    const a = await s.join('김지휘')
    const joined = await s.join('최가입')
    const add = async (name: string) => (await call(s!.admin, 'POST', '/api/unregistered', { name, dept: '현장', title: '주무관' })).data.id as string
    const u1 = await add('미등록하나')
    const u2 = await add('최가입')
    let st = (await call(a, 'GET', '/api/command')).data
    expect(st.guests).toEqual({ label: '미등록 인원', where: '관리 → 구성원·PC → 미등록 인원' })
    expect(st.people.find((p: { id: string }) => p.id === `g:${u1}`)).toMatchObject({ name: '미등록하나', dept: '현장', title: '주무관', temp: true, source: '미등록 인원' })
    // the command post keeps no list of its own any more
    expect((await call(s.admin, 'POST', '/api/command/people', { name: 'x' })).status).toBe(404)

    const team = (await call(s.admin, 'POST', '/api/command/teams', { name: 'A조' })).data.id
    const mode = st.modes[0].id
    const role = (await call(s.admin, 'POST', '/api/command/roles', { modeId: mode, name: '운전' })).data.id
    expect((await call(s.admin, 'PUT', `/api/command/teams/${team}/members`, { personIds: [a.memberId, `g:${u1}`, `g:${u2}`] })).status).toBe(200)
    expect((await call(s.admin, 'PUT', '/api/command/assignments', { modeId: mode, teamId: team, roleId: role, personIds: [`g:${u2}`] })).status).toBe(200)
    expect((await call(s.admin, 'PUT', `/api/command/teams/${team}/members`, { personIds: ['g:x:nobody00'] })).status).toBe(400)

    // merged in 관리: the places become the member's
    await call(s.admin, 'PUT', `/api/unregistered/${u2}/merge`, { memberId: joined.memberId })
    st = (await call(a, 'GET', '/api/command')).data
    expect(st.teams[0].members).toEqual([a.memberId, `g:${u1}`, joined.memberId])
    expect(st.assignments).toContainEqual({ roleId: role, teamId: team, personId: joined.memberId })
    expect(st.people.some((p: { id: string }) => p.id === `g:${u2}`)).toBe(false)

    // deleted in 관리: still shown where placed (marked), not offered again, taken out by hand
    await call(s.admin, 'DELETE', `/api/unregistered/${u1}`)
    st = (await call(a, 'GET', '/api/command')).data
    expect(st.people.find((p: { id: string }) => p.id === `g:${u1}`)).toMatchObject({ name: '미등록하나', left: 'removed' })
    // the 조 can still be saved with them in it, but nobody can add them anew
    expect((await call(s.admin, 'PUT', `/api/command/teams/${team}/members`, { personIds: [a.memberId, `g:${u1}`, joined.memberId] })).status).toBe(200)
    expect((await call(s.admin, 'POST', '/api/command/exceptions', { personId: `g:${u1}`, fromDate: '2020-01-01' })).status).toBe(404)
    expect((await call(s.admin, 'DELETE', `/api/command/people/${encodeURIComponent(`g:${u1}`)}`)).status).toBe(200)
    st = (await call(a, 'GET', '/api/command')).data
    expect(st.teams[0].members).toEqual([a.memberId, joined.memberId])
    expect(st.people.some((p: { id: string }) => p.id === `g:${u1}`)).toBe(false)

    // the command post's 임시 인원 of before (v1.11.0 ~ 1.12.x) move to the list with their places
    const cdb = s.command.db
    const old = '3f2a9c1e-7b4d-4e21-9a0b-55cd12ef3401'
    cdb.run('INSERT INTO cmd_people (id, name, title, memo, created_at) VALUES (?, ?, ?, ?, ?)', [old, '이예전', '소방위', '파견', 1])
    cdb.run('INSERT INTO cmd_team_members (person_id, team_id, sort) VALUES (?, ?, ?)', [`x:${old}`, team, 9])
    const common = (await call(s.admin, 'POST', '/api/command/common', { name: '운반', perTeam: false })).data.id
    cdb.run("INSERT INTO cmd_common_assign (common_id, team_id, person_id) VALUES (?, '', ?)", [common, `x:${old}`])
    st = (await call(a, 'GET', '/api/command')).data
    const moved = keyedUnregId(old)
    expect(moved).toBe('x:3f2a9c1e7b4d4e219a0b55cd')
    expect(cdb.all('SELECT id FROM cmd_people')).toEqual([])
    expect(st.teams[0].members).toContain(`g:${moved}`)
    expect(st.common.find((c: { id: string }) => c.id === common).assign).toEqual([{ teamId: '', personId: `g:${moved}` }])
    const listed = (await call(a, 'GET', '/api/unregistered')).data.find((p: { id: string }) => p.id === moved)
    expect(listed).toMatchObject({ name: '이예전', title: '소방위', memo: '파견', deleted: false })
    // doing it again registers nobody twice
    cdb.run('INSERT INTO cmd_people (id, name, title, memo, created_at) VALUES (?, ?, ?, ?, ?)', [old, '이예전', '소방위', '파견', 1])
    await call(a, 'GET', '/api/command')
    expect((await call(a, 'GET', '/api/unregistered')).data.filter((p: { name: string }) => p.name === '이예전')).toHaveLength(1)
    expect(cdb.all('SELECT id FROM cmd_people')).toEqual([])
  })
})
