import { cn } from '@renderer/lib/utils'
import { useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import listPlugin from '@fullcalendar/list'
import interactionPlugin from '@fullcalendar/interaction'
import koLocale from '@fullcalendar/core/locales/ko'
import type { EventClickArg, EventDropArg, DatesSetArg, EventContentArg } from '@fullcalendar/core'
import type { EventResizeDoneArg, DateClickArg } from '@fullcalendar/interaction'
import { Plus, Printer, Upload, Download, Lock, Users } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Select } from '@renderer/components/ui/input'
import { api, errorMessage } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { useMembers, useMe } from '@renderer/lib/queries'
import { useSpace } from '@renderer/app/space-store'
import { useConn } from '@renderer/app/conn-store'
import { DAY } from '@renderer/lib/dates'
import { parseIcs, toIcs } from '@shared/ics'
import { useHolidays, usePersonalEvents, useServerEvents, type Range } from './calendar-api'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { isTaskAssignee, type TaskDto } from '@shared/schemas/work'
import { useAnnualTasks } from '@renderer/features/docs/AnnualCalendar'
import { annualDate } from '@renderer/features/docs/useDocAlerts'
import { EventDialog, ModeDialog, type EditMode, type EventTarget } from './EventDialog'

/** 'personal' = only what is on this PC, 'shared' = only what is on the server; a member id = that member's shared events */
type Show = 'all' | 'mine' | 'personal' | 'shared' | string

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}

export function CalendarPage(): React.JSX.Element {
  const qc = useQueryClient()
  const calRef = useRef<FullCalendar>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const space = useSpace((s) => s.space)
  const online = useConn((s) => s.state === 'online')
  const { data: me } = useMe()
  const { data: members } = useMembers()
  const [range, setRange] = useState<Range | null>(null)
  const [show, setShow] = useState<Show>('all')
  const [target, setTarget] = useState<EventTarget | null>(null)
  const [msg, setMsg] = useState('')
  const [pendingMove, setPendingMove] = useState<null | { run: (m: EditMode) => Promise<void>; revert: () => void }>(null)

  const memberFilter = show !== 'all' && show !== 'personal' && show !== 'shared' ? (show === 'mine' ? me?.id : show) : undefined
  const server = useServerEvents(show === 'personal' ? null : range, { groupId: space === 'team' ? undefined : space, memberId: memberFilter })
  const personal = usePersonalEvents(show === 'all' || show === 'mine' || show === 'personal' ? range : null)
  const holidays = useHolidays(range)
  const navigate = useNavigate()
  // Task due dates (6.8: 캘린더에 마감일 표시): tasks I received or requested, plus personal to-dos.
  const tasks = useQuery({
    queryKey: ['tasks', 'due', range?.from, range?.to],
    queryFn: () => api.get<TaskDto[]>('/api/tasks', { filter: 'all', state: 'open', dueFrom: range!.from, dueTo: range!.to }),
    enabled: online && !!range && show !== 'personal'
  })
  const annual = useAnnualTasks()
  const localTasks = useQuery({ queryKey: ['local', 'tasks'], queryFn: () => invoke('local:tasks.list', { includeDone: false }), networkMode: 'always' })

  const events = useMemo(() => {
    const out: Record<string, unknown>[] = []
    for (const e of show === 'personal' ? [] : server.data ?? []) {
      // Skip my own busy blocks: the personal original is shown instead.
      if (e.kind === 'busy' && e.authorId === me?.id) continue
      const color = e.kind === 'busy' ? '#94a3b8' : e.color ?? '#2563eb'
      out.push({
        id: `server:${e.id}:${e.key}`,
        title: e.kind === 'absence' ? `[${e.absenceType ?? '부재'}] ${e.authorName}` : e.kind === 'busy' ? `바쁨 · ${e.authorName}` : e.title,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        backgroundColor: color,
        borderColor: color,
        editable: e.authorId === me?.id && e.kind !== 'busy',
        extendedProps: { origin: 'server', item: e }
      })
    }
    if (show === 'all' || show === 'mine' || show === 'personal') {
      for (const e of personal.data ?? []) {
        out.push({
          id: `local:${e.id}:${e.key}`,
          title: e.title,
          start: e.start,
          end: e.end,
          allDay: e.allDay,
          backgroundColor: '#64748b',
          borderColor: '#64748b',
          editable: true,
          classNames: ['personal-event'],
          extendedProps: { origin: 'local', item: e }
        })
      }
    }
    for (const t of tasks.data ?? []) {
      if (!isTaskAssignee(t, me?.id) && t.requesterId !== me?.id) continue
      out.push({ id: `task:${t.id}`, title: `📌 마감: ${t.title}`, start: t.dueAt!, allDay: false, backgroundColor: '#fef3c7', borderColor: '#d97706', textColor: '#92400e', editable: false, extendedProps: { origin: 'task' } })
    }
    if (show === 'all' || show === 'mine' || show === 'personal') {
      for (const t of localTasks.data ?? []) {
        if (!t.dueAt || !range || t.dueAt < range.from || t.dueAt >= range.to) continue
        out.push({ id: `ltask:${t.id}`, title: `📌 마감: ${t.title}`, start: t.dueAt, allDay: false, backgroundColor: '#f1f5f9', borderColor: '#64748b', textColor: '#334155', editable: false, classNames: ['personal-event'], extendedProps: { origin: 'local-task' } })
      }
    }
    if (range && show !== 'personal') {
      const y0 = new Date(range.from).getFullYear()
      const y1 = new Date(range.to).getFullYear()
      for (const t of annual.data ?? []) {
        for (let y = y0; y <= y1; y++) {
          const d = annualDate(t, y)
          const start = new Date(d.getFullYear(), d.getMonth(), d.getDate())
          if (start.getTime() >= range.to || start.getTime() + DAY <= range.from) continue
          out.push({ id: `annual:${t.id}:${y}`, title: `📅 ${t.title}`, start, end: new Date(start.getTime() + DAY), allDay: true, backgroundColor: '#ede9fe', borderColor: '#7c3aed', textColor: '#5b21b6', editable: false, extendedProps: { origin: 'annual' } })
        }
      }
    }
    for (const h of holidays.data ?? []) {
      out.push({ id: `holiday:${h.date}`, title: h.name, start: h.date, allDay: true, display: 'background', backgroundColor: '#fee2e2', classNames: ['holiday'], extendedProps: { origin: 'holiday' } })
      out.push({ id: `holiday-label:${h.date}`, title: h.name, start: h.date, allDay: true, backgroundColor: 'transparent', borderColor: 'transparent', textColor: '#dc2626', editable: false, extendedProps: { origin: 'holiday' } })
    }
    return out
  }, [server.data, personal.data, holidays.data, tasks.data, localTasks.data, annual.data, show, me, range])

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['events'] })
    void qc.invalidateQueries({ queryKey: ['local', 'events'] })
  }

  const onClick = (arg: EventClickArg): void => {
    const p = arg.event.extendedProps as { origin: string; item?: { id: string; key: number; start: number; end: number; recurring: boolean } }
    if (p.origin === 'task' || p.origin === 'local-task') {
      navigate('/tasks')
      return
    }
    if (p.origin === 'annual') {
      navigate('/docs/annual')
      return
    }
    if (!p.item || p.origin === 'holiday') return
    if (p.origin === 'server' && (p.item as { kind?: string }).kind === 'busy') return
    setTarget({ origin: p.origin as 'server' | 'local', id: p.item.id, occurrence: p.item.recurring ? p.item.key : undefined, occStart: p.item.start, occEnd: p.item.end })
  }

  /** Drag & drop / resize: move the occurrence (asks this/following/all for recurring). */
  const onMove = (arg: EventDropArg | EventResizeDoneArg): void => {
    const p = arg.event.extendedProps as { origin: string; item: { id: string; key: number; start: number; end: number; recurring: boolean; allDay: boolean } }
    const start = arg.event.start!.getTime()
    const end = arg.event.end ? arg.event.end.getTime() : start + (arg.event.allDay ? DAY : 3600000)
    const delta = start - p.item.start
    const run = async (mode: EditMode): Promise<void> => {
      try {
        if (p.origin === 'local') {
          const cur = await invoke('local:events.get', { id: p.item.id })
          if (!cur) return
          const times = mode === 'all' ? { startAt: cur.startAt + delta, endAt: cur.startAt + delta + (end - start) } : { startAt: start, endAt: end }
          await invoke('local:events.save', { ...cur, location: cur.location ?? '', id: cur.id, ...times, allDay: arg.event.allDay, rrule: mode === 'this' ? null : cur.rrule, mode, occurrenceStart: p.item.recurring ? p.item.key : undefined })
        } else {
          const body: Record<string, unknown> = { mode, allDay: arg.event.allDay }
          if (p.item.recurring) body.occurrenceStart = p.item.key
          if (mode === 'all' && p.item.recurring) {
            const cur = await api.get<{ startAt: number; endAt: number }>(`/api/events/${p.item.id}`)
            body.startAt = cur.startAt + delta
            body.endAt = cur.startAt + delta + (end - start)
          } else {
            body.startAt = start
            body.endAt = end
            if (mode === 'this') body.rrule = null
          }
          await api.patch(`/api/events/${p.item.id}`, body)
        }
        refresh()
      } catch (e) {
        setMsg(errorMessage(e))
        arg.revert()
      }
    }
    if (p.item.recurring) setPendingMove({ run, revert: arg.revert })
    else void run('all')
  }

  const exportIcs = async (): Promise<void> => {
    if (!range) return
    const list = [
      ...(server.data ?? []).filter((e) => e.kind !== 'busy').map((e) => ({ uid: `${e.id}-${e.key}@teamhub`, title: e.title, startAt: e.start, endAt: e.end, allDay: e.allDay, location: e.location ?? undefined })),
      ...(personal.data ?? []).map((e) => ({ uid: `${e.id}-${e.key}@teamhub-local`, title: e.title, startAt: e.start, endAt: e.end, allDay: e.allDay, location: e.location ?? undefined }))
    ]
    download(`TeamHub-일정.ics`, toIcs(list), 'text/calendar')
    setMsg(`${list.length}개 일정을 내보냈습니다.`)
  }

  const importIcs = async (file: File | undefined): Promise<void> => {
    if (!file) return
    const items = parseIcs(await file.text())
    if (!items.length) return setMsg('가져올 일정이 없습니다.')
    if (!window.confirm(`${items.length}개 일정을 개인 일정(내 PC)으로 가져올까요?`)) return
    for (const e of items) {
      await invoke('local:events.save', { title: e.title.slice(0, 120), bodyHtml: e.description ? `<p>${e.description.replace(/[<>&]/g, '')}</p>` : '', startAt: e.startAt, endAt: e.endAt, allDay: e.allDay, rrule: e.rrule ?? null, location: (e.location ?? '').slice(0, 120), reminders: [] })
    }
    setMsg(`${items.length}개 일정을 가져왔습니다.`)
    refresh()
    if (fileRef.current) fileRef.current.value = ''
  }

  const renderContent = (arg: EventContentArg): React.JSX.Element => {
    const local = (arg.event.extendedProps as { origin: string }).origin === 'local'
    return (
      <div className="flex min-w-0 items-center gap-1 overflow-hidden px-0.5 text-[0.78rem]">
        {local && <Lock className="size-3 shrink-0" aria-label="개인 일정" />}
        {arg.timeText && !arg.event.allDay && <span className="shrink-0 opacity-80">{arg.timeText}</span>}
        <span className="truncate">{arg.event.title}</span>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="일정"
        description="개인 일정(🔒 회색)은 내 PC에만 저장되고, 공유 일정(색깔)은 서버에 저장되어 팀·그룹·지정한 사람이 함께 봅니다."
        actions={
          <>
            <Select aria-label="보기 대상" className="w-40" value={show} onChange={(e) => setShow(e.target.value)}>
              <option value="all">전체 일정</option>
              <option value="mine">내 일정만</option>
              <option value="personal">개인 일정만</option>
              <option value="shared">공유 일정만</option>
              {(members ?? [])
                .filter((m) => m.id !== me?.id)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}님 일정
                  </option>
                ))}
            </Select>
            <Button variant="outline" size="icon" aria-label="일정 내보내기(.ics)" title="일정 내보내기(.ics)" onClick={() => void exportIcs()}>
              <Download />
            </Button>
            <Button variant="outline" size="icon" aria-label="일정 가져오기(.ics)" title="일정 가져오기(.ics)" onClick={() => fileRef.current?.click()}>
              <Upload />
            </Button>
            <input ref={fileRef} type="file" accept=".ics,text/calendar" className="hidden" aria-label="ics 파일 선택" onChange={(e) => void importIcs(e.target.files?.[0])} />
            <Button variant="outline" size="icon" aria-label="인쇄" title="인쇄" onClick={() => window.print()}>
              <Printer />
            </Button>
            <Button onClick={() => setTarget({ origin: 'new', start: Math.ceil(Date.now() / 3600000) * 3600000 })}>
              <Plus /> 새 일정
            </Button>
          </>
        }
      />
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-2" data-testid="calendar-kind">
        <div className="flex overflow-hidden rounded-md border border-border" role="tablist" aria-label="일정 구분">
          {(
            [
              ['all', '전체', null],
              ['personal', '개인 일정', Lock],
              ['shared', '공유 일정', Users]
            ] as const
          ).map(([v, l, Icon]) => {
            const on = v === 'all' ? show !== 'personal' && show !== 'shared' : show === v
            return (
              <button key={v} role="tab" aria-selected={on} onClick={() => setShow(v)} className={cn('flex cursor-pointer items-center gap-1.5 border-r border-border px-3.5 py-1.5 text-sm font-semibold last:border-r-0', on ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>
                {Icon && <Icon className="size-3.5" aria-hidden />}
                {l}
              </button>
            )
          })}
        </div>
        <span className="text-xs text-muted-foreground">
          {show === 'personal' ? '내 PC에만 저장된 일정입니다. 다른 사람에게 보이지 않고 서버가 꺼져 있어도 쓸 수 있습니다.' : show === 'shared' ? '서버에 저장되어 함께 보는 일정입니다(팀·부서·그룹·지정한 사람).' : '개인 일정(🔒 회색)과 공유 일정(색깔)을 함께 봅니다.'}
        </span>
      </div>
      {msg && (
        <p className="border-b border-border px-5 py-1.5 text-xs text-muted-foreground" onClick={() => setMsg('')}>
          {msg}
        </p>
      )}
      {!online && <p className="border-b border-border bg-important/10 px-5 py-1.5 text-xs text-important">서버 연결이 끊겨 공유 일정은 마지막으로 받은 내용만 보입니다. 개인 일정은 그대로 쓸 수 있습니다.</p>}
      <div className="calendar-wrap min-h-0 flex-1 overflow-hidden p-3" data-testid="calendar">
        <FullCalendar
          ref={calRef}
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          locale={koLocale}
          height="100%"
          headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' }}
          buttonText={{ today: '오늘', month: '월', week: '주', day: '일', list: '목록' }}
          events={events}
          editable
          selectable
          dayMaxEvents={4}
          nowIndicator
          eventContent={renderContent}
          datesSet={(a: DatesSetArg) => setRange({ from: a.start.getTime(), to: a.end.getTime() })}
          eventClick={onClick}
          eventDrop={onMove}
          eventResize={onMove}
          dateClick={(a: DateClickArg) => {
            const start = a.allDay ? a.date.getTime() : a.date.getTime()
            setTarget({ origin: 'new', start: a.allDay ? start + 9 * 3600000 : start, end: a.allDay ? start + 10 * 3600000 : start + 3600000 })
          }}
          select={(a) => {
            if (a.allDay && a.end.getTime() - a.start.getTime() <= DAY) return
            setTarget({ origin: 'new', start: a.start.getTime(), end: a.end.getTime(), allDay: a.allDay })
          }}
        />
      </div>
      {target && <EventDialog target={target} onClose={() => setTarget(null)} />}
      <ModeDialog
        open={!!pendingMove}
        verb="이동"
        onPick={(m) => {
          const p = pendingMove
          setPendingMove(null)
          if (!p) return
          if (m) void p.run(m)
          else p.revert()
        }}
      />
    </div>
  )
}
