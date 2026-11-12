import type { Db } from '../node/sqlite'
import type { ScopeDto, ScopeInput } from '../shared/schemas/scope'
import { badRequest } from './errors'

/**
 * Visibility rules for every shared item (13.9). All shared resources use only
 * these functions. Items carry scope_type; group/member targets live in scope_targets.
 *
 * Visible when: scope_type = 'team', OR the viewer is the author, OR a scope target
 * names the viewer, OR names an active group the viewer belongs to.
 */
export function visibleWhere(alias: string, itemType: string, memberId: string): { sql: string; params: string[] } {
  return {
    sql: `(${alias}.scope_type = 'team' OR ${alias}.created_by = ? OR EXISTS (
      SELECT 1 FROM scope_targets st WHERE st.item_type = ? AND st.item_id = ${alias}.id AND (
        (st.target_type = 'member' AND st.target_id = ?) OR
        (st.target_type = 'group' AND st.target_id IN (
          SELECT gm.group_id FROM group_members gm JOIN groups g ON g.id = gm.group_id
          WHERE gm.member_id = ? AND g.state != 'dissolved'))
      )))`,
    params: [memberId, itemType, memberId, memberId]
  }
}

export function canSee(db: Db, table: string, itemType: string, itemId: string, memberId: string): boolean {
  const w = visibleWhere('t', itemType, memberId)
  return !!db.get(`SELECT 1 FROM ${table} t WHERE t.id = ? AND ${w.sql}`, [itemId, ...w.params])
}

/** Members who can see the item: used for realtime events and receipts. */
export function audienceOf(db: Db, table: string, itemType: string, itemId: string): Set<string> {
  const item = db.get<{ scope_type: string; created_by: string | null }>(`SELECT scope_type, created_by FROM ${table} WHERE id = ?`, [itemId])
  if (!item) return new Set()
  if (item.scope_type === 'team') {
    return new Set(db.all<{ id: string }>(`SELECT id FROM members WHERE status = 'active'`).map((r) => r.id))
  }
  const ids = new Set<string>()
  if (item.created_by) ids.add(item.created_by)
  const rows = db.all<{ id: string }>(
    `SELECT st.target_id AS id FROM scope_targets st JOIN members m ON m.id = st.target_id
       WHERE st.item_type = ? AND st.item_id = ? AND st.target_type = 'member' AND m.status = 'active'
     UNION
     SELECT gm.member_id AS id FROM scope_targets st
       JOIN groups g ON g.id = st.target_id AND g.state != 'dissolved'
       JOIN group_members gm ON gm.group_id = g.id
       JOIN members m ON m.id = gm.member_id AND m.status = 'active'
       WHERE st.item_type = ? AND st.item_id = ? AND st.target_type = 'group'`,
    [itemType, itemId, itemType, itemId]
  )
  for (const r of rows) ids.add(r.id)
  return ids
}

export function myGroupIds(db: Db, memberId: string): string[] {
  return db
    .all<{ group_id: string }>(
      `SELECT gm.group_id FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.member_id = ? AND g.state = 'active'`,
      [memberId]
    )
    .map((r) => r.group_id)
}

/**
 * Store the scope targets of an item. Authors may only target active groups
 * they belong to (admins any active group).
 */
export function setScope(db: Db, itemType: string, itemId: string, scope: ScopeInput, actor: { id: string; role: string }): void {
  db.run('DELETE FROM scope_targets WHERE item_type = ? AND item_id = ?', [itemType, itemId])
  if (scope.type === 'group') {
    const mine = new Set(myGroupIds(db, actor.id))
    for (const gid of new Set(scope.groupIds)) {
      const g = db.get<{ state: string }>('SELECT state FROM groups WHERE id = ?', [gid])
      if (!g || g.state !== 'active') throw badRequest('보관되었거나 없는 그룹에는 올릴 수 없습니다.')
      if (!mine.has(gid) && actor.role !== 'admin') throw badRequest('내가 속한 그룹에만 공유할 수 있습니다.')
      db.run(`INSERT INTO scope_targets (item_type, item_id, target_type, target_id) VALUES (?, ?, 'group', ?)`, [itemType, itemId, gid])
    }
  } else if (scope.type === 'members') {
    for (const mid of new Set(scope.memberIds)) {
      if (!db.get('SELECT 1 FROM members WHERE id = ?', [mid])) throw badRequest('없는 구성원이 포함되어 있습니다.')
      db.run(`INSERT INTO scope_targets (item_type, item_id, target_type, target_id) VALUES (?, ?, 'member', ?)`, [itemType, itemId, mid])
    }
  }
}

export function scopeDto(db: Db, itemType: string, itemId: string, scopeType: string): ScopeDto {
  const groups = db.all<{ id: string; name: string; color: string }>(
    `SELECT g.id, g.name, g.color FROM scope_targets st JOIN groups g ON g.id = st.target_id
     WHERE st.item_type = ? AND st.item_id = ? AND st.target_type = 'group' ORDER BY g.name`,
    [itemType, itemId]
  )
  const members = db.all<{ id: string; name: string }>(
    `SELECT m.id, m.name FROM scope_targets st JOIN members m ON m.id = st.target_id
     WHERE st.item_type = ? AND st.item_id = ? AND st.target_type = 'member' ORDER BY m.name`,
    [itemType, itemId]
  )
  return { type: scopeType as ScopeDto['type'], groups, members }
}

/** SQL fragment restricting to items scoped to a given group (for ?groupId= filters). */
export function inGroupWhere(alias: string, itemType: string): string {
  return `EXISTS (SELECT 1 FROM scope_targets sg WHERE sg.item_type = '${itemType}' AND sg.item_id = ${alias}.id AND sg.target_type = 'group' AND sg.target_id = ?)`
}
