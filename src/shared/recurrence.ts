import { rrulestr, RRule } from 'rrule'

/**
 * Recurrence expansion shared by server (team events), main (personal reminders)
 * and renderer (personal events). Times are UTC epoch ms; recurrence follows the
 * local wall clock (a 09:00 weekly meeting stays at 09:00 across DST changes).
 */

export interface RecurringLike {
  startAt: number
  endAt: number
  allDay: boolean
  rrule: string | null
  exdates: number[]
}

export interface Occurrence {
  /** start of this occurrence (UTC ms) */
  start: number
  end: number
  /** original start, used as the occurrence key for exceptions */
  key: number
}

const offsetAt = (ms: number): number => new Date(ms).getTimezoneOffset() * 60000

/** Local wall clock -> "floating" UTC date that rrule can iterate on. */
const toFloating = (ms: number): Date => new Date(ms - offsetAt(ms))
/** Floating UTC date -> real UTC ms for the local wall clock it represents. */
const fromFloating = (d: Date): number => {
  const guess = d.getTime() + offsetAt(d.getTime())
  return d.getTime() + offsetAt(guess)
}

function parse(rule: string, startAt: number): RRule {
  const clean = rule.replace(/^RRULE:/i, '').trim()
  return rrulestr(clean, { dtstart: toFloating(startAt) }) as RRule
}

/** Occurrences overlapping [from, to). Non-recurring events return themselves if they overlap. */
export function expand(ev: RecurringLike, from: number, to: number, limit = 1000): Occurrence[] {
  const dur = Math.max(0, ev.endAt - ev.startAt)
  if (!ev.rrule) return ev.startAt < to && ev.endAt > from ? [{ start: ev.startAt, end: ev.endAt, key: ev.startAt }] : []
  const rule = parse(ev.rrule, ev.startAt)
  const ex = new Set(ev.exdates)
  const out: Occurrence[] = []
  // Include occurrences that started before `from` but are still running.
  const dates = rule.between(toFloating(from - dur - 1), toFloating(to), true)
  for (const d of dates) {
    const s = fromFloating(d)
    if (ex.has(s)) continue
    if (s < to && s + dur > from) out.push({ start: s, end: s + dur, key: s })
    if (out.length >= limit) break
  }
  return out
}

/** Set UNTIL just before `occurrenceStart` (for "this and following" edits). */
export function truncateRule(rule: string, occurrenceStart: number): string | null {
  const parts = rule
    .replace(/^RRULE:/i, '')
    .split(';')
    .filter((p) => p && !/^(UNTIL|COUNT)=/i.test(p))
  const until = new Date(toFloating(occurrenceStart - 1000).getTime())
  const fmt = until.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  parts.push(`UNTIL=${fmt}`)
  return parts.join(';')
}

/** True if the rule produces no occurrence at or after start (series fully truncated). */
export function isEmptyRule(ev: RecurringLike): boolean {
  if (!ev.rrule) return false
  return parse(ev.rrule, ev.startAt).after(toFloating(ev.startAt), true) === null
}

export type Freq = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'weekdays'

export interface SimpleRule {
  freq: Freq
  interval: number
  byWeekday: number[] // 0 = Monday .. 6 = Sunday
  end: { type: 'never' } | { type: 'until'; date: number } | { type: 'count'; count: number }
}

const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

/** Build an RRULE string from the simple editor in the UI. */
export function buildRule(r: SimpleRule): string | null {
  if (r.freq === 'none') return null
  const parts: string[] = []
  if (r.freq === 'weekdays') parts.push('FREQ=WEEKLY', 'BYDAY=MO,TU,WE,TH,FR')
  else {
    parts.push(`FREQ=${r.freq.toUpperCase()}`)
    if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`)
    if (r.freq === 'weekly' && r.byWeekday.length) parts.push(`BYDAY=${r.byWeekday.map((d) => DAY_CODES[d]).join(',')}`)
  }
  if (r.end.type === 'count') parts.push(`COUNT=${Math.max(1, r.end.count)}`)
  if (r.end.type === 'until') {
    const d = new Date(r.end.date)
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}T235959Z`
    parts.push(`UNTIL=${ymd}`)
  }
  return parts.join(';')
}

/** Parse an RRULE back into the simple editor model (best effort). */
export function parseRule(rule: string | null): SimpleRule {
  const def: SimpleRule = { freq: 'none', interval: 1, byWeekday: [], end: { type: 'never' } }
  if (!rule) return def
  const map = Object.fromEntries(
    rule
      .replace(/^RRULE:/i, '')
      .split(';')
      .map((p) => p.split('=') as [string, string])
  )
  const freq = (map.FREQ ?? '').toLowerCase() as Freq
  const byday = (map.BYDAY ?? '').split(',').filter(Boolean)
  const r: SimpleRule = { ...def, freq: ['daily', 'weekly', 'monthly', 'yearly'].includes(freq) ? freq : 'none', interval: Number(map.INTERVAL ?? 1) || 1 }
  r.byWeekday = byday.map((d) => DAY_CODES.indexOf(d)).filter((i) => i >= 0)
  if (freq === 'weekly' && byday.join(',') === 'MO,TU,WE,TH,FR' && r.interval === 1) r.freq = 'weekdays'
  if (map.COUNT) r.end = { type: 'count', count: Number(map.COUNT) }
  else if (map.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(map.UNTIL)
    if (m) r.end = { type: 'until', date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() }
  }
  return r
}

export function describeRule(rule: string | null): string {
  const r = parseRule(rule)
  const n = r.interval > 1 ? `${r.interval}` : ''
  const days = ['월', '화', '수', '목', '금', '토', '일']
  let s = ''
  switch (r.freq) {
    case 'none':
      return '반복 안 함'
    case 'daily':
      s = n ? `${n}일마다` : '매일'
      break
    case 'weekdays':
      s = '평일 매일'
      break
    case 'weekly':
      s = `${n ? `${n}주마다` : '매주'}${r.byWeekday.length ? ' ' + r.byWeekday.map((d) => days[d]).join('·') : ''}`
      break
    case 'monthly':
      s = n ? `${n}개월마다` : '매월'
      break
    case 'yearly':
      s = n ? `${n}년마다` : '매년'
      break
  }
  if (r.end.type === 'count') s += `, ${r.end.count}회`
  if (r.end.type === 'until') {
    const d = new Date(r.end.date)
    s += `, ${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}까지`
  }
  return s
}
