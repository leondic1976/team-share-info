import type { Db } from '../../node/sqlite'
import type { GroupBrief } from '../../shared/schemas/auth'
import type { GroupDto, GroupMemberDto } from '../../shared/schemas/scope'

interface GroupRow {
  id: string
  name: string
  description: string | null
  color: string
  visibility: 'public' | 'private'
  state: 'active' | 'archived' | 'dissolved'
  owner_id: string
  owner_name: string
  member_count: number
  my_role: 'owner' | 'member' | null
  my_notify: number | null
  pending_kind: 'invite' | 'request' | null
  invite_id: string | null
}

const SELECT = `
  SELECT g.*, CASE WHEN IFNULL(LENGTH(o.nickname), 0) = 0 THEN o.name ELSE o.name || char(40) || o.nickname || char(41) END AS owner_name,
    (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS member_count,
    gm.role AS my_role, gm.notify AS my_notify,
    gi.kind AS pending_kind, gi.id AS invite_id
  FROM groups g
  JOIN members o ON o.id = g.owner_id
  LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.member_id = ?
  LEFT JOIN group_invites gi ON gi.group_id = g.id AND gi.member_id = ? AND gi.state = 'pending'`

export function toGroupDto(r: GroupRow): GroupDto {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    color: r.color,
    visibility: r.visibility,
    state: r.state,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    memberCount: r.member_count,
    myRole: r.my_role,
    notify: r.my_notify !== 0,
    myPending: r.pending_kind,
    inviteId: r.invite_id
  }
}

export function getGroup(db: Db, id: string, viewerId: string): GroupDto | undefined {
  const r = db.get<GroupRow>(`${SELECT} WHERE g.id = ?`, [viewerId, viewerId, id])
  return r ? toGroupDto(r) : undefined
}

/** Groups I belong to, public groups, and private groups I was invited to. */
export function listGroupsFor(db: Db, viewerId: string): GroupDto[] {
  return db
    .all<GroupRow>(
      `${SELECT} WHERE g.state != 'dissolved' AND (gm.member_id IS NOT NULL OR g.visibility = 'public' OR gi.kind = 'invite')
       ORDER BY gm.member_id IS NULL, g.name`,
      [viewerId, viewerId]
    )
    .map(toGroupDto)
}

export function listAllGroups(db: Db): (GroupDto & { usageBytes: number })[] {
  return db.all<GroupRow>(`${SELECT} WHERE g.state != 'dissolved' ORDER BY g.name`, ['', '']).map((r) => ({ ...toGroupDto(r), usageBytes: 0 }))
}

export function groupMembers(db: Db, groupId: string): GroupMemberDto[] {
  return db
    .all<{ member_id: string; name: string; dept_name: string | null; role: 'owner' | 'member'; joined_at: number }>(
      `SELECT gm.member_id, m.name, d.name AS dept_name, gm.role, gm.joined_at FROM group_members gm
       JOIN members m ON m.id = gm.member_id LEFT JOIN departments d ON d.id = m.dept_id
       WHERE gm.group_id = ? ORDER BY gm.role = 'owner' DESC, m.name`,
      [groupId]
    )
    .map((r) => ({ memberId: r.member_id, name: r.name, deptName: r.dept_name, role: r.role, joinedAt: r.joined_at }))
}

export function groupMemberIds(db: Db, groupId: string): string[] {
  return db.all<{ member_id: string }>('SELECT member_id FROM group_members WHERE group_id = ?', [groupId]).map((r) => r.member_id)
}

export function isGroupMember(db: Db, groupId: string, memberId: string): 'owner' | 'member' | null {
  return db.get<{ role: 'owner' | 'member' }>('SELECT role FROM group_members WHERE group_id = ? AND member_id = ?', [groupId, memberId])?.role ?? null
}

export function addGroupMember(db: Db, groupId: string, memberId: string, role: 'owner' | 'member' = 'member'): void {
  db.run(
    `INSERT INTO group_members (group_id, member_id, role, joined_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(group_id, member_id) DO UPDATE SET role = CASE WHEN excluded.role = 'owner' THEN 'owner' ELSE group_members.role END`,
    [groupId, memberId, role, Date.now()]
  )
  db.run(`UPDATE group_invites SET state = 'accepted', updated_at = ? WHERE group_id = ? AND member_id = ? AND state = 'pending'`, [Date.now(), groupId, memberId])
}

/** Groups the member belongs to (for /api/me and the space switcher). */
export function myGroups(db: Db, memberId: string): GroupBrief[] {
  return db
    .all<{ id: string; name: string; color: string; role: 'owner' | 'member'; notify: number }>(
      `SELECT g.id, g.name, g.color, gm.role, gm.notify FROM group_members gm JOIN groups g ON g.id = gm.group_id
       WHERE gm.member_id = ? AND g.state = 'active' ORDER BY g.name`,
      [memberId]
    )
    .map((r) => ({ id: r.id, name: r.name, color: r.color, role: r.role, notify: r.notify !== 0 }))
}
