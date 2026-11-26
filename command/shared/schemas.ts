/** 긴급구조지휘대: what the server accepts (Zod). */
import { z } from 'zod'
import { MARK_ICONS } from './types'

const name = (max: number, what: string) => z.string().trim().min(1, `${what}을(를) 입력하세요.`).max(max)
const ymdStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '날짜가 올바르지 않습니다.')
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '시각이 올바르지 않습니다.')
/** a member id of the host or a temporary person ('x:…') */
export const personId = z.string().min(1).max(64)
const html = z.string().max(2_000_000).default('')
const ids = z.array(z.string().min(1).max(64)).max(500)

export const managersSchema = z.object({ memberIds: z.array(z.string().min(1).max(64)).max(3, '지휘대담당은 3명까지 정할 수 있습니다.') })
export const modeSchema = z.object({ name: name(40, '근무 유형 이름'), hidden: z.boolean().optional() })
export const modePatchSchema = modeSchema.partial()
export const teamSchema = z.object({ name: name(20, '조 이름'), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2563eb') })
export const teamPatchSchema = teamSchema.partial()
export const teamMembersSchema = z.object({ personIds: z.array(personId).max(300) })
export const orderSchema = z.object({ ids })
export const rotationSchema = z.object({
  baseDate: ymdStr,
  shiftTime: hm.default('09:00'),
  periodDays: z.number().int().min(1, '주기는 1일 이상입니다.').max(31, '주기는 31일까지입니다.'),
  order: ids
})
export const overrideSchema = z
  .object({ fromAt: z.number().int(), toAt: z.number().int(), teamId: z.string().min(1).max(64), note: z.string().trim().max(100).default('') })
  .refine((o) => o.toAt > o.fromAt, { message: '끝이 시작보다 늦어야 합니다.', path: ['toAt'] })
export const roleSchema = z.object({ modeId: z.string().min(1).max(64), parentId: z.string().max(64).nullable().default(null), name: name(60, '분류 이름') })
export const rolePatchSchema = z.object({ name: name(60, '분류 이름').optional(), parentId: z.string().max(64).nullable().optional(), dutyHtml: z.string().max(2_000_000).optional() })
export const assignSchema = z.object({ modeId: z.string().min(1).max(64), teamId: z.string().min(1).max(64), roleId: z.string().min(1).max(64), personIds: z.array(personId).max(100) })
export const copyAssignSchema = z.object({ fromModeId: z.string().min(1).max(64), toModeId: z.string().min(1).max(64) })
export const commonSchema = z.object({ name: name(60, '공통업무 이름'), description: z.string().trim().max(500).default(''), perTeam: z.boolean().default(false) })
export const commonPatchSchema = commonSchema.partial()
export const commonAssignSchema = z.object({ teamId: z.string().max(64).default(''), personIds: z.array(personId).max(100) })
export const exceptionSchema = z
  .object({ personId, reason: z.string().trim().max(100).default(''), fromDate: ymdStr, toDate: ymdStr.nullable().default(null) })
  .refine((e) => !e.toDate || e.toDate >= e.fromDate, { message: '끝 날짜가 시작보다 빠릅니다.', path: ['toDate'] })
export const substitutionSchema = z
  .object({ personId, substituteId: personId, reason: z.string().trim().max(100).default(''), fromDate: ymdStr, toDate: ymdStr.nullable().default(null) })
  .refine((e) => !e.toDate || e.toDate >= e.fromDate, { message: '끝 날짜가 시작보다 빠릅니다.', path: ['toDate'] })
export const tempPersonSchema = z.object({ name: name(30, '이름'), title: z.string().trim().max(30).default(''), memo: z.string().trim().max(100).default('') })
export const mergeSchema = z.object({ memberId: z.string().min(1).max(64) })

export const noticeSchema = z.object({ title: name(150, '제목'), bodyHtml: html, pinned: z.boolean().default(false), attachmentIds: ids.default([]) })
export const materialSchema = z.object({ category: z.string().trim().max(40).default(''), title: name(150, '제목'), description: z.string().trim().max(1000).default(''), attachmentId: z.string().max(64).nullable().default(null) })

const point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
export const markSchema = z.object({
  key: z.string().min(1).max(64),
  kind: z.enum(['pin', 'line', 'arrow', 'area', 'text']),
  icon: z.enum(MARK_ICONS).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  label: z.string().trim().max(60).default(''),
  points: z.array(point).min(1).max(200)
})
export const mapSchema = z.object({ imageId: z.string().max(64).nullable().default(null), width: z.number().int().min(0).max(20000).default(0), height: z.number().int().min(0).max(20000).default(0), marks: z.array(markSchema.extend({ id: z.string().max(64).optional() })).max(500).default([]) })
export const markChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), mark: markSchema }),
  z.object({ op: z.literal('move'), key: z.string().min(1).max(64), points: z.array(point).min(1).max(200) }),
  z.object({ op: z.literal('remove'), key: z.string().min(1).max(64) })
])

export const scenarioMsgSchema = z
  .object({
    offsetMin: z.number().int().min(0).max(24 * 60).default(0),
    title: name(120, '메시지 제목'),
    bodyHtml: html,
    targetKind: z.enum(['role', 'person', 'all']).default('all'),
    targetIds: ids.default([]),
    handling: z.enum(['assigned', 'first', 'all']).default('assigned'),
    answerKind: z.enum(['text', 'choice']).default('text'),
    choices: z.array(z.string().trim().min(1).max(100)).max(6).default([]),
    correctIndex: z.number().int().min(0).max(5).nullable().default(null),
    limitMin: z.number().int().min(1).max(600).nullable().default(null),
    popup: z.boolean().default(true),
    mapChanges: z.array(markChangeSchema).max(50).default([])
  })
  .refine((m) => m.answerKind !== 'choice' || m.choices.length >= 2, { message: '객관식은 선택지를 2개 이상 적으세요.', path: ['choices'] })
  .refine((m) => m.correctIndex == null || m.correctIndex < m.choices.length, { message: '정답 번호가 선택지 밖입니다.', path: ['correctIndex'] })
  .refine((m) => m.targetKind === 'all' || m.handling === 'all' || m.targetIds.length > 0, { message: '처리할 분류나 사람을 고르세요.', path: ['targetIds'] })
export const scenarioSchema = z.object({
  modeId: z.string().min(1).max(64),
  title: name(120, '시나리오 제목'),
  summaryHtml: html,
  targetHtml: html,
  map: mapSchema.default({ imageId: null, width: 0, height: 0, marks: [] }),
  messages: z.array(scenarioMsgSchema).max(200).default([])
})

export const drillCreateSchema = z.object({
  scenarioId: z.string().max(64).nullable().default(null),
  modeId: z.string().min(1).max(64),
  title: name(120, '훈련 이름'),
  teamIds: z.array(z.string().min(1).max(64)).min(1, '참가 조를 고르세요.').max(20),
  withCommon: z.boolean().default(false),
  /** null: start now */
  startAt: z.number().int().nullable().default(null)
})
export const answerSchema = z.object({ body: z.string().trim().max(5000).default(''), choiceIndex: z.number().int().min(0).max(5).nullable().default(null), attachmentIds: ids.default([]) })
export const gradeSchema = z.object({ grade: z.enum(['good', 'fair', 'poor']).nullable(), comment: z.string().trim().max(1000).default('') })
export const noteSchema = z.object({ body: name(1000, '기록') })
export const reviewSchema = z.object({ reviewHtml: html })
export const remindSchema = z.object({ memberIds: z.array(z.string().min(1).max(64)).max(300) })
