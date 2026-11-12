import { useEffect } from 'react'
import type { EventOccurrenceDto } from '@shared/schemas/events'
import type { ReminderItem } from '@shared/schemas/personal'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { useConn } from '@renderer/app/conn-store'
import { format } from 'date-fns'

const LOOKAHEAD = 15 * 86400000

function label(m: number): string {
  if (m === 0) return '지금'
  if (m < 60) return `${m}분 전`
  if (m < 1440) return `${Math.round(m / 60)}시간 전`
  return `${Math.round(m / 1440)}일 전`
}

/**
 * Shared event reminders: the renderer fetches upcoming events from the server and
 * hands the reminder times to the main-process scheduler, which fires them even when
 * the window is hidden (13.13). Refreshes on event changes, reconnects and every 5 minutes.
 */
export function useEventReminders(): void {
  const online = useConn((s) => s.state === 'online')
  useEffect(() => {
    if (!online) return
    let alive = true
    const sync = async (): Promise<void> => {
      const now = Date.now()
      try {
        const list = await api.get<EventOccurrenceDto[]>('/api/events', { from: now - 3600000, to: now + LOOKAHEAD })
        const items: ReminderItem[] = []
        for (const e of list) {
          if (e.kind !== 'team' || e.myResponse === 'no') continue
          for (const m of e.reminders) {
            const fireAt = e.start - m * 60000
            if (fireAt < now - 3600000) continue
            items.push({
              key: `se:${e.id}:${e.key}:${m}`,
              fireAt,
              title: `일정 알림 · ${label(m)}`,
              body: `${e.title} (${format(e.start, e.allDay ? 'M/d 종일' : 'M/d HH:mm')})${e.location ? ` · ${e.location}` : ''}`,
              route: '/calendar'
            })
          }
        }
        if (alive) await invoke('scheduler:setServerReminders', { source: 'events', items })
      } catch {
        // offline: keep the last list in main
      }
    }
    void sync()
    const off1 = realtime.on('event.changed', () => void sync())
    const off2 = realtime.onReconnect(() => void sync())
    const t = window.setInterval(() => void sync(), 5 * 60000)
    return () => {
      alive = false
      off1()
      off2()
      window.clearInterval(t)
    }
  }, [online])
}
