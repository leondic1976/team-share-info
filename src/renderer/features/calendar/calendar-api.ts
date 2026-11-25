import { useQuery } from '@tanstack/react-query'
import type { EventOccurrenceDto, HolidayDto } from '@shared/schemas/events'
import type { PersonalOccurrenceDto } from '@shared/schemas/personal'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { useConn } from '@renderer/app/conn-store'
import { ymd } from '@renderer/lib/dates'
import { warmEventsKey } from '@renderer/lib/warm-cache'

export interface Range {
  from: number
  to: number
}

export function useServerEvents(range: Range | null, filter: { groupId?: string; memberId?: string }): { data: EventOccurrenceDto[] | undefined } {
  const online = useConn((s) => s.state === 'online')
  const q = useQuery({
    queryKey: ['events', range?.from, range?.to, filter.groupId ?? '', filter.memberId ?? ''],
    queryFn: () => api.get<EventOccurrenceDto[]>('/api/events', { from: range!.from, to: range!.to, groupId: filter.groupId, memberId: filter.memberId }),
    enabled: online && !!range,
    placeholderData: (p) => p
  })
  // Server PC off and this month never opened: the wide range kept in the background
  // (warmCache) still shows the shared events (지시 81). Only without a member filter.
  const warm = useQuery({ queryKey: warmEventsKey(filter.groupId), queryFn: () => Promise.resolve<EventOccurrenceDto[] | null>(null), enabled: false })
  if (q.data !== undefined || online || !range || filter.memberId || !warm.data) return { data: q.data }
  return { data: warm.data.filter((e) => e.start < range.to && e.end > range.from) }
}

export function usePersonalEvents(range: Range | null) {
  return useQuery({
    queryKey: ['local', 'events', range?.from, range?.to],
    queryFn: () => invoke('local:events.list', { from: range!.from, to: range!.to }),
    enabled: !!range,
    networkMode: 'always'
  })
}

export function useHolidays(range: Range | null) {
  const online = useConn((s) => s.state === 'online')
  return useQuery({
    queryKey: ['events', 'holidays', range?.from, range?.to],
    queryFn: () => api.get<HolidayDto[]>('/api/holidays', { from: ymd(range!.from), to: ymd(range!.to) }),
    enabled: online && !!range,
    staleTime: 3600_000,
    placeholderData: (p) => p
  })
}

export type CalItem =
  | ({ origin: 'server' } & EventOccurrenceDto)
  | ({ origin: 'local' } & PersonalOccurrenceDto)
