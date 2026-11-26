import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { ko } from 'date-fns/locale'
import { remainingLabel, type CollectChangedPayload } from '@shared/schemas/collect'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { useConn } from '@renderer/app/conn-store'
import { inDoNotDisturb } from '@renderer/app/prefs-store'

export interface CollectMenuSummary {
  todo: number
  canCreate: boolean
}

/** The 자료 취합 menu count (requests waiting for me) and whether I may ask for one. */
export function useCollectSummary(enabled: boolean) {
  const online = useConn((s) => s.state === 'online')
  return useQuery({
    queryKey: ['collect', 'summary'],
    queryFn: () => api.get<CollectMenuSummary>('/api/collects/summary'),
    enabled: enabled && online,
    staleTime: 30_000
  })
}

export const fmtDeadline = (ms: number): string => format(ms, 'M월 d일 (EEE) HH:mm', { locale: ko })

function toast(p: CollectChangedPayload): void {
  const when = p.deadlineAt ? `${fmtDeadline(p.deadlineAt)}까지 (${remainingLabel(p.deadlineAt, Date.now())})` : ''
  const title =
    p.remind === 'day'
      ? '자료 제출 마감 하루 전'
      : p.remind === 'hour'
        ? '자료 제출 마감 1시간 전'
        : p.remind === 'manual'
          ? `자료 제출 다시 알림 · ${p.byName ?? ''}`
          : `자료 제출 요청 · ${p.byName ?? ''}`
  void invoke('notify:toast', { title, body: `“${p.title ?? ''}” ${when}`.trim(), route: `/collect/${p.id}`, key: `collect:${p.id}` })
}

/**
 * 자료 취합 alerts (지시 127): the card and sound when a request for me arrives, when the
 * requester sends 다시 알림, and the automatic reminders before the deadline. A PC that was
 * off gets the cards of what it missed when it connects.
 */
export function useCollectAlerts(enabled: boolean): void {
  const online = useConn((s) => s.state === 'online')
  const memberId = useConn((s) => s.memberId)
  useEffect(() => {
    if (!enabled || !online) return
    const pending = (): void => {
      void api
        .get<CollectChangedPayload[]>('/api/collects/pending')
        .then((list) => {
          if (inDoNotDisturb()) return
          for (const p of list.slice(0, 5)) toast(p)
        })
        .catch(() => undefined)
    }
    pending()
    const off = realtime.on('collect.changed', (raw) => {
      const p = raw as CollectChangedPayload
      if (!p.created && !p.remind) return
      if (p.byId === memberId && !p.remind) return
      if (!inDoNotDisturb()) toast(p)
    })
    const offRe = realtime.onReconnect(pending)
    return () => {
      off()
      offRe()
    }
  }, [enabled, online, memberId])
}
