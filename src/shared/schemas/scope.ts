import { z } from 'zod'

/** Visibility of a shared item (6.2 ③): whole team, selected groups, or selected people. */
export const scopeSchema = z
  .object({
    type: z.enum(['team', 'group', 'members']),
    groupIds: z.array(z.string()).max(50).default([]),
    memberIds: z.array(z.string()).max(500).default([])
  })
  .refine((s) => s.type !== 'group' || s.groupIds.length > 0, { message: '그룹을 하나 이상 고르세요.', path: ['groupIds'] })
  .refine((s) => s.type !== 'members' || s.memberIds.length > 0, { message: '받을 사람을 한 명 이상 고르세요.', path: ['memberIds'] })
export type ScopeInput = z.infer<typeof scopeSchema>

export interface ScopeDto {
  type: 'team' | 'group' | 'members'
  groups: { id: string; name: string; color: string }[]
  members: { id: string; name: string }[]
}

export const GROUP_COLORS = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#0891b2', '#4b5563'] as const

export const groupCreateSchema = z.object({
  name: z.string().trim().min(1, '그룹 이름을 입력하세요').max(40),
  description: z.string().trim().max(200).default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2563eb'),
  visibility: z.enum(['public', 'private']).default('private'),
  memberIds: z.array(z.string()).max(500).default([])
})

export const groupPatchSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().max(200).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  state: z.enum(['active', 'archived']).optional(),
  ownerId: z.string().optional(),
  notify: z.boolean().optional()
})

export interface GroupDto {
  id: string
  name: string
  description: string | null
  color: string
  visibility: 'public' | 'private'
  state: 'active' | 'archived' | 'dissolved'
  ownerId: string
  ownerName: string
  memberCount: number
  myRole: 'owner' | 'member' | null
  notify: boolean
  myPending: 'invite' | 'request' | null
  inviteId: string | null
}

export interface GroupMemberDto {
  memberId: string
  name: string
  deptName: string | null
  role: 'owner' | 'member'
  joinedAt: number
}

export interface GroupInviteDto {
  id: string
  groupId: string
  groupName: string
  groupColor: string
  memberId: string
  memberName: string
  kind: 'invite' | 'request'
  createdAt: number
}
