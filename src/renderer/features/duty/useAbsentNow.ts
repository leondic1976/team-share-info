import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { startOfWeek } from 'date-fns'
import type { DutyBoardDto } from '@shared/schemas/duty'
import { absencesOn, type DayAbsence } from '@shared/dutyDay'
import { api } from '@renderer/lib/api'
import { DAY, startOfDay } from '@renderer/lib/dates'
import { useMe } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'

/**
 * Who is away today by 근무현황, for the 사고명 badge next to names. It reads the same week board
 * as the home widget and 근무현황 (one request, kept for offline use, refreshed on event.changed).
 */
export function useAbsentNow(): Map<string, DayAbsence> {
  const online = useConn((s) => s.state === 'online')
  const { data: me } = useMe()
  const today = startOfDay(Date.now())
  const week = startOfWeek(today, { weekStartsOn: 1 }).getTime()
  const off = !!me?.disabledFeatures?.includes('duty')
  const q = useQuery({
    queryKey: ['events', 'duty', week, week + 7 * DAY],
    queryFn: () => api.get<DutyBoardDto>('/api/duty', { from: week, to: week + 7 * DAY }),
    enabled: online && !off,
    placeholderData: (prev) => prev,
    staleTime: 60_000
  })
  const entries = off ? undefined : q.data?.entries
  // to the minute: an absence that ended drops out on the next render
  const minute = Math.floor(Date.now() / 60_000)
  return useMemo(() => absencesOn(entries ?? [], today, minute * 60_000), [entries, today, minute])
}
