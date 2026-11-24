import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { Building2, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, List, MapPin, Maximize2, Network, Phone, Printer, Search, Settings2, Smartphone, UserRound, ZoomIn, ZoomOut } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Input, Select } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { PresenceDot, PRESENCE_LABEL } from '@renderer/components/PresenceDot'
import { EmptyState, Loading, OfflineState } from '@renderer/components/EmptyState'
import { useMe, useMembers, useOrgDisplay } from '@renderer/lib/queries'
import { startOfDay, DAY } from '@renderer/lib/dates'
import { cn } from '@renderer/lib/utils'
import { useConn } from '@renderer/app/conn-store'
import { MemberCard } from '@renderer/features/directory/MemberCard'
import { displayName, roleLabel, type MemberDto, type Presence } from '@shared/schemas/auth'
import { DUTY_COLORS, dayPart, dutyGroupOf, type DutyEntryDto } from '@shared/schemas/duty'
import type { DepartmentDto } from '@shared/schemas/org'
import { buildOrgTree, findOrgNode, flattenOrg, memberColumns, pruneOrg, type OrgNode } from '@shared/org'
import { useDepartments, useTodayAbsences } from './useOrgData'
import './orgchart.css'

type Node = OrgNode<MemberDto>
type View = 'chart' | 'list'

const NONE_ID = '__none'
const PRESENCES: Presence[] = ['online', 'away', 'absent', 'offline']
/** A4 landscape inside 10mm margins, in CSS pixels (with a little room to spare). */
const PRINT_WIDTH = 1020
const MIN_ZOOM = 0.3
const MAX_ZOOM = 1.5

/** 재석: at the PC now (online or briefly away). */
const isPresent = (m: MemberDto): boolean => m.presence === 'online' || m.presence === 'away'
const lower = (parts: (string | null | undefined)[]): string => parts.filter(Boolean).join(' ').toLowerCase()
const personText = (m: MemberDto): string => lower([m.name, m.nickname, m.title, m.rank, m.duty, m.ext, m.mobile, m.deptName, m.statusMessage])
const deptText = (d: DepartmentDto): string => lower([d.name, d.duties, d.phone, d.location])
const allPeople = (n: Node): MemberDto[] => [...n.members, ...n.children.flatMap(allPeople)]

/** What every part of the chart needs to draw a person or a department. */
interface Shared {
  meId: string | undefined
  absences: Map<string, DutyEntryDto[]>
  dayStart: number
  searching: boolean
  hits: Set<string>
  current: string | null
  collapsed: Set<string>
  toggle: (deptId: string) => void
  open: (m: MemberDto) => void
}

function AbsenceBadges({ entries, dayStart }: { entries: DutyEntryDto[] | undefined; dayStart: number }): React.JSX.Element | null {
  if (!entries?.length) return null
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map((e) => {
        const color = DUTY_COLORS[dutyGroupOf(e.type)]
        const part = dayPart(e, dayStart, dayStart + DAY)
        return (
          <span key={`${e.id}:${e.key}`} className="inline-flex items-center rounded px-1.5 py-0.5 text-[0.72rem] font-semibold leading-none" style={{ color, backgroundColor: `${color}22` }} title={[e.place, e.note].filter(Boolean).join(' · ') || undefined}>
            {e.type}
            {part !== '종일' && <span className="ml-1 font-normal">{part}</span>}
          </span>
        )
      })}
    </span>
  )
}

function RoleBadge({ m }: { m: MemberDto }): React.JSX.Element | null {
  if (m.role !== 'admin') return null
  return <Badge variant={m.isOwner ? 'important' : 'muted'}>{roleLabel(m)}</Badge>
}

function PersonCard({ m, head, s }: { m: MemberDto; head?: boolean; s: Shared }): React.JSX.Element {
  const id = `m:${m.id}`
  const hit = s.hits.has(id)
  const rankLine = [m.title, m.rank].filter(Boolean).join(' · ')
  const badges = head || m.role === 'admin' || m.id === s.meId
  return (
    <button
      type="button"
      data-org-id={id}
      data-testid={`org-person-${m.name}`}
      onClick={() => s.open(m)}
      className={cn(
        'org-person flex w-full cursor-pointer flex-col gap-1 rounded-lg border px-2.5 py-2 text-left transition-shadow hover:border-primary hover:shadow-md',
        head ? 'border-primary/60 bg-accent' : 'border-border bg-card',
        hit && 'ring-2 ring-important',
        s.current === id && 'ring-4 ring-important',
        s.searching && !hit && 'opacity-35'
      )}
    >
      <span className="flex items-center gap-1.5">
        <PresenceDot presence={m.presence} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={displayName(m)}>
          {m.name}
          {m.nickname && <span className="font-normal text-muted-foreground"> ({m.nickname})</span>}
        </span>
      </span>
      {rankLine && <span className="truncate text-xs">{rankLine}</span>}
      {badges && (
        <span className="flex flex-wrap gap-1">
          {head && <Badge>부서장</Badge>}
          <RoleBadge m={m} />
          {m.id === s.meId && <Badge variant="success">나</Badge>}
        </span>
      )}
      {m.duty && (
        <span className="org-clamp-2 text-xs text-muted-foreground" title={m.duty}>
          {m.duty}
        </span>
      )}
      {(m.ext || m.mobile) && (
        <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
          {m.ext && (
            <span className="inline-flex items-center gap-0.5">
              <Phone className="size-3" aria-label="내선" /> {m.ext}
            </span>
          )}
          {m.mobile && (
            <span className="inline-flex items-center gap-0.5">
              <Smartphone className="size-3" aria-label="휴대폰" /> {m.mobile}
            </span>
          )}
        </span>
      )}
      <AbsenceBadges entries={s.absences.get(m.id)} dayStart={s.dayStart} />
      {m.statusMessage && <span className="truncate text-xs text-muted-foreground">“{m.statusMessage}”</span>}
    </button>
  )
}

/** "재석 3/5명 · 부재 1" for everyone in a department and below it. */
function Counts({ people, s }: { people: MemberDto[]; s: Shared }): React.JSX.Element {
  const present = people.filter(isPresent).length
  const away = people.filter((m) => !isPresent(m) && (m.presence === 'absent' || s.absences.has(m.id))).length
  return (
    <>
      <span>
        재석 <b className="text-success">{present}</b>/{people.length}명
      </span>
      {away > 0 && <span>부재 {away}</span>}
    </>
  )
}

function DeptFacts({ d }: { d: DepartmentDto }): React.JSX.Element {
  return (
    <>
      {d.phone && (
        <span className="inline-flex items-center gap-0.5 tabular-nums">
          <Phone className="size-3" aria-label="대표 전화" /> {d.phone}
        </span>
      )}
      {d.location && (
        <span className="inline-flex items-center gap-0.5">
          <MapPin className="size-3" aria-label="위치" /> {d.location}
        </span>
      )}
    </>
  )
}

/** A head who belongs to another department is named here and listed where they belong. */
function HeadLine({ n, s }: { n: Node; s: Shared }): React.JSX.Element | null {
  const h = n.head
  if (!h || h.deptId === n.dept.id) return null
  return (
    <button type="button" className="inline-flex cursor-pointer items-center gap-1 text-xs hover:text-primary" onClick={() => s.open(h)}>
      <UserRound className="size-3" /> 부서장 <b>{h.name}</b> {h.title}
    </button>
  )
}

function DeptBox({ n, s }: { n: Node; s: Shared }): React.JSX.Element {
  const id = `d:${n.dept.id}`
  const headHere = n.head && n.head.deptId === n.dept.id ? n.head : null
  const others = n.members.filter((m) => m.id !== headHere?.id)
  const cols = memberColumns(others.length)
  const closed = !s.searching && s.collapsed.has(n.dept.id)
  const foldable = n.members.length > 0 || n.children.length > 0
  const hit = s.hits.has(id)
  const stripe = n.depth === 0 ? 'var(--primary)' : `color-mix(in srgb, var(--primary) ${n.depth === 1 ? 60 : 35}%, var(--card))`
  return (
    <div
      data-org-id={id}
      data-testid={`org-dept-${n.dept.name}`}
      className={cn('org-box rounded-xl border border-border bg-card text-left shadow-sm', hit && 'ring-2 ring-important', s.current === id && 'ring-4 ring-important')}
      style={{ width: `max(14rem, calc(${cols} * 11rem + ${(cols - 1) * 0.5 + 1}rem + 2px))`, borderTop: `3px solid ${stripe}` }}
    >
      <div className="space-y-1 px-3 py-2">
        <div className="flex items-start gap-1.5">
          <Building2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1 text-sm font-bold leading-tight break-keep">{n.dept.name}</span>
          {foldable && (
            <button
              type="button"
              className="no-print -mr-1 cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-muted"
              aria-label={`${n.dept.name} ${closed ? '펼치기' : '접기'}`}
              aria-expanded={!closed}
              title={closed ? '펼치기' : '접기'}
              onClick={() => s.toggle(n.dept.id)}
            >
              {closed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <Counts people={allPeople(n)} s={s} />
          <DeptFacts d={n.dept} />
        </div>
        <HeadLine n={n} s={s} />
        {n.dept.duties && (
          <p className="org-clamp-2 whitespace-pre-line text-xs text-muted-foreground" title={n.dept.duties}>
            {n.dept.duties}
          </p>
        )}
      </div>
      {closed ? (
        <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          접힘 · 구성원 {n.total}명{n.children.length > 0 && ` · 하위 부서 ${flattenOrg(n.children).length}개`}
        </div>
      ) : (
        n.members.length > 0 && (
          <div className="grid gap-2 border-t border-border p-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {headHere && (
              <div className="col-span-full">
                <PersonCard m={headHere} head s={s} />
              </div>
            )}
            {others.map((m) => (
              <PersonCard key={m.id} m={m} s={s} />
            ))}
          </div>
        )
      )}
    </div>
  )
}

function Branch({ n, s }: { n: Node; s: Shared }): React.JSX.Element {
  const closed = !s.searching && s.collapsed.has(n.dept.id)
  return (
    <li>
      <DeptBox n={n} s={s} />
      {!closed && n.children.length > 0 && (
        <ul>
          {n.children.map((c) => (
            <Branch key={c.dept.id} n={c} s={s} />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * The scrolling area of the chart: scales the tree (fit to width or a chosen zoom) and lets
 * the empty area be dragged. The tree keeps its natural size and is scaled with a transform;
 * the box around it takes the scaled size, so the scroll bars match what is seen.
 */
function ChartCanvas({
  fit,
  zoom,
  printing,
  onScale,
  printList,
  children
}: {
  fit: boolean
  zoom: number
  printing: boolean
  onScale: (scale: number) => void
  /** printed instead of the chart when the chart is too wide for a sheet of paper */
  printList: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [nat, setNat] = useState({ w: 0, h: 0 })
  const [room, setRoom] = useState(0)
  const [dragging, setDragging] = useState(false)

  useLayoutEffect(() => {
    const el = inner.current
    const sc = scroller.current
    if (!el || !sc) return
    const measure = (): void => {
      // hidden (the list is being printed instead): keep the last size
      if (!el.offsetWidth) return
      setNat((p) => (p.w === el.offsetWidth && p.h === el.offsetHeight ? p : { w: el.offsetWidth, h: el.offsetHeight }))
      setRoom(sc.clientWidth)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    ro.observe(sc)
    return () => ro.disconnect()
  }, [])

  const fitTo = (width: number): number => (nat.w > 0 && width > 0 ? Math.max(0.2, Math.min(1, Math.floor((width / nat.w) * 100) / 100)) : 1)
  // 2rem: the padding of the scrolling area
  const paper = fitTo(PRINT_WIDTH)
  const asList = printing && paper < 0.5
  const scale = printing ? paper : fit ? fitTo(room - 32) : zoom
  useEffect(() => {
    if (!printing) onScale(scale)
  }, [scale, printing, onScale])

  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent): void => {
      const d = drag.current
      const sc = scroller.current
      if (!d || !sc) return
      sc.scrollLeft = d.left - (e.clientX - d.x)
      sc.scrollTop = d.top - (e.clientY - d.y)
    }
    const up = (): void => {
      drag.current = null
      setDragging(false)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [dragging])

  return (
    <>
    {asList && printList}
    <div
      ref={scroller}
      data-testid="org-canvas"
      className={cn('org-canvas min-h-0 flex-1 overflow-auto p-4', dragging && 'org-dragging', asList && 'hidden')}
      onMouseDown={(e) => {
        const sc = scroller.current
        if (e.button !== 0 || !sc || (e.target as HTMLElement).closest('button, a, input, select')) return
        drag.current = { x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop }
        setDragging(true)
      }}
    >
      <div className="relative mx-auto" style={{ width: nat.w * scale, height: nat.h * scale }}>
        <div ref={inner} className="absolute left-0 top-0" style={{ width: 'max-content', transform: `scale(${scale})`, transformOrigin: '0 0' }}>
          {children}
        </div>
      </div>
    </div>
    </>
  )
}

function ListView({ nodes, s }: { nodes: Node[]; s: Shared }): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 print:overflow-visible print:p-0" data-testid="org-list">
      <div className="mx-auto max-w-5xl space-y-3">
        {nodes.map((n) => {
          const id = `d:${n.dept.id}`
          return (
            <section
              key={n.dept.id}
              data-org-id={id}
              className={cn('org-list-dept rounded-lg border border-border bg-card', s.hits.has(id) && 'ring-2 ring-important', s.current === id && 'ring-4 ring-important')}
              style={{ marginLeft: `${n.depth * 1.25}rem` }}
            >
              <header className="space-y-0.5 border-b border-border px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5 text-sm font-bold text-foreground">
                    <Building2 className="size-4 text-primary" aria-hidden /> {n.dept.name}
                  </span>
                  <Counts people={allPeople(n)} s={s} />
                  <DeptFacts d={n.dept} />
                  <HeadLine n={n} s={s} />
                </div>
                {n.dept.duties && <p className="whitespace-pre-line text-xs text-muted-foreground">{n.dept.duties}</p>}
              </header>
              {n.members.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">{n.children.length ? '하위 부서에 구성원이 있습니다.' : '소속 구성원이 없습니다.'}</p>
              ) : (
                <table className="w-full table-fixed text-sm">
                  <colgroup>
                    <col className="w-[24%]" />
                    <col className="w-[16%]" />
                    <col />
                    <col className="w-[10%]" />
                    <col className="w-[15%]" />
                    <col className="w-[14%]" />
                  </colgroup>
                  <tbody className="divide-y divide-border">
                    {n.members.map((m) => {
                      const mid = `m:${m.id}`
                      const hit = s.hits.has(mid)
                      return (
                        <tr
                          key={m.id}
                          data-org-id={mid}
                          data-testid={`org-row-${m.name}`}
                          className={cn('org-person cursor-pointer hover:bg-muted', hit && 'bg-important/10', s.current === mid && 'bg-important/25', s.searching && !hit && 'opacity-35')}
                          onClick={() => s.open(m)}
                        >
                          <td className="px-3 py-1.5">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <PresenceDot presence={m.presence} />
                              <b>{m.name}</b>
                              {m.nickname && <span className="text-muted-foreground">({m.nickname})</span>}
                              {n.head?.id === m.id && <Badge>부서장</Badge>}
                              <RoleBadge m={m} />
                            </span>
                          </td>
                          <td className="py-1.5 pr-2">{[m.title, m.rank].filter(Boolean).join(' · ')}</td>
                          <td className="py-1.5 pr-2 text-xs text-muted-foreground">{m.duty}</td>
                          <td className="py-1.5 pr-2 tabular-nums">{m.ext}</td>
                          <td className="py-1.5 pr-2 tabular-nums">{m.mobile}</td>
                          <td className="py-1.5 pr-2 text-xs">
                            <AbsenceBadges entries={s.absences.get(m.id)} dayStart={s.dayStart} />
                            {!s.absences.has(m.id) && <span className="text-muted-foreground">{m.statusMessage || PRESENCE_LABEL[m.presence]}</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

/** 조직도: the team as a top-down chart (or an indented list), with who is in today. */
export function OrgChartPage(): React.JSX.Element {
  const navigate = useNavigate()
  const online = useConn((s) => s.state === 'online')
  const { data: me } = useMe()
  const members = useMembers()
  const depts = useDepartments()
  const absences = useTodayAbsences()
  const org = useOrgDisplay()
  const page = useRef<HTMLDivElement>(null)

  const [view, setView] = useState<View>('chart')
  const [q, setQ] = useState('')
  const [onlyPresent, setOnlyPresent] = useState(false)
  const [deptId, setDeptId] = useState('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [fit, setFit] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [scale, setScale] = useState(1)
  const [printing, setPrinting] = useState(false)
  const [at, setAt] = useState(0)
  const [card, setCard] = useState<string | null>(null)

  const people = useMemo(() => members.data ?? [], [members.data])
  const tree = useMemo(() => buildOrgTree(depts.data ?? [], people), [depts.data, people])
  const flatAll = useMemo(() => flattenOrg(tree.roots), [tree])

  /** What is shown: the chosen department (or all), people filtered, in the order of the screen. */
  const shown = useMemo(() => {
    const picked = deptId === 'all' ? null : findOrgNode(tree.roots, deptId)
    let roots: Node[] = picked ? [picked] : tree.roots
    let loose = picked ? [] : tree.unassigned
    if (onlyPresent) {
      roots = pruneOrg(roots, isPresent)
      loose = loose.filter(isPresent)
    } else if (picked) {
      // the chosen department becomes the top of the chart
      roots = pruneOrg(
        roots,
        () => true,
        () => true
      )
    }
    if (loose.length) {
      const none: Node = { dept: { id: NONE_ID, name: tree.roots.length ? '부서 미지정' : '구성원', parentId: null, sort: 0 }, depth: 0, head: null, members: loose, children: [], total: loose.length }
      roots = [...roots, none]
    }
    return { roots, flat: flattenOrg(roots), single: !!picked }
  }, [tree, deptId, onlyPresent])

  const needle = q.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!needle) return [] as string[]
    const out: string[] = []
    for (const n of shown.flat) {
      if (n.dept.id !== NONE_ID && deptText(n.dept).includes(needle)) out.push(`d:${n.dept.id}`)
      for (const m of n.members) if (personText(m).includes(needle)) out.push(`m:${m.id}`)
    }
    return out
  }, [needle, shown])
  const hits = useMemo(() => new Set(matches), [matches])
  const current = matches.length ? matches[at % matches.length] : null

  useEffect(() => setAt(0), [needle])
  useEffect(() => {
    if (!current) return
    // after the chart has opened the folded departments on the way
    const t = window.setTimeout(() => page.current?.querySelector(`[data-org-id="${CSS.escape(current)}"]`)?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }), 50)
    return () => window.clearTimeout(t)
  }, [current, view])

  if (!online && !members.data) return <OfflineState />
  if (!members.data) return <Loading />

  const dayStart = startOfDay(Date.now())
  const s: Shared = {
    meId: me?.id,
    absences,
    dayStart,
    searching: !!needle,
    hits,
    current,
    collapsed,
    toggle: (id) =>
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (!next.delete(id)) next.add(id)
        return next
      }),
    open: (m) => setCard(m.id)
  }
  const opened = card ? people.find((m) => m.id === card) : undefined

  const present = people.filter(isPresent).length
  const away = people.filter((m) => !isPresent(m) && (m.presence === 'absent' || absences.has(m.id))).length
  const stats: { label: string; value: number; tone?: string }[] = [
    { label: '총원', value: people.length },
    { label: '재석', value: present, tone: 'text-success' },
    { label: '부재', value: away, tone: 'text-personal' },
    { label: '미접속', value: people.length - present - away, tone: 'text-muted-foreground' },
    { label: '부서', value: flatAll.length }
  ]

  const changeZoom = (step: number): void => {
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((scale + step) * 10) / 10)))
    setFit(false)
  }
  const print = (): void => {
    window.addEventListener('afterprint', () => setPrinting(false), { once: true })
    // the chart must be laid out for the paper before the print dialog reads the page
    flushSync(() => setPrinting(true))
    window.print()
  }
  const top = org.teamName || org.orgName || '우리 팀'

  return (
    <div ref={page} className="org-page flex h-full flex-col" data-testid="org-page">
      <PageHeader
        title="조직도"
        description={[org.orgName, org.teamName].filter(Boolean).join(' · ') || undefined}
        actions={
          <div className="no-print flex items-center gap-1">
            <Button size="sm" variant={view === 'chart' ? 'default' : 'outline'} onClick={() => setView('chart')}>
              <Network /> 조직도
            </Button>
            <Button size="sm" variant={view === 'list' ? 'default' : 'outline'} onClick={() => setView('list')}>
              <List /> 목록형
            </Button>
            <Button size="sm" variant="outline" onClick={print}>
              <Printer /> 인쇄
            </Button>
            {me?.isOwner === true && (
              <Button size="sm" variant="outline" onClick={() => navigate('/settings', { state: { focus: 'org' } })}>
                <Settings2 /> 조직 관리
              </Button>
            )}
          </div>
        }
      />

      <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-border px-5 py-2 text-sm" data-testid="org-summary">
        {stats.map((x) => (
          <span key={x.label} className="text-muted-foreground">
            {x.label} <b className={cn('text-base tabular-nums text-foreground', x.tone)}>{x.value}</b>
          </span>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {PRESENCES.map((p) => (
            <span key={p} className="inline-flex items-center gap-1">
              <PresenceDot presence={p} /> {PRESENCE_LABEL[p]}
            </span>
          ))}
          <span>{format(Date.now(), 'yyyy-MM-dd HH:mm')} 기준</span>
        </span>
      </div>

      <div className="no-print flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-2">
        <div className="relative w-64">
          <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="조직도 검색"
            className="pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && matches.length > 0 && setAt((i) => (i + (e.shiftKey ? matches.length - 1 : 1)) % matches.length)}
            placeholder="이름·부서·업무·전화 검색"
          />
        </div>
        {needle && (
          <span className="text-xs text-muted-foreground" data-testid="org-matches">
            {matches.length ? `${(at % matches.length) + 1} / ${matches.length}건 · Enter로 다음` : '찾는 내용이 없습니다'}
          </span>
        )}
        <Select aria-label="부서 선택" className="w-44" value={deptId} onChange={(e) => setDeptId(e.target.value)}>
          <option value="all">전체 부서</option>
          {flatAll.map((n) => (
            <option key={n.dept.id} value={n.dept.id}>
              {'  '.repeat(n.depth)}
              {n.dept.name}
            </option>
          ))}
        </Select>
        <label className="flex cursor-pointer items-center gap-1.5 text-sm">
          <Switch checked={onlyPresent} onCheckedChange={setOnlyPresent} label="재석만 보기" /> 재석만
        </label>
        {view === 'chart' && (
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())} title="모든 부서를 펼칩니다">
              <ChevronsUpDown /> 모두 펼치기
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set(shown.flat.map((n) => n.dept.id)))} title="부서 이름만 보이게 접습니다">
              <ChevronsDownUp /> 모두 접기
            </Button>
            <Button size="icon-sm" variant="outline" aria-label="축소" title="축소" disabled={scale <= MIN_ZOOM} onClick={() => changeZoom(-0.1)}>
              <ZoomOut />
            </Button>
            <button type="button" className="w-12 cursor-pointer rounded text-center text-xs tabular-nums hover:bg-muted" title="100%로 보기" onClick={() => (setZoom(1), setFit(false))} data-testid="org-zoom">
              {Math.round(scale * 100)}%
            </button>
            <Button size="icon-sm" variant="outline" aria-label="확대" title="확대" disabled={scale >= MAX_ZOOM} onClick={() => changeZoom(0.1)}>
              <ZoomIn />
            </Button>
            <Button size="sm" variant={fit ? 'secondary' : 'outline'} onClick={() => setFit(true)} title="조직도 전체가 화면 너비에 들어오게 맞춥니다">
              <Maximize2 /> 화면 맞춤
            </Button>
          </div>
        )}
      </div>

      {shown.roots.length === 0 ? (
        <EmptyState icon={Network} title={onlyPresent ? '지금 재석 중인 구성원이 없습니다' : '표시할 조직이 없습니다'} description={onlyPresent ? '"재석만"을 끄면 전체 조직도가 보입니다.' : undefined} />
      ) : view === 'list' ? (
        <ListView nodes={shown.flat} s={s} />
      ) : (
        <ChartCanvas fit={fit} zoom={zoom} printing={printing} onScale={setScale} printList={<ListView nodes={shown.flat} s={s} />}>
          <ul className="org-tree">
            {shown.single ? (
              <Branch n={shown.roots[0]} s={s} />
            ) : (
              <li>
                <div className="org-box rounded-xl bg-primary px-6 py-3 text-center text-primary-foreground shadow" data-testid="org-root">
                  {org.orgName && org.orgName !== top && <div className="text-xs opacity-90">{org.orgName}</div>}
                  <div className="text-base font-bold">{top}</div>
                  <div className="mt-0.5 text-xs opacity-90">
                    총원 {people.length}명 · 부서 {flatAll.length}개
                  </div>
                </div>
                <ul>
                  {shown.roots.map((n) => (
                    <Branch key={n.dept.id} n={n} s={s} />
                  ))}
                </ul>
              </li>
            )}
          </ul>
        </ChartCanvas>
      )}

      {opened && (
        <MemberCard
          m={opened}
          onClose={() => setCard(null)}
          today={
            absences.has(opened.id) ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2 text-xs">
                <span className="text-muted-foreground">오늘</span>
                <AbsenceBadges entries={absences.get(opened.id)} dayStart={dayStart} />
                <span className="text-muted-foreground">
                  {absences
                    .get(opened.id)!
                    .map((e) => [e.place, e.note].filter(Boolean).join(' · '))
                    .filter(Boolean)
                    .join(', ')}
                </span>
              </div>
            ) : undefined
          }
        />
      )}
    </div>
  )
}
