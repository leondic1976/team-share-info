import { z } from 'zod'
import { PC_UID_RE } from '../constants'

export const helloSchema = z.object({
  name: z.literal('TeamHub'),
  orgName: z.string(),
  teamName: z.string(),
  noticeText: z.string(),
  version: z.string(),
  protocol: z.number(),
  minProtocol: z.number(),
  initialized: z.boolean()
})
export type Hello = z.infer<typeof helloSchema>

export const joinRequestInputSchema = z.object({
  name: z.string().trim().min(1, '이름을 입력하세요').max(40),
  deptName: z.string().trim().max(40).default(''),
  title: z.string().trim().max(40).default(''),
  ext: z.string().trim().max(20).default(''),
  pcName: z.string().trim().min(1).max(80),
  winUser: z.string().trim().min(1).max(80),
  appVersion: z.string().trim().max(40).default(''),
  /** The unique value of the asking PC (older versions do not send it). */
  pcUid: z.string().regex(PC_UID_RE).optional()
})
export type JoinRequestInput = z.infer<typeof joinRequestInputSchema>

export const joinPollSchema = z.object({
  state: z.enum(['pending', 'approved', 'rejected']),
  deviceId: z.string().optional(),
  deviceKey: z.string().optional(),
  memberId: z.string().optional()
})
export type JoinPoll = z.infer<typeof joinPollSchema>

export type Role = 'admin' | 'member'

export interface MemberDto {
  id: string
  name: string
  deptId: string | null
  deptName: string | null
  title: string | null
  ext: string | null
  mobile: string | null
  duty: string | null
  role: Role
  status: 'active' | 'suspended'
  statusMessage: string | null
  lastSeenAt: number | null
  presence: Presence
  /** A free name the member chose for themselves; only they can set it. */
  nickname: string | null
  /** Details an admin set (name, deptId, title, ext, mobile, duty): the member cannot change these. */
  adminFields: string[]
}

/** Details of a member that an admin may set; once set by an admin they stay as set. */
export const ADMIN_SET_FIELDS = ['name', 'deptId', 'title', 'ext', 'mobile', 'duty'] as const

/** "홍길동 (길동이)" where there is a nickname. */
export function displayName(m: { name: string; nickname?: string | null }): string {
  return m.nickname ? `${m.name} (${m.nickname})` : m.name
}

export type Presence = 'online' | 'away' | 'offline' | 'absent'

export interface GroupBrief {
  id: string
  name: string
  color: string
  role: 'owner' | 'member'
  /** false when I turned off notifications for this group */
  notify: boolean
}

export interface MeDto extends MemberDto {
  deviceId: string
  groups: GroupBrief[]
  disabledFeatures: string[]
  adminPinSet: boolean
  /** Join requests waiting for a decision; always 0 for non-admins. */
  pendingJoins: number
  /** team ledgers somebody else changed since I last opened them */
  ledgerUnseen: number
}

export const mePatchSchema = z.object({
  deptId: z.string().nullable().optional(),
  statusMessage: z.string().trim().max(60).nullable().optional(),
  ext: z.string().trim().max(20).nullable().optional(),
  mobile: z.string().trim().max(20).nullable().optional(),
  duty: z.string().trim().max(200).nullable().optional(),
  title: z.string().trim().max(40).nullable().optional(),
  name: z.string().trim().min(1).max(40).optional(),
  nickname: z.string().trim().max(20).nullable().optional()
})

export interface JoinRequestDto {
  id: string
  name: string
  deptName: string | null
  title: string | null
  ext: string | null
  pcName: string
  winUser: string
  ip: string
  appVersion: string | null
  state: 'pending' | 'approved' | 'rejected'
  inAllowedRange: boolean
  createdAt: number
  decidedAt: number | null
  pcUid: string | null
  /** This PC already has an account: approving gives it back instead of making a second one. */
  knownMember: { id: string; name: string } | null
}

export interface DeviceDto {
  id: string
  memberId: string
  memberName: string
  pcName: string
  winUser: string
  approvedIp: string
  lastIp: string | null
  ipChanged: boolean
  appVersion: string | null
  approvedAt: number
  revokedAt: number | null
  lastSeenAt: number | null
  online: boolean
  pcUid: string | null
  /** The server PC's own entry. */
  isServer: boolean
}

/** A PC shut out for good (관리 → 구성원 → 영구 차단한 PC). */
export interface BlockedPcDto {
  id: string
  pcUid: string | null
  pcName: string
  winUser: string
  /** Whose PC it was when it was blocked. */
  memberName: string | null
  reason: string
  blockedByName: string | null
  createdAt: number
}

export const blockPcSchema = z
  .object({
    /** An approved PC ... */
    deviceId: z.string().optional(),
    /** ... or a PC that is asking for access. */
    requestId: z.string().optional(),
    reason: z.string().trim().min(2, '차단 사유를 입력하세요').max(200)
  })
  .refine((v) => !!v.deviceId !== !!v.requestId, '차단할 PC를 지정하세요')

export const adminMemberPatchSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  role: z.enum(['admin', 'member']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  deptId: z.string().nullable().optional(),
  title: z.string().trim().max(40).nullable().optional(),
  ext: z.string().trim().max(20).nullable().optional(),
  mobile: z.string().trim().max(20).nullable().optional(),
  duty: z.string().trim().max(200).nullable().optional()
})
