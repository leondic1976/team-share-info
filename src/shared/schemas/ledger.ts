import { z } from 'zod'
import { scopeSchema, type ScopeDto } from './scope'

// ---------- ledgers (관리대장) ----------
// A ledger is kept as a head (name, note, columns) and rows, one record per row, in the
// local DB (개인용) or the server DB (팀용 · 지정자용). Saving sends only what changed.

/** Rows in one ledger. */
export const LEDGER_MAX_ROWS = 100_000
export const LEDGER_MAX_COLS = 200
/** Longest JSON text of the cells of one row (characters). */
export const LEDGER_ROW_MAX = 64 * 1024
/** Rows carried by one request (save, read page). */
export const LEDGER_CHUNK = 2000
/** Saved versions kept per ledger (변경 이력). */
export const LEDGER_VERSIONS_KEEP = 30
/** A new version is kept when the last one is older than this. */
export const LEDGER_SNAPSHOT_GAP_MS = 10 * 60_000
/** A save that removes at least this many rows keeps a version first, whatever the time. */
export const LEDGER_SNAPSHOT_REMOVED = 20
/** Deleted ledgers stay in the trash this long. */
export const LEDGER_TRASH_DAYS = 30
/** Removed rows are remembered this long for people who were away (then they reload the ledger). */
export const LEDGER_GONE_KEEP_MS = 7 * 24 * 3600_000

const cell = z.union([z.string().max(20_000), z.number(), z.boolean(), z.null()])
export type LedgerCell = z.infer<typeof cell>
const cells = z.record(z.string().max(40), cell)
const rowId = z.string().min(1).max(40)
const pos = z.number().finite()

const colSchema = z.looseObject({ id: z.string().min(1).max(40), name: z.string().min(1).max(60), type: z.string().min(1).max(20) })

/** Everything but the rows. Unknown fields (template, share…) are kept as they are. */
export const ledgerHeadSchema = z.looseObject({
  name: z.string().trim().min(1, '대장 이름을 넣으세요').max(60),
  note: z.string().max(2000).optional(),
  cols: z.array(colSchema).max(LEDGER_MAX_COLS, `열이 너무 많습니다(${LEDGER_MAX_COLS}개까지).`)
})
export type LedgerHead = z.infer<typeof ledgerHeadSchema>

/** p: position (rows are shown in ascending order). */
export const ledgerRowSchema = z.object({ id: rowId, p: pos, c: cells })
export type LedgerRow = z.infer<typeof ledgerRowSchema>

/**
 * A whole sheet in one piece (resources/ledger/sheet.js): new ledgers, files, the screen of
 * v1.1.0. Row positions are optional; rows without one keep their order in the list.
 */
export const ledgerDocRowSchema = z.looseObject({ id: rowId, p: pos.optional(), c: cells })
export const ledgerDocSchema = ledgerHeadSchema.extend({
  rows: z.array(ledgerDocRowSchema).max(20_000, '한 번에 20,000행까지 보낼 수 있습니다.')
})
export type LedgerDoc = z.infer<typeof ledgerDocSchema>

/**
 * What one save carries. Cells are compare-and-set: `was` is the value this editor saw
 * (null: empty); a row whose cell holds something else by now is refused, the rest is saved.
 */
export const ledgerChangeSchema = z.object({
  /** new head and the head revision it was made on */
  head: z.object({ value: ledgerHeadSchema, rev: z.number().int() }).optional(),
  add: z.array(ledgerRowSchema).max(LEDGER_CHUNK).default([]),
  set: z.array(z.object({ id: rowId, set: cells, was: cells })).max(LEDGER_CHUNK).default([]),
  move: z.array(z.object({ id: rowId, p: pos })).max(LEDGER_CHUNK * 10).default([]),
  remove: z.array(rowId).max(LEDGER_CHUNK * 10).default([]),
  /** the version this editor has; the answer carries what others changed after it */
  since: z.number().int().min(0).default(0),
  icon: z.string().max(8).optional()
})
export type LedgerChange = z.infer<typeof ledgerChangeSchema>

/** What changed after a version. full: too much or too long ago — read the ledger again. */
export interface LedgerChanges {
  version: number
  full?: boolean
  headRev: number
  head?: LedgerHead
  rows: LedgerRow[]
  gone: string[]
}

export interface LedgerRefused {
  /** somebody else changed the columns, name or note first */
  head?: boolean
  /** changed: a cell holds another value now; gone: the row was removed */
  rows: { id: string; reason: 'changed' | 'gone' }[]
}

export interface LedgerVersion {
  id: string
  version: number
  name: string
  rows: number
  /** why it was kept: edit (before a round of edits), bulk (before many rows went), restore, manual */
  reason: string
  byName: string | null
  createdAt: number
}

export const ledgerEditModeSchema = z.enum(['all', 'owner'])
export type LedgerEditMode = z.infer<typeof ledgerEditModeSchema>
const icon = z.string().max(8).default('📄')

export const ledgerCreateSchema = z.object({
  doc: ledgerDocSchema,
  scope: scopeSchema,
  editMode: ledgerEditModeSchema.default('all'),
  icon
})

/** Whole-sheet save of the v1.1.0 screen (kept so that PCs not updated yet keep working). */
export const ledgerSaveSchema = z.object({
  doc: ledgerDocSchema,
  version: z.number().int(),
  icon: icon.optional()
})

export const ledgerPatchSchema = z.object({
  scope: scopeSchema.optional(),
  editMode: ledgerEditModeSchema.optional()
})

export interface LedgerMeta {
  id: string
  name: string
  icon: string
  rows: number
  version: number
  headRev: number
  /** all: everyone who sees it edits; owner: only the creator and admins edit */
  editMode: LedgerEditMode
  scope: ScopeDto
  ownerId: string
  ownerName: string
  createdAt: number
  updatedAt: number
  updatedById: string | null
  updatedByName: string | null
  canEdit: boolean
  /** may change the audience, the edit mode, or delete */
  canManage: boolean
  /** somebody else changed it since I last opened it (or I never opened it) */
  unseen: boolean
  deletedAt?: number | null
  /** always null: v1.1.0 let one person edit at a time */
  lock: null
  /** set by the screen when the server PC still runs v1.1.0 (ledgers kept whole): read-only */
  oldServer?: boolean
}

/** Head and one page of rows. more: read the next page with `after` = position of the last row. */
export interface LedgerDto extends LedgerMeta {
  doc: LedgerHead & { rows: LedgerRow[] }
  more: boolean
}

export interface LedgerSaveResult {
  meta: LedgerMeta
  changes: LedgerChanges
  refused: LedgerRefused
}

export interface LedgerChangedPayload {
  id: string
  version?: number
  byId?: string
  deleted?: boolean
  /** who saved (with `version`) or shared (with `shared`) */
  byName?: string
  /** sent to people who can see the ledger from now on (new ledger, audience changed) */
  shared?: boolean
  name?: string
}

// ---------- personal ledgers (local DB of this PC) ----------
export interface LocalLedgerMeta {
  id: string
  name: string
  icon: string
  rows: number
  version: number
  headRev: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}
export interface LocalLedgerDto extends LocalLedgerMeta {
  doc: LedgerHead & { rows: LedgerRow[] }
  more: boolean
}

// ---------- save as (다른 이름으로 저장) ----------
export const LEDGER_EXPORT_FORMATS = ['xlsx', 'xls', 'csv', 'db', 'json'] as const
export type LedgerExportFormat = (typeof LEDGER_EXPORT_FORMATS)[number]
/** One exported value: text, number, boolean, or a date as 'YYYY-MM-DD' in a date column. */
export type LedgerExportCell = string | number | boolean | null
export interface LedgerExportColumn {
  name: string
  /** text | number | date | check */
  kind: 'text' | 'number' | 'date' | 'check'
  /** Excel number format, e.g. '#,##0' */
  format?: string
  width?: number
}
