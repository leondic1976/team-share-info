import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { FeedbackError, FEEDBACK_LIMITS, INSTALL_ID_RE, openSealed, submitFeedback, type FeedbackCreds } from '../../node/feedback'
import type { ServerContext } from '../context'
import { badRequest, forbidden } from '../errors'
import { parse, ok } from '../validate'

/** What a member PC gets back: a refused post is an answer, not a server error. */
export interface FeedbackRelayResult {
  ok: boolean
  number?: number
  error?: string
  /** No answer from the board: the post may exist; sending the same receipt number again is safe. */
  unsure?: boolean
}

const relaySchema = z.object({
  id: z.string().regex(/^TH-[A-Z2-9]{8}$/),
  kind: z.enum(['feature', 'bug']),
  title: z.string().trim().min(FEEDBACK_LIMITS.titleMin).max(FEEDBACK_LIMITS.titleMax),
  body: z.string().trim().min(FEEDBACK_LIMITS.bodyMin).max(FEEDBACK_LIMITS.bodyMax),
  author: z.string().trim().max(FEEDBACK_LIMITS.authorMax),
  environment: z.string().max(200),
  installId: z.string().regex(INSTALL_ID_RE),
  retry: z.boolean().optional()
})

const MAX_PER_DAY = 10
const DAY = 86_400_000

/**
 * "기능요청 및 오류신고" for PCs without internet: a member PC that cannot reach the board
 * hands its post to the server PC, which posts it with the key built into its own program.
 * The server keeps nothing of the post.
 */
export function registerFeedbackRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  let cache: FeedbackCreds | null | undefined
  const creds = (): FeedbackCreds | null => {
    if (ctx.feedback?.creds) return ctx.feedback.creds
    if (cache !== undefined) return cache
    const file = ctx.feedback?.file
    cache = file && existsSync(file) ? openSealed(readFileSync(file)) : null
    return cache
  }
  /** posts passed on per member (times), to keep one PC from flooding the board through the server */
  const passed = new Map<string, number[]>()

  const blocked = async (installId: string): Promise<boolean> => {
    const site = ctx.feedback?.site
    if (!site) return false
    try {
      const r = await fetch(`${site}feedback-blocked.json`, { signal: AbortSignal.timeout(6000), cache: 'no-store' })
      if (!r.ok) return false
      const list = (await r.json()) as unknown
      return Array.isArray(list) && list.includes(installId)
    } catch {
      return false
    }
  }

  app.get('/api/feedback/relay', auth, async () => ok({ available: !!creds() }))

  app.post('/api/feedback/relay', auth, async (req) => {
    const input = parse(relaySchema, req.body)
    const c = creds()
    if (!c) throw badRequest('서버 PC의 프로그램에 보내기 기능이 들어 있지 않습니다. 서버 PC를 최신 버전으로 업데이트해 주세요.')
    const now = Date.now()
    const mine = (passed.get(req.member.id) ?? []).filter((t) => now - t < DAY)
    if (mine.length >= MAX_PER_DAY) throw badRequest(`하루에 ${MAX_PER_DAY}건까지 보낼 수 있습니다. 내일 다시 보내 주세요.`)
    if (await blocked(input.installId)) throw forbidden(`이 PC의 고유값(${input.installId})은 게시판 이용이 제한되어 있습니다. 관리자에게 문의해 주세요.`)
    try {
      const r = await submitFeedback(c, { ...input, retry: !!input.retry }, { api: ctx.feedback?.api })
      passed.set(req.member.id, [...mine, now])
      return ok<FeedbackRelayResult>({ ok: true, number: r.number })
    } catch (e) {
      if (!(e instanceof FeedbackError)) throw e
      return ok<FeedbackRelayResult>({ ok: false, unsure: e.unsure, error: e.offline ? '서버 PC도 인터넷(GitHub)에 연결할 수 없어 보내지 못했습니다. 인터넷이 되는 PC에서 보내 주세요.' : e.message })
    }
  })
}
