import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
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

/**
 * Size of a tree without blocking the process (main must stay responsive while a large
 * server folder is measured). Yields to the event loop every few hundred entries.
 */
export async function treeSizeAsync(dir: string, names?: string[]): Promise<TreeSize> {
  const out = { files: 0, bytes: 0 }
  let n = 0
  const walk = async (p: string): Promise<void> => {
    let st
    try {
      st = await stat(p)
    } catch {
      return
    }
    if (++n % 500 === 0) await new Promise((r) => setImmediate(r))
    if (st.isDirectory()) {
      let list: string[]
      try {
        list = await readdir(p)
      } catch {
        return
      }
      for (const c of list) await walk(join(p, c))
    } else {
      out.files++
      out.bytes += st.size
    }
  }
  if (!existsSync(dir)) return out
  let top: string[]
  try {
    top = names ?? (await readdir(dir))
  } catch {
    return out
  }
  for (const c of top) await walk(join(dir, c))
  return out
}

/**
 * Written into the target folder before a copy starts and removed once the copy is verified.
 * A folder that still has it holds an unfinished copy (the program was closed or the PC went
 * off in the middle): it is not "TeamHub data", and the next move into it clears it first.
 */
export const MOVE_MARK = '.teamhub-moving'
export const unfinishedCopy = (dir: string): boolean => existsSync(join(dir, MOVE_MARK))

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
 * SQLite on a share corrupts), the drive is there, not the same as / inside / containing the
 * current folder, not a protected system folder, writable, and enough free space (+10% and
 * 50 MB). Checking leaves nothing behind: a folder it had to create to test writing is removed
 * again (the move creates it for real).
 */
export function checkTarget(opts: { from: string; to: string; marker: string; needBytes: number; isProtected: (p: string) => boolean }): TargetCheck {
  const { from, to, marker, needBytes } = opts
  const fail = (error: string): TargetCheck => ({ ok: false, error, hasData: false, needBytes, freeBytes: null })
  if (!to.trim()) return fail('폴더를 고르세요.')
  if (/^[\\/]{2}/.test(to)) return fail('네트워크 폴더(\\\\서버\\공유)에는 둘 수 없습니다. 이 PC의 드라이브에 있는 폴더를 고르세요.')
  if (!isAbsolute(to) || !/^[a-z]:[\\/]/i.test(to)) return fail('전체 경로(예: D:\\TeamHub 자료)를 고르세요.')
  const root = parse(resolve(to)).root
  if (!existsSync(root)) return fail(`${root.slice(0, 2)} 드라이브를 찾을 수 없습니다. 연결되어 있는지 확인하거나 다른 드라이브를 고르세요.`)
  if (samePath(from, to)) return fail('지금 쓰는 폴더와 같습니다.')
  if (isInside(to, from)) return fail('지금 폴더 안의 폴더로는 옮길 수 없습니다.')
  if (isInside(from, to)) return fail('지금 폴더를 품고 있는 상위 폴더로는 옮길 수 없습니다. 그 안에 새 폴더를 만들어 고르세요.')
  if (opts.isProtected(to)) return fail('시스템 폴더나 다른 사용자 폴더에는 둘 수 없습니다.')
  let st
  try {
    st = existsSync(to) ? statSync(to) : null
  } catch {
    return fail('그 폴더를 열 수 없습니다(권한).')
  }
  if (st && !st.isDirectory()) return fail('폴더가 아닙니다. 폴더를 고르세요.')
  let made: string | undefined
  try {
    made = mkdirSync(to, { recursive: true })
    const probe = join(to, `.teamhub-write-test-${process.pid}`)
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    removeMade(to, made)
    if (code === 'ENOSPC') return fail('그 드라이브에 빈 공간이 없습니다.')
    if (code === 'ENOENT') return fail('그 위치에 폴더를 만들 수 없습니다(드라이브나 상위 폴더 확인).')
    return fail('이 폴더에 쓸 수 없습니다(권한 또는 읽기 전용). 다른 폴더를 고르세요.')
  }
  const hasData = existsSync(join(to, marker)) && !unfinishedCopy(to)
  let freeBytes: number | null
  try {
    const s = statfsSync(to)
    freeBytes = Number(s.bavail) * Number(s.bsize)
  } catch {
    freeBytes = null
  }
  removeMade(to, made)
  if (!hasData && freeBytes !== null && freeBytes < needBytes * 1.1 + 50 * 1024 * 1024) return { ok: false, error: `빈 공간이 모자랍니다(필요 ${fmtBytes(needBytes * 1.1 + 50 * 1024 * 1024)}, 남은 공간 ${fmtBytes(freeBytes)}).`, hasData, needBytes, freeBytes }
  return { ok: true, hasData, needBytes, freeBytes }
}

/** Remove the (empty) folders a check created: from `to` up to `made`, the first one created. */
function removeMade(to: string, made: string | undefined): void {
  if (!made) return
  let p = resolve(to)
  for (let i = 0; i < 64; i++) {
    try {
      rmdirSync(p)
    } catch {
      return
    }
    if (samePath(p, made)) return
    const up = dirname(p)
    if (up === p) return
    p = up
  }
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
export async function copyEntries(from: string, to: string, names: string[], onProgress?: (p: MoveProgress) => void, opts: { mark?: boolean } = {}): Promise<string[]> {
  const total = (await treeSizeAsync(from, names.filter((n) => existsSync(join(from, n))))).bytes
  if (opts.mark) {
    await mkdir(to, { recursive: true })
    await writeFile(join(to, MOVE_MARK), JSON.stringify({ from, at: Date.now() }))
  }
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

/** Rows per table of a SQLite file (read-only), or null when it cannot be read. */
export function tableCounts(file: string): Record<string, number> | null {
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const out: Record<string, number> = {}
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]
      for (const t of tables) {
        // (a virtual table of a module this build lacks cannot be counted: skipped)
        try {
          out[t.name] = (db.prepare(`SELECT count(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get() as { n: number }).n
        } catch {
          // skipped
        }
      }
      return out
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/**
 * Every copied file exists; plain files have the same size; DB files pass quick_check and
 * hold as many rows per table as the source (nothing writes the source during a move: the
 * server is stopped, the personal DB not opened yet).
 */
export function verifyCopy(from: string, to: string, copied: string[]): string | null {
  for (const rel of copied) {
    const dest = join(to, rel)
    if (!existsSync(dest)) return `복사되지 않은 파일: ${rel}`
    if (/\.db$/i.test(rel)) {
      const bad = verifySqlite(dest)
      if (bad) return `${rel}: ${bad}`
      const a = tableCounts(join(from, rel))
      const b = tableCounts(dest)
      if (a && b) {
        const diff = Object.keys(a).find((t) => a[t] !== b[t])
        if (diff) return `${rel}: ${diff} 표의 행 수가 다릅니다(${a[diff]} -> ${b[diff] ?? 0})`
      }
    } else if (statSync(dest).size !== statSync(join(from, rel)).size) return `크기가 다른 파일: ${rel}`
  }
  return null
}

/** The copy in `to` is complete and checked: no longer an unfinished copy. */
export function finishCopy(to: string): void {
  rmSync(join(to, MOVE_MARK), { force: true })
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
