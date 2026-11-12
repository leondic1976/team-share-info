import { useEffect } from 'react'
import type { TaskDto } from '@shared/schemas/work'
import type { ReminderItem } from '@shared/schemas/personal'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { useConn } from '@renderer/app/conn-store'
import { inDoNotDisturb } from '@renderer/app/prefs-store'

/**
 * Task alerts (6.8): a toast when someone assigns me a task, and due reminders
 * (1 day before and at the due time) handed to the main-process scheduler.
 */
export function useTaskAlerts(): void {
  const online = useConn((s) => s.state === 'online')
  useEffect(() => {
    if (!online) return
    const sync = async (): Promise<void> => {
      try {
        const list = await api.get<TaskDto[]>('/api/tasks', { filter: 'received', state: 'open' })
        const items: ReminderItem[] = []
        for (const t of list) {
          if (!t.dueAt || t.state === 'done') continue
          items.push({ key: `st:${t.id}:${t.dueAt}:d`, fireAt: t.dueAt - 86400000, title: '업무 마감 내일', body: `${t.title} (요청: ${t.requesterName})`, route: '/tasks' })
          items.push({ key: `st:${t.id}:${t.dueAt}:0`, fireAt: t.dueAt, title: '업무 마감 시각입니다', body: `${t.title} (요청: ${t.requesterName})`, route: '/tasks' })
        }
        await invoke('scheduler:setServerReminders', { source: 'tasks', items })
      } catch {
        // offline
      }
    }
    void sync()
    const off = realtime.on('task.changed', (raw) => {
      const p = raw as { assigned?: boolean; title?: string; requesterName?: string }
      if (p.assigned && !inDoNotDisturb()) void invoke('notify:toast', { title: `새 업무 요청 · ${p.requesterName ?? ''}`, body: p.title ?? '', route: '/tasks' })
      void sync()
    })
    const offRe = realtime.onReconnect(() => void sync())
    return () => {
      off()
      offRe()
    }
  }, [online])
}
