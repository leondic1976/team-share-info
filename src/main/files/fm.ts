import { app, shell } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import os from 'node:os'
import { extOf, isProtectedPath, uniqueName, validName, type FmEntry, type FmPlace, type FmResult } from '../../shared/fm'
import { localDb } from '../localdb'

/** Personal file explorer (6.18 ①). Works on the user's own files; never sends anything. */

const env = () => ({
  systemRoot: process.env.SystemRoot ?? 'C:\\Windows',
  programFiles: [process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'],
  programData: process.env.ProgramData ?? 'C:\\ProgramData',
  usersDir: join(os.homedir(), '..'),
  home: os.homedir()
})
export const isProtected = (p: string): boolean => isProtectedPath(p, env())

const HIDDEN = new Set(['desktop.ini', 'thumbs.db', '$recycle.bin', 'system volume information', 'ntuser.dat', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log.tmp'])
const isHidden = (name: string): boolean => name.startsWith('.') || name.startsWith('~$') || HIDDEN.has(name.toLowerCase()) || /^ntuser\./i.test(name)

export function places(): FmPlace[] {
  const out: FmPlace[] = []
  const known: [string, Parameters<typeof app.getPath>[0]][] = [
    ['바탕 화면', 'desktop'],
    ['문서', 'documents'],
    ['다운로드', 'downloads'],
    ['사진', 'pictures']
  ]
  for (const [name, k] of known) {
    try {
      const p = app.getPath(k)
      if (existsSync(p)) out.push({ path: p, name, kind: 'known' })
    } catch {
      // not available
    }
  }
  out.push({ path: os.homedir(), name: '내 폴더', kind: 'known' })
  for (let c = 67; c <= 90; c++) {
    const p = `${String.fromCharCode(c)}:\\`
    if (existsSync(p)) out.push({ path: p, name: `${String.fromCharCode(c)}: 드라이브`, kind: 'drive' })
  }
  for (const pin of pins()) out.push({ ...pin, kind: 'pin' })
  return out
}

export function pins(): { path: string; name: string }[] {
  return localDb().db.all<{ path: string; name: string }>('SELECT path, name FROM fm_pins ORDER BY sort, name')
}
export function setPin(path: string, on: boolean): void {
  if (on) localDb().db.run('INSERT INTO fm_pins (path, name, sort) VALUES (?, ?, (SELECT COALESCE(MAX(sort),0)+1 FROM fm_pins)) ON CONFLICT(path) DO NOTHING', [path, basename(path) || path])
  else localDb().db.run('DELETE FROM fm_pins WHERE path = ?', [path])
}

export function recentFolders(): string[] {
  return localDb().kv.get<string[]>('fm.recent') ?? []
}
function touchFolder(p: string): void {
  const list = [p, ...recentFolders().filter((x) => x.toLowerCase() !== p.toLowerCase())].slice(0, 15)
  localDb().kv.set('fm.recent', list)
}

export function listDir(path: string, showHidden: boolean): { entries: FmEntry[]; error?: string; truncated?: boolean } {
  let names: string[]
  try {
    names = readdirSync(path)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return { entries: [], error: code === 'EPERM' || code === 'EACCES' ? '이 폴더를 열 권한이 없습니다.' : code === 'ENOENT' ? '폴더가 없습니다.' : '폴더를 열 수 없습니다.' }
  }
  touchFolder(path)
  const entries: FmEntry[] = []
  for (const name of names.slice(0, 10000)) {
    const hidden = isHidden(name)
    if (hidden && !showHidden) continue
    const p = join(path, name)
    try {
      const s = statSync(p)
      entries.push({ path: p, name, ext: s.isDirectory() ? '' : extOf(name), dir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, mtime: s.mtimeMs, hidden })
    } catch {
      // unreadable entry (locked system file)
    }
  }
  return { entries, truncated: names.length > 10000 }
}

const deny = (p: string): FmResult | null => (isProtected(p) ? { ok: false, error: '시스템 폴더나 드라이브 맨 위, 다른 사용자 폴더는 TeamHub에서 바꿀 수 없습니다.' } : null)

export function mkdir(parent: string, name: string): FmResult {
  const bad = validName(name)
  if (bad) return { ok: false, error: bad }
  // creating inside a drive root is fine; only the root itself is protected for rename/delete
  if (isProtected(join(parent, name))) return deny(join(parent, name))!
  const n = uniqueName(name.trim(), (x) => existsSync(join(parent, x)), true)
  try {
    mkdirSync(join(parent, n))
    return { ok: true, paths: [join(parent, n)] }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function rename(path: string, name: string): FmResult {
  const bad = validName(name)
  if (bad) return { ok: false, error: bad }
  const d = deny(path)
  if (d) return d
  const dest = join(path, '..', name.trim())
  if (dest.toLowerCase() !== path.toLowerCase() && existsSync(dest)) return { ok: false, error: '같은 이름이 이미 있습니다.' }
  try {
    renameSync(path, dest)
    relink(path, dest)
    return { ok: true, paths: [dest] }
  } catch (e) {
    return { ok: false, error: (e as NodeJS.ErrnoException).code === 'EBUSY' ? '다른 프로그램이 사용 중입니다.' : (e as Error).message }
  }
}

/** Copy or move into destDir. Never overwrites: conflicting names get " (2)". */
export function transfer(paths: string[], destDir: string, move: boolean): FmResult {
  if (isProtected(join(destDir, 'x'))) return deny(join(destDir, 'x'))!
  let done = 0
  const out: string[] = []
  for (const src of paths) {
    if (move) {
      const d = deny(src)
      if (d) return { ...d, done }
    }
    const srcNorm = src.toLowerCase()
    if (destDir.toLowerCase() === srcNorm || destDir.toLowerCase().startsWith(`${srcNorm}\\`)) return { ok: false, error: '폴더를 자기 안으로 옮기거나 복사할 수 없습니다.', done }
    let isDir: boolean
    try {
      isDir = statSync(src).isDirectory()
    } catch {
      continue
    }
    if (move && join(src, '..').toLowerCase() === destDir.toLowerCase()) continue
    const dest = join(destDir, uniqueName(basename(src), (x) => existsSync(join(destDir, x)), isDir))
    try {
      if (move) {
        try {
          renameSync(src, dest)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
          cpSync(src, dest, { recursive: true, errorOnExist: true, preserveTimestamps: true })
          rmSync(src, { recursive: true, force: true })
        }
        relink(src, dest)
      } else cpSync(src, dest, { recursive: true, errorOnExist: true, preserveTimestamps: true })
      done++
      out.push(dest)
    } catch (e) {
      return { ok: false, error: `${basename(src)}: ${(e as NodeJS.ErrnoException).code === 'EBUSY' ? '다른 프로그램이 사용 중입니다.' : (e as Error).message}`, done, paths: out }
    }
  }
  return { ok: true, done, paths: out }
}

/** Delete to the Recycle Bin (restorable). The renderer confirms first (13.0 rule 10). */
export async function trash(paths: string[]): Promise<FmResult> {
  let done = 0
  for (const p of paths) {
    const d = deny(p)
    if (d) return { ...d, done }
    try {
      if (process.env.TEAMHUB_E2E) {
        // E2E never touches the real Recycle Bin of the test PC.
        const bin = join(app.getPath('userData'), 'e2e-recycle')
        mkdirSync(bin, { recursive: true })
        renameSync(p, join(bin, `${Date.now()}-${basename(p)}`))
      } else await shell.trashItem(p)
      done++
    } catch (e) {
      return { ok: false, error: `${basename(p)}: ${(e as Error).message}`, done }
    }
  }
  return { ok: true, done }
}

export function properties(path: string): { path: string; size: number; files: number; folders: number; created: number; modified: number; dir: boolean } | null {
  try {
    const s = statSync(path)
    if (!s.isDirectory()) return { path, size: s.size, files: 1, folders: 0, created: s.birthtimeMs, modified: s.mtimeMs, dir: false }
    let size = 0
    let files = 0
    let folders = 0
    const walk = (p: string, depth: number): void => {
      if (depth > 20 || files > 200000) return
      let list: import('node:fs').Dirent[]
      try {
        list = readdirSync(p, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of list) {
        const c = join(p, e.name)
        if (e.isDirectory()) {
          folders++
          walk(c, depth + 1)
        } else {
          files++
          try {
            size += statSync(c).size
          } catch {
            // skip
          }
        }
      }
    }
    walk(path, 0)
    return { path, size, files, folders, created: s.birthtimeMs, modified: s.mtimeMs, dir: true }
  } catch {
    return null
  }
}

/** Keep tags, collections, pins and the search index pointing at moved/renamed items. */
export function relink(from: string, to: string): void {
  const db = localDb().db
  const like = `${from.replace(/[%_\\]/g, (c) => `\\${c}`)}\\\\%`
  db.tx(() => {
    for (const t of ['file_tags', 'collection_items']) {
      db.run(`UPDATE OR IGNORE ${t} SET path = ? WHERE path = ?`, [to, from])
      db.run(`UPDATE OR IGNORE ${t} SET path = ? || substr(path, ?) WHERE path LIKE ? ESCAPE '\\'`, [to, from.length + 1, like])
    }
    db.run('UPDATE OR IGNORE fm_pins SET path = ?, name = ? WHERE path = ?', [to, basename(to), from])
  })
}

export const openItem = (p: string): Promise<string> => shell.openPath(p)
export const revealItem = (p: string): void => shell.showItemInFolder(p)
