import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { newId, parseJson } from '../../node/sqlite'
import {
  LEDGER_DOC_MAX,
  LEDGER_LOCK_MS,
  ledgerCreateSchema,
  ledgerPatchSchema,
  ledgerSaveSchema,
  type LedgerChangedPayload,
  type LedgerDoc,
  type LedgerDto,
  type LedgerMeta
} from '../../shared/schemas/ledger'
import type { ServerContext } from '../context'
import { badRequest, conflict, forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { audienceOf, scopeDto, setScope, visibleWhere } from '../scope'

interface Row {
  id: string
  name: string
  icon: string
  doc: string
  row_count: number
  version: number
  edit_mode: LedgerMeta['editMode']
  scope_type: string
  lock_by: string | null
  lock_at: number | null
  locker_name: string | null
  created_by: string
  owner_name: string
  updater_name: string | null
  created_at: number
  updated_at: number
}

const SELECT = `SELECT l.*, o.name AS owner_name, u.name AS updater_name, k.name AS locker_name FROM ledgers l
  JOIN members o ON o.id = l.created_by LEFT JOIN members u ON u.id = l.updated_by LEFT JOIN members k ON k.id = l.lock_by`

/**
 * Team ledgers (관리대장 · 팀 대장): a spreadsheet-like sheet kept on the server and shared
 * by scope (13.9). One person edits at a time: the editor holds a lock that expires when
 * it is not refreshed, and every save names the version it was made on, so two people can
 * never overwrite each other.
 */
export function registerLedgerRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db

  const lockOf = (r: Row, now = Date.now()): string | null => (r.lock_by && r.lock_at !== null && now - r.lock_at < LEDGER_LOCK_MS ? r.lock_by : null)
  const canEdit = (r: Row, m: { id: string; role: string }): boolean => r.edit_mode === 'all' || r.created_by === m.id || m.role === 'admin'
  const canManage = (r: Row, m: { id: string; role: string }): boolean => r.created_by === m.id || m.role === 'admin'

  const meta = (r: Row, m: { id: string; role: string }): LedgerMeta => {
    const holder = lockOf(r)
    return {
      id: r.id,
      name: r.name,
      icon: r.icon,
      rows: r.row_count,
      version: r.version,
      editMode: r.edit_mode,
      scope: scopeDto(db, 'ledger', r.id, r.scope_type),
      ownerId: r.created_by,
      ownerName: r.owner_name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      updatedByName: r.updater_name,
      canEdit: canEdit(r, m),
      canManage: canManage(r, m),
      lock: holder ? { memberId: holder, name: r.locker_name ?? '', mine: holder === m.id } : null
    }
  }
  const full = (r: Row, m: { id: string; role: string }): LedgerDto => ({ ...meta(r, m), doc: parseJson<LedgerDoc>(r.doc, { name: r.name, cols: [], rows: [] }) })

  const load = (req: FastifyRequest): Row => {
    const { id } = req.params as { id: string }
    const w = visibleWhere('l', 'ledger', req.member.id)
    const r = db.get<Row>(`${SELECT} WHERE l.id = ? AND l.deleted_at IS NULL AND ${w.sql}`, [id, ...w.params])
    if (!r) throw notFound('대장')
    return r
  }
  const reload = (id: string): Row => db.get<Row>(`${SELECT} WHERE l.id = ?`, [id])!
  const changed = (id: string, extra: Iterable<string> = [], payload: Partial<LedgerChangedPayload> = {}): void =>
    ctx.hub.sendTo([...audienceOf(db, 'ledgers', 'ledger', id), ...extra], 'ledger.changed', { id, ...payload } satisfies LedgerChangedPayload)

  const docText = (doc: LedgerDoc): string => {
    const names = new Set<string>()
    const ids = new Set<string>()
    for (const c of doc.cols) {
      if (ids.has(c.id) || names.has(c.name.toLowerCase())) throw badRequest('같은 이름의 열이 있습니다.')
      ids.add(c.id)
      names.add(c.name.toLowerCase())
    }
    const text = JSON.stringify(doc)
    if (text.length > LEDGER_DOC_MAX) throw badRequest('대장이 너무 큽니다(약 500KB). 오래된 행을 다른 대장으로 나눠 주세요.')
    return text
  }

  app.get('/api/ledgers', auth, async (req) => {
    const w = visibleWhere('l', 'ledger', req.member.id)
    const rows = db.all<Row>(`${SELECT} WHERE l.deleted_at IS NULL AND ${w.sql} ORDER BY l.updated_at DESC LIMIT 500`, w.params)
    return ok(rows.map((r) => meta(r, req.member)))
  })

  app.get('/api/ledgers/:id', auth, async (req) => ok(full(load(req), req.member)))

  app.post('/api/ledgers', auth, async (req) => {
    const input = parse(ledgerCreateSchema, req.body)
    const text = docText(input.doc)
    const id = newId()
    const t = Date.now()
    db.tx(() => {
      db.run(
        `INSERT INTO ledgers (id, name, icon, doc, row_count, edit_mode, scope_type, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.doc.name, input.icon, text, input.doc.rows.length, input.editMode, input.scope.type, req.member.id, req.member.id, t, t]
      )
      setScope(db, 'ledger', id, input.scope, req.member)
    })
    logActivity(ctx, req, 'ledger.create', { type: 'ledger', id }, { name: input.doc.name })
    changed(id)
    return ok(full(reload(id), req.member))
  })

  /** Start (or keep) editing. Answers with the whole ledger so the editor starts from the newest version. */
  app.post('/api/ledgers/:id/lock', auth, async (req) => {
    const r = load(req)
    if (!canEdit(r, req.member)) throw forbidden('보기 전용 대장입니다. 만든 사람과 관리자만 고칠 수 있습니다.')
    const holder = lockOf(r)
    if (holder && holder !== req.member.id) throw conflict(`${r.locker_name ?? '다른 사람'}님이 편집 중입니다. 끝나면 고칠 수 있습니다.`)
    db.run('UPDATE ledgers SET lock_by = ?, lock_at = ? WHERE id = ?', [req.member.id, Date.now(), r.id])
    if (holder !== req.member.id) changed(r.id)
    // ?brief=1: the editor only keeps the lock alive and does not need the sheet again
    const n = reload(r.id)
    return ok((req.query as { brief?: string }).brief ? meta(n, req.member) : full(n, req.member))
  })

  app.delete('/api/ledgers/:id/lock', auth, async (req) => {
    const r = load(req)
    if (r.lock_by === req.member.id) {
      db.run('UPDATE ledgers SET lock_by = NULL, lock_at = NULL WHERE id = ?', [r.id])
      changed(r.id)
    }
    return ok(meta(reload(r.id), req.member))
  })

  app.put('/api/ledgers/:id', auth, async (req) => {
    const r = load(req)
    const input = parse(ledgerSaveSchema, req.body)
    if (!canEdit(r, req.member)) throw forbidden('보기 전용 대장입니다. 만든 사람과 관리자만 고칠 수 있습니다.')
    const holder = lockOf(r)
    if (holder && holder !== req.member.id) throw conflict(`${r.locker_name ?? '다른 사람'}님이 편집 중입니다. 끝나면 고칠 수 있습니다.`)
    if (input.version !== r.version) throw conflict('다른 사람이 먼저 고쳤습니다. 최신 내용을 다시 불러옵니다.')
    const text = docText(input.doc)
    const t = Date.now()
    db.run(`UPDATE ledgers SET name = ?, icon = COALESCE(?, icon), doc = ?, row_count = ?, version = version + 1, updated_by = ?, updated_at = ?, lock_by = ?, lock_at = ? WHERE id = ?`, [
      input.doc.name,
      input.icon ?? null,
      text,
      input.doc.rows.length,
      req.member.id,
      t,
      req.member.id,
      t,
      r.id
    ])
    const n = reload(r.id)
    changed(r.id, [], { version: n.version })
    return ok(meta(n, req.member))
  })

  /** Audience and edit mode: the creator and admins. */
  app.patch('/api/ledgers/:id', auth, async (req) => {
    const r = load(req)
    const p = parse(ledgerPatchSchema, req.body)
    if (!canManage(r, req.member)) throw forbidden('대장을 만든 사람과 관리자만 바꿀 수 있습니다.')
    const before = audienceOf(db, 'ledgers', 'ledger', r.id)
    db.tx(() => {
      if (p.scope) {
        db.run('UPDATE ledgers SET scope_type = ? WHERE id = ?', [p.scope.type, r.id])
        setScope(db, 'ledger', r.id, p.scope, req.member)
      }
      if (p.editMode) db.run('UPDATE ledgers SET edit_mode = ? WHERE id = ?', [p.editMode, r.id])
    })
    logActivity(ctx, req, 'ledger.update', { type: 'ledger', id: r.id }, { name: r.name, scope: p.scope?.type, editMode: p.editMode })
    changed(r.id, before)
    return ok(meta(reload(r.id), req.member))
  })

  app.delete('/api/ledgers/:id', auth, async (req) => {
    const r = load(req)
    if (!canManage(r, req.member)) throw forbidden('대장을 만든 사람과 관리자만 지울 수 있습니다.')
    const holder = lockOf(r)
    if (holder && holder !== req.member.id) throw conflict(`${r.locker_name ?? '다른 사람'}님이 편집 중이라 지울 수 없습니다.`)
    const audience = audienceOf(db, 'ledgers', 'ledger', r.id)
    db.run('UPDATE ledgers SET deleted_at = ?, lock_by = NULL, lock_at = NULL WHERE id = ?', [Date.now(), r.id])
    logActivity(ctx, req, 'ledger.delete', { type: 'ledger', id: r.id }, { name: r.name })
    ctx.hub.sendTo(audience, 'ledger.changed', { id: r.id, deleted: true } satisfies LedgerChangedPayload)
    return ok({ id: r.id })
  })
}
