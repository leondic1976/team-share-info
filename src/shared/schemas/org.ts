import { z } from 'zod'

/** A department of the organisation chart. Fields after `sort` are absent from older servers. */
export interface DepartmentDto {
  id: string
  name: string
  parentId: string | null
  sort: number
  /** the member who leads the department (부서장) */
  headId?: string | null
  /** main phone or extension of the department */
  phone?: string | null
  /** what the department is in charge of (담당 업무) */
  duties?: string | null
  /** where it sits (e.g. "본관 2층") */
  location?: string | null
  /**
   * Set when a person made this department by typing their own affiliation (내 정보, 사용 신청):
   * the member id, and when. Cleared once the 최종관리자 has renamed, moved or confirmed it.
   */
  enteredBy?: string | null
  enteredAt?: number | null
}

/** Optional text; an empty one is stored as "none". */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null))

export const departmentCreateSchema = z.object({
  name: z.string().trim().min(1, '부서 이름을 입력하세요').max(40),
  parentId: z.string().nullable().default(null),
  /** left out: goes after the last department of the same parent */
  sort: z.number().int().optional(),
  headId: z.string().nullable().optional(),
  phone: text(40),
  duties: text(500),
  location: text(60)
})

export const departmentPatchSchema = z.object({
  name: z.string().trim().min(1, '부서 이름을 입력하세요').max(40).optional(),
  parentId: z.string().nullable().optional(),
  sort: z.number().int().optional(),
  headId: z.string().nullable().optional(),
  phone: text(40),
  duties: text(500),
  location: text(60),
  /** true: the 최종관리자 has looked at a person-entered department; its mark goes */
  confirmed: z.boolean().optional()
})

/** 합치기: the members and the departments below `id` go to `targetId`, then `id` is removed. */
export const departmentMergeSchema = z.object({ targetId: z.string().min(1) })

/** The departments of one parent, in the order they should be shown. */
export const departmentOrderSchema = z.object({
  parentId: z.string().nullable(),
  ids: z.array(z.string()).min(1).max(500)
})

/** What 조직 관리 sets for a member: where they belong and how they are listed in the chart. */
export const orgMemberPatchSchema = z.object({
  deptId: z.string().nullable().optional(),
  title: z.string().trim().max(40).nullable().optional(),
  rank: z.string().trim().max(40).nullable().optional(),
  orgSort: z.number().int().min(0).max(100000).optional()
})

/** The members of one department (null: no department), in the order they should be shown. */
export const orgMemberOrderSchema = z.object({
  deptId: z.string().nullable(),
  ids: z.array(z.string()).min(1).max(1000)
})
