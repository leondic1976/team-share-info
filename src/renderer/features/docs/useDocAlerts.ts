import { useEffect } from 'react'
import type { AnnualTaskDto } from '@shared/schemas/docs'
import type { ReminderItem } from '@shared/schemas/personal'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { useConn } from '@renderer/app/conn-store'
import { inDoNotDisturb } from '@renderer/app/prefs-store'

/** Date of an annual task in a given year (day missing = 1st of the month), local 09:00. */
export function annualDate(t: Pick<AnnualTaskDto, 'month' | 'day'>, year: number): Date {
  const last = new Date(year, t.month, 0).getDate()
  return new Date(year, t.month - 1, Math.min(t.day ?? 1, last), 9, 0)
}

/** Must-read notifications and annual-task reminders (6.11). */
export function useDocAlerts(): void {
  const online = useConn((s) => s.state === 'online')
  const memberId = useConn((s) => s.memberId)
  useEffect(() => {
    if (!online) return
    const sync = async (): Promise<void> => {
      try {
        const list = await api.get<AnnualTaskDto[]>('/api/annual-tasks')
        const now = new Date()
        const items: ReminderItem[] = []
        for (const t of list) {
          for (const y of [now.getFullYear(), now.getFullYear() + 1]) {
            const when = annualDate(t, y)
            const fireAt = when.getTime() - t.remindDaysBefore * 86400000
            items.push({ key: `an:${t.id}:${y}`, fireAt, title: `연간 업무 · ${t.remindDaysBefore ? `${t.remindDaysBefore}일 뒤` : '오늘'}`, body: `${t.title} (${t.month}월${t.day ? ` ${t.day}일` : ''})`, route: '/docs/annual' })
          }
        }
        await invoke('scheduler:setServerReminders', { source: 'annual', items })
      } catch {
        // offline
      }
    }
    void sync()
    const off = realtime.on('doc.changed', (raw) => {
      const p = raw as { mustread?: boolean; title?: string; authorId?: string; authorName?: string; annual?: boolean; id: string; updated?: boolean; remind?: boolean }
      if (p.annual) void sync()
      if (p.mustread && p.authorId !== memberId && !inDoNotDisturb()) {
        void invoke('notify:toast', { title: `[필독] ${p.title ?? ''}`, body: `${p.authorName ?? ''} · ${p.remind ? '아직 읽지 않은 필독 문서입니다.' : p.updated ? '필독 문서가 바뀌었습니다.' : '새 필독 문서입니다.'}`, route: `/docs/mustread/${p.id}` })
      }
    })
    const offRe = realtime.onReconnect(() => void sync())
    return () => {
      off()
      offRe()
    }
  }, [online, memberId])
}
