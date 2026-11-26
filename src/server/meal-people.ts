/**
 * 식사 신청 (plugin id 'meal') before 1.8.0 kept its own list of people registered by hand
 * (staff who do not use TeamHub). Since 지시 134 there is one list for the whole program (미등록
 * 인원, unregistered.ts); this reads the plugin's old list on the server so it can be taken over.
 *
 * The plugin's settings room (the oldest 'meal' room whose shared data is meal settings) holds
 * the list in `shared.people` (written by the owner) and in the entries of the 식수서무 named in
 * the shared data (`entry.people`); the newest record of each person wins. This mirrors meal.js
 * effective() and cleanPeople() (tests/plugins/meal.test.ts compares the two).
 *
 * Only a team-wide room is read (the plugin makes no other kind).
 */
import type { Db } from '../node/sqlite'
import { parseJson } from '../node/sqlite'

export const MEAL_PLUGIN_ID = 'meal'

/** One person of the list: `gone` = deleted there, `as` = merged there into that member. */
export interface MealPerson {
  id: string
  name: string
  dept: string
  title: string
  memo: string
  at: number
  /** who wrote the newest record (the room's owner when it does not say) */
  by: string
  gone?: boolean
  as?: string
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const isId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 40
const isManualId = (x: unknown): x is string => typeof x === 'string' && /^x:[a-z0-9]{6,24}$/.test(x)
const line = (v: unknown, max: number): string =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim()
// meal.js LIMITS: personName, personDept, personTitle, personMemo
const MAX = { name: 30, dept: 30, title: 20, memo: 60 }
const STEWARDS_MAX = 2

/** meal.js cleanPeople(): { 'x:…': person } without the records that are not usable. */
export function cleanMealPeople(src: unknown): Record<string, MealPerson> {
  const out: Record<string, MealPerson> = {}
  if (!isObj(src)) return out
  for (const id of Object.keys(src)) {
    const r = src[id]
    if (!isManualId(id) || !isObj(r) || !(Number(r.at) > 0)) continue
    const p: MealPerson = { id, name: line(r.name, MAX.name), dept: line(r.dept, MAX.dept), title: line(r.title, MAX.title), memo: line(r.memo, MAX.memo), at: Number(r.at), by: isId(r.by) ? r.by : '' }
    if (!p.name) continue
    if (r.gone) p.gone = true
    if (isId(r.as) && !isManualId(r.as)) p.as = r.as
    out[id] = p
  }
  return out
}

export interface MealRoom {
  createdBy: string
  shared: unknown
  entries: Record<string, { value: unknown; at: number }>
}

/** meal.js effective(room).people: the shared list merged with what the 식수서무 wrote. */
export function mealPeopleOf(room: MealRoom): Record<string, MealPerson> {
  const shared = isObj(room.shared) ? room.shared : {}
  const owner = room.createdBy
  const stewards = Array.from(new Set((Array.isArray(shared.stewards) ? shared.stewards : []).filter(isId)))
    .slice(0, STEWARDS_MAX)
    .filter((id) => id !== owner)
  const since = isObj(shared.since) ? shared.since : {}
  const people = cleanMealPeople(shared.people)
  for (const pid of Object.keys(people)) if (!people[pid].by) people[pid].by = owner
  for (const id of stewards) {
    const e = room.entries[id]
    if (!e) continue
    const v = isObj(e.value) ? e.value : {}
    const cap = Number(e.at) > 0 ? Number(e.at) : Infinity
    const from = isId(id) && Number(since[id]) > 0 ? Number(since[id]) : 0
    const mine = cleanMealPeople(v.people)
    for (const pid of Object.keys(mine)) {
      const at = Math.min(mine[pid].at, cap)
      if (at < from || (people[pid] && people[pid].at >= at)) continue
      people[pid] = { ...mine[pid], at, by: id }
    }
  }
  return people
}

const isMealSettings = (shared: unknown): boolean => isObj(shared) && shared.kind === 'meal' && !!shared.meals

/** The plugin's settings room (meal.js pickRoom(): the oldest one), team-wide rooms only; null: none. */
export function mealRoom(db: Db): MealRoom | null {
  const rows = db.all<{ id: string; created_by: string; shared: string }>("SELECT id, created_by, shared FROM plugin_rooms WHERE plugin_id = ? AND scope_type = 'team' ORDER BY created_at, rowid", [MEAL_PLUGIN_ID])
  for (const r of rows) {
    const shared = parseJson<unknown>(r.shared, {})
    if (!isMealSettings(shared)) continue
    // only the entries of the 식수서무 named there can hold people
    const stewards = (isObj(shared) && Array.isArray(shared.stewards) ? shared.stewards : []).filter(isId).slice(0, 10)
    const entries = stewards.length
      ? Object.fromEntries(
          db
            .all<{ member_id: string; value: string; at: number }>(`SELECT member_id, value, at FROM plugin_entries WHERE room_id = ? AND member_id IN (${stewards.map(() => '?').join(',')})`, [r.id, ...stewards])
            .map((e) => [e.member_id, { value: parseJson<unknown>(e.value, null), at: e.at }])
        )
      : {}
    return { createdBy: r.created_by, shared, entries }
  }
  return null
}

/** Everybody on the list (also those deleted or merged there), by name. Empty without the plugin's room. */
export function mealPeople(db: Db): MealPerson[] {
  const room = mealRoom(db)
  if (!room) return []
  return Object.values(mealPeopleOf(room)).sort((a, b) => a.name.localeCompare(b.name, 'ko') || (a.id < b.id ? -1 : 1))
}
