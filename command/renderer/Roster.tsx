import { Download, Printer } from 'lucide-react'
import type { CmdTeam } from '../shared/types'
import { periodText, rolePath, substitutionPhase, ymd } from '../shared/logic'
import type { Model } from './model'
import { useHost } from './host'
import { Badge, Button, Card, CardHeader, CardTitle, EmptyNote, EmptyState, PersonName, Unreg, cn, titled, titledText } from './ui'
import { PlacedName, SubstitutionsToday, coverNote, placedText } from './Substitutions'

/** The role tree of a mode, a column per 조, the people in each cell as it is today (substitutes marked). */
export function RoleTable({ m, modeId, teams }: { m: Model; modeId: string; teams: CmdTeam[] }): React.JSX.Element {
  const tree = m.tree(modeId)
  if (!tree.length) return <EmptyNote>이 근무 유형에는 분류가 아직 없습니다. 설정 → 분류와 임무에서 만드세요.</EmptyNote>
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-sm" data-testid="cmd-roster">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="w-64 px-3 py-1.5 text-left font-medium">분류(임무)</th>
            {teams.map((t) => (
              <th key={t.id} className="border-l border-border px-2 py-1.5 text-left font-medium">
                <span className="mr-1 inline-block size-2.5 rounded-full align-[-1px]" style={{ background: t.color }} />
                {t.name}
                {m.shift?.teamId === t.id && <span className="ml-1 text-primary">(오늘)</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tree.map(({ role, depth }) => (
            <tr key={role.id} className="border-b border-border last:border-0" data-role={role.name}>
              <td className={cn('px-3 py-1.5', depth === 0 && 'font-semibold')} style={{ paddingLeft: 12 + depth * 16 }}>
                {role.name}
              </td>
              {teams.map((t) => {
                const ps = m.placedNow(role.id, t.id)
                return (
                  <td key={t.id} className="border-l border-border px-2 py-1.5 align-top">
                    {ps.length ? (
                      <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                        {ps.map((x) => (
                          <PlacedName key={x.p.id} m={m} x={x} />
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50">-</span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 편성: every 조 side by side (as today: substitutes marked), the common duties, exceptions and substitutions; print and CSV. */
export function Roster({ m, modeId, now }: { m: Model; modeId: string; now: number }): React.JSX.Element {
  const host = useHost()
  const mode = m.s.modes.find((x) => x.id === modeId)
  const today = ymd(now)
  if (!m.s.teams.length) return <EmptyState title="조가 없습니다" description="설정 → 조에서 A조·B조처럼 조를 만들고 조원을 넣으세요." />
  const csv = (): void => {
    const rows: string[][] = [['분류', ...m.s.teams.map((t) => t.name)]]
    for (const { role } of m.tree(modeId)) rows.push([rolePath(m.s.roles, role.id), ...m.s.teams.map((t) => m.placedNow(role.id, t.id).map((x) => placedText(m, x)).join(', '))])
    rows.push([])
    rows.push(['공통업무', '방식', '담당'])
    for (const c of m.commonNow) rows.push([c.name, c.perTeam ? '조별' : '고정', c.assign.map((a) => `${c.perTeam ? `${m.team(a.teamId)?.name ?? ''}: ` : ''}${a.cover ? `대리 ${titledText(m.person(a.personId))} (${coverNote(m, a.cover)})` : titledText(m.person(a.personId))}`).join(', ')])
    rows.push([])
    rows.push(['예외자', '사유', '기간'])
    for (const e of m.s.exceptions) rows.push([titledText(m.person(e.personId)), e.reason, `${e.fromDate} ~ ${e.toDate ?? '계속'}`])
    rows.push([])
    rows.push(['부재자', '사유', '대리자', '기간', '상태'])
    for (const x of m.s.substitutions.filter((y) => substitutionPhase(y, today) !== 'past')) rows.push([titledText(m.person(x.personId)), x.reason, titledText(m.person(x.substituteId)), periodText(x.fromDate, x.toDate), substitutionPhase(x, today) === 'now' ? '진행 중' : '예정'])
    host.saveCsv(`편성표_${mode?.name ?? ''}.csv`, rows)
  }
  return (
    <div className="space-y-4 print:space-y-2" data-testid="cmd-roster-tab">
      <div className="flex items-center gap-2 print:hidden">
        <span className="text-sm text-muted-foreground">
          {mode?.name} 편성표 · {today} 기준{m.absent.size ? ` (대리 ${m.absent.size}명 반영)` : ''}
        </span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => window.print()}>
          <Printer /> 인쇄
        </Button>
        <Button size="sm" variant="outline" onClick={csv}>
          <Download /> CSV로 저장
        </Button>
      </div>
      <h2 className="hidden text-lg font-bold print:block">
        {mode?.name} 편성표 ({today} 기준)
      </h2>
      <Card>
        <RoleTable m={m} modeId={modeId} teams={m.s.teams} />
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>조원 (분류에 배치되지 않은 사람 포함)</CardTitle>
        </CardHeader>
        <div className="grid gap-0 sm:grid-cols-2 lg:grid-cols-4">
          {m.s.teams.map((t) => (
            <div key={t.id} className="border-b border-border p-3 sm:border-r">
              <p className="mb-1 text-sm font-semibold">
                <span className="mr-1 inline-block size-2.5 rounded-full" style={{ background: t.color }} />
                {t.name} <span className="font-normal text-muted-foreground">{t.members.length}명</span>
              </p>
              <ul className="space-y-0.5 text-sm">
                {t.members.map((pid) => {
                  const p = m.person(pid)
                  const placed = m.rolesOf(pid, modeId).length > 0
                  const away = m.absent.get(pid)
                  return (
                    <li key={pid} className={placed ? '' : 'text-important'}>
                      {titled(p)}
                      <Unreg p={p} />
                      {!placed && <span className="ml-1 text-xs">(미배치)</span>}
                      {away && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          (부재{away.reason ? ` · ${away.reason}` : ''} · 대리 {m.person(away.substituteId)?.name})
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>공통업무</CardTitle>
          </CardHeader>
          <table className="w-full text-sm">
            <tbody>
              {m.commonNow.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="w-44 px-3 py-1.5 font-medium">
                    {c.name} {c.perTeam ? <Badge>조별</Badge> : <Badge>고정</Badge>}
                  </td>
                  <td className="px-3 py-1.5">
                    {c.perTeam
                      ? m.s.teams.map((t) => {
                          const ps = c.assign.filter((a) => a.teamId === t.id)
                          return ps.length ? (
                            <span key={t.id} className="mr-3 inline-flex flex-wrap gap-x-1.5">
                              <b>{t.name}</b>
                              {ps.map((a) => {
                                const p = m.person(a.personId)
                                return p ? <PlacedName key={a.personId} m={m} x={{ p, cover: a.cover }} /> : null
                              })}
                            </span>
                          ) : null
                        })
                      : c.assign.length ? (
                          <span className="inline-flex flex-wrap gap-x-2">
                            {c.assign.map((a) => {
                              const p = m.person(a.personId)
                              return p ? <PlacedName key={a.personId} m={m} x={{ p, cover: a.cover }} /> : null
                            })}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">지정 안 됨</span>
                        )}
                  </td>
                </tr>
              ))}
              {!m.s.common.length && (
                <tr>
                  <td>
                    <EmptyNote>공통업무가 없습니다.</EmptyNote>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>예외자</CardTitle>
          </CardHeader>
          <table className="w-full text-sm">
            <tbody>
              {m.s.exceptions.map((e) => (
                <tr key={e.id} className={cn('border-b border-border last:border-0', !m.excepted.has(e.personId) && 'text-muted-foreground')}>
                  <td className="px-3 py-1.5 font-medium">
                    <PersonName p={m.person(e.personId)} />
                  </td>
                  <td className="px-3 py-1.5">{e.reason}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {e.fromDate} ~ {e.toDate ?? '계속'}
                  </td>
                </tr>
              ))}
              {!m.s.exceptions.length && (
                <tr>
                  <td>
                    <EmptyNote>예외자가 없습니다.</EmptyNote>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
      <SubstitutionsToday m={m} now={now} upcoming />
    </div>
  )
}
