import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { CalendarDays, Lock } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { startOfDay, DAY } from '@renderer/lib/dates'
import { useSpace } from '@renderer/app/space-store'
import { usePersonalEvents, useServerEvents } from './calendar-api'
import { useMemo } from 'react'

/** Home widget: today's shared + personal events (6.1). */
export function TodayWidget(): React.JSX.Element {
  const navigate = useNavigate()
  const space = useSpace((s) => s.space)
  const range = useMemo(() => {
    const s = startOfDay(Date.now())
    return { from: s, to: s + DAY }
  }, [])
  const server = useServerEvents(range, { groupId: space === 'team' ? undefined : space })
  const personal = usePersonalEvents(range)
  const items = [
    ...(server.data ?? []).filter((e) => e.kind !== 'busy').map((e) => ({ key: `s${e.id}${e.key}`, start: e.start, allDay: e.allDay, title: e.kind === 'absence' ? `[${e.absenceType}] ${e.authorName}` : e.title, local: false, color: e.color ?? '#2563eb' })),
    ...(personal.data ?? []).map((e) => ({ key: `l${e.id}${e.key}`, start: e.start, allDay: e.allDay, title: e.title, local: true, color: '#64748b' }))
  ].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start)
  return (
    <Card data-testid="widget-today">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <CalendarDays className="size-4" /> 오늘 일정
        </CardTitle>
        <Button size="sm" variant="ghost" onClick={() => navigate('/calendar')}>
          달력 보기
        </Button>
      </CardHeader>
      <CardContent className="max-h-80 space-y-0.5 overflow-y-auto p-2">
        {!items.length ? (
          <p className="px-2 py-4 text-center text-sm text-muted-foreground">오늘 일정이 없습니다.</p>
        ) : (
          items.map((i) => (
            <div key={i.key} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm">
              <span className="h-4 w-1 shrink-0 rounded" style={{ background: i.color }} />
              <span className="w-12 shrink-0 text-xs text-muted-foreground">{i.allDay ? '종일' : format(i.start, 'HH:mm')}</span>
              {i.local && <Lock className="size-3 shrink-0 text-personal" aria-label="개인 일정" />}
              <span className="truncate">{i.title}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
