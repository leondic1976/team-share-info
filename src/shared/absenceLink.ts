import type { EventOccurrenceDto } from './schemas/events'
import type { PersonalOccurrenceDto } from './schemas/personal'

/**
 * 근무현황 사고 and the personal schedule (instruction 145). My 사고 shows in my personal
 * schedule without being copied; a 사고 filed from a personal event is shown once, as that event,
 * while both still have the same times (if someone changed one of them, both show).
 */
const key = (id: string, start: number, end: number): string => `${id}:${start}:${end}`

/** The 사고 (absence occurrences) of `memberId` that no personal event already stands for. */
export function myAbsencesForPersonal(server: EventOccurrenceDto[], personal: PersonalOccurrenceDto[], memberId: string | null | undefined): EventOccurrenceDto[] {
  if (!memberId) return []
  const linked = new Set(personal.filter((p) => p.absenceEventId).map((p) => key(p.absenceEventId!, p.start, p.end)))
  return server.filter((e) => e.kind === 'absence' && e.authorId === memberId && !linked.has(key(e.id, e.start, e.end)))
}

/** True when this server occurrence is my 사고 that a personal event already shows. */
export function shownAsPersonal(e: EventOccurrenceDto, personal: PersonalOccurrenceDto[], memberId: string | null | undefined): boolean {
  if (e.kind !== 'absence' || !memberId || e.authorId !== memberId) return false
  return personal.some((p) => p.absenceEventId === e.id && p.start === e.start && p.end === e.end)
}

/** "[연가] 근무현황" — how my 사고 reads among my own events. */
export const absenceTitle = (e: Pick<EventOccurrenceDto, 'absenceType'>): string => `[${e.absenceType ?? '부재'}] 근무현황`
