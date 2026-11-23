import { z } from 'zod'
import { scopeSchema, type ScopeDto } from './scope'
import { DUTY_TYPE_NAMES } from './duty'

/** The same list as the 근무현황 screen: both write the same absence events. */
export const ABSENCE_TYPES: readonly string[] = DUTY_TYPE_NAMES

export const eventInputSchema = z
  .object({
    kind: z.enum(['team', 'absence']).default('team'),
    title: z.string().trim().min(1, '제목을 입력하세요').max(120),
    bodyHtml: z.string().max(500_000).default(''),
    startAt: z.number().int(),
    endAt: z.number().int(),
    allDay: z.boolean().default(false),
    rrule: z.string().max(300).nullable().default(null),
    location: z.string().trim().max(120).default(''),
    absenceType: z.string().max(20).nullable().default(null),
    reminders: z.array(z.number().int().min(0).max(60 * 24 * 14)).max(5).default([]),
    scope: scopeSchema,
    attendeeIds: z.array(z.string()).max(300).default([])
  })
  .refine((e) => e.endAt >= e.startAt, { message: '끝나는 시각이 시작보다 빠릅니다.', path: ['endAt'] })
export type EventInput = z.input<typeof eventInputSchema>

export const eventPatchSchema = z.object({
  mode: z.enum(['all', 'this', 'following']).default('all'),
  occurrenceStart: z.number().int().optional(),
  title: z.string().trim().min(1).max(120).optional(),
  bodyHtml: z.string().max(500_000).optional(),
  startAt: z.number().int().optional(),
  endAt: z.number().int().optional(),
  allDay: z.boolean().optional(),
  rrule: z.string().max(300).nullable().optional(),
  location: z.string().trim().max(120).optional(),
  absenceType: z.string().max(20).nullable().optional(),
  reminders: z.array(z.number().int().min(0).max(60 * 24 * 14)).max(5).optional(),
  scope: scopeSchema.optional(),
  attendeeIds: z.array(z.string()).max(300).optional()
})

export type EventKind = 'team' | 'absence' | 'busy'

/** One occurrence in a date range (recurring events are expanded on the server). */
export interface EventOccurrenceDto {
  id: string
  key: number
  start: number
  end: number
  allDay: boolean
  title: string
  kind: EventKind
  location: string | null
  absenceType: string | null
  recurring: boolean
  authorId: string
  authorName: string
  color: string | null
  scope: ScopeDto
  attendeeCount: number
  myResponse: 'none' | 'yes' | 'no' | 'maybe' | null
  reminders: number[]
}

export interface EventDto {
  id: string
  kind: EventKind
  title: string
  bodyHtml: string
  startAt: number
  endAt: number
  allDay: boolean
  rrule: string | null
  exdates: number[]
  location: string | null
  absenceType: string | null
  reminders: number[]
  scope: ScopeDto
  authorId: string
  authorName: string
  attendees: { memberId: string; name: string; response: 'none' | 'yes' | 'no' | 'maybe' }[]
  createdAt: number
}

export interface HolidayDto {
  date: string
  name: string
}

export const worklogInputSchema = z.object({
  doneHtml: z.string().max(500_000).default(''),
  todoHtml: z.string().max(500_000).default(''),
  notesHtml: z.string().max(500_000).default(''),
  scope: scopeSchema
})

export interface WorklogDto {
  id: string
  memberId: string
  memberName: string
  deptName: string | null
  date: string
  doneHtml: string
  todoHtml: string
  notesHtml: string
  scope: ScopeDto
  updatedAt: number
}
