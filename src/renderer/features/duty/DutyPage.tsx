import { sendOrQueue } from '@renderer/lib/outbox'
import { Fragment, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addMonths, format, startOfMonth, startOfWeek } from 'date-fns'
import { ko } from 'date-fns/locale'
import { Building2, CalendarDays, CalendarRange, ChevronLeft, ChevronRight, Download, List, MessageSquare, Pencil, Plus, Printer, Repeat, Trash2, UserCheck, UserCog, UserPlus } from 'lucide-react'
import { MemberLink } from '@renderer/components/MemberLink'
import { useNavigate } from 'react-router-dom'
import { DUTY_COLORS, DUTY_TYPE_NAMES, dayPart, dutyGroupOf, onDay, type DutyBoardDto, type DutyEntryDto, type DutyMemberDto } from '@shared/schemas/duty'
import { dutyDayStat, entriesByMember, peopleIn, type DutyDayStat } from '@shared/dutyDay'
import { holidayMap } from '@shared/holidays'
import { toCsv } from '@shared/csv'
import { DEPT_SEP, deptOptions, deptPathText } from '@shared/org'
import { DUTY_ALL_DEPTS, DUTY_NO_DEPT, dutySections, type DutySection } from '@shared/dutySections'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Input, Select } from '@renderer/components/ui/input'
import { Dialog } from '@renderer/components/Dialog'
import { EmptyState, ErrorState, Loading, OfflineState, EmptyNote } from '@renderer/components/EmptyState'
import { MemberPicker } from '@renderer/components/ScopePicker'
import { Field } from '@renderer/features/setup/SetupFrame'
import { api, errorMessage } from '@renderer/lib/api'
import { DAY, fmtRange, fromInputValue, startOfDay, toInputValue, ymd } from '@renderer/lib/dates'
import { confirmPii } from '@renderer/lib/pii'
import { useDisplayName, useMe, useOrgDisplay } from '@renderer/lib/queries'
import { useHolidays } from '@renderer/features/calendar/calendar-api'
import { TypeBadge } from './TypeBadge'
import { DutyReportDialog } from './DutyReport'
import { useConn } from '@renderer/app/conn-store'
import { cn } from '@renderer/lib/utils'
import { DateTimeInput } from '@renderer/components/DateTimeInput'
import { RoleMark } from '@renderer/components/RoleMark'

type Tab = 'day' | 'week' | 'list'
type Section = DutySection<DutyMemberDto>
type DialogState = { edit: DutyEntryDto } | { memberId: string; day: number }

const sectionName = (s: Section): string => s.dept?.name ?? '부서 미지정'
const sectionPath = (s: Section): string => deptPathText(s.path) || '부서 미지정'

/** A 소속 heading: the levels above in muted text, then the department itself ("본부 > 총무과 > 인사팀"). */
function SectionTitle({ s, suffix }: { s: Section; suffix?: string }): React.JSX.Element {
  return (
    <span title={sectionPath(s)}>
      {s.path.length > 1 && (
        <span className="font-normal text-muted-foreground">
          {deptPathText(s.path.slice(0, -1))}
          {DEPT_SEP}
        </span>
      )}
      {sectionName(s)}
      {suffix && <span className="ml-1 font-normal text-muted-foreground">{suffix}</span>}
    </span>
  )
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
              {/* grouped by 소속 in the order of the org chart, like the rest of the screen */}
              {dutySections(board.departments, board.members)
                .filter((s) => s.members.length)
                .map((s) => (
                  <optgroup key={s.dept?.id ?? 'none'} label={sectionPath(s)}>
                    {s.members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {dn(m)}
                        {m.title ? ` ${m.title}` : ''}
                        {m.id === meId ? ' (나)' : ''}
                      </option>
                    ))}
                  </optgroup>
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
            {(() => {
              const move = (v: string): void => {
                if (!v) return
                const s = fromInputValue(v)
                // moving the start keeps the length
                setEnd(s + Math.max(allDay ? DAY : 0, end - start))
                setStart(s)
              }
              return allDay ? (
                <Input aria-label="시작" type="date" value={toInputValue(start, true)} onChange={(e) => move(e.target.value)} />
              ) : (
                <DateTimeInput label="시작" value={toInputValue(start)} onChange={move} />
              )
            })()}
          </Field>
          <Field label={allDay ? '마지막 날' : '끝'}>
            {allDay ? (
              <Input aria-label="끝" type="date" value={toInputValue(end - DAY, true)} onChange={(e) => e.target.value && setEnd(fromInputValue(e.target.value) + DAY)} />
            ) : (
              <DateTimeInput label="끝" value={toInputValue(end)} onChange={(v) => v && setEnd(fromInputValue(v))} />
            )}
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
  const [report, setReport] = useState(false)
  const org = useOrgDisplay()

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

  // every tab shows the people by 소속: the department tree from the top down, as in the org chart
  const sections = useMemo(() => (board ? dutySections(board.departments, board.members, dept) : []), [board, dept])
  const unassigned = useMemo(() => !!board?.members.some((m) => !m.deptId || !board.departments.some((d) => d.id === m.deptId)), [board])
  const byMember = useMemo(() => entriesByMember(board?.entries ?? []), [board])
  // public holidays of the shown range (관리 → 공휴일: the built-in Korean ones and the organisation's)
  const holidaysQ = useHolidays(useMemo(() => ({ from, to: to - DAY }), [from, to]))
  const holidays = useMemo(() => holidayMap(holidaysQ.data ?? []), [holidaysQ.data])
  const holidayOf = (ms: number): string | undefined => holidays.get(ymd(ms))
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
    const shown = sections.flatMap((s) => s.members)
    const awayOf = (m: DutyMemberDto): DutyEntryDto[] => (byMember.get(m.id) ?? []).filter((e) => onDay(e, day, d1))
    /** People away per reason; someone with two reasons that day is listed under each, but counted once in 사고. */
    const stat = (members: DutyMemberDto[]): DutyDayStat => dutyDayStat(members, byMember, day, d1)
    const all = stat(shown)
    const types = [...all.byType.keys()]
    const people = peopleIn
    const holiday = holidayOf(day)
    const num = 'px-2 py-1.5 text-center tabular-nums'
    /** One line of the 총괄표; a 소속 with departments below it counts them all (소계). */
    const totalRow = (key: string, label: React.ReactNode, depth: number, members: DutyMemberDto[], subtotal: boolean): React.JSX.Element => {
      const st = stat(members)
      return (
        <tr key={key} className={cn('border-b border-border last:border-0', subtotal && 'bg-muted/30 font-semibold')} data-testid="duty-total-row">
          <td className="px-3 py-1.5" style={{ paddingLeft: 12 + depth * 14 }}>
            {label}
          </td>
          <td className={num}>{st.total}</td>
          <td className={num}>{st.total - st.away.length}</td>
          <td className={cn(num, 'border-l border-border', st.away.length > 0 && 'font-semibold text-urgent')}>{st.away.length}</td>
          {types.map((t) => {
            const n = people(st.byType.get(t) ?? [])
            return (
              <td key={t} className={cn(num, !n && 'font-normal text-muted-foreground/50')}>
                {n || '·'}
              </td>
            )
          })}
        </tr>
      )
    }
    const counts = (total: number, away: number): React.JSX.Element[] =>
      (
        [
          ['총원', total, ''],
          ['현재원', total - away, 'text-primary'],
          ['사고', away, away ? 'text-urgent' : '']
        ] as const
      ).map(([k, v, c]) => (
        <span key={k} className="flex min-w-[4.5rem] flex-col items-center rounded-md border border-border bg-card px-2.5 py-1 leading-tight">
          <span className="text-[0.7rem] text-muted-foreground">{k}</span>
          <span className="text-sm">
            <b className={cn('text-base tabular-nums', c)}>{v}</b>명
          </span>
        </span>
      ))
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
            <span className="ml-auto text-xs text-muted-foreground">
              {holiday && <b className="mr-1.5 font-semibold text-urgent">{holiday}</b>}
              {format(day, 'yyyy. M. d. (EEE)', { locale: ko })} 기준
            </span>
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
                {sections.map((s) => (
                  <Fragment key={s.dept?.id ?? 'none'}>
                    {totalRow(s.dept?.id ?? 'none', s.depth === 0 ? <SectionTitle s={s} /> : <span title={sectionPath(s)}>{sectionName(s)}</span>, s.depth, s.all, s.childCount > 0)}
                    {/* the people of a 소속 itself, next to the departments below it, so the lines add up */}
                    {s.childCount > 0 && s.members.length > 0 && totalRow(`${s.dept?.id}:own`, <span className="text-muted-foreground">직속</span>, s.depth + 1, s.members, false)}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {!sections.length && <EmptyState icon={UserCheck} title="구성원이 없습니다" />}
        {sections.map((s) => {
          const st = stat(s.members)
          const inOffice = s.members.filter((m) => !awayOf(m).length)
          const sub = s.childCount > 0 ? stat(s.all) : null
          return (
            <Fragment key={s.dept?.id ?? 'none'}>
              {/* a 소속 with departments below it: its heading with the numbers of everyone under it */}
              {sub && (
                <div style={{ marginLeft: s.depth * 16 }} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/50 px-4 py-2" data-testid="duty-group">
                  <h2 className="mr-auto flex items-center gap-1.5 text-sm font-bold">
                    <Building2 className="size-4 shrink-0 text-muted-foreground" />
                    <SectionTitle s={s} suffix="소계" />
                  </h2>
                  {counts(sub.total, sub.away.length)}
                </div>
              )}
              {s.members.length > 0 && (
            <section style={{ marginLeft: (s.depth + (sub ? 1 : 0)) * 16 }} className="rounded-lg border border-border bg-card" data-testid="duty-dept">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
                <h2 className="mr-auto text-sm font-bold">
                  <SectionTitle s={s} suffix={sub ? '직속' : undefined} />
                </h2>
                {counts(st.total, st.away.length)}
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
                {!st.away.length && <EmptyNote>사고 인원 없음</EmptyNote>}
                <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 text-sm">
                  <span className="mr-1 w-24 shrink-0 text-xs text-muted-foreground">현재원 {inOffice.length}명</span>
                  {inOffice.map((m) =>
                    canAddFor(m.id) ? (
                      <span key={m.id} className="inline-flex items-center gap-0.5">
                        <button className="cursor-pointer rounded bg-muted px-1.5 py-0.5 text-xs hover:bg-primary/15" title="눌러서 사고 신청" onClick={() => setDialog({ memberId: m.id, day })}>
                          {dn(m)}
                          <RoleMark memberId={m.id} />
                        </button>
                        {/* the name itself registers an absence here, so the messenger gets its own small button */}
                        {m.id !== meId && (
                          <MemberLink memberId={m.id} name={m.name} noMark className="rounded p-0.5 text-muted-foreground hover:bg-primary/15 hover:text-primary">
                            <MessageSquare className="size-3" aria-label={`${m.name} 메신저 열기`} />
                          </MemberLink>
                        )}
                      </span>
                    ) : (
                      <MemberLink key={m.id} memberId={m.id} name={m.name} noMark className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {dn(m)}
                        <RoleMark memberId={m.id} />
                      </MemberLink>
                    )
                  )}
                  {!inOffice.length && <span className="text-xs text-muted-foreground">없음</span>}
                </div>
              </div>
            </section>
              )}
            </Fragment>
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
              <th className="w-36 px-3 py-1.5 text-left align-top font-medium">이름</th>
              {days.map((d, i) => {
                const h = holidayOf(d)
                return (
                  <th key={d} className={cn('px-1 py-1.5 align-top font-medium', d === today && 'bg-primary/10 text-primary', (i >= 5 || h) && 'text-urgent/80', h && 'text-urgent')} data-holiday={h} title={h}>
                    {format(d, 'M/d (EEE)', { locale: ko })}
                    {h && <span className="block truncate text-[0.7rem] font-semibold leading-tight">{h}</span>}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {sections.map((s) => [
              <tr key={`h${s.dept?.id ?? 'none'}`} className="border-b border-border bg-muted/50" data-testid="duty-week-dept">
                <td colSpan={8} className="py-1 pr-3 text-xs font-semibold" style={{ paddingLeft: 12 + s.depth * 14 }}>
                  <SectionTitle s={s} /> <span className="font-normal text-muted-foreground">({s.childCount > 0 ? `${s.all.length}명, 직속 ${s.members.length}명` : `${s.members.length}명`})</span>
                </td>
              </tr>,
              ...s.members.map((m) => (
                <tr key={m.id} className="border-b border-border last:border-0">
                  <td className="truncate py-1.5 pr-3" style={{ paddingLeft: 20 + s.depth * 14 }}>
                    <MemberLink memberId={m.id} name={m.name}>{dn(m)}</MemberLink> <span className="text-xs text-muted-foreground">{m.title}</span>
                  </td>
                  {days.map((d, i) => {
                    const es = (byMember.get(m.id) ?? []).filter((e) => onDay(e, d, d + DAY))
                    const mine = es.find(canEdit)
                    const click = mine ? () => setDialog({ edit: mine }) : !es.length && canAddFor(m.id) ? () => setDialog({ memberId: m.id, day: d }) : undefined
                    return (
                      <td
                        key={d}
                        className={cn('h-9 border-l border-border px-1 py-1 text-center align-middle', d === today && 'bg-primary/5', (i >= 5 || holidays.has(ymd(d))) && !es.length && 'bg-muted/40', click && 'cursor-pointer hover:bg-primary/10')}
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
    // by 소속 (the department tree order, inside a department the member order an admin set); one person's lines by date
    let order = 0
    const shown = new Map(sections.flatMap((s) => s.members.map((m) => [m.id, { m, dept: deptPathText(s.path), rank: order++ }] as const)))
    const rows = board.entries
      .filter((e) => shown.has(e.memberId))
      .map((e) => ({ e, ...shown.get(e.memberId)! }))
      .filter((r) => !q.trim() || `${r.m.name} ${dn(r.m)} ${r.dept} ${r.e.type} ${r.e.place} ${r.e.note}`.includes(q.trim()))
      .sort((x, y) => x.rank - y.rank || x.e.start - y.e.start)
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
    const monthHolidays = (holidaysQ.data ?? []).filter((h) => h.date.startsWith(format(monthStart, 'yyyy-MM')))
    return (
      <div className="space-y-3">
        {monthHolidays.length > 0 && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="duty-month-holidays">
            <span className="font-semibold">이 달의 공휴일</span>
            {monthHolidays.map((h) => (
              <span key={h.date}>
                {format(new Date(`${h.date}T00:00:00`), 'M. d.(EEE)', { locale: ko })} <b className="font-semibold text-urgent">{h.name}</b>
              </span>
            ))}
          </p>
        )}
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
        description="오늘 누가 자리에 없는지 소속별로 봅니다. 여기 올린 내용은 일정과 팀원 현황(부재)에도 나타납니다."
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
            {tab === 'day' && holidayOf(day) && (
              <span className="ml-1.5 text-xs font-semibold text-urgent" data-testid="duty-holiday">
                {holidayOf(day)}
              </span>
            )}
          </span>
          <Button size="icon-sm" variant="ghost" aria-label="다음" onClick={() => move(1)}>
            <ChevronRight />
          </Button>
          <Button size="sm" variant="outline" disabled={day === today} onClick={() => setDay(today)}>
            오늘
          </Button>
          <Input aria-label="날짜 고르기" type="date" className="w-40" value={toInputValue(day, true)} onChange={(e) => e.target.value && setDay(fromInputValue(e.target.value))} />
        </div>
        {tab === 'day' && (
          <Button size="sm" variant="outline" disabled={!board} onClick={() => setReport(true)}>
            <Printer /> 보고서 인쇄
          </Button>
        )}
        <Select aria-label="부서" className="ml-auto w-48" value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value={DUTY_ALL_DEPTS}>전체 부서</option>
          {/* the department tree, indented, as in the org chart */}
          {deptOptions(board?.departments ?? []).map((d) => (
            <option key={d.id} value={d.id} title={deptPathText(d.path)}>
              {d.label}
            </option>
          ))}
          {(unassigned || dept === DUTY_NO_DEPT) && <option value={DUTY_NO_DEPT}>부서 미지정</option>}
        </Select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {!board ? !online ? <OfflineState /> : boardQ.isError ? <ErrorState error={boardQ.error} onRetry={() => void boardQ.refetch()} /> : <Loading /> : tab === 'day' ? dayView() : tab === 'week' ? weekView() : listView()}
      </div>
      {dialog && board && <DutyDialog board={board} meId={meId} state={dialog} onClose={() => setDialog(null)} />}
      {clerks && board && <ClerksDialog board={board} onClose={() => setClerks(false)} />}
      {report && board && tab === 'day' && (
        <DutyReportDialog
          board={board}
          sections={sections}
          day={day}
          holiday={holidayOf(day)}
          org={[org.orgName, org.teamName].filter(Boolean).join(' ')}
          scope={dept === DUTY_ALL_DEPTS ? '' : dept === DUTY_NO_DEPT ? '부서 미지정' : deptPathText(deptOptions(board.departments).find((d) => d.id === dept)?.path ?? [])}
          author={me ? [dn(me), me.title].filter(Boolean).join(' ') : ''}
          onClose={() => setReport(false)}
        />
      )}
    </div>
  )
}
