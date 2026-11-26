import type { FastifyInstance, FastifyRequest } from 'fastify'
import { PII_CHECK_PROTOCOL } from '../shared/constants'
import { detectPiiIn, piiCounts, type PiiRefusalDetails } from '../shared/pii'
import { logActivity } from './activity'
import type { ServerContext } from './context'
import { AppError } from './errors'

/**
 * The personal-information check of the sending PC, done again on the server: a changed or
 * other program could leave it out. Every write that the PC checks before sending calls
 * `requirePiiAck` with the same texts. When they look like personal information and the writer
 * has not confirmed (`piiAck`), the write is refused with 422 PII_UNCONFIRMED and the kinds
 * found; the PC asks the writer and sends again with the acknowledgement.
 *
 * Rollout: programs older than PII_CHECK_PROTOCOL never send the acknowledgement, so their
 * writes are not checked here (they still ask on their own PC).
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** the writer confirmed the personal information in this request */
    piiAck?: boolean
  }
}

/**
 * The acknowledgement is `piiAck: true` in a JSON body or `?piiAck=1`. It is taken out of the
 * body before the route reads it, so body schemas (some of them strict) never see it.
 */
export function registerPiiAck(app: FastifyInstance): void {
  app.addHook('preValidation', async (req) => {
    const body = req.body as Record<string, unknown> | null | undefined
    let ack = false
    if (body && typeof body === 'object' && !Array.isArray(body) && 'piiAck' in body) {
      ack = body.piiAck === true
      delete body.piiAck
    }
    const q = (req.query as Record<string, unknown> | undefined)?.piiAck
    if (q === '1' || q === 'true') ack = true
    req.piiAck = ack
  })
}

/** Is this caller new enough to be held to the server check? */
export function piiChecked(req: FastifyRequest): boolean {
  return (req.clientProtocol ?? 0) >= PII_CHECK_PROTOCOL
}

/**
 * Throws 422 PII_UNCONFIRMED when the parts look like personal information and the request
 * carries no acknowledgement. `where` names the write in the log (e.g. 'chat.message').
 * Logged with the kinds and counts only, never the text.
 */
export function requirePiiAck(ctx: ServerContext, req: FastifyRequest, where: string, parts: readonly (string | null | undefined)[]): void {
  if (req.piiAck || !piiChecked(req)) return
  const found = detectPiiIn(parts)
  if (!found.length) return
  const counts = piiCounts(found)
  logActivity(ctx, req, 'pii.refused', null, { where, counts })
  ctx.log?.('warn', `pii refused: ${where} ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(',')}`)
  // the samples are already masked and go back only to the writer, so the dialog matches the PC's
  const details: PiiRefusalDetails = { found }
  throw new AppError('PII_UNCONFIRMED', '개인정보로 보이는 내용이 있어 보내지 않았습니다. 내용을 확인한 뒤 다시 보내 주세요.', 422, { ...details })
}
