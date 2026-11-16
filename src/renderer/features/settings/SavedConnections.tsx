import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { MonitorSmartphone, Server, Trash2 } from 'lucide-react'
import type { SavedConnInfo } from '@shared/ipc'
import { Button } from '@renderer/components/ui/button'
import { invoke } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { queryClient } from '@renderer/lib/query-client'

/**
 * Everything on screen belongs to the connection that was in use, so after a switch the
 * window starts over from the first route instead of patching each store.
 */
export function restartAfterSwitch(): void {
  queryClient.clear()
  window.location.hash = '/'
  window.location.reload()
}

/**
 * Connections this PC used before (server or member PC). Choosing one makes it the
 * connection in use again — the same device, so no new approval is needed.
 */
export function SavedConnections({ activateLabel }: { activateLabel: string }): React.JSX.Element | null {
  const [list, setList] = useState<SavedConnInfo[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void invoke('conn:saved').then(setList)
  }, [])
  if (list.length === 0) return null

  const activate = async (c: SavedConnInfo): Promise<void> => {
    setBusy(true)
    realtime.stop()
    const r = await invoke('conn:activateSaved', { id: c.id }).catch((e: unknown) => ({ ok: false, error: String(e) }))
    if (!r.ok) window.alert(r.error ?? '전환하지 못했습니다.')
    restartAfterSwitch()
  }
  const forget = async (c: SavedConnInfo): Promise<void> => {
    const warn =
      c.mode === 'server'
        ? `"${c.label}" 서버 연결을 목록에서 지웁니다. 서버 자료(${c.dataDir ?? '데이터 폴더'})는 지워지지 않지만, 이 PC에서 다시 그 서버를 쓰려면 백업으로 옮겨 와야 합니다. 계속할까요?`
        : `"${c.label}" 연결을 목록에서 지웁니다. 다시 접속하려면 사용 신청과 승인을 새로 받아야 합니다. 계속할까요?`
    if (!window.confirm(warn)) return
    await invoke('conn:forgetSaved', { id: c.id })
    setList(await invoke('conn:saved'))
  }

  return (
    <div className="space-y-1.5" data-testid="saved-connections">
      {list.map((c) => (
        <div key={c.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm" data-testid="saved-connection">
          {c.mode === 'server' ? <Server className="size-4 shrink-0 text-primary" /> : <MonitorSmartphone className="size-4 shrink-0 text-primary" />}
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">
              {c.label} <span className="font-normal text-muted-foreground">· {c.mode === 'server' ? '이 PC가 서버' : '팀원 PC'}</span>
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {c.mode === 'server' ? c.dataDir : c.serverUrl?.replace(/^https?:\/\//, '')} · {format(c.savedAt, 'yyyy-MM-dd HH:mm')}까지 사용
            </div>
          </div>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void activate(c)}>
            {activateLabel}
          </Button>
          <Button size="sm" variant="ghost" aria-label="기억한 연결 지우기" disabled={busy} onClick={() => void forget(c)}>
            <Trash2 />
          </Button>
        </div>
      ))}
    </div>
  )
}
