/**
 * 훈련 창: a window of its own in the middle of the screen (always on top) for the participants of
 * a drill. Orange with a big "훈련" mark — never to be taken for a real 긴급공지 (red). It shows
 * the message to handle and who handles it; somebody who may answer does it right here.
 */
import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Flag, X } from 'lucide-react'
import { HANDLING_LABEL } from '../shared/types'
import { drillElapsedMs, formatClock, waitsFor } from '../shared/logic'
import type { CommandDrillPayload } from '../shared/events'
import { buildModel } from './model'
import { hm } from './model'
import { useCommandLive, useCommandState, useDrill, useServerNow } from './data'
import { useHost } from './host'
import { AnswerBox, MeId } from './DrillView'
import { targetText } from './ScenarioEditor'
import { RichView } from './rich'
import { Badge, Button } from './ui'

/** A short rising three-note sound, unlike the 긴급공지 alarm. */
export function drillTone(): void {
  try {
    const ctx = new AudioContext()
    ;[523.3, 659.3, 784].forEach((f, i) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'triangle'
      o.frequency.value = f
      const t = ctx.currentTime + i * 0.16
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3)
      o.connect(g).connect(ctx.destination)
      o.start(t)
      o.stop(t + 0.32)
    })
    setTimeout(() => void ctx.close(), 1200)
  } catch {
    // no audio
  }
}

export function DrillPopup({ drillId }: { drillId: string }): React.JSX.Element {
  const host = useHost()
  useCommandLive()
  const st = useCommandState()
  const q = useDrill(drillId)
  const d = q.data
  const now = useServerNow(d?.serverNow)
  const seen = useRef<Set<string>>(new Set())
  const [focus, setFocus] = useState<string | null>(null)
  const meId = st.data?.me.id ?? ''

  // a new message (or 다시 알림) for this drill: sound, and it comes to the front
  useEffect(() => {
    drillTone()
    return host.on('command.drill', (raw) => {
      const p = raw as CommandDrillPayload
      if (p.drillId !== drillId) return
      if ((p.kind === 'message' || p.kind === 'remind') && p.msgId) {
        setFocus(p.msgId)
        drillTone()
      }
    })
  }, [host, drillId])

  useEffect(() => {
    if (!d) return
    for (const x of d.messages) if (x.sentAt) seen.current.add(x.id)
    // the drill is over or gone: nothing to do here
    if (d.state === 'ended') {
      const t = window.setTimeout(() => host.closeWindow(), 4000)
      return () => window.clearTimeout(t)
    }
  }, [d, host])

  if (!d || !st.data) return <div className="flex h-screen items-center justify-center bg-orange-600 text-white">불러오는 중…</div>
  const m = buildModel(st.data, now)
  const sent = d.messages.filter((x) => x.sentAt && !x.skipped).sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0))
  const mine = sent.filter((x) => waitsFor(x, meId))
  const msg = (focus && sent.find((x) => x.id === focus)) || mine[mine.length - 1] || sent[0] || null
  const canAnswer = !!msg && waitsFor(msg, meId)
  const close = (): void => host.closeWindow()
  return (
    <MeId.Provider value={meId}>
    <div className="flex h-screen flex-col bg-card text-foreground" data-testid="drill-popup" role="alertdialog" aria-label={`훈련: ${d.title}`}>
      <div className="no-drag flex shrink-0 items-center gap-2 bg-orange-600 px-4 py-2 text-white">
        <Flag className="size-5" />
        <span className="rounded bg-white px-2 py-0.5 text-sm font-extrabold tracking-widest text-orange-700">훈련</span>
        <span className="min-w-0 truncate font-bold">{d.title}</span>
        {d.startedAt && <span className="ml-auto font-mono tabular-nums">{formatClock(drillElapsedMs(d, now))}</span>}
        <button type="button" className="ml-2 flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-sm font-semibold hover:bg-white/15" onClick={close} data-testid="drill-popup-close">
          <X className="size-4" /> 닫기
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
        {!msg ? (
          <div className="space-y-2 text-center">
            <p className="text-2xl font-extrabold">훈련이 시작되었습니다</p>
            <p className="text-sm text-muted-foreground">상황 메시지가 오면 이 창에 나타납니다. 내가 처리할 메시지는 여기서 바로 처리 보고를 할 수 있습니다.</p>
            {d.summaryHtml && <RichView html={d.summaryHtml} className="text-left text-sm" />}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm tabular-nums text-muted-foreground">{msg.sentAt ? hm(msg.sentAt) : ''}</span>
              <h1 className="text-2xl font-extrabold" data-testid="drill-popup-title">
                {msg.title}
              </h1>
              {mine.length > 1 && <Badge tone="urgent">처리할 메시지 {mine.length}건</Badge>}
            </div>
            <p className="rounded-md bg-orange-500/10 px-3 py-1.5 text-sm font-semibold text-orange-800 dark:text-orange-200" data-testid="drill-popup-handler">
              처리 담당: {targetText(m, msg)} · {HANDLING_LABEL[msg.handling]}
              {msg.limitMin ? ` · ${msg.limitMin}분 안` : ''}
            </p>
            {msg.bodyHtml && <RichView html={msg.bodyHtml} className="text-base" />}
            {canAnswer ? (
              <AnswerBox d={d} msg={msg} compact onDone={() => (mine.length <= 1 ? close() : setFocus(null))} />
            ) : (
              <p className="text-sm text-muted-foreground">{msg.done ? '처리되었습니다.' : '이 메시지는 다른 사람이 처리합니다. 상황을 확인하세요.'}</p>
            )}
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2">
        <Button size="sm" variant="ghost" onClick={() => host.showMain(`${host.basePath}/drill/${d.id}`)}>
          <ExternalLink /> 훈련 화면에서 보기
        </Button>
        {mine.length > 1 && (
          <span className="flex flex-wrap gap-1">
            {mine.map((x) => (
              <Button key={x.id} size="sm" variant={x.id === msg?.id ? 'default' : 'outline'} onClick={() => setFocus(x.id)}>
                {x.title}
              </Button>
            ))}
          </span>
        )}
        <Button className="ml-auto bg-orange-600 text-white hover:bg-orange-700" onClick={close} data-testid="drill-popup-ok">
          확인
        </Button>
      </div>
    </div>
    </MeId.Provider>
  )
}
