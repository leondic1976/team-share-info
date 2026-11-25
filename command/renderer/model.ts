import type { CmdPerson, CmdRole, CommandState } from '../shared/types'
import { activeExceptions, roleTree, teamAt, ymd, type Shift } from '../shared/logic'

/** Lookups worked out once from the state. */
export interface Model {
  s: CommandState
  person: (id: string) => CmdPerson | undefined
  team: (id: string | null | undefined) => CommandState['teams'][number] | undefined
  /** the people of a role in a 조 */
  placed: (roleId: string, teamId: string) => CmdPerson[]
  /** the 조 of a person */
  teamOf: (personId: string) => string | null
  /** roles (of a mode) a person holds in their 조 */
  rolesOf: (personId: string, modeId: string) => CmdRole[]
  tree: (modeId: string) => { role: CmdRole; depth: number }[]
  excepted: Set<string>
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
  return {
    s,
    person: (id) => people.get(id),
    team: (id) => (id ? teams.get(id) : undefined),
    placed: (roleId, teamId) => s.assignments.filter((a) => a.roleId === roleId && a.teamId === teamId).map((a) => people.get(a.personId)).filter((p): p is CmdPerson => !!p),
    teamOf: (id) => teamOf.get(id) ?? null,
    rolesOf: (id, modeId) => {
      const t = teamOf.get(id)
      const ids = new Set(s.assignments.filter((a) => a.personId === id && a.teamId === t).map((a) => a.roleId))
      return s.roles.filter((r) => r.modeId === modeId && ids.has(r.id))
    },
    tree: (modeId) => roleTree(s.roles, modeId),
    excepted: new Set(activeExceptions(s.exceptions, ymd(now)).map((e) => e.personId)),
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
