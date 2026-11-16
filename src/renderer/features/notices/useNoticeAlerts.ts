import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { UrgentPayload } from '@shared/schemas/notices'
import { realtime } from '@renderer/lib/realtime'
import { api } from '@renderer/lib/api'
import { invoke, onMain } from '@renderer/lib/bridge'
import { inDoNotDisturb } from '@renderer/app/prefs-store'
import { useConn } from '@renderer/app/conn-store'
import { useMe } from '@renderer/lib/queries'

interface ChangedPayload {
  id: string
  level?: 'urgent' | 'important' | 'normal'
  title?: string
  authorName?: string
  authorId?: string
  published?: boolean
  renotify?: boolean
  groupIds?: string[]
}

/** Unread notice count, used for the sidebar badge and the tray icon. */
export function useUnreadNotices(): { unread: number; urgent: number } {
  const online = useConn((s) => s.state === 'online')
  const q = useQuery({
    queryKey: ['notices', 'unread-count'],
    queryFn: () => api.get<{ unread: number; urgent: number }>('/api/notices/unread-count'),
    enabled: online,
    placeholderData: (p) => p
  })
  return q.data ?? { unread: 0, urgent: 0 }
}

/**
 * Delivers notice alerts (6.3): urgent -> always-on-top popup; important -> Windows
 * notification (respecting do-not-disturb); after reconnecting, fetch what was missed.
 */
export function useNoticeAlerts(): void {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const memberId = useConn((s) => s.memberId)
  const { unread } = useUnreadNotices()
  const chat = useQuery({ queryKey: ['chat', 'unread'], queryFn: () => api.get<{ messages: number; notes: number }>('/api/chat/unread'), enabled: useConn((s) => s.state === 'online') })
  const pendingJoins = useMe().data?.pendingJoins ?? 0
  const total = unread + (chat.data?.messages ?? 0) + (chat.data?.notes ?? 0) + pendingJoins

  // Tray icon shows a red dot while anything is unread (notices, messages, notes)
  // or, for admins, while join requests wait for approval.
  useEffect(() => {
    void invoke('app:setBadge', { count: total })
  }, [total])

  useEffect(() => {
    const offUrgent = realtime.on('notice.urgent', (p) => void invoke('notify:urgent', p as UrgentPayload))
    const offChanged = realtime.on('notice.changed', (raw) => {
      const p = raw as ChangedPayload
      if (!p.level || p.authorId === memberId) return
      if (!(p.published || p.renotify)) return
      // Skip when every target group is muted by me (그룹 알림 끄기).
      const groups = useConn.getState().me?.groups ?? []
      const muted = !!p.groupIds?.length && p.groupIds.every((g) => groups.find((x) => x.id === g)?.notify === false)
      if (p.level === 'important' && !muted && !inDoNotDisturb()) {
        void invoke('notify:toast', { title: `[중요] ${p.title ?? '공지'}`, body: `${p.authorName ?? ''} · 공지를 확인하세요`, route: `/notices/${p.id}` })
      }
    })
    const offRe = realtime.onReconnect(() => {
      void api
        .get<UrgentPayload[]>('/api/notices/pending')
        .then((list) => {
          const important = list.filter((p) => p.level === 'important')
          for (const p of list.filter((x) => x.level === 'urgent')) void invoke('notify:urgent', p)
          if (important.length && !inDoNotDisturb()) {
            const first = important[0]
            void invoke('notify:toast', {
              title: important.length > 1 ? `[중요] 공지 ${important.length}건` : `[중요] ${first.title}`,
              body: '연결이 끊긴 동안 도착한 공지가 있습니다.',
              route: important.length > 1 ? '/notices' : `/notices/${first.id}`
            })
          }
        })
        .catch(() => undefined)
    })
    const offNav = onMain('app:navigate', ({ path }) => navigate(path))
    const offClosed = onMain('popup:closed', () => void qc.invalidateQueries({ queryKey: ['notices'] }))
    return () => {
      offUrgent()
      offChanged()
      offRe()
      offNav()
      offClosed()
    }
  }, [memberId, navigate, qc])
}
