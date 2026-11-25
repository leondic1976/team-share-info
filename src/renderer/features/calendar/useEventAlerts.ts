import { useEffect } from 'react'
import { format } from 'date-fns'
import { ko } from 'date-fns/locale'
import type { EventDto } from '@shared/schemas/events'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { useConn } from '@renderer/app/conn-store'
import { inDoNotDisturb } from '@renderer/app/prefs-store'

/** How long after it was made an event still counts as newly registered. */
const NEW_MS = 3 * 60_000

/**
 * 일정 등록 (지시 85): when somebody else registers a shared event this member can see, the card
 * near the tray and the "팀뿌요~" sound. Changes of an existing event and 근무현황 entries (부재,
 * the whole team sees those) do not alert.
 */
export function useEventAlerts(): void {
  const memberId = useConn((s) => s.memberId)
  useEffect(() => {
    const told = new Set<string>()
    return realtime.on('event.changed', (raw) => {
      const p = raw as { id?: string; deleted?: boolean; duty?: boolean }
      if (!p.id || p.deleted || p.duty || told.has(p.id) || inDoNotDisturb()) return
      const id = p.id
      void api
        .get<EventDto>(`/api/events/${id}`)
        .then((e) => {
          if (e.authorId === memberId || e.kind !== 'team' || Date.now() - e.createdAt > NEW_MS || told.has(id)) return
          told.add(id)
          const when = e.allDay ? format(e.startAt, 'M/d(EEE)', { locale: ko }) : format(e.startAt, 'M/d(EEE) a h:mm', { locale: ko })
          void invoke('notify:toast', { key: `event:${id}`, title: `새 일정 · ${e.authorName}`, body: `${e.title} · ${when}${e.location ? ` · ${e.location}` : ''}`, route: '/calendar' })
        })
        .catch(() => undefined)
    })
  }, [memberId])
}
