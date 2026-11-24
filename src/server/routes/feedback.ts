import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { PC_UID_RE } from '../../shared/constants'
import { FEEDBACK_LIMITS, FEEDBACK_PATTERNS, checkItem, feedbackItemSchema, tidyLine, tidyText, type FeedbackAdminDto, type FeedbackItem, type FeedbackItemDto } from '../../shared/schemas/feedback'
import { logActivity } from '../activity'
import { makeRequireOwner } from '../auth'
import type { ServerContext } from '../context'
import { badRequest, conflict, notFound } from '../errors'
import {
  bundleText,
  feedbackCreds,
  makeBundles,
  markDelivered,
  nextBundleAt,
  storeItem,
  toBundleDto,
  toItemDto,
  uploadBundles,
  type FeedbackBundleRow,
  type FeedbackItemRow
} from '../feedback'
import { parse, ok } from '../validate'

const MAX_PER_DAY = 10
const MIN_GAP_MS = 60_000
const DAY = 86_400_000
/** an item is 24 KB at most; anything larger is not read at all */
const BODY_LIMIT = 64 * 1024

/** What a program older than the weekly bundles sends to /api/feedback/relay. */
const legacySchema = z.object({
  id: z.string().regex(/^TH-[A-Z2-9]{8}$/),
  kind: z.enum(['feature', 'bug']),
  title: z.string().max(400),
  body: z.string().max(20000),
  author: z.string().max(120),
  environment: z.string().max(200),
  installId: z.string().regex(PC_UID_RE),
  retry: z.boolean().optional()
})

/**
 * "기능요청 및 오류신고": every member PC hands its posts to this server (no internet and no key
 * needed on that PC). The server keeps them and hands the posts of a week to the developer as
 * one bundle (../feedback.ts). 최종관리자 and 서무 see what came in; a post can be removed until
 * it is in a bundle.
 */
export function registerFeedbackRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler; requireAdmin: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const admin = { preHandler: [guards.requireAuth, guards.requireAdmin] }
  const owner = { preHandler: [guards.requireAuth, guards.requireAdmin, makeRequireOwner(ctx)] }

  /** Keep one post of the member who asks; the same post sent again is answered with what is kept. */
  const receive = (req: FastifyRequest, item: FeedbackItem): FeedbackItemDto => {
    const have = ctx.db.get<FeedbackItemRow>('SELECT * FROM feedback_items WHERE id = ?', [item.submissionId])
    if (have) {
      // somebody else's id: say nothing about that post
      if (have.member_id !== req.member.id) throw conflict('이미 접수된 글입니다.')
      return toItemDto(have)
    }
    const now = Date.now()
    const mine = ctx.db.all<{ received_at: number }>('SELECT received_at FROM feedback_items WHERE member_id = ? AND received_at > ? ORDER BY received_at DESC', [req.member.id, now - DAY])
    if (mine[0] && now - mine[0].received_at < MIN_GAP_MS) throw badRequest('방금 글을 보냈습니다. 1분 뒤에 다시 보내 주세요.')
    if (mine.length >= MAX_PER_DAY) throw badRequest(`하루에 ${MAX_PER_DAY}건까지 보낼 수 있습니다. 내일 다시 보내 주세요.`)
    const { row } = storeItem(ctx, req.member.id, item, now)
    // the text itself is not copied into the activity log
    logActivity(ctx, req, 'feedback.receive', { type: 'feedback', id: row.id }, { kind: row.kind })
    return toItemDto(row)
  }

  app.post('/api/feedback', { ...auth, bodyLimit: BODY_LIMIT }, async (req) => ok(receive(req, parse(feedbackItemSchema, req.body))))

  app.get('/api/feedback/mine', auth, async (req) =>
    ok(ctx.db.all<FeedbackItemRow>('SELECT * FROM feedback_items WHERE member_id = ? ORDER BY received_at DESC LIMIT 50', [req.member.id]).map((r) => toItemDto(r)))
  )

  // Programs older than the weekly bundles asked the server PC to pass a post on to GitHub right
  // away. They are still answered, but the post is kept and bundled like every other one.
  app.get('/api/feedback/relay', auth, async () => ok({ available: true }))
  app.post('/api/feedback/relay', { ...auth, bodyLimit: BODY_LIMIT }, async (req) => {
    const old = parse(legacySchema, req.body)
    const h = createHash('sha256').update(`teamhub-feedback-legacy:${old.id}:${old.installId}`).digest('hex')
    const env = /^TeamHub (\S+) · (Windows [A-Za-z0-9 ._()-]{1,50})$/.exec(old.environment.trim())
    const version = env && new RegExp(FEEDBACK_PATTERNS.version, 'u').test(env[1]) ? env[1] : null
    const made = checkItem({
      kind: old.kind,
      title: tidyLine(old.title, FEEDBACK_LIMITS.titleMax),
      body: tidyText(old.body, FEEDBACK_LIMITS.bodyMax),
      author: tidyLine(old.author, FEEDBACK_LIMITS.authorMax),
      installId: old.installId,
      // the same old receipt number gives the same id: a repeated send is kept once
      submissionId: `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`,
      createdAt: new Date().toISOString(),
      ...(version && env ? { app: { version, os: env[2] } } : {})
    })
    if (!made.ok) throw badRequest('글의 형식이 맞지 않아 접수하지 못했습니다.')
    receive(req, made.value)
    // the old program insists on a post number of the board; there is none yet
    return ok({ ok: true, number: ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM feedback_items')!.n })
  })

  app.get('/api/admin/feedback', admin, async () => {
    const items = ctx.db
      .all<FeedbackItemRow & { member_name: string | null }>(
        `SELECT f.*, m.name AS member_name FROM feedback_items f LEFT JOIN members m ON m.id = f.member_id ORDER BY f.received_at DESC LIMIT 300`
      )
      .map((r) => toItemDto({ ...r, member_name: r.member_name ?? null }))
    const bundles = ctx.db.all<FeedbackBundleRow>('SELECT * FROM feedback_bundles ORDER BY created_at DESC, id LIMIT 60').map(toBundleDto)
    return ok<FeedbackAdminDto>({ items, bundles, canUpload: !!feedbackCreds(ctx), nextBundleAt: nextBundleAt(ctx) })
  })

  app.delete('/api/admin/feedback/items/:id', admin, async (req) => {
    const { id } = req.params as { id: string }
    const row = ctx.db.get<FeedbackItemRow>('SELECT * FROM feedback_items WHERE id = ?', [id])
    if (!row) throw notFound('글')
    if (row.state !== 'received') throw conflict('이미 묶음에 들어간 글은 지울 수 없습니다.')
    ctx.db.run('DELETE FROM feedback_items WHERE id = ?', [id])
    logActivity(ctx, req, 'feedback.delete', { type: 'feedback', id }, { kind: row.kind })
    return ok({ deleted: true })
  })

  // 지금 묶어 보내기: do not wait for the weekly rule (최종관리자 only: it sends data out of the organisation)
  app.post('/api/admin/feedback/send-now', owner, async (req) => {
    let made: number
    try {
      made = makeBundles(ctx)
    } catch (e) {
      throw badRequest((e as Error).message)
    }
    const r = await uploadBundles(ctx, Date.now(), true)
    logActivity(ctx, req, 'feedback.send-now', null, { bundles: made, uploaded: r.uploaded, failed: r.failed })
    return ok({ made, ...r })
  })

  // 파일로 저장: the bundle as the very JSON that would be handed to GitHub
  app.get('/api/admin/feedback/bundles/:id/file', admin, async (req) => {
    const { id } = req.params as { id: string }
    const text = bundleText(ctx, id)
    if (!text) throw notFound('묶음')
    logActivity(ctx, req, 'feedback.export', { type: 'feedback_bundle', id })
    return ok({ name: `teamhub-feedback-${id}.json`, text })
  })

  // handed over as a file: it does not have to be sent any more
  app.post('/api/admin/feedback/bundles/:id/delivered', owner, async (req) => {
    const { id } = req.params as { id: string }
    const b = ctx.db.get<FeedbackBundleRow>('SELECT * FROM feedback_bundles WHERE id = ?', [id])
    if (!b) throw notFound('묶음')
    if (b.state === 'uploaded') throw conflict('이미 전달된 묶음입니다.')
    markDelivered(ctx, id, null)
    logActivity(ctx, req, 'feedback.delivered', { type: 'feedback_bundle', id }, { items: b.item_count })
    return ok({ delivered: true })
  })
}
