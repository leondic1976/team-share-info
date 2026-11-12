import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId, parseJson } from '../../node/sqlite'
import { PLUGIN_ID_RE, PLUGIN_STATE_MAX, pluginRoomInputSchema, type PluginInvitePayload, type PluginRoomDto } from '../../shared/schemas/plugins'
import type { ServerContext } from '../context'
import { badRequest, conflict, forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { audienceOf, scopeDto, setScope, visibleWhere } from '../scope'

interface Row {
  id: string
  plugin_id: string
  title: string
  scope_type: string
  shared: string
  closed: number
  version: number
  created_by: string
  creator_name: string
  created_at: number
  updated_at: number
}

const SELECT = 'SELECT r.*, m.name AS creator_name FROM plugin_rooms r JOIN members m ON m.id = r.created_by'
const json = (v: unknown, what: string): string => {
  const s = JSON.stringify(v ?? null)
  if (s.length > PLUGIN_STATE_MAX) throw badRequest(`${what}이(가) 너무 큽니다.`)
  return s
}

/**
 * Generic shared rooms for plugins (확장 기능 "함께하기"). The server does not know the
 * plugin's rules; it keeps two kinds of data with simple ownership:
 *  - shared: written by the room creator only
 *  - entries: one value per member, written only by that member
 * Every room has a scope (13.9); members outside it cannot see it.
 */
export function registerPluginRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db
  const pid = z.object({ pluginId: z.string().regex(PLUGIN_ID_RE) })

  const dto = (r: Row): PluginRoomDto => ({
    id: r.id,
    pluginId: r.plugin_id,
    title: r.title,
    createdBy: r.created_by,
    createdByName: r.creator_name,
    scope: scopeDto(db, 'plugin_room', r.id, r.scope_type),
    shared: parseJson(r.shared, {}),
    entries: Object.fromEntries(
      db
        .all<{ member_id: string; name: string; value: string; at: number }>('SELECT e.member_id, m.name, e.value, e.at FROM plugin_entries e JOIN members m ON m.id = e.member_id WHERE e.room_id = ? ORDER BY e.at', [r.id])
        .map((e) => [e.member_id, { name: e.name, value: parseJson(e.value, null), at: e.at }])
    ),
    closed: !!r.closed,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  })
  const visible = (pluginId: string, id: string, memberId: string): Row => {
    const w = visibleWhere('r', 'plugin_room', memberId)
    const r = db.get<Row>(`${SELECT} WHERE r.id = ? AND r.plugin_id = ? AND ${w.sql}`, [id, pluginId, ...w.params])
    if (!r) throw notFound('방')
    return r
  }
  const changed = (r: Row): void => ctx.hub.sendTo(audienceOf(db, 'plugin_rooms', 'plugin_room', r.id), 'plugin.room', { pluginId: r.plugin_id, roomId: r.id })
  const bump = (id: string): void => {
    db.run('UPDATE plugin_rooms SET version = version + 1, updated_at = ? WHERE id = ?', [Date.now(), id])
  }

  app.get('/api/plugins/:pluginId/rooms', auth, async (req) => {
    const { pluginId } = parse(pid, req.params)
    const q = parse(z.object({ closed: z.enum(['0', '1', 'all']).default('all') }), req.query)
    const w = visibleWhere('r', 'plugin_room', req.member.id)
    const extra = q.closed === 'all' ? '' : ` AND r.closed = ${q.closed === '1' ? 1 : 0}`
    return ok(db.all<Row>(`${SELECT} WHERE r.plugin_id = ? AND ${w.sql}${extra} ORDER BY r.updated_at DESC LIMIT 100`, [pluginId, ...w.params]).map(dto))
  })

  app.get('/api/plugins/:pluginId/rooms/:id', auth, async (req) => {
    const p = parse(pid.extend({ id: z.string() }), req.params)
    return ok(dto(visible(p.pluginId, p.id, req.member.id)))
  })

  app.post('/api/plugins/:pluginId/rooms', auth, async (req) => {
    const { pluginId } = parse(pid, req.params)
    const input = parse(pluginRoomInputSchema, req.body)
    const id = newId()
    const t = Date.now()
    db.tx(() => {
      db.run('INSERT INTO plugin_rooms (id, plugin_id, title, scope_type, shared, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, pluginId, input.title, input.scope.type, json(input.shared, '공유 데이터'), req.member.id, t, t])
      setScope(db, 'plugin_room', id, input.scope, req.member)
    })
    logActivity(ctx, req, 'plugin_room.create', { type: 'plugin_room', id }, { pluginId })
    const r = visible(pluginId, id, req.member.id)
    const audience = audienceOf(db, 'plugin_rooms', 'plugin_room', id)
    audience.delete(req.member.id)
    const invite: PluginInvitePayload = { pluginId, roomId: id, title: input.title, fromName: req.member.name }
    if (input.scope.type !== 'team') ctx.hub.sendTo(audience, 'plugin.invite', invite)
    changed(r)
    return ok(dto(r))
  })

  /** Creator only: replace the shared data (optionally only if the version matches). */
  app.put('/api/plugins/:pluginId/rooms/:id/shared', auth, async (req) => {
    const p = parse(pid.extend({ id: z.string() }), req.params)
    const body = parse(z.object({ shared: z.unknown(), version: z.number().int().optional(), close: z.boolean().optional() }), req.body)
    const r = visible(p.pluginId, p.id, req.member.id)
    if (r.created_by !== req.member.id) throw forbidden('방을 만든 사람만 바꿀 수 있습니다.')
    if (body.version !== undefined && body.version !== r.version) throw conflict('다른 곳에서 먼저 바뀌었습니다. 새로 고친 뒤 다시 하세요.')
    db.run('UPDATE plugin_rooms SET shared = ?, closed = COALESCE(?, closed) WHERE id = ?', [json(body.shared, '공유 데이터'), body.close === undefined ? null : body.close ? 1 : 0, r.id])
    bump(r.id)
    const n = visible(p.pluginId, p.id, req.member.id)
    changed(n)
    return ok(dto(n))
  })

  /** Each member writes only their own entry (e.g. the ladder line they picked). */
  app.put('/api/plugins/:pluginId/rooms/:id/entry', auth, async (req) => {
    const p = parse(pid.extend({ id: z.string() }), req.params)
    const body = parse(z.object({ value: z.unknown() }), req.body)
    const r = visible(p.pluginId, p.id, req.member.id)
    if (r.closed) throw badRequest('끝난 방입니다.')
    if (body.value === null || body.value === undefined) db.run('DELETE FROM plugin_entries WHERE room_id = ? AND member_id = ?', [r.id, req.member.id])
    else
      db.run('INSERT INTO plugin_entries (room_id, member_id, value, at) VALUES (?, ?, ?, ?) ON CONFLICT(room_id, member_id) DO UPDATE SET value = excluded.value, at = excluded.at', [r.id, req.member.id, json(body.value, '참여 데이터'), Date.now()])
    bump(r.id)
    const n = visible(p.pluginId, p.id, req.member.id)
    changed(n)
    return ok(dto(n))
  })

  app.delete('/api/plugins/:pluginId/rooms/:id', auth, async (req) => {
    const p = parse(pid.extend({ id: z.string() }), req.params)
    const r = visible(p.pluginId, p.id, req.member.id)
    if (r.created_by !== req.member.id && req.member.role !== 'admin') throw forbidden('방을 만든 사람과 관리자만 지울 수 있습니다.')
    const audience = audienceOf(db, 'plugin_rooms', 'plugin_room', r.id)
    db.tx(() => {
      db.run('DELETE FROM plugin_rooms WHERE id = ?', [r.id])
      db.run(`DELETE FROM scope_targets WHERE item_type = 'plugin_room' AND item_id = ?`, [r.id])
    })
    logActivity(ctx, req, 'plugin_room.delete', { type: 'plugin_room', id: r.id }, { pluginId: p.pluginId })
    ctx.hub.sendTo(audience, 'plugin.room', { pluginId: p.pluginId, roomId: r.id, deleted: true })
    return ok({ id: r.id })
  })
}
