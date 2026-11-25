/**
 * 메신저 파일 보관 기간 (지시 109): files sent in conversations (files and pictures, pasted ones
 * included) are deleted from the server PC once they are older than the period set in
 * 관리 > 설정 > 저장 공간 (at least 90 days), so the server PC does not run out of disk space.
 * The messages stay; their attachment row keeps the name and size, marked expired.
 * Only message attachments: 자료실, notices, boards, backups and the rest are not touched, and a
 * stored file that something else still uses (same content, 13.5) stays on disk.
 */
import { rmSync } from 'node:fs'
import type { ServerContext } from './context'
import { getSection, readSetting, writeSetting } from './settings'
import { addRef, blobAbsPath, type BlobRow } from './storage/blobs'

const DAY = 86_400_000
/** Files handled in one run; a large backlog (the first run on an old server) goes over several hourly runs. */
const BATCH = 1000
const STATE_KEY = 'messageFileCleanup'

export interface MessageFileCleanupState {
  /** when the job last looked */
  checkedAt: number
  /** the last run that deleted something */
  last: { at: number; files: number; bytes: number; days: number } | null
}

export interface MessageFileCleanupResult {
  /** attachments marked expired */
  files: number
  /** bytes actually freed on disk (a file also used elsewhere frees nothing) */
  bytes: number
  /** more old files wait for the next run */
  more: boolean
}

export function messageFileCleanupState(ctx: ServerContext): MessageFileCleanupState | null {
  return readSetting<MessageFileCleanupState>(ctx.db, STATE_KEY) ?? null
}

/** Space the files of conversations take now (each stored file counted once). */
export function messageFileUsage(ctx: ServerContext): { files: number; bytes: number } {
  const r = ctx.db.get<{ files: number; bytes: number }>(
    `SELECT COUNT(*) AS files,
       (SELECT COALESCE(SUM(b.size), 0) FROM blobs b WHERE b.id IN (SELECT blob_id FROM attachments WHERE owner_type = 'message' AND expired_at IS NULL)) AS bytes
     FROM attachments WHERE owner_type = 'message' AND expired_at IS NULL`
  )
  return { files: r?.files ?? 0, bytes: r?.bytes ?? 0 }
}

/** Is a stored file still used by anything (attachments of any kind, 자료실 versions)? */
function blobInUse(ctx: ServerContext, blobId: string): boolean {
  return !!(
    ctx.db.get('SELECT 1 FROM attachments WHERE blob_id = ? LIMIT 1', [blobId]) ??
    ctx.db.get('SELECT 1 FROM file_versions WHERE blob_id = ? LIMIT 1', [blobId])
  )
}

export function runMessageFileRetention(ctx: ServerContext, now = Date.now()): MessageFileCleanupResult {
  const days = getSection(ctx.db, 'storage').messageFileRetentionDays
  const prev = messageFileCleanupState(ctx)
  if (days === null) {
    writeSetting(ctx.db, STATE_KEY, {
      checkedAt: now,
      last: prev?.last ?? null
    } satisfies MessageFileCleanupState)
    return { files: 0, bytes: 0, more: false }
  }
  const cutoff = now - days * DAY
  // the age is that of the message (and of the upload, which comes first); a deleted message has no files left
  const rows = ctx.db.all<{ id: string; blob_id: string | null }>(
    `SELECT a.id, a.blob_id FROM attachments a JOIN messages m ON m.id = a.owner_id
     WHERE a.owner_type = 'message' AND a.expired_at IS NULL AND a.created_at < ? AND m.created_at < ?
     ORDER BY a.created_at LIMIT ?`,
    [cutoff, cutoff, BATCH + 1]
  )
  const more = rows.length > BATCH
  const batch = rows.slice(0, BATCH)
  const blobs = new Set<string>()
  ctx.db.tx(() => {
    for (const a of batch) {
      ctx.db.run('UPDATE attachments SET expired_at = ?, blob_id = NULL, updated_at = ? WHERE id = ?', [
        now,
        now,
        a.id
      ])
      if (a.blob_id) {
        addRef(ctx, a.blob_id, -1)
        blobs.add(a.blob_id)
      }
    }
  })
  let bytes = 0
  for (const id of blobs) {
    const b = ctx.db.get<BlobRow>('SELECT * FROM blobs WHERE id = ?', [id])
    if (!b || b.ref_count > 0 || blobInUse(ctx, id)) continue
    try {
      rmSync(blobAbsPath(ctx, b), { force: true })
      ctx.db.run('DELETE FROM blobs WHERE id = ?', [id])
      bytes += b.size
    } catch (e) {
      // left for the daily sweep of unreferenced files (runFileJobs)
      ctx.log?.('warn', `message file retention: could not delete ${b.path}: ${(e as Error).message}`)
    }
  }
  const last = batch.length ? { at: now, files: batch.length, bytes, days } : (prev?.last ?? null)
  writeSetting(ctx.db, STATE_KEY, { checkedAt: now, last } satisfies MessageFileCleanupState)
  if (batch.length) {
    ctx.log?.(
      'info',
      `message file retention (${days} days): ${batch.length} file(s) expired, ${(bytes / 1024 ** 2).toFixed(1)} MB freed${more ? ', more next run' : ''}`
    )
  }
  return { files: batch.length, bytes, more }
}
