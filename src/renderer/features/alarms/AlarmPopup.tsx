import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { AlarmClock, BellOff, Clock } from 'lucide-react'
import type { AlarmPopupPayload } from '@shared/schemas/tools'
import { Button } from '@renderer/components/ui/button'
import { invoke } from '@renderer/lib/bridge'
import { api } from '@renderer/lib/api'
import { useConn } from '@renderer/app/conn-store'
import { beep } from '@renderer/features/notices/UrgentPopup'

/** Alarm popup window (#/popup/alarm/:pid): 끄기 / 5분 뒤 / 10분 뒤. */
export function AlarmPopup({ pid }: { pid: string }): React.JSX.Element {
  const loadConn = useConn((s) => s.load)
  const [p, setP] = useState<AlarmPopupPayload | null>(null)

  useEffect(() => {
    void invoke('alarm:popupGet', { pid }).then(setP)
  }, [pid])

  // Ring a few times (about 30 s) unless sound is off.
  useEffect(() => {
    if (!p?.sound) return
    beep()
    let n = 0
    const t = window.setInterval(() => {
      if (++n >= 10) window.clearInterval(t)
      else beep()
    }, 3000)
    return () => window.clearInterval(t)
  }, [p])

  const act = async (action: 'dismiss' | 'snooze', minutes?: number): Promise<void> => {
    if (p?.remoteId) {
      // Alarms from teammates are marked confirmed on the server.
      try {
        loadConn(await invoke('conn:get'))
        await api.post(`/api/alarms/${p.remoteId}/dismiss`)
      } catch {
        // offline: it comes back on reconnect
      }
    }
    await invoke('alarm:popupAction', { pid, action, minutes })
  }

  if (!p) return <div className="p-4 text-sm text-muted-foreground">불러오는 중…</div>
  return (
    <div className="flex h-full flex-col border-4 border-primary bg-background" data-testid="alarm-popup">
      <div className="flex items-center gap-2 bg-primary px-3 py-2 text-primary-foreground">
        <AlarmClock className="size-5" />
        <span className="font-bold">{p.fromName ? `${p.fromName}님이 보낸 알람` : '알람'}</span>
        <span className="ml-auto text-xs opacity-90">{format(p.fireAt, 'M/d HH:mm')}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <h1 className="text-lg font-bold" data-testid="alarm-title">
          {p.title}
        </h1>
        {p.body && <p className="selectable mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{p.body}</p>}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <Button size="sm" variant="outline" onClick={() => void act('snooze', 5)}>
          <Clock /> 5분 뒤
        </Button>
        <Button size="sm" variant="outline" onClick={() => void act('snooze', 10)}>
          10분 뒤
        </Button>
        <Button size="sm" className="ml-auto" onClick={() => void act('dismiss')}>
          <BellOff /> {p.remoteId ? '확인' : '끄기'}
        </Button>
      </div>
    </div>
  )
}
