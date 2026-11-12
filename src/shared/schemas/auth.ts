import { z } from 'zod'

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
  appVersion: z.string().trim().max(40).default('')
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
}

export const mePatchSchema = z.object({
  deptId: z.string().nullable().optional(),
  statusMessage: z.string().trim().max(60).nullable().optional(),
  ext: z.string().trim().max(20).nullable().optional(),
  mobile: z.string().trim().max(20).nullable().optional(),
  duty: z.string().trim().max(200).nullable().optional(),
  title: z.string().trim().max(40).nullable().optional(),
  name: z.string().trim().min(1).max(40).optional()
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
}

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
