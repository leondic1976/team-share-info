import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { NotebookText, Video } from 'lucide-react'
import type { MeetingDto } from '@shared/schemas/meetings'
import { startMeeting } from '@renderer/features/meetings/MeetingsPage'
import { BUILTIN_TEMPLATES } from '@shared/schemas/docs'
import { format } from 'date-fns'
import { useQueryClient } from '@tanstack/react-query'
import { Lock, Users, Plane, Trash2, Share2, Download, Save } from 'lucide-react'
import { Dialog } from '@renderer/components/Dialog'
import { Button } from '@renderer/components/ui/button'
import { Input, Select } from '@renderer/components/ui/input'
import { Editor, RichView } from '@renderer/components/Editor'
import { MemberPicker, ScopePicker, defaultScope, scopeIsValid } from '@renderer/components/ScopePicker'
import { Field } from '@renderer/features/setup/SetupFrame'
import { api, errorMessage } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { DAY, REMINDER_CHOICES, fmtRange, fromInputValue, startOfDay, toInputValue } from '@renderer/lib/dates'
import { useMe } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import { useSpace } from '@renderer/app/space-store'
import { ABSENCE_TYPES, type EventDto } from '@shared/schemas/events'
import type { ScopeInput } from '@shared/schemas/scope'
import { describeRule } from '@shared/recurrence'
import { RecurrenceEditor } from './RecurrenceEditor'
import { cn } from '@renderer/lib/utils'

export type EditMode = 'this' | 'following' | 'all'
type Kind = 'personal' | 'team' | 'absence'

export interface EventTarget {
  origin: 'server' | 'local' | 'new'
  id?: string
  /** occurrence key (original start) when opened from a recurring occurrence */
  occurrence?: number
  occStart?: number
  occEnd?: number
  /** defaults for new events */
  start?: number
  end?: number
  allDay?: boolean
}

interface Form {
  kind: Kind
  title: string
  bodyHtml: string
  start: number
  end: number
  allDay: boolean
  rrule: string | null
  location: string
  reminders: number[]
  scope: ScopeInput
  attendeeIds: string[]
  absenceType: string
  busy: boolean
  busyEventId: string | null
}

/** Ask how to apply a change to a recurring event. */
export function ModeDialog({ open, onPick, verb }: { open: boolean; onPick: (m: EditMode | null) => void; verb: string }): React.JSX.Element {
  return (
    <Dialog open={open} onClose={() => onPick(null)} title={`반복 일정 ${verb}`} width="max-w-sm">
      <div className="space-y-2">
        {(
          [
            ['this', '이 일정만'],
            ['following', '이 일정과 이후 일정'],
            ['all', '모든 반복 일정']
          ] as const
        ).map(([m, l]) => (
          <Button key={m} className="w-full justify-start" variant="outline" onClick={() => onPick(m)}>
            {l}
          </Button>
        ))}
      </div>
    </Dialog>
  )
}

export function EventDialog({ target, onClose }: { target: EventTarget; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: me } = useMe()
  const online = useConn((s) => s.state === 'online')
  const space = useSpace((s) => s.space)

  /** 6.17: join the live meeting of this event, or start one for its attendees. */
  const joinEventMeeting = async (): Promise<void> => {
    if (!server) return
    try {
      const live = await api.get<MeetingDto[]>('/api/meetings', { state: 'live', eventId: server.id })
      if (live[0]) await invoke('meeting:open', { id: live[0].id })
      else {
        const ids = server.attendees.map((a) => a.memberId)
        await startMeeting({ title: server.title, mode: 'video', eventId: server.id, scope: ids.length ? { type: 'members', groupIds: [], memberIds: ids } : { type: 'team', groupIds: [], memberIds: [] } })
      }
      onClose()
    } catch (e) {
      window.alert(errorMessage(e))
    }
  }

  /** 6.11: start minutes from a meeting — title, date, place and attendees are filled in. */
  const writeMinutes = (): void => {
    if (!server) return
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === 'builtin-minutes')!.bodyHtml
    const esc = (s: string): string => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)
    const attendees = server.attendees.map((a) => a.name).join(', ')
    const body = tpl
      .replace('<th>일시</th><td></td>', `<th>일시</th><td>${esc(fmtRange(f.start, f.end, f.allDay))}</td>`)
      .replace('<th>장소</th><td></td>', `<th>장소</th><td>${esc(server.location ?? '')}</td>`)
      .replace('<th>참석자</th><td></td>', `<th>참석자</th><td>${esc(attendees)}</td>`)
    const qs = new URLSearchParams({ new: 'minutes', title: `회의록 - ${server.title} (${format(f.start, 'M/d')})`, eventId: server.id, body })
    onClose()
    navigate(`/docs/minutes?${qs.toString()}`)
  }
  const [loaded, setLoaded] = useState(target.origin === 'new')
  const [orig, setOrig] = useState<{ start: number; end: number; rrule: string | null; authorId?: string; authorName?: string; kind?: string } | null>(null)
  const [readOnly, setReadOnly] = useState(false)
  const [server, setServer] = useState<EventDto | null>(null)
  const [f, setF] = useState<Form>(() => {
    const start = target.start ?? Date.now()
    return {
      kind: 'personal',
      title: '',
      bodyHtml: '',
      start,
      end: target.end ?? start + 3600000,
      allDay: target.allDay ?? false,
      rrule: null,
      location: '',
      reminders: [10],
      scope: defaultScope(space),
      attendeeIds: [],
      absenceType: '휴가',
      busy: false,
      busyEventId: null
    }
  })
  const [err, setErr] = useState('')
  const [busyAct, setBusyAct] = useState(false)
  const [askMode, setAskMode] = useState<null | { verb: string; run: (m: EditMode) => Promise<void> }>(null)
  const set = <K extends keyof Form>(k: K, v: Form[K]): void => setF((p) => ({ ...p, [k]: v }))

  useEffect(() => {
    if (target.origin === 'local' && target.id) {
      void invoke('local:events.get', { id: target.id }).then((e) => {
        if (!e) return onClose()
        setOrig({ start: e.startAt, end: e.endAt, rrule: e.rrule })
        setF((p) => ({
          ...p,
          kind: 'personal',
          title: e.title,
          bodyHtml: e.bodyHtml,
          start: target.occStart ?? e.startAt,
          end: target.occEnd ?? e.endAt,
          allDay: e.allDay,
          rrule: e.rrule,
          location: e.location ?? '',
          reminders: e.reminders,
          busy: !!e.busyEventId,
          busyEventId: e.busyEventId
        }))
        setLoaded(true)
      })
    } else if (target.origin === 'server' && target.id) {
      void api
        .get<EventDto>(`/api/events/${target.id}`)
        .then((e) => {
          setServer(e)
          setOrig({ start: e.startAt, end: e.endAt, rrule: e.rrule, authorId: e.authorId, authorName: e.authorName, kind: e.kind })
          setReadOnly(e.authorId !== me?.id && me?.role !== 'admin')
          setF((p) => ({
            ...p,
            kind: e.kind === 'absence' ? 'absence' : 'team',
            title: e.title,
            bodyHtml: e.bodyHtml,
            start: target.occStart ?? e.startAt,
            end: target.occEnd ?? e.endAt,
            allDay: e.allDay,
            rrule: e.rrule,
            location: e.location ?? '',
            reminders: e.reminders,
            scope: { type: e.scope.type, groupIds: e.scope.groups.map((g) => g.id), memberIds: e.scope.members.map((m) => m.id) },
            attendeeIds: e.attendees.map((a) => a.memberId),
            absenceType: e.absenceType ?? '휴가'
          }))
          setLoaded(true)
        })
        .catch((e) => setErr(errorMessage(e)))
    }
  }, [target, me, onClose])

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['events'] })
    void qc.invalidateQueries({ queryKey: ['local', 'events'] })
  }

  const wrap = async (fn: () => Promise<void>): Promise<void> => {
    setErr('')
    setBusyAct(true)
    try {
      await fn()
      refresh()
      onClose()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusyAct(false)
    }
  }

  const isRecurringExisting = target.origin !== 'new' && !!orig?.rrule && target.occurrence !== undefined

  /** For "all" edits opened from an occurrence, shift the series start by the same delta. */
  const seriesTimes = (): { startAt: number; endAt: number } => {
    if (!orig || target.occStart === undefined) return { startAt: f.start, endAt: f.end }
    const delta = f.start - target.occStart
    return { startAt: orig.start + delta, endAt: orig.start + delta + (f.end - f.start) }
  }

  const syncBusy = async (localId: string): Promise<void> => {
    if (f.busyEventId) await api.del(`/api/events/${f.busyEventId}`).catch(() => undefined)
    let busyId: string | null = null
    if (f.busy && online) {
      const t = f.rrule ? seriesTimes() : { startAt: f.start, endAt: f.end }
      busyId = (await api.post<{ id: string }>('/api/events/busy', { startAt: t.startAt, endAt: t.endAt, allDay: f.allDay, rrule: f.rrule })).id
    }
    await invoke('local:events.setBusy', { id: localId, busyEventId: busyId })
  }

  const saveLocal = async (mode: EditMode): Promise<void> => {
    const times = mode === 'all' && isRecurringExisting ? seriesTimes() : { startAt: f.start, endAt: f.end }
    const id = await invoke('local:events.save', {
      id: target.origin === 'local' ? target.id : undefined,
      title: f.title,
      bodyHtml: f.bodyHtml,
      ...times,
      allDay: f.allDay,
      rrule: mode === 'this' ? null : f.rrule,
      location: f.location,
      reminders: f.reminders,
      mode,
      occurrenceStart: target.occurrence
    })
    if (f.busy || f.busyEventId) await syncBusy(id)
  }

  const saveServer = async (mode: EditMode): Promise<void> => {
    const body = {
      kind: f.kind === 'absence' ? 'absence' : 'team',
      title: f.title,
      bodyHtml: f.bodyHtml,
      allDay: f.allDay,
      rrule: f.rrule,
      location: f.location,
      reminders: f.reminders,
      absenceType: f.kind === 'absence' ? f.absenceType : null,
      scope: f.scope,
      attendeeIds: f.kind === 'team' ? f.attendeeIds : []
    }
    if (target.origin === 'server' && target.id) {
      const times = mode === 'all' && isRecurringExisting ? seriesTimes() : { startAt: f.start, endAt: f.end }
      await api.patch(`/api/events/${target.id}`, { ...body, ...times, mode, occurrenceStart: target.occurrence, rrule: mode === 'this' ? null : f.rrule })
    } else {
      await api.post('/api/events', { ...body, startAt: f.start, endAt: f.end })
    }
  }

  const save = (): void => {
    if (!f.title.trim()) return setErr('제목을 입력하세요.')
    if (f.end < f.start) return setErr('끝나는 시각이 시작보다 빠릅니다.')
    if (f.kind === 'team' && !scopeIsValid(f.scope)) return setErr('공개 범위를 정하세요.')
    const run = async (m: EditMode): Promise<void> => {
      if (f.kind === 'personal') await saveLocal(m)
      else await saveServer(m)
    }
    if (isRecurringExisting) setAskMode({ verb: '수정', run: (m) => wrap(() => run(m)) })
    else void wrap(() => run('all'))
  }

  const remove = (): void => {
    const run = async (m: EditMode): Promise<void> => {
      if (target.origin === 'local' && target.id) {
        if (f.busyEventId && m === 'all') await api.del(`/api/events/${f.busyEventId}`).catch(() => undefined)
        await invoke('local:events.delete', { id: target.id, mode: m, occurrence: target.occurrence })
      } else if (target.origin === 'server' && target.id) {
        await api.del(`/api/events/${target.id}?mode=${m}${target.occurrence !== undefined ? `&occurrence=${target.occurrence}` : ''}`)
      }
    }
    if (isRecurringExisting) setAskMode({ verb: '삭제', run: (m) => wrap(() => run(m)) })
    else if (window.confirm('이 일정을 삭제할까요?')) void wrap(() => run('all'))
  }

  /** Personal -> shared (13.10): create on the server, then optionally remove the local original. */
  const shareToServer = (): void =>
    void wrap(async () => {
      if (!scopeIsValid(f.scope)) throw new Error('공개 범위를 정하세요.')
      const t = isRecurringExisting ? seriesTimes() : { startAt: f.start, endAt: f.end }
      await api.post('/api/events', { kind: 'team', title: f.title, bodyHtml: f.bodyHtml, ...t, allDay: f.allDay, rrule: f.rrule, location: f.location, reminders: f.reminders, scope: f.scope, attendeeIds: f.attendeeIds })
      if (target.id && window.confirm('공유했습니다. 내 PC의 개인 일정 원본을 지울까요?')) {
        if (f.busyEventId) await api.del(`/api/events/${f.busyEventId}`).catch(() => undefined)
        await invoke('local:events.delete', { id: target.id, mode: 'all' })
      }
    })

  /** Shared -> personal: copy to the local DB, then optionally delete from the server. */
  const unshare = (): void =>
    void wrap(async () => {
      if (!server) return
      await invoke('local:events.save', { title: server.title, bodyHtml: server.bodyHtml, startAt: server.startAt, endAt: server.endAt, allDay: server.allDay, rrule: server.rrule, location: server.location ?? '', reminders: server.reminders })
      if (window.confirm('내 PC에 복사했습니다. 서버의 공유 일정을 지울까요? (다른 팀원에게서 사라집니다)')) await api.del(`/api/events/${server.id}`)
    })

  const kinds: { k: Kind; label: string; icon: typeof Lock; hint: string }[] = [
    { k: 'personal', label: '개인 일정', icon: Lock, hint: '내 PC에만 저장' },
    { k: 'team', label: '공유 일정', icon: Users, hint: '팀·그룹·지정한 사람' },
    { k: 'absence', label: '부재', icon: Plane, hint: '휴가·출장 등, 팀 전체에 표시' }
  ]
  const isNew = target.origin === 'new'
  const title = isNew ? '새 일정' : readOnly ? '일정' : '일정 수정'

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={title}
        width="max-w-2xl"
        footer={
          !loaded ? undefined : readOnly ? (
            <>
              {server?.kind === 'team' && (
                <Button variant="outline" onClick={() => void joinEventMeeting()}>
                  <Video /> 화상 회의
                </Button>
              )}
              {server?.kind === 'team' && (
                <Button variant="outline" onClick={writeMinutes}>
                  <NotebookText /> 회의록 작성
                </Button>
              )}
              <Button variant="ghost" onClick={onClose}>
                닫기
              </Button>
            </>
          ) : (
            <>
              {target.origin === 'server' && server?.kind === 'team' && (
                <Button variant="outline" onClick={() => void joinEventMeeting()}>
                  <Video /> 화상 회의
                </Button>
              )}
              {target.origin === 'server' && server?.kind === 'team' && (
                <Button variant="outline" onClick={writeMinutes}>
                  <NotebookText /> 회의록 작성
                </Button>
              )}
              {!isNew && (
                <Button variant="ghost" className="mr-auto text-urgent" onClick={remove} disabled={busyAct}>
                  <Trash2 /> 삭제
                </Button>
              )}
              {target.origin === 'local' && online && (
                <Button variant="outline" onClick={shareToServer} disabled={busyAct} title="공개 범위를 정한 뒤 누르세요">
                  <Share2 /> 공유하기
                </Button>
              )}
              {target.origin === 'server' && server?.kind === 'team' && server.authorId === me?.id && (
                <Button variant="outline" onClick={unshare} disabled={busyAct}>
                  <Download /> 개인 일정으로 옮기기
                </Button>
              )}
              <Button onClick={save} disabled={busyAct || (f.kind !== 'personal' && !online)}>
                <Save /> 저장
              </Button>
            </>
          )
        }
      >
        {!loaded ? (
          <p className="text-sm text-muted-foreground">불러오는 중…</p>
        ) : readOnly && server ? (
          <div className="space-y-3 text-sm">
            <h3 className="text-lg font-bold">{server.title}</h3>
            <p className="text-muted-foreground">
              {fmtRange(f.start, f.end, f.allDay)} · {server.authorName}
            </p>
            {server.rrule && <p>반복: {describeRule(server.rrule)}</p>}
            {server.location && <p>장소: {server.location}</p>}
            {server.absenceType && <p>부재 종류: {server.absenceType}</p>}
            <RichView html={server.bodyHtml} />
            {server.attendees.length > 0 && <AttendeesBlock event={server} onChanged={refresh} />}
          </div>
        ) : (
          <div className="space-y-4">
            {(isNew || target.origin === 'local') && (
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="일정 종류">
                {kinds
                  .filter((k) => isNew || k.k === 'personal')
                  .map((k) => (
                    <button
                      key={k.k}
                      type="button"
                      role="radio"
                      aria-checked={f.kind === k.k}
                      onClick={() => set('kind', k.k)}
                      className={cn('cursor-pointer rounded-md border-2 px-3 py-2 text-left', f.kind === k.k ? 'border-primary bg-primary/5' : 'border-border')}
                    >
                      <div className="flex items-center gap-1.5 text-sm font-semibold">
                        <k.icon className="size-4" /> {k.label}
                      </div>
                      <div className="text-xs text-muted-foreground">{k.hint}</div>
                    </button>
                  ))}
              </div>
            )}
            <Field label="제목">
              <Input aria-label="일정 제목" value={f.title} onChange={(e) => set('title', e.target.value)} autoFocus />
            </Field>
            {f.kind === 'absence' && (
              <Field label="부재 종류">
                <Select aria-label="부재 종류" value={f.absenceType} onChange={(e) => set('absenceType', e.target.value)}>
                  {ABSENCE_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={f.allDay}
                  onChange={(e) => {
                    const allDay = e.target.checked
                    const s = startOfDay(f.start)
                    setF((p) => ({ ...p, allDay, start: allDay ? s : s + 9 * 3600000, end: allDay ? Math.max(startOfDay(p.end), s) + DAY : s + 10 * 3600000 }))
                  }}
                />
                종일
              </label>
              <Field label="시작">
                <Input
                  aria-label="시작"
                  type={f.allDay ? 'date' : 'datetime-local'}
                  value={toInputValue(f.start, f.allDay)}
                  onChange={(e) => {
                    if (!e.target.value) return
                    const s = fromInputValue(e.target.value)
                    setF((p) => ({ ...p, start: s, end: s + Math.max(p.allDay ? DAY : 0, p.end - p.start) }))
                  }}
                />
              </Field>
              <Field label={f.allDay ? '마지막 날' : '끝'}>
                <Input
                  aria-label="끝"
                  type={f.allDay ? 'date' : 'datetime-local'}
                  value={toInputValue(f.allDay ? f.end - DAY : f.end, f.allDay)}
                  onChange={(e) => e.target.value && set('end', fromInputValue(e.target.value) + (f.allDay ? DAY : 0))}
                />
              </Field>
            </div>
            <Field label="반복">
              <RecurrenceEditor value={f.rrule} onChange={(r) => set('rrule', r)} startAt={f.start} />
            </Field>
            <Field label="알림">
              <div className="flex flex-wrap gap-1.5">
                {REMINDER_CHOICES.map((c) => {
                  const on = f.reminders.includes(c.min)
                  return (
                    <button
                      key={c.min}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set('reminders', on ? f.reminders.filter((x) => x !== c.min) : [...f.reminders, c.min].slice(-5))}
                      className={cn('cursor-pointer rounded-full border px-2.5 py-1 text-xs', on ? 'border-primary bg-primary/10 text-primary' : 'border-border')}
                    >
                      {c.label}
                    </button>
                  )
                })}
              </div>
            </Field>
            <Field label="장소">
              <Input aria-label="장소" value={f.location} onChange={(e) => set('location', e.target.value)} />
            </Field>
            {f.kind === 'team' && (
              <>
                <Field label="공개 범위">
                  <ScopePicker value={f.scope} onChange={(s) => set('scope', s)} />
                </Field>
                <Field label="참석자 (선택)" hint="참석자는 공개 범위와 상관없이 이 일정을 보고 참석 여부를 회신할 수 있습니다.">
                  <MemberPicker value={f.attendeeIds} onChange={(ids) => set('attendeeIds', ids)} />
                </Field>
              </>
            )}
            {f.kind === 'personal' && (
              <>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={f.busy} onChange={(e) => set('busy', e.target.checked)} disabled={!online} />
                  <span>
                    팀원에게 <b>바쁨</b>으로만 표시
                    <span className="block text-xs text-muted-foreground">제목·내용은 내 PC에만 두고, 시간대만 서버에 올립니다.</span>
                  </span>
                </label>
                {target.origin === 'local' && online && (
                  <Field label="공유할 때의 공개 범위" hint="[공유하기]를 누르면 이 범위로 서버에 올라갑니다.">
                    <ScopePicker value={f.scope} onChange={(s) => set('scope', s)} />
                  </Field>
                )}
              </>
            )}
            <Field label="내용">
              <Editor value={f.bodyHtml} onChange={(h) => set('bodyHtml', h)} minHeight={100} />
            </Field>
            {target.origin === 'server' && server && server.attendees.length > 0 && <AttendeesBlock event={server} onChanged={refresh} />}
            {f.kind !== 'personal' && !online && <p className="text-sm text-important">서버에 연결되어 있지 않아 공유 일정을 저장할 수 없습니다.</p>}
            {err && <p className="text-sm text-urgent">{err}</p>}
          </div>
        )}
        {readOnly && err && <p className="text-sm text-urgent">{err}</p>}
      </Dialog>
      <ModeDialog
        open={!!askMode}
        verb={askMode?.verb ?? ''}
        onPick={(m) => {
          const a = askMode
          setAskMode(null)
          if (m && a) void a.run(m)
        }}
      />
    </>
  )
}

const RESP: Record<string, string> = { yes: '참석', no: '불참', maybe: '미정', none: '응답 없음' }

function AttendeesBlock({ event, onChanged }: { event: EventDto; onChanged: () => void }): React.JSX.Element {
  const { data: me } = useMe()
  const [list, setList] = useState(event.attendees)
  const mine = list.find((a) => a.memberId === me?.id)
  const respond = async (r: 'yes' | 'no' | 'maybe'): Promise<void> => {
    await api.post(`/api/events/${event.id}/respond`, { response: r })
    setList(list.map((a) => (a.memberId === me?.id ? { ...a, response: r } : a)))
    onChanged()
  }
  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 text-sm font-semibold">참석자 {list.length}명</div>
      <div className="flex flex-wrap gap-1.5 text-xs">
        {list.map((a) => (
          <span key={a.memberId} className={cn('rounded-full px-2 py-0.5', a.response === 'yes' ? 'bg-success/15 text-success' : a.response === 'no' ? 'bg-urgent/10 text-urgent' : 'bg-muted')}>
            {a.name} · {RESP[a.response]}
          </span>
        ))}
      </div>
      {mine && (
        <div className="mt-3 flex items-center gap-2 text-sm">
          내 응답:
          {(['yes', 'no', 'maybe'] as const).map((r) => (
            <Button key={r} size="sm" variant={mine.response === r ? 'default' : 'outline'} onClick={() => void respond(r)}>
              {RESP[r]}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
