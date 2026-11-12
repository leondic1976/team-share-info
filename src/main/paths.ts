import { app } from 'electron'
import { join } from 'node:path'

/**
 * Dev profile support (13.3): TEAMHUB_PROFILE=b gives a separate userData folder
 * and a separate single-instance lock so a server (A) and a member (B) can run
 * side by side on one PC.
 */
export const PROFILE = (process.env.TEAMHUB_PROFILE ?? '').trim().replace(/[^a-z0-9_-]/gi, '')

export function setupPaths(): void {
  app.setName('TeamHub')
  const dirName = PROFILE ? `TeamHub-${PROFILE}` : 'TeamHub'
  // TEAMHUB_USERDATA: isolated data folder for automated E2E runs.
  const override = process.env.TEAMHUB_USERDATA
  app.setPath('userData', override ? override : join(app.getPath('appData'), dirName))
  app.setAppUserModelId(PROFILE ? `kr.teamhub.app.${PROFILE}` : 'kr.teamhub.app')
}

export function resourcePath(...parts: string[]): string {
  const base = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
  return join(base, ...parts)
}

export function userDataPath(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}
