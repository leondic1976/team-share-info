import type { CmdPerson, CmdRole, CmdSubstitution, CommandState } from '../shared/types'
import { activeExceptions, activeSubstitutions, effectiveAssignments, effectiveCommon, roleTree, teamAt, ymd, type EffCommon, type Shift } from '../shared/logic'

/** A person in a place as it is filled today: `cover` when they stand in for an absent person. */
export interface PlacedNow {
  p: CmdPerson
  cover?: CmdSubstitution
}

/** Lookups worked out once from the state. */
export interface Model {
  s: CommandState
  person: (id: string) => CmdPerson | undefined
  team: (id: string | null | undefined) => CommandState['teams'][number] | undefined
  /** the people of a role in a 조 (as placed in 설정, without substitutes) */
  placed: (roleId: string, teamId: string) => CmdPerson[]
  /** the people of a role in a 조 today: an absent person's place shows their substitute */
  placedNow: (roleId: string, teamId: string) => PlacedNow[]
  /** 공통업무 as done today (absent people swapped for their substitutes) */
  commonNow: EffCommon[]
  /** the 조 of a person */
  teamOf: (personId: string) => string | null
  /** roles (of a mode) a person holds in their 조 */
  rolesOf: (personId: string, modeId: string) => CmdRole[]
  tree: (modeId: string) => { role: CmdRole; depth: number }[]
  excepted: Set<string>
  /** substitutions in force today, by the absent person */
  absent: Map<string, CmdSubstitution>
  shift: Shift | null
  next: Shift | null
  modes: CommandState['modes']
}

export function buildModel(s: CommandState, now: number): Model {
  const people = new Map(s.people.map((p) => [p.id, p]))
  const teams = new Map(s.teams.map((t) => [t.id, t]))
  const teamOf = new Map<string, string>()
  for (const t of s.teams) for (const p of t.members) teamOf.set(p, t.id)
  const shift = teamAt(s.rotation, s.overrides, now)
  const today = ymd(now)
  const excepted = new Set(activeExceptions(s.exceptions, today).map((e) => e.personId))
  // a substitute that is gone (a temporary person removed) leaves the place as it was
  const subs = activeSubstitutions(s.substitutions, today).filter((x) => people.has(x.substituteId) && !excepted.has(x.personId))
  const eff = effectiveAssignments(s.assignments, subs)
  return {
    s,
    person: (id) => people.get(id),
    team: (id) => (id ? teams.get(id) : undefined),
    placed: (roleId, teamId) => s.assignments.filter((a) => a.roleId === roleId && a.teamId === teamId).map((a) => people.get(a.personId)).filter((p): p is CmdPerson => !!p),
    placedNow: (roleId, teamId) =>
      eff
        .filter((a) => a.roleId === roleId && a.teamId === teamId)
        .flatMap((a): PlacedNow[] => {
          const p = people.get(a.personId)
          return p ? [{ p, cover: a.cover }] : []
        }),
    commonNow: effectiveCommon(s.common, subs),
    teamOf: (id) => teamOf.get(id) ?? null,
    rolesOf: (id, modeId) => {
      const t = teamOf.get(id)
      const ids = new Set(s.assignments.filter((a) => a.personId === id && a.teamId === t).map((a) => a.roleId))
      return s.roles.filter((r) => r.modeId === modeId && ids.has(r.id))
    },
    tree: (modeId) => roleTree(s.roles, modeId),
    excepted,
    absent: new Map(subs.map((x) => [x.personId, x])),
    shift,
    next: shift ? teamAt(s.rotation, s.overrides, shift.to) : null,
    modes: s.modes.filter((m) => !m.hidden)
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')
const WD = ['일', '월', '화', '수', '목', '금', '토']
/** "11/23(월) 09:00" */
export function when(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** "14:05" */
export const hm = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const ymdOf = ymd
