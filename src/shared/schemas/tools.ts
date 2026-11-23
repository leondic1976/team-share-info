import { z } from 'zod'
import { rrulestr } from 'rrule'
import { scopeSchema, type ScopeDto } from './scope'

// ---------- memos (local) ----------
export const MEMO_COLORS = { yellow: '#fef08a', green: '#bbf7d0', blue: '#bfdbfe', pink: '#fbcfe8', gray: '#e5e7eb' } as const
export type MemoColor = keyof typeof MEMO_COLORS

export const memoInputSchema = z.object({
  id: z.string().optional(),
  body: z.string().max(200_000),
  color: z.enum(['yellow', 'green', 'blue', 'pink', 'gray']).default('yellow'),
  pinned: z.boolean().default(false),
  tags: z.array(z.string().max(20)).max(10).default([])
})
export type MemoInput = z.input<typeof memoInputSchema>

export interface MemoDto {
  id: string
  body: string
  color: MemoColor
  pinned: boolean
  tags: string[]
  sticky: boolean
  bounds: { x: number; y: number; w: number; h: number } | null
  alwaysOnTop: boolean
  createdAt: number
  updatedAt: number
}

// ---------- alarms (local) ----------
export type AlarmKind = 'once' | 'repeat' | 'deadline' | 'timer'
export const alarmInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1, '알람 이름을 입력하세요').max(100),
  note: z.string().max(1000).default(''),
  kind: z.enum(['once', 'repeat', 'deadline', 'timer']),
  fireAt: z.number().int(),
  rrule: z.string().max(200).nullable().default(null),
  leadDays: z.array(z.number().int().min(0).max(60)).max(6).default([]),
  enabled: z.boolean().default(true),
  sound: z.boolean().default(true)
})
export type AlarmInput = z.input<typeof alarmInputSchema>

export interface AlarmDto {
  id: string
  title: string
  note: string
  kind: AlarmKind
  fireAt: number
  rrule: string | null
  leadDays: number[]
  enabled: boolean
  snoozeUntil: number | null
  lastFiredAt: number | null
  sound: boolean
  next: number | null
}

const offsetAt = (ms: number): number => new Date(ms).getTimezoneOffset() * 60000

/**
 * Times an alarm should ring within [from, to] (6.12). Repeat rules follow the local
 * wall clock; deadlines ring at 09:00 N days before and at the deadline itself.
 */
export function alarmTimes(a: Pick<AlarmDto, 'kind' | 'fireAt' | 'rrule' | 'leadDays' | 'enabled' | 'snoozeUntil'>, from: number, to: number): number[] {
  const out: number[] = []
  if (a.snoozeUntil && a.snoozeUntil >= from && a.snoozeUntil <= to) out.push(a.snoozeUntil)
  if (!a.enabled) return out
  if (a.kind === 'once' || a.kind === 'timer') {
    if (a.fireAt >= from && a.fireAt <= to) out.push(a.fireAt)
  } else if (a.kind === 'deadline') {
    for (const d of a.leadDays.length ? a.leadDays : [0]) {
      let t = a.fireAt
      if (d > 0) {
        const day = new Date(a.fireAt - d * 86400000)
        t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0).getTime()
      }
      if (t >= from && t <= to) out.push(t)
    }
  } else if (a.kind === 'repeat' && a.rrule) {
    try {
      const floating = (ms: number): Date => new Date(ms - offsetAt(ms))
      const rule = rrulestr(a.rrule.replace(/^RRULE:/i, ''), { dtstart: floating(a.fireAt) })
      for (const d of rule.between(floating(from), floating(to), true).slice(0, 500)) {
        out.push(d.getTime() + offsetAt(d.getTime() + offsetAt(d.getTime())))
      }
    } catch {
      // invalid rule: never rings
    }
  }
  return [...new Set(out)].sort((x, y) => x - y)
}

export function nextAlarmTime(a: Parameters<typeof alarmTimes>[0], now = Date.now()): number | null {
  return alarmTimes(a, now, now + 400 * 86400000)[0] ?? null
}

// ---------- snippets / clipboard / favorites (local) ----------
export const snippetInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1).max(60),
  body: z.string().min(1).max(20_000),
  groupName: z.string().trim().max(30).default('')
})
export interface SnippetDto {
  id: string
  title: string
  body: string
  groupName: string
  usedAt: number | null
}
export interface ClipboardItemDto {
  id: string
  kind: 'text' | 'image'
  body: string
  at: number
}
export interface FavoriteDto {
  id: string
  itemType: string
  itemId: string
  title: string
  route: string
}

// ---------- shared memos & sent alarms (server) ----------
export const sharedMemoInputSchema = z.object({
  body: z.string().trim().min(1, '내용을 입력하세요').max(2000),
  color: z.enum(['yellow', 'green', 'blue', 'pink', 'gray']).default('yellow'),
  scope: scopeSchema
})
export interface SharedMemoDto {
  id: string
  body: string
  color: MemoColor
  scope: ScopeDto
  authorId: string
  authorName: string
  createdAt: number
  checkedAt: number | null
  checkedByName: string | null
}

export const sendAlarmSchema = z.object({
  toIds: z.array(z.string()).min(1, '받는 사람을 고르세요').max(100),
  fireAt: z.number().int(),
  /** Ring as soon as it is sent: the server uses its own clock, so the sender's PC clock does not matter. */
  immediate: z.boolean().default(false),
  title: z.string().trim().min(1, '알람 내용을 입력하세요').max(100),
  body: z.string().max(500).default('')
})
export interface SentAlarmDto {
  id: string
  fromName: string
  toName: string
  fireAt: number
  title: string
  body: string
  deliveredAt: number | null
  dismissedAt: number | null
}
/** payload of alarm.fire */
export interface AlarmFirePayload {
  id: string
  fromName: string
  title: string
  body: string
  fireAt: number
}

// ---------- main-process tool state ----------
/** Content of an alarm popup window (#/popup/alarm/:pid). */
export interface AlarmPopupPayload {
  pid: string
  /** local alarm id (snooze applies to it) */
  alarmId: string | null
  /** alarm sent by a teammate (dismissed on the server) */
  remoteId: string | null
  title: string
  body: string
  fireAt: number
  fromName: string | null
  sound: boolean
}

/** One entry of "오늘 울릴 알림" (6.12 ②). */
export interface UpcomingReminder {
  key: string
  fireAt: number
  title: string
  body: string
  route?: string
  source: string
  fired: boolean
}

export interface FocusState {
  active: boolean
  kind: 'focus' | 'break'
  minutes: number
  endsAt: number | null
  /** toasts held back during focus */
  held: number
}

export interface ClipboardSettings {
  enabled: boolean
  clearOnExit: boolean
}
