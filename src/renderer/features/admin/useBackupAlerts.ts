import { useEffect } from 'react'
import { format, formatDistanceToNow } from 'date-fns'
import { ko } from 'date-fns/locale'
import type { MeDto } from '@shared/schemas/auth'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { useConn } from '@renderer/app/conn-store'
import { inDoNotDisturb } from '@renderer/app/prefs-store'

const ROUTE = '/admin/backup'
const KEY = 'teamhub.backupReminder'
/** again a few minutes after going online (a catch-up backup may have run by then), then hourly */
const RECHECK_MS = [3 * 60_000]
const HOURLY_MS = 3600_000

const today = (): string => format(new Date(), 'yyyy-MM-dd')
function remindedToday(): boolean {
  try {
    return localStorage.getItem(KEY) === today()
  } catch {
    return false
  }
}
function markReminded(): void {
  try {
    localStorage.setItem(KEY, today())
  } catch {
    // storage unavailable: the reminder may come again
  }
}

/**
 * 최종관리자 (the server PC) only: a reminder card when the server backups are failing or the
 * last successful one is more than 2 days old, at most once a day. A 서무 cannot change backups,
 * and the server sends the state to the server PC only.
 */
export function useBackupAlerts(isOwner: boolean): void {
  const online = useConn((s) => s.state === 'online')
  useEffect(() => {
    if (!online || !isOwner) return
    const check = async (): Promise<void> => {
      if (remindedToday() || inDoNotDisturb()) return
      let alert: MeDto['backupAlert']
      try {
        alert = (await api.get<MeDto>('/api/me')).backupAlert
      } catch {
        return
      }
      if (!alert || remindedToday()) return
      markReminded()
      const last = alert.lastAt ? `마지막으로 성공한 백업: ${format(alert.lastAt, 'yyyy-MM-dd HH:mm')}(${formatDistanceToNow(alert.lastAt, { locale: ko })} 전)` : '아직 성공한 백업이 없습니다.'
      if (alert.kind === 'failed') {
        void invoke('notify:toast', {
          title: '서버 백업이 실패했습니다',
          body: `${alert.lastError ? `오류: ${alert.lastError.slice(0, 240)}\n` : ''}${last}\n눌러서 관리 → 백업·복구를 엽니다.`,
          route: ROUTE,
          key: 'backup-alert'
        })
      } else {
        void invoke('notify:toast', {
          title: alert.lastAt ? '서버 백업이 2일 넘게 되지 않았습니다' : '서버 백업이 아직 없습니다',
          body: `${last}\n눌러서 관리 → 백업·복구에서 지금 백업을 누르세요.`,
          route: ROUTE,
          key: 'backup-alert'
        })
      }
    }
    const timers = [setTimeout(() => void check(), 5000), ...RECHECK_MS.map((ms) => setTimeout(() => void check(), ms))]
    const hourly = setInterval(() => void check(), HOURLY_MS)
    const offRe = realtime.onReconnect(() => void check())
    return () => {
      timers.forEach(clearTimeout)
      clearInterval(hourly)
      offRe()
    }
  }, [online, isOwner])
}
