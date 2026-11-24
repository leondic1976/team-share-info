import { sendOrQueue } from '@renderer/lib/outbox'
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addMonths, format, startOfMonth, startOfWeek } from 'date-fns'
import { ko } from 'date-fns/locale'
import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight, Download, List, MessageSquare, Pencil, Plus, Repeat, Trash2, UserCheck, UserCog, UserPlus } from 'lucide-react'
import { MemberLink } from '@renderer/components/MemberLink'
import { useNavigate } from 'react-router-dom'
import { DUTY_COLORS, DUTY_TYPE_NAMES, dayPart, dutyGroupOf, onDay, type DutyBoardDto, type DutyEntryDto, type DutyMemberDto } from '@shared/schemas/duty'
import { toCsv } from '@shared/csv'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Input, Select } from '@renderer/components/ui/input'
import { Dialog } from '@renderer/components/Dialog'
import { EmptyState, ErrorState, Loading, OfflineState } from '@renderer/components/EmptyState'
import { MemberPicker } from '@renderer/components/ScopePicker'
import { Field } from '@renderer/features/setup/SetupFrame'
import { api, errorMessage } from '@renderer/lib/api'
import { DAY, fmtRange, fromInputValue, startOfDay, toInputValue } from '@renderer/lib/dates'
import { confirmPii } from '@renderer/lib/pii'
import { useDisplayName, useMe } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import { cn } from '@renderer/lib/utils'

type Tab = 'day' | 'week' | 'list'
type Dept = DutyBoardDto['departments'][number]
interface DeptBlock {
  dept: Dept | null
  depth: number
  members: DutyMemberDto[]
}
type DialogState = { edit: DutyEntryDto } | { memberId: string; day: number }

function TypeBadge({ type, part, className }: { type: string; part?: string; className?: string }): React.JSX.Element {
  const color = DUTY_COLORS[dutyGroupOf(type)]
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-semibold leading-none', className)} style={{ color, backgroundColor: `${color}22` }}>
      {type}
      {part && <span className="ml-1 font-normal">{part}</span>}
    </span>
  )
}

/** Departments in tree order with their members; `only` narrows to one department and what is under it. */
function deptBlocks(board: DutyBoardDto, only: string): DeptBlock[] {
  const out: DeptBlock[] = []
  const walk = (parent: string | null, depth: number, inside: boolean): void => {
    for (const d of board.departments.filter((x) => x.parentId === parent)) {
      const show = inside || only === 'all' || d.id === only
      if (show) out.push({ dept: d, depth: only === 'all' ? depth : 0, members: board.members.filter((m) => m.deptId === d.id) })
      walk(d.id, depth + 1, show && only !== 'all')
    }
  }
  walk(null, 0, false)
  if (only === 'all') {
    const none = board.members.filter((m) => !m.deptId || !board.departments.some((d) => d.id === m.deptId))
    if (none.length) out.push({ dept: null, depth: 0, members: none })
  }
  return out.filter((b) => b.members.length)
}

function DutyDialog({ board, meId, state, onClose }: { board: DutyBoardDto; meId: string; state: DialogState; onClose: () => void }): React.JSX.Element {
  const dn = useDisplayName()
  const qc = useQueryClient()
  const edit = 'edit' in state ? state.edit : null
  const day0 = edit ? startOfDay(edit.start) : state && 'day' in state ? state.day : startOfDay(Date.now())
  const [memberId, setMemberId] = useState(edit ? edit.memberId : 'memberId' in state ? state.memberId : meId)
  const [type, setType] = useState(edit?.type ?? '연가')
  const [allDay, setAllDay] = useState(edit?.allDay ?? true)
  const [start, setStart] = useState(edit?.start ?? day0)
  /** all day: the midnight after the last day */
  const [end, setEnd] = useState(edit?.end ?? day0 + DAY)
  const [place, setPlace] = useState(edit?.place ?? '')
  const [note, setNote] = useState(edit?.note ?? '')
  const [err, setErr] = useState('')
  const types = DUTY_TYPE_NAMES.includes(type) ? DUTY_TYPE_NAMES : [type, ...DUTY_TYPE_NAMES]

  const hours = (from: number, to: number): void => {
    const d = startOfDay(start)
    setAllDay(false)
    setStart(d + from * 3600000)
    setEnd(d + to * 3600000)
  }
  const pickType = (t: string): void => {
    setType(t)
    if (t === '반가' && allDay) hours(9, 13)
  }
  const toggleAllDay = (v: boolean): void => {
    const s = startOfDay(start)
    setAllDay(v)
    setStart(v ? s : s + 9 * 3600000)
    setEnd(v ? Math.max(startOfDay(end - 1), s) + DAY : s + 18 * 3600000)
  }
  const save = useMutation({
    mutationFn: () => {
      const body = { type, startAt: start, endAt: end, allDay, place, note }
      return edit ? api.patch(`/api/duty/${edit.id}`, body) : sendOrQueue({ kind: 'duty', label: `근무현황: ${type}`, path: '/api/duty', body: { ...body, memberId } })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['events'] })
      void qc.invalidateQueries({ queryKey: ['members'] })
      onClose()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  const submit = (): void => {
    if (end <= start) return setErr(allDay ? '마지막 날이 시작일보다 빠릅니다.' : '끝나는 시각이 시작보다 늦어야 합니다.')
    if (confirmPii([place, note], '팀 전체가 보게 되며,')) save.mutate()
  }
  const who = board.members.find((m) => m.id === memberId)

  return (
    <Dialog
      open
      onClose={onClose}
      title={edit ? '근무상황 고치기' : memberId === meId ? '사고 신청 (휴가·병가·출장 등)' : '사고 대신 신청'}
      width="max-w-lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button disabled={save.isPending} onClick={submit}>
            {edit ? '저장' : '올리기'}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="duty-dialog">
        {edit || !board.canManage ? (
          <p className="text-sm">
            <span className="text-muted-foreground">대상</span> <b>{who?.name ?? '-'}</b> <span className="text-muted-foreground">{who?.title}</span>
          </p>
        ) : (
          <Field label="대상" hint="최종관리자·서무와 대리 등록자는 다른 사람의 근무상황을 대신 올릴 수 있습니다.">
            <Select aria-label="대상" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
              {board.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {dn(m)}
                  {m.title ? ` ${m.title}` : ''}
                  {m.id === meId ? ' (나)' : ''} · {board.departments.find((d) => d.id === m.deptId)?.name ?? '부서 미지정'}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="종류">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="종류">
            {types.map((t) => {
              const color = DUTY_COLORS[dutyGroupOf(t)]
              const on = t === type
              return (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={cn('cursor-pointer rounded-md border px-2.5 py-1 text-sm', on ? 'font-semibold' : 'border-border text-muted-foreground hover:bg-muted')}
                  style={on ? { color, borderColor: color, backgroundColor: `${color}1f` } : undefined}
                  onClick={() => pickType(t)}
                >
                  {t}
                </button>
              )
            })}
          </div>
        </Field>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={allDay ? '시작일' : '시작'}>
            <Input
              aria-label="시작"
              type={allDay ? 'date' : 'datetime-local'}
              value={toInputValue(start, allDay)}
              onChange={(e) => {
                if (!e.target.value) return
                const s = fromInputValue(e.target.value)
                // moving the start keeps the length
                setEnd(s + Math.max(allDay ? DAY : 0, end - start))
                setStart(s)
              }}
            />
          </Field>
          <Field label={allDay ? '마지막 날' : '끝'}>
            <Input aria-label="끝" type={allDay ? 'date' : 'datetime-local'} value={toInputValue(allDay ? end - DAY : end, allDay)} onChange={(e) => e.target.value && setEnd(fromInputValue(e.target.value) + (allDay ? DAY : 0))} />
          </Field>
          <label className="flex h-9 cursor-pointer items-center gap-1.5 text-sm">
            <input type="checkbox" checked={allDay} onChange={(e) => toggleAllDay(e.target.checked)} /> 종일
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          시간으로 올리기:
          <Button size="sm" variant="outline" onClick={() => hours(9, 13)}>
            오전 (09~13시)
          </Button>
          <Button size="sm" variant="outline" onClick={() => hours(14, 18)}>
            오후 (14~18시)
          </Button>
        </div>
        <Field label="행선지 (선택)">
          <Input aria-label="행선지" maxLength={120} value={place} onChange={(e) => setPlace(e.target.value)} placeholder="예: 도청, ○○연수원" />
        </Field>
        <Field label="사유·메모 (선택)" hint="팀 전체가 봅니다. 병명 같은 민감한 내용은 적지 마세요.">
          <Input aria-label="사유" maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 업무 협의, 직무 교육" />
        </Field>
        {err && (
          <p className="text-sm text-urgent" role="alert">
            {err}
          </p>
        )}
      </div>
    </Dialog>
  )
}

function ClerksDialog({ board, onClose }: { board: DutyBoardDto; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const [ids, setIds] = useState(board.clerkIds)
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: () => api.put('/api/duty/clerks', { memberIds: ids }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['events'] })
      onClose()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title="대리 등록자 지정"
      width="max-w-md"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">대리 등록자로 지정한 사람은 다른 팀원의 근무상황을 대신 올리고, 고치고, 지울 수 있습니다(관리 권한은 생기지 않습니다). 최종관리자(서버 PC)와 서무는 지정하지 않아도 할 수 있습니다.</p>
        <MemberPicker value={ids} onChange={setIds} />
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}

export function DutyPage(): React.JSX.Element {
  const dn = useDisplayName()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const online = useConn((s) => s.state === 'online')
  const { data: me } = useMe()
  const [tab, setTab] = useState<Tab>('day')
  const [day, setDay] = useState(() => startOfDay(Date.now()))
  const [dept, setDept] = useState('all')
  const [q, setQ] = useState('')
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [clerks, setClerks] = useState(false)

  const weekStart = startOfWeek(day, { weekStartsOn: 1 }).getTime()
  const monthStart = startOfMonth(day).getTime()
  // one request serves the day and the week view; the list asks for the month
  const from = tab === 'list' ? monthStart : weekStart
  const to = tab === 'list' ? addMonths(monthStart, 1).getTime() : weekStart + 7 * DAY
  const boardQ = useQuery({ queryKey: ['events', 'duty', from, to], queryFn: () => api.get<DutyBoardDto>('/api/duty', { from, to }), enabled: online, placeholderData: (prev) => prev })
  const board = boardQ.data
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/duty/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['events'] })
      void qc.invalidateQueries({ queryKey: ['members'] })
    }
  })

  const blocks = useMemo(() => (board ? deptBlocks(board, dept) : []), [board, dept])
  const byMember = useMemo(() => {
    const m = new Map<string, DutyEntryDto[]>()
    for (const e of board?.entries ?? []) m.set(e.memberId, [...(m.get(e.memberId) ?? []), e])
    return m
  }, [board])
  const today = startOfDay(Date.now())
  const meId = me?.id ?? ''
  const canEdit = (e: DutyEntryDto): boolean => !e.recurring && (e.memberId === meId || !!board?.canManage)
  const canAddFor = (memberId: string): boolean => memberId === meId || !!board?.canManage
  const remove = (e: DutyEntryDto, name: string): void => {
    if (window.confirm(`${name}님의 ${e.type}(${fmtRange(e.start, e.end, e.allDay)})을(를) 지울까요?`)) del.mutate(e.id)
  }
  const move = (n: number): void => setDay(tab === 'list' ? addMonths(monthStart, n).getTime() : startOfDay(day + n * (tab === 'week' ? 7 : 1) * DAY + DAY / 2))

  const actionsFor = (e: DutyEntryDto, name: string): React.JSX.Element | null =>
    e.recurring ? (
      <Button size="icon-sm" variant="ghost" aria-label="반복 일정: 일정 화면에서 고치기" title="반복되는 부재 일정입니다. 일정 화면에서 고칩니다." onClick={() => navigate('/calendar')}>
        <Repeat />
      </Button>
    ) : canEdit(e) ? (
      <>
        <Button size="icon-sm" variant="ghost" aria-label={`${name} ${e.type} 고치기`} onClick={() => setDialog({ edit: e })}>
          <Pencil />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label={`${name} ${e.type} 지우기`} onClick={() => remove(e, name)}>
          <Trash2 />
        </Button>
      </>
    ) : null

  /**
   * 일별: the personnel status the way an office reports it. On top the 총괄표 (one line per
   * department: 총원 / 현재원 / 사고, and the 사고 split by reason); below it each department
   * with its three numbers and the people away, grouped by reason.
   */
  const dayView = (): React.JSX.Element => {
    const d1 = day + DAY
    const shown = blocks.flatMap((b) => b.members)
    const awayOf = (m: DutyMemberDto): DutyEntryDto[] => (byMember.get(m.id) ?? []).filter((e) => onDay(e, day, d1))
    /** People away per reason; someone with two reasons that day is listed under each, but counted once in 사고. */
    const stat = (members: DutyMemberDto[]): { total: number; away: DutyMemberDto[]; byType: Map<string, { m: DutyMemberDto; e: DutyEntryDto }[]> } => {
      const byType = new Map<string, { m: DutyMemberDto; e: DutyEntryDto }[]>()
      const away = members.filter((m) => awayOf(m).length)
      for (const m of away) for (const e of awayOf(m)) byType.set(e.type, [...(byType.get(e.type) ?? []), { m, e }])
      return { total: members.length, away, byType }
    }
    const all = stat(shown)
    const types = [...all.byType.keys()]
    const people = (list: { m: DutyMemberDto }[]): number => new Set(list.map((x) => x.m.id)).size
    const num = 'px-2 py-1.5 text-center tabular-nums'
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-card" data-testid="duty-summary">
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-bold">인원 총괄표</h2>
            <span className="text-sm">
              총원 <b className="text-base">{all.total}</b>명
            </span>
            <span className="text-sm">
              현재원 <b className="text-base text-primary">{all.total - all.away.length}</b>명
            </span>
            <span className="text-sm">
              사고 <b className="text-base text-urgent">{all.away.length}</b>명
            </span>
            <span className="ml-auto text-xs text-muted-foreground">{format(day, 'yyyy. M. d. (EEE)', { locale: ko })} 기준</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm" data-testid="duty-total-table">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-xs text-muted-foreground">
                  <th rowSpan={2} className="px-3 py-1.5 text-left font-medium">
                    부서
                  </th>
                  <th rowSpan={2} className="px-2 py-1.5 font-medium">
                    총원
                  </th>
                  <th rowSpan={2} className="px-2 py-1.5 font-medium">
                    현재원
                  </th>
                  <th colSpan={1 + types.length} className="border-l border-border px-2 py-1 font-medium">
                    사고
                  </th>
                </tr>
                <tr className="border-b border-border bg-muted/50 text-xs text-muted-foreground">
                  <th className="border-l border-border px-2 py-1 font-medium">계</th>
                  {types.map((t) => (
                    <th key={t} className="px-2 py-1 font-medium">
                      <TypeBadge type={t} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border font-bold">
                  <td className="px-3 py-1.5">계</td>
                  <td className={num}>{all.total}</td>
                  <td className={cn(num, 'text-primary')}>{all.total - all.away.length}</td>
                  <td className={cn(num, 'border-l border-border text-urgent')}>{all.away.length}</td>
                  {types.map((t) => (
                    <td key={t} className={num}>
                      {people(all.byType.get(t) ?? [])}
                    </td>
                  ))}
                </tr>
                {blocks.map((b) => {
                  const st = stat(b.members)
                  return (
                    <tr key={b.dept?.id ?? 'none'} className="border-b border-border last:border-0">
                      <td className="px-3 py-1.5" style={{ paddingLeft: 12 + b.depth * 14 }}>
                        {b.dept?.name ?? '부서 미지정'}
                      </td>
                      <td className={num}>{st.total}</td>
                      <td className={num}>{st.total - st.away.length}</td>
                      <td className={cn(num, 'border-l border-border', st.away.length > 0 && 'font-semibold text-urgent')}>{st.away.length}</td>
                      {types.map((t) => {
                        const n = people(st.byType.get(t) ?? [])
                        return (
                          <td key={t} className={cn(num, !n && 'text-muted-foreground/50')}>
                            {n || '·'}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
        {!blocks.length && <EmptyState icon={UserCheck} title="구성원이 없습니다" />}
        {blocks.map((b) => {
          const st = stat(b.members)
          const inOffice = b.members.filter((m) => !awayOf(m).length)
          return (
            <section key={b.dept?.id ?? 'none'} style={{ marginLeft: b.depth * 16 }} className="rounded-lg border border-border bg-card" data-testid="duty-dept">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
                <h2 className="mr-auto text-sm font-bold">{b.dept?.name ?? '부서 미지정'}</h2>
                {(
                  [
                    ['총원', st.total, ''],
                    ['현재원', st.total - st.away.length, 'text-primary'],
                    ['사고', st.away.length, st.away.length ? 'text-urgent' : '']
                  ] as const
                ).map(([k, v, c]) => (
                  <span key={k} className="flex min-w-[4.5rem] flex-col items-center rounded-md border border-border px-2.5 py-1 leading-tight">
                    <span className="text-[0.7rem] text-muted-foreground">{k}</span>
                    <span className="text-sm">
                      <b className={cn('text-base tabular-nums', c)}>{v}</b>명
                    </span>
                  </span>
                ))}
              </div>
              <div className="divide-y divide-border">
                {[...st.byType].map(([t, list]) => (
                  <div key={t} className="flex gap-3 px-4 py-2 text-sm" data-testid="duty-reason">
                    <div className="flex w-24 shrink-0 items-start gap-1.5 pt-0.5">
                      <TypeBadge type={t} />
                      <b className="tabular-nums">{people(list)}명</b>
                    </div>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      {list.map(({ m, e }) => (
                        <div key={`${e.id}:${e.key}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5" data-testid="duty-row">
                          <span className="w-28 shrink-0 truncate font-medium">
                            <MemberLink memberId={m.id} name={m.name}>{dn(m)}</MemberLink> <span className="text-xs font-normal text-muted-foreground">{m.title}</span>
                          </span>
                          <span className="sr-only">{e.type}</span>
                          <span className="w-24 shrink-0 text-xs text-muted-foreground">{dayPart(e, day, d1)}</span>
                          <span className="min-w-0 flex-1 truncate">
                            {[e.place, e.note].filter(Boolean).join(' · ')}
                            {e.end - e.start > DAY && <span className="ml-2 text-xs text-muted-foreground">{fmtRange(e.start, e.end, e.allDay)}</span>}
                          </span>
                          {e.registeredByName && <span className="shrink-0 text-xs text-muted-foreground">{e.registeredByName} 대신 신청</span>}
                          <span className="flex shrink-0">{actionsFor(e, m.name)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {!st.away.length && <p className="px-4 py-2 text-xs text-muted-foreground">사고 인원 없음</p>}
                <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 text-sm">
                  <span className="mr-1 w-24 shrink-0 text-xs text-muted-foreground">현재원 {inOffice.length}명</span>
                  {inOffice.map((m) =>
                    canAddFor(m.id) ? (
                      <span key={m.id} className="inline-flex items-center gap-0.5">
                        <button className="cursor-pointer rounded bg-muted px-1.5 py-0.5 text-xs hover:bg-primary/15" title="눌러서 사고 신청" onClick={() => setDialog({ memberId: m.id, day })}>
                          {dn(m)}
                        </button>
                        {/* the name itself registers an absence here, so the messenger gets its own small button */}
                        {m.id !== meId && (
                          <MemberLink memberId={m.id} name={m.name} className="rounded p-0.5 text-muted-foreground hover:bg-primary/15 hover:text-primary">
                            <MessageSquare className="size-3" aria-label={`${m.name} 메신저 열기`} />
                          </MemberLink>
                        )}
                      </span>
                    ) : (
                      <MemberLink key={m.id} memberId={m.id} name={m.name} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {dn(m)}
                      </MemberLink>
                    )
                  )}
                  {!inOffice.length && <span className="text-xs text-muted-foreground">없음</span>}
                </div>
              </div>
            </section>
          )
        })}
      </div>
    )
  }

  const weekView = (): React.JSX.Element => {
    const days = Array.from({ length: 7 }, (_, i) => startOfDay(weekStart + i * DAY + DAY / 2))
    return (
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[720px] border-collapse text-sm" data-testid="duty-week">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="w-36 px-3 py-2 text-left font-medium">이름</th>
              {days.map((d, i) => (
                <th key={d} className={cn('px-1 py-2 font-medium', d === today && 'bg-primary/10 text-primary', i >= 5 && 'text-urgent/80')}>
                  {format(d, 'M/d (EEE)', { locale: ko })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {blocks.map((b) => [
              <tr key={`h${b.dept?.id ?? 'none'}`} className="border-b border-border bg-muted/50">
                <td colSpan={8} className="px-3 py-1 text-xs font-semibold">
                  {b.dept?.name ?? '부서 미지정'} <span className="font-normal text-muted-foreground">({b.members.length})</span>
                </td>
              </tr>,
              ...b.members.map((m) => (
                <tr key={m.id} className="border-b border-border last:border-0">
                  <td className="truncate px-3 py-1.5">
                    <MemberLink memberId={m.id} name={m.name}>{dn(m)}</MemberLink> <span className="text-xs text-muted-foreground">{m.title}</span>
                  </td>
                  {days.map((d, i) => {
                    const es = (byMember.get(m.id) ?? []).filter((e) => onDay(e, d, d + DAY))
                    const mine = es.find(canEdit)
                    const click = mine ? () => setDialog({ edit: mine }) : !es.length && canAddFor(m.id) ? () => setDialog({ memberId: m.id, day: d }) : undefined
                    return (
                      <td
                        key={d}
                        className={cn('h-9 border-l border-border px-1 py-1 text-center align-middle', d === today && 'bg-primary/5', i >= 5 && !es.length && 'bg-muted/40', click && 'cursor-pointer hover:bg-primary/10')}
                        onClick={click}
                        title={es.map((e) => `${e.type} ${dayPart(e, d, d + DAY)} ${[e.place, e.note].filter(Boolean).join(' · ')}`.trim()).join('\n') || undefined}
                      >
                        <span className="flex flex-wrap justify-center gap-0.5">
                          {es.map((e) => (
                            <TypeBadge key={`${e.id}:${e.key}`} type={e.type} part={dayPart(e, d, d + DAY) === '종일' ? undefined : dayPart(e, d, d + DAY)} />
                          ))}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              ))
            ])}
          </tbody>
        </table>
      </div>
    )
  }

  const listView = (): React.JSX.Element => {
    if (!board) return <></>
    const shown = new Map(blocks.flatMap((b) => b.members.map((m) => [m.id, { m, dept: b.dept?.name ?? '' }] as const)))
    const rows = board.entries
      .filter((e) => shown.has(e.memberId))
      .map((e) => ({ e, ...shown.get(e.memberId)! }))
      .filter((r) => !q.trim() || `${r.m.name} ${dn(r.m)} ${r.dept} ${r.e.type} ${r.e.place} ${r.e.note}`.includes(q.trim()))
    const days = (e: DutyEntryDto): string => (e.allDay ? `${Math.round((e.end - e.start) / DAY)}일` : `${Math.round(((e.end - e.start) / 3600000) * 10) / 10}시간`)
    const exportCsv = (): void => {
      const csv = toCsv([['시작', '끝', '기간', '부서', '이름', '직위', '종류', '행선지', '사유', '대신 올린 사람'], ...rows.map(({ e, m, dept: d }) => [format(e.start, e.allDay ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm'), format(e.allDay ? e.end - DAY : e.end, e.allDay ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm'), days(e), d, m.name, m.title ?? '', e.type, e.place, e.note, e.registeredByName ?? ''])])
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `근무현황_${format(monthStart, 'yyyy-MM')}.csv`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 3000)
    }
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Input aria-label="기록 검색" className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름·종류·행선지 검색" />
          <span className="text-xs text-muted-foreground">{rows.length}건</span>
          <Button size="sm" variant="outline" className="ml-auto" disabled={!rows.length} onClick={exportCsv}>
            <Download /> CSV로 저장
          </Button>
        </div>
        {!rows.length ? (
          <EmptyState icon={List} title="이 달에 올라온 근무상황이 없습니다" />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-sm" data-testid="duty-list">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">기간</th>
                  <th className="px-2 py-2 font-medium">부서</th>
                  <th className="px-2 py-2 font-medium">이름</th>
                  <th className="px-2 py-2 font-medium">종류</th>
                  <th className="px-2 py-2 font-medium">행선지·사유</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ e, m, dept: d }) => (
                  <tr key={`${e.id}:${e.key}`} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-3 py-1.5">
                      {fmtRange(e.start, e.end, e.allDay)} <span className="text-xs text-muted-foreground">{days(e)}</span>
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">{d}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-medium">
                      <MemberLink memberId={m.id} name={m.name}>{dn(m)}</MemberLink>
                    </td>
                    <td className="px-2 py-1.5">
                      <TypeBadge type={e.type} />
                    </td>
                    <td className="px-2 py-1.5">
                      {[e.place, e.note].filter(Boolean).join(' · ')}
                      {e.registeredByName && <span className="ml-2 text-xs text-muted-foreground">{e.registeredByName} 대신 올림</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-right">{actionsFor(e, m.name)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  const label = tab === 'day' ? format(day, 'yyyy년 M월 d일 (EEE)', { locale: ko }) : tab === 'week' ? `${format(weekStart, 'M월 d일', { locale: ko })} ~ ${format(weekStart + 6 * DAY, 'M월 d일', { locale: ko })}` : format(monthStart, 'yyyy년 M월', { locale: ko })
  const TABS: { k: Tab; label: string; icon: typeof List }[] = [
    { k: 'day', label: '일별', icon: CalendarDays },
    { k: 'week', label: '주간', icon: CalendarRange },
    { k: 'list', label: '기록', icon: List }
  ]

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="근무현황"
        description="오늘 누가 자리에 없는지 부서별로 봅니다. 여기 올린 내용은 일정과 팀원 현황(부재)에도 나타납니다."
        actions={
          <>
            {me?.role === 'admin' && board && (
              <Button size="sm" variant="ghost" onClick={() => setClerks(true)}>
                <UserCog /> 대리 등록자 지정
              </Button>
            )}
            {board?.canManage && (
              <Button size="sm" variant="outline" onClick={() => setDialog({ memberId: board.members.find((m) => m.id !== meId)?.id ?? meId, day: tab === 'day' ? day : today })}>
                <UserPlus /> 대신 신청
              </Button>
            )}
            <Button size="sm" disabled={!board || !meId} onClick={() => setDialog({ memberId: meId, day: tab === 'day' ? day : today })}>
              <Plus /> 사고 신청
            </Button>
          </>
        }
      />
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-2">
        <div className="flex gap-1" role="tablist" aria-label="보기">
          {TABS.map((t) => (
            <Button key={t.k} size="sm" role="tab" aria-selected={tab === t.k} variant={tab === t.k ? 'default' : 'outline'} onClick={() => setTab(t.k)}>
              <t.icon /> {t.label}
            </Button>
          ))}
        </div>
        <div className="ml-2 flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="이전" onClick={() => move(-1)}>
            <ChevronLeft />
          </Button>
          <span className="min-w-40 text-center text-sm font-semibold" data-testid="duty-date">
            {label}
          </span>
          <Button size="icon-sm" variant="ghost" aria-label="다음" onClick={() => move(1)}>
            <ChevronRight />
          </Button>
          <Button size="sm" variant="outline" disabled={day === today} onClick={() => setDay(today)}>
            오늘
          </Button>
          <Input aria-label="날짜 고르기" type="date" className="w-40" value={toInputValue(day, true)} onChange={(e) => e.target.value && setDay(fromInputValue(e.target.value))} />
        </div>
        <Select aria-label="부서" className="ml-auto w-44" value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="all">전체 부서</option>
          {board?.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {!board ? !online ? <OfflineState /> : boardQ.isError ? <ErrorState error={boardQ.error} onRetry={() => void boardQ.refetch()} /> : <Loading /> : tab === 'day' ? dayView() : tab === 'week' ? weekView() : listView()}
      </div>
      {dialog && board && <DutyDialog board={board} meId={meId} state={dialog} onClose={() => setDialog(null)} />}
      {clerks && board && <ClerksDialog board={board} onClose={() => setClerks(false)} />}
    </div>
  )
}
