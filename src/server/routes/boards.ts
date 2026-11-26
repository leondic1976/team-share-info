import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId } from '../../node/sqlite'
import type { Db } from '../../node/sqlite'
import { boardInputSchema, postInputSchema, type BoardDto, type PollDto, type PostDto, type PostSummaryDto } from '../../shared/schemas/work'
import type { ServerContext } from '../context'
import { badRequest, forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { audienceOf, canSee, scopeDto, setScope, visibleWhere } from '../scope'
import { cleanHtml } from '../html'
import { deleteAttachmentsOf, linkAttachments, listAttachments, registerAttachmentOwner } from './attachments'
import { commentCount, registerCommentOwner } from './comments'
import { choseongOr } from '../choseong'

interface BoardRow {
  id: string
  name: string
  kind: BoardDto['kind']
  description: string | null
  scope_type: string
  sort: number
  created_by: string
}

interface PostRow {
  id: string
  board_id: string
  title: string
  body_html: string
  pinned: number
  created_by: string
  author_name: string
  created_at: number
  updated_at: number
}

const POST_SELECT = `SELECT p.*, CASE WHEN IFNULL(LENGTH(m.nickname), 0) = 0 THEN m.name ELSE m.name || char(40) || m.nickname || char(41) END AS author_name FROM posts p JOIN members m ON m.id = p.created_by`

function boardVisible(db: Db, boardId: string, memberId: string): boolean {
  return !!db.get('SELECT 1 FROM boards WHERE id = ? AND deleted_at IS NULL', [boardId]) && canSee(db, 'boards', 'board', boardId, memberId)
}

function postBoard(db: Db, postId: string): string | null {
  return db.get<{ board_id: string }>('SELECT board_id FROM posts WHERE id = ? AND deleted_at IS NULL', [postId])?.board_id ?? null
}

/** Boards with posts, comments, view tracking and polls (6.9). */
export function registerBoardRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler; requireAdmin: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db
  const notifyBoard = (boardId: string, postId?: string): void => ctx.hub.sendTo(audienceOf(db, 'boards', 'board', boardId), 'post.changed', { boardId, postId })

  const postCheck = (d: Db, postId: string, m: string): boolean => {
    const b = postBoard(d, postId)
    return !!b && boardVisible(d, b, m)
  }
  registerAttachmentOwner('post', postCheck)
  registerCommentOwner('post', postCheck, (postId) => {
    const b = postBoard(db, postId)
    if (b) notifyBoard(b, postId)
  })

  const canManageBoard = (b: BoardRow, req: FastifyRequest): boolean => req.member.role === 'admin' || b.created_by === req.member.id

  const loadBoard = (req: FastifyRequest, id: string): BoardRow => {
    const b = db.get<BoardRow>('SELECT * FROM boards WHERE id = ? AND deleted_at IS NULL', [id])
    if (!b || !canSee(db, 'boards', 'board', id, req.member.id)) throw notFound('게시판')
    return b
  }
  const loadPost = (req: FastifyRequest, id: string): PostRow => {
    const p = db.get<PostRow>(`${POST_SELECT} WHERE p.id = ? AND p.deleted_at IS NULL`, [id])
    if (!p || !boardVisible(db, p.board_id, req.member.id)) throw notFound('글')
    return p
  }

  const summary = (p: PostRow, viewerId: string): PostSummaryDto => ({
    id: p.id,
    boardId: p.board_id,
    title: p.title,
    authorId: p.created_by,
    authorName: p.author_name,
    pinned: !!p.pinned,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    viewCount: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM post_views WHERE post_id = ?', [p.id])?.n ?? 0,
    commentCount: commentCount(db, 'post', p.id),
    attachmentCount: listAttachments(db, 'post', p.id).length,
    hasPoll: !!db.get('SELECT 1 FROM polls WHERE post_id = ?', [p.id]),
    read: p.created_by === viewerId || !!db.get('SELECT 1 FROM post_views WHERE post_id = ? AND member_id = ?', [p.id, viewerId])
  })

  const pollDto = (postId: string, viewerId: string): PollDto | null => {
    const poll = db.get<{ id: string; question: string; multiple: number; anonymous: number; closes_at: number | null; closed_at: number | null }>('SELECT * FROM polls WHERE post_id = ?', [postId])
    if (!poll) return null
    const closed = !!poll.closed_at || (!!poll.closes_at && poll.closes_at < Date.now())
    const options = db.all<{ id: string; label: string }>('SELECT id, label FROM poll_options WHERE poll_id = ? ORDER BY sort', [poll.id])
    return {
      id: poll.id,
      question: poll.question,
      multiple: !!poll.multiple,
      anonymous: !!poll.anonymous,
      closesAt: poll.closes_at,
      closed,
      options: options.map((o) => {
        const voters = db.all<{ name: string }>('SELECT m.name FROM poll_votes v JOIN members m ON m.id = v.member_id WHERE v.option_id = ? ORDER BY m.name', [o.id])
        return { id: o.id, label: o.label, votes: voters.length, ...(poll.anonymous ? {} : { voters: voters.map((v) => v.name) }) }
      }),
      myVotes: db.all<{ option_id: string }>('SELECT option_id FROM poll_votes WHERE poll_id = ? AND member_id = ?', [poll.id, viewerId]).map((r) => r.option_id),
      totalVoters: db.get<{ n: number }>('SELECT COUNT(DISTINCT member_id) AS n FROM poll_votes WHERE poll_id = ?', [poll.id])?.n ?? 0
    }
  }

  // ---- boards ----
  app.get('/api/boards', auth, async (req) => {
    const w = visibleWhere('b', 'board', req.member.id)
    const rows = db.all<BoardRow>(`SELECT b.* FROM boards b WHERE b.deleted_at IS NULL AND ${w.sql} ORDER BY b.sort, b.name`, w.params)
    return ok(
      rows.map((b): BoardDto => ({
        id: b.id,
        name: b.name,
        kind: b.kind,
        description: b.description,
        scope: scopeDto(db, 'board', b.id, b.scope_type),
        sort: b.sort,
        postCount: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM posts WHERE board_id = ? AND deleted_at IS NULL', [b.id])?.n ?? 0,
        unreadCount:
          db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM posts p WHERE p.board_id = ? AND p.deleted_at IS NULL AND p.created_by != ? AND p.created_at > ?
             AND NOT EXISTS (SELECT 1 FROM post_views v WHERE v.post_id = p.id AND v.member_id = ?)`,
            [b.id, req.member.id, Date.now() - 30 * 86400000, req.member.id]
          )?.n ?? 0,
        canManage: canManageBoard(b, req)
      }))
    )
  })

  // Creating boards is an admin task (6.9 관리자가 게시판 생성); group owners may create boards for their groups.
  app.post('/api/boards', auth, async (req) => {
    const input = parse(boardInputSchema, req.body)
    const isGroupOwner =
      input.scope.type === 'group' &&
      input.scope.groupIds.every((g) => !!db.get(`SELECT 1 FROM group_members WHERE group_id = ? AND member_id = ? AND role = 'owner'`, [g, req.member.id]))
    if (req.member.role !== 'admin' && !isGroupOwner) throw forbidden('게시판은 관리자(또는 그룹 게시판은 그룹장)가 만듭니다.')
    const id = newId()
    const t = Date.now()
    db.tx(() => {
      db.run(`INSERT INTO boards (id, name, kind, description, scope_type, sort, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        input.name,
        input.kind,
        input.description || null,
        input.scope.type,
        input.sort,
        req.member.id,
        t,
        t
      ])
      setScope(db, 'board', id, input.scope, req.member)
    })
    logActivity(ctx, req, 'board.create', { type: 'board', id }, { name: input.name })
    ctx.hub.sendTo(audienceOf(db, 'boards', 'board', id), 'board.changed', { id })
    return ok({ id })
  })

  app.patch('/api/boards/:id', auth, async (req) => {
    const b = loadBoard(req, (req.params as { id: string }).id)
    if (!canManageBoard(b, req)) throw forbidden()
    const p = parse(boardInputSchema.partial(), req.body)
    const before = audienceOf(db, 'boards', 'board', b.id)
    db.tx(() => {
      db.run('UPDATE boards SET name = COALESCE(?, name), kind = COALESCE(?, kind), description = COALESCE(?, description), sort = COALESCE(?, sort), updated_at = ? WHERE id = ?', [
        p.name ?? null,
        p.kind ?? null,
        p.description ?? null,
        p.sort ?? null,
        Date.now(),
        b.id
      ])
      if (p.scope) {
        db.run('UPDATE boards SET scope_type = ? WHERE id = ?', [p.scope.type, b.id])
        setScope(db, 'board', b.id, p.scope, req.member)
      }
    })
    ctx.hub.sendTo([...before, ...audienceOf(db, 'boards', 'board', b.id)], 'board.changed', { id: b.id })
    return ok({ id: b.id })
  })

  app.delete('/api/boards/:id', auth, async (req) => {
    const b = loadBoard(req, (req.params as { id: string }).id)
    if (!canManageBoard(b, req)) throw forbidden()
    const audience = audienceOf(db, 'boards', 'board', b.id)
    db.run('UPDATE boards SET deleted_at = ? WHERE id = ?', [Date.now(), b.id])
    logActivity(ctx, req, 'board.delete', { type: 'board', id: b.id }, { name: b.name })
    ctx.hub.sendTo(audience, 'board.changed', { id: b.id })
    return ok({ id: b.id })
  })

  // ---- posts ----
  app.get('/api/boards/:id/posts', auth, async (req) => {
    const b = loadBoard(req, (req.params as { id: string }).id)
    const q = parse(z.object({ q: z.string().max(100).default(''), before: z.coerce.number().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query)
    const where = ['p.board_id = ?', 'p.deleted_at IS NULL']
    const params: (string | number)[] = [b.id]
    if (q.q.trim()) {
      const c = choseongOr(q.q, ['p.title'])
      where.push(`(p.title LIKE ? OR p.body_html LIKE ?${c.sql})`)
      params.push(`%${q.q.trim()}%`, `%${q.q.trim()}%`, ...c.params)
    }
    if (q.before) {
      where.push('p.created_at < ?')
      params.push(q.before)
    }
    const rows = db.all<PostRow>(`${POST_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${q.before ? '' : 'p.pinned DESC,'} p.created_at DESC LIMIT ?`, [...params, q.limit])
    return ok(rows.map((p) => summary(p, req.member.id)))
  })

  app.get('/api/posts/:id', auth, async (req) => {
    const p = loadPost(req, (req.params as { id: string }).id)
    // The author's own views are not counted (6.9 조회자 확인).
    if (p.created_by !== req.member.id) db.run('INSERT INTO post_views (post_id, member_id, viewed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [p.id, req.member.id, Date.now()])
    const b = db.get<BoardRow>('SELECT * FROM boards WHERE id = ?', [p.board_id])!
    const dto: PostDto = {
      ...summary(p, req.member.id),
      bodyHtml: p.body_html,
      attachments: listAttachments(db, 'post', p.id),
      poll: pollDto(p.id, req.member.id),
      canEdit: p.created_by === req.member.id || canManageBoard(b, req)
    }
    return ok(dto)
  })

  app.get('/api/posts/:id/views', auth, async (req) => {
    const p = loadPost(req, (req.params as { id: string }).id)
    return ok(
      db.all<{ name: string; viewed_at: number }>('SELECT m.name, v.viewed_at FROM post_views v JOIN members m ON m.id = v.member_id WHERE v.post_id = ? ORDER BY v.viewed_at DESC', [p.id]).map((v) => ({
        name: v.name,
        viewedAt: v.viewed_at
      }))
    )
  })

  app.post('/api/posts', auth, async (req) => {
    const input = parse(postInputSchema, req.body)
    const b = loadBoard(req, input.boardId)
    if (input.pinned && !canManageBoard(b, req)) throw forbidden('고정은 게시판 관리자만 할 수 있습니다.')
    const id = newId()
    const t = Date.now()
    db.tx(() => {
      db.run('INSERT INTO posts (id, board_id, title, body_html, pinned, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        b.id,
        input.title,
        cleanHtml(input.bodyHtml),
        input.pinned ? 1 : 0,
        req.member.id,
        t,
        t
      ])
      linkAttachments(ctx, input.attachmentIds, 'post', id, req.member.id)
      if (input.poll) {
        const pid = newId()
        db.run('INSERT INTO polls (id, post_id, question, multiple, anonymous, closes_at) VALUES (?, ?, ?, ?, ?, ?)', [
          pid,
          id,
          input.poll.question,
          input.poll.multiple ? 1 : 0,
          input.poll.anonymous ? 1 : 0,
          input.poll.closesAt
        ])
        input.poll.options.forEach((label, i) => db.run('INSERT INTO poll_options (id, poll_id, label, sort) VALUES (?, ?, ?, ?)', [newId(), pid, label, i]))
      }
    })
    logActivity(ctx, req, 'post.create', { type: 'post', id }, { title: input.title })
    notifyBoard(b.id, id)
    return ok({ id })
  })

  app.patch('/api/posts/:id', auth, async (req) => {
    const p = loadPost(req, (req.params as { id: string }).id)
    const b = db.get<BoardRow>('SELECT * FROM boards WHERE id = ?', [p.board_id])!
    if (p.created_by !== req.member.id && !canManageBoard(b, req)) throw forbidden()
    const u = parse(z.object({ title: z.string().trim().min(1).max(150).optional(), bodyHtml: z.string().max(3_000_000).optional(), pinned: z.boolean().optional() }), req.body)
    if (u.pinned !== undefined && !canManageBoard(b, req)) throw forbidden('고정은 게시판 관리자만 할 수 있습니다.')
    db.run('UPDATE posts SET title = COALESCE(?, title), body_html = COALESCE(?, body_html), pinned = COALESCE(?, pinned), updated_at = ? WHERE id = ?', [
      u.title ?? null,
      u.bodyHtml !== undefined ? cleanHtml(u.bodyHtml) : null,
      u.pinned === undefined ? null : u.pinned ? 1 : 0,
      Date.now(),
      p.id
    ])
    notifyBoard(p.board_id, p.id)
    return ok({ id: p.id })
  })

  app.delete('/api/posts/:id', auth, async (req) => {
    const p = loadPost(req, (req.params as { id: string }).id)
    const b = db.get<BoardRow>('SELECT * FROM boards WHERE id = ?', [p.board_id])!
    if (p.created_by !== req.member.id && !canManageBoard(b, req)) throw forbidden()
    db.run('UPDATE posts SET deleted_at = ? WHERE id = ?', [Date.now(), p.id])
    deleteAttachmentsOf(ctx, 'post', p.id)
    logActivity(ctx, req, 'post.delete', { type: 'post', id: p.id }, { title: p.title })
    notifyBoard(p.board_id, p.id)
    return ok({ id: p.id })
  })

  /** Vote: replaces my previous choice(s). */
  app.post('/api/posts/:id/vote', auth, async (req) => {
    const p = loadPost(req, (req.params as { id: string }).id)
    const poll = db.get<{ id: string; multiple: number; closes_at: number | null; closed_at: number | null }>('SELECT * FROM polls WHERE post_id = ?', [p.id])
    if (!poll) throw notFound('투표')
    if (poll.closed_at || (poll.closes_at && poll.closes_at < Date.now())) throw badRequest('마감된 투표입니다.')
    const { optionIds } = parse(z.object({ optionIds: z.array(z.string()).max(20) }), req.body)
    const valid = new Set(db.all<{ id: string }>('SELECT id FROM poll_options WHERE poll_id = ?', [poll.id]).map((o) => o.id))
    const chosen = [...new Set(optionIds)].filter((o) => valid.has(o))
    if (!poll.multiple && chosen.length > 1) throw badRequest('하나만 고를 수 있습니다.')
    db.tx(() => {
      db.run('DELETE FROM poll_votes WHERE poll_id = ? AND member_id = ?', [poll.id, req.member.id])
      for (const o of chosen) db.run('INSERT INTO poll_votes (poll_id, option_id, member_id, voted_at) VALUES (?, ?, ?, ?)', [poll.id, o, req.member.id, Date.now()])
    })
    notifyBoard(p.board_id, p.id)
    return ok(pollDto(p.id, req.member.id))
  })

  app.post('/api/posts/:id/close-poll', auth, async (req) => {
    const p = loadPost(req, (req.params as { id: string }).id)
    if (p.created_by !== req.member.id && req.member.role !== 'admin') throw forbidden('글쓴이만 마감할 수 있습니다.')
    db.run('UPDATE polls SET closed_at = ? WHERE post_id = ?', [Date.now(), p.id])
    notifyBoard(p.board_id, p.id)
    return ok(pollDto(p.id, req.member.id))
  })
}
