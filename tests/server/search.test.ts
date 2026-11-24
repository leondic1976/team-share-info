import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type TestServer } from './helpers'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'
const team = { type: 'team', groupIds: [], memberIds: [] }

describe('unified search (M8-2)', () => {
  it('finds items across features but only what the member may see', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    await s.req(s.admin, { method: 'POST', url: '/api/notices', payload: { level: 'normal', title: '예산 편성 안내', bodyHtml: '<p>2026 예산 제출</p>', scope: team } })
    await s.req(s.admin, { method: 'POST', url: '/api/notices', payload: { level: 'normal', title: 'B만 보는 예산 메모', bodyHtml: '<p>비공개</p>', scope: { type: 'members', groupIds: [], memberIds: [b.memberId] } } })
    await s.req(s.admin, { method: 'POST', url: '/api/docs', payload: { kind: 'manual', title: '예산 업무 매뉴얼', bodyHtml: '<p>절차</p>', scope: team } })
    await s.req(s.admin, { method: 'POST', url: '/api/tasks', payload: { title: '예산서 검토', assigneeId: b.memberId, scope: team } })
    const find = async (cred: typeof b, q: string) => (await s!.req(cred, { method: 'GET', url: `/api/search?q=${encodeURIComponent(q)}`, ip: IP })).json().data as { type: string; title: string; snippet: string }[]
    const forB = await find(b, '예산')
    // the task exists (older PCs still use /api/tasks) but is no longer a search result
    expect(forB.map((r) => r.type).sort()).toEqual(['doc', 'notice', 'notice'])
    const forC = await find(c, '예산')
    expect(forC.map((r) => r.title)).not.toContain('B만 보는 예산 메모')
    expect(forC.find((r) => r.type === 'notice')!.snippet).toContain('2026 예산 제출')
    expect((await find(c, 'C')).some((r) => r.type === 'member' && r.title === 'C')).toBe(true)
    expect((await find(c, '%')).length).toBe(0) // wildcards are literal
  })

  it('stays fast with many items', async () => {
    s = await createTestServer()
    const t = Date.now()
    s.ctx.db.tx(() => {
      for (let i = 0; i < 20000; i++)
        s!.ctx.db.run(`INSERT INTO notices (id, level, title, body_html, scope_type, created_by, publish_at, published_at, created_at, updated_at) VALUES (?, 'normal', ?, ?, 'team', ?, ?, ?, ?, ?)`, [
          `n${i}`,
          `공지 ${i}`,
          `<p>내용 ${i} 회의 자료 ${i % 97}</p>`,
          s!.admin.memberId,
          t,
          t,
          t,
          t
        ])
    })
    const t0 = performance.now()
    const r = await s.req(s.admin, { method: 'GET', url: `/api/search?q=${encodeURIComponent('자료 96')}` })
    const ms = performance.now() - t0
    expect(r.json().data.length).toBeGreaterThan(0)
    expect(ms).toBeLessThan(process.env.CI ? 3000 : 500)
  }, 60000)
})
