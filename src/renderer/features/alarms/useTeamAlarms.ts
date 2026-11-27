import { useEffect } from 'react'
import type { AlarmFirePayload } from '@shared/schemas/tools'
import type { UpcomingReminder } from '@shared/schemas/tools'
import { realtime } from '@renderer/lib/realtime'
import { api } from '@renderer/lib/api'
import { invoke, localKv } from '@renderer/lib/bridge'
import { useConn } from '@renderer/app/conn-store'
import { startOfDay, DAY, ymd } from '@renderer/lib/dates'
import type { EventOccurrenceDto } from '@shared/schemas/events'
import { myAbsencesForPersonal } from '@shared/absenceLink'

/** Alarms sent by teammates (6.12 ②): pushed when due, and fetched on (re)connect. */
export function useTeamAlarms(): void {
  const online = useConn((s) => s.state === 'online')
  useEffect(() => {
    const offFire = realtime.on('alarm.fire', (p) => void invoke('alarm:showRemote', p as AlarmFirePayload))
    return offFire
  }, [])
  useEffect(() => {
    if (!online) return
    void api
      .get<AlarmFirePayload[]>('/api/alarms/pending')
      .then((list) => list.forEach((a) => void invoke('alarm:showRemote', a)))
      .catch(() => undefined)
  }, [online])
}

export const SOURCE_LABEL: Record<string, string> = {
  alarms: '알람',
  'personal-events': '개인 일정',
  events: '일정',
  annual: '연간 업무'
}

export function todayReminders(): Promise<UpcomingReminder[]> {
  const s = startOfDay(Date.now())
  return invoke('scheduler:upcoming', { from: s, to: s + DAY - 1 })
}

/** Morning summary on the first start of the day (6.12 ③ 오늘의 업무). */
export function useMorningSummary(): void {
  useEffect(() => {
    const t = window.setTimeout(async () => {
      const today = ymd()
      if ((await localKv.get<string>('summaryDate')) === today) return
      await localKv.set('summaryDate', today)
      const s = startOfDay(Date.now())
      const conn = useConn.getState()
      const [events, items, server] = await Promise.all([
        invoke('local:events.list', { from: s, to: s + DAY }),
        todayReminders(),
        // my 사고 in 근무현황 belongs to my day too (instruction 145)
        conn.state === 'online' && conn.memberId ? api.get<EventOccurrenceDto[]>('/api/events', { from: s, to: s + DAY, memberId: conn.memberId }).catch(() => []) : Promise.resolve([])
      ])
      const away = [...new Set(myAbsencesForPersonal(server, [], conn.memberId).map((e) => e.absenceType ?? '부재'))]
      const alarms = items.filter((i) => i.source === 'alarms').length
      const ev = events.length + new Set(items.filter((i) => i.source === 'events').map((i) => i.body)).size
      if (!ev && !alarms && !away.length) return
      void invoke('notify:toast', { title: '오늘의 업무', body: `${away.length ? `오늘 ${away.join('·')} · ` : ''}일정 ${ev}건 · 알람 ${alarms}건`, route: '/home' })
    }, 8000)
    return () => window.clearTimeout(t)
  }, [])
}
