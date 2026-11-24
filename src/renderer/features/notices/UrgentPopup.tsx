import { useCallback, useEffect, useState } from 'react'
import { format } from 'date-fns'
import { CheckCircle2, ExternalLink, Loader2, Siren } from 'lucide-react'
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

  // Until it is confirmed the alarm sounds again every 20 seconds (at most 15 times: an empty
  // office should not beep all night).
  useEffect(() => {
    let n = 0
    const t = window.setInterval(() => {
      if (++n > 15) window.clearInterval(t)
      else beep()
    }, 20_000)
    return () => window.clearInterval(t)
  }, [])

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

  const hasBody = !!p && p.bodyHtml.replace(/<[^>]*>/g, '').trim().length > 0

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

  if (!p) return <div className="flex h-full items-center justify-center bg-urgent p-6 text-sm text-white">불러오는 중…</div>
  return (
    <div className={`th-emergency flex h-full flex-col bg-urgent text-white ${shake ? 'th-emergency-shake' : ''}`} data-testid="urgent-popup" role="alertdialog" aria-label={`긴급공지: ${p.title}`}>
      <div className="flex shrink-0 items-center gap-2 bg-black/25 px-5 py-2.5">
        <Siren className="th-emergency-blink size-6" aria-hidden />
        <span className="text-lg font-extrabold tracking-wide">긴급공지</span>
        <span className="ml-auto text-sm opacity-90">
          {p.authorName} · {format(p.publishedAt, 'M/d HH:mm')}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-8 py-5 text-center">
        <h1 className="selectable break-keep text-3xl font-extrabold leading-snug">{p.title}</h1>
        {hasBody && (
          <div className="selectable mt-5 max-h-full w-full max-w-2xl overflow-y-auto rounded-lg bg-white px-5 py-4 text-left text-base text-neutral-900">
            <RichView html={p.bodyHtml} />
          </div>
        )}
      </div>
      {err && <p className="shrink-0 bg-black/30 px-5 py-1.5 text-sm font-semibold">{err} — 서버에 연결되면 다시 누르세요.</p>}
      <div className="flex shrink-0 flex-wrap items-center gap-2 bg-black/25 px-5 py-3">
        <button className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-sm underline-offset-2 hover:underline" onClick={() => void invoke('window:showMain', { path: `/notices/${p.id}` })}>
          <ExternalLink className="size-4" /> 공지에서 보기
        </button>
        <div className="ml-auto flex items-center gap-2">
          {busy && <Loader2 className="size-5 animate-spin" />}
          {p.requireAck && p.replyOptions.length ? (
            p.replyOptions.map((o) => (
              <Button key={o} size="lg" className="bg-white font-bold text-urgent hover:bg-white/90" onClick={() => void done(o)} disabled={busy}>
                {o}
              </Button>
            ))
          ) : (
            <Button size="lg" className="bg-white px-8 text-base font-extrabold text-urgent hover:bg-white/90" onClick={() => void done()} disabled={busy} autoFocus>
              <CheckCircle2 /> {p.requireAck ? '확인' : '읽음 · 닫기'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
