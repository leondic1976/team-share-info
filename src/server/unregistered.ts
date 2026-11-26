/**
 * 미등록 인원 (지시 134): one list of the staff who do not use TeamHub, kept in the server DB
 * (unregistered_people) by the server PC and the 서무. 식사 신청 reads it through the plugin
 * bridge, 긴급구조지휘대 through its host (command-host.ts).
 *
 * Taking over what was kept elsewhere before (safe to run any number of times):
 *  - importMealPeople: the 식사 신청 plugin's own list (its settings room) - same ids, so the
 *    plugin's old records still name the same person;
 *  - addUnregistered with a `key`: the command post's 임시 인원 (command.db cmd_people), moved
 *    by the command module itself (routes.ts moveOldTemps).
 */
import { randomBytes } from 'node:crypto'
import type { Db } from '../node/sqlite'
import { recordError, type ServerContext } from './context'
import { mealPeople } from './meal-people'
import { UNREG_LIMITS, isUnregisteredId, unregLine, type UnregisteredDto, type UnregisteredInput } from '../shared/schemas/unregistered'

interface Row {
  id: string
  name: string
  dept: string
  title: string
  memo: string
  merged_into: string | null
  deleted_at: number | null
  created_by: string
  created_at: number
  updated_at: number
}
const NAME = "CASE WHEN IFNULL(LENGTH(m.nickname), 0) = 0 THEN m.name ELSE m.name || char(40) || m.nickname || char(41) END"

/** Everybody ever on the list (also those deleted or merged), by name. */
export function listUnregistered(db: Db): UnregisteredDto[] {
  return db
    .all<Row & { merged_name: string | null; creator_name: string | null }>(
      `SELECT u.*, (SELECT ${NAME} FROM members m WHERE m.id = u.merged_into) AS merged_name, (SELECT ${NAME} FROM members m WHERE m.id = u.created_by) AS creator_name FROM unregistered_people u ORDER BY u.name, u.id`
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      dept: r.dept,
      title: r.title,
      memo: r.memo,
      mergedInto: r.merged_into,
      mergedIntoName: r.merged_name,
      deleted: r.deleted_at !== null,
      createdBy: r.created_by,
      createdByName: r.creator_name ?? '',
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }))
}

export const getUnregistered = (db: Db, id: string): UnregisteredDto | undefined => listUnregistered(db).find((p) => p.id === id)

/** How many are on the list now (not deleted, not merged). */
export const listedCount = (db: Db): number => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM unregistered_people WHERE deleted_at IS NULL AND merged_into IS NULL')?.n ?? 0

const newUnregId = (): string => `x:${randomBytes(8).toString('hex')}`
/** The id that a key always gives (a retried move does not register the same person twice). */
export const keyedUnregId = (key: string): string => {
  const id = `x:${key.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24)}`
  return isUnregisteredId(id) ? id : newUnregId()
}

/**
 * Registers somebody. With `key`, the id comes from the key and an existing one is kept as it
 * is ({ id, existed: true }). Over the limit: { error }.
 */
export function addUnregistered(db: Db, input: UnregisteredInput, by: string, opts: { key?: string; at?: number } = {}): { id: string; existed?: boolean } | { error: string } {
  const id = opts.key ? keyedUnregId(opts.key) : newUnregId()
  if (db.get('SELECT 1 FROM unregistered_people WHERE id = ?', [id])) return { id, existed: true }
  const name = unregLine(input.name, UNREG_LIMITS.name)
  if (!name) return { error: '이름을 적으세요.' }
  // a move from elsewhere (key) is not held to the limit: nobody is lost
  if (!opts.key && listedCount(db) >= UNREG_LIMITS.max) return { error: `미등록 인원은 ${UNREG_LIMITS.max}명까지 등록할 수 있습니다.` }
  const t = opts.at ?? Date.now()
  db.run('INSERT INTO unregistered_people (id, name, dept, title, memo, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    id,
    name,
    unregLine(input.dept, UNREG_LIMITS.dept),
    unregLine(input.title, UNREG_LIMITS.title),
    unregLine(input.memo, UNREG_LIMITS.memo),
    by,
    t,
    by,
    t
  ])
  return { id }
}

/**
 * Takes over the 식사 신청 plugin's own list (before 1.8.0): every person not here yet is added
 * with the plugin's id, name, 부서, 직위, 메모, who registered them and when, and whether they
 * were deleted or merged into a member there. Somebody already here is left as the list says
 * (what the 서무 changed since wins). The count limit does not apply: nobody is lost.
 * Returns how many were added.
 */
export function importMealPeople(db: Db): number {
  const people = mealPeople(db)
  if (!people.length) return 0
  const members = new Set(db.all<{ id: string }>('SELECT id FROM members').map((m) => m.id))
  let added = 0
  db.tx(() => {
    for (const p of people) {
      if (!isUnregisteredId(p.id) || db.get('SELECT 1 FROM unregistered_people WHERE id = ?', [p.id])) continue
      const as = p.as && members.has(p.as) ? p.as : null
      db.run('INSERT INTO unregistered_people (id, name, dept, title, memo, merged_into, deleted_at, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        p.id,
        p.name,
        unregLine(p.dept, UNREG_LIMITS.dept),
        unregLine(p.title, UNREG_LIMITS.title),
        unregLine(p.memo, UNREG_LIMITS.memo),
        as,
        p.gone ? p.at : null,
        p.by,
        p.at,
        p.by,
        p.at
      ])
      added++
    }
  })
  return added
}

// ---------- who wants to hear about changes (the command module, through its host) ----------
const listeners = new WeakMap<ServerContext, Set<() => void>>()
export function onUnregisteredChange(ctx: ServerContext, cb: () => void): () => void {
  let set = listeners.get(ctx)
  if (!set) listeners.set(ctx, (set = new Set()))
  set.add(cb)
  return () => set.delete(cb)
}
/** The list changed: the screens refresh (realtime) and the listeners hear it. */
export function unregisteredChanged(ctx: ServerContext): void {
  ctx.hub.broadcast('unregistered.changed', {})
  for (const cb of listeners.get(ctx) ?? []) {
    try {
      cb()
    } catch (e) {
      recordError(ctx, `unregistered listener: ${(e as Error).message}`)
    }
  }
}

/** Takes over the plugin's old list and tells everybody when somebody was added. */
export function runMealImport(ctx: ServerContext): number {
  const n = importMealPeople(ctx.db)
  if (n) unregisteredChanged(ctx)
  return n
}
