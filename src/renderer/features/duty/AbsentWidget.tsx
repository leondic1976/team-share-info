import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { startOfWeek } from 'date-fns'
import { UserX } from 'lucide-react'
import { dayPart, type DutyBoardDto } from '@shared/schemas/duty'
import { dutySections } from '@shared/dutySections'
import { dutyAbsentGroups, entriesByMember } from '@shared/dutyDay'
import { deptPathText } from '@shared/org'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { EmptyNote, Loading, OfflineState } from '@renderer/components/EmptyState'
import { MemberLink } from '@renderer/components/MemberLink'
import { api } from '@renderer/lib/api'
import { DAY, startOfDay } from '@renderer/lib/dates'
import { useDisplayName, useMe } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import { TypeBadge } from './TypeBadge'

/**
 * Home widget "오늘 부재자": who is away today (every reason 근무현황 counts as 사고), by 소속
 * in the order of the org chart. It reads the same board as 근무현황 (the week asked for by its
 * daily and weekly view, also kept for offline use), so it shows exactly what that screen shows.
 */
export function AbsentWidget(): React.JSX.Element | null {
  const navigate = useNavigate()
  const dn = useDisplayName()
  const online = useConn((s) => s.state === 'online')
  const { data: me } = useMe()
  const today = startOfDay(Date.now())
  const week = startOfWeek(today, { weekStartsOn: 1 }).getTime()
  const off = !!me?.disabledFeatures?.includes('duty')
  const q = useQuery({
    queryKey: ['events', 'duty', week, week + 7 * DAY],
    queryFn: () => api.get<DutyBoardDto>('/api/duty', { from: week, to: week + 7 * DAY }),
    enabled: online && !off,
    placeholderData: (prev) => prev
  })
  const board = q.data
  const groups = useMemo(() => (board ? dutyAbsentGroups(dutySections(board.departments, board.members), entriesByMember(board.entries), today) : []), [board, today])
  if (off) return null
  const count = groups.reduce((n, g) => n + g.people.length, 0)
  return (
    <Card data-testid="widget-absent">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <UserX className="size-4" /> 오늘 부재자
        </CardTitle>
        <div className="flex items-center gap-1">
          {board && <span className="text-xs text-muted-foreground">{count}명</span>}
          <Button size="sm" variant="ghost" onClick={() => navigate('/duty')}>
            근무현황
          </Button>
        </div>
      </CardHeader>
      <CardContent className="max-h-80 overflow-y-auto p-2">
        {!board ? (
          !online ? <OfflineState /> : <Loading />
        ) : !groups.length ? (
          <EmptyNote>오늘 자리를 비운 사람이 없습니다.</EmptyNote>
        ) : (
          <div className="space-y-2">
            {groups.map(({ section: s, people }) => (
              <div key={s.dept?.id ?? 'none'} data-testid="absent-dept">
                <div className="truncate px-2 pb-0.5 text-xs font-semibold text-muted-foreground" title={deptPathText(s.path) || undefined}>
                  {deptPathText(s.path) || '부서 미지정'}
                  {s.childCount > 0 && ' (직속)'}
                  <span className="ml-1 font-normal">{people.length}명</span>
                </div>
                {people.map(({ m, entries }) => (
                  <div key={m.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted" data-testid="absent-row">
                    <span className="w-28 shrink-0 truncate">
                      <MemberLink memberId={m.id} name={m.name} className="font-medium">
                        {dn(m)}
                      </MemberLink>{' '}
                      <span className="text-xs text-muted-foreground">{m.title}</span>
                    </span>
                    <span className="flex shrink-0 flex-wrap gap-1">
                      {entries.map((e) => {
                        const part = dayPart(e, today, today + DAY)
                        return <TypeBadge key={`${e.id}:${e.key}`} type={e.type} part={part === '종일' ? undefined : part} />
                      })}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{entries.map((e) => [e.place, e.note].filter(Boolean).join(' · ')).filter(Boolean).join(', ')}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
