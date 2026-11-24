import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Globe, ListChecks, Star, Trash2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { invoke } from '@renderer/lib/bridge'
import { startOfDay, DAY } from '@renderer/lib/dates'
import { useSpace } from '@renderer/app/space-store'
import { cn } from '@renderer/lib/utils'
import { usePersonalEvents, useServerEvents } from '@renderer/features/calendar/calendar-api'
import { SOURCE_LABEL, todayReminders } from '@renderer/features/alarms/useTeamAlarms'
import { useFavorites } from './tools-api'

interface Row {
  key: string
  at: number | null
  kind: string
  title: string
  route: string
  overdue?: boolean
  done?: boolean
}

/** Home widget "오늘의 업무" (6.12 ③): events and alarms in time order. */
export function TodayWorkWidget(): React.JSX.Element {
  const navigate = useNavigate()
  const space = useSpace((s) => s.space)
  const range = useMemo(() => {
    const s = startOfDay(Date.now())
    return { from: s, to: s + DAY }
  }, [])
  const server = useServerEvents(range, { groupId: space === 'team' ? undefined : space })
  const personal = usePersonalEvents(range)
  const reminders = useQuery({ queryKey: ['local', 'upcoming-today'], queryFn: todayReminders, networkMode: 'always', refetchInterval: 60_000 })

  const rows: Row[] = [
    ...(server.data ?? []).filter((e) => e.kind !== 'busy').map((e) => ({ key: `e${e.id}${e.key}`, at: e.allDay ? null : e.start, kind: e.kind === 'absence' ? '부재' : '일정', title: e.kind === 'absence' ? `[${e.absenceType}] ${e.authorName}` : e.title, route: '/calendar' })),
    ...(personal.data ?? []).map((e) => ({ key: `p${e.id}${e.key}`, at: e.allDay ? null : e.start, kind: '개인 일정', title: e.title, route: '/calendar' })),
    ...(reminders.data ?? []).filter((r) => r.source === 'alarms').map((r) => ({ key: r.key, at: r.fireAt, kind: SOURCE_LABEL.alarms, title: r.title, route: '/alarms', done: r.fired }))
  ]
  rows.sort((a, b) => Number(!!b.overdue) - Number(!!a.overdue) || (a.at ?? 0) - (b.at ?? 0))

  return (
    <Card data-testid="widget-todaywork">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <ListChecks className="size-4" /> 오늘의 업무
        </CardTitle>
        <div className="flex">
          <Button size="sm" variant="ghost" onClick={() => navigate('/calendar')}>
            달력 보기
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate('/alarms')}>
            오늘 울릴 알림
          </Button>
        </div>
      </CardHeader>
      <CardContent className="max-h-80 space-y-0.5 overflow-y-auto p-2">
        {!rows.length ? (
          <p className="px-2 py-4 text-center text-sm text-muted-foreground">오늘 일정과 알람이 없습니다.</p>
        ) : (
          rows.map((r) => (
            <button key={r.key} className={cn('flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted', r.done && 'opacity-50')} onClick={() => navigate(r.route)}>
              <span className={cn('w-12 shrink-0 text-xs text-muted-foreground', r.overdue && 'font-semibold text-urgent')}>{r.overdue ? '지남' : r.at === null ? '종일' : format(r.at, 'HH:mm')}</span>
              <span className="w-20 shrink-0 truncate rounded bg-muted px-1.5 py-0.5 text-center text-xs">{r.kind}</span>
              <span className="truncate">{r.title}</span>
            </button>
          ))
        )}
      </CardContent>
    </Card>
  )
}

export function openFavorite(route: string, navigate: (p: string) => void): void {
  if (/^https?:\/\//i.test(route)) void invoke('app:openExternal', { url: route })
  else navigate(route)
}

/** Home widget: favorites (documents, posts, files, work sites). Stored on this PC. */
export function FavoritesWidget(): React.JSX.Element {
  const navigate = useNavigate()
  const favs = useFavorites()
  return (
    <Card data-testid="widget-favorites">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Star className="size-4" /> 즐겨찾기
        </CardTitle>
        <Button size="sm" variant="ghost" title="자주 가는 웹 사이트는 런처의 사이트 모음에서 관리합니다" onClick={() => navigate('/launcher', { state: { tab: 'sites' } })}>
          <Globe /> 사이트 모음
        </Button>
      </CardHeader>
      <CardContent className="max-h-80 space-y-0.5 overflow-y-auto p-2">
        {!favs.data?.length ? (
          <p className="px-2 py-4 text-center text-sm text-muted-foreground">기록·게시글·자료·공지의 별 단추(즐겨찾기)를 누르면 여기에 모입니다. 웹 사이트는 [사이트 모음]에 등록하세요.</p>
        ) : (
          favs.data.map((f) => (
            <div key={f.id} className="group flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted">
              {f.itemType === 'url' ? <Globe className="size-3.5 shrink-0 text-muted-foreground" /> : <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" />}
              <button className="min-w-0 flex-1 cursor-pointer truncate text-left" onClick={() => openFavorite(f.route, navigate)}>
                {f.title}
              </button>
              <button
                className="invisible cursor-pointer rounded p-1 hover:bg-background group-hover:visible"
                aria-label={`${f.title} 즐겨찾기 해제`}
                onClick={() => void invoke('local:favorites.toggle', { itemType: f.itemType, itemId: f.itemId, title: f.title, route: f.route })}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

/** ☆ toggle placed on documents, posts, files and notices. */
export function FavoriteStar({ itemType, itemId, title, route }: { itemType: string; itemId: string; title: string; route: string }): React.JSX.Element {
  const favs = useFavorites()
  const on = !!favs.data?.some((f) => f.itemType === itemType && f.itemId === itemId)
  return (
    <Button size="icon-sm" variant="ghost" aria-label={on ? '즐겨찾기 해제' : '즐겨찾기'} aria-pressed={on} title={on ? '즐겨찾기 해제' : '즐겨찾기'} onClick={() => void invoke('local:favorites.toggle', { itemType, itemId, title, route })}>
      <Star className={cn(on && 'fill-amber-400 text-amber-400')} />
    </Button>
  )
}
