import { useCallback, useEffect, useState } from 'react'
import { format } from 'date-fns'
import { CheckCircle2, ExternalLink, Loader2, Siren } from 'lucide-react'
import type { UrgentPayload } from '@shared/schemas/notices'
import { Button } from '@renderer/components/ui/button'
import { RichView } from '@renderer/components/Editor'
import { invoke, onMain } from '@renderer/lib/bridge'
import { api, ApiError, errorMessage } from '@renderer/lib/api'
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
  /** why confirming did not work: the notice is over ('gone'), or the server cannot be reached ('offline') */
  const [stuck, setStuck] = useState<'' | 'gone' | 'offline'>('')

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
      // The window can be up before the connection details are loaded (it opens the moment the
      // program starts): wait for them, and give a server that is just coming up a few tries.
      if (!useConn.getState().serverUrl) await load()
      for (let i = 0; ; i++) {
        try {
          if (p.requireAck) await api.post(`/api/notices/${p.id}/ack`, reply ? { reply } : {})
          else await api.post(`/api/notices/${p.id}/read`)
          break
        } catch (e) {
          const net = e instanceof ApiError && (e.code === 'NETWORK' || e.code === 'NO_SERVER')
          if (!net || i >= 4) throw e
          await new Promise((r) => setTimeout(r, 1500))
        }
      }
      await invoke('notify:closeUrgent', { id: p.id })
    } catch (e) {
      setBusy(false)
      const gone = e instanceof ApiError && (e.status === 404 || (e.status === 400 && e.message.includes('수신 대상')))
      if (gone) {
        // The server knows the notice but it no longer waits for this person: deleted or ended
        // by the sender, expired, or not addressed to me any more. Nothing is left to confirm.
        setStuck('gone')
        setErr('이미 끝났거나 지워진 긴급공지입니다. 창을 닫습니다.')
        window.setTimeout(() => void invoke('notify:closeUrgent', { id: p.id }), 2500)
        return
      }
      // The server cannot be reached (or does not accept this PC right now): the window must
      // not hold the screen for ever. It may be closed; it comes back once the server answers,
      // because the notice is still unconfirmed there.
      const unreachable = !(e instanceof ApiError) || e.status === 0 || e.status >= 500 || e.status === 401 || e.status === 403 || e.status === 426
      if (unreachable) setStuck('offline')
      setErr(e instanceof ApiError && (e.code === 'NETWORK' || e.code === 'NO_SERVER') ? '서버에 연결되지 않아 확인을 보내지 못했습니다.' : errorMessage(e))
    }
  }

  // A window without its notice (the program was restarted underneath it) has nothing to show.
  useEffect(() => {
    if (p) return
    const t = window.setTimeout(() => void invoke('notify:closeUrgent', { id }), 8000)
    return () => window.clearTimeout(t)
  }, [p, id])

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
      {err && (
        <p className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 bg-black/30 px-5 py-1.5 text-sm font-semibold" role="alert" data-testid="urgent-error">
          <span>{err}</span>
          {stuck === 'offline' && (
            <>
              <span className="font-normal opacity-90">다시 눌러 보거나, 지금은 닫아 둘 수 있습니다(서버에 연결되면 다시 뜹니다).</span>
              <button className="ml-auto cursor-pointer rounded-md border border-white/70 px-2.5 py-1 text-sm hover:bg-white/15" onClick={() => void invoke('notify:closeUrgent', { id: p.id })} data-testid="urgent-dismiss">
                지금은 닫기
              </button>
            </>
          )}
        </p>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2 bg-black/25 px-5 py-3">
        <button className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-sm underline-offset-2 hover:underline" onClick={() => void invoke('window:showMain', { path: `/notices/${p.id}` })}>
          <ExternalLink className="size-4" /> 공지에서 보기
        </button>
        <div className="ml-auto flex items-center gap-2">
          {busy && <Loader2 className="size-5 animate-spin" />}
          {p.requireAck && p.replyOptions.length ? (
            p.replyOptions.map((o) => (
              <Button key={o} size="lg" className="bg-white font-bold text-urgent hover:bg-white/90" onClick={() => void done(o)} disabled={busy || stuck === 'gone'}>
                {o}
              </Button>
            ))
          ) : (
            <Button size="lg" className="bg-white px-8 text-base font-extrabold text-urgent hover:bg-white/90" onClick={() => void done()} disabled={busy || stuck === 'gone'} autoFocus>
              <CheckCircle2 /> {p.requireAck ? '확인' : '읽음 · 닫기'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
