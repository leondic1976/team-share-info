import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './helpers'
import { dayPart, dutyGroupOf, onDay } from '../../src/shared/schemas/duty'

const IP = '192.168.10.20'
const DAY = 86400000
const midnight = (offsetDays = 0): number => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays).getTime()
}

describe('근무현황 (duty board)', () => {
  let s: TestServer
  afterEach(async () => {
    await s.close()
  })

  it('a member records their own absence; it is the same absence the calendar and presence show', async () => {
    s = await createTestServer()
    const b = await s.join('B', { deptName: '민원팀' })
    const c = await s.join('C')
    const from = midnight()
    const sent: { name: string; payload: unknown }[] = []
    s.ctx.hub.broadcast = (name, payload) => void sent.push({ name, payload })

    const res = await s.req(b, { method: 'POST', url: '/api/duty', ip: IP, payload: { type: '출장', startAt: from, endAt: from + 2 * DAY, allDay: true, place: '도청', note: '업무 협의' } })
    expect(res.statusCode).toBe(200)
    expect(sent.map((m) => m.name)).toEqual(['event.changed', 'presence.changed'])

    const board = (await s.req(c, { method: 'GET', url: `/api/duty?from=${from}&to=${from + 7 * DAY}`, ip: IP })).json().data
    expect(board.canManage).toBe(false)
    expect(board.members.map((m: { name: string }) => m.name).sort()).toEqual(['B', 'C', '관리자'])
    expect(board.departments.map((d: { name: string }) => d.name).sort()).toEqual(['민원팀', '행정팀'])
    expect(board.entries).toHaveLength(1)
    expect(board.entries[0]).toMatchObject({ memberId: b.memberId, type: '출장', allDay: true, place: '도청', note: '업무 협의', recurring: false, registeredByName: null })

    // the calendar lists it as an absence of B, and B is "absent" now
    const ev = (await s.req(c, { method: 'GET', url: `/api/events?from=${from}&to=${from + DAY}`, ip: IP })).json().data
    expect(ev[0]).toMatchObject({ kind: 'absence', absenceType: '출장', authorId: b.memberId, location: '도청' })
    expect(s.ctx.hub.absenceLookup?.(b.memberId)).toBe(true)
    expect(s.ctx.hub.absenceLookup?.(c.memberId)).toBe(false)

    // an absence made in the calendar shows on the board too
    await s.req(c, { method: 'POST', url: '/api/events', ip: IP, payload: { kind: 'absence', absenceType: '연가', title: '연가', startAt: from + DAY, endAt: from + 2 * DAY, allDay: true, scope: { type: 'team' } } })
    const again = (await s.req(b, { method: 'GET', url: `/api/duty?from=${from}&to=${from + 7 * DAY}`, ip: IP })).json().data
    expect(again.entries.map((e: { type: string; note: string }) => [e.type, e.note])).toEqual([
      ['출장', '업무 협의'],
      ['연가', '']
    ])
  })

  it('only the member, an admin or a 서무 may record, change and delete', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const c = await s.join('C')
    const from = midnight()
    const body = { type: '병가', startAt: from, endAt: from + DAY, allDay: true }

    // C is nobody special: not for B
    expect((await s.req(c, { method: 'POST', url: '/api/duty', ip: IP, payload: { ...body, memberId: b.memberId } })).statusCode).toBe(403)
    // the admin (server PC) records it for B
    const id = (await s.req(s.admin, { method: 'POST', url: '/api/duty', payload: { ...body, memberId: b.memberId } })).json().data.id
    let board = (await s.req(b, { method: 'GET', url: `/api/duty?from=${from}&to=${from + DAY}`, ip: IP })).json().data
    expect(board.entries[0]).toMatchObject({ memberId: b.memberId, type: '병가', registeredByName: '관리자' })

    // C cannot touch it, B (whose absence it is) can
    expect((await s.req(c, { method: 'PATCH', url: `/api/duty/${id}`, ip: IP, payload: body })).statusCode).toBe(403)
    expect((await s.req(c, { method: 'DELETE', url: `/api/duty/${id}`, ip: IP })).statusCode).toBe(403)
    expect((await s.req(b, { method: 'PATCH', url: `/api/duty/${id}`, ip: IP, payload: { ...body, type: '반가', startAt: from + 9 * 3600000, endAt: from + 13 * 3600000, allDay: false } })).statusCode).toBe(200)

    // only an admin names a 서무; then C may record for others
    expect((await s.req(c, { method: 'PUT', url: '/api/duty/clerks', ip: IP, payload: { memberIds: [c.memberId] } })).statusCode).toBe(403)
    expect((await s.req(s.admin, { method: 'PUT', url: '/api/duty/clerks', payload: { memberIds: [c.memberId, 'nobody'] } })).json().data.clerkIds).toEqual([c.memberId])
    board = (await s.req(c, { method: 'GET', url: `/api/duty?from=${from}&to=${from + DAY}`, ip: IP })).json().data
    expect(board).toMatchObject({ canManage: true, clerkIds: [c.memberId] })
    expect(board.entries[0]).toMatchObject({ type: '반가', allDay: false })
    expect((await s.req(c, { method: 'POST', url: '/api/duty', ip: IP, payload: { ...body, type: '교육', memberId: b.memberId } })).statusCode).toBe(200)
    expect((await s.req(c, { method: 'DELETE', url: `/api/duty/${id}`, ip: IP })).statusCode).toBe(200)
    board = (await s.req(b, { method: 'GET', url: `/api/duty?from=${from}&to=${from + DAY}`, ip: IP })).json().data
    expect(board.entries.map((e: { type: string; registeredByName: string }) => [e.type, e.registeredByName])).toEqual([['교육', 'C']])
  })

  it('refuses bad input; a repeating calendar absence is shown but changed in the calendar', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const from = midnight()
    expect((await s.req(b, { method: 'POST', url: '/api/duty', ip: IP, payload: { type: '연가', startAt: from, endAt: from, allDay: true } })).statusCode).toBe(400)
    expect((await s.req(b, { method: 'POST', url: '/api/duty', ip: IP, payload: { type: '', startAt: from, endAt: from + DAY } })).statusCode).toBe(400)
    expect((await s.req(b, { method: 'POST', url: '/api/duty', ip: IP, payload: { type: '연가', startAt: from, endAt: from + DAY, memberId: 'nobody' } })).statusCode).toBe(403)
    expect((await s.req(s.admin, { method: 'POST', url: '/api/duty', payload: { type: '연가', startAt: from, endAt: from + DAY, memberId: 'nobody' } })).statusCode).toBe(400)
    expect((await s.req(b, { method: 'GET', url: `/api/duty?from=${from}&to=${from + 200 * DAY}`, ip: IP })).statusCode).toBe(400)
    expect((await s.req(b, { method: 'PATCH', url: '/api/duty/nothing', ip: IP, payload: { type: '연가', startAt: from, endAt: from + DAY } })).statusCode).toBe(404)

    const ev = (await s.req(b, { method: 'POST', url: '/api/events', ip: IP, payload: { kind: 'absence', absenceType: '유연근무', title: '시차출퇴근', startAt: from + 9 * 3600000, endAt: from + 10 * 3600000, rrule: 'FREQ=DAILY;COUNT=3', scope: { type: 'team' } } })).json().data
    const board = (await s.req(b, { method: 'GET', url: `/api/duty?from=${from}&to=${from + 7 * DAY}`, ip: IP })).json().data
    expect(board.entries).toHaveLength(3)
    expect(board.entries[0]).toMatchObject({ type: '유연근무', note: '시차출퇴근', recurring: true })
    expect((await s.req(b, { method: 'DELETE', url: `/api/duty/${ev.id}`, ip: IP })).statusCode).toBe(400)
  })
})

describe('duty day helpers', () => {
  const day = new Date(2026, 10, 23).getTime()
  it('tells which days an entry touches and what part of the day', () => {
    const allDay = { start: day, end: day + 2 * DAY, allDay: true }
    expect(onDay(allDay, day, day + DAY)).toBe(true)
    expect(onDay(allDay, day + DAY, day + 2 * DAY)).toBe(true)
    expect(onDay(allDay, day + 2 * DAY, day + 3 * DAY)).toBe(false)
    expect(dayPart(allDay, day, day + DAY)).toBe('종일')
    const morning = { start: day + 9 * 3600000, end: day + 13 * 3600000, allDay: false }
    expect(dayPart(morning, day, day + DAY)).toBe('09:00~13:00')
    // a trip from 14:00 today to 11:00 the day after tomorrow
    const trip = { start: day + 14 * 3600000, end: day + 2 * DAY + 11 * 3600000, allDay: false }
    expect(dayPart(trip, day, day + DAY)).toBe('14:00~')
    expect(dayPart(trip, day + DAY, day + 2 * DAY)).toBe('종일')
    expect(dayPart(trip, day + 2 * DAY, day + 3 * DAY)).toBe('~11:00')
  })
  it('keeps a colour group for the types of older versions', () => {
    expect(dutyGroupOf('연가')).toBe('leave')
    expect(dutyGroupOf('휴가')).toBe('leave')
    expect(dutyGroupOf('출장')).toBe('trip')
    expect(dutyGroupOf('모르는 종류')).toBe('etc')
  })
})
