import { z } from 'zod'
import { PC_UID_RE } from '../constants'
import type { BackupAlert } from './settings'

export const helloSchema = z.object({
  name: z.literal('TeamHub'),
  orgName: z.string(),
  teamName: z.string(),
  noticeText: z.string(),
  version: z.string(),
  protocol: z.number(),
  minProtocol: z.number(),
  /** What this server can do beyond the protocol number (older servers send none). 'idem': X-Idempotency-Key */
  caps: z.array(z.string()).optional(),
  initialized: z.boolean()
})
export type Hello = z.infer<typeof helloSchema>

export const joinRequestInputSchema = z.object({
  name: z.string().trim().min(1, '이름을 입력하세요').max(40),
  /** The last level of the affiliation (all of it from older versions, which know one level only). */
  deptName: z.string().trim().max(40).default(''),
  /**
   * 소속 as typed, top level first ("본부 > 과 > 팀" → three entries). On approval existing levels
   * are matched and missing ones created. Older versions send `deptName` only.
   */
  deptPath: z.array(z.string().trim().max(40)).max(6).optional(),
  title: z.string().trim().max(40).default(''),
  ext: z.string().trim().max(20).default(''),
  pcName: z.string().trim().min(1).max(80),
  winUser: z.string().trim().min(1).max(80),
  appVersion: z.string().trim().max(40).default(''),
  /** The unique value of the asking PC (older versions do not send it). */
  pcUid: z.string().regex(PC_UID_RE).optional(),
  /**
   * 공용 PC: the asking person shares the PC and its Windows account with others, each with an
   * own unique value. The server then recognises this person by the unique value only.
   */
  sharedPc: z.boolean().optional()
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
  /** the department the member belongs to: its own name (the last level of the affiliation) */
  deptName: string | null
  /** 소속 in full, top level first (e.g. 본부, 과, 팀). Absent from servers older than multi-level affiliations. */
  deptPath?: string[]
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
  /**
   * The server PC's own account: the 최종관리자. Other members with role 'admin' are 서무.
   * Absent from servers older than the two admin tiers.
   */
  isOwner?: boolean
  /** 직급 (e.g. 6급), set in 조직 관리. Absent from servers older than the org chart. */
  rank?: string | null
  /** Place inside the department in the org chart (0: none given). */
  orgSort?: number
}

/** What to call a member's role: 최종관리자 (server PC), 서무 (other admins), 일반. */
export function roleLabel(m: { role: Role; isOwner?: boolean }): string {
  if (m.role !== 'admin') return '일반'
  return m.isOwner === undefined ? '관리자' : m.isOwner ? '최종관리자' : '서무'
}

/** True for a 서무: an admin who is not the server PC's own account (the 최종관리자). */
export function isClerk(m: { role?: Role | null; isOwner?: boolean } | null | undefined): boolean {
  return !!m && m.role === 'admin' && m.isOwner === false
}

/** Details of a member that an admin may set; once set by an admin they stay as set. */
export const ADMIN_SET_FIELDS = ['name', 'deptId', 'title', 'ext', 'mobile', 'duty'] as const

/** "홍길동(길동이)": the real name, then the pen name (필명) the member chose, if any. */
export function displayName(m: { name: string; nickname?: string | null }): string {
  return m.nickname ? `${m.name}(${m.nickname})` : m.name
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
  /**
   * For me this is stricter than for other members: true only when this PC is the server PC
   * itself, which is what the server asks for on data storage and critical settings.
   */
  isOwner?: boolean
  deviceId: string
  groups: GroupBrief[]
  disabledFeatures: string[]
  adminPinSet: boolean
  /** Join requests waiting for a decision; always 0 for non-admins. */
  pendingJoins: number
  /** I may send an emergency notice (긴급 level): admins, or everyone when the setting says so. Older servers do not send it. */
  canSendUrgent?: boolean
  /** team ledgers somebody else changed since I last opened them */
  ledgerUnseen: number
  /** 최종관리자 only: server backups are failing or old (the reminder card). Older servers do not send it. */
  backupAlert?: BackupAlert | null
}

/**
 * 내 정보 → 소속: an existing department (`deptId`, null: none) or the affiliation as typed
 * (`path`, top level first; levels that do not exist yet are created and marked as person-entered).
 */
export const meDeptSchema = z.union([z.strictObject({ deptId: z.string().nullable() }), z.strictObject({ path: z.array(z.string().max(200)).min(1).max(12) })])

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
  /** the affiliation as typed, as one text ("본부 > 과 > 팀") */
  deptName: string | null
  /** the same, level by level (absent from older servers) */
  deptPath?: string[]
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
  /** 공용 PC: one of several people on that PC (absent from older servers). */
  sharedPc?: boolean
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
  /** 공용 PC: several people (accounts) use this PC under one Windows account (absent from older servers). */
  sharedPc?: boolean
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
