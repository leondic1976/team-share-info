import type { Db } from '../../node/sqlite'
import { extOf, extsOf, parseSearch, type IndexRoot, type SearchHit, type SearchQuery } from '../../shared/fm'

export interface IndexedFile {
  path: string
  name: string
  dir: string
  size: number
  mtime: number
  isDir: boolean
}

interface Row {
  path: string
  name: string
  dir: string
  ext: string
  size: number
  mtime: number
  is_dir: number
}

const hit = (r: Row): SearchHit => ({ path: r.path, name: r.name, dir: r.dir, ext: r.ext, size: r.size, mtime: r.mtime, isDir: !!r.is_dir })
const esc = (s: string): string => s.replace(/[%_\\]/g, (c) => `\\${c}`)

/** File-name index for fast search (6.18 ②). Shared by the indexer worker and main. */
export class FsIndexRepo {
  constructor(private readonly db: Db) {}

  roots(scanning: Set<string> = new Set()): IndexRoot[] {
    return this.db
      .all<{ path: string; enabled: number; last_scan_at: number | null; file_count: number }>('SELECT * FROM fs_roots ORDER BY path')
      .map((r) => ({ path: r.path, enabled: !!r.enabled, lastScanAt: r.last_scan_at, fileCount: r.file_count, scanning: scanning.has(r.path) }))
  }
  addRoot(path: string): void {
    this.db.run('INSERT INTO fs_roots (path) VALUES (?) ON CONFLICT(path) DO UPDATE SET enabled = 1', [path])
  }
  removeRoot(path: string): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM fs_files WHERE root = ?', [path])
      this.db.run('DELETE FROM fs_roots WHERE path = ?', [path])
    })
  }
  setEnabled(path: string, enabled: boolean): void {
    this.db.run('UPDATE fs_roots SET enabled = ? WHERE path = ?', [enabled ? 1 : 0, path])
    if (!enabled) this.db.run('DELETE FROM fs_files WHERE root = ?', [path])
  }

  /** Insert or refresh entries seen in scan generation `gen`. */
  upsert(root: string, gen: number, files: IndexedFile[]): void {
    this.db.tx(() => {
      for (const f of files) {
        this.db.run(
          `INSERT INTO fs_files (path, root, name, dir, ext, size, mtime, is_dir, gen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, is_dir = excluded.is_dir, gen = excluded.gen, root = excluded.root`,
          [f.path, root, f.name, f.dir, f.isDir ? '' : extOf(f.name), f.size, Math.round(f.mtime), f.isDir ? 1 : 0, gen]
        )
      }
    })
  }
  /** After a full scan: drop entries not seen in this generation. */
  finishScan(root: string, gen: number): number {
    this.db.run('DELETE FROM fs_files WHERE root = ? AND gen < ?', [root, gen])
    const n = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM fs_files WHERE root = ?', [root])?.n ?? 0
    this.db.run('UPDATE fs_roots SET last_scan_at = ?, file_count = ? WHERE path = ?', [Date.now(), n, root])
    return n
  }
  /** A path (file or folder) disappeared: remove it and everything under it. */
  removePath(path: string): void {
    this.db.run(`DELETE FROM fs_files WHERE path = ? OR path LIKE ? ESCAPE '\\'`, [path, `${esc(path)}\\\\%`])
  }

  search(q: SearchQuery): SearchHit[] {
    const { fts, like } = parseSearch(q.q)
    const where: string[] = []
    const params: (string | number)[] = []
    let from = 'fs_files f'
    if (fts.length) {
      from = 'fs_files_fts JOIN fs_files f ON f.rowid = fs_files_fts.rowid'
      where.push('fs_files_fts MATCH ?')
      params.push(fts.join(' AND '))
    }
    for (const l of like) {
      where.push(`f.name LIKE ? ESCAPE '\\'`)
      params.push(l)
    }
    if (q.category === 'folder') where.push('f.is_dir = 1')
    else if (q.category) {
      const exts = extsOf(q.category)
      where.push(`f.ext IN (${exts.map(() => '?').join(',')})`)
      params.push(...exts)
    }
    if (q.ext) {
      where.push('f.ext = ?')
      params.push(q.ext.replace(/^\./, '').toLowerCase())
    }
    if (q.minSize !== undefined) {
      where.push('f.size >= ?')
      params.push(q.minSize)
    }
    if (q.maxSize !== undefined) {
      where.push('f.size <= ?')
      params.push(q.maxSize)
    }
    if (q.modifiedAfter !== undefined) {
      where.push('f.mtime >= ?')
      params.push(q.modifiedAfter)
    }
    if (q.modifiedBefore !== undefined) {
      where.push('f.mtime < ?')
      params.push(q.modifiedBefore)
    }
    if (q.under) {
      where.push(`(f.dir = ? OR f.dir LIKE ? ESCAPE '\\')`)
      params.push(q.under.replace(/\\$/, ''), `${esc(q.under.replace(/\\$/, ''))}\\\\%`)
    }
    if (!where.length) return []
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 2000)
    return this.db.all<Row>(`SELECT f.path, f.name, f.dir, f.ext, f.size, f.mtime, f.is_dir FROM ${from} WHERE ${where.join(' AND ')} ORDER BY f.mtime DESC LIMIT ${limit}`, params).map(hit)
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM fs_files')?.n ?? 0
  }
}
