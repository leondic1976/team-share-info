import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { addDays, format, startOfWeek } from 'date-fns'
import { ko } from 'date-fns/locale'
import { ChevronLeft, ChevronRight, Copy, RefreshCw, StickyNote } from 'lucide-react'
import type { EventOccurrenceDto, WorklogDto } from '@shared/schemas/events'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Editor } from '@renderer/components/Editor'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { ymd } from '@renderer/lib/dates'
import { useMe } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const text = (html: string): string => {
  const d = document.createElement('div')
  d.innerHTML = html.replace(/<\/(p|li)>/g, '</$1>\n')
  return (d.textContent ?? '').trim()
}
const list = (items: string[]): string => (items.length ? `<ul>${items.map((i) => `<li><p>${i}</p></li>`).join('')}</ul>` : '<p>-</p>')

interface Collected {
  events: string[]
  logs: string[]
}

/** Weekly review (6.12 ③): collects this week's work into an editable report draft. */
export function WeeklyReview(): React.JSX.Element {
  const online = useConn((s) => s.state === 'online')
  const { data: me } = useMe()
  const [week, setWeek] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }))
  const [html, setHtml] = useState('')
  const [editorKey, setEditorKey] = useState(0)
  const [msg, setMsg] = useState('')
  const from = week.getTime()
  const to = addDays(week, 7).getTime()

  const data = useQuery({
    queryKey: ['weekly-review', from, me?.id, online],
    networkMode: 'always',
    queryFn: async (): Promise<Collected> => {
      const pevents = await invoke('local:events.list', { from, to })
      let events: EventOccurrenceDto[] = []
      let logs: WorklogDto[] = []
      if (online && me) {
        ;[events, logs] = await Promise.all([
          api.get<EventOccurrenceDto[]>('/api/events', { from, to }),
          api.get<WorklogDto[]>('/api/worklogs', { from: ymd(from), to: ymd(to - 1), memberId: me.id })
        ])
      }
      const ev = [
        ...events
          .filter((e) => e.kind !== 'busy' && e.kind !== 'absence' && (e.authorId === me?.id || e.myResponse === 'yes' || e.scope.type === 'team'))
          .map((e) => ({ at: e.start, s: `${format(e.start, e.allDay ? 'M/d(EEE)' : 'M/d(EEE) HH:mm', { locale: ko })} ${esc(e.title)}` })),
        ...pevents.map((e) => ({ at: e.start, s: `${format(e.start, e.allDay ? 'M/d(EEE)' : 'M/d(EEE) HH:mm', { locale: ko })} ${esc(e.title)}` }))
      ]
        .sort((a, b) => a.at - b.at)
        .map((e) => e.s)
      const lg = logs
        .sort((a, b) => a.date.localeCompare(b.date))
        .filter((l) => text(l.doneHtml))
        .map((l) => `${format(new Date(`${l.date}T00:00`), 'M/d(EEE)', { locale: ko })} ${esc(text(l.doneHtml).replace(/\n+/g, ' · '))}`)
      return { events: ev, logs: lg }
    }
  })

  const build = (): void => {
    const d = data.data
    if (!d) return
    const range = `${format(week, 'M/d')} ~ ${format(addDays(week, 4), 'M/d')}`
    setHtml(
      `<h2>주간 업무 보고 (${range})</h2>` +
        `<h3>이번 주 한 일</h3>${list(d.logs)}` +
        `<h3>참석한 일정·회의</h3>${list(d.events)}` +
        `<h3>다음 주 계획</h3><ul><li><p></p></li></ul>` +
        `<h3>특이 사항</h3><p></p>`
    )
    setEditorKey((k) => k + 1)
  }

  const copy = async (): Promise<void> => {
    await invoke('clipboard:write', { text: text(html) })
    setMsg('내용을 복사했습니다.')
  }
  const toMemo = async (): Promise<void> => {
    await invoke('local:memos.save', { body: html, color: 'blue', tags: ['주간보고'] })
    setMsg('메모에 저장했습니다(태그: 주간보고).')
  }

  const d = data.data
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-3xl space-y-3">
        <div className="flex items-center gap-2">
          <Button size="icon-sm" variant="ghost" aria-label="이전 주" onClick={() => setWeek(addDays(week, -7))}>
            <ChevronLeft />
          </Button>
          <span className="font-semibold">
            {format(week, 'yyyy년 M월 d일', { locale: ko })} 주
          </span>
          <Button size="icon-sm" variant="ghost" aria-label="다음 주" onClick={() => setWeek(addDays(week, 7))}>
            <ChevronRight />
          </Button>
          <Button size="sm" className="ml-auto" disabled={!d} onClick={build}>
            <RefreshCw /> 보고 초안 만들기
          </Button>
        </div>
        <Card>
          <CardContent className="grid grid-cols-2 gap-2 p-3 text-center text-sm" data-testid="weekly-counts">
            <div>
              <div className="text-xs text-muted-foreground">일정·회의</div>
              <div className="text-lg font-bold">{d?.events.length ?? '-'}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">업무일지</div>
              <div className="text-lg font-bold">{d?.logs.length ?? '-'}</div>
            </div>
          </CardContent>
        </Card>
        {!online && <p className="text-xs text-muted-foreground">서버에 연결되지 않아 내 PC의 개인 일정만 모았습니다.</p>}
        {html ? (
          <>
            <Editor key={editorKey} value={html} onChange={setHtml} minHeight={320} ariaLabel="주간 보고 초안" />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void copy()}>
                <Copy /> 글자만 복사
              </Button>
              <Button size="sm" variant="outline" onClick={() => void toMemo()}>
                <StickyNote /> 메모로 저장
              </Button>
              {msg && (
                <span className="text-sm text-primary" role="status">
                  {msg}
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">이번 주에 작성한 업무일지와 참석한 일정을 모아 보고 초안을 만듭니다. 초안은 고쳐서 복사하거나 메모로 저장할 수 있습니다.</p>
        )}
      </div>
    </div>
  )
}
