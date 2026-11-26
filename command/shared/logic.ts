/**
 * 긴급구조지휘대: rules worked out the same way on the server and on the screens. Pure functions
 * (no I/O, no host), unit-tested in command/tests.
 */
import type { CmdAssignment, CmdCommon, CmdException, CmdOverride, CmdPerson, CmdRole, CmdRotation, CmdSubstitution, CmdTeam, Drill, DrillMember, DrillMsg, Grade, Mark, MarkChange, SummaryRow } from './types'

const DAY = 86_400_000
const pad = (n: number): string => String(n).padStart(2, '0')

export function ymd(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local time of a date and HH:mm. */
export function atTime(date: string, hm: string): number {
  const [y, m, d] = date.split('-').map(Number)
  const [h, mi] = hm.split(':').map(Number)
  return new Date(y, m - 1, d, h || 0, mi || 0).getTime()
}

const addDaysMs = (ms: number, n: number): number => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes()).getTime()
}

export interface Shift {
  teamId: string
  from: number
  to: number
  /** set by hand (수동 지정) */
  manual: boolean
  note?: string
}

/** The automatic period that holds `at`, counted in calendar days (summer time safe). */
function autoShift(r: CmdRotation, at: number): Shift | null {
  if (!r.order.length || r.periodDays < 1) return null
  const base = atTime(r.baseDate, r.shiftTime)
  // whole periods between base and at, counted by calendar days
  const days = Math.floor((at - base) / DAY)
  let k = Math.floor(days / r.periodDays)
  let from = addDaysMs(base, k * r.periodDays)
  // correct for the day boundary of the shift time
  while (from > at) {
    k--
    from = addDaysMs(base, k * r.periodDays)
  }
  while (addDaysMs(base, (k + 1) * r.periodDays) <= at) {
    k++
    from = addDaysMs(base, k * r.periodDays)
  }
  const n = r.order.length
  return { teamId: r.order[((k % n) + n) % n], from, to: addDaysMs(base, (k + 1) * r.periodDays), manual: false }
}

/** The 조 on duty at `at`: a period set by hand wins (the one made last), else the rotation. */
export function teamAt(r: CmdRotation | null, overrides: CmdOverride[], at: number): Shift | null {
  const o = overrides.filter((x) => x.fromAt <= at && at < x.toAt).sort((a, b) => b.createdAt - a.createdAt)[0]
  if (o) return { teamId: o.teamId, from: o.fromAt, to: o.toAt, manual: true, note: o.note }
  return r ? autoShift(r, at) : null
}

/** The next `n` periods of one 조 from `from` (its current one first, when it is on now). */
export function nextShifts(r: CmdRotation | null, overrides: CmdOverride[], teamId: string, from: number, n: number): Shift[] {
  const out: Shift[] = []
  let at = from
  for (let guard = 0; out.length < n && guard < 400; guard++) {
    const s = teamAt(r, overrides, at)
    if (!s) break
    if (s.teamId === teamId && !out.some((x) => x.from === s.from)) out.push(s)
    at = Math.max(s.to, at + 60_000)
  }
  return out
}

/** Exceptions in force on a day (YYYY-MM-DD). */
export function activeExceptions(list: CmdException[], today: string): CmdException[] {
  return list.filter((e) => e.fromDate <= today && (!e.toDate || today <= e.toDate))
}

/** The roles of a mode as a tree, in order: [{ role, depth }]. */
export function roleTree(roles: CmdRole[], modeId: string): { role: CmdRole; depth: number }[] {
  const mine = roles.filter((r) => r.modeId === modeId)
  const ids = new Set(mine.map((r) => r.id))
  const out: { role: CmdRole; depth: number }[] = []
  const walk = (parent: string | null, depth: number): void => {
    for (const r of mine.filter((x) => (x.parentId && ids.has(x.parentId) ? x.parentId : null) === parent).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'ko'))) {
      out.push({ role: r, depth })
      if (depth < 12) walk(r.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** A role and everything under it. */
export function roleWithChildren(roles: CmdRole[], roleId: string): Set<string> {
  const out = new Set([roleId])
  for (let grew = true; grew; ) {
    grew = false
    for (const r of roles) if (r.parentId && out.has(r.parentId) && !out.has(r.id)) {
      out.add(r.id)
      grew = true
    }
  }
  return out
}

/** The path of names from the top: "현장지휘팀 > 통신지원요원". */
export function rolePath(roles: CmdRole[], roleId: string): string {
  const byId = new Map(roles.map((r) => [r.id, r]))
  const names: string[] = []
  for (let r = byId.get(roleId); r && names.length < 12; r = r.parentId ? byId.get(r.parentId) : undefined) names.unshift(r.name)
  return names.join(' > ')
}

// ---------- 대리자 ----------
const OPEN_END = '9999-12-31'

/** Two periods of days (YYYY-MM-DD, null: no end) share at least one day. */
export function periodsOverlap(aFrom: string, aTo: string | null, bFrom: string, bTo: string | null): boolean {
  return aFrom <= (bTo ?? OPEN_END) && bFrom <= (aTo ?? OPEN_END)
}

/** "2026-12-01 ~ 2026-12-05" */
export const periodText = (fromDate: string, toDate: string | null): string => `${fromDate} ~ ${toDate ?? '계속'}`

/** Where a substitution stands on a day. */
export function substitutionPhase(s: Pick<CmdSubstitution, 'fromDate' | 'toDate'>, day: string): 'now' | 'later' | 'past' {
  if (day < s.fromDate) return 'later'
  return s.toDate && s.toDate < day ? 'past' : 'now'
}

/**
 * The substitutions in force on a day, one per absent person (overlaps are refused when saved;
 * should two meet anyway, the one that started later wins).
 */
export function activeSubstitutions(list: CmdSubstitution[], day: string): CmdSubstitution[] {
  const out = new Map<string, CmdSubstitution>()
  for (const x of list) {
    if (x.substituteId === x.personId || substitutionPhase(x, day) !== 'now') continue
    const cur = out.get(x.personId)
    if (!cur || x.fromDate > cur.fromDate) out.set(x.personId, x)
  }
  return [...out.values()]
}

/** A place as it is filled on a day; `cover`: taken by a substitute for the absent `cover.personId`. */
export type EffAssignment = CmdAssignment & { cover?: CmdSubstitution }
export type EffCommonAssign = CmdCommon['assign'][number] & { cover?: CmdSubstitution }
export type EffCommon = Omit<CmdCommon, 'assign'> & { assign: EffCommonAssign[] }

/** Places with the absent people swapped for their substitutes (same order; one entry per person and place). */
function swapIn<T extends { personId: string }>(list: T[], active: CmdSubstitution[], key: (x: T) => string): (T & { cover?: CmdSubstitution })[] {
  const by = new Map(active.map((x) => [x.personId, x]))
  const out: (T & { cover?: CmdSubstitution })[] = []
  const at = new Map<string, number>()
  for (const a of list) {
    const sub = by.get(a.personId)
    const e = sub ? { ...a, personId: sub.substituteId, cover: sub } : a
    const k = `${key(a)}|${e.personId}`
    const i = at.get(k)
    if (i === undefined) {
      at.set(k, out.length)
      out.push(e)
    } else if (sub) out[i] = e // the substitute held this place already: one entry, marked as covering
  }
  return out
}

/** Who does each 분류 in each 조 on a day (every 근무 유형): an absent person's places go to their substitute. */
export function effectiveAssignments(assignments: CmdAssignment[], active: CmdSubstitution[]): EffAssignment[] {
  return active.length ? swapIn(assignments, active, (a) => `${a.roleId}|${a.teamId}`) : assignments
}

/** 공통업무 (fixed or per 조) as done on a day: an absent person's go to their substitute. */
export function effectiveCommon(common: CmdCommon[], active: CmdSubstitution[]): EffCommon[] {
  return active.length ? common.map((c) => ({ ...c, assign: swapIn(c.assign, active, (a) => a.teamId) })) : common
}

export interface SubstitutionCheck {
  /** why it is refused ('' : allowed) */
  error: string
  /** allowed, but worth knowing */
  warnings: string[]
}

/**
 * The rules of a substitution, the same on the server (refusal) and on the screen (before
 * saving): not oneself; one substitution at a time per absent person; the substitute must not
 * be on exception or away themselves, and the absent person must not be covering for somebody
 * else then. A substitute who has duties of their own in that 조 is allowed, with a warning.
 */
export function checkSubstitution(
  input: Pick<CmdSubstitution, 'personId' | 'substituteId' | 'fromDate' | 'toDate'> & { id?: string },
  o: { substitutions: CmdSubstitution[]; exceptions: CmdException[]; teams: CmdTeam[]; assignments: CmdAssignment[]; common: CmdCommon[]; roles: CmdRole[]; people: CmdPerson[] }
): SubstitutionCheck {
  const name = (id: string): string => o.people.find((p) => p.id === id)?.name ?? '(알 수 없음)'
  const A = name(input.personId)
  const S = name(input.substituteId)
  const warnings: string[] = []
  if (input.personId === input.substituteId) return { error: '대리자는 부재자와 다른 사람이어야 합니다.', warnings }
  const overlap = (x: { fromDate: string; toDate: string | null }): boolean => periodsOverlap(x.fromDate, x.toDate, input.fromDate, input.toDate)
  const others = o.substitutions.filter((x) => x.id !== input.id && overlap(x))
  const same = others.find((x) => x.personId === input.personId)
  if (same) return { error: `${A}은(는) 이미 ${periodText(same.fromDate, same.toDate)}에 대리(${name(same.substituteId)})가 등록되어 있습니다. 기간이 겹치지 않게 하세요.`, warnings }
  const ex = o.exceptions.find((x) => x.personId === input.substituteId && overlap(x))
  if (ex) return { error: `${S}은(는) 그 기간에 예외자(${ex.reason || '사유 없음'} · ${periodText(ex.fromDate, ex.toDate)})라 대리자가 될 수 없습니다.`, warnings }
  const away = others.find((x) => x.personId === input.substituteId)
  if (away) return { error: `${S}도 그 기간에 부재(${periodText(away.fromDate, away.toDate)}, 대리 ${name(away.substituteId)})라 대리자가 될 수 없습니다.`, warnings }
  const covering = others.find((x) => x.substituteId === input.personId)
  if (covering) return { error: `${A}은(는) 그 기간에 ${name(covering.personId)}의 대리자입니다. 그 대리를 먼저 고치거나 지우세요.`, warnings }

  const teamA = o.teams.find((t) => t.members.includes(input.personId))
  if (teamA) {
    const own = [...new Set(o.assignments.filter((a) => a.teamId === teamA.id && a.personId === input.substituteId).map((a) => rolePath(o.roles, a.roleId)))].filter(Boolean)
    if (own.length) warnings.push(`${S}은(는) 같은 조(${teamA.name})에서 "${own.slice(0, 3).join('", "')}"도 맡고 있어, 그 기간에는 두 임무를 함께 맡습니다.`)
  }
  const commons = o.common.filter((c) => c.assign.some((a) => a.personId === input.substituteId && (!c.perTeam || a.teamId === teamA?.id))).map((c) => c.name)
  if (commons.length) warnings.push(`${S}은(는) 공통업무 ${commons.join(', ')}도 맡고 있습니다.`)
  for (const x of others.filter((y) => y.substituteId === input.substituteId)) warnings.push(`${S}은(는) ${periodText(x.fromDate, x.toDate)}에 ${name(x.personId)}의 대리도 맡고 있습니다.`)
  if (o.people.find((p) => p.id === input.substituteId)?.temp) warnings.push(`${S}은(는) 미등록 인원이라 훈련에는 참가하지 못합니다. 그 기간에 시작하는 훈련에서 ${A}의 자리는 비게 됩니다.`)
  if (!teamA && !o.common.some((c) => c.assign.some((a) => a.personId === input.personId))) warnings.push(`${A}은(는) 조·공통업무에 들어 있지 않아 대신 맡을 것이 없습니다.`)
  return { error: '', warnings }
}

/** A substitution that keeps somebody from being put on exception for a period (they cover for someone then). */
export function coveringIn(list: CmdSubstitution[], substituteId: string, fromDate: string, toDate: string | null): CmdSubstitution | undefined {
  return list.find((x) => x.substituteId === substituteId && periodsOverlap(x.fromDate, x.toDate, fromDate, toDate))
}

export interface Headcount {
  teams: { teamId: string; members: number; temps: number; placed: number; unplaced: number; absent: number }[]
  common: number
  exceptions: number
  /** absent people whose places a substitute takes that day */
  substitutions: number
  /** members of the host in no 조 and not excepted */
  outside: number
  total: number
}

/**
 * 인원총괄현황 for one mode (placed/unplaced depend on the mode). An absent person with a
 * substitute stays a member of their 조 and counts as placed (their places are filled); the
 * 공통업무 count is of the people doing it that day.
 */
export function headcount(o: { teams: CmdTeam[]; people: CmdPerson[]; assignments: CmdAssignment[]; roles: CmdRole[]; common: CmdCommon[]; exceptions: CmdException[]; substitutions?: CmdSubstitution[]; modeId: string; today: string }): Headcount {
  const modeRoles = new Set(o.roles.filter((r) => r.modeId === o.modeId).map((r) => r.id))
  const placed = new Set(o.assignments.filter((a) => modeRoles.has(a.roleId)).map((a) => `${a.teamId}|${a.personId}`))
  const excepted = new Set(activeExceptions(o.exceptions, o.today).map((e) => e.personId))
  const subs = activeSubstitutions(o.substitutions ?? [], o.today).filter((x) => !excepted.has(x.personId))
  const absent = new Set(subs.map((x) => x.personId))
  const inTeam = new Set(o.teams.flatMap((t) => t.members))
  // people of a host's list (e.g. 식수관리 등록자) count only once they have a place here
  const used = new Set([...inTeam, ...excepted, ...o.common.flatMap((c) => c.assign.map((a) => a.personId)), ...(o.substitutions ?? []).flatMap((y) => [y.personId, y.substituteId])])
  const temp = new Set(o.people.filter((p) => p.temp && (!p.source || used.has(p.id))).map((p) => p.id))
  const teams = o.teams.map((t) => {
    const ms = t.members.filter((p) => !excepted.has(p))
    const placedN = ms.filter((p) => placed.has(`${t.id}|${p}`)).length
    return { teamId: t.id, members: ms.length, temps: ms.filter((p) => temp.has(p)).length, placed: placedN, unplaced: ms.length - placedN, absent: ms.filter((p) => absent.has(p)).length }
  })
  const common = new Set(effectiveCommon(o.common, subs).flatMap((c) => c.assign.map((a) => a.personId)).filter((p) => !excepted.has(p))).size
  const outside = o.people.filter((p) => !p.temp && !inTeam.has(p.id) && !excepted.has(p.id)).length
  return { teams, common, exceptions: excepted.size, substitutions: subs.length, outside, total: o.people.filter((p) => !p.temp).length + temp.size }
}

// ---------- drills ----------
/** Minutes of the drill that have run (pauses left out). */
export function drillElapsedMs(d: Pick<Drill, 'state' | 'startedAt' | 'pausedAt' | 'pausedMs' | 'endedAt'>, now: number): number {
  if (!d.startedAt) return 0
  const end = d.state === 'ended' ? (d.endedAt ?? now) : d.state === 'paused' ? (d.pausedAt ?? now) : now
  return Math.max(0, end - d.startedAt - d.pausedMs)
}

/** The members who are to handle a message: by role (and what is under it), by person, or everybody. */
export function resolveTargets(m: Pick<DrillMsg, 'targetKind' | 'targetIds' | 'handling'>, members: DrillMember[], roles: CmdRole[]): string[] {
  if (m.handling === 'all' || m.targetKind === 'all') return members.map((x) => x.memberId)
  if (m.targetKind === 'person') return members.filter((x) => m.targetIds.includes(x.memberId)).map((x) => x.memberId)
  const wanted = new Set<string>()
  for (const id of m.targetIds) for (const r of roleWithChildren(roles, id)) wanted.add(r)
  return members.filter((x) => x.roleIds.some((r) => wanted.has(r))).map((x) => x.memberId)
}

/** May this member answer this message now? Returns '' or why not. */
export function answerRefusal(m: Pick<DrillMsg, 'handling' | 'targets' | 'answers' | 'sentAt' | 'skipped'>, memberId: string, isParticipant: boolean): string {
  if (!m.sentAt || m.skipped) return '아직 보내지 않은 메시지입니다.'
  if (!isParticipant) return '이 훈련의 참가자가 아닙니다.'
  if (m.handling === 'assigned' && !m.targets.includes(memberId)) return '이 메시지의 처리 담당이 아닙니다.'
  if (m.handling === 'first' && m.answers.some((a) => a.memberId !== memberId)) return '다른 사람이 이미 처리했습니다.'
  return ''
}

/** Nothing left to answer. */
export function msgDone(m: Pick<DrillMsg, 'handling' | 'targets' | 'answers'>): boolean {
  if (m.handling === 'first') return m.answers.length > 0
  return m.targets.length > 0 && m.targets.every((t) => m.answers.some((a) => a.memberId === t))
}

/** Must this member still answer? */
export function waitsFor(m: Pick<DrillMsg, 'handling' | 'targets' | 'answers' | 'sentAt' | 'skipped'>, memberId: string): boolean {
  if (!m.sentAt || m.skipped) return false
  if (m.handling === 'first') return !m.answers.length && m.targets.includes(memberId)
  return m.targets.includes(memberId) && !m.answers.some((a) => a.memberId === memberId)
}

/** The marks as they were at `at` (every version is kept with createdAt/removedAt). */
export function marksAt(marks: Mark[], at: number): Mark[] {
  return marks.filter((m) => (m.createdAt ?? 0) <= at && (m.removedAt == null || m.removedAt > at))
}

/** Applies map changes to the current marks: returns the versions to add and the ids to close. */
export function applyMarkChanges(current: Mark[], changes: MarkChange[], newId: () => string): { add: Mark[]; close: string[] } {
  const add: Mark[] = []
  const close: string[] = []
  for (const c of changes) {
    if (c.op === 'add') add.push({ ...c.mark, id: newId() })
    else {
      const cur = current.find((m) => m.key === c.key && m.removedAt == null)
      if (!cur) continue
      close.push(cur.id)
      if (c.op === 'move') add.push({ ...cur, id: newId(), points: c.points, removedAt: null })
    }
  }
  return { add, close }
}

const emptyGrades = (): Record<Grade, number> => ({ good: 0, fair: 0, poor: 0 })

/** 결과 요약: by person and by role (the roles a person holds in the drill). */
export function drillSummary(d: Pick<Drill, 'members' | 'messages'>, roles: CmdRole[]): { people: SummaryRow[]; roles: SummaryRow[]; total: SummaryRow } {
  const sent = d.messages.filter((m) => m.sentAt && !m.skipped)
  const row = (key: string, name: string): SummaryRow & { secs: number[] } => ({ key, name, received: 0, answered: 0, late: 0, avgSeconds: null, grades: emptyGrades(), choiceAsked: 0, choiceRight: 0, secs: [] })
  const people = new Map(d.members.map((m) => [m.memberId, row(m.memberId, m.name)]))
  const byRole = new Map<string, ReturnType<typeof row>>()
  const total = row('total', '전체')
  const add = (r: ReturnType<typeof row>, m: DrillMsg, memberId: string): void => {
    r.received++
    const a = m.answers.find((x) => x.memberId === memberId)
    if (!a) return
    r.answered++
    if (a.late) r.late++
    r.secs.push(a.seconds)
    if (a.grade) r.grades[a.grade]++
    if (m.answerKind === 'choice' && m.correctIndex != null) {
      r.choiceAsked++
      if (a.choiceIndex === m.correctIndex) r.choiceRight++
    }
  }
  for (const m of sent) {
    // who received it: the targets; for "anybody first", whoever answered counts too
    const who = new Set(m.targets)
    if (m.handling === 'first') for (const a of m.answers) who.add(a.memberId)
    for (const id of who) {
      const p = people.get(id)
      if (p) add(p, m, id)
      add(total, m, id)
      const member = d.members.find((x) => x.memberId === id)
      for (const rid of member?.roleIds ?? []) {
        let r = byRole.get(rid)
        if (!r) byRole.set(rid, (r = row(rid, rolePath(roles, rid) || '(지운 분류)')))
        add(r, m, id)
      }
    }
  }
  const fin = (r: ReturnType<typeof row>): SummaryRow => {
    const { secs, ...rest } = r
    return { ...rest, avgSeconds: secs.length ? Math.round(secs.reduce((s, x) => s + x, 0) / secs.length) : null }
  }
  return { people: [...people.values()].map(fin), roles: [...byRole.values()].map(fin), total: fin(total) }
}

/** "3분 20초" */
export function formatSeconds(s: number | null): string {
  if (s == null) return '-'
  const m = Math.floor(s / 60)
  return m ? `${m}분 ${s % 60}초` : `${s}초`
}

/** "01:05:30" */
export function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}
