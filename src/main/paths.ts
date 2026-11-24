import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Dev profile support (13.3): TEAMHUB_PROFILE=b gives a separate userData folder
 * and a separate single-instance lock so a server (A) and a member (B) can run
 * side by side on one PC.
 */
export const PROFILE = (process.env.TEAMHUB_PROFILE ?? '').trim().replace(/[^a-z0-9_-]/gi, '')

let baseDir = ''
let seatSub: string | null = null

export function setupPaths(): void {
  app.setName('TeamHub')
  const dirName = PROFILE ? `TeamHub-${PROFILE}` : 'TeamHub'
  // TEAMHUB_USERDATA: isolated data folder for automated E2E runs.
  const override = process.env.TEAMHUB_USERDATA
  baseDir = override ? override : join(app.getPath('appData'), dirName)
  app.setPath('userData', baseDir)
  app.setAppUserModelId(PROFILE ? `kr.teamhub.app.${PROFILE}` : 'kr.teamhub.app')
}

/**
 * The app data folder of this PC and Windows account. It is also the userData folder, except
 * for a person of a shared PC who is not its first user: that person's userData is a folder
 * below it (seats.ts), so everything kept per userData is kept per person.
 */
export function baseDataPath(...parts: string[]): string {
  return join(baseDir || app.getPath('userData'), ...parts)
}

/**
 * Shared PC: from here on this process works for one person. Called once, after the PIN was
 * checked and before anything of the session (local DB, device key, cache) is opened.
 * `sub` is that person's path below the base folder; null for the first user (base folder).
 */
export function enterSeatFolder(dir: string, sub: string | null): void {
  mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)
  seatSub = sub
}

/** Path of the signed-in person below the base folder ('users/<id>'); null for the first user and without shared mode. */
export function seatSubPath(): string | null {
  return seatSub
}

export function resourcePath(...parts: string[]): string {
  const base = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
  return join(base, ...parts)
}

export function userDataPath(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}
