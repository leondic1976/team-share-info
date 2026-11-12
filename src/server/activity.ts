import type { FastifyRequest } from 'fastify'
import { newId } from '../node/sqlite'
import type { ServerContext } from './context'

/** Every state-changing request is recorded (13.6). Reads are not logged. */
export function logActivity(
  ctx: ServerContext,
  req: FastifyRequest | null,
  action: string,
  target?: { type: string; id: string } | null,
  detail?: Record<string, unknown>
): void {
  ctx.db.run(
    'INSERT INTO activity_logs (id, at, member_id, ip, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      newId(),
      Date.now(),
      req?.member?.id ?? null,
      req?.clientIp ?? req?.ip ?? null,
      action,
      target?.type ?? null,
      target?.id ?? null,
      detail ? JSON.stringify(detail) : null
    ]
  )
}
