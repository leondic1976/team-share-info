import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type TestServer } from './helpers'
import { canTransition, TASK_TRANSITIONS, type TaskState } from '../../src/shared/schemas/work'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'

describe('task state rules (6.8)', () => {
  it('matches the transition table', () => {
    const A = { assignee: true, requester: false }
    const R = { assignee: false, requester: true }
    expect(canTransition('requested', 'doing', A)).toBe(true)
    expect(canTransition('requested', 'doing', R)).toBe(false)
    expect(canTransition('doing', 'done', A)).toBe(true)
    expect(canTransition('done', 'confirmed', A)).toBe(false)
    expect(canTransition('done', 'confirmed', R)).toBe(true)
    expect(canTransition('done', 'doing', R)).toBe(true)
    expect(canTransition('confirmed', 'doing', A)).toBe(false)
    expect(canTransition('requested', 'confirmed', { assignee: true, requester: true })).toBe(false)
    const states = Object.keys(TASK_TRANSITIONS) as TaskState[]
    for (const s1 of states) expect(canTransition(s1, s1, { assignee: true, requester: true })).toBe(false)
  })
})

describe('tasks (M6-1)', () => {
  it('request -> doing -> done -> confirmed with role checks and visibility', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const c = await s.join('C')
    const t = (await s.req(a, { method: 'POST', url: '/api/tasks', ip: IP, payload: { title: '보고서 검토', assigneeId: b.memberId, dueAt: Date.now() + 86400000, priority: 'high' } })).json().data
    expect(t).toMatchObject({ state: 'requested', requesterName: 'A', assigneeName: 'B' })
    expect((await s.req(b, { method: 'GET', url: '/api/tasks?filter=received', ip: IP })).json().data.map((x: { title: string }) => x.title)).toEqual(['보고서 검토'])
    expect((await s.req(a, { method: 'GET', url: '/api/tasks?filter=requested', ip: IP })).json().data).toHaveLength(1)
    expect((await s.req(c, { method: 'GET', url: `/api/tasks/${t.id}`, ip: IP })).statusCode).toBe(404)
    const patch = (who: typeof a, body: object) => s!.req(who, { method: 'PATCH', url: `/api/tasks/${t.id}`, ip: IP, payload: body })
    expect((await patch(a, { state: 'doing' })).statusCode).toBe(403)
    expect((await patch(b, { state: 'doing' })).statusCode).toBe(200)
    expect((await patch(b, { title: '바꿈' })).statusCode).toBe(403)
    expect((await patch(b, { state: 'done' })).json().data.doneAt).not.toBeNull()
    expect((await patch(b, { state: 'confirmed' })).statusCode).toBe(403)
    expect((await patch(a, { state: 'confirmed' })).json().data.state).toBe('confirmed')
    // comments visible to both, not to C
    await s.req(b, { method: 'POST', url: `/api/comments/task/${t.id}`, ip: IP, payload: { body: '완료했습니다' } })
    expect((await s.req(a, { method: 'GET', url: `/api/comments/task/${t.id}`, ip: IP })).json().data[0]).toMatchObject({ body: '완료했습니다', authorName: 'B' })
    expect((await s.req(c, { method: 'GET', url: `/api/comments/task/${t.id}`, ip: IP })).statusCode).toBe(404)
    // only the requester deletes
    expect((await s.req(b, { method: 'DELETE', url: `/api/tasks/${t.id}`, ip: IP })).statusCode).toBe(403)
    expect((await s.req(a, { method: 'DELETE', url: `/api/tasks/${t.id}`, ip: IP })).statusCode).toBe(200)
  })

  it('filters by due date range (calendar)', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const due = new Date(2026, 11, 10, 18).getTime()
    await s.req(s.admin, { method: 'POST', url: '/api/tasks', payload: { title: '마감', assigneeId: b.memberId, dueAt: due } })
    const r = (await s.req(b, { method: 'GET', url: `/api/tasks?filter=all&dueFrom=${new Date(2026, 11, 1).getTime()}&dueTo=${new Date(2027, 0, 1).getTime()}`, ip: IP })).json().data
    expect(r).toHaveLength(1)
  })
})

describe('boards and polls (M6-2)', () => {
  it('admin creates boards; members post; views are tracked', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    expect((await s.req(b, { method: 'POST', url: '/api/boards', ip: IP, payload: { name: '자유', scope: { type: 'team' } } })).statusCode).toBe(403)
    const board = (await s.req(s.admin, { method: 'POST', url: '/api/boards', payload: { name: '자유게시판', scope: { type: 'team' } } })).json().data
    const post = (await s.req(b, { method: 'POST', url: '/api/posts', ip: IP, payload: { boardId: board.id, title: '점심 메뉴', bodyHtml: '<p>추천</p>' } })).json().data
    expect((await s.req(b, { method: 'POST', url: '/api/posts', ip: IP, payload: { boardId: board.id, title: 'x', pinned: true } })).statusCode).toBe(403)
    let boards = (await s.req(c, { method: 'GET', url: '/api/boards', ip: IP })).json().data
    expect(boards[0]).toMatchObject({ name: '자유게시판', postCount: 1, unreadCount: 1 })
    await s.req(c, { method: 'GET', url: `/api/posts/${post.id}`, ip: IP })
    boards = (await s.req(c, { method: 'GET', url: '/api/boards', ip: IP })).json().data
    expect(boards[0].unreadCount).toBe(0)
    const views = (await s.req(b, { method: 'GET', url: `/api/posts/${post.id}/views`, ip: IP })).json().data
    expect(views.map((v: { name: string }) => v.name)).toEqual(['C'])
    expect((await s.req(c, { method: 'DELETE', url: `/api/posts/${post.id}`, ip: IP })).statusCode).toBe(403)
    expect((await s.req(s.admin, { method: 'DELETE', url: `/api/posts/${post.id}` })).statusCode).toBe(200)
  })

  it('group boards are invisible to non-members', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const c = await s.join('C')
    const g = (await s.req(a, { method: 'POST', url: '/api/groups', ip: IP, payload: { name: 'TF' } })).json().data
    const board = (await s.req(a, { method: 'POST', url: '/api/boards', ip: IP, payload: { name: 'TF 게시판', scope: { type: 'group', groupIds: [g.id] } } })).json().data
    const post = (await s.req(a, { method: 'POST', url: '/api/posts', ip: IP, payload: { boardId: board.id, title: '내부' } })).json().data
    expect((await s.req(c, { method: 'GET', url: '/api/boards', ip: IP })).json().data).toEqual([])
    expect((await s.req(c, { method: 'GET', url: `/api/posts/${post.id}`, ip: IP })).statusCode).toBe(404)
  })

  it('polls: single vs multiple, anonymous, closing', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const board = (await s.req(s.admin, { method: 'POST', url: '/api/boards', payload: { name: '설문', scope: { type: 'team' } } })).json().data
    const single = (await s.req(s.admin, { method: 'POST', url: '/api/posts', payload: { boardId: board.id, title: '회식 날짜', poll: { question: '언제?', options: ['금', '목'] } } })).json().data
    let p = (await s.req(b, { method: 'GET', url: `/api/posts/${single.id}`, ip: IP })).json().data.poll
    expect((await s.req(b, { method: 'POST', url: `/api/posts/${single.id}/vote`, ip: IP, payload: { optionIds: p.options.map((o: { id: string }) => o.id) } })).statusCode).toBe(400)
    await s.req(b, { method: 'POST', url: `/api/posts/${single.id}/vote`, ip: IP, payload: { optionIds: [p.options[0].id] } })
    await s.req(c, { method: 'POST', url: `/api/posts/${single.id}/vote`, ip: IP, payload: { optionIds: [p.options[0].id] } })
    await s.req(c, { method: 'POST', url: `/api/posts/${single.id}/vote`, ip: IP, payload: { optionIds: [p.options[1].id] } })
    p = (await s.req(s.admin, { method: 'GET', url: `/api/posts/${single.id}` })).json().data.poll
    expect(p.options.map((o: { votes: number; voters: string[] }) => [o.votes, o.voters])).toEqual([
      [1, ['B']],
      [1, ['C']]
    ])
    expect(p.totalVoters).toBe(2)
    const anon = (await s.req(s.admin, { method: 'POST', url: '/api/posts', payload: { boardId: board.id, title: '익명', poll: { question: '만족?', options: ['예', '아니오', '보통'], multiple: true, anonymous: true } } })).json().data
    let ap = (await s.req(b, { method: 'GET', url: `/api/posts/${anon.id}`, ip: IP })).json().data.poll
    await s.req(b, { method: 'POST', url: `/api/posts/${anon.id}/vote`, ip: IP, payload: { optionIds: [ap.options[0].id, ap.options[2].id] } })
    ap = (await s.req(s.admin, { method: 'GET', url: `/api/posts/${anon.id}` })).json().data.poll
    expect(ap.options.map((o: { votes: number }) => o.votes)).toEqual([1, 0, 1])
    expect(ap.options[0].voters).toBeUndefined()
    expect((await s.req(b, { method: 'POST', url: `/api/posts/${anon.id}/close-poll`, ip: IP })).statusCode).toBe(403)
    await s.req(s.admin, { method: 'POST', url: `/api/posts/${anon.id}/close-poll` })
    expect((await s.req(c, { method: 'POST', url: `/api/posts/${anon.id}/vote`, ip: IP, payload: { optionIds: [ap.options[1].id] } })).statusCode).toBe(400)
  })
})

describe('contacts and departments (M6-3)', () => {
  it('creates, searches, imports in bulk, enforces owner edits and scope', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    await s.req(b, { method: 'POST', url: '/api/contacts', ip: IP, payload: { org: '○○구청', name: '김주무관', phone: '02-123-4567' } })
    const bulk = (await s.req(b, { method: 'POST', url: '/api/contacts/bulk', ip: IP, payload: { rows: [{ org: 'A사', name: '이대리' }, { org: 'B사' }], scope: { type: 'members', memberIds: [b.memberId] } } })).json().data
    expect(bulk).toMatchObject({ added: 1 })
    expect(bulk.errors[0]).toContain('2행')
    const forC = (await s.req(c, { method: 'GET', url: '/api/contacts', ip: IP })).json().data
    expect(forC.map((x: { name: string }) => x.name)).toEqual(['김주무관'])
    expect((await s.req(b, { method: 'GET', url: '/api/contacts?q=4567', ip: IP })).json().data).toHaveLength(1)
    expect((await s.req(c, { method: 'PATCH', url: `/api/contacts/${forC[0].id}`, ip: IP, payload: { name: 'x' } })).statusCode).toBe(403)
  })

  it('admins manage departments; members can set their own department', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const d = (await s.req(s.admin, { method: 'POST', url: '/api/admin/departments', payload: { name: '기획팀' } })).json().data
    expect((await s.req(b, { method: 'POST', url: '/api/admin/departments', ip: IP, payload: { name: 'x' } })).statusCode).toBe(403)
    await s.req(b, { method: 'PATCH', url: '/api/me', ip: IP, payload: { deptId: d.id, mobile: '010-1111-2222', duty: '예산' } })
    const me = (await s.req(b, { method: 'GET', url: '/api/me', ip: IP })).json().data
    expect(me).toMatchObject({ deptName: '기획팀', mobile: '010-1111-2222', duty: '예산' })
    expect((await s.req(s.admin, { method: 'DELETE', url: `/api/admin/departments/${d.id}` })).statusCode).toBe(400)
  })
})
