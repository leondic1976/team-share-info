import { z } from 'zod'
import { newId, parseJson, type Db } from '../../node/sqlite'
import { LedgerStore, headOf } from '../../node/ledger-store'
import {
  LEDGER_CHUNK,
  LEDGER_MAX_ROWS,
  LEDGER_TRASH_DAYS,
  ledgerDocRowSchema,
  ledgerHeadSchema,
  type LedgerChange,
  type LedgerChanges,
  type LedgerDoc,
  type LedgerHead,
  type LedgerRefused,
  type LedgerRow,
  type LedgerVersion,
  type LocalLedgerDto,
  type LocalLedgerMeta
} from '../../shared/schemas/ledger'
import type { KvRepo } from './kv'

interface Row {
  id: string
  name: string
  icon: string
  head: string
  head_rev: number
  row_count: number
  version: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

/** A whole sheet of any size this PC holds (new ledger, file, copy of a team ledger). */
export const localLedgerDocSchema = ledgerHeadSchema.extend({
  rows: z.array(ledgerDocRowSchema).max(LEDGER_MAX_ROWS, `행이 너무 많습니다(${LEDGER_MAX_ROWS.toLocaleString()}행까지).`)
})

const ME = { id: null, name: null }
const meta = (r: Row): LocalLedgerMeta => ({
  id: r.id,
  name: r.name,
  icon: r.icon,
  rows: r.row_count,
  version: r.version,
  headRev: r.head_rev,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at
})

/** Personal ledgers (관리대장 · 개인용): rows of this PC's local DB, never sent anywhere. */
export class LedgersRepo {
  private readonly store: LedgerStore
  constructor(private readonly db: Db) {
    this.store = new LedgerStore(db)
  }

  private row(id: string, trashed = false): Row {
    const r = this.db.get<Row>(`SELECT * FROM ledgers WHERE id = ? AND deleted_at IS ${trashed ? 'NOT ' : ''}NULL`, [id])
    if (!r) throw new Error('대장을 찾을 수 없습니다.')
    return r
  }

  list(): LocalLedgerMeta[] {
    return this.db.all<Row>('SELECT * FROM ledgers WHERE deleted_at IS NULL ORDER BY updated_at DESC').map(meta)
  }

  /** Deleted ledgers; those left longer than the keeping time go for good. */
  trash(): LocalLedgerMeta[] {
    const old = this.db.all<{ id: string }>('SELECT id FROM ledgers WHERE deleted_at IS NOT NULL AND deleted_at < ?', [Date.now() - LEDGER_TRASH_DAYS * 24 * 3600_000])
    for (const x of old) this.store.destroy(x.id)
    return this.db.all<Row>('SELECT * FROM ledgers WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').map(meta)
  }

  get(id: string, after: { p: number; id: string } | null = null, limit = LEDGER_CHUNK): LocalLedgerDto {
    const r = this.row(id)
    const page = this.store.page(id, after, limit)
    return { ...meta(r), doc: { ...parseJson<LedgerHead>(r.head, { name: r.name, cols: [] }), rows: page.rows }, more: page.more }
  }

  create(doc: LedgerDoc, icon = '📄', t = Date.now()): LocalLedgerMeta {
    const id = newId()
    this.db.tx(() => {
      this.db.run('INSERT INTO ledgers (id, name, icon, head, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, doc.name, icon, JSON.stringify(headOf(doc)), t, t])
      this.store.fill(id, doc.rows)
    })
    return meta(this.row(id))
  }

  save(id: string, change: LedgerChange): { meta: LocalLedgerMeta; changes: LedgerChanges; refused: LedgerRefused } {
    this.row(id)
    const res = this.store.apply(id, change, ME)
    return { meta: meta(this.row(id)), changes: res.changes, refused: res.refused }
  }

  remove(id: string): void {
    this.db.run('UPDATE ledgers SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [Date.now(), id])
  }
  restore(id: string): LocalLedgerMeta {
    this.row(id, true)
    this.db.run('UPDATE ledgers SET deleted_at = NULL WHERE id = ?', [id])
    return meta(this.row(id))
  }
  purge(id: string): void {
    this.row(id, true)
    this.store.destroy(id)
  }

  versions(id: string): LedgerVersion[] {
    return this.store.versions(this.row(id).id)
  }
  keep(id: string): LedgerVersion[] {
    this.store.snapshot(this.row(id).id, 'manual', ME)
    return this.store.versions(id)
  }
  versionDoc(id: string, versionId: string): LedgerDoc {
    return this.store.versionDoc(this.row(id).id, versionId)
  }
  revert(id: string, versionId: string): LocalLedgerMeta {
    this.store.restore(this.row(id).id, versionId, ME)
    return meta(this.row(id))
  }
  /** The whole sheet (save as, copy to the team). */
  doc(id: string): LedgerHead & { rows: LedgerRow[] } {
    return this.store.doc(this.row(id).id)
  }

  /**
   * Ledgers of v1.1.0 and of the former "스마트 대장" plugin were kept whole under kv keys
   * `plugin:ledger:book:<id>`. Move each into rows once; a sheet that cannot be read stays
   * where it is.
   */
  importLegacy(kv: KvRepo): number {
    const keys = this.db.all<{ key: string }>("SELECT key FROM kv WHERE key LIKE 'plugin:ledger:book:%'").map((r) => r.key)
    if (!keys.length) return 0
    const index = kv.get<{ id: string; icon?: string }[]>('plugin:ledger:index')
    let n = 0
    for (const key of keys) {
      const raw = kv.get<{ id?: string; updatedAt?: number }>(key)
      const parsed = localLedgerDocSchema.safeParse(raw)
      if (!parsed.success) continue
      const e = Array.isArray(index) ? index.find((x) => x && x.id === raw?.id) : undefined
      const { updatedAt: _u, ...doc } = parsed.data as LedgerDoc & { updatedAt?: unknown }
      this.db.tx(() => {
        const made = this.create(doc as LedgerDoc, typeof e?.icon === 'string' ? e.icon.slice(0, 8) : '📄', typeof raw?.updatedAt === 'number' ? raw.updatedAt : Date.now())
        const last = kv.get<{ book?: string }>('plugin:ledger:last')
        if (last && last.book === raw?.id) kv.set('plugin:ledger:last', { book: made.id })
        kv.delete(key)
      })
      n++
    }
    if (!this.db.get("SELECT 1 AS x FROM kv WHERE key LIKE 'plugin:ledger:book:%'")) kv.delete('plugin:ledger:index')
    return n
  }
}
