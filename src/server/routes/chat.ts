import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId } from '../../node/sqlite'
import type { Db } from '../../node/sqlite'
import { conversationCreateSchema, messageCreateSchema, noteCreateSchema, type ConversationDto, type MessageDto, type MessageNewPayload, type NoteDto } from '../../shared/schemas/chat'
import type { ServerContext } from '../context'
import { badRequest, forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { getSection } from '../settings'
import { isGroupMember } from '../repos/groups'
import { linkAttachments, registerAttachmentOwner, deleteAttachmentsOf } from './attachments'

interface ConvRow {
  id: string
  kind: 'dm' | 'room' | 'group'
  group_id: string | null
  title: string | null
  last_seq: number
  last_message_at: number | null
  created_by?: string | null
}

const IMG = /\.(png|jpe?g|gif|bmp|webp)$/i

/** Active member ids of a conversation (group chats follow the group's membership). */
export function conversationMemberIds(db: Db, c: Pick<ConvRow, 'id' | 'kind' | 'group_id'>): string[] {
  if (c.kind === 'group' && c.group_id) {
    return db
      .all<{ member_id: string }>(
        `SELECT gm.member_id FROM group_members gm JOIN groups g ON g.id = gm.group_id JOIN members m ON m.id = gm.member_id
         WHERE gm.group_id = ? AND g.state != 'dissolved' AND m.status = 'active'`,
        [c.group_id]
      )
      .map((r) => r.member_id)
  }
  return db
    .all<{ member_id: string }>(`SELECT member_id FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL`, [c.id])
    .map((r) => r.member_id)
}

function isConversationMember(db: Db, c: ConvRow, memberId: string): boolean {
  if (c.kind === 'group') return !!c.group_id && !!isGroupMember(db, c.group_id, memberId)
  return !!db.get('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND member_id = ? AND left_at IS NULL', [c.id, memberId])
}

/** Ensure the group chat exists for each group I belong to (6.6: created automatically). */
function ensureGroupConversations(db: Db, memberId: string): void {
  const groups = db.all<{ id: string }>(
    `SELECT g.id FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.member_id = ? AND g.state = 'active'
     AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.group_id = g.id)`,
    [memberId]
  )
  const t = Date.now()
  for (const g of groups) {
    db.run(`INSERT INTO conversations (id, kind, group_id, created_at, updated_at) VALUES (?, 'group', ?, ?, ?) ON CONFLICT DO NOTHING`, [newId(), g.id, t, t])
  }
}

/** Read state row (created lazily for group chats). */
function readState(db: Db, convId: string, memberId: string): { last_read_seq: number; muted: number } {
  const r = db.get<{ last_read_seq: number; muted: number }>('SELECT last_read_seq, muted FROM conversation_members WHERE conversation_id = ? AND member_id = ?', [convId, memberId])
  if (r) return r
  db.run('INSERT INTO conversation_members (conversation_id, member_id, last_read_seq, joined_at) VALUES (?, ?, 0, ?) ON CONFLICT DO NOTHING', [convId, memberId, Date.now()])
  return { last_read_seq: 0, muted: 0 }
}

export function registerChatRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db

  registerAttachmentOwner('message', (d, msgId, memberId) => {
    const m = d.get<{ conversation_id: string }>('SELECT conversation_id FROM messages WHERE id = ? AND deleted_at IS NULL', [msgId])
    if (!m) return false
    const c = d.get<ConvRow>('SELECT * FROM conversations WHERE id = ?', [m.conversation_id])
    return !!c && isConversationMember(d, c, memberId)
  })

  const load = (req: FastifyRequest, id: string): ConvRow => {
    const c = db.get<ConvRow>('SELECT * FROM conversations WHERE id = ?', [id])
    if (!c || !isConversationMember(db, c, req.member.id)) throw notFound('대화방')
    return c
  }

  const titleOf = (c: ConvRow, viewerId: string, memberIds: string[]): string => {
    if (c.kind === 'group') return db.get<{ name: string }>('SELECT name FROM groups WHERE id = ?', [c.group_id])?.name ?? '그룹'
    if (c.title) return c.title
    const others = memberIds.filter((m) => m !== viewerId)
    const names = others.length
      ? db.all<{ name: string }>(`SELECT name FROM members WHERE id IN (${others.map(() => '?').join(',')}) ORDER BY name`, others).map((r) => r.name)
      : ['나']
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} 외 ${names.length - 3}명` : names.join(', ')
  }

  /** Other participants of a room may be removed by whoever made it and by admins (최종관리자·서무) who are in it. */
  const mayRemove = (c: ConvRow, memberId: string): boolean =>
    c.kind === 'room' && (c.created_by === memberId || db.get<{ role: string }>('SELECT role FROM members WHERE id = ?', [memberId])?.role === 'admin')

  const toDto = (c: ConvRow, viewerId: string): ConversationDto => {
    // A 1:1 is always the same two people: the one who left it (it is only hidden from their list
    // until a new message) still names the conversation for the one who stayed.
    const ids = c.kind === 'dm' ? db.all<{ member_id: string }>('SELECT member_id FROM conversation_members WHERE conversation_id = ?', [c.id]).map((r) => r.member_id) : conversationMemberIds(db, c)
    const rs = readState(db, c.id, viewerId)
    const last = db.get<{ body: string; kind: string; name: string | null }>(
      `SELECT x.body, x.kind, m.name FROM messages x LEFT JOIN members m ON m.id = x.sender_id WHERE x.conversation_id = ? AND x.deleted_at IS NULL ORDER BY x.seq DESC LIMIT 1`,
      [c.id]
    )
    const unread =
      db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND seq > ? AND deleted_at IS NULL AND (sender_id IS NULL OR sender_id != ?)`, [c.id, rs.last_read_seq, viewerId])?.n ?? 0
    return {
      id: c.id,
      kind: c.kind,
      title: titleOf(c, viewerId, ids),
      groupId: c.group_id,
      groupColor: c.group_id ? db.get<{ color: string }>('SELECT color FROM groups WHERE id = ?', [c.group_id])?.color ?? null : null,
      memberCount: ids.length,
      memberIds: ids,
      lastSeq: c.last_seq,
      lastMessageAt: c.last_message_at,
      lastPreview: last ? (last.kind === 'text' || last.kind === 'system' ? last.body.slice(0, 80) : last.kind === 'image' ? '(사진)' : '(파일)') : null,
      lastSenderName: last?.name ?? null,
      unread,
      muted: !!rs.muted,
      createdBy: c.created_by ?? null,
      canRemove: mayRemove(c, viewerId)
    }
  }

  const messageDtos = (c: ConvRow, rows: { id: string; seq: number; sender_id: string | null; sender_name: string | null; kind: MessageDto['kind']; body: string; created_at: number }[]): MessageDto[] => {
    const ids = conversationMemberIds(db, c)
    const reads = new Map(
      db
        .all<{ member_id: string; last_read_seq: number }>('SELECT member_id, last_read_seq FROM conversation_members WHERE conversation_id = ?', [c.id])
        .map((r) => [r.member_id, r.last_read_seq])
    )
    return rows.map((m) => ({
      id: m.id,
      conversationId: c.id,
      seq: m.seq,
      senderId: m.sender_id,
      senderName: m.sender_name,
      kind: m.kind,
      body: m.body,
      attachments: db.all<{ id: string; name: string; size: number }>(`SELECT id, name, size FROM attachments WHERE owner_type = 'message' AND owner_id = ?`, [m.id]),
      createdAt: m.created_at,
      unreadBy: m.kind === 'system' ? 0 : ids.filter((id) => id !== m.sender_id && (reads.get(id) ?? 0) < m.seq).length
    }))
  }

  app.get('/api/conversations', auth, async (req) => {
    ensureGroupConversations(db, req.member.id)
    const rows = db.all<ConvRow>(
      `SELECT c.* FROM conversations c WHERE
        (c.kind != 'group' AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = c.id AND cm.member_id = ? AND cm.left_at IS NULL))
        OR (c.kind = 'group' AND EXISTS (SELECT 1 FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.group_id = c.group_id AND gm.member_id = ? AND g.state != 'dissolved'))
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
      [req.member.id, req.member.id]
    )
    return ok(rows.map((c) => toDto(c, req.member.id)))
  })

  app.get('/api/chat/unread', auth, async (req) => {
    ensureGroupConversations(db, req.member.id)
    const rows = db.all<ConvRow>(
      `SELECT c.* FROM conversations c WHERE
        (c.kind != 'group' AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = c.id AND cm.member_id = ? AND cm.left_at IS NULL AND cm.muted = 0))
        OR (c.kind = 'group' AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = c.group_id AND gm.member_id = ?))`,
      [req.member.id, req.member.id]
    )
    let messages = 0
    for (const c of rows) {
      const rs = readState(db, c.id, req.member.id)
      if (rs.muted) continue
      messages += db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND seq > ? AND deleted_at IS NULL AND (sender_id IS NULL OR sender_id != ?)`, [c.id, rs.last_read_seq, req.member.id])?.n ?? 0
    }
    const notes = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notes WHERE to_id = ? AND read_at IS NULL AND deleted_by_receiver = 0', [req.member.id])?.n ?? 0
    return ok({ messages, notes })
  })

  /** Start a chat: one other person -> reuse the 1:1 conversation; otherwise a new room. */
  app.post('/api/conversations', auth, async (req) => {
    const input = parse(conversationCreateSchema, req.body)
    const others = [...new Set(input.memberIds)].filter((m) => m !== req.member.id)
    for (const m of others) if (!db.get(`SELECT 1 FROM members WHERE id = ? AND status = 'active'`, [m])) throw badRequest('없는 구성원이 포함되어 있습니다.')
    if (!others.length) throw badRequest('대화할 사람을 고르세요.')
    const t = Date.now()
    if (others.length === 1 && !input.title) {
      const key = [req.member.id, others[0]].sort().join(':')
      const existing = db.get<ConvRow>('SELECT * FROM conversations WHERE dm_key = ?', [key])
      if (existing) {
        db.run('UPDATE conversation_members SET left_at = NULL WHERE conversation_id = ?', [existing.id])
        return ok(toDto(existing, req.member.id))
      }
      const id = newId()
      db.tx(() => {
        db.run(`INSERT INTO conversations (id, kind, dm_key, created_by, created_at, updated_at) VALUES (?, 'dm', ?, ?, ?, ?)`, [id, key, req.member.id, t, t])
        for (const m of [req.member.id, others[0]]) db.run('INSERT INTO conversation_members (conversation_id, member_id, joined_at) VALUES (?, ?, ?)', [id, m, t])
      })
      return ok(toDto(db.get<ConvRow>('SELECT * FROM conversations WHERE id = ?', [id])!, req.member.id))
    }
    const id = newId()
    db.tx(() => {
      db.run(`INSERT INTO conversations (id, kind, title, created_by, created_at, updated_at) VALUES (?, 'room', ?, ?, ?, ?)`, [id, input.title || null, req.member.id, t, t])
      for (const m of [req.member.id, ...others]) db.run('INSERT INTO conversation_members (conversation_id, member_id, joined_at) VALUES (?, ?, ?)', [id, m, t])
    })
    ctx.hub.sendTo([req.member.id, ...others], 'conversation.changed', { id })
    return ok(toDto(db.get<ConvRow>('SELECT * FROM conversations WHERE id = ?', [id])!, req.member.id))
  })

  app.get('/api/conversations/:id', auth, async (req) => {
    const c = load(req, (req.params as { id: string }).id)
    const dto = toDto(c, req.member.id)
    const members = dto.memberIds.length
      ? db.all<{ id: string; name: string }>(`SELECT id, name FROM members WHERE id IN (${dto.memberIds.map(() => '?').join(',')}) ORDER BY name`, dto.memberIds)
      : []
    return ok({ ...dto, members })
  })

  app.patch('/api/conversations/:id', auth, async (req) => {
    const c = load(req, (req.params as { id: string }).id)
    const p = parse(z.object({ title: z.string().trim().max(60).optional(), muted: z.boolean().optional() }), req.body)
    if (p.muted !== undefined) {
      readState(db, c.id, req.member.id)
      db.run('UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND member_id = ?', [p.muted ? 1 : 0, c.id, req.member.id])
    }
    if (p.title !== undefined) {
      if (c.kind !== 'room') throw badRequest('대화방 이름은 여러 명 대화방에서만 바꿀 수 있습니다.')
      db.run('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', [p.title || null, Date.now(), c.id])
      ctx.hub.sendTo(conversationMemberIds(db, c), 'conversation.changed', { id: c.id })
    }
    return ok(toDto(db.get<ConvRow>('SELECT * FROM conversations WHERE id = ?', [c.id])!, req.member.id))
  })

  /** Both people of a 1:1 conversation, also one who left it. */
  const conversationMemberIdsAll = (convId: string): string[] =>
    db.all<{ member_id: string }>('SELECT member_id FROM conversation_members WHERE conversation_id = ?', [convId]).map((r) => r.member_id)

  const systemMessage = (c: ConvRow, body: string): void => {
    const seq = c.last_seq + 1
    const t = Date.now()
    db.run(`INSERT INTO messages (id, conversation_id, seq, sender_id, kind, body, created_at) VALUES (?, ?, ?, NULL, 'system', ?, ?)`, [newId(), c.id, seq, body, t])
    db.run('UPDATE conversations SET last_seq = ?, last_message_at = ?, updated_at = ? WHERE id = ?', [seq, t, t, c.id])
    c.last_seq = seq
  }

  app.post('/api/conversations/:id/members', auth, async (req) => {
    const c = load(req, (req.params as { id: string }).id)
    if (c.kind === 'group') throw badRequest('그룹 대화방의 참가자는 그룹에서 관리합니다.')
    const { memberIds } = parse(z.object({ memberIds: z.array(z.string()).min(1).max(200) }), req.body)
    const t = Date.now()
    const added: string[] = []
    if (c.kind === 'dm') {
      // A 1:1 conversation stays the private pair it is reused as: more people means a new room (history is not copied).
      const pair = conversationMemberIdsAll(c.id)
      const extra = [...new Set(memberIds)].filter((m) => !pair.includes(m) && !!db.get(`SELECT 1 FROM members WHERE id = ? AND status = 'active'`, [m]))
      if (!extra.length) throw badRequest('추가할 사람을 고르세요.')
      const id = newId()
      const all = [...new Set([req.member.id, ...pair, ...extra])]
      db.tx(() => {
        db.run(`INSERT INTO conversations (id, kind, created_by, created_at, updated_at) VALUES (?, 'room', ?, ?, ?)`, [id, req.member.id, t, t])
        for (const m of all) db.run('INSERT INTO conversation_members (conversation_id, member_id, joined_at) VALUES (?, ?, ?)', [id, m, t])
        const room = db.get<ConvRow>('SELECT * FROM conversations WHERE id = ?', [id])!
        const names = extra.map((m) => db.get<{ name: string }>('SELECT name FROM members WHERE id = ?', [m])!.name)
        systemMessage(room, `${req.member.name}님이 ${names.join(', ')}님을 추가해 새 대화방을 만들었습니다.`)
      })
      ctx.hub.sendTo(all, 'conversation.changed', { id })
      return ok({ added: extra.length, conversationId: id, created: true })
    }
    const active = new Set(conversationMemberIds(db, c))
    db.tx(() => {
      for (const m of new Set(memberIds)) {
        if (active.has(m) || !db.get(`SELECT 1 FROM members WHERE id = ? AND status = 'active'`, [m])) continue
        db.run(
          `INSERT INTO conversation_members (conversation_id, member_id, last_read_seq, joined_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(conversation_id, member_id) DO UPDATE SET left_at = NULL`,
          [c.id, m, c.last_seq, t]
        )
        added.push(db.get<{ name: string }>('SELECT name FROM members WHERE id = ?', [m])!.name)
      }
      if (added.length) systemMessage(c, `${req.member.name}님이 ${added.join(', ')}님을 초대했습니다.`)
    })
    ctx.hub.sendTo(conversationMemberIds(db, c), 'conversation.changed', { id: c.id })
    return ok({ added: added.length, conversationId: c.id, created: false })
  })

  /** Remove another participant from a room (registered beside `/members/me`, which stays "leave"). */
  app.delete('/api/conversations/:id/members/:memberId', auth, async (req) => {
    const { id, memberId } = req.params as { id: string; memberId: string }
    const c = load(req, id)
    if (c.kind === 'group') throw badRequest('그룹 대화방의 참가자는 그룹에서 관리합니다.')
    if (c.kind === 'dm') throw badRequest('1:1 대화에서는 내보낼 수 없습니다.')
    if (memberId === req.member.id) throw badRequest('본인은 나가기를 사용하세요.')
    if (!mayRemove(c, req.member.id)) throw forbidden('대화방을 만든 사람과 관리자만 내보낼 수 있습니다.')
    const target = db.get<{ name: string }>(
      `SELECT m.name FROM conversation_members cm JOIN members m ON m.id = cm.member_id WHERE cm.conversation_id = ? AND cm.member_id = ? AND cm.left_at IS NULL`,
      [c.id, memberId]
    )
    if (!target) throw notFound('참가자')
    db.tx(() => {
      db.run('UPDATE conversation_members SET left_at = ? WHERE conversation_id = ? AND member_id = ?', [Date.now(), c.id, memberId])
      systemMessage(c, `${req.member.name}님이 ${target.name}님을 내보냈습니다.`)
    })
    // the removed member hears it once (so the room disappears on their PC) and nothing after that
    ctx.hub.sendTo([...conversationMemberIds(db, c), memberId], 'conversation.changed', { id: c.id, removed: [memberId] })
    return ok({ id: c.id })
  })

  app.delete('/api/conversations/:id/members/me', auth, async (req) => {
    const c = load(req, (req.params as { id: string }).id)
    if (c.kind === 'group') throw badRequest('그룹 대화방은 그룹에서 나가야 빠집니다.')
    db.tx(() => {
      db.run('UPDATE conversation_members SET left_at = ? WHERE conversation_id = ? AND member_id = ?', [Date.now(), c.id, req.member.id])
      if (c.kind === 'room') systemMessage(c, `${req.member.name}님이 나갔습니다.`)
    })
    ctx.hub.sendTo([...conversationMemberIds(db, c), req.member.id], 'conversation.changed', { id: c.id })
    return ok({ id: c.id })
  })

  app.get('/api/conversations/:id/messages', auth, async (req) => {
    const c = load(req, (req.params as { id: string }).id)
    const q = parse(z.object({ before: z.coerce.number().int().optional(), after: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query)
    const where = ['x.conversation_id = ?', 'x.deleted_at IS NULL']
    const params: (string | number)[] = [c.id]
    if (q.before !== undefined) {
      where.push('x.seq < ?')
      params.push(q.before)
    }
    if (q.after !== undefined) {
      where.push('x.seq > ?')
      params.push(q.after)
    }
    const rows = db.all<{ id: string; seq: number; sender_id: string | null; sender_name: string | null; kind: MessageDto['kind']; body: string; created_at: number }>(
      `SELECT x.id, x.seq, x.sender_id, CASE WHEN IFNULL(LENGTH(m.nickname), 0) = 0 THEN m.name ELSE m.name || char(40) || m.nickname || char(41) END AS sender_name, x.kind, x.body, x.created_at FROM messages x LEFT JOIN members m ON m.id = x.sender_id
       WHERE ${where.join(' AND ')} ORDER BY x.seq ${q.after !== undefined ? 'ASC' : 'DESC'} LIMIT ?`,
      [...params, q.limit]
    )
    if (q.after === undefined) rows.reverse()
    return ok(messageDtos(c, rows))
  })

  app.post('/api/conversations/:id/messages', auth, async (req) => {
    const c = load(req, (req.params as { id: string }).id)
    const input = parse(messageCreateSchema, req.body)
    const t = Date.now()
    const out: { id: string; seq: number; kind: MessageDto['kind']; body: string }[] = []
    db.tx(() => {
      const cur = db.get<{ last_seq: number }>('SELECT last_seq FROM conversations WHERE id = ?', [c.id])!
      let seq = cur.last_seq
      const insert = (kind: MessageDto['kind'], body: string): string => {
        seq++
        const id = newId()
        db.run('INSERT INTO messages (id, conversation_id, seq, sender_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, c.id, seq, req.member.id, kind, body, t])
        out.push({ id, seq, kind, body })
        return id
      }
      // Each attachment becomes its own message (image or file), then the text.
      for (const aid of input.attachmentIds) {
        const a = db.get<{ name: string }>(`SELECT name FROM attachments WHERE id = ? AND owner_type = 'pending' AND created_by = ?`, [aid, req.member.id])
        if (!a) continue
        const mid = insert(IMG.test(a.name) ? 'image' : 'file', a.name)
        linkAttachments(ctx, [aid], 'message', mid, req.member.id)
      }
      if (input.body.trim()) insert('text', input.body)
      db.run('UPDATE conversations SET last_seq = ?, last_message_at = ?, updated_at = ? WHERE id = ?', [seq, t, t, c.id])
      readState(db, c.id, req.member.id)
      db.run('UPDATE conversation_members SET last_read_seq = ? WHERE conversation_id = ? AND member_id = ?', [seq, c.id, req.member.id])
      // A 1:1 chat reappears for someone who left it when a new message arrives.
      if (c.kind === 'dm') db.run('UPDATE conversation_members SET left_at = NULL WHERE conversation_id = ?', [c.id])
    })
    const members = conversationMemberIds(db, c)
    const title = titleOf(c, '', members)
    const last = out[out.length - 1]
    if (last) {
      const payload: MessageNewPayload = {
        conversationId: c.id,
        seq: last.seq,
        senderId: req.member.id,
        senderName: req.member.name,
        preview: last.kind === 'text' ? last.body.slice(0, 100) : last.kind === 'image' ? '(사진)' : `(파일) ${last.body}`,
        title: c.kind === 'dm' ? req.member.name : title
      }
      ctx.hub.sendTo(members, 'message.new', payload)
    }
    return ok({ seqs: out.map((o) => o.seq) })
  })

  app.post('/api/conversations/:id/read', auth, async (req) => {
    const c = load(req, (req.params as { id: string }).id)
    const { seq } = parse(z.object({ seq: z.number().int().min(0) }), req.body)
    readState(db, c.id, req.member.id)
    const r = db.run('UPDATE conversation_members SET last_read_seq = ? WHERE conversation_id = ? AND member_id = ? AND last_read_seq < ?', [Math.min(seq, c.last_seq), c.id, req.member.id, seq])
    if (r.changes) ctx.hub.sendTo(conversationMemberIds(db, c), 'conversation.read', { id: c.id, memberId: req.member.id, seq })
    return ok({ id: c.id })
  })

  app.delete('/api/messages/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const m = db.get<{ conversation_id: string; sender_id: string | null }>('SELECT conversation_id, sender_id FROM messages WHERE id = ? AND deleted_at IS NULL', [id])
    if (!m) throw notFound('메시지')
    const c = load(req, m.conversation_id)
    if (m.sender_id !== req.member.id) throw forbidden('내가 보낸 메시지만 지울 수 있습니다.')
    db.run('UPDATE messages SET deleted_at = ? WHERE id = ?', [Date.now(), id])
    deleteAttachmentsOf(ctx, 'message', id)
    ctx.hub.sendTo(conversationMemberIds(db, c), 'conversation.changed', { id: c.id })
    return ok({ id })
  })

  app.get('/api/messages/search', auth, async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().min(1).max(100) }), req.query)
    const rows = db.all<{ id: string; conversation_id: string; seq: number; body: string; created_at: number; sender_name: string | null }>(
      `SELECT x.id, x.conversation_id, x.seq, x.body, x.created_at, CASE WHEN IFNULL(LENGTH(m.nickname), 0) = 0 THEN m.name ELSE m.name || char(40) || m.nickname || char(41) END AS sender_name FROM messages x LEFT JOIN members m ON m.id = x.sender_id
       WHERE x.deleted_at IS NULL AND x.kind != 'system' AND x.body LIKE ? ORDER BY x.created_at DESC LIMIT 300`,
      [`%${q}%`]
    )
    const allowed = new Map<string, boolean>()
    const out = []
    for (const r of rows) {
      if (!allowed.has(r.conversation_id)) {
        const c = db.get<ConvRow>('SELECT * FROM conversations WHERE id = ?', [r.conversation_id])
        allowed.set(r.conversation_id, !!c && isConversationMember(db, c, req.member.id))
      }
      if (allowed.get(r.conversation_id)) out.push({ ...r, conversationId: r.conversation_id, senderName: r.sender_name, createdAt: r.created_at })
      if (out.length >= 100) break
    }
    return ok(out.map((r) => ({ id: r.id, conversationId: r.conversationId, seq: r.seq, body: r.body, senderName: r.senderName, createdAt: r.createdAt })))
  })

  // ---- 쪽지 (notes): one-way messages that wait in the inbox (6.7) ----
  const noteDto = (r: { id: string; batch_id: string; from_id: string; from_name: string; to_id: string; to_name: string; body: string; created_at: number; read_at: number | null }): NoteDto => ({
    id: r.id,
    batchId: r.batch_id,
    fromId: r.from_id,
    fromName: r.from_name,
    toId: r.to_id,
    toName: r.to_name,
    body: r.body,
    createdAt: r.created_at,
    readAt: r.read_at
  })
  const NOTE_SELECT = `SELECT n.*, CASE WHEN IFNULL(LENGTH(f.nickname), 0) = 0 THEN f.name ELSE f.name || char(40) || f.nickname || char(41) END AS from_name, CASE WHEN IFNULL(LENGTH(t.nickname), 0) = 0 THEN t.name ELSE t.name || char(40) || t.nickname || char(41) END AS to_name FROM notes n JOIN members f ON f.id = n.from_id JOIN members t ON t.id = n.to_id`

  app.get('/api/notes', auth, async (req) => {
    const { box } = parse(z.object({ box: z.enum(['inbox', 'sent']).default('inbox') }), req.query)
    const rows =
      box === 'inbox'
        ? db.all(`${NOTE_SELECT} WHERE n.to_id = ? AND n.deleted_by_receiver = 0 ORDER BY n.created_at DESC LIMIT 300`, [req.member.id])
        : db.all(`${NOTE_SELECT} WHERE n.from_id = ? AND n.deleted_by_sender = 0 ORDER BY n.created_at DESC LIMIT 300`, [req.member.id])
    return ok((rows as Parameters<typeof noteDto>[0][]).map(noteDto))
  })

  app.post('/api/notes', auth, async (req) => {
    const input = parse(noteCreateSchema, req.body)
    const batch = newId()
    const t = Date.now()
    const to = [...new Set(input.toIds)].filter((id) => !!db.get(`SELECT 1 FROM members WHERE id = ? AND status = 'active'`, [id]))
    if (!to.length) throw badRequest('받는 사람을 고르세요.')
    db.tx(() => {
      for (const id of to) db.run('INSERT INTO notes (id, from_id, to_id, batch_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', [newId(), req.member.id, id, batch, input.body, t])
    })
    logActivity(ctx, req, 'note.send', { type: 'note', id: batch }, { count: to.length })
    ctx.hub.sendTo(to, 'note.new', { fromName: req.member.name, preview: input.body.slice(0, 100) })
    ctx.hub.sendTo([req.member.id], 'note.changed', {})
    return ok({ batchId: batch, count: to.length })
  })

  app.post('/api/notes/:id/read', auth, async (req) => {
    const { id } = req.params as { id: string }
    const n = db.get<{ from_id: string }>('SELECT from_id FROM notes WHERE id = ? AND to_id = ?', [id, req.member.id])
    if (!n) throw notFound('쪽지')
    db.run('UPDATE notes SET read_at = COALESCE(read_at, ?) WHERE id = ?', [Date.now(), id])
    ctx.hub.sendTo([n.from_id, req.member.id], 'note.changed', { id })
    return ok({ id })
  })

  app.delete('/api/notes/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const n = db.get<{ from_id: string; to_id: string }>('SELECT from_id, to_id FROM notes WHERE id = ?', [id])
    if (!n || (n.from_id !== req.member.id && n.to_id !== req.member.id)) throw notFound('쪽지')
    if (n.to_id === req.member.id) db.run('UPDATE notes SET deleted_by_receiver = 1 WHERE id = ?', [id])
    if (n.from_id === req.member.id) db.run('UPDATE notes SET deleted_by_sender = 1 WHERE id = ?', [id])
    db.run('DELETE FROM notes WHERE id = ? AND deleted_by_sender = 1 AND deleted_by_receiver = 1', [id])
    return ok({ id })
  })
}

/** Retention (관리 → 메시지 보관 기간): delete old messages, their attachments and old notes. */
export function runChatJobs(ctx: ServerContext, now = Date.now()): number {
  const days = getSection(ctx.db, 'ops').messageRetentionDays
  const cutoff = now - days * 86400000
  const old = ctx.db.all<{ id: string }>('SELECT id FROM messages WHERE created_at < ? LIMIT 5000', [cutoff])
  for (const m of old) {
    deleteAttachmentsOf(ctx, 'message', m.id)
    ctx.db.run('DELETE FROM messages WHERE id = ?', [m.id])
  }
  ctx.db.run('DELETE FROM notes WHERE created_at < ?', [cutoff])
  return old.length
}
