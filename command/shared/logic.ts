/**
 * 긴급구조지휘대: rules worked out the same way on the server and on the screens. Pure functions
 * (no I/O, no host), unit-tested in command/tests.
 */
import type { CmdAssignment, CmdCommon, CmdException, CmdOverride, CmdPerson, CmdRole, CmdRotation, CmdTeam, Drill, DrillMember, DrillMsg, Grade, Mark, MarkChange, SummaryRow } from './types'

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

export interface Headcount {
  teams: { teamId: string; members: number; temps: number; placed: number; unplaced: number }[]
  common: number
  exceptions: number
  /** members of the host in no 조 and not excepted */
  outside: number
  total: number
}

/** 인원총괄현황 for one mode (placed/unplaced depend on the mode). */
export function headcount(o: { teams: CmdTeam[]; people: CmdPerson[]; assignments: CmdAssignment[]; roles: CmdRole[]; common: CmdCommon[]; exceptions: CmdException[]; modeId: string; today: string }): Headcount {
  const temp = new Set(o.people.filter((p) => p.temp).map((p) => p.id))
  const modeRoles = new Set(o.roles.filter((r) => r.modeId === o.modeId).map((r) => r.id))
  const placed = new Set(o.assignments.filter((a) => modeRoles.has(a.roleId)).map((a) => `${a.teamId}|${a.personId}`))
  const excepted = new Set(activeExceptions(o.exceptions, o.today).map((e) => e.personId))
  const inTeam = new Set(o.teams.flatMap((t) => t.members))
  const teams = o.teams.map((t) => {
    const ms = t.members.filter((p) => !excepted.has(p))
    const placedN = ms.filter((p) => placed.has(`${t.id}|${p}`)).length
    return { teamId: t.id, members: ms.length, temps: ms.filter((p) => temp.has(p)).length, placed: placedN, unplaced: ms.length - placedN }
  })
  const common = new Set(o.common.flatMap((c) => c.assign.map((a) => a.personId)).filter((p) => !excepted.has(p))).size
  const outside = o.people.filter((p) => !p.temp && !inTeam.has(p.id) && !excepted.has(p.id)).length
  return { teams, common, exceptions: excepted.size, outside, total: o.people.filter((p) => !p.temp).length + temp.size }
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
