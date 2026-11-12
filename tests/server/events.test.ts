import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type TestServer } from './helpers'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})

const IP = '192.168.10.20'
const L = (y: number, m: number, d: number, h = 0): number => new Date(y, m - 1, d, h).getTime()
const team = { type: 'team', groupIds: [], memberIds: [] }

describe('events (M3-1, M3-2)', () => {
  it('creates, lists in range, and restricts by scope; attendees can see member-scoped events', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const c = await s.join('C')
    await s.req(a, { method: 'POST', url: '/api/events', ip: IP, payload: { title: '팀회의', startAt: L(2026, 11, 16, 10), endAt: L(2026, 11, 16, 11), scope: team } })
    const priv = await s.req(a, {
      method: 'POST',
      url: '/api/events',
      ip: IP,
      payload: { title: '면담', startAt: L(2026, 11, 17, 14), endAt: L(2026, 11, 17, 15), scope: { type: 'members', memberIds: [b.memberId] }, attendeeIds: [b.memberId] }
    })
    expect(priv.statusCode).toBe(200)
    const range = `from=${L(2026, 11, 16)}&to=${L(2026, 11, 23)}`
    const bList = (await s.req(b, { method: 'GET', url: `/api/events?${range}`, ip: IP })).json().data.map((e: { title: string }) => e.title)
    const cList = (await s.req(c, { method: 'GET', url: `/api/events?${range}`, ip: IP })).json().data.map((e: { title: string }) => e.title)
    expect(bList).toEqual(['팀회의', '면담'])
    expect(cList).toEqual(['팀회의'])
    const id = priv.json().data.id
    expect((await s.req(c, { method: 'GET', url: `/api/events/${id}`, ip: IP })).statusCode).toBe(404)
    await s.req(b, { method: 'POST', url: `/api/events/${id}/respond`, ip: IP, payload: { response: 'yes' } })
    const d = (await s.req(a, { method: 'GET', url: `/api/events/${id}`, ip: IP })).json().data
    expect(d.attendees).toEqual([{ memberId: b.memberId, name: 'B', response: 'yes' }])
    expect((await s.req(c, { method: 'POST', url: `/api/events/${id}/respond`, ip: IP, payload: { response: 'yes' } })).statusCode).toBe(404)
  })

  it('expands recurring events and edits this / following / all', async () => {
    s = await createTestServer()
    const r = await s.req(s.admin, {
      method: 'POST',
      url: '/api/events',
      payload: { title: '주간회의', startAt: L(2026, 11, 2, 9), endAt: L(2026, 11, 2, 10), rrule: 'FREQ=WEEKLY;BYDAY=MO', scope: team }
    })
    const id = r.json().data.id
    const list = async () =>
      (await s!.req(s!.admin, { method: 'GET', url: `/api/events?from=${L(2026, 11, 1)}&to=${L(2026, 12, 1)}` })).json().data.map((e: { title: string; start: number }) => `${new Date(e.start).getDate()}:${e.title}`)
    expect(await list()).toEqual(['2:주간회의', '9:주간회의', '16:주간회의', '23:주간회의', '30:주간회의'])

    // this occurrence only: move 11/9 to 11/10
    await s.req(s.admin, { method: 'PATCH', url: `/api/events/${id}`, payload: { mode: 'this', occurrenceStart: L(2026, 11, 9, 9), startAt: L(2026, 11, 10, 9), endAt: L(2026, 11, 10, 10), title: '주간회의(변경)' } })
    expect(await list()).toEqual(['2:주간회의', '10:주간회의(변경)', '16:주간회의', '23:주간회의', '30:주간회의'])

    // this and following: rename from 11/23
    await s.req(s.admin, { method: 'PATCH', url: `/api/events/${id}`, payload: { mode: 'following', occurrenceStart: L(2026, 11, 23, 9), title: '정례회의' } })
    expect(await list()).toEqual(['2:주간회의', '10:주간회의(변경)', '16:주간회의', '23:정례회의', '30:정례회의'])

    // delete one occurrence
    await s.req(s.admin, { method: 'DELETE', url: `/api/events/${id}?mode=this&occurrence=${L(2026, 11, 16, 9)}` })
    expect(await list()).toEqual(['2:주간회의', '10:주간회의(변경)', '23:정례회의', '30:정례회의'])

    // all: rename the original series
    await s.req(s.admin, { method: 'PATCH', url: `/api/events/${id}`, payload: { mode: 'all', title: '회의' } })
    expect(await list()).toEqual(['2:회의', '10:주간회의(변경)', '23:정례회의', '30:정례회의'])
  })

  it('rejects invalid rules and end before start; only the author edits', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    expect((await s.req(s.admin, { method: 'POST', url: '/api/events', payload: { title: 'x', startAt: 10, endAt: 5, scope: team } })).statusCode).toBe(400)
    expect((await s.req(s.admin, { method: 'POST', url: '/api/events', payload: { title: 'x', startAt: 10, endAt: 50, rrule: 'GARBAGE', scope: team } })).statusCode).toBe(400)
    const id = (await s.req(s.admin, { method: 'POST', url: '/api/events', payload: { title: 'x', startAt: 10, endAt: 50, scope: team } })).json().data.id
    expect((await s.req(b, { method: 'PATCH', url: `/api/events/${id}`, ip: IP, payload: { title: 'y' } })).statusCode).toBe(403)
  })

  it('absence makes presence "absent" and is visible to the team', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const now = Date.now()
    await s.req(b, { method: 'POST', url: '/api/events', ip: IP, payload: { kind: 'absence', absenceType: '휴가', title: '연차', startAt: now - 3600000, endAt: now + 3600000, scope: { type: 'members', memberIds: [b.memberId] } } })
    const ms = (await s.req(s.admin, { method: 'GET', url: '/api/members' })).json().data
    expect(ms.find((m: { name: string }) => m.name === 'B').presence).toBe('absent')
    const ev = (await s.req(s.admin, { method: 'GET', url: `/api/events?from=${now - 86400000}&to=${now + 86400000}` })).json().data
    expect(ev[0]).toMatchObject({ kind: 'absence', absenceType: '휴가', title: '연차' })
  })

  it('busy blocks hide details', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    await s.req(b, { method: 'POST', url: '/api/events/busy', ip: IP, payload: { startAt: L(2026, 11, 20, 13), endAt: L(2026, 11, 20, 15) } })
    const ev = (await s.req(s.admin, { method: 'GET', url: `/api/events?from=${L(2026, 11, 20)}&to=${L(2026, 11, 21)}` })).json().data
    expect(ev[0]).toMatchObject({ kind: 'busy', title: '바쁨', authorName: 'B' })
  })

  it('serves built-in holidays and lets admins edit them', async () => {
    s = await createTestServer()
    const h = (await s.req(s.admin, { method: 'GET', url: '/api/holidays?from=2026-09-01&to=2026-10-31' })).json().data
    expect(h.map((x: { date: string }) => x.date)).toContain('2026-09-25')
    await s.req(s.admin, { method: 'PUT', url: '/api/admin/holidays/2026-10-30', payload: { name: '창립기념일' } })
    await s.req(s.admin, { method: 'DELETE', url: '/api/admin/holidays/2026-10-09' })
    const h2 = (await s.req(s.admin, { method: 'GET', url: '/api/holidays?from=2026-10-01&to=2026-10-31' })).json().data.map((x: { name: string }) => x.name)
    expect(h2).toContain('창립기념일')
    expect(h2).not.toContain('한글날')
  })
})

describe('worklogs (M3-5)', () => {
  it('upserts my worklog and respects its scope', async () => {
    s = await createTestServer()
    const a = await s.join('A')
    const b = await s.join('B')
    const put = await s.req(a, {
      method: 'PUT',
      url: '/api/worklogs/mine/2026-11-12',
      ip: IP,
      payload: { doneHtml: '<p>보고서 작성</p>', todoHtml: '<p>검토</p>', scope: { type: 'members', memberIds: [s.admin.memberId] } }
    })
    expect(put.statusCode).toBe(200)
    await s.req(a, { method: 'PUT', url: '/api/worklogs/mine/2026-11-12', ip: IP, payload: { doneHtml: '<p>보고서 완료</p>', scope: { type: 'members', memberIds: [s.admin.memberId] } } })
    const q = 'from=2026-11-01&to=2026-11-30'
    const adminView = (await s.req(s.admin, { method: 'GET', url: `/api/worklogs?${q}` })).json().data
    expect(adminView).toHaveLength(1)
    expect(adminView[0]).toMatchObject({ memberName: 'A', doneHtml: '<p>보고서 완료</p>' })
    expect((await s.req(b, { method: 'GET', url: `/api/worklogs?${q}`, ip: IP })).json().data).toEqual([])
    const mine = (await s.req(a, { method: 'GET', url: '/api/worklogs/mine/2026-11-12', ip: IP })).json().data
    expect(mine.doneHtml).toBe('<p>보고서 완료</p>')
    await s.req(a, { method: 'DELETE', url: '/api/worklogs/mine/2026-11-12', ip: IP })
    expect((await s.req(a, { method: 'GET', url: '/api/worklogs/mine/2026-11-12', ip: IP })).json().data).toBeNull()
  })
})
