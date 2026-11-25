import type { Presence } from './schemas/auth'

/** Display order of presence states: here first, then away, absent, offline (홈 팀원 현황). */
export const PRESENCE_ORDER: Record<Presence, number> = { online: 0, away: 1, absent: 2, offline: 3 }

/** Comparator by presence only; Array.prototype.sort is stable, so the given order is kept within a state. */
export function byPresence(a: { presence: Presence }, b: { presence: Presence }): number {
  return PRESENCE_ORDER[a.presence] - PRESENCE_ORDER[b.presence]
}
