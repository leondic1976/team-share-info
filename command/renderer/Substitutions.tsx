/**
 * 대리자: who takes an absent person's places (분류 in every 근무 유형, 공통업무) for a period.
 * The register (설정), its dialog, the marks shown in 현황·편성 and the hint from the host's
 * 근무현황 ("away from today through the next days — name a substitute").
 */
import { useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, Trash2, UserRoundCheck } from 'lucide-react'
import type { CmdPerson, CmdSubstitution } from '../shared/types'
import { absenceHints, checkSubstitution, daysLabel, periodText, periodsOverlap, rolePath, substitutionPhase, ymd } from '../shared/logic'
import type { Model, PlacedNow } from './model'
import { useAct } from './data'
import { useHost } from './host'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, EmptyNote, Field, Input, PersonName, Select, Unreg, cn, titled, titledText } from './ui'

export const PHASE_LABEL = { now: '진행 중', later: '예정', past: '지난' } as const
const REASONS = ['휴가', '교육', '출장', '병가', '훈련 파견']

/** "원 담당 소방위 김지휘 · 휴가" */
export function coverNote(m: Model, x: CmdSubstitution): string {
  return `원 담당 ${titledText(m.person(x.personId))}${x.reason ? ` · ${x.reason}` : ''}`
}

/** For text (CSV): "대리 소방장 이대리 (원 담당 소방위 김지휘 · 휴가)" or the name (with " (미등록)"). */
export function placedText(m: Model, x: PlacedNow): string {
  return x.cover ? `대리 ${titledText(x.p)} (${coverNote(m, x.cover)})` : titledText(x.p)
}

/** A name in a place today, marked when a substitute stands in. */
export function PlacedName({ m, x }: { m: Model; x: PlacedNow }): React.JSX.Element {
  return (
    <span className="whitespace-nowrap" data-testid={x.cover ? 'cmd-cover' : undefined}>
      {x.cover && (
        <Badge tone="primary" className="mr-1">
          대리
        </Badge>
      )}
      {titled(x.p)}
      <Unreg p={x.p} />
      {x.cover && <span className="ml-1 text-xs text-muted-foreground">({coverNote(m, x.cover)})</span>}
    </span>
  )
}

/** What the absent person does that the substitute takes: "긴급구조지휘대: 조장", "공통업무: 장비운반차 운전". */
export function placesOf(m: Model, personId: string): string[] {
  const teamId = m.teamOf(personId)
  const out: string[] = []
  for (const mode of m.s.modes) {
    const ids = m.s.assignments.filter((a) => a.personId === personId && a.teamId === teamId && m.s.roles.some((r) => r.id === a.roleId && r.modeId === mode.id))
    if (ids.length) out.push(`${mode.name}: ${ids.map((a) => rolePath(m.s.roles, a.roleId)).join(', ')}`)
  }
  const commons = m.s.common.filter((c) => c.assign.some((a) => a.personId === personId && (!c.perTeam || a.teamId === teamId)))
  if (commons.length) out.push(`공통업무: ${commons.map((c) => c.name).join(', ')}`)
  return out
}

/**
 * People grouped by 조 for a select (조 없음 and 미등록 인원 last). Those who left the host's
 * list are not offered, unless the record names them already (`keep`).
 */
function groupedPeople(m: Model, keep: string[]): { label: string; people: CmdPerson[] }[] {
  const ok = (p: CmdPerson): boolean => !p.left || keep.includes(p.id)
  const groups = m.s.teams.map((t) => ({ label: t.name, people: t.members.map((id) => m.person(id)).filter((p): p is CmdPerson => !!p && ok(p)) }))
  const placed = new Set(m.s.teams.flatMap((t) => t.members))
  const rest = m.s.people.filter((p) => !placed.has(p.id) && ok(p))
  groups.push({ label: '조 없음', people: rest.filter((p) => !p.temp) }, { label: m.s.guests?.label ?? '미등록 인원', people: rest.filter((p) => p.temp) })
  return groups.filter((g) => g.people.length)
}

type Draft = { id?: string; personId: string; substituteId: string; reason: string; fromDate: string; toDate: string | null }

/** Registers or changes a substitution; the rules are checked as it is filled in. */
export function SubstitutionDialog({ m, value, onClose }: { m: Model; value: Partial<Draft> | null; onClose: () => void }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const today = ymd(Date.now())
  const [f, setF] = useState<Draft>({ personId: '', substituteId: '', reason: '', fromDate: today, toDate: today })
  const { setErr } = act
  useEffect(() => {
    if (!value) return
    setF({ personId: '', substituteId: '', reason: '', fromDate: ymd(Date.now()), toDate: ymd(Date.now()), ...value })
    setErr('')
  }, [value, setErr])
  const keepIds = useMemo(() => [value?.personId ?? '', value?.substituteId ?? ''].filter(Boolean), [value])
  const groups = useMemo(() => groupedPeople(m, keepIds), [m, keepIds])
  const ctx = { substitutions: m.s.substitutions, exceptions: m.s.exceptions, teams: m.s.teams, assignments: m.s.assignments, common: m.s.common, roles: m.s.roles, people: m.s.people }
  const check = f.personId && f.substituteId ? checkSubstitution(f, ctx) : null
  const badPeriod = !!f.toDate && f.toDate < f.fromDate
  // why somebody cannot be the substitute in this period (shown next to the name)
  const notFor = (p: CmdPerson): string => {
    if (p.id === f.personId) return '부재자 본인'
    const overlap = (x: { fromDate: string; toDate: string | null }): boolean => periodsOverlap(x.fromDate, x.toDate, f.fromDate, f.toDate)
    if (m.s.exceptions.some((x) => x.personId === p.id && overlap(x))) return '그 기간 예외자'
    if (m.s.substitutions.some((x) => x.id !== f.id && x.personId === p.id && overlap(x))) return '그 기간 부재'
    return ''
  }
  const places = f.personId ? placesOf(m, f.personId) : []
  const save = (): void =>
    void act.run(
      () => {
        const body = { personId: f.personId, substituteId: f.substituteId, reason: f.reason, fromDate: f.fromDate, toDate: f.toDate }
        return f.id ? host.api.patch(`/api/command/substitutions/${f.id}`, body) : host.api.post('/api/command/substitutions', body)
      },
      () => onClose()
    )
  return (
    <Dialog
      open={!!value}
      onClose={onClose}
      title={f.id ? '대리 고치기' : '대리자 등록'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button disabled={!f.personId || !f.substituteId || badPeriod || !!check?.error || act.busy} onClick={save} data-testid="cmd-sub-save">
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">대리자는 부재 기간 동안 부재자의 분류(모든 근무 유형)와 공통업무를 대신 맡습니다. 부재자는 조에 그대로 남고, 기간이 끝나면 저절로 원래대로 돌아갑니다.</p>
        <Field label="부재자">
          <Select value={f.personId} onChange={(e) => setF({ ...f, personId: e.target.value })} aria-label="부재자" data-testid="cmd-sub-person">
            <option value="">고르세요</option>
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {titledText(p)}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        {f.personId && (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs" data-testid="cmd-sub-places">
            <p className="mb-0.5 font-semibold">대신 맡을 임무{m.team(m.teamOf(f.personId)) ? ` (${m.team(m.teamOf(f.personId))?.name})` : ''}</p>
            {places.length ? places.map((x) => <p key={x}>{x}</p>) : <p className="text-muted-foreground">맡은 분류·공통업무가 없습니다.</p>}
          </div>
        )}
        <Field label="사유">
          <Input value={f.reason} maxLength={100} list="cmd-sub-reasons" onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="예: 휴가, 교육, 출장" aria-label="부재 사유" />
          <datalist id="cmd-sub-reasons">
            {REASONS.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </Field>
        <div className="flex flex-wrap gap-3">
          <Field label="시작일">
            <Input type="date" className="w-44" value={f.fromDate} onChange={(e) => e.target.value && setF({ ...f, fromDate: e.target.value })} aria-label="대리 시작일" />
          </Field>
          <Field label="끝일 (비우면 계속)">
            <Input type="date" className="w-44" value={f.toDate ?? ''} onChange={(e) => setF({ ...f, toDate: e.target.value || null })} aria-label="대리 끝일" />
          </Field>
        </div>
        <Field label="대리자">
          <Select value={f.substituteId} onChange={(e) => setF({ ...f, substituteId: e.target.value })} aria-label="대리자" data-testid="cmd-sub-substitute">
            <option value="">고르세요</option>
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.people.map((p) => {
                  const why = notFor(p)
                  return (
                    <option key={p.id} value={p.id} disabled={!!why}>
                      {titledText(p)}
                      {why ? ` — ${why}` : ''}
                    </option>
                  )
                })}
              </optgroup>
            ))}
          </Select>
        </Field>
        {badPeriod && <p className="text-sm text-urgent">끝 날짜가 시작보다 빠릅니다.</p>}
        {check?.error && (
          <p className="text-sm text-urgent" role="alert" data-testid="cmd-sub-error">
            {check.error}
          </p>
        )}
        {!!check?.warnings.length && (
          <ul className="space-y-0.5 rounded-md border border-important/40 bg-important/10 px-3 py-2 text-xs" data-testid="cmd-sub-warnings">
            {check.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {act.err && (
          <p className="text-sm text-urgent" role="alert">
            {act.err}
          </p>
        )}
      </div>
    </Dialog>
  )
}

/** 설정: the register of substitutions, 진행 중 · 예정 · 지난. */
export function SubstitutionsCard({ m, now }: { m: Model; now: number }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const today = ymd(now)
  const [phase, setPhase] = useState<keyof typeof PHASE_LABEL>('now')
  const [edit, setEdit] = useState<Partial<Draft> | null>(null)
  const count = (k: keyof typeof PHASE_LABEL): number => m.s.substitutions.filter((x) => substitutionPhase(x, today) === k).length
  const list = m.s.substitutions.filter((x) => substitutionPhase(x, today) === phase).sort((a, b) => (phase === 'past' ? b.fromDate.localeCompare(a.fromDate) : a.fromDate.localeCompare(b.fromDate)))
  return (
    <Card data-testid="cmd-subs">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <UserRoundCheck className="size-4" /> 대리자 (부재 기간에 임무를 대신 맡는 사람)
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => setEdit({})} data-testid="cmd-sub-add">
          <Plus /> 대리자 등록
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <span className="flex flex-wrap gap-1" role="tablist" aria-label="대리 기간">
          {(Object.keys(PHASE_LABEL) as (keyof typeof PHASE_LABEL)[]).map((k) => (
            <Button key={k} role="tab" aria-selected={phase === k} size="sm" variant={phase === k ? 'default' : 'outline'} onClick={() => setPhase(k)} data-sub-phase={k}>
              {PHASE_LABEL[k]} {count(k)}
            </Button>
          ))}
        </span>
        {!list.length && <EmptyNote>{PHASE_LABEL[phase]} 대리가 없습니다.</EmptyNote>}
        {list.map((x) => {
          const absent = m.person(x.personId)
          const sub = m.person(x.substituteId)
          return (
            <div key={x.id} className={cn('flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm', phase === 'past' && 'text-muted-foreground')} data-testid="cmd-sub-row">
              <b className="min-w-0 truncate">
                <PersonName p={absent} />
              </b>
              {x.reason && <Badge>{x.reason}</Badge>}
              <span className="text-muted-foreground">대리</span>
              <b className="min-w-0 truncate">
                <PersonName p={sub} />
              </b>
              <span className="ml-auto whitespace-nowrap text-xs tabular-nums">{periodText(x.fromDate, x.toDate)}</span>
              <Button size="icon-sm" variant="ghost" aria-label="대리 고치기" onClick={() => setEdit(x)}>
                <Pencil />
              </Button>
              <Button size="icon-sm" variant="ghost" className="text-urgent" aria-label="대리 삭제" onClick={() => window.confirm(`${absent?.name ?? ''}의 대리(${sub?.name ?? ''})를 지울까요?`) && void act.run(() => host.api.del(`/api/command/substitutions/${x.id}`))}>
                <Trash2 />
              </Button>
            </div>
          )
        })}
        <p className="text-xs text-muted-foreground">
          <b>대리자</b>는 부재자(휴가·교육·출장 등)의 분류(모든 근무 유형)와 공통업무를 그 기간 동안 대신 맡습니다. 부재자는 조에 그대로 남고 현황·편성에 <b>대리</b>로 표시되며, 그 기간에 시작하는 훈련에는 대리자가 참가합니다. <b>예외자</b>는 대신할 사람 없이 편성에서 빠지는 것입니다.
        </p>
        {act.err && (
          <p className="text-sm text-urgent" role="alert">
            {act.err}
          </p>
        )}
      </CardContent>
      <SubstitutionDialog m={m} value={edit} onClose={() => setEdit(null)} />
    </Card>
  )
}

/** 현황·편성: the substitutions of today (and the coming ones), for everybody. */
export function SubstitutionsToday({ m, now, upcoming = false }: { m: Model; now: number; upcoming?: boolean }): React.JSX.Element {
  const today = ymd(now)
  const list = m.s.substitutions.filter((x) => {
    const ph = substitutionPhase(x, today)
    return ph === 'now' || (upcoming && ph === 'later')
  })
  return (
    <Card data-testid="cmd-subs-today">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <UserRoundCheck className="size-4" /> {upcoming ? '대리자 (진행 중 · 예정)' : '대리자 (오늘)'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {list.length ? (
          list.map((x) => (
            <div key={x.id} className="flex flex-wrap gap-x-2">
              <span>
                <b>
                  <PersonName p={m.person(x.personId)} />
                </b>{' '}
                {x.reason && <span className="text-muted-foreground">({x.reason})</span>} → 대리{' '}
                <b>
                  <PersonName p={m.person(x.substituteId)} />
                </b>
              </span>
              <span className="text-muted-foreground">
                {periodText(x.fromDate, x.toDate)}
                {substitutionPhase(x, today) === 'later' && ' · 예정'}
              </span>
            </div>
          ))
        ) : (
          <EmptyNote>{upcoming ? '대리가 없습니다.' : '오늘 대리가 없습니다.'}</EmptyNote>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * For those in charge: somebody with a place on duty (in a 조 on duty then, or a 공통업무) is away
 * by the host's 근무현황 from today through the next days and has no substitute for (some of)
 * those days — a button names one for the first days left uncovered.
 */
export function AbsenceHints({ m, now }: { m: Model; now: number }): React.JSX.Element | null {
  const [edit, setEdit] = useState<Partial<Draft> | null>(null)
  const today = ymd(now)
  const hints = absenceHints({ ...m.s, absences: m.s.hostAbsences ?? [], known: (id) => !!m.person(id) })
  if (!m.s.me.isManager || !hints.length) return null
  return (
    <div className="space-y-1" data-testid="cmd-absence-hints">
      {hints.map((x) => (
        <div key={`${x.personId}|${x.type}|${x.fromDate}`} className="flex flex-wrap items-center gap-2 rounded-md border border-important/40 bg-important/10 px-3 py-1.5 text-sm" data-testid="cmd-absence-hint">
          <UserRoundCheck className="size-4 text-important" />
          <span>
            <b>{titled(m.person(x.personId))}</b> {daysLabel(x.fromDate, x.toDate, today)} {x.type} — 근무현황에 부재로 올라 있는데{' '}
            {x.partial ? `${x.gaps.map((g) => daysLabel(g.fromDate, g.toDate, today)).join(', ')}에 ` : ''}대리자가 없습니다.
          </span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setEdit({ personId: x.personId, reason: x.type, fromDate: x.gaps[0].fromDate, toDate: x.gaps[0].toDate })} data-testid="cmd-absence-sub">
            대리자 지정
          </Button>
        </div>
      ))}
      <SubstitutionDialog m={m} value={edit} onClose={() => setEdit(null)} />
    </div>
  )
}
