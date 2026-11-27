import { describe, it, expect, afterEach } from 'vitest'
import { createTestServer, type TestServer, type Cred } from './helpers'
import { ymd } from '../../command/shared/logic'
import { absenceDays } from '../../src/server/command-host'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})
const IP = '192.168.10.20'

type Body = Record<string, unknown>
const call = async (who: Cred, method: string, url: string, payload?: Body) => {
  const r = await s!.req(who, { method: method as 'GET', url, ip: IP, payload })
  return { status: r.statusCode, data: r.json().data, error: r.json().error?.message as string | undefined }
}

describe('긴급구조지휘대 (command module through TeamHub)', () => {
  it('편성: 지휘대담당, 근무 유형, 조, 순환, 분류, 배치, 공통업무, 예외자, 미등록 인원', async () => {
    s = await createTestServer()
    const admin = s.admin
    const a = await s.join('김지휘')
    const b = await s.join('이조사')
    const c = await s.join('박통신')

    let st = (await call(a, 'GET', '/api/command')).data
    expect(st.modes.map((m: { name: string }) => m.name)).toEqual(['긴급구조지휘대', '긴급구조통제단', '풍수해 비상상황근무'])
    expect(st.me).toMatchObject({ isManager: false, isOwner: false })
    // only those in charge change things; only the server PC names them
    expect((await call(a, 'POST', '/api/command/teams', { name: 'A조' })).status).toBe(403)
    expect((await call(a, 'PUT', '/api/command/managers', { memberIds: [a.memberId] })).status).toBe(403)
    expect((await call(admin, 'PUT', '/api/command/managers', { memberIds: ['1', '2', '3', '4'] })).status).toBe(400)
    expect((await call(admin, 'PUT', '/api/command/managers', { memberIds: [a.memberId] })).status).toBe(200)
    st = (await call(a, 'GET', '/api/command')).data
    expect(st.me.isManager).toBe(true)
    expect(st.managers.map((m: { name: string }) => m.name)).toEqual(['김지휘'])

    const mode = st.modes[0].id
    const mode2 = st.modes[1].id
    const tA = (await call(a, 'POST', '/api/command/teams', { name: 'A조' })).data.id
    const tB = (await call(a, 'POST', '/api/command/teams', { name: 'B조' })).data.id
    expect((await call(a, 'PUT', `/api/command/teams/${tA}/members`, { personIds: [a.memberId, b.memberId, c.memberId] })).status).toBe(200)
    // one person, one 조: putting 박통신 in B조 takes them out of A조
    await call(a, 'PUT', `/api/command/teams/${tB}/members`, { personIds: [c.memberId] })
    st = (await call(a, 'GET', '/api/command')).data
    expect(st.teams.find((t: { id: string }) => t.id === tA).members).toEqual([a.memberId, b.memberId])
    await call(a, 'PUT', `/api/command/teams/${tA}/members`, { personIds: [a.memberId, b.memberId, c.memberId] })

    // the rotation: A조 from a Monday, a week each
    expect((await call(a, 'PUT', '/api/command/rotation', { baseDate: '2026-11-02', shiftTime: '09:00', periodDays: 7, order: [tA, tB, 'nope'] })).data.order).toEqual([tA, tB])

    // roles of the first mode
    const r1 = (await call(a, 'POST', '/api/command/roles', { modeId: mode, name: '조장' })).data.id
    const r2 = (await call(a, 'POST', '/api/command/roles', { modeId: mode, name: '현장지휘팀' })).data.id
    const r3 = (await call(a, 'POST', '/api/command/roles', { modeId: mode, parentId: r2, name: '통신지원요원' })).data.id
    expect((await call(a, 'PATCH', `/api/command/roles/${r2}`, { parentId: r3 })).status).toBe(400)
    await call(a, 'PATCH', `/api/command/roles/${r3}`, { dutyHtml: '<p>무전 운용<script>x</script></p>' })
    expect((await call(c, 'GET', `/api/command/roles/${r3}`)).data).toMatchObject({ dutyHtml: '<p>무전 운용</p>', path: '현장지휘팀 > 통신지원요원' })

    // placing: members of the 조 only, one role per 조 and mode
    expect((await call(a, 'PUT', '/api/command/assignments', { modeId: mode, teamId: tA, roleId: r1, personIds: [a.memberId] })).status).toBe(200)
    expect((await call(a, 'PUT', '/api/command/assignments', { modeId: mode, teamId: tA, roleId: r3, personIds: [b.memberId, c.memberId] })).status).toBe(200)
    const twice = await call(a, 'PUT', '/api/command/assignments', { modeId: mode, teamId: tA, roleId: r1, personIds: [a.memberId, b.memberId] })
    expect([twice.status, twice.error]).toEqual([400, '이조사은(는) 이미 "현장지휘팀 > 통신지원요원"에 배치되어 있습니다. 한 조에서는 한 분류만 맡습니다.'])
    expect((await call(a, 'PUT', '/api/command/assignments', { modeId: mode, teamId: tB, roleId: r1, personIds: [a.memberId] })).status).toBe(400)

    // another mode: its own roles; copying by the same path
    const m2r = (await call(a, 'POST', '/api/command/roles', { modeId: mode2, name: '조장' })).data.id
    expect((await call(a, 'POST', '/api/command/assignments/copy', { fromModeId: mode, toModeId: mode2 })).data.copied).toBe(1)
    st = (await call(a, 'GET', '/api/command')).data
    expect(st.assignments.filter((x: { roleId: string }) => x.roleId === m2r)).toEqual([{ roleId: m2r, teamId: tA, personId: a.memberId }])

    // 공통업무: fixed or per 조
    const cm = (await call(a, 'POST', '/api/command/common', { name: '장비운반차 운전', perTeam: false })).data.id
    expect((await call(a, 'PUT', `/api/command/common/${cm}/assign`, { personIds: [c.memberId] })).status).toBe(200)
    const cm2 = (await call(a, 'POST', '/api/command/common', { name: '콤비버스 운전', perTeam: true })).data.id
    expect((await call(a, 'PUT', `/api/command/common/${cm2}/assign`, { teamId: tB, personIds: [c.memberId] })).status).toBe(400)

    // 미등록 인원 (관리, 지시 134): placed, then merged in 관리 into a member who joined later
    const unreg = (await call(admin, 'POST', '/api/unregistered', { name: '최미등', title: '소방위' })).data.id
    const tmp = `g:${unreg}`
    await call(a, 'PUT', `/api/command/teams/${tB}/members`, { personIds: [tmp] })
    await call(a, 'PUT', '/api/command/assignments', { modeId: mode, teamId: tB, roleId: r1, personIds: [tmp] })
    const d = await s.join('최미등')
    // merging is done in 관리, not here
    expect((await call(a, 'POST', `/api/command/people/${encodeURIComponent(tmp)}/merge`, { memberId: d.memberId })).status).toBe(400)
    expect((await call(admin, 'PUT', `/api/unregistered/${unreg}/merge`, { memberId: d.memberId })).status).toBe(200)
    st = (await call(a, 'GET', '/api/command')).data
    expect(st.teams.find((t: { id: string }) => t.id === tB).members).toEqual([d.memberId])
    expect(st.assignments).toContainEqual({ roleId: r1, teamId: tB, personId: d.memberId })
    expect(st.people.some((p: { id: string }) => p.id === tmp)).toBe(false)

    // 예외자: in force now takes them out of their 조
    expect((await call(a, 'POST', '/api/command/exceptions', { personId: d.memberId, reason: '장기교육', fromDate: '2020-01-01', toDate: null })).status).toBe(200)
    st = (await call(a, 'GET', '/api/command')).data
    expect(st.teams.find((t: { id: string }) => t.id === tB).members).toEqual([])
    expect((await call(a, 'PUT', `/api/command/teams/${tB}/members`, { personIds: [d.memberId] })).error).toContain('예외자')
  })

  it('공지·자료: those in charge write, everybody reads; unread count', async () => {
    s = await createTestServer()
    const b = await s.join('팀원')
    expect((await call(b, 'POST', '/api/command/notices', { title: 'x' })).status).toBe(403)
    expect((await call(s.admin, 'POST', '/api/command/notices', { title: '11월 훈련 안내', bodyHtml: '<p>목요일 14시</p>' })).status).toBe(200)
    expect((await call(b, 'GET', '/api/command')).data.unreadNotices).toBe(1)
    const list = (await call(b, 'GET', '/api/command/notices')).data
    expect(list[0]).toMatchObject({ title: '11월 훈련 안내', read: false })
    await call(b, 'POST', `/api/command/notices/${list[0].id}/read`)
    expect((await call(b, 'GET', '/api/command')).data.unreadNotices).toBe(0)
    expect((await call(s.admin, 'POST', '/api/command/materials', { category: '매뉴얼', title: '통제단 운영 매뉴얼' })).status).toBe(200)
    expect((await call(b, 'GET', '/api/command/materials')).data[0]).toMatchObject({ category: '매뉴얼', title: '통제단 운영 매뉴얼', file: null })
  })

  it('훈련: scenario hidden from participants, messages on time, answers by the way of handling, grades, the map live', async () => {
    s = await createTestServer()
    const admin = s.admin
    const b = await s.join('상황조사')
    const c = await s.join('통신')
    const outsider = await s.join('비참가')
    const st = (await call(admin, 'GET', '/api/command')).data
    const mode = st.modes[0].id
    const t = (await call(admin, 'POST', '/api/command/teams', { name: 'A조' })).data.id
    await call(admin, 'PUT', `/api/command/teams/${t}/members`, { personIds: [b.memberId, c.memberId] })
    const rB = (await call(admin, 'POST', '/api/command/roles', { modeId: mode, name: '상황조사요원' })).data.id
    const rC = (await call(admin, 'POST', '/api/command/roles', { modeId: mode, name: '통신지원요원' })).data.id
    await call(admin, 'PUT', '/api/command/assignments', { modeId: mode, teamId: t, roleId: rB, personIds: [b.memberId] })
    await call(admin, 'PUT', '/api/command/assignments', { modeId: mode, teamId: t, roleId: rC, personIds: [c.memberId] })

    const sc = await call(admin, 'POST', '/api/command/scenarios', {
      modeId: mode,
      title: '공장 화재',
      targetHtml: '<p>3층 공장</p>',
      map: { imageId: null, width: 800, height: 600, marks: [{ key: 'fire1', kind: 'pin', icon: 'fire', color: '#dc2626', label: '화점', points: [[0.5, 0.5]] }] },
      messages: [
        { offsetMin: 0, title: '최초 신고', targetKind: 'role', targetIds: [rB], handling: 'assigned', limitMin: 5 },
        { offsetMin: 5, title: '통신 두절', targetKind: 'role', targetIds: [rC], handling: 'assigned', answerKind: 'choice', choices: ['무전 중계', '전령'], correctIndex: 0, mapChanges: [{ op: 'move', key: 'fire1', points: [[0.6, 0.5]] }] },
        { offsetMin: 10, title: '전원 보고', handling: 'all' }
      ]
    })
    expect(sc.status).toBe(200)
    expect((await call(b, 'GET', `/api/command/scenarios/${sc.data.id}`)).status).toBe(403)

    const drillId = (await call(admin, 'POST', '/api/command/drills', { scenarioId: sc.data.id, modeId: mode, title: '11월 공장 화재 훈련', teamIds: [t] })).data.id
    let dB = (await call(b, 'GET', `/api/command/drills/${drillId}`)).data
    expect(dB.state).toBe('running')
    expect(dB.members.map((m: { name: string }) => m.name).sort()).toEqual(['상황조사', '통신'])
    // only what was sent shows; the right answer of a choice question stays hidden
    expect(dB.messages.map((m: { title: string }) => m.title)).toEqual(['최초 신고'])
    expect(dB.messages[0].targets).toEqual([b.memberId])
    expect(dB.marks.filter((m: { removedAt: number | null }) => m.removedAt == null).map((m: { label: string }) => m.label)).toEqual(['화점'])
    const m1 = dB.messages[0].id

    // answers: only the one it is for; not an outsider
    expect((await call(c, 'POST', `/api/command/drills/${drillId}/messages/${m1}/answer`, { body: '확인' })).error).toContain('처리 담당이 아닙니다')
    expect((await call(outsider, 'POST', `/api/command/drills/${drillId}/messages/${m1}/answer`, { body: '확인' })).error).toContain('참가자가 아닙니다')
    expect((await call(b, 'POST', `/api/command/drills/${drillId}/messages/${m1}/answer`, {})).status).toBe(400)
    expect((await call(b, 'POST', `/api/command/drills/${drillId}/messages/${m1}/answer`, { body: '현장 도착, 연기 확인' })).data.late).toBe(false)

    // five minutes on: the next message goes, with its map change
    s.command.runJobs(Date.now() + 5 * 60_000 + 1000)
    dB = (await call(b, 'GET', `/api/command/drills/${drillId}`)).data
    expect(dB.messages.map((m: { title: string }) => m.title)).toEqual(['최초 신고', '통신 두절'])
    expect(dB.messages[1].correctIndex).toBeNull()
    const live = dB.marks.filter((m: { removedAt: number | null }) => m.removedAt == null)
    expect(live.map((m: { points: number[][] }) => m.points[0])).toEqual([[0.6, 0.5]])
    expect(dB.marks).toHaveLength(2)
    const m2 = dB.messages[1].id
    expect((await call(c, 'POST', `/api/command/drills/${drillId}/messages/${m2}/answer`, { body: 'x' })).error).toBe('선택지를 고르세요.')
    expect((await call(c, 'POST', `/api/command/drills/${drillId}/messages/${m2}/answer`, { choiceIndex: 0 })).status).toBe(200)

    // those in charge: the whole drill (also what is still to come), skip, ad hoc, the map live, notes
    const dA = (await call(admin, 'GET', `/api/command/drills/${drillId}`)).data
    expect(dA.messages).toHaveLength(3)
    expect(dA.messages[1].correctIndex).toBe(0)
    expect((await call(admin, 'POST', `/api/command/drills/${drillId}/messages/${dA.messages[2].id}/skip`)).status).toBe(200)
    expect((await call(admin, 'POST', `/api/command/drills/${drillId}/messages`, { title: '즉석: 2차 폭발', handling: 'first', targetKind: 'all' })).status).toBe(200)
    expect((await call(b, 'POST', `/api/command/drills/${drillId}/marks`, { key: 'cmd1', kind: 'pin', icon: 'command', color: '#2563eb', label: '지휘소', points: [[0.1, 0.1]] })).status).toBe(403)
    expect((await call(admin, 'POST', `/api/command/drills/${drillId}/marks`, { key: 'cmd1', kind: 'pin', icon: 'command', color: '#2563eb', label: '지휘소', points: [[0.1, 0.1]] })).status).toBe(200)
    expect((await call(admin, 'PATCH', `/api/command/drills/${drillId}/marks/cmd1`, { kind: 'pin', icon: 'command', color: '#2563eb', label: '지휘소(이동)', points: [[0.2, 0.1]] })).status).toBe(200)
    expect((await call(admin, 'DELETE', `/api/command/drills/${drillId}/marks/fire1`)).status).toBe(200)
    dB = (await call(b, 'GET', `/api/command/drills/${drillId}`)).data
    expect(dB.marks.filter((m: { removedAt: number | null }) => m.removedAt == null).map((m: { label: string }) => m.label)).toEqual(['지휘소(이동)'])
    const adHoc = dB.messages.find((m: { title: string }) => m.title === '즉석: 2차 폭발')
    expect(adHoc.adHoc).toBe(true)
    // anybody first: one answer settles it
    expect((await call(c, 'POST', `/api/command/drills/${drillId}/messages/${adHoc.id}/answer`, { body: '대피 지시' })).status).toBe(200)
    expect((await call(b, 'POST', `/api/command/drills/${drillId}/messages/${adHoc.id}/answer`, { body: '나도' })).error).toContain('이미 처리')

    // grade, note, end: then the right answer shows to everybody
    const ans = (await call(admin, 'GET', `/api/command/drills/${drillId}`)).data.messages[0].answers[0]
    expect((await call(b, 'PUT', `/api/command/drills/${drillId}/answers/${ans.id}/grade`, { grade: 'good' })).status).toBe(403)
    expect((await call(admin, 'PUT', `/api/command/drills/${drillId}/answers/${ans.id}/grade`, { grade: 'good', comment: '신속' })).status).toBe(200)
    expect((await call(admin, 'POST', `/api/command/drills/${drillId}/notes`, { body: '통신 두절 상황 부여' })).status).toBe(200)
    expect((await call(admin, 'POST', `/api/command/drills/${drillId}/end`)).status).toBe(200)
    dB = (await call(b, 'GET', `/api/command/drills/${drillId}`)).data
    expect(dB.state).toBe('ended')
    expect(dB.messages.find((m: { title: string }) => m.title === '통신 두절').correctIndex).toBe(0)
    expect(dB.messages[0].answers[0]).toMatchObject({ grade: 'good', comment: '신속' })
    expect(dB.notes).toEqual([])
    expect((await call(admin, 'GET', `/api/command/drills/${drillId}`)).data.notes[0].body).toBe('통신 두절 상황 부여')
    expect((await call(c, 'POST', `/api/command/drills/${drillId}/messages/${m1}/answer`, { body: 'late' })).error).toBe('끝난 훈련입니다.')
  })

  it('a drill scheduled for later starts by itself; pause holds the clock', async () => {
    s = await createTestServer()
    const b = await s.join('대원')
    const mode = (await call(s.admin, 'GET', '/api/command')).data.modes[0].id
    const t = (await call(s.admin, 'POST', '/api/command/teams', { name: 'A조' })).data.id
    await call(s.admin, 'PUT', `/api/command/teams/${t}/members`, { personIds: [b.memberId] })
    const start = Date.now() + 60_000
    const id = (await call(s.admin, 'POST', '/api/command/drills', { modeId: mode, title: '예약 훈련', teamIds: [t], startAt: start })).data.id
    expect((await call(b, 'GET', `/api/command/drills/${id}`)).data.state).toBe('scheduled')
    s.command.runJobs(start + 1)
    expect((await call(b, 'GET', `/api/command/drills/${id}`)).data.state).toBe('running')
    await call(s.admin, 'POST', `/api/command/drills/${id}/pause`)
    expect((await call(b, 'GET', `/api/command/drills/${id}`)).data.state).toBe('paused')
    await call(s.admin, 'POST', `/api/command/drills/${id}/resume`)
    expect((await call(s.admin, 'POST', `/api/command/drills/${id}/delete`)).status).toBe(400)
    await call(s.admin, 'POST', `/api/command/drills/${id}/end`)
    expect((await call(s.admin, 'POST', `/api/command/drills/${id}/delete`)).status).toBe(200)
  })

  it('대리자: those in charge register it (rules on the server), the roster and drills take the substitute', async () => {
    s = await createTestServer()
    const admin = s.admin
    const kim = await s.join('김부재')
    const lee = await s.join('이대리')
    const park = await s.join('박조원')
    const DAY = 86_400_000
    const today = ymd(Date.now())
    const tomorrow = ymd(Date.now() + DAY)
    const st0 = (await call(admin, 'GET', '/api/command')).data
    const mode = st0.modes[0].id
    const tA = (await call(admin, 'POST', '/api/command/teams', { name: 'A조' })).data.id
    const tB = (await call(admin, 'POST', '/api/command/teams', { name: 'B조' })).data.id
    await call(admin, 'PUT', `/api/command/teams/${tA}/members`, { personIds: [kim.memberId, park.memberId] })
    await call(admin, 'PUT', `/api/command/teams/${tB}/members`, { personIds: [lee.memberId] })
    const r1 = (await call(admin, 'POST', '/api/command/roles', { modeId: mode, name: '조장' })).data.id
    const r2 = (await call(admin, 'POST', '/api/command/roles', { modeId: mode, name: '상황요원' })).data.id
    await call(admin, 'PUT', '/api/command/assignments', { modeId: mode, teamId: tA, roleId: r1, personIds: [kim.memberId] })
    await call(admin, 'PUT', '/api/command/assignments', { modeId: mode, teamId: tA, roleId: r2, personIds: [park.memberId] })
    const body = { personId: kim.memberId, substituteId: lee.memberId, reason: '휴가', fromDate: today, toDate: tomorrow }

    // writes are for the server PC and the 지휘대담당 only
    expect((await call(park, 'POST', '/api/command/substitutions', body)).status).toBe(403)
    const made = await call(admin, 'POST', '/api/command/substitutions', body)
    expect([made.status, made.data.warnings]).toEqual([200, []])
    const id = made.data.id
    expect((await call(park, 'PATCH', `/api/command/substitutions/${id}`, body)).status).toBe(403)
    expect((await call(park, 'DELETE', `/api/command/substitutions/${id}`)).status).toBe(403)
    // everybody reads them
    expect((await call(park, 'GET', '/api/command')).data.substitutions).toEqual([{ id, ...body }])

    // the rules
    expect((await call(admin, 'POST', '/api/command/substitutions', { ...body, substituteId: park.memberId, fromDate: tomorrow, toDate: null })).error).toContain('기간이 겹치지 않게')
    expect((await call(admin, 'POST', '/api/command/substitutions', { ...body, substituteId: kim.memberId })).error).toBe('대리자는 부재자와 다른 사람이어야 합니다.')
    expect((await call(admin, 'POST', '/api/command/substitutions', { ...body, toDate: '2000-01-01' })).status).toBe(400)
    expect((await call(admin, 'POST', '/api/command/substitutions', { ...body, substituteId: 'nobody' })).status).toBe(404)
    // the one covering cannot be put on exception in the period
    expect((await call(admin, 'POST', '/api/command/exceptions', { personId: lee.memberId, reason: '교육', fromDate: tomorrow, toDate: null })).error).toContain('김부재의 대리자입니다')
    // a substitute on exception then is refused
    // a 미등록 person (the host's list) can be a substitute like a member
    const unreg = (await call(admin, 'POST', '/api/unregistered', { name: '정미등', title: '소방장' })).data.id
    const temp = `g:${unreg}`
    const ex = (await call(admin, 'POST', '/api/command/exceptions', { personId: temp, reason: '파견', fromDate: '2099-01-01', toDate: null })).data.id
    expect((await call(admin, 'POST', '/api/command/substitutions', { ...body, substituteId: temp, fromDate: '2099-02-01', toDate: '2099-02-02' })).error).toContain('예외자(파견')
    await call(admin, 'DELETE', `/api/command/exceptions/${ex}`)
    // own duty in the same 조: allowed with a warning (edit: 박조원 covers instead)
    const edited = await call(admin, 'PATCH', `/api/command/substitutions/${id}`, { ...body, substituteId: park.memberId })
    expect(edited.status).toBe(200)
    expect(edited.data.warnings[0]).toContain('같은 조(A조)에서 "상황요원"도 맡고 있어')
    await call(admin, 'PATCH', `/api/command/substitutions/${id}`, body)

    // a drill of A조 started in the period: 이대리 takes part as 조장 in 김부재's place
    const d1 = (await call(admin, 'POST', '/api/command/drills', { modeId: mode, title: '대리 훈련', teamIds: [tA] })).data.id
    const members = (await call(admin, 'GET', `/api/command/drills/${d1}`)).data.members
    expect(members.map((x: { name: string }) => x.name).sort()).toEqual(['박조원', '이대리'])
    expect(members.find((x: { memberId: string }) => x.memberId === lee.memberId)).toMatchObject({ teamId: tA, roleIds: [r1], common: false, coverFor: '김부재' })
    await call(admin, 'POST', `/api/command/drills/${d1}/end`)

    // a 미등록 substitute cannot join: the place stays empty, the absent one is not in it either
    const tmp = await call(admin, 'POST', '/api/command/substitutions', { ...body, personId: park.memberId, substituteId: temp, reason: '출장' })
    expect(tmp.data.warnings.some((w: string) => w.includes('미등록 인원이라 훈련에는 참가하지 못합니다'))).toBe(true)
    expect((await call(park, 'GET', '/api/command')).data.people.find((x: { id: string }) => x.id === temp)).toMatchObject({ name: '정미등', temp: true })
    const d2 = (await call(admin, 'POST', '/api/command/drills', { modeId: mode, title: '미등록 대리 훈련', teamIds: [tA] })).data.id
    expect((await call(admin, 'GET', `/api/command/drills/${d2}`)).data.members.map((x: { name: string }) => x.name)).toEqual(['이대리'])
    await call(admin, 'POST', `/api/command/drills/${d2}/end`)

    // deleting it gives the places back
    expect((await call(admin, 'DELETE', `/api/command/substitutions/${id}`)).status).toBe(200)
    expect((await call(admin, 'GET', '/api/command')).data.substitutions.map((x: { id: string }) => x.id)).toEqual([tmp.data.id])

    // the 미등록 person merged into a member in 관리: the substitution follows
    const jung = await s.join('정미등')
    expect((await call(admin, 'PUT', `/api/unregistered/${unreg}/merge`, { memberId: jung.memberId })).status).toBe(200)
    const after = (await call(admin, 'GET', '/api/command')).data.substitutions
    expect(after).toEqual([expect.objectContaining({ id: tmp.data.id, personId: park.memberId, substituteId: jung.memberId })])
  })

  it('대리자 hint: who is away by 근무현황 from today through the next 7 days goes to those in charge only', async () => {
    s = await createTestServer()
    const b = await s.join('휴가자')
    const c = await s.join('팀원')
    const e = await s.join('교육자')
    const d = new Date()
    const at = (days: number, h = 0): number => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, h).getTime()
    const day = (days: number): string => ymd(at(days))
    const duty = async (who: Cred, payload: Body): Promise<void> => {
      expect((await s!.req(who, { method: 'POST', url: '/api/duty', ip: IP, payload })).statusCode).toBe(200)
    }
    // today only (all-day: the end is the next midnight, not a day of the absence)
    await duty(b, { type: '연가', startAt: at(0), endAt: at(1), allDay: true })
    expect((await call(s.admin, 'GET', '/api/command')).data.hostAbsences).toEqual([{ personId: b.memberId, type: '연가', fromDate: day(0), toDate: day(0) }])
    expect((await call(c, 'GET', '/api/command')).data.hostAbsences).toBeUndefined()

    // all-day from the day after tomorrow for 3 days; one that began yesterday shows from today;
    // timed ones to the day of their end; one beyond the 7 days is not shown
    await duty(c, { type: '연가', startAt: at(2), endAt: at(5), allDay: true })
    await duty(e, { type: '교육', startAt: at(-1), endAt: at(2), allDay: true })
    await duty(e, { type: '출장', startAt: at(3, 9), endAt: at(4, 18), allDay: false })
    await duty(b, { type: '병가', startAt: at(7), endAt: at(8), allDay: true })
    // a repeating calendar absence, day after day: one period
    expect((await s.req(c, { method: 'POST', url: '/api/events', ip: IP, payload: { kind: 'absence', absenceType: '유연근무', title: '시차출퇴근', startAt: at(1, 9), endAt: at(1, 10), rrule: 'FREQ=DAILY;COUNT=3', scope: { type: 'team' } } })).statusCode).toBe(200)
    const list = (await call(s.admin, 'GET', '/api/command')).data.hostAbsences
    expect(list).toHaveLength(5)
    expect(list).toEqual(
      expect.arrayContaining([
        { personId: b.memberId, type: '연가', fromDate: day(0), toDate: day(0) },
        { personId: c.memberId, type: '연가', fromDate: day(2), toDate: day(4) },
        { personId: c.memberId, type: '유연근무', fromDate: day(1), toDate: day(3) },
        { personId: e.memberId, type: '교육', fromDate: day(0), toDate: day(1) },
        { personId: e.memberId, type: '출장', fromDate: day(3), toDate: day(4) }
      ])
    )
  })

  it('대리자 hint: the days of an absence occurrence', () => {
    const today0 = new Date(2026, 10, 27).getTime()
    const t = (d: number, h = 0): number => new Date(2026, 10, d, h).getTime()
    expect(absenceDays({ start: t(28), end: t(29) }, today0)).toEqual({ fromDate: '2026-11-28', toDate: '2026-11-28' })
    expect(absenceDays({ start: t(25), end: t(30) }, today0)).toEqual({ fromDate: '2026-11-27', toDate: '2026-11-29' })
    expect(absenceDays({ start: t(28, 9), end: t(30, 18) }, today0)).toEqual({ fromDate: '2026-11-28', toDate: '2026-11-30' })
    expect(absenceDays({ start: t(28, 22), end: t(29) }, today0)).toEqual({ fromDate: '2026-11-28', toDate: '2026-11-28' })
    expect(absenceDays({ start: t(28, 9), end: t(28, 9) }, today0)).toEqual({ fromDate: '2026-11-28', toDate: '2026-11-28' })
  })
})
