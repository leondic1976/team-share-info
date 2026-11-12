import { useEffect, useState } from 'react'
import { MonitorUp, Phone, PhoneOff, Video } from 'lucide-react'
import type { MeetingInvitePayload } from '@shared/schemas/meetings'
import { Button } from '@renderer/components/ui/button'
import { invoke } from '@renderer/lib/bridge'
import { api } from '@renderer/lib/api'
import { useConn } from '@renderer/app/conn-store'
import { beep } from '@renderer/features/notices/UrgentPopup'

/** Incoming meeting pop-up (#/popup/invite/:id): 참가 / 거절. */
export function InvitePopup({ id }: { id: string }): React.JSX.Element {
  const loadConn = useConn((s) => s.load)
  const [p, setP] = useState<MeetingInvitePayload | null>(null)
  useEffect(() => {
    void invoke('meeting:inviteGet', { id }).then(setP)
    beep()
    const t = window.setInterval(beep, 4000)
    const stop = window.setTimeout(() => window.clearInterval(t), 30000)
    return () => {
      window.clearInterval(t)
      window.clearTimeout(stop)
    }
  }, [id])
  const decline = async (): Promise<void> => {
    try {
      loadConn(await invoke('conn:get'))
      await api.post(`/api/meetings/${id}/decline`)
    } catch {
      // offline
    }
    await invoke('meeting:inviteClose', { id, accept: false })
  }
  if (!p) return <div className="p-4 text-sm">불러오는 중…</div>
  return (
    <div className="flex h-full flex-col bg-background" data-testid="meeting-invite">
      <div className="flex items-center gap-2 bg-primary px-3 py-2 text-primary-foreground">
        {p.mode === 'video' ? <Video className="size-5" /> : <MonitorUp className="size-5" />}
        <span className="font-bold">{p.mode === 'video' ? '회의 초대' : '화면 공유 초대'}</span>
      </div>
      <div className="flex-1 px-4 py-3">
        <p className="text-lg font-bold">{p.title}</p>
        <p className="text-sm text-muted-foreground">{p.hostName}님이 초대했습니다.</p>
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-3 py-2">
        <Button variant="outline" onClick={() => void decline()}>
          <PhoneOff /> 거절
        </Button>
        <Button onClick={() => void invoke('meeting:inviteClose', { id, accept: true })}>
          <Phone /> 참가
        </Button>
      </div>
    </div>
  )
}
