import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { ko } from 'date-fns/locale'
import { AlarmClock, BellRing, CheckCircle2, Clock, Plus, Timer, Trash2, Coffee, Brain, Square } from 'lucide-react'
import type { AlarmDto, AlarmInput, AlarmKind } from '@shared/schemas/tools'
import { describeRule } from '@shared/recurrence'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Input, Label, Textarea } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Dialog, confirmDialog } from '@renderer/components/Dialog'
import { EmptyState } from '@renderer/components/EmptyState'
import { invoke, onMain } from '@renderer/lib/bridge'
import { errorMessage } from '@renderer/lib/api'
import { fromInputValue, toInputValue } from '@renderer/lib/dates'
import { cn } from '@renderer/lib/utils'
import { RecurrenceEditor } from '@renderer/features/calendar/RecurrenceEditor'
import { useAlarms, useFocus } from '@renderer/features/memos/tools-api'
import { SOURCE_LABEL, todayReminders } from './useTeamAlarms'
import { DateTimeInput, TimeSelect } from '@renderer/components/DateTimeInput'

const KIND_LABEL: Record<AlarmKind, string> = { once: '한 번', repeat: '반복', deadline: '기한', timer: '타이머' }
const LEADS = [
  { d: 7, label: 'D-7' },
  { d: 3, label: 'D-3' },
  { d: 1, label: 'D-1' },
  { d: 0, label: '마감 시각' }
]
const WEEKDAYS = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'

function at(h: number, m: number): number {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

function describe(a: AlarmDto): string {
  if (a.kind === 'repeat') return `${describeRule(a.rrule)} ${format(a.fireAt, 'HH:mm')}`
  if (a.kind === 'deadline') return `마감 ${format(a.fireAt, 'M/d(EEE) HH:mm', { locale: ko })} · ${a.leadDays.map((d) => (d ? `D-${d}` : '당일')).join(', ')}`
  return format(a.fireAt, 'M/d(EEE) HH:mm', { locale: ko })
}

export function AlarmDialog({ open, onClose, initial }: { open: boolean; onClose: () => void; initial: Partial<AlarmInput> | null }): React.JSX.Element {
  const [f, setF] = useState<AlarmInput>({ title: '', kind: 'once', fireAt: Date.now() + 3600_000 })
  const [timerMin, setTimerMin] = useState(10)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (open) {
      setErr('')
      setF({ title: '', note: '', kind: 'once', fireAt: Math.ceil((Date.now() + 3600_000) / 600_000) * 600_000, rrule: null, leadDays: [7, 3, 1, 0], sound: true, ...initial })
    }
  }, [open, initial])
  const set = (p: Partial<AlarmInput>): void => setF((cur) => ({ ...cur, ...p }))
  const save = async (): Promise<void> => {
    const input = { ...f }
    if (input.kind === 'timer') input.fireAt = Date.now() + timerMin * 60_000
    if (input.kind === 'repeat' && !input.rrule) input.rrule = WEEKDAYS
    if (input.kind !== 'repeat') input.rrule = null
    if ((input.kind === 'once' || input.kind === 'timer') && input.fireAt < Date.now() - 30_000) return setErr('지난 시각입니다.')
    try {
      await invoke('local:alarms.save', input)
      onClose()
    } catch (e) {
      setErr(errorMessage(e))
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={f.id ? '알람 고치기' : '알람 추가'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button disabled={!f.title.trim()} onClick={() => void save()}>
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label htmlFor="al-title">알람 이름</Label>
          <Input id="al-title" maxLength={100} value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="예: 주간 보고 제출" />
        </div>
        <div className="flex gap-1" role="radiogroup" aria-label="알람 종류">
          {(Object.keys(KIND_LABEL) as AlarmKind[]).map((k) => (
            <Button key={k} role="radio" aria-checked={f.kind === k} size="sm" variant={f.kind === k ? 'default' : 'outline'} onClick={() => set({ kind: k, rrule: k === 'repeat' ? (f.rrule ?? WEEKDAYS) : f.rrule })}>
              {KIND_LABEL[k]}
            </Button>
          ))}
        </div>
        {f.kind === 'timer' ? (
          <div className="flex items-center gap-2">
            <Label htmlFor="al-min">몇 분 뒤</Label>
            <Input id="al-min" type="number" min={1} max={600} className="w-24" value={timerMin} onChange={(e) => setTimerMin(Math.max(1, Number(e.target.value) || 1))} />
            {[5, 10, 30, 60].map((m) => (
              <Button key={m} size="sm" variant="ghost" onClick={() => setTimerMin(m)}>
                {m}분
              </Button>
            ))}
          </div>
        ) : f.kind === 'repeat' ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label>시각</Label>
              <TimeSelect
                label="시각"
                minuteStep={1}
                value={format(f.fireAt, 'HH:mm')}
                onChange={(v) => {
                  const [h, m] = v.split(':').map(Number)
                  set({ fireAt: at(h || 0, m || 0) })
                }}
              />
              <Button size="sm" variant="ghost" onClick={() => set({ fireAt: at(11, 50), rrule: WEEKDAYS, title: f.title || '점심 10분 전' })}>
                점심 10분 전
              </Button>
              <Button size="sm" variant="ghost" onClick={() => set({ fireAt: at(17, 50), rrule: WEEKDAYS, title: f.title || '퇴근 10분 전' })}>
                퇴근 10분 전
              </Button>
            </div>
            <RecurrenceEditor value={f.rrule ?? WEEKDAYS} startAt={f.fireAt} onChange={(r) => set({ rrule: r ?? WEEKDAYS })} />
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label>{f.kind === 'deadline' ? '마감 일시' : '울릴 일시'}</Label>
              <DateTimeInput label={f.kind === 'deadline' ? '마감 일시' : '울릴 일시'} minuteStep={1} value={toInputValue(f.fireAt)} onChange={(v) => v && set({ fireAt: fromInputValue(v) })} />
            </div>
            {f.kind === 'deadline' && (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="text-muted-foreground">알림</span>
                {LEADS.map((l) => (
                  <label key={l.d} className="flex cursor-pointer items-center gap-1">
                    <input
                      type="checkbox"
                      checked={(f.leadDays ?? []).includes(l.d)}
                      onChange={(e) => set({ leadDays: e.target.checked ? [...(f.leadDays ?? []), l.d].sort((a, b) => b - a) : (f.leadDays ?? []).filter((x) => x !== l.d) })}
                    />
                    {l.label}
                  </label>
                ))}
                <span className="text-xs text-muted-foreground">(D-N은 그날 오전 9시)</span>
              </div>
            )}
          </div>
        )}
        <div>
          <Label htmlFor="al-note">메모 (선택)</Label>
          <Textarea id="al-note" rows={2} maxLength={1000} value={f.note ?? ''} onChange={(e) => set({ note: e.target.value })} />
        </div>
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
          <Switch checked={f.sound !== false} onCheckedChange={(v) => set({ sound: v })} label="소리" />
          소리 내기
        </label>
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}

function TodayTab(): React.JSX.Element {
  const navigate = useNavigate()
  const q = useQuery({ queryKey: ['local', 'upcoming-today'], queryFn: todayReminders, networkMode: 'always', refetchInterval: 30_000, refetchOnMount: 'always' })
  const { refetch } = q
  useEffect(() => onMain('alarms:changed', () => void refetch()), [refetch])
  const items = q.data ?? []
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <p className="mb-3 text-sm text-muted-foreground">일정·연간 업무·알람에서 오늘 울리는 알림을 시간순으로 모았습니다.</p>
      {!items.length ? (
        <EmptyState icon={BellRing} title="오늘 울릴 알림이 없습니다" />
      ) : (
        <div className="space-y-1" data-testid="today-reminders">
          {items.map((r) => (
            <button key={r.key} className={cn('flex w-full cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-muted', r.fired && 'opacity-55')} onClick={() => r.route && navigate(r.route)}>
              <span className="w-12 shrink-0 font-mono text-xs">{format(r.fireAt, 'HH:mm')}</span>
              <span className="w-20 shrink-0 rounded bg-muted px-1.5 py-0.5 text-center text-xs">{SOURCE_LABEL[r.source] ?? r.source}</span>
              <span className="truncate font-medium">{r.title}</span>
              <span className="truncate text-xs text-muted-foreground">{r.body}</span>
              {r.fired && (
                <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <CheckCircle2 className="size-3.5" /> 울림
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MyAlarmsTab({ onEdit }: { onEdit: (a: Partial<AlarmInput>) => void }): React.JSX.Element {
  const alarms = useAlarms()
  const quickTimer = (m: number): void => void invoke('local:alarms.save', { title: `${m}분 타이머`, kind: 'timer', fireAt: Date.now() + m * 60_000 })
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Timer className="size-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">바로 타이머</span>
        {[5, 10, 15, 30, 60].map((m) => (
          <Button key={m} size="sm" variant="outline" onClick={() => quickTimer(m)}>
            {m}분
          </Button>
        ))}
      </div>
      {!alarms.data?.length ? (
        <EmptyState icon={AlarmClock} title="알람이 없습니다" description="한 번·반복·기한·타이머 알람을 추가하세요. 알람은 이 PC에서만 울립니다." />
      ) : (
        <div className="space-y-1.5" data-testid="alarm-list">
          {alarms.data.map((a) => (
            <div key={a.id} className={cn('flex items-center gap-3 rounded-md border border-border px-3 py-2', !a.enabled && 'opacity-60')} data-testid="alarm-item">
              <Switch checked={a.enabled} onCheckedChange={(v) => void invoke('local:alarms.setEnabled', { id: a.id, enabled: v })} label={`${a.title} ${a.enabled ? '끄기' : '켜기'}`} />
              <button className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => onEdit({ ...a })}>
                <div className="flex items-center gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{KIND_LABEL[a.kind]}</span>
                  <span className="truncate font-semibold">{a.title}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {describe(a)}
                  {a.snoozeUntil && a.snoozeUntil > Date.now() && ` · 다시 알림 ${format(a.snoozeUntil, 'HH:mm')}`}
                  {a.next ? ` · 다음 ${format(a.next, 'M/d HH:mm')}` : a.enabled ? '' : ' · 꺼짐'}
                </div>
              </button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`${a.title} 삭제`}
                onClick={() => {
                  if (confirmDialog('이 알람을 지울까요?')) void invoke('local:alarms.delete', { id: a.id })
                }}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function FocusTab(): React.JSX.Element {
  const focus = useFocus()
  const [now, setNow] = useState(Date.now())
  const [minutes, setMinutes] = useState(25)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const f = focus.data
  const left = f?.active && f.endsAt ? Math.max(0, f.endsAt - now) : 0
  const mm = String(Math.floor(left / 60000)).padStart(2, '0')
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0')
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <Card className="mx-auto max-w-md">
        <CardContent className="flex flex-col items-center gap-4 p-6">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {f?.active ? f.kind === 'focus' ? <Brain className="size-4" /> : <Coffee className="size-4" /> : <Clock className="size-4" />}
            {f?.active ? (f.kind === 'focus' ? '집중 중' : '휴식 중') : '집중 타이머'}
          </div>
          <div className="font-mono text-6xl font-bold tabular-nums" data-testid="focus-left" aria-live="off">
            {f?.active ? `${mm}:${ss}` : `${String(minutes).padStart(2, '0')}:00`}
          </div>
          {f?.active ? (
            <>
              {f.kind === 'focus' && <p className="text-sm text-muted-foreground">집중하는 동안 일반 알림은 보류됩니다(긴급 공지·알람은 울림). 보류 {f.held}건</p>}
              <Button variant="outline" onClick={() => void invoke('focus:stop')}>
                <Square /> 그만하기
              </Button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                {[15, 25, 50].map((m) => (
                  <Button key={m} size="sm" variant={minutes === m ? 'default' : 'outline'} onClick={() => setMinutes(m)}>
                    {m}분
                  </Button>
                ))}
                <Input type="number" aria-label="집중 시간(분)" min={1} max={180} className="w-20" value={minutes} onChange={(e) => setMinutes(Math.min(180, Math.max(1, Number(e.target.value) || 1)))} />
              </div>
              <div className="flex gap-2">
                <Button onClick={() => void invoke('focus:start', { minutes, kind: 'focus' })}>
                  <Brain /> 집중 시작
                </Button>
                <Button variant="outline" onClick={() => void invoke('focus:start', { minutes: 5, kind: 'break' })}>
                  <Coffee /> 5분 휴식
                </Button>
              </div>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            오늘 집중 {f?.today.sessions ?? 0}회 · {f?.today.minutes ?? 0}분
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

type Tab = 'today' | 'mine' | 'focus'

export function AlarmsPage(): React.JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('today')
  const [edit, setEdit] = useState<Partial<AlarmInput> | null>(null)
  // "알람으로" from a memo opens the dialog prefilled.
  useEffect(() => {
    const s = location.state as { newAlarm?: Partial<AlarmInput> } | null
    if (s?.newAlarm) {
      setTab('mine')
      setEdit(s.newAlarm)
      navigate('/alarms', { replace: true, state: null })
    }
  }, [location.state, navigate])
  const tabs: { key: Tab; label: string; icon: typeof AlarmClock }[] = [
    { key: 'today', label: '오늘 울릴 알림', icon: BellRing },
    { key: 'mine', label: '내 알람', icon: AlarmClock },
    { key: 'focus', label: '집중 타이머', icon: Brain }
  ]
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="알람"
        description="내 알람은 이 PC에만 저장되고 이 PC에서 울립니다. 팀원에게 보내는 알람은 메신저에 있습니다."
        actions={
          <Button size="sm" onClick={() => setEdit({})}>
            <Plus /> 알람 추가
          </Button>
        }
      />
      <div className="flex shrink-0 gap-1 border-b border-border px-5 py-2" role="tablist">
        {tabs.map((t) => (
          <Button key={t.key} role="tab" aria-selected={tab === t.key} size="sm" variant={tab === t.key ? 'default' : 'ghost'} onClick={() => setTab(t.key)}>
            <t.icon /> {t.label}
          </Button>
        ))}
      </div>
      {tab === 'today' && <TodayTab />}
      {tab === 'mine' && <MyAlarmsTab onEdit={setEdit} />}
      {tab === 'focus' && <FocusTab />}
      <AlarmDialog open={!!edit} initial={edit} onClose={() => setEdit(null)} />
    </div>
  )
}
