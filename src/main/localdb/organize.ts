import type { Db } from '../../node/sqlite'
import { newId, parseJson } from '../../node/sqlite'
import { TAG_COLORS, type BookmarkDto, type BookmarkInput, type CollectionDto, type SmartFolderDto, type SmartQuery, type TagDto } from '../../shared/organize'

/** Tags, collections (virtual folders), smart folders and bookmarks (6.18 ③④). */
export class OrganizeRepo {
  constructor(private readonly db: Db) {}

  // ---------- tags ----------
  tags(): TagDto[] {
    return this.db.all<TagDto>('SELECT t.name, t.color, (SELECT COUNT(*) FROM file_tags f WHERE f.tag = t.name) AS count FROM tags t ORDER BY t.name')
  }
  tagsOf(paths: string[]): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (let i = 0; i < paths.length; i += 400) {
      const chunk = paths.slice(i, i + 400)
      for (const r of this.db.all<{ path: string; tag: string }>(`SELECT path, tag FROM file_tags WHERE path IN (${chunk.map(() => '?').join(',')}) ORDER BY tag`, chunk)) (out[r.path] ??= []).push(r.tag)
    }
    return out
  }
  setTags(path: string, tags: string[]): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM file_tags WHERE path = ?', [path])
      for (const t of new Set(tags.map((x) => x.trim()).filter(Boolean))) {
        if (!this.db.get('SELECT 1 FROM tags WHERE name = ?', [t])) {
          const n = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tags')?.n ?? 0
          this.db.run('INSERT INTO tags (name, color) VALUES (?, ?)', [t, TAG_COLORS[n % TAG_COLORS.length]])
        }
        this.db.run('INSERT OR IGNORE INTO file_tags (path, tag, added_at) VALUES (?, ?, ?)', [path, t, Date.now()])
      }
    })
  }
  addTag(paths: string[], tag: string): void {
    for (const p of paths) this.setTags(p, [...(this.tagsOf([p])[p] ?? []), tag])
  }
  pathsWithTag(tag: string): string[] {
    return this.db.all<{ path: string }>('SELECT path FROM file_tags WHERE tag = ? ORDER BY added_at DESC', [tag]).map((r) => r.path)
  }
  updateTag(name: string, patch: { name?: string; color?: string }): void {
    if (patch.color) this.db.run('UPDATE tags SET color = ? WHERE name = ?', [patch.color, name])
    if (patch.name && patch.name !== name) this.db.run('UPDATE tags SET name = ? WHERE name = ?', [patch.name, name])
  }
  deleteTag(name: string): void {
    this.db.run('DELETE FROM tags WHERE name = ?', [name])
  }
  /** Tags or collection entries whose path is gone are dropped on request. */
  forgetPath(path: string): void {
    this.db.run('DELETE FROM file_tags WHERE path = ?', [path])
    this.db.run('DELETE FROM collection_items WHERE path = ?', [path])
  }

  // ---------- collections ----------
  collections(): CollectionDto[] {
    return this.db.all<{ id: string; parent_id: string | null; name: string; note: string; count: number }>(
      'SELECT c.*, (SELECT COUNT(*) FROM collection_items i WHERE i.collection_id = c.id) AS count FROM collections c ORDER BY c.sort, c.name'
    ).map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name, note: r.note, count: r.count }))
  }
  saveCollection(c: { id?: string; parentId?: string | null; name: string; note?: string }): string {
    if (c.id && this.db.get('SELECT 1 FROM collections WHERE id = ?', [c.id])) {
      if (c.parentId && this.isDescendant(c.parentId, c.id)) throw new Error('묶음을 자기 아래로 옮길 수 없습니다.')
      this.db.run('UPDATE collections SET name = ?, note = ?, parent_id = ? WHERE id = ?', [c.name, c.note ?? '', c.parentId ?? null, c.id])
      return c.id
    }
    const id = newId()
    this.db.run('INSERT INTO collections (id, parent_id, name, note, sort, created_at) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort),0)+1 FROM collections), ?)', [id, c.parentId ?? null, c.name, c.note ?? '', Date.now()])
    return id
  }
  private isDescendant(id: string, ancestor: string): boolean {
    let cur: string | null = id
    for (let i = 0; cur && i < 100; i++) {
      if (cur === ancestor) return true
      cur = this.db.get<{ parent_id: string | null }>('SELECT parent_id FROM collections WHERE id = ?', [cur])?.parent_id ?? null
    }
    return false
  }
  deleteCollection(id: string): void {
    this.db.run('DELETE FROM collections WHERE id = ?', [id])
  }
  collectionItems(id: string): { path: string; note: string; addedAt: number }[] {
    return this.db.all<{ path: string; note: string; added_at: number }>('SELECT path, note, added_at FROM collection_items WHERE collection_id = ? ORDER BY added_at DESC', [id]).map((r) => ({ path: r.path, note: r.note, addedAt: r.added_at }))
  }
  addToCollection(id: string, paths: string[]): number {
    let n = 0
    for (const p of paths) n += this.db.run('INSERT OR IGNORE INTO collection_items (collection_id, path, added_at) VALUES (?, ?, ?)', [id, p, Date.now()]).changes as number
    return n
  }
  removeFromCollection(id: string, path: string): void {
    this.db.run('DELETE FROM collection_items WHERE collection_id = ? AND path = ?', [id, path])
  }
  setItemNote(id: string, path: string, note: string): void {
    this.db.run('UPDATE collection_items SET note = ? WHERE collection_id = ? AND path = ?', [note, id, path])
  }

  // ---------- smart folders ----------
  smartFolders(): SmartFolderDto[] {
    return this.db.all<{ id: string; name: string; query: string }>('SELECT * FROM smart_folders ORDER BY sort, name').map((r) => ({ id: r.id, name: r.name, query: parseJson<SmartQuery>(r.query, { q: '' }) }))
  }
  saveSmartFolder(f: { id?: string; name: string; query: SmartQuery }): string {
    if (f.id && this.db.get('SELECT 1 FROM smart_folders WHERE id = ?', [f.id])) {
      this.db.run('UPDATE smart_folders SET name = ?, query = ? WHERE id = ?', [f.name, JSON.stringify(f.query), f.id])
      return f.id
    }
    const id = newId()
    this.db.run('INSERT INTO smart_folders (id, name, query, sort, created_at) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort),0)+1 FROM smart_folders), ?)', [id, f.name, JSON.stringify(f.query), Date.now()])
    return id
  }
  deleteSmartFolder(id: string): void {
    this.db.run('DELETE FROM smart_folders WHERE id = ?', [id])
  }

  // ---------- bookmarks ----------
  bookmarks(): BookmarkDto[] {
    return this.db.all<BookmarkDto>('SELECT id, title, url, category, note, sort FROM bookmarks ORDER BY category, sort, title')
  }
  saveBookmark(b: BookmarkInput): string {
    if (b.id && this.db.get('SELECT 1 FROM bookmarks WHERE id = ?', [b.id])) {
      this.db.run('UPDATE bookmarks SET title = ?, url = ?, category = ?, note = ? WHERE id = ?', [b.title, b.url, b.category ?? '', b.note ?? '', b.id])
      return b.id
    }
    const existing = this.db.get<{ id: string }>('SELECT id FROM bookmarks WHERE url = ?', [b.url])
    if (existing) return existing.id
    const id = newId()
    this.db.run('INSERT INTO bookmarks (id, title, url, category, note, sort, created_at) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort),0)+1 FROM bookmarks), ?)', [id, b.title, b.url, b.category ?? '', b.note ?? '', Date.now()])
    return id
  }
  importBookmarks(items: { title: string; url: string; category: string }[]): number {
    let n = 0
    this.db.tx(() => {
      for (const i of items) {
        if (this.db.get('SELECT 1 FROM bookmarks WHERE url = ?', [i.url])) continue
        this.saveBookmark({ title: i.title.slice(0, 100) || i.url, url: i.url, category: i.category })
        n++
      }
    })
    return n
  }
  deleteBookmark(id: string): void {
    this.db.run('DELETE FROM bookmarks WHERE id = ?', [id])
  }
  reorderBookmarks(ids: string[]): void {
    this.db.tx(() => ids.forEach((id, i) => this.db.run('UPDATE bookmarks SET sort = ? WHERE id = ?', [i, id])))
  }
}
