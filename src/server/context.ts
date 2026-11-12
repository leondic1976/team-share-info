import type { Db } from '../node/sqlite'
import type { Hub } from './ws/hub'

export interface ServerContext {
  db: Db
  dataDir: string
  version: string
  startedAt: number
  hub: Hub
  recentErrors: { at: number; message: string }[]
  /** Called when settings that affect the running process change (port, discovery...). */
  onSettingsChanged?: () => void
  /** Ask the host (Electron main) to restart the server process, e.g. after staging a restore. */
  requestRestart?: (reason: string) => void
}

export function recordError(ctx: ServerContext, message: string): void {
  ctx.recentErrors.unshift({ at: Date.now(), message })
  if (ctx.recentErrors.length > 50) ctx.recentErrors.length = 50
}
