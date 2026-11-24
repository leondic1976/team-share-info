import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { format } from 'date-fns'
import { AppWindow, Hand, Loader2, Monitor, MessageSquare, Mic, MicOff, MonitorUp, MonitorX, NotebookText, PhoneOff, Send, Users, Video, VideoOff, Power } from 'lucide-react'
import { RECOMMENDED_VIDEO_PEERS, type MeetingDto } from '@shared/schemas/meetings'
import { Button } from '@renderer/components/ui/button'
import { Select } from '@renderer/components/ui/input'
import { Dialog } from '@renderer/components/Dialog'
import { invoke } from '@renderer/lib/bridge'
import { api, authHeaders, buildUrl, errorMessage } from '@renderer/lib/api'
import { realtime } from '@renderer/lib/realtime'
import { useConn } from '@renderer/app/conn-store'
import { cn } from '@renderer/lib/utils'
import { Room, type PeerView } from './rtc'

function VideoEl({ stream, muted, className, testId }: { stream: MediaStream | null; muted?: boolean; className?: string; testId?: string }): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream
  }, [stream])
  return <video ref={ref} autoPlay playsInline muted={muted} className={className} data-testid={testId} />
}

function Tile({ name, stream, cam, mic, hand, level, local, conn }: { name: string; stream: MediaStream | null; cam: boolean; mic: boolean; hand: boolean; level: number; local?: boolean; conn?: string }): React.JSX.Element {
  const speaking = mic && level > 0.08
  return (
    <div className={cn('relative flex aspect-video min-h-0 items-center justify-center overflow-hidden rounded-lg bg-slate-800 ring-2', speaking ? 'ring-green-400' : 'ring-transparent')} data-testid={local ? 'tile-me' : 'tile-peer'} data-name={name}>
      {stream && cam ? <VideoEl stream={stream} muted={local} className={cn('h-full w-full object-cover', local && '-scale-x-100')} testId={local ? 'video-me' : 'video-peer'} /> : <div className="flex size-16 items-center justify-center rounded-full bg-slate-600 text-2xl font-bold text-white">{name.slice(0, 1)}</div>}
      {/* audio of remote peers plays even when their camera is off */}
      {!local && stream && !cam && <VideoEl stream={stream} className="hidden" />}
      <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
        {mic ? <Mic className="size-3" /> : <MicOff className="size-3 text-red-400" />} {name}
        {local && ' (나)'}
      </div>
      {hand && <div className="absolute right-1.5 top-1.5 rounded bg-amber-400 px-1.5 py-0.5 text-xs font-semibold text-slate-900"><Hand className="mr-0.5 inline size-3.5 align-[-0.15em]" aria-hidden />손들기</div>}
      {conn && conn !== 'connected' && <div className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">{conn === 'failed' ? '연결 실패 · 다시 시도 중' : '연결 중…'}</div>}
    </div>
  )
}

function ScreenPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (id: string, kind: 'screen' | 'window', displayId: string, audio: boolean) => void }): React.JSX.Element {
  const [list, setList] = useState<Awaited<ReturnType<typeof listSources>>>([])
  const [audio, setAudio] = useState(false)
  useEffect(() => {
    if (open) void listSources().then(setList)
  }, [open])
  return (
    <Dialog open={open} onClose={onClose} title="공유할 화면·창 고르기" width="max-w-3xl">
      <div className="grid grid-cols-3 gap-3" data-testid="screen-picker">
        {list.map((s) => (
          <button key={s.id} className="cursor-pointer rounded-md border border-border p-2 text-left hover:border-primary hover:bg-muted" onClick={() => onPick(s.id, s.kind, s.displayId, audio)}>
            <img src={s.thumbnail} alt="" className="aspect-video w-full rounded bg-slate-900 object-contain" />
            <span className="mt-1 flex items-center gap-1 text-xs">
              {s.kind === 'screen' ? <Monitor className="size-3.5 shrink-0" aria-label="화면" /> : <AppWindow className="size-3.5 shrink-0" aria-label="창" />}
              <span className="truncate">{s.name}</span>
            </span>
          </button>
        ))}
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} /> 컴퓨터 소리도 함께 공유(전체 화면일 때)
      </label>
    </Dialog>
  )
}
const listSources = () => invoke('meeting:sources')

/** Meeting window (#/popup/meeting/:id): lobby → mesh call with screen sharing (6.17). */
export function MeetingRoom({ id }: { id: string }): React.JSX.Element {
  const loadConn = useConn((s) => s.load)
  const me = useConn((s) => s.memberId)
  const online = useConn((s) => s.state === 'online')
  const [meeting, setMeeting] = useState<MeetingDto | null>(null)
  const [phase, setPhase] = useState<'lobby' | 'in' | 'ended'>('lobby')
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  const room = useRef<Room | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [dev, setDev] = useState<{ audio?: string; video?: string }>({})
  const [wantMic, setWantMic] = useState(true)
  const [wantCam, setWantCam] = useState(true)
  const [panel, setPanel] = useState<'chat' | 'people' | null>(null)
  const [picker, setPicker] = useState(false)
  const [text, setText] = useState('')
  const [joining, setJoining] = useState(false)

  const names = useMemo(() => Object.fromEntries((meeting?.participants ?? []).map((p) => [p.memberId, p.name])), [meeting])

  // Load connection info, start realtime in this window, fetch the meeting, prepare preview.
  useEffect(() => {
    let alive = true
    void (async () => {
      const c = await invoke('conn:get')
      loadConn(c)
      realtime.start()
      try {
        const m = await api.get<MeetingDto>(`/api/meetings/${id}`)
        if (!alive) return
        setMeeting(m)
        if (m.state === 'ended') setPhase('ended')
        if (m.mode === 'screen') setWantCam(false)
        if (c.memberId) {
          const r = new Room(id, c.memberId)
          room.current = r
          ;(window as unknown as { __teamhubRoom?: Room }).__teamhubRoom = r // for diagnostics (E2E)
          r.subscribe(rerender)
          const n = await r.openMedia({ audio: true, video: m.mode === 'video' })
          if (n) setNote(n)
          setDevices(await navigator.mediaDevices.enumerateDevices())
        }
      } catch (e) {
        setErr(errorMessage(e))
      }
    })()
    return () => {
      alive = false
      room.current?.close()
      realtime.stop()
    }
  }, [id, loadConn])

  // Participants come and go.
  useEffect(() => {
    const off = realtime.on('meeting.changed', (p) => {
      const m = p as { id: string; joined?: string; left?: string; ended?: boolean }
      if (m.id !== id) return
      if (m.left) room.current?.remove(m.left)
      if (m.ended) {
        room.current?.stopScreen()
        void invoke('meeting:border', { on: false })
        setPhase('ended')
      }
      void api.get<MeetingDto>(`/api/meetings/${id}`).then((mt) => {
        setMeeting(mt)
        if (phase === 'in' && m.joined && m.joined !== me) room.current?.connect([m.joined])
      })
    })
    return off
  }, [id, phase, me])

  // Leave when the window closes.
  useEffect(() => {
    const leave = (): void => {
      if (phase !== 'in') return
      void fetch(buildUrl(`/api/meetings/${id}/leave`), { method: 'POST', headers: authHeaders(), keepalive: true }).catch(() => undefined)
    }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [id, phase])

  const r = room.current
  const join = async (): Promise<void> => {
    if (!r) return
    setJoining(true)
    try {
      const m = await api.post<MeetingDto>(`/api/meetings/${id}/join`)
      setMeeting(m)
      const others = m.participants.filter((p) => !p.leftAt && p.memberId !== me)
      // Over the recommended size, people join with cameras off (6.17 인원 기준).
      const tooMany = others.length + 1 > RECOMMENDED_VIDEO_PEERS && m.hostId !== me
      r.setMic(wantMic)
      r.setCam(wantCam && !tooMany)
      if (tooMany && wantCam) setNote(`참가자가 ${RECOMMENDED_VIDEO_PEERS}명을 넘어 카메라를 끄고 들어왔습니다. 필요하면 켜세요.`)
      r.connect(others.map((p) => p.memberId))
      setPhase('in')
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setJoining(false)
    }
  }
  const leave = async (): Promise<void> => {
    r?.stopScreen()
    void invoke('meeting:border', { on: false })
    await api.post(`/api/meetings/${id}/leave`).catch(() => undefined)
    window.close()
  }
  const endAll = async (): Promise<void> => {
    if (!window.confirm('모든 참가자의 회의를 끝낼까요?')) return
    await api.post(`/api/meetings/${id}/end`).catch((e: unknown) => setErr(errorMessage(e)))
  }
  const pick = async (sourceId: string, kind: 'screen' | 'window', displayId: string, audio: boolean): Promise<void> => {
    setPicker(false)
    if (!r) return
    try {
      await invoke('meeting:chooseSource', { id: sourceId, audio })
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio })
      stream.getVideoTracks()[0].contentHint = 'detail'
      await r.shareScreen(stream)
      if (kind === 'screen') void invoke('meeting:border', { on: true, displayId })
      stream.getVideoTracks()[0].addEventListener('ended', () => void invoke('meeting:border', { on: false }))
    } catch (e) {
      setErr(`화면 공유를 시작하지 못했습니다: ${(e as Error).message}`)
    }
  }
  const stopShare = (): void => {
    r?.stopScreen()
    void invoke('meeting:border', { on: false })
  }
  const writeMinutes = (): void => {
    if (!meeting) return
    const people = meeting.participants.map((p) => p.name).join(', ')
    const body = `<h2>회의 정보</h2><p>일시: ${format(meeting.startedAt, 'yyyy-MM-dd HH:mm')}</p><p>참석: ${people}</p><h2>안건</h2><p></p><h2>결정 사항</h2><p></p>`
    const qs = new URLSearchParams({ new: 'minutes', title: `회의록 - ${meeting.title} (${format(meeting.startedAt, 'M/d')})`, body, ...(meeting.eventId ? { eventId: meeting.eventId } : {}) })
    void invoke('window:showMain', { path: `/docs/minutes?${qs.toString()}` })
  }

  if (err && !meeting) return <div className="flex h-full items-center justify-center bg-slate-900 p-6 text-sm text-red-300">{err}</div>
  if (!meeting || !r || !me) return <div className="flex h-full items-center justify-center bg-slate-900 text-slate-300"><Loader2 className="animate-spin" /></div>

  const views = r.views()
  const sharer = r.screen ? { id: me, stream: r.screen } : (views.find((v) => v.screen) ? { id: views.find((v) => v.screen)!.id, stream: views.find((v) => v.screen)!.screen! } : null)
  const audioIns = devices.filter((d) => d.kind === 'audioinput')
  const videoIns = devices.filter((d) => d.kind === 'videoinput')
  const isHost = meeting.hostId === me

  if (phase === 'lobby')
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-slate-900 p-6 text-white" data-testid="meeting-lobby">
        <h1 className="text-xl font-bold">{meeting.title}</h1>
        <p className="text-sm text-slate-300">
          {meeting.hostName}님의 {meeting.mode === 'screen' ? '화면 공유' : '회의'} · 참가 중 {meeting.participants.filter((p) => !p.leftAt).length}명
        </p>
        <div className="w-full max-w-lg">
          <Tile name="나" stream={r.local} cam={wantCam && r.local.getVideoTracks().length > 0} mic={wantMic} hand={false} level={r.localLevel} local />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant={wantMic ? 'secondary' : 'destructive'} onClick={() => setWantMic(!wantMic)} disabled={!r.local.getAudioTracks().length}>
            {wantMic ? <Mic /> : <MicOff />} 마이크
          </Button>
          <Button variant={wantCam ? 'secondary' : 'destructive'} onClick={() => setWantCam(!wantCam)} disabled={!r.local.getVideoTracks().length}>
            {wantCam ? <Video /> : <VideoOff />} 카메라
          </Button>
          {audioIns.length > 1 && (
            <Select aria-label="마이크 선택" className="w-48 text-slate-900" value={dev.audio ?? ''} onChange={(e) => (setDev({ ...dev, audio: e.target.value }), void r.openMedia({ audio: true, video: meeting.mode === 'video', audioId: e.target.value, videoId: dev.video }))}>
              <option value="">기본 마이크</option>
              {audioIns.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || '마이크'}
                </option>
              ))}
            </Select>
          )}
          {videoIns.length > 1 && (
            <Select aria-label="카메라 선택" className="w-48 text-slate-900" value={dev.video ?? ''} onChange={(e) => (setDev({ ...dev, video: e.target.value }), void r.openMedia({ audio: true, video: true, audioId: dev.audio, videoId: e.target.value }))}>
              <option value="">기본 카메라</option>
              {videoIns.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || '카메라'}
                </option>
              ))}
            </Select>
          )}
        </div>
        {note && <p className="text-sm text-amber-300">{note} 음성·화면만으로 참가할 수 있습니다.</p>}
        {err && <p className="text-sm text-red-300">{err}</p>}
        <div className="flex gap-2">
          <Button size="lg" disabled={joining || !online} onClick={() => void join()}>
            {joining ? <Loader2 className="animate-spin" /> : null} 참가
          </Button>
          <Button size="lg" variant="ghost" className="text-white" onClick={() => window.close()}>
            닫기
          </Button>
        </div>
      </div>
    )

  if (phase === 'ended')
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-slate-900 text-white" data-testid="meeting-ended">
        <p className="text-lg font-semibold">회의가 끝났습니다.</p>
        <div className="flex gap-2">
          <Button onClick={writeMinutes}>
            <NotebookText /> 회의록 작성
          </Button>
          <Button variant="secondary" onClick={() => window.close()}>
            닫기
          </Button>
        </div>
      </div>
    )

  const tiles = (
    <>
      <Tile name={names[me] ?? '나'} stream={r.local} cam={r.cam} mic={r.mic} hand={r.hand} level={r.localLevel} local />
      {views.map((v: PeerView) => (
        <Tile key={v.id} name={names[v.id] ?? '참가자'} stream={v.camera} cam={v.state.cam} mic={v.state.mic} hand={v.state.hand} level={v.level} conn={v.connection} />
      ))}
    </>
  )
  const cols = views.length + 1 <= 1 ? 1 : views.length + 1 <= 4 ? 2 : 3

  return (
    <div className="flex h-full flex-col bg-slate-900 text-white" data-testid="meeting-room">
      <div className="flex shrink-0 items-center gap-2 px-4 py-2 text-sm">
        <span className="font-semibold">{meeting.title}</span>
        <span className="text-slate-400">· {views.length + 1}명</span>
        {sharer && <span className="rounded bg-red-600 px-2 py-0.5 text-xs">{sharer.id === me ? '내 화면 공유 중' : `${names[sharer.id] ?? ''} 화면 공유 중`}</span>}
        {note && <span className="text-xs text-amber-300">{note}</span>}
        {err && <span className="text-xs text-red-300">{err}</span>}
      </div>
      <div className="flex min-h-0 flex-1 gap-2 px-3 pb-2">
        {sharer ? (
          <div className="flex min-w-0 flex-1 gap-2">
            <div
              className="relative min-w-0 flex-1 overflow-hidden rounded-lg bg-black"
              onClick={(e) => {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                r.sendPointer((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height)
              }}
              title="누르면 모두에게 그 위치를 표시합니다"
            >
              <VideoEl stream={sharer.stream} muted={sharer.id === me} className="h-full w-full object-contain" testId="video-screen" />
              {r.pointer && Date.now() - r.pointer.at < 2500 && (
                <span key={r.pointer.at} className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-4 border-red-500" style={{ left: `${r.pointer.x * 100}%`, top: `${r.pointer.y * 100}%` }} />
              )}
            </div>
            <div className="flex w-56 shrink-0 flex-col gap-2 overflow-y-auto">{tiles}</div>
          </div>
        ) : (
          <div className="grid min-w-0 flex-1 content-center gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {tiles}
          </div>
        )}
        {panel && (
          <aside className="flex w-72 shrink-0 flex-col rounded-lg bg-slate-800">
            {panel === 'people' ? (
              <div className="space-y-1 p-3 text-sm" data-testid="meeting-people">
                <p className="mb-2 font-semibold">참가자</p>
                {meeting.participants.filter((p) => !p.leftAt).map((p) => {
                  const v = views.find((x) => x.id === p.memberId)
                  return (
                    <div key={p.memberId} className="flex items-center gap-2">
                      <span className="flex-1 truncate">
                        {p.name}
                        {p.memberId === meeting.hostId && ' · 연 사람'}
                      </span>
                      {(p.memberId === me ? r.hand : v?.state.hand) && <Hand className="size-3.5 text-amber-400" aria-label="손들기" />}
                      {(p.memberId === me ? r.mic : v?.state.mic) ? <Mic className="size-3.5" /> : <MicOff className="size-3.5 text-red-400" />}
                    </div>
                  )
                })}
              </div>
            ) : (
              <>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-sm" data-testid="meeting-chat">
                  {r.chat.map((c, i) => (
                    <div key={i}>
                      <span className="text-xs text-slate-400">
                        {names[c.from] ?? '참가자'} · {format(c.at, 'HH:mm')}
                      </span>
                      <p className="selectable whitespace-pre-wrap break-words">{c.text}</p>
                    </div>
                  ))}
                  {!r.chat.length && <p className="text-xs text-slate-400">회의 중 대화는 저장되지 않습니다.</p>}
                </div>
                <form
                  className="flex gap-1 border-t border-slate-700 p-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (text.trim()) r.sendChat(text.trim())
                    setText('')
                  }}
                >
                  <input aria-label="회의 대화 입력" className="min-w-0 flex-1 rounded bg-slate-700 px-2 py-1 text-sm outline-none" value={text} onChange={(e) => setText(e.target.value)} />
                  <Button size="icon-sm" type="submit" aria-label="보내기">
                    <Send />
                  </Button>
                </form>
              </>
            )}
          </aside>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-center gap-2 border-t border-slate-800 py-2.5">
        <Button variant={r.mic ? 'secondary' : 'destructive'} onClick={() => r.setMic(!r.mic)} disabled={!r.local.getAudioTracks().length} aria-label={r.mic ? '마이크 끄기' : '마이크 켜기'}>
          {r.mic ? <Mic /> : <MicOff />}
        </Button>
        <Button variant={r.cam ? 'secondary' : 'destructive'} onClick={() => r.setCam(!r.cam)} disabled={!r.local.getVideoTracks().length} aria-label={r.cam ? '카메라 끄기' : '카메라 켜기'}>
          {r.cam ? <Video /> : <VideoOff />}
        </Button>
        {r.screen ? (
          <Button variant="destructive" onClick={stopShare}>
            <MonitorX /> 공유 중지
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => setPicker(true)}>
            <MonitorUp /> 화면 공유
          </Button>
        )}
        <Button variant={r.hand ? 'default' : 'secondary'} onClick={() => r.setHand(!r.hand)} aria-label="손들기">
          <Hand />
        </Button>
        <Button variant={panel === 'chat' ? 'default' : 'secondary'} onClick={() => setPanel(panel === 'chat' ? null : 'chat')} aria-label="회의 대화">
          <MessageSquare />
        </Button>
        <Button variant={panel === 'people' ? 'default' : 'secondary'} onClick={() => setPanel(panel === 'people' ? null : 'people')} aria-label="참가자">
          <Users />
        </Button>
        <Button variant="destructive" onClick={() => void leave()}>
          <PhoneOff /> 나가기
        </Button>
        {isHost && (
          <Button variant="ghost" className="text-red-300" onClick={() => void endAll()}>
            <Power /> 회의 끝내기
          </Button>
        )}
      </div>
      <ScreenPicker open={picker} onClose={() => setPicker(false)} onPick={(sid, kind, did, audio) => void pick(sid, kind, did, audio)} />
    </div>
  )
}
