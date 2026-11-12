import type { Db } from '../../node/sqlite'
import { newId, parseJson } from '../../node/sqlite'
import { DEFAULT_DB_PROPS, extractNoteLinks, htmlToText, type CellValue, type DbProps, type NoteDto, type NoteKind, type NoteRow, type NoteTreeItem } from '../../shared/notes'

interface Row {
  id: string
  parent_id: string | null
  kind: NoteKind
  title: string
  icon: string
  body_html: string
  props: string
  row_values: string | null
  sort: number
  favorite: number
  is_template: number
  trashed_at: number | null
  created_at: number
  updated_at: number
}

const tree = (r: Row): NoteTreeItem => ({ id: r.id, parentId: r.parent_id, kind: r.kind, title: r.title, icon: r.icon, sort: r.sort, favorite: !!r.favorite, isTemplate: !!r.is_template })
const TRASH_KEEP_MS = 30 * 86400000

/** Personal knowledge notes (6.18 ⑤): page tree, links/backlinks, databases, trash. */
export class NotesRepo {
  constructor(private readonly db: Db) {}

  /** Pages and databases (database rows are shown inside their database, not in the tree). */
  tree(): NoteTreeItem[] {
    return this.db.all<Row>('SELECT * FROM notes WHERE trashed_at IS NULL AND row_values IS NULL ORDER BY sort, created_at').map(tree)
  }
  trash(): NoteTreeItem[] {
    return this.db.all<Row>(`SELECT * FROM notes n WHERE trashed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM notes p WHERE p.id = n.parent_id AND p.trashed_at IS NOT NULL) ORDER BY trashed_at DESC`).map(tree)
  }

  get(id: string): NoteDto | null {
    const r = this.db.get<Row>('SELECT * FROM notes WHERE id = ?', [id])
    if (!r) return null
    const backlinks = this.db.all<{ id: string; title: string; icon: string }>(
      'SELECT n.id, n.title, n.icon FROM note_links l JOIN notes n ON n.id = l.from_id WHERE l.to_id = ? AND n.trashed_at IS NULL ORDER BY n.updated_at DESC',
      [id]
    )
    const path: { id: string; title: string }[] = []
    let cur = r.parent_id
    for (let i = 0; cur && i < 50; i++) {
      const p = this.db.get<{ id: string; title: string; parent_id: string | null }>('SELECT id, title, parent_id FROM notes WHERE id = ?', [cur])
      if (!p) break
      path.unshift({ id: p.id, title: p.title })
      cur = p.parent_id
    }
    return {
      ...tree(r),
      bodyHtml: r.body_html,
      props: parseJson<DbProps | Record<string, never>>(r.props, {}),
      rowValues: r.row_values ? parseJson<Record<string, CellValue>>(r.row_values, {}) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      trashedAt: r.trashed_at,
      backlinks,
      path
    }
  }

  create(i: { parentId?: string | null; kind?: NoteKind; title?: string; icon?: string; bodyHtml?: string; rowOf?: string }): string {
    const id = newId()
    const t = Date.now()
    const parent = i.rowOf ?? i.parentId ?? null
    const kind = i.kind ?? 'page'
    const sort = this.db.get<{ m: number }>('SELECT COALESCE(MAX(sort), 0) + 1 AS m FROM notes WHERE parent_id IS ?', [parent])?.m ?? 0
    const html = i.bodyHtml ?? ''
    this.db.run('INSERT INTO notes (id, parent_id, kind, title, icon, body_html, body_text, props, row_values, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      parent,
      kind,
      i.title ?? '',
      i.icon ?? '',
      html,
      htmlToText(html),
      kind === 'database' ? JSON.stringify(DEFAULT_DB_PROPS) : '{}',
      i.rowOf ? '{}' : null,
      sort,
      t,
      t
    ])
    this.relink(id, html)
    return id
  }

  update(id: string, p: { title?: string; icon?: string; bodyHtml?: string; props?: DbProps; rowValues?: Record<string, CellValue>; favorite?: boolean; isTemplate?: boolean }): void {
    const sets: string[] = []
    const vals: (string | number | null)[] = []
    if (p.title !== undefined) {
      sets.push('title = ?')
      vals.push(p.title)
    }
    if (p.icon !== undefined) {
      sets.push('icon = ?')
      vals.push(p.icon)
    }
    if (p.bodyHtml !== undefined) {
      sets.push('body_html = ?', 'body_text = ?')
      vals.push(p.bodyHtml, htmlToText(p.bodyHtml))
    }
    if (p.props !== undefined) {
      sets.push('props = ?')
      vals.push(JSON.stringify(p.props))
    }
    if (p.rowValues !== undefined) {
      sets.push('row_values = ?')
      vals.push(JSON.stringify(p.rowValues))
    }
    if (p.favorite !== undefined) {
      sets.push('favorite = ?')
      vals.push(p.favorite ? 1 : 0)
    }
    if (p.isTemplate !== undefined) {
      sets.push('is_template = ?')
      vals.push(p.isTemplate ? 1 : 0)
    }
    if (!sets.length) return
    sets.push('updated_at = ?')
    vals.push(Date.now(), id)
    this.db.run(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`, vals)
    if (p.bodyHtml !== undefined) this.relink(id, p.bodyHtml)
  }

  private relink(id: string, html: string): void {
    this.db.run('DELETE FROM note_links WHERE from_id = ?', [id])
    for (const to of extractNoteLinks(html)) if (to !== id) this.db.run('INSERT OR IGNORE INTO note_links (from_id, to_id) VALUES (?, ?)', [id, to])
  }

  private descendants(id: string): string[] {
    return this.db
      .all<{ id: string }>('WITH RECURSIVE d(id) AS (SELECT id FROM notes WHERE parent_id = ? UNION ALL SELECT n.id FROM notes n JOIN d ON n.parent_id = d.id) SELECT id FROM d', [id])
      .map((r) => r.id)
  }

  /** Move under a new parent at position `index` among its siblings. */
  move(id: string, parentId: string | null, index: number): void {
    if (parentId && (parentId === id || this.descendants(id).includes(parentId))) throw new Error('페이지를 자기 아래로 옮길 수 없습니다.')
    this.db.tx(() => {
      const sibs = this.db.all<{ id: string }>('SELECT id FROM notes WHERE parent_id IS ? AND id != ? AND trashed_at IS NULL AND row_values IS NULL ORDER BY sort, created_at', [parentId, id]).map((r) => r.id)
      sibs.splice(Math.max(0, Math.min(index, sibs.length)), 0, id)
      this.db.run('UPDATE notes SET parent_id = ? WHERE id = ?', [parentId, id])
      sibs.forEach((s, i) => this.db.run('UPDATE notes SET sort = ? WHERE id = ?', [i, s]))
    })
  }

  /** Trash a page with everything under it (restorable for 30 days). */
  moveToTrash(id: string): void {
    const t = Date.now()
    this.db.tx(() => {
      for (const n of [id, ...this.descendants(id)]) this.db.run('UPDATE notes SET trashed_at = ? WHERE id = ? AND trashed_at IS NULL', [t, n])
    })
  }
  restore(id: string): void {
    const r = this.db.get<{ trashed_at: number | null; parent_id: string | null }>('SELECT trashed_at, parent_id FROM notes WHERE id = ?', [id])
    if (!r?.trashed_at) return
    this.db.tx(() => {
      for (const n of [id, ...this.descendants(id)]) this.db.run('UPDATE notes SET trashed_at = NULL WHERE id = ? AND trashed_at = ?', [n, r.trashed_at])
      // a parent still in the trash: put the page back at the top level
      if (r.parent_id && this.db.get('SELECT 1 FROM notes WHERE id = ? AND trashed_at IS NOT NULL', [r.parent_id])) this.db.run('UPDATE notes SET parent_id = NULL WHERE id = ?', [id])
    })
  }
  purge(id: string): void {
    this.db.tx(() => {
      for (const n of [...this.descendants(id), id]) this.db.run('DELETE FROM notes WHERE id = ?', [n])
    })
  }
  purgeOld(now = Date.now()): number {
    const old = this.db.all<{ id: string }>('SELECT id FROM notes WHERE trashed_at IS NOT NULL AND trashed_at < ?', [now - TRASH_KEEP_MS])
    for (const o of old) this.db.run('DELETE FROM notes WHERE id = ?', [o.id])
    return old.length
  }

  /** Copy a page (and its subpages) — used for templates. */
  duplicate(id: string, parentId: string | null, asTemplate = false, top = true): string {
    const src = this.get(id)
    if (!src) throw new Error('페이지가 없습니다.')
    const nid = this.create({ parentId, kind: src.kind, title: !top || asTemplate || src.isTemplate ? src.title : `${src.title} (사본)`, icon: src.icon, bodyHtml: src.bodyHtml })
    if (src.kind === 'database') this.update(nid, { props: src.props as DbProps })
    if (asTemplate) this.update(nid, { isTemplate: true })
    for (const c of this.db.all<{ id: string }>('SELECT id FROM notes WHERE parent_id = ? AND trashed_at IS NULL AND row_values IS NULL ORDER BY sort', [id])) this.duplicate(c.id, nid, false, false)
    return nid
  }

  // ---------- databases ----------
  rows(dbId: string): NoteRow[] {
    return this.db
      .all<Row>('SELECT * FROM notes WHERE parent_id = ? AND row_values IS NOT NULL AND trashed_at IS NULL ORDER BY sort', [dbId])
      .map((r) => ({ id: r.id, title: r.title, icon: r.icon, values: parseJson<Record<string, CellValue>>(r.row_values ?? '{}', {}), sort: r.sort }))
  }
  addRow(dbId: string, values: Record<string, CellValue> = {}, title = ''): string {
    const id = this.create({ rowOf: dbId, title })
    this.update(id, { rowValues: values })
    return id
  }

  search(q: string, limit = 50): { id: string; title: string; icon: string; snippet: string }[] {
    const t = q.trim()
    if (!t) return []
    const base = 'SELECT n.id, n.title, n.icon, n.body_text FROM notes n'
    const rows =
      [...t].length >= 3
        ? this.db.all<{ id: string; title: string; icon: string; body_text: string }>(`${base} JOIN notes_fts f ON f.rowid = n.rowid WHERE notes_fts MATCH ? AND n.trashed_at IS NULL ORDER BY rank LIMIT ?`, [`"${t.replace(/"/g, '""')}"`, limit])
        : this.db.all<{ id: string; title: string; icon: string; body_text: string }>(`${base} WHERE (n.title LIKE ? OR n.body_text LIKE ?) AND n.trashed_at IS NULL ORDER BY n.updated_at DESC LIMIT ?`, [`%${t}%`, `%${t}%`, limit])
    return rows.map((r) => {
      const i = r.body_text.toLowerCase().indexOf(t.toLowerCase())
      return { id: r.id, title: r.title, icon: r.icon, snippet: i >= 0 ? r.body_text.slice(Math.max(0, i - 30), i + 60).replace(/\n/g, ' ') : r.body_text.slice(0, 80).replace(/\n/g, ' ') }
    })
  }
}
