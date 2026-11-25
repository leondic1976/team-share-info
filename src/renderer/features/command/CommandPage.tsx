/**
 * 긴급구조지휘대 in TeamHub: the module's screens (command/renderer) with TeamHub as their host —
 * the menu page, the 훈련 창 and 통제실 windows, the alerts and the menu badge.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { useConn } from '@renderer/app/conn-store'
import { Loading } from '@renderer/components/EmptyState'
import { CommandApp, ControlRoomWindow, useCommandAlerts } from '../../../../command/renderer/CommandApp'
import { DrillPopup } from '../../../../command/renderer/DrillPopup'
import type { CommandState } from '../../../../command/shared/types'
import { TeamHubCommandHost } from './host'

export function CommandPage(): React.JSX.Element {
  return (
    <TeamHubCommandHost>
      <CommandApp />
    </TeamHubCommandHost>
  )
}

function Alerts({ meId, enabled }: { meId: string | null; enabled: boolean }): null {
  useCommandAlerts(meId, enabled)
  return null
}
/** In the main window all the time: the 훈련 창 pops up for participants; 지휘대 공지 alert cards. */
export function CommandAlerts({ meId, enabled }: { meId: string | null; enabled: boolean }): React.JSX.Element {
  return (
    <TeamHubCommandHost>
      <Alerts meId={meId} enabled={enabled} />
    </TeamHubCommandHost>
  )
}

/** The menu badge: unread 지휘대 공지 and drill messages waiting for me (same query as the page). */
export function useCommandBadge(enabled: boolean): number {
  const online = useConn((s) => s.state === 'online')
  const q = useQuery({ queryKey: ['command', 'state'], queryFn: () => api.get<CommandState>('/api/command'), enabled: enabled && online, placeholderData: (p) => p, staleTime: 30_000 })
  useEffect(() => {
    if (!enabled) return
    const offs = [realtime.on('command.changed', () => void q.refetch()), realtime.on('command.drill', () => void q.refetch())]
    return () => offs.forEach((o) => o())
  }, [enabled, q])
  const s = q.data
  if (!s) return 0
  return s.unreadNotices + s.drills.reduce((n, d) => n + (d.state !== 'ended' ? d.pendingForMe : 0), 0)
}

/** A window of its own (훈련 창 or 통제실): its own connection to the server, like the meeting window. */
function useOwnConnection(): boolean {
  const loadConn = useConn((s) => s.load)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    void invoke('conn:get').then((c) => {
      loadConn(c)
      realtime.start()
      setReady(true)
    })
    return () => realtime.stop()
  }, [loadConn])
  return ready
}

export function DrillPopupWindow({ id }: { id: string }): React.JSX.Element {
  const ready = useOwnConnection()
  if (!ready) return <Loading />
  return (
    <TeamHubCommandHost popup>
      <DrillPopup drillId={id} />
    </TeamHubCommandHost>
  )
}

export function ControlRoomPopup({ id }: { id: string }): React.JSX.Element {
  const ready = useOwnConnection()
  useEffect(() => {
    document.title = '훈련 통제실 · 긴급구조지휘대'
  }, [])
  if (!ready) return <Loading />
  return (
    <TeamHubCommandHost popup>
      <ControlRoomWindow drillId={id} />
    </TeamHubCommandHost>
  )
}
