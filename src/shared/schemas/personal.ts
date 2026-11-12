import { z } from 'zod'

/** Personal (local DB) data shapes. These never travel to the server (2.3). */

export const personalEventInputSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().trim().min(1, '제목을 입력하세요').max(120),
    bodyHtml: z.string().max(500_000).default(''),
    startAt: z.number().int(),
    endAt: z.number().int(),
    allDay: z.boolean().default(false),
    rrule: z.string().max(300).nullable().default(null),
    location: z.string().trim().max(120).default(''),
    reminders: z.array(z.number().int().min(0).max(60 * 24 * 14)).max(5).default([]),
    mode: z.enum(['all', 'this', 'following']).default('all'),
    occurrenceStart: z.number().int().optional()
  })
  .refine((e) => e.endAt >= e.startAt, { message: '끝나는 시각이 시작보다 빠릅니다.', path: ['endAt'] })
export type PersonalEventInput = z.input<typeof personalEventInputSchema>

export interface PersonalEventDto {
  id: string
  title: string
  bodyHtml: string
  startAt: number
  endAt: number
  allDay: boolean
  rrule: string | null
  exdates: number[]
  location: string | null
  reminders: number[]
  busyEventId: string | null
}

export interface PersonalOccurrenceDto {
  id: string
  key: number
  start: number
  end: number
  allDay: boolean
  title: string
  location: string | null
  recurring: boolean
  reminders: number[]
  busyEventId: string | null
}

export interface DiaryEntryDto {
  id: string
  date: string
  bodyHtml: string
  tags: string[]
  updatedAt: number
}

export interface DiarySummaryDto {
  date: string
  snippet: string
  tags: string[]
}

/** Reminder computed by the renderer for server data, fired by main (13.13 timers). */
export interface ReminderItem {
  key: string
  fireAt: number
  title: string
  body: string
  route?: string
}

export const personalTaskInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1, '할 일을 입력하세요').max(200),
  note: z.string().max(5000).default(''),
  dueAt: z.number().int().nullable().default(null),
  priority: z.enum(['low', 'normal', 'high']).default('normal')
})
export type PersonalTaskInput = z.input<typeof personalTaskInputSchema>

export interface PersonalTaskDto {
  id: string
  title: string
  note: string
  dueAt: number | null
  priority: 'low' | 'normal' | 'high'
  doneAt: number | null
  sort: number
  createdAt: number
  updatedAt: number
}
