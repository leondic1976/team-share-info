import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { newId } from '../../node/sqlite'
import type { ServerContext } from '../context'
import { AppError, badRequest } from '../errors'
import { getSection } from '../settings'

export interface BlobRow {
  id: string
  sha256: string
  size: number
  path: string
  ref_count: number
}

export function filesRoot(ctx: ServerContext): string {
  return join(ctx.dataDir, 'files')
}

export function blobAbsPath(ctx: ServerContext, blob: Pick<BlobRow, 'path'>): string {
  return join(filesRoot(ctx), blob.path)
}

export function usedBytes(ctx: ServerContext): number {
  return ctx.db.get<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM blobs')?.n ?? 0
}

export function extOf(name: string): string {
  const m = /\.([^.\\/]+)$/.exec(name)
  return m ? m[1].toLowerCase() : ''
}

/** "5GB", "1.5GB", "500MB" for limit messages. */
export function sizeLabel(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${Number(gb.toFixed(1))}GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))}MB`
}

/** Room the disk must keep after an upload, so the DB and other writes do not fail. */
const DISK_RESERVE = 200 * 1024 * 1024

/** Reject blocked extensions and over-size files before receiving data. */
export function checkUploadAllowed(ctx: ServerContext, name: string, declaredSize?: number): void {
  const st = getSection(ctx.db, 'storage')
  if (st.blockedExtensions.includes(extOf(name))) throw new AppError('EXTENSION_BLOCKED', `.${extOf(name)} 파일은 올릴 수 없습니다.`, 400)
  if (declaredSize !== undefined) {
    if (declaredSize > st.maxFileBytes) throw new AppError('FILE_TOO_LARGE', `파일이 너무 큽니다(최대 ${sizeLabel(st.maxFileBytes)}).`, 413)
    if (usedBytes(ctx) + declaredSize > st.quotaBytes) throw new AppError('QUOTA_EXCEEDED', '서버 저장 공간이 부족합니다. 관리자에게 문의하세요.', 507)
    // the limit may be larger than what the drive really has left
    let free: number | null = null
    try {
      const s = statfsSync(ctx.dataDir)
      free = s.bavail * s.bsize
    } catch {
      // unknown: let the upload try
    }
    if (free !== null && declaredSize + DISK_RESERVE > free) throw new AppError('QUOTA_EXCEEDED', '서버 PC의 디스크 여유 공간이 부족합니다. 관리자에게 문의하세요.', 507)
  }
}

/**
 * Store a stream as a content-addressed blob (same content stored once, 13.5).
 * Files are written as files/<aa>/<bb>/<sha256>; names never come from users.
 */
export async function storeStream(ctx: ServerContext, stream: Readable): Promise<BlobRow> {
  const st = getSection(ctx.db, 'storage')
  const root = filesRoot(ctx)
  const tmpDir = join(root, 'tmp')
  mkdirSync(tmpDir, { recursive: true })
  const tmp = join(tmpDir, `${newId()}.part`)
  const hash = createHash('sha256')
  let size = 0
  const meter = new Transform({
    transform(chunk: Buffer, _e, cb) {
      size += chunk.length
      if (size > st.maxFileBytes) {
        cb(new AppError('FILE_TOO_LARGE', `파일이 너무 큽니다(최대 ${sizeLabel(st.maxFileBytes)}).`, 413))
        return
      }
      hash.update(chunk)
      cb(null, chunk)
    }
  })
  try {
    await pipeline(stream, meter, createWriteStream(tmp))
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  if (usedBytes(ctx) + size > st.quotaBytes) {
    rmSync(tmp, { force: true })
    throw new AppError('QUOTA_EXCEEDED', '서버 저장 공간이 부족합니다. 관리자에게 문의하세요.', 507)
  }
  return adoptFile(ctx, tmp, hash.digest('hex'), size)
}

/** Move a finished temp file into the blob store (dedupe by hash). */
export function adoptFile(ctx: ServerContext, tmpPath: string, sha256: string, size: number): BlobRow {
  const existing = ctx.db.get<BlobRow>('SELECT * FROM blobs WHERE sha256 = ?', [sha256])
  if (existing && existsSync(blobAbsPath(ctx, existing))) {
    rmSync(tmpPath, { force: true })
    return existing
  }
  const rel = join(sha256.slice(0, 2), sha256.slice(2, 4), sha256)
  const abs = join(filesRoot(ctx), rel)
  mkdirSync(join(filesRoot(ctx), sha256.slice(0, 2), sha256.slice(2, 4)), { recursive: true })
  if (existsSync(abs)) rmSync(abs, { force: true })
  renameSync(tmpPath, abs)
  if (existing) {
    ctx.db.run('UPDATE blobs SET path = ?, size = ?, updated_at = ? WHERE id = ?', [rel, size, Date.now(), existing.id])
    return { ...existing, path: rel, size }
  }
  const id = newId()
  const t = Date.now()
  ctx.db.run('INSERT INTO blobs (id, sha256, size, path, ref_count, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)', [id, sha256, size, rel, t, t])
  return { id, sha256, size, path: rel, ref_count: 0 }
}

export function addRef(ctx: ServerContext, blobId: string, delta: number): void {
  ctx.db.run('UPDATE blobs SET ref_count = MAX(0, ref_count + ?), updated_at = ? WHERE id = ?', [delta, Date.now(), blobId])
}

/** Delete blobs nobody references any more (called by cleanup jobs). */
export function sweepUnreferenced(ctx: ServerContext, olderThanMs = 24 * 3600 * 1000, now = Date.now()): number {
  const rows = ctx.db.all<BlobRow>('SELECT * FROM blobs WHERE ref_count <= 0 AND updated_at < ?', [now - olderThanMs])
  for (const b of rows) {
    rmSync(blobAbsPath(ctx, b), { force: true })
    ctx.db.run('DELETE FROM blobs WHERE id = ?', [b.id])
  }
  return rows.length
}

export function contentDisposition(name: string, inline = false): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function assertName(name: string): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from user-supplied file names
  const n = name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
  if (!n || n.length > 200) throw badRequest('파일 이름이 올바르지 않습니다.')
  return n
}
