import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type TestServer } from './helpers'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})

const IP = '192.168.10.20'

describe('member details: the server PC has the last word, the nickname is the member\'s own', () => {
  it('what the admin sets stays; the member cannot change it back, but still changes the rest', async () => {
    s = await createTestServer()
    const kim = await s.join('김주무')
    const me = async (): Promise<Record<string, unknown>> => (await s!.req(kim, { method: 'GET', url: '/api/me', ip: IP })).json().data

    // the member's own entries, as before
    await s.req(kim, { method: 'PATCH', url: '/api/me', ip: IP, payload: { name: '김주무관', title: '주무관', ext: '1234', mobile: '010-0000-0000' } })
    expect(await me()).toMatchObject({ name: '김주무관', title: '주무관', ext: '1234', adminFields: [] })

    // the admin corrects name and extension
    const r = await s.req(s.admin, { method: 'PATCH', url: `/api/admin/members/${kim.memberId}`, payload: { name: '김철수', ext: '5678' } })
    expect(r.statusCode).toBe(200)
    expect(await me()).toMatchObject({ name: '김철수', ext: '5678', title: '주무관' })
    expect(((await me()).adminFields as string[]).sort()).toEqual(['ext', 'name'])
    // everybody sees it
    const list = (await s.req(s.admin, { method: 'GET', url: '/api/members' })).json().data as { id: string; name: string }[]
    expect(list.find((m) => m.id === kim.memberId)?.name).toBe('김철수')

    // the member's screen sends all fields: the admin's stay, the others are taken
    const self = await s.req(kim, { method: 'PATCH', url: '/api/me', ip: IP, payload: { name: '다른이름', ext: '0000', title: '팀장', mobile: null } })
    expect(self.statusCode).toBe(200)
    expect(await me()).toMatchObject({ name: '김철수', ext: '5678', title: '팀장', mobile: null })

    // a change of role or status alone does not take the details over
    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/members/${kim.memberId}`, payload: { role: 'admin' } })
    expect(((await me()).adminFields as string[]).sort()).toEqual(['ext', 'name'])
  })

  it('nickname: only the member sets it; shown to others; cleared with an empty value', async () => {
    s = await createTestServer()
    const kim = await s.join('김주무')
    await s.req(kim, { method: 'PATCH', url: '/api/me', ip: IP, payload: { nickname: '  철수짱  ' } })
    const seen = (await s.req(s.admin, { method: 'GET', url: '/api/members' })).json().data as { id: string; nickname: string | null }[]
    expect(seen.find((m) => m.id === kim.memberId)?.nickname).toBe('철수짱')
    // the admin's edit cannot touch it (the field is not part of what an admin may send)
    await s.req(s.admin, { method: 'PATCH', url: `/api/admin/members/${kim.memberId}`, payload: { nickname: '관리자가정함', title: '주무관' } })
    expect((await s.req(kim, { method: 'GET', url: '/api/me', ip: IP })).json().data).toMatchObject({ nickname: '철수짱', title: '주무관' })
    await s.req(kim, { method: 'PATCH', url: '/api/me', ip: IP, payload: { nickname: '' } })
    expect((await s.req(kim, { method: 'GET', url: '/api/me', ip: IP })).json().data.nickname).toBeNull()
  })
})
