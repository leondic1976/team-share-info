import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { addDays, addMonths, endOfMonth, endOfWeek, format, startOfMonth, startOfWeek } from 'date-fns'
import { ko } from 'date-fns/locale'
import { CalendarCheck, ChevronLeft, ChevronRight, Lock, Search, Save, Users, FileDown, Trash2 } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Input, Select } from '@renderer/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Editor, RichView } from '@renderer/components/Editor'
import { ScopePicker, ScopeTags, defaultScope } from '@renderer/components/ScopePicker'
import { EmptyState, OfflineState } from '@renderer/components/EmptyState'
import { invoke } from '@renderer/lib/bridge'
import { api, errorMessage } from '@renderer/lib/api'
import { parseYmd, ymd } from '@renderer/lib/dates'
import { useMembers, useMe } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import { useSpace } from '@renderer/app/space-store'
import type { WorklogDto } from '@shared/schemas/events'
import type { ScopeInput } from '@shared/schemas/scope'
import { cn } from '@renderer/lib/utils'
import { WeeklyReview } from './WeeklyReview'

function MonthPicker({ date, onPick, marked }: { date: string; onPick: (d: string) => void; marked: Set<string> }): React.JSX.Element {
  const [month, setMonth] = useState(() => startOfMonth(parseYmd(date)))
  const days: Date[] = []
  for (let d = startOfWeek(month, { weekStartsOn: 0 }); d <= endOfWeek(endOfMonth(month), { weekStartsOn: 0 }); d = addDays(d, 1)) days.push(d)
  return (
    <div className="select-none">
      <div className="mb-2 flex items-center justify-between">
        <Button size="icon-sm" variant="ghost" aria-label="이전 달" onClick={() => setMonth(addMonths(month, -1))}>
          <ChevronLeft />
        </Button>
        <span className="text-sm font-semibold">{format(month, 'yyyy년 M월')}</span>
        <Button size="icon-sm" variant="ghost" aria-label="다음 달" onClick={() => setMonth(addMonths(month, 1))}>
          <ChevronRight />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-xs">
        {['일', '월', '화', '수', '목', '금', '토'].map((d, i) => (
          <span key={d} className={cn('py-1 text-muted-foreground', i === 0 && 'text-urgent', i === 6 && 'text-primary')}>
            {d}
          </span>
        ))}
        {days.map((d) => {
          const key = ymd(d)
          const other = d.getMonth() !== month.getMonth()
          return (
            <button
              key={key}
              onClick={() => onPick(key)}
              aria-label={key}
              className={cn('relative cursor-pointer rounded py-1.5 hover:bg-muted', other && 'opacity-40', key === date && 'bg-primary font-bold text-primary-foreground hover:bg-primary', key === ymd() && key !== date && 'font-bold text-primary')}
            >
              {d.getDate()}
              {marked.has(key) && <span className={cn('absolute bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full', key === date ? 'bg-white' : 'bg-primary')} />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Personal diary: stored only on this PC (🔒). Saved automatically while typing. */
function DiaryTab(): React.JSX.Element {
  const qc = useQueryClient()
  const [date, setDate] = useState(ymd())
  const [html, setHtml] = useState('')
  const [tags, setTags] = useState('')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [editorKey, setEditorKey] = useState(0)
  const timer = useRef<number | null>(null)
  const ym = date.slice(0, 7)
  const month = useQuery({ queryKey: ['local', 'diary', 'month', ym], queryFn: () => invoke('local:diary.month', { ym }), networkMode: 'always' })
  const search = useQuery({ queryKey: ['local', 'diary', 'search', q], queryFn: () => invoke('local:diary.search', { q }), enabled: q.trim().length > 0, networkMode: 'always' })

  useEffect(() => {
    let alive = true
    void invoke('local:diary.get', { date }).then((e) => {
      if (!alive) return
      setHtml(e?.bodyHtml ?? '')
      setTags(e?.tags.join(', ') ?? '')
      setEditorKey((k) => k + 1)
      setStatus(e ? `마지막 저장 ${format(e.updatedAt, 'M/d HH:mm')}` : '')
    })
    return () => {
      alive = false
    }
  }, [date])

  const save = async (bodyHtml: string, tagText: string): Promise<void> => {
    await invoke('local:diary.save', {
      date,
      bodyHtml,
      tags: tagText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 20)
    })
    setStatus(`저장됨 ${format(new Date(), 'HH:mm:ss')}`)
    void qc.invalidateQueries({ queryKey: ['local', 'diary'] })
  }
  const schedule = (bodyHtml: string, tagText: string): void => {
    if (timer.current) window.clearTimeout(timer.current)
    setStatus('저장 중…')
    timer.current = window.setTimeout(() => void save(bodyHtml, tagText), 800)
  }

  const marked = useMemo(() => new Set((month.data ?? []).map((d) => d.date)), [month.data])
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-72 shrink-0 space-y-4 overflow-y-auto border-r border-border p-4">
        <MonthPicker date={date} onPick={setDate} marked={marked} />
        <div className="relative">
          <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input aria-label="다이어리 검색" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="내용·태그 검색" />
        </div>
        <div className="space-y-1">
          {(q.trim() ? search.data : month.data)?.map((d) => (
            <button key={d.date} onClick={() => setDate(d.date)} className={cn('block w-full cursor-pointer rounded px-2 py-1.5 text-left hover:bg-muted', d.date === date && 'bg-primary/10')}>
              <div className="text-xs font-semibold">{format(parseYmd(d.date), 'M월 d일 (EEE)', { locale: ko })}</div>
              <div className="truncate text-xs text-muted-foreground">{d.snippet || '(이미지)'}</div>
            </button>
          ))}
        </div>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-lg font-bold">{format(parseYmd(date), 'yyyy년 M월 d일 EEEE', { locale: ko })}</h2>
          <span className="flex items-center gap-1 rounded bg-personal/15 px-1.5 py-0.5 text-xs text-personal">
            <Lock className="size-3" /> 내 PC에만 저장
          </span>
          <span className="ml-auto text-xs text-muted-foreground" data-testid="diary-status">
            {status}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="text-urgent"
            onClick={async () => {
              if (!window.confirm('이 날의 다이어리를 지울까요?')) return
              await invoke('local:diary.delete', { date })
              setHtml('')
              setTags('')
              setEditorKey((k) => k + 1)
              void qc.invalidateQueries({ queryKey: ['local', 'diary'] })
            }}
          >
            <Trash2 /> 지우기
          </Button>
        </div>
        <Editor
          key={`${date}-${editorKey}`}
          value={html}
          ariaLabel="다이어리 본문"
          minHeight={360}
          placeholder="오늘 있었던 일, 생각, 메모를 자유롭게 적으세요. 자동으로 저장됩니다."
          onChange={(h) => {
            setHtml(h)
            schedule(h, tags)
          }}
        />
        <div className="mt-3 flex items-center gap-2">
          <span className="text-sm">태그</span>
          <Input
            aria-label="태그"
            value={tags}
            onChange={(e) => {
              setTags(e.target.value)
              schedule(html, e.target.value)
            }}
            placeholder="쉼표로 구분 (예: 업무, 회의)"
          />
        </div>
      </div>
    </div>
  )
}

const EMPTY = '<p></p>'

/** Shared work log (6.4): today done / tomorrow / notes with a scope. */
function WorklogTab(): React.JSX.Element {
  const qc = useQueryClient()
  const online = useConn((s) => s.state === 'online')
  const space = useSpace((s) => s.space)
  const { data: me } = useMe()
  const { data: members } = useMembers()
  const [date, setDate] = useState(ymd())
  const [done, setDone] = useState('')
  const [todo, setTodo] = useState('')
  const [notes, setNotes] = useState('')
  const [scope, setScope] = useState<ScopeInput>(defaultScope(space))
  const [ver, setVer] = useState(0)
  const [msg, setMsg] = useState('')
  const [view, setView] = useState<'write' | 'team'>('write')
  const [from, setFrom] = useState(ymd(startOfWeek(new Date(), { weekStartsOn: 1 })))
  const [to, setTo] = useState(ymd(endOfWeek(new Date(), { weekStartsOn: 1 })))
  const [who, setWho] = useState('')

  useEffect(() => {
    if (!online) return
    let alive = true
    void api.get<WorklogDto | null>(`/api/worklogs/mine/${date}`).then((w) => {
      if (!alive) return
      setDone(w?.doneHtml ?? '')
      setTodo(w?.todoHtml ?? '')
      setNotes(w?.notesHtml ?? '')
      if (w) setScope({ type: w.scope.type, groupIds: w.scope.groups.map((g) => g.id), memberIds: w.scope.members.map((m) => m.id) })
      setVer((v) => v + 1)
      setMsg(w ? `저장된 일지 · ${format(w.updatedAt, 'M/d HH:mm')}` : '')
    })
    return () => {
      alive = false
    }
  }, [date, online])

  const list = useQuery({
    queryKey: ['worklogs', from, to, who, space],
    queryFn: () => api.get<WorklogDto[]>('/api/worklogs', { from, to, memberId: who || undefined, groupId: space === 'team' ? undefined : space }),
    enabled: online && view === 'team'
  })

  const save = async (): Promise<void> => {
    try {
      await api.put(`/api/worklogs/mine/${date}`, { doneHtml: done, todoHtml: todo, notesHtml: notes, scope })
      setMsg(`저장했습니다 · ${format(new Date(), 'HH:mm')}`)
      void qc.invalidateQueries({ queryKey: ['worklogs'] })
    } catch (e) {
      setMsg(errorMessage(e))
    }
  }

  /** Weekly/monthly report: bundle logs into a .doc (HTML) that opens in Word/한글. */
  const exportDoc = (): void => {
    const rows = [...(list.data ?? [])].sort((a, b) => a.date.localeCompare(b.date) || a.memberName.localeCompare(b.memberName))
    const sec = (t: string, h: string): string => (h && h !== EMPTY ? `<h4>${t}</h4>${h}` : '')
    const body = rows
      .map((w) => `<h3>${w.date} (${format(parseYmd(w.date), 'EEE', { locale: ko })}) · ${w.memberName}</h3>${sec('한 일', w.doneHtml)}${sec('할 일', w.todoHtml)}${sec('특이사항', w.notesHtml)}`)
      .join('<hr/>')
    const html = `<html><head><meta charset="utf-8"><title>업무보고</title><style>body{font-family:'맑은 고딕';font-size:10pt}h1{font-size:16pt}h3{font-size:12pt;margin-top:14pt}h4{font-size:10pt;margin:6pt 0 2pt}table{border-collapse:collapse}td,th{border:1px solid #999;padding:3pt}</style></head><body><h1>업무보고 (${from} ~ ${to})</h1>${body}</body></html>`
    const url = URL.createObjectURL(new Blob(['\uFEFF' + html], { type: 'application/msword' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `업무보고_${from}_${to}.doc`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 3000)
  }

  if (!online) return <OfflineState />
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mb-4 flex gap-1">
        <Button size="sm" variant={view === 'write' ? 'secondary' : 'ghost'} onClick={() => setView('write')}>
          내 업무일지 쓰기
        </Button>
        <Button size="sm" variant={view === 'team' ? 'secondary' : 'ghost'} onClick={() => setView('team')}>
          <Users /> 팀 업무일지 보기·취합
        </Button>
      </div>
      {view === 'write' ? (
        <div className="max-w-4xl space-y-4">
          <div className="flex items-center gap-2">
            <Button size="icon-sm" variant="ghost" aria-label="전날" onClick={() => setDate(ymd(addDays(parseYmd(date), -1)))}>
              <ChevronLeft />
            </Button>
            <Input aria-label="일지 날짜" type="date" className="w-44" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            <Button size="icon-sm" variant="ghost" aria-label="다음날" onClick={() => setDate(ymd(addDays(parseYmd(date), 1)))}>
              <ChevronRight />
            </Button>
            <span className="text-sm font-semibold">{format(parseYmd(date), 'EEEE', { locale: ko })}</span>
            <span className="ml-auto text-xs text-muted-foreground" data-testid="worklog-status">
              {msg}
            </span>
          </div>
          {(
            [
              ['오늘 한 일', done, setDone],
              ['내일 할 일', todo, setTodo],
              ['특이사항', notes, setNotes]
            ] as const
          ).map(([label, val, setter]) => (
            <Card key={label}>
              <CardHeader>
                <CardTitle>{label}</CardTitle>
              </CardHeader>
              <CardContent>
                <Editor key={`${label}-${ver}`} value={val} onChange={setter} minHeight={90} ariaLabel={label} />
              </CardContent>
            </Card>
          ))}
          <Card>
            <CardHeader>
              <CardTitle>공개 범위</CardTitle>
            </CardHeader>
            <CardContent>
              <ScopePicker value={scope} onChange={setScope} />
            </CardContent>
          </Card>
          <Button onClick={() => void save()}>
            <Save /> 업무일지 저장
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="시작일" type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />~
            <Input aria-label="종료일" type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
            <Button size="sm" variant="outline" onClick={() => {
              setFrom(ymd(startOfWeek(new Date(), { weekStartsOn: 1 })))
              setTo(ymd(endOfWeek(new Date(), { weekStartsOn: 1 })))
            }}>
              이번 주
            </Button>
            <Button size="sm" variant="outline" onClick={() => {
              setFrom(ymd(startOfMonth(new Date())))
              setTo(ymd(endOfMonth(new Date())))
            }}>
              이번 달
            </Button>
            <Select aria-label="작성자" className="w-36" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">전체 작성자</option>
              {me && <option value={me.id}>나</option>}
              {(members ?? [])
                .filter((m) => m.id !== me?.id)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </Select>
            <Button size="sm" className="ml-auto" onClick={exportDoc} disabled={!list.data?.length}>
              <FileDown /> 문서로 내보내기(.doc)
            </Button>
          </div>
          {!list.data?.length ? (
            <EmptyState title="이 기간의 업무일지가 없습니다" />
          ) : (
            list.data.map((w) => (
              <Card key={w.id} data-testid={`worklog-${w.memberName}-${w.date}`}>
                <CardHeader>
                  <CardTitle>
                    {format(parseYmd(w.date), 'M/d (EEE)', { locale: ko })} · {w.memberName}
                  </CardTitle>
                  <ScopeTags scope={w.scope} />
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-3">
                  {(
                    [
                      ['한 일', w.doneHtml],
                      ['할 일', w.todoHtml],
                      ['특이사항', w.notesHtml]
                    ] as const
                  ).map(([l, h]) => (
                    <div key={l}>
                      <div className="mb-1 text-xs font-semibold text-muted-foreground">{l}</div>
                      <RichView html={h || '<p>-</p>'} />
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function DiaryPage(): React.JSX.Element {
  const [tab, setTab] = useState<'diary' | 'worklog' | 'review'>('diary')
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="다이어리 · 업무일지"
        description={
          tab === 'diary' ? '다이어리는 내 PC에만 저장되고 아무에게도 공유되지 않습니다.' : tab === 'worklog' ? '업무일지는 정한 공개 범위의 팀원에게 공유됩니다.' : '주간 보고 초안은 저장하기 전까지 아무 곳에도 보내지 않습니다.'
        }
        actions={
          <div className="flex gap-1">
            <Button size="sm" variant={tab === 'diary' ? 'default' : 'outline'} onClick={() => setTab('diary')}>
              <Lock /> 다이어리
            </Button>
            <Button size="sm" variant={tab === 'worklog' ? 'default' : 'outline'} onClick={() => setTab('worklog')}>
              <Users /> 업무일지
            </Button>
            <Button size="sm" variant={tab === 'review' ? 'default' : 'outline'} onClick={() => setTab('review')}>
              <CalendarCheck /> 주간 돌아보기
            </Button>
          </div>
        }
      />
      {tab === 'diary' ? <DiaryTab /> : tab === 'worklog' ? <WorklogTab /> : <WeeklyReview />}
    </div>
  )
}
