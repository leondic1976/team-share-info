import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { newId, parseJson } from '../../node/sqlite'
import { LedgerError, LedgerStore, headOf } from '../../node/ledger-store'
import {
  LEDGER_CHUNK,
  LEDGER_SNAPSHOT_GAP_MS,
  LEDGER_TRASH_DAYS,
  ledgerChangeSchema,
  ledgerCreateSchema,
  ledgerPatchSchema,
  ledgerSaveSchema,
  type LedgerChangedPayload,
  type LedgerDto,
  type LedgerHead,
  type LedgerMeta,
  type LedgerSaveResult
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
  head: string
  row_count: number
  version: number
  head_rev: number
  edit_mode: LedgerMeta['editMode']
  scope_type: string
  created_by: string
  owner_name: string
  updated_by: string | null
  updater_name: string | null
  noted_at: number | null
  created_at: number
  updated_at: number
  deleted_at: number | null
  seen: number | null
}
type Me = { id: string; role: string; name: string }

const SELECT = `SELECT l.*, o.name AS owner_name, u.name AS updater_name, s.version AS seen FROM ledgers l
  JOIN members o ON o.id = l.created_by LEFT JOIN members u ON u.id = l.updated_by
  LEFT JOIN ledger_seen s ON s.ledger_id = l.id AND s.member_id = ?`
/** Whole-sheet requests of the v1.1.0 screen work up to this many rows. */
const LEGACY_ROWS = 20_000

/**
 * Team ledgers (관리대장 · 팀용/지정자용): rows kept one by one on the server and shared by
 * scope (13.9). Several people edit at once: a save carries only the changed cells with the
 * value the editor saw, and a cell somebody else changed meanwhile is refused (never
 * overwritten). Versions are kept for 변경 이력, deleted ledgers stay in the trash.
 */
export function registerLedgerRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db
  const store = new LedgerStore(db)

  const canEdit = (r: Row, m: Me): boolean => r.edit_mode === 'all' || r.created_by === m.id || m.role === 'admin'
  const canManage = (r: Row, m: Me): boolean => r.created_by === m.id || m.role === 'admin'

  const meta = (r: Row, m: Me): LedgerMeta => ({
    id: r.id,
    name: r.name,
    icon: r.icon,
    rows: r.row_count,
    version: r.version,
    headRev: r.head_rev,
    editMode: r.edit_mode,
    scope: scopeDto(db, 'ledger', r.id, r.scope_type),
    ownerId: r.created_by,
    ownerName: r.owner_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedById: r.updated_by,
    updatedByName: r.updater_name,
    canEdit: canEdit(r, m),
    canManage: canManage(r, m),
    unseen: r.updated_by !== m.id && r.version > (r.seen ?? 0),
    deletedAt: r.deleted_at,
    lock: null
  })
  const dto = (r: Row, m: Me, after: { p: number; id: string } | null, limit: number): LedgerDto => {
    const page = store.page(r.id, after, limit)
    return { ...meta(r, m), doc: { ...parseJson<LedgerHead>(r.head, { name: r.name, cols: [] }), rows: page.rows }, more: page.more }
  }

  const load = (req: FastifyRequest, trashed = false): Row => {
    const { id } = req.params as { id: string }
    const w = visibleWhere('l', 'ledger', req.member.id)
    const r = db.get<Row>(`${SELECT} WHERE l.id = ? AND l.deleted_at IS ${trashed ? 'NOT ' : ''}NULL AND ${w.sql}`, [req.member.id, id, ...w.params])
    if (!r) throw notFound('대장')
    return r
  }
  const reload = (id: string, m: Me): Row => db.get<Row>(`${SELECT} WHERE l.id = ?`, [m.id, id])!
  const seen = (r: Row, m: Me, version = r.version): void => {
    if ((r.seen ?? 0) < version) db.run('INSERT INTO ledger_seen (ledger_id, member_id, version) VALUES (?, ?, ?) ON CONFLICT(ledger_id, member_id) DO UPDATE SET version = excluded.version', [r.id, m.id, version])
  }
  const changed = (id: string, extra: Iterable<string> = [], payload: Partial<LedgerChangedPayload> = {}): void =>
    ctx.hub.sendTo([...audienceOf(db, 'ledgers', 'ledger', id), ...extra], 'ledger.changed', { id, ...payload } satisfies LedgerChangedPayload)
  /** Errors of the store are the user's to read. */
  const guard = <T>(fn: () => T): T => {
    try {
      return fn()
    } catch (e) {
      if (e instanceof LedgerError) throw badRequest(e.message)
      throw e
    }
  }
  const actor = (m: Me): { id: string; name: string } => ({ id: m.id, name: m.name })
  /** "누가 언제 고쳤는지" in the activity log: once per round of edits, not once per keystroke. */
  const noteEdit = (req: FastifyRequest, r: Row, t: number): void => {
    if (r.updated_by === req.member.id && r.noted_at && t - r.noted_at < LEDGER_SNAPSHOT_GAP_MS) return
    db.run('UPDATE ledgers SET noted_at = ? WHERE id = ?', [t, r.id])
    logActivity(ctx, req, 'ledger.edit', { type: 'ledger', id: r.id }, { name: r.name })
  }

  app.get('/api/ledgers', auth, async (req) => {
    const w = visibleWhere('l', 'ledger', req.member.id)
    const rows = db.all<Row>(`${SELECT} WHERE l.deleted_at IS NULL AND ${w.sql} ORDER BY l.updated_at DESC LIMIT 500`, [req.member.id, ...w.params])
    return ok(rows.map((r) => meta(r, req.member)))
  })

  /** Deleted ledgers I may bring back: my own, or all of them for an admin. */
  app.get('/api/ledgers/trash', auth, async (req) => {
    const old = db.all<{ id: string }>('SELECT id FROM ledgers WHERE deleted_at IS NOT NULL AND deleted_at < ?', [Date.now() - LEDGER_TRASH_DAYS * 24 * 3600_000])
    for (const x of old) {
      db.run("DELETE FROM scope_targets WHERE item_type = 'ledger' AND item_id = ?", [x.id])
      db.run('DELETE FROM ledger_seen WHERE ledger_id = ?', [x.id])
      store.destroy(x.id)
    }
    const rows = db.all<Row>(`${SELECT} WHERE l.deleted_at IS NOT NULL ${req.member.role === 'admin' ? '' : 'AND l.created_by = ?'} ORDER BY l.deleted_at DESC LIMIT 200`, req.member.role === 'admin' ? [req.member.id] : [req.member.id, req.member.id])
    return ok(rows.map((r) => meta(r, req.member)))
  })

  /** Head and a page of rows. Without `limit` (the v1.1.0 screen): every row at once. */
  app.get('/api/ledgers/:id', auth, async (req) => {
    const r = load(req)
    const q = req.query as { limit?: string; p?: string; after?: string }
    if (!q.limit && r.row_count > LEGACY_ROWS) throw conflict('이 대장은 프로그램을 업데이트해야 열 수 있습니다.')
    const limit = q.limit ? Math.max(1, Math.min(LEDGER_CHUNK * 5, Number(q.limit) || LEDGER_CHUNK)) : LEGACY_ROWS
    const after = q.after && q.p !== undefined && Number.isFinite(Number(q.p)) ? { p: Number(q.p), id: q.after } : null
    if (!after) seen(r, req.member)
    return ok(dto(r, req.member, after, limit))
  })

  app.get('/api/ledgers/:id/changes', auth, async (req) => {
    const r = load(req)
    seen(r, req.member)
    return ok(store.changes(r.id, Math.max(0, Number((req.query as { since?: string }).since) || 0)))
  })

  app.post('/api/ledgers', auth, async (req) => {
    const input = parse(ledgerCreateSchema, req.body)
    const id = newId()
    const t = Date.now()
    guard(() =>
      db.tx(() => {
        db.run(
          `INSERT INTO ledgers (id, name, icon, doc, head, row_count, edit_mode, scope_type, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, '', ?, 0, ?, ?, ?, ?, ?, ?)`,
          [id, input.doc.name, input.icon, JSON.stringify(headOf(input.doc)), input.editMode, input.scope.type, req.member.id, req.member.id, t, t]
        )
        store.fill(id, input.doc.rows)
        setScope(db, 'ledger', id, input.scope, req.member)
      })
    )
    logActivity(ctx, req, 'ledger.create', { type: 'ledger', id }, { name: input.doc.name })
    const n = reload(id, req.member)
    seen(n, req.member)
    const others = [...audienceOf(db, 'ledgers', 'ledger', id)].filter((m) => m !== req.member.id)
    ctx.hub.sendTo([req.member.id], 'ledger.changed', { id } satisfies LedgerChangedPayload)
    ctx.hub.sendTo(others, 'ledger.changed', { id, shared: true, name: n.name, byName: req.member.name, byId: req.member.id } satisfies LedgerChangedPayload)
    return ok(dto(n, req.member, null, LEDGER_CHUNK))
  })

  /** Save: changed cells, new rows, moved rows, removed rows, head. */
  app.post('/api/ledgers/:id/changes', auth, async (req) => {
    const r = load(req)
    const input = parse(ledgerChangeSchema, req.body)
    if (!canEdit(r, req.member)) throw forbidden('보기 전용 대장입니다. 만든 사람과 관리자만 고칠 수 있습니다.')
    const t = Date.now()
    const res = guard(() => store.apply(r.id, input, actor(req.member), t))
    if (res.saved) {
      db.run('UPDATE ledgers SET updated_by = ? WHERE id = ?', [req.member.id, r.id])
      noteEdit(req, r, t)
      changed(r.id, [], { version: res.version, byId: req.member.id, byName: req.member.name })
    }
    const n = reload(r.id, req.member)
    seen(n, req.member)
    return ok({ meta: meta(reload(r.id, req.member), req.member), changes: res.changes, refused: res.refused } satisfies LedgerSaveResult)
  })

  // ---------- the v1.1.0 screen: whole sheet, one editor at a time ----------
  app.put('/api/ledgers/:id', auth, async (req) => {
    const r = load(req)
    const input = parse(ledgerSaveSchema, req.body)
    if (!canEdit(r, req.member)) throw forbidden('보기 전용 대장입니다. 만든 사람과 관리자만 고칠 수 있습니다.')
    if (input.version !== r.version) throw conflict('다른 사람이 먼저 고쳤습니다. 최신 내용을 다시 불러옵니다.')
    if (r.row_count > LEGACY_ROWS) throw conflict('이 대장은 프로그램을 업데이트해야 고칠 수 있습니다.')
    const t = Date.now()
    const version = guard(() =>
      db.tx(() => {
        if (t - (r.noted_at ?? 0) > LEDGER_SNAPSHOT_GAP_MS) store.snapshot(r.id, 'edit', actor(req.member), t)
        return store.replace(r.id, input.doc, t)
      })
    )
    db.run('UPDATE ledgers SET updated_by = ?, icon = COALESCE(?, icon) WHERE id = ?', [req.member.id, input.icon ?? null, r.id])
    noteEdit(req, r, t)
    changed(r.id, [], { version, byId: req.member.id, byName: req.member.name })
    const n = reload(r.id, req.member)
    seen(n, req.member)
    return ok(meta(reload(r.id, req.member), req.member))
  })
  app.post('/api/ledgers/:id/lock', auth, async (req) => {
    const r = load(req)
    if (!canEdit(r, req.member)) throw forbidden('보기 전용 대장입니다. 만든 사람과 관리자만 고칠 수 있습니다.')
    if ((req.query as { brief?: string }).brief) return ok(meta(r, req.member))
    if (r.row_count > LEGACY_ROWS) throw conflict('이 대장은 프로그램을 업데이트해야 고칠 수 있습니다.')
    return ok(dto(r, req.member, null, LEGACY_ROWS))
  })
  app.delete('/api/ledgers/:id/lock', auth, async (req) => ok(meta(load(req), req.member)))

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
    const now = audienceOf(db, 'ledgers', 'ledger', r.id)
    const added = [...now].filter((m) => !before.has(m) && m !== req.member.id)
    ctx.hub.sendTo([...new Set([...before, ...now])].filter((m) => !added.includes(m)), 'ledger.changed', { id: r.id } satisfies LedgerChangedPayload)
    ctx.hub.sendTo(added, 'ledger.changed', { id: r.id, shared: true, name: r.name, byName: req.member.name, byId: req.member.id } satisfies LedgerChangedPayload)
    return ok(meta(reload(r.id, req.member), req.member))
  })

  // ---------- trash ----------
  app.delete('/api/ledgers/:id', auth, async (req) => {
    const r = load(req)
    if (!canManage(r, req.member)) throw forbidden('대장을 만든 사람과 관리자만 지울 수 있습니다.')
    const audience = audienceOf(db, 'ledgers', 'ledger', r.id)
    db.run('UPDATE ledgers SET deleted_at = ?, deleted_by = ? WHERE id = ?', [Date.now(), req.member.id, r.id])
    logActivity(ctx, req, 'ledger.delete', { type: 'ledger', id: r.id }, { name: r.name })
    ctx.hub.sendTo(audience, 'ledger.changed', { id: r.id, deleted: true } satisfies LedgerChangedPayload)
    return ok({ id: r.id })
  })
  app.post('/api/ledgers/:id/restore', auth, async (req) => {
    const r = load(req, true)
    if (!canManage(r, req.member)) throw forbidden('대장을 만든 사람과 관리자만 되살릴 수 있습니다.')
    db.run('UPDATE ledgers SET deleted_at = NULL, deleted_by = NULL WHERE id = ?', [r.id])
    logActivity(ctx, req, 'ledger.restore', { type: 'ledger', id: r.id }, { name: r.name })
    changed(r.id)
    return ok(meta(reload(r.id, req.member), req.member))
  })
  app.delete('/api/ledgers/:id/purge', auth, async (req) => {
    const r = load(req, true)
    if (!canManage(r, req.member)) throw forbidden('대장을 만든 사람과 관리자만 지울 수 있습니다.')
    db.tx(() => {
      db.run("DELETE FROM scope_targets WHERE item_type = 'ledger' AND item_id = ?", [r.id])
      db.run('DELETE FROM ledger_seen WHERE ledger_id = ?', [r.id])
      store.destroy(r.id)
    })
    logActivity(ctx, req, 'ledger.purge', { type: 'ledger', id: r.id }, { name: r.name })
    return ok({ id: r.id })
  })

  // ---------- versions (변경 이력) ----------
  app.get('/api/ledgers/:id/versions', auth, async (req) => ok(store.versions(load(req).id)))
  /** Keep the sheet as it is now ("지금 상태 보관"). */
  app.post('/api/ledgers/:id/versions', auth, async (req) => {
    const r = load(req)
    if (!canEdit(r, req.member)) throw forbidden('보기 전용 대장입니다.')
    store.snapshot(r.id, 'manual', actor(req.member))
    return ok(store.versions(r.id))
  })
  /** A kept version as a whole sheet (to look at it or take a copy). */
  app.get('/api/ledgers/:id/versions/:vid', auth, async (req) => {
    const r = load(req)
    return ok(guard(() => store.versionDoc(r.id, (req.params as { vid: string }).vid)))
  })
  app.post('/api/ledgers/:id/versions/:vid/restore', auth, async (req) => {
    const r = load(req)
    if (!canEdit(r, req.member)) throw forbidden('보기 전용 대장입니다. 만든 사람과 관리자만 되돌릴 수 있습니다.')
    const version = guard(() => store.restore(r.id, (req.params as { vid: string }).vid, actor(req.member)))
    db.run('UPDATE ledgers SET updated_by = ? WHERE id = ?', [req.member.id, r.id])
    logActivity(ctx, req, 'ledger.revert', { type: 'ledger', id: r.id }, { name: r.name })
    changed(r.id, [], { version, byId: req.member.id, byName: req.member.name })
    const n = reload(r.id, req.member)
    seen(n, req.member)
    return ok(meta(reload(r.id, req.member), req.member))
  })
}
