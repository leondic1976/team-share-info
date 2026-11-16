import { z } from 'zod'
import { scopeSchema, type ScopeDto } from './scope'

// ---------- team ledgers (관리대장 · 팀 대장) ----------
/** Longest JSON text of one ledger (characters); the client stops at the same size. */
export const LEDGER_DOC_MAX = 500 * 1024
/** An edit lock nobody refreshed for this long is free again (the editor closed the app, lost the network…). */
export const LEDGER_LOCK_MS = 90_000

const cell = z.union([z.string().max(20_000), z.number(), z.boolean(), z.null()])

/**
 * The sheet as the ledger screen keeps it (resources/ledger/sheet.js). The server stores it
 * whole; it checks the shape and size but does not interpret formulas.
 */
export const ledgerDocSchema = z.looseObject({
  name: z.string().trim().min(1, '대장 이름을 넣으세요').max(60),
  note: z.string().max(2000).optional(),
  cols: z
    .array(z.looseObject({ id: z.string().min(1).max(40), name: z.string().min(1).max(60), type: z.string().min(1).max(20) }))
    .max(200, '열이 너무 많습니다(200개까지).'),
  rows: z.array(z.looseObject({ id: z.string().min(1).max(40), c: z.record(z.string().max(40), cell) })).max(20_000, '행이 너무 많습니다(20,000행까지).')
})
export type LedgerDoc = z.infer<typeof ledgerDocSchema>

export const ledgerEditModeSchema = z.enum(['all', 'owner'])
export type LedgerEditMode = z.infer<typeof ledgerEditModeSchema>
const icon = z.string().max(8).default('📄')

export const ledgerCreateSchema = z.object({
  doc: ledgerDocSchema,
  scope: scopeSchema,
  editMode: ledgerEditModeSchema.default('all'),
  icon
})

export const ledgerSaveSchema = z.object({
  doc: ledgerDocSchema,
  /** The version this edit was made on; the save is refused when the ledger moved on. */
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
  /** all: everyone who sees it edits; owner: only the creator and admins edit */
  editMode: LedgerEditMode
  scope: ScopeDto
  ownerId: string
  ownerName: string
  createdAt: number
  updatedAt: number
  updatedByName: string | null
  /** may edit at all (the lock decides who edits right now) */
  canEdit: boolean
  /** may change the audience, the edit mode, or delete */
  canManage: boolean
  /** who is editing now; null when free */
  lock: { memberId: string; name: string; mine: boolean } | null
}

export interface LedgerDto extends LedgerMeta {
  doc: LedgerDoc
}

export interface LedgerChangedPayload {
  id: string
  version?: number
  deleted?: boolean
}
