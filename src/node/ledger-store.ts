import { gunzipSync, gzipSync } from 'node:zlib'
import { newId, parseJson, type Db } from './sqlite'
import {
  LEDGER_CHUNK,
  LEDGER_GONE_KEEP_MS,
  LEDGER_MAX_ROWS,
  LEDGER_ROW_MAX,
  LEDGER_SNAPSHOT_GAP_MS,
  LEDGER_SNAPSHOT_REMOVED,
  LEDGER_VERSIONS_KEEP,
  type LedgerCell,
  type LedgerChange,
  type LedgerChanges,
  type LedgerDoc,
  type LedgerHead,
  type LedgerRefused,
  type LedgerRow,
  type LedgerVersion
} from '../shared/schemas/ledger'

/**
 * Row storage of ledgers (관리대장), the same in the local DB (개인용) and the server DB
 * (팀용 · 지정자용): tables `ledgers` (head), `ledger_rows` (one record per row) and
 * `ledger_versions` (변경 이력, gzip). The caller owns the other columns of `ledgers`
 * (audience, owner…) and checks who may do what.
 */

/** A change the user must be told about in Korean (bad sheet, too many rows…). */
export class LedgerError extends Error {}

/** More changed rows than this: the reader takes the whole ledger again. */
const FEED_MAX = 20_000
const POS_STEP = 1024

interface Head {
  version: number
  head: string
  head_rev: number
  head_seq: number
  row_count: number
  feed_floor: number
  snap_at: number | null
  name: string
}
interface StoredRow {
  id: string
  pos: number
  cells: string
  seq: number
  gone: number
}
export interface LedgerActor {
  id: string | null
  name: string | null
}

const empty = (v: unknown): boolean => v === undefined || v === null || v === ''
const same = (a: unknown, b: unknown): boolean => (empty(a) && empty(b)) || a === b

/** Head of a sheet: no rows, no id, unique column ids and names. */
export function headOf(doc: LedgerHead | LedgerDoc): LedgerHead {
  const { rows: _rows, id: _id, ...head } = doc as LedgerDoc & { id?: unknown }
  const names = new Set<string>()
  const ids = new Set<string>()
  for (const c of head.cols) {
    const n = c.name.trim().toLowerCase()
    if (ids.has(c.id) || names.has(n)) throw new LedgerError('같은 이름의 열이 있습니다.')
    ids.add(c.id)
    names.add(n)
  }
  return head
}

function cellsText(c: Record<string, LedgerCell>): string {
  const out: Record<string, LedgerCell> = {}
  for (const k of Object.keys(c)) if (!empty(c[k])) out[k] = c[k]
  const text = JSON.stringify(out)
  if (text.length > LEDGER_ROW_MAX) throw new LedgerError('한 행에 들어간 내용이 너무 깁니다(약 64KB).')
  return text
}

export class LedgerStore {
  constructor(private readonly db: Db) {}

  private head(id: string): Head {
    const h = this.db.get<Head>('SELECT version, head, head_rev, head_seq, row_count, feed_floor, snap_at, name FROM ledgers WHERE id = ?', [id])
    if (!h) throw new LedgerError('대장을 찾을 수 없습니다.')
    return h
  }

  /** Rows of a new ledger (the caller has inserted the `ledgers` record with version 1). */
  fill(id: string, rows: LedgerDoc['rows']): void {
    if (rows.length > LEDGER_MAX_ROWS) throw new LedgerError(`행이 너무 많습니다(${LEDGER_MAX_ROWS.toLocaleString()}행까지).`)
    const ins = this.db.raw.prepare('INSERT OR IGNORE INTO ledger_rows (ledger_id, id, pos, cells, seq, gone) VALUES (?, ?, ?, ?, 1, 0)')
    let n = 0
    rows.forEach((r, i) => (n += Number(ins.run(id, r.id, r.p ?? (i + 1) * POS_STEP, cellsText(r.c)).changes)))
    this.db.run('UPDATE ledgers SET row_count = ? WHERE id = ?', [n, id])
  }

  /** One page of rows in order; `after` is the last row of the page before. */
  page(id: string, after: { p: number; id: string } | null, limit = LEDGER_CHUNK): { rows: LedgerRow[]; more: boolean } {
    const rows = after
      ? this.db.all<StoredRow>('SELECT id, pos, cells FROM ledger_rows WHERE ledger_id = ? AND gone = 0 AND (pos > ? OR (pos = ? AND id > ?)) ORDER BY pos, id LIMIT ?', [id, after.p, after.p, after.id, limit + 1])
      : this.db.all<StoredRow>('SELECT id, pos, cells FROM ledger_rows WHERE ledger_id = ? AND gone = 0 ORDER BY pos, id LIMIT ?', [id, limit + 1])
    const more = rows.length > limit
    return { rows: rows.slice(0, limit).map((r) => ({ id: r.id, p: r.pos, c: parseJson<Record<string, LedgerCell>>(r.cells, {}) })), more }
  }

  /** The whole sheet in one piece (versions, copies, files). */
  doc(id: string): LedgerHead & { rows: LedgerRow[] } {
    const h = this.head(id)
    const rows = this.db.all<StoredRow>('SELECT id, pos, cells FROM ledger_rows WHERE ledger_id = ? AND gone = 0 ORDER BY pos, id', [id])
    return { ...parseJson<LedgerHead>(h.head, { name: h.name, cols: [] }), rows: rows.map((r) => ({ id: r.id, p: r.pos, c: parseJson<Record<string, LedgerCell>>(r.cells, {}) })) }
  }

  /** What changed after `since` (not counting `skipSeq`, the caller's own save, unless listed in `also`). */
  changes(id: string, since: number, skipSeq = -1, also: string[] = []): LedgerChanges {
    const h = this.head(id)
    const base = { version: h.version, headRev: h.head_rev, rows: [], gone: [] }
    if (since >= h.version && !also.length) return base
    if (since < h.feed_floor) return { ...base, full: true }
    const n = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ledger_rows WHERE ledger_id = ? AND seq > ? AND seq <> ?', [id, since, skipSeq])!.n
    if (n > FEED_MAX) return { ...base, full: true }
    const list = this.db.all<StoredRow>('SELECT id, pos, cells, gone FROM ledger_rows WHERE ledger_id = ? AND seq > ? AND seq <> ?', [id, since, skipSeq])
    if (also.length) {
      const got = new Set(list.map((r) => r.id))
      const one = this.db.raw.prepare('SELECT id, pos, cells, gone FROM ledger_rows WHERE ledger_id = ? AND id = ?')
      for (const x of also) {
        if (got.has(x)) continue
        const r = one.get(id, x) as StoredRow | undefined
        if (r) list.push(r)
      }
    }
    const out: LedgerChanges = { ...base }
    for (const r of list) {
      if (r.gone) out.gone.push(r.id)
      else out.rows.push({ id: r.id, p: r.pos, c: parseJson<Record<string, LedgerCell>>(r.cells, {}) })
    }
    if (h.head_seq > since && h.head_seq !== skipSeq) out.head = parseJson<LedgerHead>(h.head, { name: h.name, cols: [] })
    return out
  }

  /**
   * One save. Cells are compare-and-set against `was`; rows that lost are refused and the
   * rest is saved. The answer carries what others changed since `change.since`, so the
   * editor ends up with exactly what is stored.
   */
  apply(id: string, change: LedgerChange, by: LedgerActor, t = Date.now()): { version: number; saved: boolean; refused: LedgerRefused; changes: LedgerChanges } {
    return this.db.tx(() => {
      const h = this.head(id)
      const refused: LedgerRefused = { rows: [] }
      const nv = h.version + 1
      const since = change.since
      const also: string[] = []
      let saved = false
      let count = h.row_count

      const headOk = !change.head || change.head.rev === h.head_rev
      if (change.head && !headOk) refused.head = true
      const newHead = change.head && headOk ? headOf(change.head.value) : null
      const oldCols = parseJson<LedgerHead>(h.head, { name: h.name, cols: [] }).cols
      const dropsColumn = !!newHead && oldCols.some((c) => !newHead.cols.some((x) => x.id === c.id))
      if (t - (h.snap_at ?? 0) > LEDGER_SNAPSHOT_GAP_MS) this.snapshot(id, 'edit', by, t)
      else if (change.remove.length >= LEDGER_SNAPSHOT_REMOVED || dropsColumn) this.snapshot(id, 'bulk', by, t)

      const one = this.db.raw.prepare('SELECT id, pos, cells, seq, gone FROM ledger_rows WHERE ledger_id = ? AND id = ?')
      const put = this.db.raw.prepare('INSERT INTO ledger_rows (ledger_id, id, pos, cells, seq, gone, gone_at) VALUES (?, ?, ?, ?, ?, 0, NULL) ON CONFLICT(ledger_id, id) DO UPDATE SET pos = excluded.pos, cells = excluded.cells, seq = excluded.seq, gone = 0, gone_at = NULL')
      const upd = this.db.raw.prepare('UPDATE ledger_rows SET cells = ?, seq = ? WHERE ledger_id = ? AND id = ?')
      const mov = this.db.raw.prepare('UPDATE ledger_rows SET pos = ?, seq = ? WHERE ledger_id = ? AND id = ? AND gone = 0 AND pos <> ?')
      const del = this.db.raw.prepare("UPDATE ledger_rows SET gone = 1, cells = '{}', seq = ?, gone_at = ? WHERE ledger_id = ? AND id = ? AND gone = 0")

      for (const r of change.add) {
        const cur = one.get(id, r.id) as StoredRow | undefined
        if (cur && !cur.gone) {
          // sent twice (a retry after a lost answer): the same row is fine, another one is refused
          if (cur.cells !== cellsText(r.c)) refused.rows.push({ id: r.id, reason: 'changed' })
          continue
        }
        if (count >= LEDGER_MAX_ROWS) throw new LedgerError(`행이 너무 많습니다(${LEDGER_MAX_ROWS.toLocaleString()}행까지). 오래된 행을 다른 대장으로 나눠 주세요.`)
        put.run(id, r.id, r.p, cellsText(r.c), nv)
        count++
        saved = true
      }
      for (const s of change.set) {
        const cur = one.get(id, s.id) as StoredRow | undefined
        if (!cur || cur.gone) {
          refused.rows.push({ id: s.id, reason: 'gone' })
          continue
        }
        const c = parseJson<Record<string, LedgerCell>>(cur.cells, {})
        // a cell that holds neither what the editor saw nor what the editor wants was changed by someone else
        if (Object.keys(s.set).some((k) => !same(c[k], s.was[k]) && !same(c[k], s.set[k]))) {
          refused.rows.push({ id: s.id, reason: 'changed' })
          also.push(s.id)
          continue
        }
        let diff = false
        for (const k of Object.keys(s.set)) {
          if (same(c[k], s.set[k])) continue
          diff = true
          if (empty(s.set[k])) delete c[k]
          else c[k] = s.set[k]
        }
        if (!diff) continue
        if (cur.seq > since) also.push(s.id)
        upd.run(cellsText(c), nv, id, s.id)
        saved = true
      }
      for (const m of change.move) if (Number(mov.run(m.p, nv, id, m.id, m.p).changes)) saved = true
      for (const x of change.remove)
        if (Number(del.run(nv, t, id, x).changes)) {
          count--
          saved = true
        }
      if (newHead) {
        const text = JSON.stringify(newHead)
        if (text !== h.head) {
          this.db.run('UPDATE ledgers SET head = ?, name = ?, head_rev = head_rev + 1, head_seq = ? WHERE id = ?', [text, newHead.name, nv, id])
          saved = true
        }
      }
      if (change.icon) this.db.run('UPDATE ledgers SET icon = ? WHERE id = ?', [change.icon, id])
      if (saved) this.db.run('UPDATE ledgers SET version = ?, row_count = ?, updated_at = ? WHERE id = ?', [nv, count, t, id])
      return { version: saved ? nv : h.version, saved, refused, changes: this.changes(id, since, saved ? nv : -1, also) }
    })
  }

  /** Replace the whole sheet (restore a version, the whole-sheet save of v1.1.0). Unchanged rows are left alone. */
  replace(id: string, doc: LedgerDoc, t = Date.now()): number {
    return this.db.tx(() => {
      const h = this.head(id)
      if (doc.rows.length > LEDGER_MAX_ROWS) throw new LedgerError(`행이 너무 많습니다(${LEDGER_MAX_ROWS.toLocaleString()}행까지).`)
      const nv = h.version + 1
      const head = JSON.stringify(headOf(doc))
      const old = new Map(this.db.all<StoredRow>('SELECT id, pos, cells, gone FROM ledger_rows WHERE ledger_id = ?', [id]).map((r) => [r.id, r]))
      const put = this.db.raw.prepare('INSERT INTO ledger_rows (ledger_id, id, pos, cells, seq, gone, gone_at) VALUES (?, ?, ?, ?, ?, 0, NULL) ON CONFLICT(ledger_id, id) DO UPDATE SET pos = excluded.pos, cells = excluded.cells, seq = excluded.seq, gone = 0, gone_at = NULL')
      const keep = new Set<string>()
      doc.rows.forEach((r, i) => {
        if (keep.has(r.id)) return
        keep.add(r.id)
        const p = (i + 1) * POS_STEP
        const text = cellsText(r.c)
        const cur = old.get(r.id)
        if (!cur || cur.gone || cur.pos !== p || cur.cells !== text) put.run(id, r.id, p, text, nv)
      })
      const del = this.db.raw.prepare("UPDATE ledger_rows SET gone = 1, cells = '{}', seq = ?, gone_at = ? WHERE ledger_id = ? AND id = ?")
      for (const r of old.values()) if (!r.gone && !keep.has(r.id)) del.run(nv, t, id, r.id)
      this.db.run('UPDATE ledgers SET head = ?, name = ?, head_rev = head_rev + ?, head_seq = CASE WHEN ? THEN ? ELSE head_seq END, version = ?, row_count = ?, updated_at = ? WHERE id = ?', [
        head,
        doc.name,
        head !== h.head ? 1 : 0,
        head !== h.head ? 1 : 0,
        nv,
        nv,
        keep.size,
        t,
        id
      ])
      return nv
    })
  }

  // ---------- versions (변경 이력) ----------
  /** Keep the sheet as it is now. Old versions beyond the limit and long-removed rows go. */
  snapshot(id: string, reason: string, by: LedgerActor, t = Date.now()): string {
    const h = this.head(id)
    const d = this.doc(id)
    const vid = newId()
    const blob = gzipSync(JSON.stringify({ ...d, rows: d.rows.map((r) => ({ id: r.id, c: r.c })) }))
    this.db.run('INSERT INTO ledger_versions (id, ledger_id, version, name, row_count, doc, reason, by_id, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [vid, id, h.version, h.name, d.rows.length, blob, reason, by.id, by.name, t])
    this.db.run('DELETE FROM ledger_versions WHERE ledger_id = ? AND id NOT IN (SELECT id FROM ledger_versions WHERE ledger_id = ? ORDER BY created_at DESC, version DESC LIMIT ?)', [id, id, LEDGER_VERSIONS_KEEP])
    const floor = this.db.get<{ s: number | null }>('SELECT MAX(seq) AS s FROM ledger_rows WHERE ledger_id = ? AND gone = 1 AND gone_at < ?', [id, t - LEDGER_GONE_KEEP_MS])?.s
    if (floor) {
      this.db.run('DELETE FROM ledger_rows WHERE ledger_id = ? AND gone = 1 AND gone_at < ?', [id, t - LEDGER_GONE_KEEP_MS])
      this.db.run('UPDATE ledgers SET feed_floor = MAX(feed_floor, ?) WHERE id = ?', [floor, id])
    }
    this.db.run('UPDATE ledgers SET snap_at = ? WHERE id = ?', [t, id])
    return vid
  }

  versions(id: string): LedgerVersion[] {
    return this.db
      .all<{ id: string; version: number; name: string; row_count: number; reason: string; by_name: string | null; created_at: number }>(
        'SELECT id, version, name, row_count, reason, by_name, created_at FROM ledger_versions WHERE ledger_id = ? ORDER BY created_at DESC, version DESC',
        [id]
      )
      .map((v) => ({ id: v.id, version: v.version, name: v.name, rows: v.row_count, reason: v.reason, byName: v.by_name, createdAt: v.created_at }))
  }

  versionDoc(id: string, versionId: string): LedgerDoc {
    const v = this.db.get<{ doc: Uint8Array }>('SELECT doc FROM ledger_versions WHERE ledger_id = ? AND id = ?', [id, versionId])
    if (!v) throw new LedgerError('그 시점의 기록을 찾을 수 없습니다.')
    return JSON.parse(gunzipSync(v.doc).toString('utf8')) as LedgerDoc
  }

  /** Back to a kept version; the sheet as it is now is kept first, so this can be undone. */
  restore(id: string, versionId: string, by: LedgerActor, t = Date.now()): number {
    const doc = this.versionDoc(id, versionId)
    return this.db.tx(() => {
      this.snapshot(id, 'restore', by, t)
      return this.replace(id, doc, t)
    })
  }

  /** Remove a ledger for good. */
  destroy(id: string): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM ledger_versions WHERE ledger_id = ?', [id])
      this.db.run('DELETE FROM ledger_rows WHERE ledger_id = ?', [id])
      this.db.run('DELETE FROM ledgers WHERE id = ?', [id])
    })
  }
}
