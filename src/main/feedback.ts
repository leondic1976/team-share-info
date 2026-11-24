import { app, BrowserWindow, screen } from 'electron'
import { release } from 'node:os'
import { DOWNLOAD_SITE } from '../shared/constants'
import type { FeedbackInfo } from '../shared/ipc'
import { FEEDBACK_LIMITS } from '../shared/schemas/feedback'
import type { FeedbackRelayConfig } from '../shared/server-host'
import { resourcePath } from './paths'
import { ensurePcUid, pcUid } from './pcid'
import { toolWindow } from './tools'

/**
 * "기능요청 및 오류신고" (settings, bottom): a window of its own to write a post. The window
 * hands the post to the server PC of the team (POST /api/feedback); the server PC keeps it and
 * hands the posts of a week to the developer's GitHub repository as one bundle
 * (src/server/feedback.ts, src/node/feedback.ts). What passed the check there is shown to
 * everybody on the download site (feedback.html).
 */
// E2E talks to a stand-in for GitHub and brings its own sealed key
const E2E = !!process.env.TEAMHUB_E2E
const apiBase = (): string | undefined => (E2E ? process.env.TEAMHUB_E2E_FEEDBACK_API : undefined)
export const boardUrl = (): string => `${DOWNLOAD_SITE}feedback.html`

const sealedFile = (): string => (E2E && process.env.TEAMHUB_E2E_FEEDBACK_FILE) || resourcePath('feedback.bin')

/** Given to the server process of this PC, which hands the weekly bundle to GitHub. */
export function feedbackRelayConfig(): FeedbackRelayConfig {
  return { file: sealedFile(), api: apiBase(), serverId: pcUid() ?? undefined }
}

/** What the window adds to a post: the unique value of this PC and (when allowed) the versions. Nothing else. */
export async function feedbackInfo(): Promise<FeedbackInfo> {
  const os = `Windows ${release()}`.replace(/[^A-Za-z0-9 ._()-]/g, '').slice(0, 60)
  return { installId: await ensurePcUid(), app: { version: app.getVersion(), os }, environment: `TeamHub ${app.getVersion()} · ${os}`, boardUrl: boardUrl(), limits: FEEDBACK_LIMITS }
}

let win: BrowserWindow | null = null
export function openFeedbackWindow(): void {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = Math.min(620, area.width - 40)
  const height = Math.min(760, area.height - 40)
  win = toolWindow(
    { width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), minWidth: 460, minHeight: 520, minimizable: true, title: '기능요청 및 오류신고' },
    '/popup/feedback'
  )
  win.once('ready-to-show', () => {
    win?.show()
    win?.focus()
  })
  win.on('closed', () => (win = null))
}
