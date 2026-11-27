import { buildOrgTree, flattenOrg } from './org'
import type { DepartmentDto } from './schemas/org'
import type { DutyEntryDto } from './schemas/duty'
import type { PluginPermission } from './schemas/plugins'

/**
 * The pure part of the plugin bridge (PluginHost): which permission each TeamHub.call method
 * needs, and the shapes some calls hand to the frame. Kept here so it can be unit-tested.
 */

/** Which permission each bridge method needs (manifest.permissions); null = every extension may. */
export const BRIDGE_NEEDS: Record<string, PluginPermission | null> = {
  me: null,
  time: null,
  holidays: null,
  members: 'members',
  unregistered: 'members',
  departments: 'members',
  absences: 'duty',
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.keys': 'storage',
  'rooms.list': 'rooms',
  'rooms.get': 'rooms',
  'rooms.create': 'rooms',
  'rooms.setShared': 'rooms',
  'rooms.setEntry': 'rooms',
  'rooms.delete': 'rooms',
  notify: 'notify',
  'clipboard.write': 'clipboard',
  'file.save': 'files',
  'file.open': 'files',
  'ocr.recognize': 'ocr',
  'copilot.open': 'copilot',
  'pii.scan': null,
  openRoute: null
}

/** Why a call is refused before it runs, or null when the extension may make it. */
export function bridgeRefusal(method: string, perms: ReadonlySet<string>): string | null {
  if (!Object.hasOwn(BRIDGE_NEEDS, method)) return `알 수 없는 기능: ${method}`
  const need = BRIDGE_NEEDS[method]
  if (need && !perms.has(need)) return `권한이 없습니다(${need}). 확장 기능 정보에 권한이 선언되어야 합니다.`
  return null
}

/** The longest range of one 'absences' call, in days (the same limit as 근무현황, GET /api/duty). */
export const ABSENCE_RANGE_DAYS = 100
const DAY_MS = 86400000

const localMidnight = (date: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d.getTime() : null
}

/** 'YYYY-MM-DD' to 'YYYY-MM-DD' (both days included) as the ms range of GET /api/duty. */
export function absenceRange(from: string, to: string): { from: number; to: number } {
  const a = localMidnight(from)
  const b = localMidnight(to)
  if (a === null || b === null || b < a) throw new Error('조회 기간이 올바르지 않습니다.')
  const end = new Date(b)
  end.setDate(end.getDate() + 1)
  if (Math.round((end.getTime() - a) / DAY_MS) > ABSENCE_RANGE_DAYS) throw new Error(`조회 기간이 너무 깁니다(${ABSENCE_RANGE_DAYS}일까지).`)
  return { from: a, to: end.getTime() }
}

/** One absence as an extension sees it: no place, note or who recorded it. */
export interface PluginAbsence {
  memberId: string
  type: string
  start: number
  end: number
  allDay: boolean
}

/** The entries of 근무현황 (active members only, repeats already expanded by the server) for a frame. */
export const pluginAbsences = (entries: DutyEntryDto[]): PluginAbsence[] => entries.map((e) => ({ memberId: e.memberId, type: e.type, start: e.start, end: e.end, allDay: e.allDay }))

/** A department as an extension sees it, in the order of the org chart (직제순). */
export interface PluginDepartment {
  id: string
  name: string
  /** names from the top department down to this one */
  path: string[]
  /** 0, 1, 2 … top-down through the tree: a department before those below it, siblings as an admin set them */
  order: number
}

/** The departments in org-chart order (설정 → 조직 관리): depth first, siblings by their order, then by name. */
export function orderedDepartments(depts: Pick<DepartmentDto, 'id' | 'name' | 'parentId' | 'sort'>[]): PluginDepartment[] {
  const out: PluginDepartment[] = []
  const paths = new Map<string, string[]>()
  for (const n of flattenOrg(buildOrgTree(depts as DepartmentDto[], []).roots)) {
    const parent = n.depth > 0 && n.dept.parentId ? paths.get(n.dept.parentId) : undefined
    const path = [...(parent ?? []), n.dept.name]
    paths.set(n.dept.id, path)
    out.push({ id: n.dept.id, name: n.dept.name, path, order: out.length })
  }
  return out
}
