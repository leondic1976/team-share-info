import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { MonitorUp, Plus, Users, Video } from 'lucide-react'
import type { MeetingDto, MeetingInput, MeetingInvitePayload } from '@shared/schemas/meetings'
import type { ScopeInput } from '@shared/schemas/scope'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Input, Label } from '@renderer/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Dialog } from '@renderer/components/Dialog'
import { EmptyState, OfflineState } from '@renderer/components/EmptyState'
import { ScopePicker, ScopeTags, defaultScope, scopeIsValid } from '@renderer/components/ScopePicker'
import { api, errorMessage } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { useConn } from '@renderer/app/conn-store'
import { useSpace } from '@renderer/app/space-store'

export const useLiveMeetings = () => {
  const online = useConn((s) => s.state === 'online')
  return useQuery({ queryKey: ['meetings', 'live'], queryFn: () => api.get<MeetingDto[]>('/api/meetings', { state: 'live' }), enabled: online, refetchInterval: 60_000 })
}

/** Start a meeting and open its window. Used by chat, groups and calendar too. */
export async function startMeeting(input: MeetingInput): Promise<MeetingDto> {
  const m = await api.post<MeetingDto>('/api/meetings', input)
  await invoke('meeting:open', { id: m.id })
  return m
}

/** Invite pop-ups for meetings and the live meeting count (main window). */
export function useMeetingAlerts(): void {
  const qc = useQueryClient()
  useEffect(() => {
    const off1 = realtime.on('meeting.invite', (p) => void invoke('meeting:invite', p as MeetingInvitePayload))
    const off2 = realtime.on('meeting.changed', () => void qc.invalidateQueries({ queryKey: ['meetings'] }))
    return () => {
      off1()
      off2()
    }
  }, [qc])
}

export function NewMeetingDialog({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: Partial<MeetingInput> | null }): React.JSX.Element {
  const space = useSpace((s) => s.space)
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<'video' | 'screen'>('video')
  const [scope, setScope] = useState<ScopeInput>(defaultScope(space))
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!open) return
    setErr('')
    setTitle(initial?.title ?? '')
    setMode(initial?.mode ?? 'video')
    setScope((initial?.scope as ScopeInput) ?? { type: 'members', groupIds: [], memberIds: [] })
  }, [open, initial])
  const start = useMutation({
    mutationFn: () => startMeeting({ title, mode, scope, conversationId: initial?.conversationId ?? null, eventId: initial?.eventId ?? null }),
    onSuccess: () => onClose(),
    onError: (e) => setErr(errorMessage(e))
  })
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="회의 시작"
      footer={
        <Button disabled={!title.trim() || !scopeIsValid(scope) || start.isPending} onClick={() => start.mutate()}>
          {mode === 'video' ? <Video /> : <MonitorUp />} 시작
        </Button>
      }
    >
      <div className="space-y-3">
        <div>
          <Label htmlFor="mt-title">회의 제목</Label>
          <Input id="mt-title" maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 주간 업무 회의" />
        </div>
        <div className="flex gap-1" role="radiogroup" aria-label="회의 방식">
          <Button role="radio" aria-checked={mode === 'video'} size="sm" variant={mode === 'video' ? 'default' : 'outline'} onClick={() => setMode('video')}>
            <Video /> 영상 회의
          </Button>
          <Button role="radio" aria-checked={mode === 'screen'} size="sm" variant={mode === 'screen' ? 'default' : 'outline'} onClick={() => setMode('screen')}>
            <MonitorUp /> 화면만 공유
          </Button>
        </div>
        <div>
          <Label>참가할 사람(공개 범위)</Label>
          <ScopePicker value={scope} onChange={setScope} />
          <p className="mt-1 text-xs text-muted-foreground">지정한 사람·그룹에게는 초대 창이 뜹니다. 팀 전체로 열면 회의 목록에만 보입니다. 영상은 6명까지 권장(최대 8명)입니다.</p>
        </div>
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}

/** Meetings list (6.17): live meetings I can see, start a new one. */
export function MeetingsPage(): React.JSX.Element {
  const online = useConn((s) => s.state === 'online')
  const location = useLocation()
  const navigate = useNavigate()
  const live = useLiveMeetings()
  const recent = useQuery({ queryKey: ['meetings', 'all'], queryFn: () => api.get<MeetingDto[]>('/api/meetings', { state: 'ended' }), enabled: online })
  const [open, setOpen] = useState(false)
  const [initial, setInitial] = useState<Partial<MeetingInput> | null>(null)
  useEffect(() => {
    const s = location.state as { newMeeting?: Partial<MeetingInput> } | null
    if (s?.newMeeting) {
      setInitial(s.newMeeting)
      setOpen(true)
      navigate('/meetings', { replace: true, state: null })
    }
  }, [location.state, navigate])
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="회의"
        description="PC끼리 직접 연결합니다. 영상·음성·화면은 어디에도 저장되지 않습니다."
        actions={
          <Button size="sm" disabled={!online} onClick={() => (setInitial(null), setOpen(true))}>
            <Plus /> 회의 시작
          </Button>
        }
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {!online && !live.data ? (
          <OfflineState />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>진행 중인 회의</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 p-2" data-testid="live-meetings">
              {!live.data?.length && <EmptyState icon={Video} title="진행 중인 회의가 없습니다" />}
              {live.data?.map((m) => (
                <div key={m.id} className="flex items-center gap-3 rounded px-3 py-2 hover:bg-muted" data-testid="live-meeting">
                  {m.mode === 'video' ? <Video className="size-5 text-primary" /> : <MonitorUp className="size-5 text-primary" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{m.title}</p>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {m.hostName} · {format(m.startedAt, 'HH:mm')} 시작 · <Users className="size-3" /> {m.participants.filter((p) => !p.leftAt).map((p) => p.name).join(', ')}
                      <ScopeTags scope={m.scope} />
                    </p>
                  </div>
                  <Button onClick={() => void invoke('meeting:open', { id: m.id })}>참가</Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
        {!!recent.data?.length && (
          <Card>
            <CardHeader>
              <CardTitle>지난 회의</CardTitle>
            </CardHeader>
            <CardContent className="space-y-0.5 p-2">
              {recent.data.slice(0, 20).map((m) => (
                <div key={m.id} className="flex items-center gap-2 rounded px-3 py-1.5 text-sm">
                  <span className="w-28 shrink-0 text-xs text-muted-foreground">{format(m.startedAt, 'M/d HH:mm')}</span>
                  <span className="truncate font-medium">{m.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{m.participants.map((p) => p.name).join(', ')}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
      <NewMeetingDialog open={open} onClose={() => setOpen(false)} initial={initial} />
    </div>
  )
}

/** Home widget: live meetings with a join button (shown only when there are any). */
export function LiveMeetingsWidget(): React.JSX.Element | null {
  const live = useLiveMeetings()
  if (!live.data?.length) return null
  return (
    <Card data-testid="widget-meetings">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Video className="size-4" /> 진행 중인 회의
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 p-2">
        {live.data.map((m) => (
          <div key={m.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
            <span className="size-2 animate-pulse rounded-full bg-red-500" />
            <span className="truncate font-medium">{m.title}</span>
            <span className="truncate text-xs text-muted-foreground">{m.hostName} · {m.participants.filter((p) => !p.leftAt).length}명</span>
            <Button size="sm" className="ml-auto" onClick={() => void invoke('meeting:open', { id: m.id })}>
              참가
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
