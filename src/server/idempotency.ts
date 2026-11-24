import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ServerContext } from './context'

/**
 * Replay protection for changes sent late (the outbox of a PC that was offline, 13.11).
 * The PC sends each queued change with X-Idempotency-Key. The first successful answer is
 * stored per member; the same key from the same member gets that answer again and the
 * change is not carried out a second time.
 */
declare module 'fastify' {
  interface FastifyRequest {
    idemKey?: string
  }
}

const KEY_RE = /^[A-Za-z0-9-]{16,64}$/
const MAX_BODY = 256 * 1024
const KEEP_MS = 30 * 86400_000

/** Called right after authentication. Returns true when the stored answer was sent. */
export function replayIdempotent(ctx: ServerContext, req: FastifyRequest, reply: FastifyReply): boolean {
  const key = req.headers['x-idempotency-key']
  if (typeof key !== 'string' || !KEY_RE.test(key) || req.method === 'GET' || req.method === 'HEAD') return false
  const row = ctx.db.get<{ status: number; body: string }>('SELECT status, body FROM idempotency WHERE key = ? AND member_id = ?', [key, req.member.id])
  if (row) {
    void reply.status(row.status).header('content-type', 'application/json; charset=utf-8').header('x-idempotent-replay', '1').send(row.body)
    return true
  }
  req.idemKey = key
  return false
}

export function registerIdempotency(app: FastifyInstance, ctx: ServerContext): void {
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.idemKey || !req.member || reply.statusCode >= 300 || reply.getHeader('x-idempotent-replay')) return payload
    const body = typeof payload === 'string' ? payload : ''
    if (body.length > MAX_BODY) return payload
    try {
      ctx.db.run('INSERT OR IGNORE INTO idempotency (key, member_id, status, body, created_at) VALUES (?, ?, ?, ?, ?)', [req.idemKey, req.member.id, reply.statusCode, body, Date.now()])
    } catch {
      // the change itself succeeded; not being able to remember it must not fail the answer
    }
    return payload
  })
}

export function pruneIdempotency(ctx: ServerContext, now = Date.now()): void {
  ctx.db.run('DELETE FROM idempotency WHERE created_at < ?', [now - KEEP_MS])
}
