/**
 * Rules the server enforces on plugin room entries (지시 125-⑧).
 *
 * A plugin room is generic: the server keeps the shared data and one entry per member and
 * does not know the plugin's rules. Some built-in plugins need one rule the client alone
 * cannot keep (an old or changed client could break it), so a plugin id may register an
 * entry guard here: given the room as it will be after the write, the entry before and after
 * and the server's clock, it says why the write is refused ('' = allowed).
 *
 * 식사 신청 (meal): a request for a meal of a day cannot be made, changed or taken out once
 * the deadline of that meal has passed by the server's clock - also not one made for somebody
 * else (대신 신청·취소). Everything else in an entry (settings, menus and people of those in
 * charge) stays free, so what managers may do after a deadline is untouched. The deadlines are
 * read the way the plugin reads them (meal.js effective(): the owner's shared data and the
 * newest settings of a 식수서무 named there).
 */

export interface GuardRoom {
  createdBy: string
  shared: unknown
  /** every entry as it will be after the write (the writer's with `at` = now) */
  entries: Record<string, { value: unknown; at: number }>
}
export type EntryGuard = (room: GuardRoom, memberId: string, before: unknown, after: unknown, now: number) => string

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const isId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 40
const isYmd = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s)
const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const WEEK = ['일', '월', '화', '수', '목', '금', '토']

// ---------- 식사 신청 ----------
export const MEAL_KEYS = ['lunch', 'dinner'] as const
type MealKey = (typeof MEAL_KEYS)[number]
const MEAL_NAMES: Record<MealKey, string> = { lunch: '점심', dinner: '저녁' }
const DEFAULT_CUTOFF: Record<MealKey, string> = { lunch: '10:30', dinner: '15:30' }
/**
 * Records older than this many days may be dropped from an entry (the plugin keeps a member's
 * own requests 100 days and those made for others 62, then drops them).
 */
export const MEAL_LOCK_DAYS = 60
/**
 * A save near the size limit of an entry (the server refuses above 64 KB, the plugin keeps
 * below 60 000 characters) may drop old records made for others to make room (Meal.applyBulk).
 */
export const MEAL_TRIM_FLOOR = 48000
const STEWARDS_MAX = 2

const cleanTime = (v: unknown, fallback: string): string => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim())
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return fallback
  return `${pad(Number(m[1]))}:${m[2]}`
}
const cutoffsOf = (settings: unknown): Record<MealKey, string> => {
  const meals = isObj(settings) && isObj(settings.meals) ? settings.meals : {}
  return { lunch: cleanTime(isObj(meals.lunch) ? meals.lunch.cutoff : undefined, DEFAULT_CUTOFF.lunch), dinner: cleanTime(isObj(meals.dinner) ? meals.dinner.cutoff : undefined, DEFAULT_CUTOFF.dinner) }
}

/** The deadlines that count now (null: not a meal settings room). Mirrors Meal.effective(). */
export function mealCutoffs(room: GuardRoom): Record<MealKey, string> | null {
  const shared = room.shared
  if (!isObj(shared) || shared.kind !== 'meal' || !shared.meals) return null
  let cutoffs = cutoffsOf(shared)
  let at = Number(shared.settingsAt) > 0 ? Number(shared.settingsAt) : 0
  const stewards = Array.from(new Set((Array.isArray(shared.stewards) ? shared.stewards : []).filter(isId)))
    .slice(0, STEWARDS_MAX)
    .filter((id) => id !== room.createdBy)
  const since = isObj(shared.since) ? shared.since : {}
  for (const id of stewards) {
    const e = room.entries[id]
    const v = e && isObj(e.value) ? e.value : null
    if (!v || !isObj(v.settings) || !(Number(v.settingsAt) > 0)) continue
    const cap = Number(e.at) > 0 ? Number(e.at) : Infinity
    const t = Math.min(Number(v.settingsAt), cap)
    const from = Number(since[id]) > 0 ? Number(since[id]) : 0
    if (t >= from && t > at) {
      cutoffs = cutoffsOf(v.settings)
      at = t
    }
  }
  return cutoffs
}

interface Rec {
  on: boolean
  at: number
}
/** 'own|date|meal' or 'for:<id>|date|meal' → { on, at }; the way the plugin reads an entry (cleanEntry). */
function mealRecords(value: unknown): { recs: Map<string, Rec>; names: Map<string, string> } {
  const recs = new Map<string, Rec>()
  const names = new Map<string, string>()
  const read = (days: unknown, scope: string): void => {
    if (!isObj(days)) return
    for (const date of Object.keys(days)) {
      if (!isYmd(date) || !isObj(days[date])) continue
      for (const k of MEAL_KEYS) {
        const r = (days[date] as Obj)[k] as Obj | null | undefined
        // `firm` (확실히 신청안함) is left out: setting or clearing it always writes a new time,
        // and a client older than 1.6.0 drops it when it saves
        if (r && typeof r === 'object') recs.set(`${scope}|${date}|${k}`, { on: !!r.on, at: Number(r.at) || 0 })
      }
    }
  }
  if (!isObj(value)) return { recs, names }
  read(value.days, 'own')
  if (isObj(value.for)) {
    for (const id of Object.keys(value.for)) {
      const t = value.for[id]
      if (id.length > 40 || !isObj(t)) continue
      read(t.days, `for:${id}`)
      names.set(id, String(t.name ?? '').slice(0, 60))
    }
  }
  return { recs, names }
}

const cutoffAt = (date: string, hm: string): number => {
  const [y, m, d] = date.split('-').map(Number)
  const [h, mi] = hm.split(':').map(Number)
  return new Date(y, m - 1, d, h, mi).getTime()
}
const label = (date: string): string => {
  const [y, m, d] = date.split('-').map(Number)
  return `${m}/${d}(${WEEK[new Date(y, m - 1, d).getDay()]})`
}

/**
 * 식사 신청: a member's write that adds, changes or drops a request whose deadline has passed is
 * refused. Allowed: records older than MEAL_LOCK_DAYS (the plugin drops them), and old records
 * made for others dropped by a save near the size limit (MEAL_TRIM_FLOOR).
 */
export const mealEntryGuard: EntryGuard = (room, _memberId, before, after, now) => {
  const cutoffs = mealCutoffs(room)
  if (!cutoffs) return ''
  const a = mealRecords(after)
  const b = mealRecords(before)
  const oldest = ymd(now - MEAL_LOCK_DAYS * 86400000)
  const trimming = JSON.stringify(after ?? null).length >= MEAL_TRIM_FLOOR
  const keys = new Set([...a.recs.keys(), ...b.recs.keys()])
  for (const key of [...keys].sort()) {
    const [scope, date, meal] = key.split('|') as [string, string, MealKey]
    const x = b.recs.get(key)
    const y = a.recs.get(key)
    if (x && y && x.on === y.on && x.at === y.at) continue
    if (now < cutoffAt(date, cutoffs[meal])) continue
    // dropped, not changed: the plugin's own clean-up of old days
    if (x && !y && (date < oldest || (trimming && scope !== 'own'))) continue
    const id = scope.startsWith('for:') ? scope.slice(4) : ''
    const name = id ? a.names.get(id) || b.names.get(id) || '' : ''
    return `${id ? `${name ? `${name} 님의 ` : '다른 사람의 '}` : ''}${label(date)} ${MEAL_NAMES[meal]}은 마감 시각(${cutoffs[meal]})이 지나 바꿀 수 없습니다.`
  }
  return ''
}

const GUARDS: Record<string, EntryGuard> = { meal: mealEntryGuard }

/** Why the server refuses this entry write of a plugin room ('' = allowed). */
export function entryRefusal(pluginId: string, room: GuardRoom, memberId: string, before: unknown, after: unknown, now: number): string {
  const guard = GUARDS[pluginId]
  return guard ? guard(room, memberId, before, after, now) : ''
}
