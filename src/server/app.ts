import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import type { Db } from '../node/sqlite'
import type { ServerContext } from './context'
import { recordError } from './context'
import { AppError } from './errors'
import { Hub } from './ws/hub'
import { makeRequireAdmin, makeRequireAuth, makeRequireOwner } from './auth'
import { ensureServerOwner } from './repos/devices'
import { registerCoreRoutes } from './routes/core'
import { registerAdminRoutes } from './routes/admin'
import { registerUpdateRoutes } from './routes/updates'
import { registerGroupRoutes } from './routes/groups'
import { registerAttachmentRoutes } from './routes/attachments'
import { registerNoticeRoutes, runNoticeJobs } from './routes/notices'
import { registerEventRoutes } from './routes/events'
import { registerWorklogRoutes } from './routes/worklogs'
import { registerFileRoutes, runFileJobs } from './routes/files'
import { registerChatRoutes, runChatJobs } from './routes/chat'
import { registerCommentRoutes } from './routes/comments'
import { registerTaskRoutes } from './routes/tasks'
import { registerBoardRoutes } from './routes/boards'
import { registerDirectoryRoutes } from './routes/directory'
import { registerDutyRoutes } from './routes/duty'
import { registerCollectRoutes, runCollectJobs } from './routes/collect'
import { registerDocRoutes } from './routes/docs'
import { registerToolRoutes, runAlarmJobs } from './routes/tools'
import { registerLauncherRoutes } from './routes/launcher'
import { leaveAllMeetings, registerMeetingRoutes } from './routes/meetings'
import { registerBackupRoutes } from './routes/backup'
import { registerPluginRoutes } from './routes/plugins'
import { registerFeedbackRoutes } from './routes/feedback'
import { runFeedbackJob } from './feedback'
import type { FeedbackRelayConfig } from '../shared/server-host'
import { registerLedgerRoutes } from './routes/ledgers'
import { registerSearchRoutes } from './routes/search'
import { registerUnregisteredRoutes } from './routes/unregistered'
import { runMealImport } from './unregistered'
import { pruneIdempotency, registerIdempotency } from './idempotency'
import { registerPiiAck } from './pii'
import { runBackupJob } from './backup'
import { runMessageFileRetention } from './message-files'
import { registerCommand } from './command-host'
import type { CommandServer } from '../../command/server/routes'

export interface BuildOptions {
  db: Db
  dataDir: string
  version: string
  feedback?: FeedbackRelayConfig
  logger?: boolean
  /** Run periodic jobs (scheduled publish, re-notify). Tests call the job functions directly. */
  jobs?: boolean
  /** Server log lines (the utilityProcess hands them to the host's log file). */
  log?: ServerContext['log']
}

export interface BuiltApp {
  /** 긴급구조지휘대 module (command/) */
  command: CommandServer
  app: FastifyInstance
  ctx: ServerContext
}

/** Build the Fastify app without listening, so tests can use app.inject(). */
export async function buildApp(opts: BuildOptions): Promise<BuiltApp> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: false,
    forceCloseConnections: true
  })
  // eslint-disable-next-line prefer-const
  let ctx: ServerContext
  const hub = new Hub(() => ctx)
  ctx = { db: opts.db, dataDir: opts.dataDir, version: opts.version, startedAt: Date.now(), hub, recentErrors: [], feedback: opts.feedback, log: opts.log }

  // Header-based auth (no cookies), so allowing any origin is safe (13.3).
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Protocol', 'X-Win-User', 'X-App-Version', 'X-Admin-Pin', 'X-File-Name', 'Range', 'If-Range', 'X-PC-Uid', 'X-Idempotency-Key'],
    exposedHeaders: ['Content-Disposition', 'Content-Range', 'Accept-Ranges', 'ETag']
  })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      void reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } })
      return
    }
    const e = err as { statusCode?: number; code?: string; message: string }
    if (e.statusCode && e.statusCode < 500) {
      void reply.status(e.statusCode).send({ error: { code: 'BAD_REQUEST', message: e.message } })
      return
    }
    recordError(ctx, `${req.method} ${req.url}: ${e.message}`)
    req.log.error(err)
    void reply.status(500).send({ error: { code: 'INTERNAL', message: '서버 오류가 발생했습니다.' } })
  })
  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send({ error: { code: 'NOT_FOUND', message: '요청한 주소를 찾을 수 없습니다.' } })
  })

  registerIdempotency(app, ctx)
  registerPiiAck(app)
  const requireAuth = makeRequireAuth(ctx)
  const requireAdmin = makeRequireAdmin(ctx)
  // 최종관리자 (the server PC) only; use after requireAuth and requireAdmin
  const requireOwner = makeRequireOwner(ctx)
  // the server PC's own account is the 최종관리자: always an active admin
  ensureServerOwner(opts.db)
  registerCoreRoutes(app, ctx, requireAuth)
  registerAdminRoutes(app, ctx, { requireAuth, requireAdmin })
  registerUpdateRoutes(app, ctx, { requireAuth, requireAdmin })
  registerGroupRoutes(app, ctx, { requireAuth, requireAdmin })
  registerAttachmentRoutes(app, ctx, { requireAuth })
  registerNoticeRoutes(app, ctx, { requireAuth })
  registerEventRoutes(app, ctx, { requireAuth, requireAdmin })
  registerWorklogRoutes(app, ctx, { requireAuth })
  registerFileRoutes(app, ctx, { requireAuth })
  registerChatRoutes(app, ctx, { requireAuth })
  registerCommentRoutes(app, ctx, { requireAuth })
  registerTaskRoutes(app, ctx, { requireAuth })
  registerBoardRoutes(app, ctx, { requireAuth, requireAdmin })
  registerDirectoryRoutes(app, ctx, { requireAuth, requireAdmin, requireOwner })
  registerDutyRoutes(app, ctx, { requireAuth })
  registerCollectRoutes(app, ctx, { requireAuth })
  registerDocRoutes(app, ctx, { requireAuth, requireAdmin })
  registerToolRoutes(app, ctx, { requireAuth })
  registerLauncherRoutes(app, ctx, { requireAuth, requireAdmin })
  registerMeetingRoutes(app, ctx, { requireAuth })
  registerBackupRoutes(app, ctx, { requireAuth, requireAdmin })
  registerPluginRoutes(app, ctx, { requireAuth })
  registerFeedbackRoutes(app, ctx, { requireAuth, requireAdmin })
  registerLedgerRoutes(app, ctx, { requireAuth })
  registerSearchRoutes(app, ctx, { requireAuth })
  registerUnregisteredRoutes(app, ctx, { requireAuth, requireAdmin })
  // 미등록 인원: take over the list the 식사 신청 plugin kept itself before 1.8.0 (once; safe again)
  try {
    runMealImport(ctx)
  } catch (e) {
    recordError(ctx, `unregistered import: ${(e as Error).message}`)
  }
  // 긴급구조지휘대: a module of its own (command/), data in command.db next to teamhub.db
  const command = registerCommand(app, ctx, { requireAuth })
  hub.onMemberOffline = (memberId) => leaveAllMeetings(ctx, memberId)

  const timers: NodeJS.Timeout[] = []
  const messageFileJob = (): void => {
    try {
      runMessageFileRetention(ctx)
    } catch (e) {
      recordError(ctx, `message file retention: ${(e as Error).message}`)
    }
  }
  if (opts.jobs !== false) {
    timers.push(
      setInterval(() => {
        try {
          runNoticeJobs(ctx)
          runAlarmJobs(ctx)
          runCollectJobs(ctx)
        } catch (e) {
          recordError(ctx, `notice jobs: ${(e as Error).message}`)
        }
      }, 15000),
      setInterval(() => {
        try {
          runBackupJob(ctx)
        } catch (e) {
          recordError(ctx, `backup: ${(e as Error).message}`)
        }
      }, 60_000),
      setInterval(() => {
        try {
          runFileJobs(ctx)
          runChatJobs(ctx)
          pruneIdempotency(ctx)
        } catch (e) {
          recordError(ctx, `file jobs: ${(e as Error).message}`)
        }
        messageFileJob()
      }, 3600_000)
    )
    // messenger files past their retention period: soon after a start, then with the hourly jobs
    // (E2E: a few seconds, so a test can age a file, restart the server and see it expire)
    timers.push(setTimeout(messageFileJob, process.env.TEAMHUB_E2E ? 3000 : 60_000))
    // 긴급구조지휘대: messages of running drills go out on time (every 5 seconds)
    timers.push(
      setInterval(() => {
        try {
          command.runJobs()
        } catch (e) {
          recordError(ctx, `command jobs: ${(e as Error).message}`)
        }
      }, 5000)
    )
    // feedback posts: the weekly bundle, and bundles that still wait (also soon after a start,
    // so a server PC that was off catches up)
    const feedbackJob = (): void => void runFeedbackJob(ctx).catch((e: unknown) => recordError(ctx, `feedback: ${(e as Error).message}`))
    timers.push(setTimeout(feedbackJob, 90_000), setInterval(feedbackJob, 3600_000))
  }

  app.addHook('onClose', async () => {
    for (const t of timers) clearInterval(t)
    hub.close()
    command.close()
  })
  await app.ready()
  hub.attach(app.server)
  return { app, ctx, command }
}
