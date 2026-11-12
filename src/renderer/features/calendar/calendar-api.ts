import { useQuery } from '@tanstack/react-query'
import type { EventOccurrenceDto, HolidayDto } from '@shared/schemas/events'
import type { PersonalOccurrenceDto } from '@shared/schemas/personal'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { useConn } from '@renderer/app/conn-store'
import { ymd } from '@renderer/lib/dates'

export interface Range {
  from: number
  to: number
}

export function useServerEvents(range: Range | null, filter: { groupId?: string; memberId?: string }) {
  const online = useConn((s) => s.state === 'online')
  return useQuery({
    queryKey: ['events', range?.from, range?.to, filter.groupId ?? '', filter.memberId ?? ''],
    queryFn: () => api.get<EventOccurrenceDto[]>('/api/events', { from: range!.from, to: range!.to, groupId: filter.groupId, memberId: filter.memberId }),
    enabled: online && !!range,
    placeholderData: (p) => p
  })
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
