import { app, BrowserWindow, net, screen } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { release } from 'node:os'
import log from 'electron-log/main'
import { DOWNLOAD_SITE } from '../shared/constants'
import type { FeedbackInfo, FeedbackSent, FeedbackSubmit, FeedbackSubmitResult } from '../shared/ipc'
import { FeedbackError, FEEDBACK_LIMITS, newFeedbackId, openSealed, submitFeedback, type FeedbackCreds } from '../node/feedback'
import { localDb } from './localdb'
import { resourcePath } from './paths'
import { ensurePcUid } from './pcid'
import { toolWindow } from './tools'

/**
 * "기능요청 및 오류신고" (settings, bottom): a window of its own to write a post, which this
 * process sends to the issue board of the app's GitHub repository (src/node/feedback.ts).
 * The board is shown to everybody on the download site (feedback.html).
 */
const KV_SENT = 'feedback:sent'
const MIN_GAP_MS = 60_000
const MAX_PER_DAY = 10

// E2E talks to a stand-in for GitHub and brings its own sealed key
const E2E = !!process.env.TEAMHUB_E2E
const apiBase = (): string | undefined => (E2E ? process.env.TEAMHUB_E2E_FEEDBACK_API : undefined)
const site = (): string | null => (E2E ? (process.env.TEAMHUB_E2E_FEEDBACK_SITE ?? null) : DOWNLOAD_SITE)
export const boardUrl = (): string => `${DOWNLOAD_SITE}feedback.html`

let credsCache: FeedbackCreds | null | undefined
function creds(): FeedbackCreds | null {
  if (credsCache !== undefined) return credsCache
  const file = (E2E && process.env.TEAMHUB_E2E_FEEDBACK_FILE) || resourcePath('feedback.bin')
  credsCache = existsSync(file) ? openSealed(readFileSync(file)) : null
  return credsCache
}

/** Values the maintainer shut out (feedback-blocked.json on the download site). */
async function blocked(id: string): Promise<boolean> {
  const base = site()
  if (!base) return false
  try {
    const r = await net.fetch(`${base}feedback-blocked.json`, { signal: AbortSignal.timeout(6000), cache: 'no-store' })
    if (!r.ok) return false
    const list = (await r.json()) as unknown
    return Array.isArray(list) && list.includes(id)
  } catch {
    // the list cannot be read (site down): GitHub still has to accept the post
    return false
  }
}

const sent = (): FeedbackSent[] => localDb().kv.get<FeedbackSent[]>(KV_SENT) ?? []
const environment = (): string => `TeamHub ${app.getVersion()} · Windows ${release()}`

export async function feedbackInfo(): Promise<FeedbackInfo> {
  return { configured: !!creds(), installId: await ensurePcUid(), environment: environment(), boardUrl: boardUrl(), limits: FEEDBACK_LIMITS, sent: sent().slice(0, 20) }
}

/** A send whose outcome is unknown (no answer): the same text sent again must not make a second post. */
let unsure: { key: string; id: string } | null = null

export async function sendFeedback(req: FeedbackSubmit): Promise<FeedbackSubmitResult> {
  const c = creds()
  if (!c) return { ok: false, error: '이 설치본에는 보내기 기능이 들어 있지 않습니다. 프로그램을 최신 버전으로 업데이트해 주세요.' }
  const mine = sent()
  const now = Date.now()
  if (mine[0] && now - mine[0].at < MIN_GAP_MS) return { ok: false, error: '방금 글을 보냈습니다. 1분 뒤에 다시 보내 주세요.' }
  if (mine.filter((s) => now - s.at < 86400000).length >= MAX_PER_DAY) return { ok: false, error: `하루에 ${MAX_PER_DAY}건까지 보낼 수 있습니다. 내일 다시 보내 주세요.` }
  try {
    // the unique value of this PC is checked first; without it nothing is sent
    const installId = await ensurePcUid()
    if (await blocked(installId)) return { ok: false, error: `이 PC의 고유값(${installId})은 게시판 이용이 제한되어 있습니다. 관리자에게 문의해 주세요.` }
    const key = `${req.kind}\n${req.title}\n${req.body}`
    const id = unsure?.key === key ? unsure.id : newFeedbackId()
    try {
      const r = await submitFeedback(
        c,
        { id, kind: req.kind, title: req.title, body: req.body, author: req.author, environment: req.includeEnv ? environment() : '', installId, retry: unsure?.key === key },
        { api: apiBase(), fetch: (u, i) => net.fetch(u, i) }
      )
      unsure = null
      const item: FeedbackSent = { id, number: r.number, kind: req.kind, title: req.title, at: Date.now() }
      localDb().kv.set(KV_SENT, [item, ...mine].slice(0, 50))
      log.info(`[feedback] posted #${r.number} (${id})`)
      return { ok: true, id, number: r.number }
    } catch (e) {
      if (e instanceof FeedbackError && e.unsure) unsure = { key, id }
      throw e
    }
  } catch (e) {
    log.warn('[feedback] failed', (e as Error).message)
    return { ok: false, error: e instanceof FeedbackError ? e.message : '보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }
  }
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
