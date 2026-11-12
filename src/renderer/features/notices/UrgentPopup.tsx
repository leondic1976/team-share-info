import { useCallback, useEffect, useState } from 'react'
import { format } from 'date-fns'
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'
import type { UrgentPayload } from '@shared/schemas/notices'
import { Button } from '@renderer/components/ui/button'
import { RichView } from '@renderer/components/Editor'
import { invoke, onMain } from '@renderer/lib/bridge'
import { api, errorMessage } from '@renderer/lib/api'
import { useConn } from '@renderer/app/conn-store'

/** Three short alarm beeps generated with WebAudio (no sound file needed). */
export function beep(): void {
  try {
    const ctx = new AudioContext()
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'square'
      o.frequency.value = i % 2 ? 660 : 880
      g.gain.value = 0.08
      o.connect(g).connect(ctx.destination)
      const t = ctx.currentTime + i * 0.35
      o.start(t)
      o.stop(t + 0.22)
    }
    setTimeout(() => void ctx.close(), 1500)
  } catch {
    // audio unavailable
  }
}

/** Content of the always-on-top urgent popup window (#/popup/urgent/:id). */
export function UrgentPopup({ id }: { id: string }): React.JSX.Element {
  const loadConn = useConn((s) => s.load)
  const [p, setP] = useState<UrgentPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [shake, setShake] = useState(false)

  const load = useCallback(async () => {
    loadConn(await invoke('conn:get'))
    setP(await invoke('popup:get', { id }))
  }, [id, loadConn])

  useEffect(() => {
    void load()
    beep()
    return onMain('popup:refresh', () => {
      beep()
      setShake(true)
      setTimeout(() => setShake(false), 600)
      void load()
    })
  }, [load])

  const done = async (reply?: string): Promise<void> => {
    if (!p) return
    setBusy(true)
    setErr('')
    try {
      if (p.requireAck) await api.post(`/api/notices/${p.id}/ack`, reply ? { reply } : {})
      else await api.post(`/api/notices/${p.id}/read`)
      await invoke('notify:closeUrgent', { id: p.id })
    } catch (e) {
      setErr(errorMessage(e))
      setBusy(false)
    }
  }

  if (!p) return <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
  return (
    <div className={`flex h-full flex-col border-4 border-urgent bg-background ${shake ? 'animate-pulse' : ''}`} data-testid="urgent-popup">
      <div className="flex items-center gap-2 bg-urgent px-4 py-2.5 text-white">
        <AlertTriangle className="size-5" />
        <span className="font-bold">긴급 알림</span>
        <span className="ml-auto text-xs opacity-90">
          {p.authorName} · {format(p.publishedAt, 'M/d HH:mm')}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <h1 className="text-lg font-bold">{p.title}</h1>
        <RichView html={p.bodyHtml} className="mt-3" />
      </div>
      {err && <p className="px-5 text-sm text-urgent">{err}</p>}
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
        <Button variant="ghost" size="sm" onClick={() => void invoke('window:showMain', { path: `/notices/${p.id}` })}>
          <ExternalLink /> 공지에서 보기
        </Button>
        <div className="ml-auto flex gap-2">
          {busy && <Loader2 className="size-5 animate-spin" />}
          {p.requireAck && p.replyOptions.length ? (
            p.replyOptions.map((o) => (
              <Button key={o} onClick={() => void done(o)} disabled={busy}>
                {o}
              </Button>
            ))
          ) : (
            <Button onClick={() => void done()} disabled={busy} variant="destructive">
              <CheckCircle2 /> {p.requireAck ? '확인' : '읽음 · 닫기'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
