import { onDay, type DutyEntryDto, type DutyMemberDto } from './schemas/duty'
import type { DutySection } from './dutySections'

/**
 * One day of 근무현황 in numbers: who is away (사고) and why. Shared by the daily view, its
 * printed report and the home widget "오늘 부재자", so all three count the same way.
 */
export interface DutyDayStat<M = DutyMemberDto> {
  total: number
  /** people with at least one entry that day (counted once) */
  away: M[]
  /** reason -> people with that reason; someone with two reasons that day is under each */
  byType: Map<string, { m: M; e: DutyEntryDto }[]>
}

export const DAY_MS = 86400000

/** Entries by member, in the server's order (by start). */
export function entriesByMember(entries: DutyEntryDto[]): Map<string, DutyEntryDto[]> {
  const m = new Map<string, DutyEntryDto[]>()
  for (const e of entries) m.set(e.memberId, [...(m.get(e.memberId) ?? []), e])
  return m
}

export function awayOn(byMember: Map<string, DutyEntryDto[]>, memberId: string, dayStart: number, dayEnd = dayStart + DAY_MS): DutyEntryDto[] {
  return (byMember.get(memberId) ?? []).filter((e) => onDay(e, dayStart, dayEnd))
}

export function dutyDayStat<M extends { id: string }>(members: M[], byMember: Map<string, DutyEntryDto[]>, dayStart: number, dayEnd = dayStart + DAY_MS): DutyDayStat<M> {
  const byType = new Map<string, { m: M; e: DutyEntryDto }[]>()
  const away: M[] = []
  for (const m of members) {
    const es = awayOn(byMember, m.id, dayStart, dayEnd)
    if (!es.length) continue
    away.push(m)
    for (const e of es) byType.set(e.type, [...(byType.get(e.type) ?? []), { m, e }])
  }
  return { total: members.length, away, byType }
}

/** People (not entries) in a list of reasons. */
export const peopleIn = (list: { m: { id: string } }[]): number => new Set(list.map((x) => x.m.id)).size

/** One line of the 인원 총괄표. */
export interface DutyTotalRow<M = DutyMemberDto> {
  key: string
  section: DutySection<M>
  depth: number
  /** a 소속 with departments below it: everyone under it (소계) */
  subtotal: boolean
  /** the people of a 소속 itself, next to the departments below it (직속) */
  own: boolean
  total: number
  present: number
  away: number
  /** reason -> people */
  byType: Record<string, number>
}

/**
 * The 인원 총괄표 of a day: the reasons seen that day (in the order first met), the 계 line,
 * and one line per 소속 (with a 직속 line under a 소속 that has departments and people of its own),
 * so the lines below a 소계 add up to it.
 */
export function dutyTotals<M extends { id: string }>(
  sections: DutySection<M>[],
  byMember: Map<string, DutyEntryDto[]>,
  dayStart: number
): { types: string[]; all: Omit<DutyTotalRow<M>, 'section' | 'key' | 'depth' | 'subtotal' | 'own'>; rows: DutyTotalRow<M>[] } {
  const all = dutyDayStat(
    sections.flatMap((s) => s.members),
    byMember,
    dayStart
  )
  const types = [...all.byType.keys()]
  const line = (st: DutyDayStat<M>): { total: number; present: number; away: number; byType: Record<string, number> } => ({
    total: st.total,
    present: st.total - st.away.length,
    away: st.away.length,
    byType: Object.fromEntries(types.map((t) => [t, peopleIn(st.byType.get(t) ?? [])]))
  })
  const rows: DutyTotalRow<M>[] = []
  for (const s of sections) {
    const id = s.dept?.id ?? 'none'
    rows.push({ key: id, section: s, depth: s.depth, subtotal: s.childCount > 0, own: false, ...line(dutyDayStat(s.all, byMember, dayStart)) })
    if (s.childCount > 0 && s.members.length > 0) rows.push({ key: `${id}:own`, section: s, depth: s.depth + 1, subtotal: false, own: true, ...line(dutyDayStat(s.members, byMember, dayStart)) })
  }
  return { types, all: line(all), rows }
}

/** One person away on the day, with every entry of theirs that touches it. */
export interface DutyAbsentee<M = DutyMemberDto> {
  m: M
  entries: DutyEntryDto[]
}

/**
 * The people away on a day, by 소속 in the order of the org chart (a 소속's own people under
 * its own heading); departments with nobody away are left out. Used by the printed report and
 * by the home widget "오늘 부재자".
 */
export function dutyAbsentGroups<M extends { id: string }>(
  sections: DutySection<M>[],
  byMember: Map<string, DutyEntryDto[]>,
  dayStart: number
): { section: DutySection<M>; people: DutyAbsentee<M>[] }[] {
  const out: { section: DutySection<M>; people: DutyAbsentee<M>[] }[] = []
  for (const s of sections) {
    const people = s.members.map((m) => ({ m, entries: awayOn(byMember, m.id, dayStart) })).filter((x) => x.entries.length)
    if (people.length) out.push({ section: s, people })
  }
  return out
}
