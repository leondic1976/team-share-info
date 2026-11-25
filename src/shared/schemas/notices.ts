import { z } from 'zod'
import { scopeSchema, type ScopeDto } from './scope'

export type NoticeLevel = 'urgent' | 'important' | 'normal'

export const NOTICE_LEVEL_LABEL: Record<NoticeLevel, string> = { urgent: '긴급', important: '중요', normal: '일반' }

export const noticeCreateSchema = z.object({
  level: z.enum(['urgent', 'important', 'normal']).default('normal'),
  title: z.string().trim().min(1, '제목을 입력하세요').max(120),
  bodyHtml: z.string().max(3_000_000).default(''),
  scope: scopeSchema,
  requireAck: z.boolean().default(false),
  replyOptions: z.array(z.string().trim().min(1).max(20)).max(6).default([]),
  pinned: z.boolean().default(false),
  publishAt: z.number().int().nullable().default(null),
  expiresAt: z.number().int().nullable().default(null),
  renotifyMinutes: z.number().int().min(1).max(1440).nullable().default(null),
  attachmentIds: z.array(z.string()).max(20).default([])
})
export type NoticeCreateInput = z.input<typeof noticeCreateSchema>

export const noticePatchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  bodyHtml: z.string().max(3_000_000).optional(),
  pinned: z.boolean().optional(),
  expiresAt: z.number().int().nullable().optional()
})

export interface NoticeSummaryDto {
  id: string
  level: NoticeLevel
  title: string
  authorId: string
  authorName: string
  scope: ScopeDto
  requireAck: boolean
  replyOptions: string[]
  pinned: boolean
  publishAt: number
  publishedAt: number | null
  expiresAt: number | null
  renotifyMinutes: number | null
  createdAt: number
  my: { readAt: number | null; ackedAt: number | null; reply: string | null } | null
  stats: { total: number; read: number; acked: number } | null
  attachmentCount: number
}

export interface NoticeDto extends NoticeSummaryDto {
  bodyHtml: string
  attachments: { id: string; name: string; size: number }[]
}

export interface ReceiptDto {
  memberId: string
  name: string
  deptName: string | null
  deliveredAt: number | null
  readAt: number | null
  ackedAt: number | null
  reply: string | null
  online: boolean
}

/** Full payload for the urgent popup (notice.urgent event). */
export interface UrgentPayload {
  id: string
  title: string
  bodyHtml: string
  /** Absent from servers older than the 서무 mark. */
  authorId?: string
  authorName: string
  requireAck: boolean
  replyOptions: string[]
  publishedAt: number
  level: NoticeLevel
}
