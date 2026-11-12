import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'

/**
 * Moving a data folder (6.20 저장 위치 변경): personal data (local DB, plugins) or the
 * server's data (server DB, files, backups, updates). SQLite files are copied with
 * `VACUUM INTO` (a consistent single file even with WAL), other files byte for byte;
 * the copy is verified before the old files are removed. Node-only, used by main.
 */

export interface TreeSize {
  files: number
  bytes: number
}

const DB_SIDE = /-(wal|shm|journal)$/i

/** Files and bytes under `dir` (a missing folder is empty). */
export function treeSize(dir: string, names?: string[]): TreeSize {
  const out = { files: 0, bytes: 0 }
  const walk = (p: string): void => {
    let st
    try {
      st = statSync(p)
    } catch {
      return
    }
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n))
    else {
      out.files++
      out.bytes += st.size
    }
  }
  if (!existsSync(dir)) return out
  for (const n of names ?? readdirSync(dir)) walk(join(dir, n))
  return out
}

const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
export const samePath = (a: string, b: string): boolean => norm(a) === norm(b)
export const isInside = (child: string, parent: string): boolean => {
  const r = relative(norm(parent), norm(child))
  return !!r && !r.startsWith('..') && !isAbsolute(r)
}

/** A drive root ("D:\") gets a TeamHub sub-folder so data never lands at the top of a drive. */
export function normalizeTarget(picked: string, sub: string): string {
  const p = resolve(picked)
  return samePath(p, parse(p).root) ? join(p, sub) : p
}

export interface TargetCheck {
  ok: boolean
  error?: string
  /** the target already holds data of this kind (marker file found) */
  hasData: boolean
  needBytes: number
  freeBytes: number | null
}

/**
 * Can `to` take the data now in `from`? Rules: absolute local path (no network share:
 * SQLite on a share corrupts), not the same as / inside / containing the current folder,
 * not a protected system folder, writable, and enough free space (+10% and 50 MB).
 */
export function checkTarget(opts: { from: string; to: string; marker: string; needBytes: number; isProtected: (p: string) => boolean }): TargetCheck {
  const { from, to, marker, needBytes } = opts
  const fail = (error: string): TargetCheck => ({ ok: false, error, hasData: false, needBytes, freeBytes: null })
  if (!isAbsolute(to)) return fail('전체 경로를 고르세요.')
  if (/^[\\/]{2}/.test(to)) return fail('네트워크 폴더(\\\\서버\\공유)에는 둘 수 없습니다. 이 PC의 드라이브에 있는 폴더를 고르세요.')
  if (samePath(from, to)) return fail('지금 쓰는 폴더와 같습니다.')
  if (isInside(to, from)) return fail('지금 폴더 안의 폴더로는 옮길 수 없습니다.')
  if (isInside(from, to)) return fail('지금 폴더를 품고 있는 상위 폴더로는 옮길 수 없습니다. 그 안에 새 폴더를 만들어 고르세요.')
  if (opts.isProtected(to)) return fail('시스템 폴더나 다른 사용자 폴더에는 둘 수 없습니다.')
  if (existsSync(to) && !statSync(to).isDirectory()) return fail('폴더가 아닙니다.')
  try {
    mkdirSync(to, { recursive: true })
    const probe = join(to, `.teamhub-write-test-${process.pid}`)
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
  } catch {
    return fail('이 폴더에 쓸 수 없습니다(권한 또는 읽기 전용).')
  }
  const hasData = existsSync(join(to, marker))
  let freeBytes: number | null
  try {
    const s = statfsSync(to)
    freeBytes = Number(s.bavail) * Number(s.bsize)
  } catch {
    freeBytes = null
  }
  if (!hasData && freeBytes !== null && freeBytes < needBytes * 1.1 + 50 * 1024 * 1024) return { ok: false, error: `빈 공간이 모자랍니다(필요 ${fmtBytes(needBytes * 1.1 + 50 * 1024 * 1024)}, 남은 공간 ${fmtBytes(freeBytes)}).`, hasData, needBytes, freeBytes }
  return { ok: true, hasData, needBytes, freeBytes }
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Consistent copy of a SQLite file (works while WAL files exist). */
export function copySqlite(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true })
  if (existsSync(dest)) rmSync(dest)
  const db = new DatabaseSync(src)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
}

/**
 * copySqlite / copyFile with a few retries: right after another process closed the file
 * (server stopped, antivirus scan) Windows can still report it busy for a moment.
 */
async function withRetry<T>(fn: () => T | Promise<T>, tries = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      const msg = String((e as Error).message ?? e)
      if (i >= tries || !/busy|locked|I\/O error|EBUSY|EPERM|EACCES/i.test(msg)) throw e
      await sleep(400 * i)
    }
  }
}

/** quick_check of a copied SQLite file; returns null when fine. */
export function verifySqlite(file: string): string | null {
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const r = db.prepare('PRAGMA quick_check').get() as Record<string, string> | undefined
      const v = r ? Object.values(r)[0] : 'no result'
      return v === 'ok' ? null : `검사 실패: ${v}`
    } finally {
      db.close()
    }
  } catch (e) {
    return (e as Error).message
  }
}

export interface MoveProgress {
  phase: 'copy' | 'verify' | 'cleanup'
  doneBytes: number
  totalBytes: number
  file?: string
}

/**
 * Copy the entries `names` (top-level names inside `from`) to `to`. `*.db` files are
 * copied with VACUUM INTO and their -wal/-shm siblings skipped. Returns what was copied
 * (relative paths) so it can be verified and, after the switch, removed from `from`.
 */
export async function copyEntries(from: string, to: string, names: string[], onProgress?: (p: MoveProgress) => void): Promise<string[]> {
  const total = treeSize(from, names.filter((n) => existsSync(join(from, n)))).bytes
  let done = 0
  const copied: string[] = []
  const walk = async (rel: string): Promise<void> => {
    const src = join(from, rel)
    const st = await stat(src)
    if (st.isDirectory()) {
      await mkdir(join(to, rel), { recursive: true })
      for (const n of await readdir(src)) await walk(join(rel, n))
      return
    }
    if (DB_SIDE.test(rel) && existsSync(join(from, rel.replace(DB_SIDE, '')))) {
      done += st.size
      return
    }
    if (/\.db$/i.test(rel)) await withRetry(() => copySqlite(src, join(to, rel)))
    else {
      await mkdir(dirname(join(to, rel)), { recursive: true })
      await withRetry(() => copyFile(src, join(to, rel)))
    }
    copied.push(rel)
    done += st.size
    onProgress?.({ phase: 'copy', doneBytes: done, totalBytes: total, file: rel })
  }
  for (const n of names) if (existsSync(join(from, n))) await walk(n)
  return copied
}

/** Every copied file exists; plain files have the same size; DB files pass quick_check. */
export function verifyCopy(from: string, to: string, copied: string[]): string | null {
  for (const rel of copied) {
    const dest = join(to, rel)
    if (!existsSync(dest)) return `복사되지 않은 파일: ${rel}`
    if (/\.db$/i.test(rel)) {
      const bad = verifySqlite(dest)
      if (bad) return `${rel}: ${bad}`
    } else if (statSync(dest).size !== statSync(join(from, rel)).size) return `크기가 다른 파일: ${rel}`
  }
  return null
}

/** Remove top-level `names` (and DB side files) from `dir`; errors are collected, not thrown. */
export function removeEntries(dir: string, names: string[]): string[] {
  const errors: string[] = []
  const all = new Set(names)
  for (const n of names) if (/\.db$/i.test(n)) for (const s of ['-wal', '-shm', '-journal']) all.add(n + s)
  for (const n of all) {
    const p = join(dir, n)
    if (!existsSync(p)) continue
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 3 })
    } catch (e) {
      errors.push(`${n}: ${(e as Error).message}`)
    }
  }
  return errors
}
