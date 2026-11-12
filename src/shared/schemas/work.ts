import { z } from 'zod'
import { scopeSchema, type ScopeDto } from './scope'

// ---------- tasks (업무 요청) ----------
export type TaskState = 'requested' | 'doing' | 'done' | 'confirmed'
export const TASK_STATE_LABEL: Record<TaskState, string> = { requested: '요청', doing: '진행 중', done: '완료', confirmed: '확인' }
export const PRIORITY_LABEL = { low: '낮음', normal: '보통', high: '높음' } as const

/**
 * Allowed state changes (6.8 상태 흐름): who may move a task from one state to another.
 * 'assignee' = 담당자, 'requester' = 요청한 사람.
 */
export const TASK_TRANSITIONS: Record<TaskState, Partial<Record<TaskState, ('assignee' | 'requester')[]>>> = {
  requested: { doing: ['assignee'], done: ['assignee'] },
  doing: { done: ['assignee'], requested: ['assignee'] },
  done: { confirmed: ['requester'], doing: ['assignee', 'requester'] },
  confirmed: { doing: ['requester'] }
}

export function canTransition(from: TaskState, to: TaskState, role: { assignee: boolean; requester: boolean }): boolean {
  const who = TASK_TRANSITIONS[from][to]
  if (!who) return false
  return (who.includes('assignee') && role.assignee) || (who.includes('requester') && role.requester)
}

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1, '제목을 입력하세요').max(120),
  bodyHtml: z.string().max(500_000).default(''),
  assigneeId: z.string(),
  dueAt: z.number().int().nullable().default(null),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  scope: scopeSchema.optional(),
  attachmentIds: z.array(z.string()).max(10).default([])
})

export const taskPatchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  bodyHtml: z.string().max(500_000).optional(),
  dueAt: z.number().int().nullable().optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  assigneeId: z.string().optional(),
  state: z.enum(['requested', 'doing', 'done', 'confirmed']).optional()
})

export interface TaskDto {
  id: string
  title: string
  bodyHtml?: string
  requesterId: string
  requesterName: string
  assigneeId: string
  assigneeName: string
  dueAt: number | null
  priority: 'low' | 'normal' | 'high'
  state: TaskState
  scope: ScopeDto
  commentCount: number
  attachmentCount: number
  createdAt: number
  updatedAt: number
  doneAt: number | null
  confirmedAt: number | null
}

export interface CommentDto {
  id: string
  body: string
  authorId: string
  authorName: string
  createdAt: number
}

// ---------- boards ----------
export const boardInputSchema = z.object({
  name: z.string().trim().min(1, '게시판 이름을 입력하세요').max(40),
  kind: z.enum(['free', 'work', 'qna']).default('free'),
  description: z.string().trim().max(200).default(''),
  scope: scopeSchema,
  sort: z.number().int().default(0)
})

export const pollInputSchema = z.object({
  question: z.string().trim().min(1).max(200),
  options: z.array(z.string().trim().min(1).max(100)).min(2, '선택지를 2개 이상 입력하세요').max(20),
  multiple: z.boolean().default(false),
  anonymous: z.boolean().default(false),
  closesAt: z.number().int().nullable().default(null)
})

export const postInputSchema = z.object({
  boardId: z.string(),
  title: z.string().trim().min(1, '제목을 입력하세요').max(150),
  bodyHtml: z.string().max(3_000_000).default(''),
  pinned: z.boolean().default(false),
  attachmentIds: z.array(z.string()).max(20).default([]),
  poll: pollInputSchema.nullable().default(null)
})

export interface BoardDto {
  id: string
  name: string
  kind: 'free' | 'work' | 'qna'
  description: string | null
  scope: ScopeDto
  sort: number
  postCount: number
  unreadCount: number
  canManage: boolean
}

export interface PostSummaryDto {
  id: string
  boardId: string
  title: string
  authorId: string
  authorName: string
  pinned: boolean
  createdAt: number
  updatedAt: number
  viewCount: number
  commentCount: number
  attachmentCount: number
  hasPoll: boolean
  read: boolean
}

export interface PollDto {
  id: string
  question: string
  multiple: boolean
  anonymous: boolean
  closesAt: number | null
  closed: boolean
  options: { id: string; label: string; votes: number; voters?: string[] }[]
  myVotes: string[]
  totalVoters: number
}

export interface PostDto extends PostSummaryDto {
  bodyHtml: string
  attachments: { id: string; name: string; size: number }[]
  poll: PollDto | null
  canEdit: boolean
}

// ---------- contacts ----------
export const contactInputSchema = z.object({
  org: z.string().trim().max(60).default(''),
  name: z.string().trim().min(1, '이름을 입력하세요').max(40),
  title: z.string().trim().max(40).default(''),
  phone: z.string().trim().max(30).default(''),
  mobile: z.string().trim().max(30).default(''),
  email: z.string().trim().max(80).default(''),
  memo: z.string().trim().max(500).default(''),
  scope: scopeSchema.optional()
})

export interface ContactDto {
  id: string
  org: string
  name: string
  title: string | null
  phone: string | null
  mobile: string | null
  email: string | null
  memo: string | null
  scope: ScopeDto
  createdBy: string
  createdByName: string
  canEdit: boolean
}
