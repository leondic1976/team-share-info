import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { join } from 'node:path'
import { z } from 'zod'
import type { ServerContext } from '../context'
import { badRequest, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { backupRoot, listBackups, readState, runBackup, stageRestore } from '../backup'
import { makeRequireOwner } from '../auth'

/** 최종관리자 (the server PC) only, a 서무 gets 403 OWNER_ONLY: backups, "back up now" and restore (6.16 백업·복구). */
export function registerBackupRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler; requireAdmin: preHandlerAsyncHookHandler }): void {
  const admin = { preHandler: [guards.requireAuth, guards.requireAdmin, makeRequireOwner(ctx)] }

  app.get('/api/admin/backups', admin, async () => {
    const root = backupRoot(ctx.db, ctx.dataDir)
    return ok({ root, state: readState(ctx.db), backups: listBackups(root) })
  })

  app.post('/api/admin/backups', admin, async (req) => {
    const info = runBackup(ctx)
    logActivity(ctx, req, 'backup.run', null, { name: info.name })
    return ok(info)
  })

  /** Stage a restore and restart the server process; the restore runs before the DB opens. */
  app.post('/api/admin/backups/restore', admin, async (req) => {
    const { name } = parse(z.object({ name: z.string().regex(/^TeamHub-[\d-]+$/) }), req.body)
    const root = backupRoot(ctx.db, ctx.dataDir)
    const b = listBackups(root).find((x) => x.name === name)
    if (!b) throw notFound('백업')
    if (!ctx.requestRestart) throw badRequest('이 환경에서는 복구할 수 없습니다.')
    logActivity(ctx, req, 'backup.restore', null, { name })
    stageRestore(ctx.dataDir, join(root, name))
    setTimeout(() => ctx.requestRestart?.('restore backup'), 300)
    return ok({ restarting: true })
  })
}
