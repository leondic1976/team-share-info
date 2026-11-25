import { z } from 'zod'

/**
 * 근무현황: who is away from the office on a day, by department. An entry is an absence
 * event of the calendar (events.kind = 'absence'), so the calendar, the presence dot and
 * this screen always show the same thing.
 */
export type DutyGroup = 'leave' | 'sick' | 'official' | 'trip' | 'edu' | 'remote' | 'long' | 'etc'

export const DUTY_TYPES: { name: string; group: DutyGroup }[] = [
  { name: '연가', group: 'leave' },
  { name: '반가', group: 'leave' },
  { name: '병가', group: 'sick' },
  { name: '공가', group: 'official' },
  { name: '특별휴가', group: 'leave' },
  { name: '출장', group: 'trip' },
  { name: '외근', group: 'trip' },
  { name: '교육', group: 'edu' },
  { name: '재택근무', group: 'remote' },
  { name: '유연근무', group: 'remote' },
  { name: '대체휴무', group: 'leave' },
  { name: '휴직', group: 'long' },
  { name: '파견', group: 'long' },
  { name: '기타', group: 'etc' }
]
export const DUTY_TYPE_NAMES = DUTY_TYPES.map((t) => t.name)

/** Names used before this list (calendar absences made by older versions) keep a colour. */
const LEGACY: Record<string, DutyGroup> = { 휴가: 'leave', 반차: 'leave' }
export const dutyGroupOf = (type: string): DutyGroup => DUTY_TYPES.find((t) => t.name === type)?.group ?? LEGACY[type] ?? 'etc'

/** Mid-tone colours that read on a light and on a dark background. */
export const DUTY_COLORS: Record<DutyGroup, string> = {
  leave: '#3b82f6',
  sick: '#ef4444',
  official: '#8b5cf6',
  trip: '#f59e0b',
  edu: '#10b981',
  remote: '#14b8a6',
  long: '#64748b',
  etc: '#64748b'
}

export const DUTY_MAX_SPAN_MS = 1100 * 86400000

export const dutyInputSchema = z
  .object({
    /** whose entry; left out = my own. Someone else's needs an admin or a 서무. */
    memberId: z.string().optional(),
    type: z.string().trim().min(1, '종류를 고르세요').max(20),
    startAt: z.number().int(),
    endAt: z.number().int(),
    allDay: z.boolean().default(true),
    place: z.string().trim().max(120).default(''),
    note: z.string().trim().max(120).default('')
  })
  .refine((e) => e.endAt > e.startAt, { message: '끝나는 때가 시작보다 빠릅니다.', path: ['endAt'] })
  .refine((e) => e.endAt - e.startAt <= DUTY_MAX_SPAN_MS, { message: '기간이 너무 깁니다(3년까지).', path: ['endAt'] })
export type DutyInput = z.input<typeof dutyInputSchema>

/** One absence in the asked range (a repeating calendar absence comes as one entry per occurrence). */
export interface DutyEntryDto {
  id: string
  key: number
  memberId: string
  type: string
  start: number
  end: number
  allDay: boolean
  place: string
  note: string
  /** made in the calendar with a repeat rule: changed there, not here */
  recurring: boolean
  /** set when somebody else (admin, 서무) recorded it for the member */
  registeredByName: string | null
}

export interface DutyMemberDto {
  id: string
  name: string
  title: string | null
  deptId: string | null
}

export interface DutyBoardDto {
  /** the server's departments as listed for the org chart (headId: 부서장, shown first in a department) */
  departments: { id: string; name: string; parentId: string | null; sort: number; headId?: string | null }[]
  members: DutyMemberDto[]
  entries: DutyEntryDto[]
  /** members who may record for others besides the admins (서무) */
  clerkIds: string[]
  /** I may record, change and delete entries of other members */
  canManage: boolean
}

/** Does the entry touch the day that starts at `dayStart` (local midnight)? */
export const onDay = (e: Pick<DutyEntryDto, 'start' | 'end'>, dayStart: number, dayEnd: number): boolean => e.start < dayEnd && e.end > dayStart

const hm = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** The part of the entry inside one day: "종일", "09:00~13:00", "14:00~" (goes on), "~11:00" (began earlier). */
export function dayPart(e: Pick<DutyEntryDto, 'start' | 'end' | 'allDay'>, dayStart: number, dayEnd: number): string {
  const from = e.start > dayStart
  const to = e.end < dayEnd
  if (e.allDay || (!from && !to)) return '종일'
  return `${from ? hm(e.start) : ''}~${to ? hm(e.end) : ''}`
}
