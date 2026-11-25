import { CalendarClock, ShieldAlert, Siren, Users } from 'lucide-react'
import { headcount } from '../shared/logic'
import type { Model } from './model'
import { when, ymdOf } from './model'
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyNote, titled } from './ui'
import { RoleTable } from './Roster'

/** 현황: today's 조, its 편성 in the chosen 근무 유형, 공통업무, 인원총괄현황, drills on now. */
export function Overview({ m, modeId, now, onOpenDrill }: { m: Model; modeId: string; now: number; onOpenDrill: (id: string) => void }): React.JSX.Element {
  const today = ymdOf(now)
  const team = m.team(m.shift?.teamId)
  const next = m.team(m.next?.teamId)
  const hc = headcount({ teams: m.s.teams, people: m.s.people, assignments: m.s.assignments, roles: m.s.roles, common: m.s.common, exceptions: m.s.exceptions, modeId, today })
  const live = m.s.drills.filter((d) => d.state === 'running' || d.state === 'paused')
  const commonToday = m.s.common.map((c) => ({ c, people: c.assign.filter((a) => !c.perTeam || a.teamId === team?.id).map((a) => m.person(a.personId)) }))
  const ex = m.s.exceptions.filter((e) => m.excepted.has(e.personId))
  return (
    <div className="space-y-4" data-testid="cmd-overview">
      {live.map((d) => (
        <button key={d.id} type="button" onClick={() => onOpenDrill(d.id)} className="flex w-full cursor-pointer items-center gap-3 rounded-lg border-2 border-orange-500 bg-orange-500/10 px-4 py-2.5 text-left" data-testid="cmd-live-drill">
          <Siren className="size-5 text-orange-600" />
          <span className="font-bold">훈련 {d.state === 'paused' ? '일시정지' : '진행 중'}: {d.title}</span>
          {d.pendingForMe > 0 && <Badge tone="urgent">내가 처리할 메시지 {d.pendingForMe}건</Badge>}
          <span className="ml-auto text-sm text-orange-700 dark:text-orange-300">훈련 화면 열기</span>
        </button>
      ))}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <CalendarClock className="size-4" /> 오늘의 조
            </CardTitle>
            {m.shift?.manual && <Badge tone="important">수동 지정{m.shift.note ? ` · ${m.shift.note}` : ''}</Badge>}
          </CardHeader>
          <CardContent className="space-y-2">
            {team && m.shift ? (
              <>
                <p className="flex items-center gap-2">
                  <span className="size-3 rounded-full" style={{ background: team.color }} />
                  <b className="text-2xl" data-testid="cmd-today-team">
                    {team.name}
                  </b>
                </p>
                <p className="text-sm text-muted-foreground">
                  {when(m.shift.from)} ~ {when(m.shift.to)}
                </p>
                {next && m.next && (
                  <p className="text-sm">
                    다음: <b>{next.name}</b> <span className="text-muted-foreground">({when(m.next.from)}부터)</span>
                  </p>
                )}
              </>
            ) : (
              <EmptyNote>순환이 정해지지 않았습니다. 설정에서 조와 순환을 정하세요.</EmptyNote>
            )}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <Users className="size-4" /> 인원총괄현황
            </CardTitle>
            <span className="text-xs text-muted-foreground">배치·미배치는 고른 근무 유형 기준</span>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="cmd-headcount">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-3 py-1.5 text-left font-medium">구분</th>
                  <th className="px-2 py-1.5 text-right font-medium">인원</th>
                  <th className="px-2 py-1.5 text-right font-medium">임시</th>
                  <th className="px-2 py-1.5 text-right font-medium">배치</th>
                  <th className="px-2 py-1.5 text-right font-medium">미배치</th>
                </tr>
              </thead>
              <tbody>
                {hc.teams.map((t) => {
                  const tm = m.team(t.teamId)
                  return (
                    <tr key={t.teamId} className={team?.id === t.teamId ? 'bg-primary/5 font-semibold' : ''}>
                      <td className="px-3 py-1.5">
                        <span className="mr-1.5 inline-block size-2.5 rounded-full" style={{ background: tm?.color }} />
                        {tm?.name}
                        {team?.id === t.teamId && <span className="ml-1 text-xs text-primary">(오늘)</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{t.members}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{t.temps || ''}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{t.placed}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{t.unplaced ? <span className="text-important">{t.unplaced}</span> : 0}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot className="border-t border-border text-sm">
                <tr>
                  <td className="px-3 py-1.5" colSpan={5}>
                    공통업무 <b>{hc.common}</b>명 · 예외자 <b>{hc.exceptions}</b>명 · 편성 밖 구성원 <b>{hc.outside}</b>명 · 총원 <b>{hc.total}</b>명
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{team ? `${team.name} 편성` : '오늘의 편성'}</CardTitle>
        </CardHeader>
        {team ? <RoleTable m={m} modeId={modeId} teams={[team]} /> : <EmptyNote>오늘의 조가 없습니다.</EmptyNote>}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>공통업무 (조와 관계없이)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {commonToday.length ? (
              commonToday.map(({ c, people }) => (
                <div key={c.id} className="flex flex-wrap gap-x-2">
                  <b className="w-40 shrink-0">{c.name}</b>
                  <span>{people.length ? people.map((p) => titled(p)).join(', ') : <span className="text-muted-foreground">지정 안 됨</span>}</span>
                  {c.perTeam && <Badge>조별</Badge>}
                </div>
              ))
            ) : (
              <EmptyNote>공통업무가 없습니다.</EmptyNote>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <ShieldAlert className="size-4" /> 예외자 (오늘)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {ex.length ? (
              ex.map((e) => (
                <div key={e.id} className="flex gap-2">
                  <b>{titled(m.person(e.personId))}</b>
                  <span className="text-muted-foreground">
                    {e.reason} · {e.fromDate} ~ {e.toDate ?? '계속'}
                  </span>
                </div>
              ))
            ) : (
              <EmptyNote>오늘 예외자가 없습니다.</EmptyNote>
            )}
          </CardContent>
        </Card>
      </div>
      {!live.length && m.s.me.isManager && (
        <p className="text-xs text-muted-foreground">
          훈련은{' '}
          <button type="button" className="cursor-pointer text-primary underline-offset-2 hover:underline" onClick={() => onOpenDrill('')}>
            훈련 탭
          </button>
          에서 시작합니다.
        </p>
      )}
    </div>
  )
}
