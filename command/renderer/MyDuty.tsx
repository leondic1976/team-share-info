import { CalendarClock, ShieldAlert, UserCheck } from 'lucide-react'
import { nextShifts, rolePath } from '../shared/logic'
import type { CmdRole } from '../shared/types'
import type { Model } from './model'
import { when } from './model'
import { useRoleDuty } from './data'
import { RichView } from './rich'
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyNote, EmptyState } from './ui'

function Duty({ role, roles }: { role: CmdRole; roles: CmdRole[] }): React.JSX.Element {
  // the role and the ones above it, each with its 임무 설명
  const chain: CmdRole[] = []
  for (let r: CmdRole | undefined = role; r && chain.length < 12; r = r.parentId ? roles.find((x) => x.id === r!.parentId) : undefined) chain.unshift(r)
  return (
    <Card data-testid="cmd-my-role">
      <CardHeader>
        <CardTitle>{rolePath(roles, role.id)}</CardTitle>
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

/** 내 임무: my 조, my role(s) and their 임무 설명 in the chosen 근무 유형, 공통업무, my next periods. */
export function MyDuty({ m, modeId, now }: { m: Model; modeId: string; now: number }): React.JSX.Element {
  const me = m.s.me.id
  const team = m.team(m.teamOf(me))
  const roles = m.rolesOf(me, modeId)
  const commons = m.s.common.filter((c) => c.assign.some((a) => a.personId === me))
  const ex = m.s.exceptions.find((e) => e.personId === me && m.excepted.has(me))
  const shifts = team ? nextShifts(m.s.rotation, m.s.overrides, team.id, now, 3) : []
  const mode = m.s.modes.find((x) => x.id === modeId)
  if (!team && !commons.length && !ex)
    return <EmptyState icon={UserCheck} title="편성되어 있지 않습니다" description="조와 공통업무 어디에도 들어 있지 않습니다. 지휘대담당에게 확인하세요." />
  return (
    <div className="space-y-4" data-testid="cmd-mine">
      {ex && (
        <div className="flex items-center gap-2 rounded-md border border-important/40 bg-important/10 px-3 py-2 text-sm">
          <ShieldAlert className="size-4 text-important" /> 예외자입니다: {ex.reason} ({ex.fromDate} ~ {ex.toDate ?? '계속'})
        </div>
      )}
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
