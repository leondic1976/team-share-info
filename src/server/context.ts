import type { Db } from '../node/sqlite'
import type { Hub } from './ws/hub'
import type { FeedbackRelayConfig } from '../shared/server-host'
import type { FeedbackCreds } from '../node/feedback'

export interface ServerContext {
  db: Db
  dataDir: string
  version: string
  startedAt: number
  hub: Hub
  recentErrors: { at: number; message: string }[]
  /** Handing the weekly bundle of feedback posts to the developer (feedback.ts). */
  feedback?: FeedbackRelayConfig & { creds?: FeedbackCreds }
  /** Called when settings that affect the running process change (port, discovery...). */
  onSettingsChanged?: () => void
  /** Ask the host (Electron main) to restart the server process, e.g. after staging a restore. */
  requestRestart?: (reason: string) => void
  /** A line for the server log (the host writes it to the app log file). */
  log?: (level: 'info' | 'warn', message: string) => void
}

export function recordError(ctx: ServerContext, message: string): void {
  ctx.recentErrors.unshift({ at: Date.now(), message })
  if (ctx.recentErrors.length > 50) ctx.recentErrors.length = 50
}
