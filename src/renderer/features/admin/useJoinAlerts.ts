import { useEffect } from 'react'
import type { MeDto } from '@shared/schemas/auth'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { useConn } from '@renderer/app/conn-store'
import { inDoNotDisturb } from '@renderer/app/prefs-store'

const ROUTE = '/admin/approvals'
const REMIND_AFTER_MS = 30 * 60_000

/** Last "N waiting" reminder, kept across remounts so reconnects do not repeat it. */
let reminded = { count: 0, at: 0 }

/**
 * Join request alerts for admins: a Windows notification when someone asks to join,
 * and a reminder of requests that arrived while this PC was off or disconnected.
 */
export function useJoinAlerts(isAdmin: boolean): void {
  const online = useConn((s) => s.state === 'online')
  useEffect(() => {
    if (!online || !isAdmin) return
    const remind = async (): Promise<void> => {
      let count: number
      try {
        count = (await api.get<MeDto>('/api/me')).pendingJoins
      } catch {
        return
      }
      if (!count) {
        reminded = { count: 0, at: 0 }
        return
      }
      const now = Date.now()
      if (count <= reminded.count && now - reminded.at < REMIND_AFTER_MS) return
      if (inDoNotDisturb()) return
      reminded = { count, at: now }
      void invoke('notify:toast', { title: `사용 신청 ${count}건이 승인을 기다립니다`, body: '관리 → 승인 관리에서 승인하거나 거절하세요.', route: ROUTE })
    }
    void remind()
    const off = realtime.on('join.requested', (raw) => {
      const p = raw as { name?: string; deptName?: string | null; pcName?: string; ip?: string }
      // Count it as announced so the reminder does not repeat it right away.
      reminded = { count: reminded.count + 1, at: Date.now() }
      if (inDoNotDisturb()) return
      const who = [p.name, p.deptName].filter(Boolean).join(' · ')
      const from = [p.pcName, p.ip].filter(Boolean).join(' · ')
      void invoke('notify:toast', { title: `사용 신청 · ${who}`, body: `${from ? `${from}\n` : ''}눌러서 승인 관리를 엽니다.`, route: ROUTE })
    })
    const offRe = realtime.onReconnect(() => void remind())
    return () => {
      off()
      offRe()
    }
  }, [online, isAdmin])
}
