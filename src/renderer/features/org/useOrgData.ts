import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@renderer/lib/api'
import { startOfDay, DAY } from '@renderer/lib/dates'
import { useConn } from '@renderer/app/conn-store'
import type { DepartmentDto } from '@shared/schemas/org'
import { onDay, type DutyBoardDto, type DutyEntryDto } from '@shared/schemas/duty'

/** The department tree. Same key as the directory, so both share the result and the offline copy. */
export function useDepartments() {
  const online = useConn((s) => s.state === 'online')
  return useQuery({ queryKey: ['members', 'departments'], queryFn: () => api.get<DepartmentDto[]>('/api/departments'), enabled: online })
}

/** Today's absences (근무현황: 연가·출장 …) by member. Under 'events', so a change shows at once. */
export function useTodayAbsences(): Map<string, DutyEntryDto[]> {
  const online = useConn((s) => s.state === 'online')
  const from = startOfDay(Date.now())
  const to = from + DAY
  const { data } = useQuery({ queryKey: ['events', 'duty', from, to], queryFn: () => api.get<DutyBoardDto>('/api/duty', { from, to }), enabled: online, placeholderData: (prev) => prev })
  return useMemo(() => {
    const m = new Map<string, DutyEntryDto[]>()
    for (const e of data?.entries ?? []) {
      if (!onDay(e, from, to)) continue
      m.set(e.memberId, [...(m.get(e.memberId) ?? []), e])
    }
    return m
  }, [data, from, to])
}
