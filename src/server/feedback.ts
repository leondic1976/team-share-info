import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { PC_UID_RE } from '../shared/constants'
import {
  FEEDBACK_PATTERNS,
  FEEDBACK_SCHEMA_VERSION,
  canonicalBundle,
  canonicalItem,
  feedbackBytes,
  packItems,
  receiptOf,
  type FeedbackBundleDto,
  type FeedbackBundleState,
  type FeedbackItem,
  type FeedbackItemDto,
  type FeedbackItemState
} from '../shared/schemas/feedback'
import { FeedbackError, openSealed, submitBundle, type FeedbackCreds } from '../node/feedback'
import { logActivity } from './activity'
import { recordError, type ServerContext } from './context'
import { serverDeviceId } from './repos/devices'
import { readSetting, writeSetting } from './settings'

/**
 * "기능요청 및 오류신고" on the server PC: the posts of the member PCs are kept here, and once a
 * week they are put into bundles and handed to the developer's GitHub repository.
 *
 * The weekly rule: a bundle is made when posts wait and at least seven days have passed since
 * the last bundle was made (for the very first one: since the oldest waiting post came in).
 * The job runs every hour and shortly after the server starts, so a server PC that was off
 * catches up as soon as it runs again. A bundle that could not be handed over (no internet, no
 * key, GitHub down) stays and is tried again once a day; nothing is marked as handed over before
 * GitHub answered with the issue it made.
 */
const DAY = 86_400_000
export const FEEDBACK_WEEK_MS = 7 * DAY
export const FEEDBACK_RETRY_MS = DAY
/** GitHub takes three bundles a day from one server PC; a fourth would be refused there. */
export const FEEDBACK_UPLOADS_PER_DAY = 3
const UPLOAD_WINDOW_MS = 25 * 3600_000
export const NO_KEY = '보내기 기능이 아직 설정되지 않았습니다. [파일로 저장]해서 개발자에게 직접 전달할 수 있습니다.'

export interface FeedbackItemRow {
  id: string
  member_id: string
  install_id: string
  kind: 'feature' | 'bug'
  title: string
  body: string
  author: string
  app_version: string | null
  os: string | null
  created_at: number
  received_at: number
  state: FeedbackItemState
  bundle_id: string | null
}
export interface FeedbackBundleRow {
  id: string
  period_from: number
  period_to: number
  item_count: number
  state: FeedbackBundleState
  tries: number
  last_error: string | null
  last_try_at: number | null
  created_at: number
  uploaded_at: number | null
  issue_number: number | null
}

export const toItemDto = (r: FeedbackItemRow & { member_name?: string | null }): FeedbackItemDto => ({
  id: r.id,
  receipt: receiptOf(r.id),
  kind: r.kind,
  title: r.title,
  body: r.body,
  author: r.author,
  createdAt: r.created_at,
  receivedAt: r.received_at,
  state: r.state,
  bundleId: r.bundle_id,
  ...(r.member_name !== undefined ? { memberName: r.member_name ?? '(지워진 구성원)' } : {})
})
export const toBundleDto = (r: FeedbackBundleRow): FeedbackBundleDto => ({
  id: r.id,
  periodFrom: r.period_from,
  periodTo: r.period_to,
  itemCount: r.item_count,
  state: r.state,
  tries: r.tries,
  lastError: r.last_error,
  createdAt: r.created_at,
  uploadedAt: r.uploaded_at,
  issueNumber: r.issue_number
})

/** The item exactly as the PC handed it in (the member id stays on this server). */
function itemOf(r: FeedbackItemRow): FeedbackItem {
  const item: FeedbackItem = { kind: r.kind, title: r.title, body: r.body, author: r.author, installId: r.install_id, submissionId: r.id, createdAt: new Date(r.created_at).toISOString() }
  if (r.app_version && r.os) item.app = { version: r.app_version, os: r.os }
  return item
}

/** Keep a post of a member PC. The same post (same submission id) is kept once. */
export function storeItem(ctx: ServerContext, memberId: string, item: FeedbackItem, now = Date.now()): { row: FeedbackItemRow; created: boolean } {
  const have = ctx.db.get<FeedbackItemRow>('SELECT * FROM feedback_items WHERE id = ?', [item.submissionId])
  if (have) return { row: have, created: false }
  ctx.db.run(
    `INSERT INTO feedback_items (id, member_id, install_id, kind, title, body, author, app_version, os, created_at, received_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received')`,
    [item.submissionId, memberId, item.installId, item.kind, item.title, item.body, item.author, item.app?.version ?? null, item.app?.os ?? null, Date.parse(item.createdAt), now]
  )
  return { row: ctx.db.get<FeedbackItemRow>('SELECT * FROM feedback_items WHERE id = ?', [item.submissionId])!, created: true }
}

const credsCache = new WeakMap<ServerContext, FeedbackCreds | null>()
/** The key built into the program of this PC; null when the build has none. */
export function feedbackCreds(ctx: ServerContext): FeedbackCreds | null {
  if (ctx.feedback?.creds) return ctx.feedback.creds
  if (credsCache.has(ctx)) return credsCache.get(ctx) ?? null
  const file = ctx.feedback?.file
  const c = file && existsSync(file) ? openSealed(readFileSync(file)) : null
  credsCache.set(ctx, c)
  return c
}

/** The unique value of this server PC: given by the program, or learnt from the server PC's own connection. */
export function feedbackServerId(ctx: ServerContext): string | null {
  const given = ctx.feedback?.serverId
  if (given && PC_UID_RE.test(given)) return given
  const own = ctx.db.get<{ pc_uid: string | null }>('SELECT pc_uid FROM devices WHERE id = ?', [serverDeviceId(ctx.db)])?.pc_uid
  return own && PC_UID_RE.test(own) ? own : null
}

interface State {
  lastBundledAt?: number
}
const readState = (ctx: ServerContext): State => readSetting<State>(ctx.db, 'feedbackState') ?? {}

/** When the next weekly bundle is made; null when no post waits. */
export function nextBundleAt(ctx: ServerContext): number | null {
  const oldest = ctx.db.get<{ at: number | null }>(`SELECT MIN(received_at) AS at FROM feedback_items WHERE state = 'received'`)?.at
  if (oldest == null) return null
  return (readState(ctx).lastBundledAt ?? oldest) + FEEDBACK_WEEK_MS
}

const VERSION_RE = new RegExp(FEEDBACK_PATTERNS.version, 'u')

/** The bundle as the JSON text that is handed over (also saved as a file by the administrator). */
export function bundleText(ctx: ServerContext, bundleId: string): string | null {
  const b = ctx.db.get<FeedbackBundleRow>('SELECT * FROM feedback_bundles WHERE id = ?', [bundleId])
  const serverId = feedbackServerId(ctx)
  if (!b || !serverId) return null
  const items = ctx.db.all<FeedbackItemRow>('SELECT * FROM feedback_items WHERE bundle_id = ? ORDER BY received_at, id', [bundleId]).map(itemOf)
  if (!items.length) return null
  return canonicalBundle({
    schema: FEEDBACK_SCHEMA_VERSION,
    type: 'bundle',
    bundleId: b.id,
    serverId,
    period: { from: new Date(b.period_from).toISOString(), to: new Date(b.period_to).toISOString() },
    createdAt: new Date(b.created_at).toISOString(),
    app: { version: VERSION_RE.test(ctx.version) ? ctx.version : '0.0.0' },
    items
  })
}

/**
 * Put every waiting post into bundles (several when one would be too large for a GitHub issue).
 * Returns how many bundles were made.
 */
export function makeBundles(ctx: ServerContext, now = Date.now()): number {
  if (!feedbackServerId(ctx)) throw new Error('서버 PC의 고유값을 아직 알 수 없어 묶음을 만들지 못했습니다. 서버 PC의 프로그램을 한 번 다시 시작해 주세요.')
  return ctx.db.tx(() => {
    const rows = ctx.db.all<FeedbackItemRow>(`SELECT * FROM feedback_items WHERE state = 'received' ORDER BY received_at, id`)
    if (!rows.length) return 0
    const from = Math.min(readState(ctx).lastBundledAt ?? rows[0].received_at, rows[0].received_at, now)
    const groups = packItems(rows, (r) => feedbackBytes(canonicalItem(itemOf(r))))
    for (const group of groups) {
      const id = randomUUID()
      ctx.db.run(`INSERT INTO feedback_bundles (id, period_from, period_to, item_count, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`, [id, from, now, group.length, now])
      for (const r of group) ctx.db.run(`UPDATE feedback_items SET state = 'bundled', bundle_id = ? WHERE id = ?`, [id, r.id])
      logActivity(ctx, null, 'feedback.bundle', { type: 'feedback_bundle', id }, { items: group.length })
    }
    writeSetting(ctx.db, 'feedbackState', { ...readState(ctx), lastBundledAt: now })
    return groups.length
  })
}

/** The bundle reached the developer (GitHub answered with its issue, or it was handed over as a file). */
export function markDelivered(ctx: ServerContext, bundleId: string, issueNumber: number | null, now = Date.now()): void {
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE feedback_bundles SET state = 'uploaded', uploaded_at = ?, issue_number = ?, last_error = NULL WHERE id = ?`, [now, issueNumber, bundleId])
    ctx.db.run(`UPDATE feedback_items SET state = 'uploaded' WHERE bundle_id = ?`, [bundleId])
  })
}

export interface UploadResult {
  uploaded: number
  failed: number
  /** bundles that still wait after this run */
  waiting: number
  /** why bundles wait, in words for the administrator ('' = nothing waits) */
  message: string
}

const busy = new WeakSet<ServerContext>()

/**
 * Hand the waiting bundles to GitHub. `force`: also those whose last try was less than a day ago
 * ("지금 묶어 보내기"). Never more than GitHub takes from one server PC in a day.
 */
export async function uploadBundles(ctx: ServerContext, now = Date.now(), force = false): Promise<UploadResult> {
  const waiting = (): number => ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM feedback_bundles WHERE state != 'uploaded'`)!.n
  if (busy.has(ctx)) return { uploaded: 0, failed: 0, waiting: waiting(), message: '지금 보내는 중입니다.' }
  busy.add(ctx)
  let uploaded = 0
  let failed = 0
  let message = ''
  try {
    const list = ctx.db.all<FeedbackBundleRow>(`SELECT * FROM feedback_bundles WHERE state != 'uploaded' ORDER BY created_at, id`)
    if (!list.length) return { uploaded, failed, waiting: 0, message }
    const creds = feedbackCreds(ctx)
    if (!creds) {
      ctx.db.run(`UPDATE feedback_bundles SET last_error = ? WHERE state != 'uploaded'`, [NO_KEY])
      return { uploaded, failed, waiting: list.length, message: NO_KEY }
    }
    for (const b of list) {
      if (!force && b.last_try_at && now - b.last_try_at < FEEDBACK_RETRY_MS) continue
      const today = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM feedback_bundles WHERE state = 'uploaded' AND issue_number IS NOT NULL AND uploaded_at > ?`, [now - UPLOAD_WINDOW_MS])!.n
      if (today >= FEEDBACK_UPLOADS_PER_DAY) {
        message = `하루에 ${FEEDBACK_UPLOADS_PER_DAY}묶음까지 보낼 수 있습니다. 나머지는 내일 자동으로 보냅니다.`
        break
      }
      const text = bundleText(ctx, b.id)
      try {
        if (!text) throw new FeedbackError('묶음을 만들 수 없습니다(서버 PC의 고유값 또는 글이 없음).')
        const r = await submitBundle(creds, text, { api: ctx.feedback?.api })
        markDelivered(ctx, b.id, r.number, now)
        logActivity(ctx, null, 'feedback.upload', { type: 'feedback_bundle', id: b.id }, { items: b.item_count, issue: r.number })
        uploaded++
      } catch (e) {
        const reason = e instanceof FeedbackError ? e.message : '보내는 중 오류가 발생했습니다.'
        if (!(e instanceof FeedbackError)) recordError(ctx, `feedback upload: ${(e as Error).message}`)
        ctx.db.run(`UPDATE feedback_bundles SET state = 'failed', tries = tries + 1, last_error = ?, last_try_at = ? WHERE id = ?`, [reason, now, b.id])
        failed++
        message = reason
        // no internet: the other bundles would fail the same way
        if (e instanceof FeedbackError && e.offline) break
      }
    }
    return { uploaded, failed, waiting: waiting(), message }
  } finally {
    busy.delete(ctx)
  }
}

/** Every hour (and shortly after the start): make the weekly bundle when it is due, hand over what waits. */
export async function runFeedbackJob(ctx: ServerContext, now = Date.now()): Promise<UploadResult> {
  const due = nextBundleAt(ctx)
  if (due !== null && now >= due) {
    try {
      makeBundles(ctx, now)
    } catch (e) {
      recordError(ctx, `feedback bundle: ${(e as Error).message}`)
    }
  }
  return uploadBundles(ctx, now)
}
