/**
 * 긴급구조지휘대: reading and writing command.db, with the rules of the 편성 (one 조 per person,
 * one role per person in a 조 and 근무 유형, people on exception are in no 조) and of drills.
 */
import type { CmdDb } from './sqlite'
import { newId, parseJson } from './sqlite'
import type { CommandGuest, CommandMember } from './host'
import type {
  CmdAssignment,
  CmdCommon,
  CmdDrillBrief,
  CmdException,
  CmdManager,
  CmdMode,
  CmdOverride,
  CmdPerson,
  CmdRole,
  CmdRotation,
  CmdTeam,
  Drill,
  DrillAnswer,
  DrillMember,
  DrillMsg,
  DrillNote,
  DrillState,
  Grade,
  MapData,
  Mark,
  Scenario,
  ScenarioBrief,
  ScenarioMsg
} from '../shared/types'
import { activeExceptions, msgDone, resolveTargets, ymd } from '../shared/logic'

export const TEMP = 'x:'
export const isTemp = (id: string): boolean => id.startsWith(TEMP)
/** somebody of the host's own list (CommandServerHost.guests): 'g:' + their id there */
export const GUEST = 'g:'
export const isGuest = (id: string): boolean => id.startsWith(GUEST)

/** The host's list as read for one request. */
export interface GuestList {
  label: string
  where: string
  list: CommandGuest[]
}
/** Tables that hold a person id. */
export const PERSON_TABLES = ['cmd_team_members', 'cmd_assignments', 'cmd_common_assign', 'cmd_exceptions'] as const
const activeGuest = (g: CommandGuest): boolean => !g.gone && !g.as

// ---------- 편성 ----------
export function managers(db: CmdDb, members: CommandMember[]): CmdManager[] {
  const byId = new Map(members.map((m) => [m.id, m]))
  return db
    .all<{ member_id: string }>('SELECT member_id FROM cmd_managers ORDER BY assigned_at')
    .filter((r) => byId.has(r.member_id))
    .map((r) => ({ memberId: r.member_id, name: byId.get(r.member_id)!.name }))
}

export const isManagerId = (db: CmdDb, memberId: string): boolean => !!db.get('SELECT 1 FROM cmd_managers WHERE member_id = ?', [memberId])

export function modes(db: CmdDb): CmdMode[] {
  return db.all<{ id: string; name: string; sort: number; hidden: number }>('SELECT id, name, sort, hidden FROM cmd_modes ORDER BY sort, created_at').map((r) => ({ id: r.id, name: r.name, sort: r.sort, hidden: !!r.hidden }))
}

export function teams(db: CmdDb): CmdTeam[] {
  const members = db.all<{ person_id: string; team_id: string }>('SELECT person_id, team_id FROM cmd_team_members ORDER BY sort, rowid')
  return db.all<{ id: string; name: string; color: string; sort: number }>('SELECT id, name, color, sort FROM cmd_teams ORDER BY sort, created_at').map((t) => ({ ...t, members: members.filter((m) => m.team_id === t.id).map((m) => m.person_id) }))
}

export function roles(db: CmdDb): CmdRole[] {
  return db
    .all<{ id: string; mode_id: string; parent_id: string | null; name: string; sort: number; has_duty: number }>("SELECT id, mode_id, parent_id, name, sort, CASE WHEN LENGTH(duty_html) > 0 THEN 1 ELSE 0 END AS has_duty FROM cmd_roles ORDER BY sort, created_at")
    .map((r) => ({ id: r.id, modeId: r.mode_id, parentId: r.parent_id, name: r.name, sort: r.sort, hasDuty: !!r.has_duty }))
}

export function assignments(db: CmdDb): CmdAssignment[] {
  return db.all<{ role_id: string; team_id: string; person_id: string }>('SELECT role_id, team_id, person_id FROM cmd_assignments ORDER BY sort, rowid').map((r) => ({ roleId: r.role_id, teamId: r.team_id, personId: r.person_id }))
}

export function common(db: CmdDb): CmdCommon[] {
  const assign = db.all<{ common_id: string; team_id: string; person_id: string }>('SELECT common_id, team_id, person_id FROM cmd_common_assign ORDER BY rowid')
  return db
    .all<{ id: string; name: string; description: string; per_team: number; sort: number }>('SELECT id, name, description, per_team, sort FROM cmd_common ORDER BY sort, created_at')
    .map((c) => ({ id: c.id, name: c.name, description: c.description, perTeam: !!c.per_team, sort: c.sort, assign: assign.filter((a) => a.common_id === c.id).map((a) => ({ teamId: a.team_id, personId: a.person_id })) }))
}

export function exceptions(db: CmdDb): CmdException[] {
  return db.all<{ id: string; person_id: string; reason: string; from_date: string; to_date: string | null }>('SELECT id, person_id, reason, from_date, to_date FROM cmd_exceptions ORDER BY from_date DESC, created_at DESC').map((e) => ({ id: e.id, personId: e.person_id, reason: e.reason, fromDate: e.from_date, toDate: e.to_date }))
}

export function overrides(db: CmdDb): CmdOverride[] {
  return db.all<{ id: string; from_at: number; to_at: number; team_id: string; note: string; created_at: number }>('SELECT * FROM cmd_overrides ORDER BY from_at').map((o) => ({ id: o.id, fromAt: o.from_at, toAt: o.to_at, teamId: o.team_id, note: o.note, createdAt: o.created_at }))
}

export function rotation(db: CmdDb): CmdRotation | null {
  const r = parseJson<CmdRotation | null>(db.get<{ value: string }>('SELECT value FROM cmd_settings WHERE key = ?', ['rotation'])?.value, null)
  return r && r.order ? r : null
}

/**
 * Everybody the screens may show: members, the host's list now (미등록), and - still placed
 * here - those taken off that list and 임시 인원 of before not moved to it yet.
 */
export function people(db: CmdDb, members: CommandMember[], guests: GuestList | null = null): CmdPerson[] {
  const temps = db.all<{ id: string; name: string; title: string; memo: string }>('SELECT id, name, title, memo FROM cmd_people ORDER BY created_at')
  const out: CmdPerson[] = [
    ...members.map((m) => ({ id: m.id, name: m.name, title: m.title, dept: m.dept, temp: false, ...(m.mark ? { mark: m.mark } : {}) })),
    // with a list of the host, the module's own 임시 인원 wait to be moved there (moveOldTemps)
    ...temps.map((t): CmdPerson => ({ id: TEMP + t.id, name: t.name, title: t.title, dept: '', temp: true, memo: t.memo, ...(guests ? { left: 'old' as const } : {}) }))
  ]
  if (!guests) return out
  const byId = new Map(guests.list.map((g) => [GUEST + g.id, g]))
  const shown = new Set<string>()
  for (const [id, g] of byId) {
    if (!activeGuest(g)) continue
    out.push({ id, name: g.name, title: g.title, dept: g.dept, temp: true, memo: g.memo, source: guests.label })
    shown.add(id)
  }
  for (const id of usedGuestIds(db)) {
    if (shown.has(id)) continue
    const g = byId.get(id)
    out.push({ id, name: g?.name || '(알 수 없음)', title: g?.title ?? '', dept: g?.dept ?? '', temp: true, memo: g?.memo ?? '', source: guests.label, left: 'removed' })
  }
  return out
}

/** Every 'g:' person id that has a place (조, 배치, 공통업무, 예외). */
export function usedGuestIds(db: CmdDb): string[] {
  const ids = new Set<string>()
  for (const t of PERSON_TABLES) for (const r of db.all<{ person_id: string }>(`SELECT DISTINCT person_id FROM ${t} WHERE person_id LIKE 'g:%'`)) ids.add(r.person_id)
  return [...ids]
}

/** The 조 a person is in (or null). */
export const teamOf = (db: CmdDb, personId: string): string | null => db.get<{ team_id: string }>('SELECT team_id FROM cmd_team_members WHERE person_id = ?', [personId])?.team_id ?? null

/**
 * A person may be given a new place: an active member, somebody on the host's list now (not
 * one who left it), or - only without such a list - an existing temporary person.
 */
export function personExists(db: CmdDb, members: CommandMember[], id: string, guests: GuestList | null = null): boolean {
  if (isTemp(id)) return !guests && !!db.get('SELECT 1 FROM cmd_people WHERE id = ?', [id.slice(TEMP.length)])
  if (isGuest(id)) return !!guests?.list.some((g) => GUEST + g.id === id && activeGuest(g))
  return members.some((m) => m.id === id)
}

// ---------- notices ----------
export function unreadNotices(db: CmdDb, memberId: string): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cmd_notices n WHERE n.deleted_at IS NULL AND n.created_by != ? AND NOT EXISTS (SELECT 1 FROM cmd_notice_reads r WHERE r.notice_id = n.id AND r.member_id = ?)', [memberId, memberId])?.n ?? 0
}

// ---------- scenarios ----------
interface ScenarioRow {
  id: string
  mode_id: string
  title: string
  summary_html: string
  target_html: string
  map: string
  messages: string
  created_by: string
  created_by_name: string
  created_at: number
  updated_at: number
}
export const emptyMap = (): MapData => ({ imageId: null, width: 0, height: 0, marks: [] })

export function scenario(db: CmdDb, id: string): Scenario | null {
  const r = db.get<ScenarioRow>('SELECT * FROM cmd_scenarios WHERE id = ? AND deleted_at IS NULL', [id])
  if (!r) return null
  return { id: r.id, modeId: r.mode_id, title: r.title, summaryHtml: r.summary_html, targetHtml: r.target_html, map: { ...emptyMap(), ...parseJson<Partial<MapData>>(r.map, {}) }, messages: parseJson<ScenarioMsg[]>(r.messages, []), createdBy: r.created_by, createdByName: r.created_by_name, createdAt: r.created_at, updatedAt: r.updated_at }
}

export function scenarioList(db: CmdDb): ScenarioBrief[] {
  return db.all<ScenarioRow>('SELECT * FROM cmd_scenarios WHERE deleted_at IS NULL ORDER BY updated_at DESC').map((r) => ({ id: r.id, modeId: r.mode_id, title: r.title, messages: parseJson<unknown[]>(r.messages, []).length, updatedAt: r.updated_at }))
}

// ---------- drills ----------
interface DrillRow {
  id: string
  scenario_id: string | null
  mode_id: string
  title: string
  summary_html: string
  target_html: string
  map: string
  team_ids: string
  with_common: number
  state: DrillState
  start_at: number | null
  started_at: number | null
  paused_at: number | null
  paused_ms: number
  ended_at: number | null
  review_html: string
  created_by: string
}
export const drillRow = (db: CmdDb, id: string): DrillRow | undefined => db.get<DrillRow>('SELECT * FROM cmd_drills WHERE id = ?', [id])

export function drillMembers(db: CmdDb, drillId: string): DrillMember[] {
  return db.all<{ member_id: string; name: string; title: string; team_id: string | null; role_ids: string; common: number }>('SELECT * FROM cmd_drill_members WHERE drill_id = ? ORDER BY rowid', [drillId]).map((m) => ({ memberId: m.member_id, name: m.name, title: m.title, teamId: m.team_id, roleIds: parseJson<string[]>(m.role_ids, []), common: !!m.common }))
}

interface MsgRow {
  id: string
  drill_id: string
  sort: number
  body: string
  targets: string
  sent_at: number | null
  skipped: number
  ad_hoc: number
}
type MsgBody = Omit<ScenarioMsg, 'id' | 'sort'>

export function drillMsgs(db: CmdDb, drillId: string, names: Map<string, string>): DrillMsg[] {
  const answers = db.all<{ id: string; msg_id: string; member_id: string; body: string; choice_index: number | null; answered_at: number; late: number; grade: Grade | null; comment: string; graded_by_name: string | null }>(
    'SELECT a.* FROM cmd_drill_answers a JOIN cmd_drill_msgs m ON m.id = a.msg_id WHERE m.drill_id = ? ORDER BY a.answered_at',
    [drillId]
  )
  return db.all<MsgRow>('SELECT * FROM cmd_drill_msgs WHERE drill_id = ? ORDER BY sort', [drillId]).map((r) => {
    const b = parseJson<MsgBody>(r.body, {} as MsgBody)
    const msg: DrillMsg = {
      id: r.id,
      sort: r.sort,
      ...b,
      targets: parseJson<string[]>(r.targets, []),
      sentAt: r.sent_at,
      skipped: !!r.skipped,
      adHoc: !!r.ad_hoc,
      done: false,
      answers: answers
        .filter((a) => a.msg_id === r.id)
        .map(
          (a): DrillAnswer => ({
            id: a.id,
            msgId: a.msg_id,
            memberId: a.member_id,
            name: names.get(a.member_id) ?? '(알 수 없음)',
            body: a.body,
            choiceIndex: a.choice_index,
            attachments: [],
            answeredAt: a.answered_at,
            seconds: r.sent_at ? Math.max(0, Math.round((a.answered_at - r.sent_at) / 1000)) : 0,
            late: !!a.late,
            grade: a.grade,
            comment: a.comment,
            gradedByName: a.graded_by_name
          })
        )
    }
    msg.done = msgDone(msg)
    return msg
  })
}

export function drillMarks(db: CmdDb, drillId: string): Mark[] {
  return db.all<{ id: string; key: string; data: string; created_at: number; removed_at: number | null }>('SELECT * FROM cmd_drill_marks WHERE drill_id = ? ORDER BY created_at, rowid', [drillId]).map((r) => ({ ...parseJson<Omit<Mark, 'id' | 'key'>>(r.data, {} as Mark), id: r.id, key: r.key, createdAt: r.created_at, removedAt: r.removed_at }))
}

export function drillNotes(db: CmdDb, drillId: string): DrillNote[] {
  return db.all<{ id: string; at: number; body: string; created_by_name: string }>('SELECT * FROM cmd_drill_notes WHERE drill_id = ? ORDER BY at', [drillId]).map((n) => ({ id: n.id, at: n.at, body: n.body, byName: n.created_by_name }))
}

/**
 * The drill as `viewer` may see it: messages not yet sent and the right answers of choice
 * questions stay with those in charge until the drill is over.
 */
export function drill(db: CmdDb, id: string, viewer: { id: string; manager: boolean }, attachments: (ownerId: string) => DrillAnswer['attachments'], now = Date.now()): Drill | null {
  const r = drillRow(db, id)
  if (!r) return null
  const members = drillMembers(db, id)
  const names = new Map(members.map((m) => [m.memberId, m.name]))
  let messages = drillMsgs(db, id, names)
  for (const m of messages) for (const a of m.answers) a.attachments = attachments(a.id)
  if (!viewer.manager) {
    messages = messages.filter((m) => m.sentAt && !m.skipped)
    if (r.state !== 'ended') for (const m of messages) m.correctIndex = null
    // the map changes of messages not sent stay hidden too
    for (const m of messages) if (!m.sentAt) m.mapChanges = []
  }
  const map = parseJson<{ imageId: string | null; width: number; height: number }>(r.map, { imageId: null, width: 0, height: 0 })
  return {
    id: r.id,
    scenarioId: r.scenario_id,
    modeId: r.mode_id,
    title: r.title,
    state: r.state,
    startAt: r.start_at,
    startedAt: r.started_at,
    pausedAt: r.paused_at,
    pausedMs: r.paused_ms,
    endedAt: r.ended_at,
    teamIds: parseJson<string[]>(r.team_ids, []),
    withCommon: !!r.with_common,
    summaryHtml: r.summary_html,
    targetHtml: r.target_html,
    map: { imageId: map.imageId ?? null, width: map.width ?? 0, height: map.height ?? 0 },
    marks: drillMarks(db, id),
    members,
    messages,
    notes: viewer.manager ? drillNotes(db, id) : [],
    reviewHtml: r.review_html,
    isManager: viewer.manager,
    serverNow: now
  }
}

export function drillBriefs(db: CmdDb, memberId: string): CmdDrillBrief[] {
  const rows = db.all<DrillRow>("SELECT * FROM cmd_drills WHERE state != 'ended' OR ended_at > ? ORDER BY COALESCE(started_at, start_at, created_at) DESC LIMIT 50", [Date.now() - 30 * 86400_000])
  return rows.map((r) => {
    const participant = !!db.get('SELECT 1 FROM cmd_drill_members WHERE drill_id = ? AND member_id = ?', [r.id, memberId])
    let pending = 0
    if (participant && r.state !== 'ended') {
      const msgs = drillMsgs(db, r.id, new Map())
      pending = msgs.filter((m) => m.sentAt && !m.skipped && (m.handling === 'first' ? !m.answers.length && m.targets.includes(memberId) : m.targets.includes(memberId) && !m.answers.some((a) => a.memberId === memberId))).length
    }
    return { id: r.id, title: r.title, modeId: r.mode_id, state: r.state, startAt: r.start_at, startedAt: r.started_at, endedAt: r.ended_at, teamIds: parseJson<string[]>(r.team_ids, []), pendingForMe: pending, participant }
  })
}

/** The participants of a drill, fixed when it starts: the chosen 조 (and the 공통업무 people). */
export function participants(db: CmdDb, members: CommandMember[], modeId: string, teamIds: string[], withCommon: boolean, now: number): DrillMember[] {
  const byId = new Map(members.map((m) => [m.id, m]))
  const excepted = new Set(activeExceptions(exceptions(db), ymd(now)).map((e) => e.personId))
  const modeRoles = new Set(roles(db).filter((r) => r.modeId === modeId).map((r) => r.id))
  const assigns = assignments(db).filter((a) => modeRoles.has(a.roleId))
  const out = new Map<string, DrillMember>()
  for (const t of teams(db).filter((x) => teamIds.includes(x.id))) {
    for (const p of t.members) {
      const m = byId.get(p)
      if (!m || excepted.has(p)) continue
      out.set(p, { memberId: p, name: m.name, title: m.title, teamId: t.id, roleIds: assigns.filter((a) => a.teamId === t.id && a.personId === p).map((a) => a.roleId), common: false })
    }
  }
  if (withCommon) {
    for (const c of common(db)) {
      for (const a of c.assign) {
        if (c.perTeam && !teamIds.includes(a.teamId)) continue
        const m = byId.get(a.personId)
        if (!m || excepted.has(a.personId)) continue
        const cur = out.get(a.personId)
        if (cur) cur.common = true
        else out.set(a.personId, { memberId: a.personId, name: m.name, title: m.title, teamId: teamOf(db, a.personId), roleIds: [], common: true })
      }
    }
  }
  return [...out.values()]
}

/** Who should hear about a drill as it runs: its participants and those in charge. */
export function drillAudience(db: CmdDb, drillId: string, owners: string[]): string[] {
  const ids = new Set(db.all<{ member_id: string }>('SELECT member_id FROM cmd_drill_members WHERE drill_id = ?', [drillId]).map((r) => r.member_id))
  for (const m of db.all<{ member_id: string }>('SELECT member_id FROM cmd_managers')) ids.add(m.member_id)
  for (const o of owners) ids.add(o)
  return [...ids]
}

/** The targets of a message when it is sent. */
export function targetsFor(db: CmdDb, drillId: string, m: Pick<ScenarioMsg, 'targetKind' | 'targetIds' | 'handling'>): string[] {
  return resolveTargets(m, drillMembers(db, drillId), roles(db))
}

export { newId }
