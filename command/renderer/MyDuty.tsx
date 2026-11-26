import { CalendarClock, ShieldAlert, UserCheck, UserRoundCheck } from 'lucide-react'
import { nextShifts, periodText, rolePath, substitutionPhase, ymd } from '../shared/logic'
import type { CmdRole, CmdSubstitution } from '../shared/types'
import type { Model } from './model'
import { when } from './model'
import { useRoleDuty } from './data'
import { RichView } from './rich'
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyNote, EmptyState, titled } from './ui'

function Duty({ role, roles, cover }: { role: CmdRole; roles: CmdRole[]; cover?: string }): React.JSX.Element {
  // the role and the ones above it, each with its 임무 설명
  const chain: CmdRole[] = []
  for (let r: CmdRole | undefined = role; r && chain.length < 12; r = r.parentId ? roles.find((x) => x.id === r!.parentId) : undefined) chain.unshift(r)
  return (
    <Card data-testid={cover ? 'cmd-cover-role' : 'cmd-my-role'}>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          {cover && <Badge tone="important">대리</Badge>}
          {rolePath(roles, role.id)}
        </CardTitle>
        {cover && <span className="text-xs text-muted-foreground">{cover}</span>}
      </CardHeader>
      <CardContent className="space-y-3">
        {chain.map((r) => (
          <DutyText key={r.id} role={r} own={r.id === role.id} />
        ))}
      </CardContent>
    </Card>
  )
}

function DutyText({ role, own }: { role: CmdRole; own: boolean }): React.JSX.Element | null {
  const q = useRoleDuty(role.hasDuty ? role.id : null)
  if (!role.hasDuty) return own ? <p className="text-sm text-muted-foreground">임무 설명이 아직 없습니다.</p> : null
  return (
    <div>
      {!own && <p className="mb-1 text-xs font-semibold text-muted-foreground">상위 분류: {role.name}</p>}
      {q.data ? <RichView html={q.data.dutyHtml} /> : <p className="text-sm text-muted-foreground">불러오는 중…</p>}
    </div>
  )
}

/** The duty I cover for an absent person (now or coming): their 분류 with 임무 설명 and their 공통업무. */
function CoverDuty({ m, x, modeId, now }: { m: Model; x: CmdSubstitution; modeId: string; now: number }): React.JSX.Element {
  const absent = m.person(x.personId)
  const teamId = m.teamOf(x.personId)
  const team = m.team(teamId)
  const roles = m.rolesOf(x.personId, modeId)
  const commons = m.s.common.filter((c) => c.assign.some((a) => a.personId === x.personId && (!c.perTeam || a.teamId === teamId)))
  const later = substitutionPhase(x, ymd(now)) === 'later'
  const shifts = team ? nextShifts(m.s.rotation, m.s.overrides, team.id, now, 6).filter((s) => ymd(s.to - 1) >= x.fromDate && (!x.toDate || ymd(s.from) <= x.toDate)).slice(0, 3) : []
  const note = `원 담당 ${titled(absent)}${x.reason ? ` · ${x.reason}` : ''} · ${periodText(x.fromDate, x.toDate)}`
  return (
    <div className="space-y-3" data-testid="cmd-cover">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-important/40 bg-important/10 px-3 py-2 text-sm">
        <UserRoundCheck className="size-4 text-important" />
        <span>
          <b>{titled(absent)}</b>
          {x.reason ? `(${x.reason})` : ''}의 대리자입니다{team ? ` — ${team.name}` : ''} · {periodText(x.fromDate, x.toDate)}
        </span>
        <Badge tone={later ? 'muted' : 'important'}>{later ? '예정' : '진행 중'}</Badge>
        {shifts.length > 0 && (
          <span className="w-full text-xs text-muted-foreground">
            그 기간 {team?.name} 근무: {shifts.map((s) => `${when(s.from)} ~ ${when(s.to)}`).join(' / ')}
          </span>
        )}
      </div>
      {roles.length ? roles.map((r) => <Duty key={r.id} role={r} roles={m.s.roles} cover={note} />) : !commons.length ? <EmptyNote>{m.s.modes.find((y) => y.id === modeId)?.name}에서 {absent?.name}이(가) 맡은 분류가 없습니다.</EmptyNote> : null}
      {commons.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <Badge tone="important">대리</Badge> 공통업무
            </CardTitle>
            <span className="text-xs text-muted-foreground">{note}</span>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {commons.map((c) => (
              <div key={c.id}>
                <b>{c.name}</b> {c.perTeam && <Badge>조별</Badge>}
                {c.description && <p className="text-muted-foreground">{c.description}</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/** 내 임무: my 조, my role(s) and their 임무 설명 in the chosen 근무 유형, 공통업무, my next periods, who covers me and whom I cover. */
export function MyDuty({ m, modeId, now }: { m: Model; modeId: string; now: number }): React.JSX.Element {
  const me = m.s.me.id
  const team = m.team(m.teamOf(me))
  const roles = m.rolesOf(me, modeId)
  const commons = m.s.common.filter((c) => c.assign.some((a) => a.personId === me))
  const ex = m.s.exceptions.find((e) => e.personId === me && m.excepted.has(me))
  const shifts = team ? nextShifts(m.s.rotation, m.s.overrides, team.id, now, 3) : []
  const mode = m.s.modes.find((x) => x.id === modeId)
  const today = ymd(now)
  const current = (x: CmdSubstitution): boolean => substitutionPhase(x, today) !== 'past' && !!m.person(x.substituteId)
  const coveredBy = m.s.substitutions.filter((x) => x.personId === me && current(x)).sort((a, b) => a.fromDate.localeCompare(b.fromDate))
  const covering = m.s.substitutions.filter((x) => x.substituteId === me && current(x)).sort((a, b) => a.fromDate.localeCompare(b.fromDate))
  if (!team && !commons.length && !ex && !covering.length && !coveredBy.length)
    return <EmptyState icon={UserCheck} title="편성되어 있지 않습니다" description="조와 공통업무 어디에도 들어 있지 않습니다. 지휘대담당에게 확인하세요." />
  return (
    <div className="space-y-4" data-testid="cmd-mine">
      {ex && (
        <div className="flex items-center gap-2 rounded-md border border-important/40 bg-important/10 px-3 py-2 text-sm">
          <ShieldAlert className="size-4 text-important" /> 예외자입니다: {ex.reason} ({ex.fromDate} ~ {ex.toDate ?? '계속'})
        </div>
      )}
      {coveredBy.map((x) => (
        <div key={x.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm" data-testid="cmd-covered-by">
          <UserRoundCheck className="size-4 text-muted-foreground" />
          <span>
            부재{x.reason ? `(${x.reason})` : ''} {periodText(x.fromDate, x.toDate)} — 그 기간 내 임무는 대리자 <b>{titled(m.person(x.substituteId))}</b>이(가) 맡습니다.
          </span>
          <Badge tone={substitutionPhase(x, today) === 'later' ? 'muted' : 'important'}>{substitutionPhase(x, today) === 'later' ? '예정' : '진행 중'}</Badge>
        </div>
      ))}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>내 조</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {team ? (
              <p className="flex items-center gap-2 text-lg font-bold">
                <span className="size-3 rounded-full" style={{ background: team.color }} />
                {team.name}
                {m.shift?.teamId === team.id && <Badge tone="primary">지금 근무</Badge>}
              </p>
            ) : (
              <p className="text-muted-foreground">조에 들어 있지 않습니다.</p>
            )}
            <p className="text-muted-foreground">{mode?.name}</p>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <CalendarClock className="size-4" /> 다음 근무 기간
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {shifts.length ? (
              shifts.map((s) => (
                <p key={s.from}>
                  {when(s.from)} ~ {when(s.to)} {s.manual && <Badge tone="important">수동 지정</Badge>}
                </p>
              ))
            ) : (
              <p className="text-muted-foreground">순환이 정해지지 않았습니다.</p>
            )}
          </CardContent>
        </Card>
      </div>
      {roles.length ? roles.map((r) => <Duty key={r.id} role={r} roles={m.s.roles} />) : team ? <EmptyNote>{mode?.name}에서 맡은 분류가 아직 없습니다.</EmptyNote> : null}
      {covering.map((x) => (
        <CoverDuty key={x.id} m={m} x={x} modeId={modeId} now={now} />
      ))}
      {commons.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>내 공통업무</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {commons.map((c) => (
              <div key={c.id}>
                <b>{c.name}</b> {c.perTeam && <Badge>조별</Badge>}
                {c.description && <p className="text-muted-foreground">{c.description}</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
