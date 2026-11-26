import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Send, Users } from 'lucide-react'
import type { SentAlarmDto } from '@shared/schemas/tools'
import { Button } from '@renderer/components/ui/button'
import { Input, Label, Textarea } from '@renderer/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { OfflineState, EmptyNote } from '@renderer/components/EmptyState'
import { MemberPicker } from '@renderer/components/ScopePicker'
import { api, errorMessage } from '@renderer/lib/api'
import { fromInputValue, toInputValue } from '@renderer/lib/dates'
import { useConn } from '@renderer/app/conn-store'
import { confirmPii } from '@renderer/lib/pii'
import type { PiiAck } from '@shared/pii'
import { DateTimeInput } from '@renderer/components/DateTimeInput'
import { RoleMark } from '@renderer/components/RoleMark'

/** Alarms sent to other members: they ring on the receiver's PC at the chosen time (6.12 ②). */
export function TeamAlarmsView(): React.JSX.Element {
  const qc = useQueryClient()
  const online = useConn((s) => s.state === 'online')
  const [toIds, setToIds] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [fireAt, setFireAt] = useState(() => Math.ceil((Date.now() + 1800_000) / 600_000) * 600_000)
  const [immediate, setImmediate] = useState(false)
  const [msg, setMsg] = useState('')
  const sent = useQuery({ queryKey: ['team-alarms', 'sent'], queryFn: () => api.get<SentAlarmDto[]>('/api/alarms/sent'), enabled: online })
  const received = useQuery({ queryKey: ['team-alarms', 'received'], queryFn: () => api.get<SentAlarmDto[]>('/api/alarms/received'), enabled: online })
  const send = useMutation({
    // 즉시: the time is taken when 보내기 is pressed (by the server), not when 즉시 was chosen
    mutationFn: ({ now, pii }: { now: boolean; pii: PiiAck }) => api.post<{ ids: string[] }>('/api/alarms', { toIds, fireAt: now ? Date.now() : fireAt, immediate: now, title, body, ...pii }),
    onSuccess: (r, { now }) => {
      setMsg(now ? `${r.ids.length}명에게 알람을 즉시 보냈습니다.` : `${r.ids.length}명에게 ${format(fireAt, 'M/d HH:mm')} 알람을 보냈습니다.`)
      setTitle('')
      setBody('')
      void qc.invalidateQueries({ queryKey: ['team-alarms'] })
    },
    onError: (e) => setMsg(errorMessage(e))
  })
  const cancel = useMutation({ mutationFn: (id: string) => api.del(`/api/alarms/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['team-alarms'] }) })
  if (!online && !sent.data) return <OfflineState />
  const state = (a: SentAlarmDto): string => (a.dismissedAt ? `확인 ${format(a.dismissedAt, 'HH:mm')}` : a.deliveredAt ? '전달됨' : a.fireAt > Date.now() ? '예약' : '전달 대기')
  return (
    <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <Send className="size-4" /> 팀원에게 알람 보내기
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">정한 시각에 받는 사람 PC에서 알람 창이 뜨고 소리가 납니다. 꼭 그 시각에 챙겨야 할 일에 쓰세요.</p>
          <MemberPicker value={toIds} onChange={setToIds} excludeSelf selectAll />
          <div>
            <Label htmlFor="ta-title">알람 내용</Label>
            <Input id="ta-title" maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 14시 회의 자료 지참" />
          </div>
          <Textarea aria-label="덧붙일 말" rows={2} maxLength={500} value={body} onChange={(e) => setBody(e.target.value)} placeholder="덧붙일 말 (선택)" />
          <div className="flex items-center gap-2">
            <Label>울릴 일시</Label>
            <DateTimeInput label="울릴 일시" minuteStep={1} disabled={immediate} value={toInputValue(fireAt)} onChange={(v) => v && setFireAt(fromInputValue(v))} />
            <Button size="sm" variant={immediate ? 'default' : 'outline'} aria-pressed={immediate} onClick={() => setImmediate((v) => !v)}>
              즉시
            </Button>
          </div>
          {immediate && <p className="text-xs text-muted-foreground">보내기를 누르는 바로 그때 울립니다. 시각을 정하려면 즉시를 다시 누르세요.</p>}
          <Button disabled={!toIds.length || !title.trim() || send.isPending} onClick={() => {
              const pii = confirmPii([title, body])
              if (pii) send.mutate({ now: immediate, pii })
            }}
          >
            <Send /> {immediate ? '즉시 보내기' : '보내기'}
          </Button>
          {msg && (
            <p className="text-sm text-primary" role="status">
              {msg}
            </p>
          )}
          <p className="text-xs text-muted-foreground">받는 사람이 그 시각에 꺼져 있으면 다음에 켤 때(24시간 안) 울립니다.</p>
        </CardContent>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>보낸 알람</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 p-2" data-testid="sent-alarms">
            {!sent.data?.length && <EmptyNote>보낸 알람이 없습니다.</EmptyNote>}
            {sent.data?.map((a) => (
              <div key={a.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">{format(a.fireAt, 'M/d HH:mm')}</span>
                <span className="shrink-0 font-medium">
                  {a.toName}
                  <RoleMark memberId={a.toId} />
                </span>
                <span className="truncate">{a.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{state(a)}</span>
                {!a.deliveredAt && (
                  <Button size="sm" variant="ghost" onClick={() => cancel.mutate(a.id)}>
                    취소
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <Users className="size-4" /> 받은 알람
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 p-2">
            {!received.data?.length && <EmptyNote>받은 알람이 없습니다.</EmptyNote>}
            {received.data?.map((a) => (
              <div key={a.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">{format(a.fireAt, 'M/d HH:mm')}</span>
                <span className="shrink-0 font-medium">
                  {a.fromName}
                  <RoleMark memberId={a.fromId} />
                </span>
                <span className="truncate">{a.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{a.dismissedAt ? '확인함' : a.fireAt > Date.now() ? '예정' : ''}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
