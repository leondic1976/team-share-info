import { z } from 'zod'
import { scopeSchema, type ScopeDto } from './scope'

export type DocKind = 'mustread' | 'manual' | 'handover' | 'minutes' | 'faq'
export const DOC_KIND_LABEL: Record<DocKind, string> = {
  mustread: '알아둘 사항',
  manual: '업무 매뉴얼',
  handover: '인수인계서',
  minutes: '회의록',
  faq: '자주 묻는 질문'
}

/** Documents not reviewed for this long are flagged "내용 확인 필요" (6.11). */
export const STALE_AFTER_MS = 180 * 86400000

export const docInputSchema = z.object({
  kind: z.enum(['mustread', 'manual', 'handover', 'minutes', 'faq']),
  parentId: z.string().nullable().default(null),
  title: z.string().trim().min(1, '제목을 입력하세요').max(150),
  bodyHtml: z.string().max(3_000_000).default(''),
  tags: z.array(z.string().trim().max(20)).max(10).default([]),
  scope: scopeSchema,
  eventId: z.string().nullable().default(null),
  sort: z.number().int().default(0),
  attachmentIds: z.array(z.string()).max(20).default([])
})

export const docPatchSchema = z.object({
  title: z.string().trim().min(1).max(150).optional(),
  bodyHtml: z.string().max(3_000_000).optional(),
  tags: z.array(z.string().trim().max(20)).max(10).optional(),
  parentId: z.string().nullable().optional(),
  sort: z.number().int().optional(),
  scope: scopeSchema.optional()
})

export interface DocSummaryDto {
  id: string
  kind: DocKind
  parentId: string | null
  title: string
  tags: string[]
  scope: ScopeDto
  sort: number
  eventId: string | null
  authorId: string
  authorName: string
  /** Absent from servers older than the 서무 mark. */
  updatedById?: string | null
  updatedByName: string | null
  createdAt: number
  updatedAt: number
  reviewedAt: number | null
  stale: boolean
  /** must-read: have I read it */
  read: boolean
  readStats: { read: number; total: number } | null
}

export interface DocDto extends DocSummaryDto {
  bodyHtml: string
  attachments: { id: string; name: string; size: number }[]
  revisionCount: number
  canEdit: boolean
  canDelete: boolean
}

export interface DocRevisionDto {
  id: string
  title: string
  bodyHtml: string
  editedByName: string
  editedAt: number
}

export const templateInputSchema = z.object({
  kind: z.enum(['mustread', 'manual', 'handover', 'minutes', 'faq', 'report']),
  name: z.string().trim().min(1).max(60),
  bodyHtml: z.string().max(500_000)
})

export interface TemplateDto {
  id: string
  kind: string
  name: string
  bodyHtml: string
  builtin: boolean
}

export const annualInputSchema = z.object({
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31).nullable().default(null),
  title: z.string().trim().min(1, '업무 이름을 입력하세요').max(120),
  bodyHtml: z.string().max(200_000).default(''),
  remindDaysBefore: z.number().int().min(0).max(60).default(7),
  scope: scopeSchema
})

export interface AnnualTaskDto {
  id: string
  month: number
  day: number | null
  title: string
  bodyHtml: string
  remindDaysBefore: number
  scope: ScopeDto
  /** Absent from servers older than the 서무 mark. */
  authorId?: string
  authorName: string
  canEdit: boolean
}

/** Built-in templates (6.11 양식). Admins can add more. */
export const BUILTIN_TEMPLATES: TemplateDto[] = [
  {
    id: 'builtin-minutes',
    kind: 'minutes',
    name: '회의록',
    builtin: true,
    bodyHtml:
      '<h2>회의 개요</h2><table><tbody><tr><th>일시</th><td></td></tr><tr><th>장소</th><td></td></tr><tr><th>참석자</th><td></td></tr></tbody></table><h2>안건</h2><ol><li><p></p></li></ol><h2>논의 내용</h2><p></p><h2>결정 사항</h2><ul><li><p></p></li></ul><h2>후속 조치</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>담당자 / 기한 / 내용</p></li></ul>'
  },
  {
    id: 'builtin-handover',
    kind: 'handover',
    name: '인수인계서',
    builtin: true,
    bodyHtml:
      '<h2>기본 정보</h2><table><tbody><tr><th>인계자</th><td></td></tr><tr><th>인수자</th><td></td></tr><tr><th>인계일</th><td></td></tr></tbody></table><h2>담당 업무</h2><ul><li><p></p></li></ul><h2>진행 중인 일</h2><table><tbody><tr><th>업무</th><th>현재 상태</th><th>다음 할 일</th><th>기한</th></tr><tr><td></td><td></td><td></td><td></td></tr></tbody></table><h2>정기 업무 (주기·시기)</h2><ul><li><p></p></li></ul><h2>관련 자료 위치</h2><ul><li><p>자료실 / </p></li></ul><h2>연락처</h2><ul><li><p></p></li></ul><h2>주의 사항</h2><p></p>'
  },
  {
    id: 'builtin-manual',
    kind: 'manual',
    name: '업무 절차',
    builtin: true,
    bodyHtml: '<h2>목적</h2><p></p><h2>처리 절차</h2><ol><li><p></p></li></ol><h2>필요한 서식·시스템</h2><ul><li><p></p></li></ul><h2>자주 하는 실수</h2><ul><li><p></p></li></ul><h2>관련 근거</h2><p></p>'
  },
  {
    id: 'builtin-report',
    kind: 'report',
    name: '보고서',
    builtin: true,
    bodyHtml: '<h2>제목</h2><p></p><h2>개요</h2><p></p><h2>현황</h2><p></p><h2>문제점</h2><p></p><h2>개선 방안</h2><p></p><h2>향후 계획</h2><p></p>'
  }
]
