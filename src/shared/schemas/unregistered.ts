import { z } from 'zod'

/**
 * 미등록 인원 (지시 134): staff who do not use TeamHub, on one list kept by the server PC and the
 * 서무 (관리 → 구성원·PC → 미등록 인원). 식사 신청 and 긴급구조지휘대 use the same list, and every
 * screen marks them "미등록".
 */
export const UNREG_LIMITS = { name: 30, dept: 30, title: 20, memo: 60, max: 300 } as const

/** Ids are 'x:' + letters and digits (the 식사 신청 plugin's ids of before are kept as they were). */
export const isUnregisteredId = (x: unknown): x is string => typeof x === 'string' && /^x:[a-z0-9]{6,24}$/.test(x)

/** One line: spaces folded, trimmed, cut to the limit. */
export const unregLine = (v: unknown, max: number): string =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim()

const field = (max: number) =>
  z
    .string()
    .max(200)
    .default('')
    .transform((v) => unregLine(v, max))

export const unregisteredInputSchema = z.object({
  name: z
    .string()
    .max(200)
    .transform((v) => unregLine(v, UNREG_LIMITS.name))
    .refine((v) => v.length > 0, '이름을 적으세요.'),
  dept: field(UNREG_LIMITS.dept),
  title: field(UNREG_LIMITS.title),
  memo: field(UNREG_LIMITS.memo)
})
export type UnregisteredInput = z.infer<typeof unregisteredInputSchema>

export const unregisteredPatchSchema = z.object({
  name: z
    .string()
    .max(200)
    .transform((v) => unregLine(v, UNREG_LIMITS.name))
    .refine((v) => v.length > 0, '이름을 적으세요.')
    .optional(),
  dept: z
    .string()
    .max(200)
    .transform((v) => unregLine(v, UNREG_LIMITS.dept))
    .optional(),
  title: z
    .string()
    .max(200)
    .transform((v) => unregLine(v, UNREG_LIMITS.title))
    .optional(),
  memo: z
    .string()
    .max(200)
    .transform((v) => unregLine(v, UNREG_LIMITS.memo))
    .optional()
})

/** 구성원과 합치기 (memberId) or 합치기 취소 (null). */
export const unregisteredMergeSchema = z.object({ memberId: z.string().min(1).max(64).nullable() })

export interface UnregisteredDto {
  id: string
  name: string
  dept: string
  title: string
  memo: string
  /** the member this person turned out to be (their records show under that member) */
  mergedInto: string | null
  mergedIntoName: string | null
  /** taken off the list (kept so old records stay readable) */
  deleted: boolean
  createdBy: string
  createdByName: string
  createdAt: number
  updatedAt: number
}

/** On the list now: not deleted and not merged into a member. */
export const isListed = (p: Pick<UnregisteredDto, 'deleted' | 'mergedInto'>): boolean => !p.deleted && !p.mergedInto

/** Is there somebody of that name already? 'member', 'unregistered' or '' (namesakes exist: a warning, not an error). */
export function unregNameClash(name: string, members: { name: string }[], list: UnregisteredDto[], selfId?: string): 'member' | 'unregistered' | '' {
  const n = unregLine(name, UNREG_LIMITS.name)
  if (!n) return ''
  if (members.some((m) => m.name === n)) return 'member'
  return list.some((p) => isListed(p) && p.id !== selfId && p.name === n) ? 'unregistered' : ''
}
