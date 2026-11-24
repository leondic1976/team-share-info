import { useEffect, useRef, useState } from 'react'
import { CloudOff, Loader2, Plus, RefreshCw, Send, Server, Trash2, Wifi } from 'lucide-react'
import type { SavedConnInfo } from '@shared/ipc'
import { useConn, type ConnState } from './conn-store'
import { invoke } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { discardOutbox, flushOutbox, loadOutbox, retryOutbox, useOutbox } from '@renderer/lib/outbox'
import { useOrgDisplay } from '@renderer/lib/queries'
import { cn } from '@renderer/lib/utils'

type Look = 'on' | 'wait' | 'off'
const LOOK: Record<ConnState, Look> = {
  loading: 'wait',
  unconfigured: 'off',
  pending: 'wait',
  connecting: 'wait',
  online: 'on',
  offline: 'off',
  rejected: 'off',
  'update-required': 'off'
}
const TEXT: Record<Look, string> = { on: '서버 연결됨', wait: '서버 연결 중', off: '서버 꺼짐 · 오프라인' }
const STYLE: Record<Look, string> = {
  on: 'border-success/40 bg-success/10 text-success',
  wait: 'border-important/50 bg-important/15 text-foreground',
  off: 'border-urgent bg-urgent text-white'
}

/** Switch this member PC to another server it belongs to. The window is read again: nothing of the other team stays on screen. */
export async function switchToServer(id: string): Promise<string | null> {
  realtime.stop()
  const r = await invoke('conn:activateSaved', { id })
  if (!r.ok) {
    realtime.start()
    return r.error ?? '서버를 바꾸지 못했습니다.'
  }
  window.location.hash = '#/home'
  window.location.reload()
  return null
}

/** Servers this PC was approved on before; shown in the top bar and on the first screens. */
export function SavedServers({ onError, compact }: { onError?: (m: string) => void; compact?: boolean }): React.JSX.Element | null {
  const [saved, setSaved] = useState<SavedConnInfo[]>([])
  useEffect(() => {
    void invoke('conn:saved').then(setSaved)
  }, [])
  if (!saved.length) return null
  return (
    <div className="space-y-1" data-testid="saved-servers">
      {!compact && <div className="text-sm font-semibold">접속하던 서버로 돌아가기</div>}
      {saved.map((s) => (
        <div key={s.id} className="flex items-center gap-1">
          <button
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-left text-sm hover:border-primary"
            onClick={() => void switchToServer(s.id).then((e) => e && onError?.(e))}
          >
            <Server className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="truncate font-medium">{s.label}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{s.serverUrl?.replace(/^https?:\/\//, '')}</span>
          </button>
          <button
            className="cursor-pointer rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-urgent"
            title="이 서버 접속 정보 지우기"
            aria-label={`${s.label} 접속 정보 지우기`}
            onClick={async () => {
              if (!window.confirm(`${s.label} 서버의 접속 정보와 이 PC에 보관한 그 서버의 자료를 지웁니다. 다시 쓰려면 사용 신청부터 해야 합니다. 지울까요?`)) return
              await invoke('conn:forgetSaved', { id: s.id })
              setSaved(await invoke('conn:saved'))
            }}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * Top bar: whether this PC is connected to the server right now - large and coloured, because
 * while it is not, what is on screen is the copy kept on this PC and new writing waits to be sent.
 * Opens a panel with the waiting items and, on a member PC, the other servers it can use.
 */
export function ConnChip(): React.JSX.Element {
  const state = useConn((s) => s.state)
  const mode = useConn((s) => s.mode)
  const serverUrl = useConn((s) => s.serverUrl)
  const { items, flash, sending } = useOutbox()
  const org = useOrgDisplay()
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const look = LOOK[state]

  useEffect(() => {
    void loadOutbox()
  }, [])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const Icon = look === 'on' ? Wifi : look === 'wait' ? Loader2 : CloudOff
  return (
    <div className="relative shrink-0" ref={box}>
      <button
        className={cn('flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-bold', STYLE[look])}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${TEXT[look]}${items.length ? `, 보낼 것 ${items.length}건` : ''}`}
        data-testid="conn-chip"
        data-state={look}
      >
        <Icon className={cn('size-3.5', look === 'wait' && 'animate-spin')} aria-hidden />
        <span className="whitespace-nowrap">{TEXT[look]}</span>
        {items.length > 0 && (
          <span className={cn('flex items-center gap-0.5 rounded-full px-1.5 leading-4', look === 'off' ? 'bg-white text-urgent' : 'bg-important text-white')} data-testid="outbox-count">
            <Send className="size-3" aria-hidden />
            {items.length}
          </span>
        )}
      </button>
      {flash && !open && (
        <div className="absolute left-0 top-9 z-50 whitespace-nowrap rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-lg" role="status" data-testid="outbox-flash">
          {flash}
        </div>
      )}
      {open && (
        <div className="absolute left-0 top-9 z-50 w-[360px] space-y-3 rounded-lg border border-border bg-card p-3 text-sm shadow-xl" data-testid="conn-panel">
          <div>
            <div className="font-semibold">{[org.orgName, org.teamName].filter(Boolean).join(' ') || '서버'}</div>
            <div className="text-xs text-muted-foreground">{mode === 'server' ? '이 PC가 서버입니다' : serverUrl?.replace(/^https?:\/\//, '')}</div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {look === 'on'
                ? '서버와 연결되어 있습니다. 바뀐 내용이 바로 반영됩니다.'
                : '서버 PC가 꺼져 있거나 연결되지 않습니다. 화면에는 이 PC에 보관해 둔 마지막 내용이 보이고, 새로 쓴 글은 보관했다가 서버가 켜지면 자동으로 보냅니다. 고치기·지우기와 파일 올리기는 연결된 뒤에 할 수 있습니다.'}
            </p>
            {look !== 'on' && state !== 'rejected' && state !== 'update-required' && (
              <button className="mt-2 flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted" onClick={() => realtime.retryNow()}>
                <RefreshCw className="size-3" /> 지금 다시 연결
              </button>
            )}
          </div>
          {items.length > 0 && (
            <div className="border-t border-border pt-2" data-testid="outbox-list">
              <div className="mb-1 flex items-center gap-2 font-semibold">
                보낼 것 {items.length}건
                {sending && <Loader2 className="size-3 animate-spin" />}
                {look === 'on' && !sending && (
                  <button className="ml-auto cursor-pointer text-xs font-normal text-primary hover:underline" onClick={() => void flushOutbox()}>
                    지금 보내기
                  </button>
                )}
              </div>
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {items.map((i) => (
                  <li key={i.id} className="flex items-start gap-1.5 rounded-md bg-muted/60 px-2 py-1 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{i.label}</div>
                      {i.state === 'failed' ? <div className="text-urgent">보내지 못함: {i.error}</div> : <div className="text-muted-foreground">서버에 연결되면 보냅니다</div>}
                    </div>
                    {i.state === 'failed' && (
                      <button className="shrink-0 cursor-pointer text-primary hover:underline" onClick={() => void retryOutbox(i.id)}>
                        다시
                      </button>
                    )}
                    <button
                      className="shrink-0 cursor-pointer text-muted-foreground hover:text-urgent"
                      aria-label="보내지 않고 지우기"
                      title="보내지 않고 지우기"
                      onClick={() => {
                        if (window.confirm('보내지 않고 지울까요? 쓴 내용은 되살릴 수 없습니다.')) void discardOutbox(i.id)
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {mode === 'client' && (
            <div className="space-y-1.5 border-t border-border pt-2">
              <div className="font-semibold">다른 서버</div>
              <SavedServers compact onError={setMsg} />
              <button
                className="flex w-full cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs hover:border-primary"
                data-testid="add-server"
                onClick={async () => {
                  if (!window.confirm('다른 서버(팀)에 사용 신청을 합니다. 지금 서버의 접속 정보는 기억해 두므로 언제든 돌아올 수 있습니다. 계속할까요?')) return
                  realtime.stop()
                  const r = await invoke('conn:switchOut')
                  if (!r.ok) {
                    realtime.start()
                    setMsg(r.error ?? '다른 서버를 추가하지 못했습니다.')
                    return
                  }
                  window.location.hash = ''
                  window.location.reload()
                }}
              >
                <Plus className="size-3.5" /> 다른 서버 추가
              </button>
              <p className="text-xs text-muted-foreground">한 번에 한 서버를 씁니다. 다른 서버의 알림은 그 서버로 바꿨을 때 받습니다.</p>
              {msg && <p className="text-xs text-urgent">{msg}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
