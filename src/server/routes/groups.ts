import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId } from '../../node/sqlite'
import { groupCreateSchema, groupPatchSchema, type GroupInviteDto } from '../../shared/schemas/scope'
import type { ServerContext } from '../context'
import { badRequest, forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { getSection } from '../settings'
import { addGroupMember, getGroup, groupMemberIds, groupMembers, isGroupMember, listAllGroups, listGroupsFor } from '../repos/groups'

export function notifyGroup(ctx: ServerContext, groupId: string, extra: string[] = []): void {
  ctx.hub.sendTo([...groupMemberIds(ctx.db, groupId), ...extra], 'group.changed', { id: groupId })
}

export function registerGroupRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  guards: { requireAuth: preHandlerAsyncHookHandler; requireAdmin: preHandlerAsyncHookHandler }
): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db

  /** Owner of the group or a server admin may manage it. */
  const manageable = (req: FastifyRequest, groupId: string): void => {
    const role = isGroupMember(db, groupId, req.member.id)
    if (role !== 'owner' && req.member.role !== 'admin') throw forbidden('그룹장만 할 수 있습니다.')
  }
  const loadGroup = (req: FastifyRequest, id: string) => {
    const g = getGroup(db, id, req.member.id)
    // Private groups are invisible to non-members without an invite (404 hides existence).
    if (!g || g.state === 'dissolved') throw notFound('그룹')
    if (g.visibility === 'private' && !g.myRole && g.myPending !== 'invite' && req.member.role !== 'admin') throw notFound('그룹')
    return g
  }

  app.get('/api/groups', auth, async (req) => ok(listGroupsFor(db, req.member.id)))

  app.post('/api/groups', auth, async (req) => {
    const input = parse(groupCreateSchema, req.body)
    if (getSection(db, 'ops').groupCreators === 'admins' && req.member.role !== 'admin') throw forbidden('관리자만 그룹을 만들 수 있습니다.')
    const id = newId()
    const t = Date.now()
    db.tx(() => {
      db.run(
        `INSERT INTO groups (id, name, description, color, visibility, owner_id, state, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [id, input.name, input.description || null, input.color, input.visibility, req.member.id, req.member.id, t, t]
      )
      addGroupMember(db, id, req.member.id, 'owner')
      for (const mid of new Set(input.memberIds)) {
        if (mid === req.member.id || !db.get(`SELECT 1 FROM members WHERE id = ? AND status = 'active'`, [mid])) continue
        db.run(`INSERT INTO group_invites (id, group_id, member_id, kind, state, created_by, created_at, updated_at) VALUES (?, ?, ?, 'invite', 'pending', ?, ?, ?)`, [
          newId(),
          id,
          mid,
          req.member.id,
          t,
          t
        ])
      }
    })
    logActivity(ctx, req, 'group.create', { type: 'group', id }, { name: input.name })
    ctx.hub.sendTo([req.member.id, ...input.memberIds], 'group.changed', { id })
    return ok(getGroup(db, id, req.member.id))
  })

  app.get('/api/groups/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const g = loadGroup(req, id)
    const canSeeMembers = !!g.myRole || req.member.role === 'admin' || g.visibility === 'public'
    return ok({ ...g, members: canSeeMembers ? groupMembers(db, id) : [] })
  })

  app.patch('/api/groups/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const g = loadGroup(req, id)
    const patch = parse(groupPatchSchema, req.body)
    // Per-member notification toggle is allowed for any member.
    if (patch.notify !== undefined) {
      if (!g.myRole) throw forbidden()
      db.run('UPDATE group_members SET notify = ? WHERE group_id = ? AND member_id = ?', [patch.notify ? 1 : 0, id, req.member.id])
    }
    const { notify: _n, ...rest } = patch
    if (Object.values(rest).some((v) => v !== undefined)) {
      manageable(req, id)
      if (rest.ownerId) {
        if (!isGroupMember(db, id, rest.ownerId)) throw badRequest('새 그룹장은 그룹 구성원이어야 합니다.')
        db.run(`UPDATE group_members SET role = 'member' WHERE group_id = ? AND role = 'owner'`, [id])
        db.run(`UPDATE group_members SET role = 'owner' WHERE group_id = ? AND member_id = ?`, [id, rest.ownerId])
      }
      db.run(
        `UPDATE groups SET name = COALESCE(?, name), description = COALESCE(?, description), color = COALESCE(?, color),
         visibility = COALESCE(?, visibility), state = COALESCE(?, state), owner_id = COALESCE(?, owner_id), updated_at = ? WHERE id = ?`,
        [rest.name ?? null, rest.description ?? null, rest.color ?? null, rest.visibility ?? null, rest.state ?? null, rest.ownerId ?? null, Date.now(), id]
      )
      logActivity(ctx, req, 'group.update', { type: 'group', id }, rest)
    }
    notifyGroup(ctx, id)
    return ok(getGroup(db, id, req.member.id))
  })

  /** Dissolve: members are removed so group-scoped items become invisible (except to authors). */
  app.delete('/api/groups/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    loadGroup(req, id)
    manageable(req, id)
    const members = groupMemberIds(db, id)
    db.tx(() => {
      db.run(`UPDATE groups SET state = 'dissolved', updated_at = ? WHERE id = ?`, [Date.now(), id])
      db.run('DELETE FROM group_members WHERE group_id = ?', [id])
      db.run(`UPDATE group_invites SET state = 'declined' WHERE group_id = ? AND state = 'pending'`, [id])
    })
    logActivity(ctx, req, 'group.dissolve', { type: 'group', id })
    ctx.hub.sendTo(members, 'group.membership', { id, removed: true })
    return ok({ id })
  })

  app.post('/api/groups/:id/invites', auth, async (req) => {
    const { id } = req.params as { id: string }
    const g = loadGroup(req, id)
    if (g.state !== 'active') throw badRequest('보관된 그룹에는 초대할 수 없습니다.')
    manageable(req, id)
    const { memberIds } = parse(z.object({ memberIds: z.array(z.string()).min(1).max(500) }), req.body)
    const t = Date.now()
    const invited: string[] = []
    for (const mid of new Set(memberIds)) {
      if (isGroupMember(db, id, mid)) continue
      if (!db.get(`SELECT 1 FROM members WHERE id = ? AND status = 'active'`, [mid])) continue
      const pending = db.get<{ id: string; kind: string }>(`SELECT id, kind FROM group_invites WHERE group_id = ? AND member_id = ? AND state = 'pending'`, [id, mid])
      if (pending?.kind === 'request') {
        // Inviting someone who already asked to join = approve.
        addGroupMember(db, id, mid)
        ctx.hub.sendTo([mid], 'group.membership', { id, added: true })
        continue
      }
      if (pending) continue
      db.run(`INSERT INTO group_invites (id, group_id, member_id, kind, state, created_by, created_at, updated_at) VALUES (?, ?, ?, 'invite', 'pending', ?, ?, ?)`, [
        newId(),
        id,
        mid,
        req.member.id,
        t,
        t
      ])
      invited.push(mid)
    }
    logActivity(ctx, req, 'group.invite', { type: 'group', id }, { count: invited.length })
    ctx.hub.sendTo(invited, 'group.changed', { id, invited: true })
    notifyGroup(ctx, id)
    return ok({ invited: invited.length })
  })

  app.post('/api/groups/:id/join-requests', auth, async (req) => {
    const { id } = req.params as { id: string }
    const g = loadGroup(req, id)
    if (g.visibility !== 'public') throw forbidden('비공개 그룹은 초대로만 가입할 수 있습니다.')
    if (g.myRole) throw badRequest('이미 그룹 구성원입니다.')
    if (g.myPending === 'invite' && g.inviteId) {
      addGroupMember(db, id, req.member.id)
    } else if (!g.myPending) {
      const t = Date.now()
      db.run(`INSERT INTO group_invites (id, group_id, member_id, kind, state, created_by, created_at, updated_at) VALUES (?, ?, ?, 'request', 'pending', ?, ?, ?)`, [
        newId(),
        id,
        req.member.id,
        req.member.id,
        t,
        t
      ])
    }
    const owner = db.get<{ member_id: string }>(`SELECT member_id FROM group_members WHERE group_id = ? AND role = 'owner'`, [id])
    ctx.hub.sendTo([req.member.id, ...(owner ? [owner.member_id] : [])], 'group.changed', { id })
    return ok(getGroup(db, id, req.member.id))
  })

  /** Pending invites for me + pending join requests for groups I own. */
  app.get('/api/group-invites', auth, async (req) => {
    const rows = db.all<{ id: string; group_id: string; group_name: string; color: string; member_id: string; member_name: string; kind: 'invite' | 'request'; created_at: number }>(
      `SELECT gi.id, gi.group_id, g.name AS group_name, g.color, gi.member_id, m.name AS member_name, gi.kind, gi.created_at
       FROM group_invites gi JOIN groups g ON g.id = gi.group_id JOIN members m ON m.id = gi.member_id
       WHERE gi.state = 'pending' AND g.state = 'active' AND (
         (gi.kind = 'invite' AND gi.member_id = ?) OR
         (gi.kind = 'request' AND EXISTS (SELECT 1 FROM group_members o WHERE o.group_id = gi.group_id AND o.member_id = ? AND o.role = 'owner'))
       ) ORDER BY gi.created_at DESC`,
      [req.member.id, req.member.id]
    )
    const list: GroupInviteDto[] = rows.map((r) => ({
      id: r.id,
      groupId: r.group_id,
      groupName: r.group_name,
      groupColor: r.color,
      memberId: r.member_id,
      memberName: r.member_name,
      kind: r.kind,
      createdAt: r.created_at
    }))
    return ok(list)
  })

  app.patch('/api/groups/:id/invites/:inviteId', auth, async (req) => {
    const { id, inviteId } = req.params as { id: string; inviteId: string }
    const { action } = parse(z.object({ action: z.enum(['accept', 'decline', 'approve', 'reject']) }), req.body)
    const inv = db.get<{ member_id: string; kind: string; state: string }>('SELECT member_id, kind, state FROM group_invites WHERE id = ? AND group_id = ?', [inviteId, id])
    if (!inv || inv.state !== 'pending') throw notFound('초대')
    if (inv.kind === 'invite') {
      if (inv.member_id !== req.member.id || (action !== 'accept' && action !== 'decline')) throw forbidden()
    } else {
      manageable(req, id)
      if (action !== 'approve' && action !== 'reject') throw badRequest('잘못된 처리입니다.')
    }
    const yes = action === 'accept' || action === 'approve'
    if (yes) addGroupMember(db, id, inv.member_id)
    else db.run(`UPDATE group_invites SET state = 'declined', updated_at = ? WHERE id = ?`, [Date.now(), inviteId])
    logActivity(ctx, req, `group.invite.${action}`, { type: 'group', id })
    ctx.hub.sendTo([inv.member_id], 'group.membership', { id, added: yes })
    notifyGroup(ctx, id, [inv.member_id])
    return ok({ id: inviteId, action })
  })

  app.delete('/api/groups/:id/members/:memberId', auth, async (req) => {
    const { id, memberId } = req.params as { id: string; memberId: string }
    loadGroup(req, id)
    const self = memberId === req.member.id
    if (!self) manageable(req, id)
    const role = isGroupMember(db, id, memberId)
    if (!role) throw notFound('구성원')
    if (role === 'owner') {
      const others = groupMemberIds(db, id).filter((m) => m !== memberId)
      if (others.length) throw badRequest('그룹장은 다른 구성원에게 그룹장을 넘긴 뒤 나갈 수 있습니다.')
    }
    db.run('DELETE FROM group_members WHERE group_id = ? AND member_id = ?', [id, memberId])
    if (role === 'owner') db.run(`UPDATE groups SET state = 'dissolved', updated_at = ? WHERE id = ?`, [Date.now(), id])
    logActivity(ctx, req, self ? 'group.leave' : 'group.remove', { type: 'group', id }, { memberId })
    ctx.hub.sendTo([memberId], 'group.membership', { id, removed: true })
    notifyGroup(ctx, id)
    return ok({ id, memberId })
  })

  // Admin overview: name, owner, member count only. Admins cannot read group content unless they are members (6.2 ⑤).
  app.get('/api/admin/groups', { preHandler: [guards.requireAuth, guards.requireAdmin] }, async () => ok(listAllGroups(db)))

}
