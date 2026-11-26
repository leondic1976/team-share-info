import { z } from 'zod'
import { scopeSchema, type ScopeDto } from './scope'

/**
 * 자료 취합 (지시 127): a person asks the members of a scope to hand in a file and/or a text by a
 * deadline ("각 담당은 ○○ 자료를 ○일까지 제출"), sees who did, reminds the others and downloads
 * everything as one ZIP. Pure rules shared by the server and the screens live here.
 */

export type CollectSubmitMode = 'file' | 'text' | 'both'
export const COLLECT_MODE_LABEL: Record<CollectSubmitMode, string> = { file: '파일', text: '글', both: '파일과 글' }

/** A target's state on the 제출 현황: 제출 · 늦게 제출 · 해당 없음 · 미제출. */
export type CollectStatus = 'submitted' | 'late' | 'na' | 'none'
export const COLLECT_STATUS_LABEL: Record<CollectStatus, string> = { submitted: '제출', late: '늦게 제출', na: '해당 없음', none: '미제출' }

export const COLLECT_LIMITS = { title: 120, description: 5000, text: 20000, reason: 500, files: 20 } as const

export const collectCreateSchema = z.object({
  title: z.string().trim().min(1, '제목을 입력하세요').max(COLLECT_LIMITS.title),
  description: z.string().trim().max(COLLECT_LIMITS.description).default(''),
  deadlineAt: z.number().int().positive('마감 일시를 정하세요'),
  allowLate: z.boolean().default(true),
  submitMode: z.enum(['file', 'text', 'both']).default('file'),
  scope: scopeSchema,
  /** 양식 파일 (uploaded first through /api/attachments) */
  attachmentIds: z.array(z.string()).max(COLLECT_LIMITS.files).default([])
})
export type CollectCreateInput = z.input<typeof collectCreateSchema>

export const collectPatchSchema = z.object({
  title: z.string().trim().min(1, '제목을 입력하세요').max(COLLECT_LIMITS.title).optional(),
  description: z.string().trim().max(COLLECT_LIMITS.description).optional(),
  deadlineAt: z.number().int().positive().optional(),
  allowLate: z.boolean().optional(),
  /** the 양식 files it keeps (ids it already has) plus new uploads */
  attachmentIds: z.array(z.string()).max(COLLECT_LIMITS.files).optional()
})
export type CollectPatchInput = z.input<typeof collectPatchSchema>

/** Hand in (or replace what was handed in): the files kept and added, and the text. */
export const collectSubmitSchema = z.object({
  text: z.string().max(COLLECT_LIMITS.text).default(''),
  attachmentIds: z.array(z.string()).max(COLLECT_LIMITS.files).default([])
})
export type CollectSubmitInput = z.input<typeof collectSubmitSchema>

export const collectNaSchema = z.object({ reason: z.string().trim().max(COLLECT_LIMITS.reason).default('') })

export interface CollectFileDto {
  id: string
  name: string
  size: number
}

export interface CollectSubmissionDto {
  status: CollectStatus
  submittedAt: number
  text: string
  /** 해당 없음: the reason given (may be empty) */
  reason: string
  files: CollectFileDto[]
}

export interface CollectCounts {
  total: number
  submitted: number
  late: number
  na: number
  none: number
}

export interface CollectSummaryDto {
  id: string
  title: string
  deadlineAt: number
  allowLate: boolean
  submitMode: CollectSubmitMode
  closedAt: number | null
  createdAt: number
  authorId: string
  authorName: string
  scope: ScopeDto
  /** I asked for it (or I am the 최종관리자): I see the 제출 현황 */
  canManage: boolean
  /** I am one of the people asked (not the requester) */
  isTarget: boolean
  /** my state when I am a target */
  myStatus: CollectStatus | null
  mySubmittedAt: number | null
  /** for the people who see the 제출 현황 */
  counts: CollectCounts | null
  formCount: number
}

export interface CollectDto extends CollectSummaryDto {
  description: string
  forms: CollectFileDto[]
  mine: CollectSubmissionDto | null
}

export interface CollectStatusRow {
  memberId: string
  name: string
  deptName: string
  deptPath: string[]
  title: string
  status: CollectStatus
  submittedAt: number | null
  text: string
  reason: string
  files: CollectFileDto[]
  online: boolean
}

export interface CollectStatusDto {
  counts: CollectCounts
  rows: CollectStatusRow[]
}

export interface CollectChangedPayload {
  id: string
  title?: string
  deadlineAt?: number
  byId?: string
  byName?: string
  /** a new request for me */
  created?: boolean
  /** 다시 알림 by the requester, or the automatic reminder before the deadline */
  remind?: 'manual' | 'day' | 'hour'
  deleted?: boolean
}

// ---------- rules ----------

interface RequestState {
  deadlineAt: number
  allowLate: boolean
  closedAt: number | null
}

/** Submissions (and 해당 없음) are taken until the deadline, after it only when 마감 후 제출 허용 is on; never once closed. */
export function isAccepting(r: RequestState, now: number): boolean {
  if (r.closedAt) return false
  return now <= r.deadlineAt || r.allowLate
}

/** A submission can be taken back only before the deadline (and while the request is open). */
export function canWithdraw(r: RequestState, now: number): boolean {
  return !r.closedAt && now <= r.deadlineAt
}

/** 늦게 제출: handed in after the deadline (follows the deadline when it is moved). */
export function statusOf(sub: { kind: 'submitted' | 'na'; submittedAt: number } | null | undefined, deadlineAt: number): CollectStatus {
  if (!sub) return 'none'
  if (sub.kind === 'na') return 'na'
  return sub.submittedAt > deadlineAt ? 'late' : 'submitted'
}

export function countStatuses(statuses: CollectStatus[]): CollectCounts {
  const c: CollectCounts = { total: statuses.length, submitted: 0, late: 0, na: 0, none: 0 }
  for (const s of statuses) c[s]++
  return c
}

/** The automatic reminders to those who have not handed in: one day and one hour before the deadline. */
export const COLLECT_REMINDERS = [
  { kind: 'day', before: 24 * 3600_000, label: '마감 하루 전' },
  { kind: 'hour', before: 3600_000, label: '마감 1시간 전' }
] as const
export type CollectReminderKind = (typeof COLLECT_REMINDERS)[number]['kind']

/**
 * Which automatic reminder is due now (null: none). A reminder is due from its time until the
 * next one (or the deadline). A reminder whose time had passed when the deadline was set (a
 * request made 3 hours before its deadline gets no "하루 전") is never sent. Whether it was sent
 * already is the caller's business (one row per request, kind and deadline).
 */
export function dueReminder(r: RequestState & { deadlineSetAt: number }, now: number): CollectReminderKind | null {
  if (r.closedAt || now >= r.deadlineAt) return null
  for (let i = COLLECT_REMINDERS.length - 1; i >= 0; i--) {
    const at = r.deadlineAt - COLLECT_REMINDERS[i].before
    if (now >= at) return r.deadlineSetAt < at ? COLLECT_REMINDERS[i].kind : null
  }
  return null
}

/** "3일 남음", "5시간 남음", "40분 남음", "마감 지남" */
export function remainingLabel(deadlineAt: number, now: number): string {
  const ms = deadlineAt - now
  if (ms <= 0) return '마감 지남'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${Math.max(1, min)}분 남음`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}시간 남음`
  return `${Math.floor(h / 24)}일 남음`
}

// ---------- the bundle (ZIP) and the list (CSV) ----------

/** A part of a file name inside the ZIP or of the ZIP's own name: no path or reserved characters. */
export function safeFilePart(s: string, max = 60): string {
  const out = [...s]
    .map((ch) => (ch < ' ' || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return out.slice(0, max) || '_'
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`

/** `자료취합_<제목>_<YYYYMMDD>.zip` (the day it is downloaded) */
export function collectZipName(title: string, at: number): string {
  return `자료취합_${safeFilePart(title, 80)}_${ymd(new Date(at))}.zip`
}
export function collectCsvName(title: string, at: number): string {
  return `자료취합_${safeFilePart(title, 80)}_${ymd(new Date(at))}_제출현황.csv`
}

/** Each submitted file in the ZIP: `<부서>_<이름>_<파일 이름>`; a text answer is `<부서>_<이름>_제출내용.txt`. */
export function zipEntryName(deptName: string, name: string, file: string): string {
  return `${safeFilePart(deptName || '부서없음', 40)}_${safeFilePart(name, 40)}_${safeFilePart(file, 160)}`
}

/** Unique names: "a.hwp", "a (2).hwp", ... */
export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>()
  return names.map((n) => {
    let out = n
    const dot = n.lastIndexOf('.')
    const stem = dot > 0 ? n.slice(0, dot) : n
    const ext = dot > 0 ? n.slice(dot) : ''
    for (let i = 2; seen.has(out.toLowerCase()); i++) out = `${stem} (${i})${ext}`
    seen.add(out.toLowerCase())
    return out
  })
}

const fmtTime = (ms: number | null): string => {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** The 제출 현황 as rows for a CSV that Excel opens (the caller adds the BOM via toCsv). */
export function collectCsvRows(rows: CollectStatusRow[]): string[][] {
  return [
    ['부서', '이름', '직위', '상태', '제출 시각', '파일', '글', '해당 없음 사유'],
    ...rows.map((r) => [
      r.deptPath.length ? r.deptPath.join(' > ') : r.deptName,
      r.name,
      r.title,
      COLLECT_STATUS_LABEL[r.status],
      fmtTime(r.submittedAt),
      r.files.map((f) => f.name).join(', '),
      r.text,
      r.reason
    ])
  ]
}
