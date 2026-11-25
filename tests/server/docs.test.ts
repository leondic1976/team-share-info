import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type TestServer } from './helpers'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'
const team = { type: 'team', groupIds: [], memberIds: [] }

describe('docs (M6-4..6)', () => {
  it('must-read: read status per member, re-read after edits, reminder targets unread', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const id = (await s.req(s.admin, { method: 'POST', url: '/api/docs', payload: { kind: 'mustread', title: '보안 수칙', bodyHtml: '<p>화면 잠금</p>', scope: team } })).json().data.id
    expect((await s.req(b, { method: 'GET', url: '/api/docs?unread=1', ip: IP })).json().data.map((d: { title: string }) => d.title)).toEqual(['보안 수칙'])
    await s.req(b, { method: 'POST', url: `/api/docs/${id}/read`, ip: IP })
    expect((await s.req(b, { method: 'GET', url: '/api/docs?unread=1', ip: IP })).json().data).toEqual([])
    const reads = (await s.req(s.admin, { method: 'GET', url: `/api/docs/${id}/reads` })).json().data
    expect(reads.find((r: { name: string }) => r.name === 'B').readAt).not.toBeNull()
    expect(reads.find((r: { name: string }) => r.name === 'C').readAt).toBeNull()
    expect((await s.req(s.admin, { method: 'POST', url: `/api/docs/${id}/remind` })).json().data.count).toBe(1)
    // only the author edits must-read notes; editing resets reads
    expect((await s.req(c, { method: 'PATCH', url: `/api/docs/${id}`, ip: IP, payload: { bodyHtml: '<p>x</p>' } })).statusCode).toBe(403)
    await s.req(s.admin, { method: 'PATCH', url: `/api/docs/${id}`, payload: { bodyHtml: '<p>화면 잠금 + USB 금지</p>' } })
    expect((await s.req(b, { method: 'GET', url: '/api/docs?unread=1', ip: IP })).json().data).toHaveLength(1)
    const list = (await s.req(s.admin, { method: 'GET', url: '/api/docs?kind=mustread' })).json().data
    expect(list[0].readStats).toEqual({ read: 0, total: 2 })
    // who wrote and who last changed it, by id (for the 서무 mark next to the names)
    expect(list[0]).toMatchObject({ authorId: s.admin.memberId, updatedById: s.admin.memberId })
  })

  it('manuals are team wikis with revision history and restore', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const id = (await s.req(s.admin, { method: 'POST', url: '/api/docs', payload: { kind: 'manual', title: '출장 처리', bodyHtml: '<p>v1</p>', scope: team } })).json().data.id
    const child = (await s.req(b, { method: 'POST', url: '/api/docs', ip: IP, payload: { kind: 'manual', parentId: id, title: '여비 정산', scope: team } })).json().data.id
    await s.req(b, { method: 'PATCH', url: `/api/docs/${id}`, ip: IP, payload: { bodyHtml: '<p>v2</p>' } })
    await s.req(b, { method: 'PATCH', url: `/api/docs/${id}`, ip: IP, payload: { bodyHtml: '<p>v3</p>' } })
    const revs = (await s.req(s.admin, { method: 'GET', url: `/api/docs/${id}/revisions` })).json().data
    expect(revs.map((r: { bodyHtml: string }) => r.bodyHtml)).toEqual(['<p>v2</p>', '<p>v1</p>'])
    await s.req(s.admin, { method: 'POST', url: `/api/docs/${id}/restore`, payload: { revisionId: revs[1].id } })
    expect((await s.req(b, { method: 'GET', url: `/api/docs/${id}`, ip: IP })).json().data).toMatchObject({ bodyHtml: '<p>v1</p>', revisionCount: 3 })
    expect((await s.req(b, { method: 'DELETE', url: `/api/docs/${id}`, ip: IP })).statusCode).toBe(403)
    expect((await s.req(s.admin, { method: 'DELETE', url: `/api/docs/${id}` })).statusCode).toBe(400)
    expect((await s.req(b, { method: 'DELETE', url: `/api/docs/${child}`, ip: IP })).statusCode).toBe(200)
  })

  it('stale flag after 180 days without review, cleared by review', async () => {
    s = await createTestServer()
    const id = (await s.req(s.admin, { method: 'POST', url: '/api/docs', payload: { kind: 'faq', title: 'Q', scope: team } })).json().data.id
    s.ctx.db.run('UPDATE docs SET reviewed_at = ?, updated_at = ? WHERE id = ?', [Date.now() - 200 * 86400000, Date.now() - 200 * 86400000, id])
    expect((await s.req(s.admin, { method: 'GET', url: `/api/docs/${id}` })).json().data.stale).toBe(true)
    await s.req(s.admin, { method: 'POST', url: `/api/docs/${id}/review` })
    expect((await s.req(s.admin, { method: 'GET', url: `/api/docs/${id}` })).json().data.stale).toBe(false)
  })

  it('group-scoped docs and annual tasks stay inside the group; templates include built-ins', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const c = await s.join('C')
    const g = (await s.req(a, { method: 'POST', url: '/api/groups', ip: IP, payload: { name: 'TF' } })).json().data
    await s.req(a, { method: 'POST', url: '/api/docs', ip: IP, payload: { kind: 'handover', title: 'TF 인수인계', scope: { type: 'group', groupIds: [g.id] } } })
    await s.req(a, { method: 'POST', url: '/api/annual-tasks', ip: IP, payload: { month: 3, day: 15, title: 'TF 결산', scope: { type: 'group', groupIds: [g.id] } } })
    await s.req(s.admin, { method: 'POST', url: '/api/annual-tasks', payload: { month: 1, title: '예산 편성', scope: team } })
    expect((await s.req(c, { method: 'GET', url: '/api/docs', ip: IP })).json().data).toEqual([])
    expect((await s.req(c, { method: 'GET', url: '/api/annual-tasks', ip: IP })).json().data.map((x: { title: string }) => x.title)).toEqual(['예산 편성'])
    expect((await s.req(c, { method: 'GET', url: '/api/annual-tasks', ip: IP })).json().data[0].authorId).toBe(s.admin.memberId)
    expect((await s.req(a, { method: 'GET', url: '/api/annual-tasks', ip: IP })).json().data).toHaveLength(2)
    const tpl = (await s.req(c, { method: 'GET', url: '/api/doc-templates', ip: IP })).json().data
    expect(tpl.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['회의록', '인수인계서']))
  })
})
