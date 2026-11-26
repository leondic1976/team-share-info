import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import {
  ArrowLeft,
  Ban,
  BellRing,
  CalendarClock,
  CircleSlash,
  FileArchive,
  FileSpreadsheet,
  FileText,
  FolderInput,
  Inbox,
  ListChecks,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Search,
  Send,
  Trash2,
  Undo2
} from 'lucide-react'
import type { AttachSaveResult } from '@shared/ipc'
import {
  COLLECT_MODE_LABEL,
  COLLECT_STATUS_LABEL,
  canWithdraw,
  collectCsvName,
  collectZipName,
  isAccepting,
  remainingLabel,
  type CollectDto,
  type CollectStatus,
  type CollectStatusDto,
  type CollectSummaryDto
} from '@shared/schemas/collect'
import { deptPathText } from '@shared/org'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { EmptyNote, EmptyState, ErrorState, Loading, OfflineState } from '@renderer/components/EmptyState'
import { AttachmentInput, FileChip, type Att } from '@renderer/components/Attachments'
import { ScopeTags } from '@renderer/components/ScopePicker'
import { MemberLink } from '@renderer/components/MemberLink'
import { ApiError, api, errorMessage } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { confirmPii } from '@renderer/lib/pii'
import { useDisplayName } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import { cn } from '@renderer/lib/utils'
import { CollectDialog } from './CollectDialog'
import { fmtDeadline, useCollectSummary } from './useCollect'

type Tab = 'todo' | 'past' | 'mine' | 'all'

const STATUS_CLS: Record<CollectStatus, string> = {
  submitted: 'bg-success/15 text-success',
  late: 'bg-important/15 text-important',
  na: 'bg-muted text-muted-foreground',
  none: 'bg-urgent/10 text-urgent'
}

function StatusBadge({ status, className }: { status: CollectStatus; className?: string }): React.JSX.Element {
  return <span className={cn('inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-semibold leading-none', STATUS_CLS[status], className)}>{COLLECT_STATUS_LABEL[status]}</span>
}

/** Re-render every minute so the countdowns move. */
function useNow(step = 60_000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), step)
    return () => window.clearInterval(t)
  }, [step])
  return now
}

function Countdown({ r, now }: { r: Pick<CollectSummaryDto, 'deadlineAt' | 'closedAt' | 'allowLate'>; now: number }): React.JSX.Element {
  if (r.closedAt) return <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">마감됨</span>
  const left = r.deadlineAt - now
  const cls = left <= 0 ? (r.allowLate ? 'bg-important/15 text-important' : 'bg-muted text-muted-foreground') : left < 24 * 3600_000 ? 'bg-urgent/10 text-urgent font-semibold' : 'bg-primary/10 text-primary'
  return (
    <span className={cn('whitespace-nowrap rounded px-1.5 py-0.5 text-xs', cls)} data-testid="collect-countdown">
      {left <= 0 && r.allowLate ? '마감 지남 · 늦게 제출 가능' : remainingLabel(r.deadlineAt, now)}
    </span>
  )
}

/** The numbers on top of the 제출 현황, as 근무현황 shows 총원 · 현재원 · 사고. */
function CountBox({ label, value, cls, active, onClick }: { label: string; value: number; cls?: string; active?: boolean; onClick?: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn('flex min-w-[4.75rem] cursor-pointer flex-col items-center rounded-md border bg-card px-2.5 py-1 leading-tight hover:bg-muted', active ? 'border-primary ring-1 ring-primary' : 'border-border')}
      data-testid={`collect-count-${label}`}
    >
      <span className="text-[0.7rem] text-muted-foreground">{label}</span>
      <span className="text-sm">
        <b className={cn('text-base tabular-nums', cls)}>{value}</b>명
      </span>
    </button>
  )
}

export function CollectPage(): React.JSX.Element {
  const { id } = useParams()
  return id ? <CollectDetail key={id} id={id} /> : <CollectList />
}

// ---------- list ----------

function CollectList(): React.JSX.Element {
  const navigate = useNavigate()
  const online = useConn((s) => s.state === 'online')
  const meId = useConn((s) => s.memberId)
  const now = useNow()
  const summary = useCollectSummary(true)
  const q = useQuery({ queryKey: ['collect', 'list'], queryFn: () => api.get<CollectSummaryDto[]>('/api/collects') })
  const [tab, setTab] = useState<Tab | null>(null)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)

  const groups = useMemo(() => {
    const list = q.data ?? []
    const todo = list.filter((r) => r.isTarget && r.myStatus === 'none' && isAccepting(r, now)).sort((a, b) => a.deadlineAt - b.deadlineAt)
    const todoIds = new Set(todo.map((r) => r.id))
    const past = list.filter((r) => r.isTarget && !todoIds.has(r.id)).sort((a, b) => b.deadlineAt - a.deadlineAt)
    const mine = list.filter((r) => r.authorId === meId)
    // the 최종관리자 also sees the requests of others it can see
    const all = list.filter((r) => r.canManage && r.authorId !== meId)
    return { todo, past, mine, all }
  }, [q.data, now, meId])
  const current: Tab = tab ?? (groups.todo.length || !groups.mine.length ? 'todo' : 'mine')
  const shown = groups[current].filter((r) => !search.trim() || `${r.title} ${r.authorName}`.includes(search.trim()))
  const TABS: { k: Tab; label: string; icon: typeof Inbox; n?: number }[] = [
    { k: 'todo', label: '해야 할 것', icon: Inbox, n: groups.todo.length },
    { k: 'past', label: '지난 것', icon: ListChecks },
    { k: 'mine', label: '내가 요청한 것', icon: Send, n: groups.mine.length },
    ...(groups.all.length ? [{ k: 'all' as Tab, label: '다른 사람 요청', icon: Lock }] : [])
  ]

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="자료 취합"
        description="담당별로 낼 자료를 마감일까지 받고, 누가 냈는지 한눈에 봅니다."
        actions={
          summary.data?.canCreate !== false && (
            <Button size="sm" disabled={!online} onClick={() => setCreating(true)} title={online ? undefined : '서버에 연결되어 있지 않습니다'}>
              <Plus /> 새 요청
            </Button>
          )
        }
      />
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-2">
        <div className="flex gap-1" role="tablist" aria-label="보기">
          {TABS.map((t) => (
            <Button key={t.k} size="sm" role="tab" aria-selected={current === t.k} variant={current === t.k ? 'default' : 'outline'} onClick={() => setTab(t.k)}>
              <t.icon /> {t.label}
              {!!t.n && <span className={cn('rounded-full px-1.5 text-[0.7rem] tabular-nums', current === t.k ? 'bg-primary-foreground/20' : 'bg-muted')}>{t.n}</span>}
            </Button>
          ))}
        </div>
        <div className="relative ml-auto w-60">
          <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input aria-label="요청 검색" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="제목·요청한 사람 검색" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {!q.data ? (
          !online ? <OfflineState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <Loading />
        ) : !shown.length ? (
          <EmptyState
            icon={current === 'todo' ? Inbox : FolderInput}
            title={current === 'todo' ? '지금 낼 자료가 없습니다' : current === 'mine' ? '요청한 자료 취합이 없습니다' : '목록이 비어 있습니다'}
            description={current === 'mine' ? '새 요청을 눌러 담당들에게 자료를 요청하세요.' : undefined}
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-sm" data-testid="collect-list">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">제목</th>
                  <th className="px-2 py-2 font-medium">요청한 사람</th>
                  <th className="px-2 py-2 font-medium">마감</th>
                  <th className="px-2 py-2 font-medium">{current === 'mine' || current === 'all' ? '제출 현황' : '내 상태'}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/50" onClick={() => navigate(`/collect/${r.id}`)} data-testid="collect-row">
                    <td className="px-3 py-2">
                      <button
                        className="cursor-pointer text-left font-medium hover:underline"
                        onClick={(e) => {
                          e.stopPropagation()
                          navigate(`/collect/${r.id}`)
                        }}
                      >
                        {r.title}
                      </button>
                      {r.formCount > 0 && <span className="ml-2 text-xs text-muted-foreground">양식 {r.formCount}개</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">{r.authorName}</td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <span className="mr-2 tabular-nums">{fmtDeadline(r.deadlineAt)}</span>
                      <Countdown r={r} now={now} />
                    </td>
                    <td className="whitespace-nowrap px-2 py-2">
                      {r.counts ? (
                        <span className="text-xs">
                          <b className="tabular-nums text-success">{r.counts.submitted + r.counts.late}</b>
                          <span className="text-muted-foreground"> / {r.counts.total}명 제출</span>
                          {r.counts.na > 0 && <span className="text-muted-foreground"> · 해당 없음 {r.counts.na}</span>}
                          {r.counts.none > 0 && <span className="text-urgent"> · 미제출 {r.counts.none}</span>}
                        </span>
                      ) : r.myStatus ? (
                        <StatusBadge status={r.myStatus} />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && (
        <CollectDialog
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false)
            navigate(`/collect/${id}`)
          }}
        />
      )}
    </div>
  )
}

// ---------- one request ----------

function SavedLine({ r, onReveal }: { r: AttachSaveResult; onReveal: () => void }): React.JSX.Element {
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground" data-testid="collect-saved">
      <span className="min-w-0 truncate">
        저장했습니다 · {r.dir}\{r.name}
      </span>
      <button className="cursor-pointer font-medium text-primary hover:underline" onClick={onReveal}>
        폴더 열기
      </button>
    </p>
  )
}

function CollectDetail({ id }: { id: string }): React.JSX.Element {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const online = useConn((s) => s.state === 'online')
  const now = useNow()
  const q = useQuery({ queryKey: ['collect', 'one', id], queryFn: () => api.get<CollectDto>(`/api/collects/${id}`), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2 })
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState('')
  const r = q.data
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['collect'] })
  const close = useMutation({ mutationFn: () => api.post(`/api/collects/${id}/close`), onSuccess: refresh, onError: (e) => setErr(errorMessage(e)) })
  const del = useMutation({
    mutationFn: () => api.del(`/api/collects/${id}`),
    onSuccess: () => {
      refresh()
      navigate('/collect')
    },
    onError: (e) => setErr(errorMessage(e))
  })
  const back = (
    <Button size="sm" variant="ghost" onClick={() => navigate('/collect')}>
      <ArrowLeft /> 목록
    </Button>
  )
  if (!r) {
    const gone = q.error instanceof ApiError && q.error.status === 404
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="자료 취합" actions={back} />
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {gone ? <EmptyState icon={FolderInput} title="요청을 찾을 수 없습니다" description="삭제되었거나 볼 수 없는 요청입니다." /> : !online ? <OfflineState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <Loading />}
        </div>
      </div>
    )
  }
  const open = isAccepting(r, now)
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={r.title}
        description={`요청: ${r.authorName} · 마감 ${fmtDeadline(r.deadlineAt)}`}
        actions={
          <>
            {back}
            {r.canManage && (
              <>
                <Button size="sm" variant="outline" disabled={!online} onClick={() => setEditing(true)}>
                  <Pencil /> 고치기
                </Button>
                {!r.closedAt && (
                  <Button size="sm" variant="outline" disabled={!online || close.isPending} onClick={() => window.confirm('지금 마감할까요? 마감하면 더는 제출을 받지 않습니다.') && close.mutate()}>
                    <Ban /> 일찍 마감
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="text-urgent" disabled={!online || del.isPending} onClick={() => window.confirm(`"${r.title}" 요청을 지울까요? 제출된 파일도 모두 지워지며 되돌릴 수 없습니다.`) && del.mutate()}>
                  <Trash2 /> 삭제
                </Button>
              </>
            )}
          </>
        }
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {err && <p className="text-sm text-urgent">{err}</p>}
        <section className="rounded-lg border border-border bg-card" data-testid="collect-request">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-border px-4 py-2.5 text-sm">
            <h2 className="text-sm font-bold">요청 내용</h2>
            <span className="flex items-center gap-1.5">
              <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
              마감 <b className="tabular-nums">{format(r.deadlineAt, 'yyyy. M. d. HH:mm')}</b>
              <Countdown r={r} now={now} />
            </span>
            <span>
              제출 방식 <b>{COLLECT_MODE_LABEL[r.submitMode]}</b>
            </span>
            <span>
              마감 후 제출 <b>{r.allowLate ? '허용' : '받지 않음'}</b>
            </span>
            <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              대상 <ScopeTags scope={r.scope} />
            </span>
          </div>
          <div className="space-y-3 px-4 py-3">
            {r.description ? <p className="selectable whitespace-pre-wrap text-sm">{r.description}</p> : <p className="text-sm text-muted-foreground">설명이 없습니다.</p>}
            {r.forms.length > 0 && (
              <div className="space-y-1.5" data-testid="collect-forms">
                <div className="text-xs font-medium text-muted-foreground">양식 파일</div>
                {r.forms.map((f) => (
                  <FileChip key={f.id} id={f.id} name={f.name} size={f.size} className="max-w-xl" />
                ))}
              </div>
            )}
          </div>
        </section>
        {r.isTarget && <SubmitCard r={r} open={open} now={now} online={online} />}
        {r.canManage && <StatusSection r={r} open={open} online={online} />}
      </div>
      {editing && <CollectDialog edit={r} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
    </div>
  )
}

// ---------- the target's side ----------

function SubmitCard({ r, open, now, online }: { r: CollectDto; open: boolean; now: number; online: boolean }): React.JSX.Element {
  const qc = useQueryClient()
  const mine = r.mine
  const [editing, setEditing] = useState(!mine)
  const [files, setFiles] = useState<Att[]>(mine?.files ?? [])
  const [text, setText] = useState(mine?.text ?? '')
  const [naOpen, setNaOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const done = (): void => {
    setErr('')
    setNaOpen(false)
    void qc.invalidateQueries({ queryKey: ['collect'] })
  }
  const submit = useMutation({
    mutationFn: () => api.put(`/api/collects/${r.id}/submission`, { text: r.submitMode === 'file' ? '' : text, attachmentIds: r.submitMode === 'text' ? [] : files.map((f) => f.id) }),
    onSuccess: () => {
      setEditing(false)
      done()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  const na = useMutation({
    mutationFn: () => api.post(`/api/collects/${r.id}/na`, { reason }),
    onSuccess: () => {
      setEditing(false)
      setFiles([])
      setText('')
      done()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  const withdraw = useMutation({
    mutationFn: () => api.del(`/api/collects/${r.id}/submission`),
    onSuccess: () => {
      setFiles([])
      setText('')
      setEditing(true)
      done()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  // what the server holds changed (another PC of mine, or after saving): show it
  useEffect(() => {
    if (!editing) {
      setFiles(mine?.files ?? [])
      setText(mine?.text ?? '')
    }
  }, [mine, editing])
  const busy = submit.isPending || na.isPending || withdraw.isPending
  const send = (): void => {
    if (r.submitMode !== 'text' && r.submitMode !== 'both' && !files.length) return setErr('제출할 파일을 올리세요.')
    if (r.submitMode === 'text' && !text.trim()) return setErr('제출할 내용을 적으세요.')
    if (r.submitMode === 'both' && !text.trim() && !files.length) return setErr('파일을 올리거나 내용을 적으세요.')
    if (confirmPii([text], '요청한 사람이 보게 되며,')) submit.mutate()
  }
  const late = now > r.deadlineAt

  return (
    <section className="rounded-lg border border-border bg-card" data-testid="collect-submit">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <h2 className="mr-auto text-sm font-bold">내 제출</h2>
        <StatusBadge status={mine?.status ?? 'none'} />
        {mine && <span className="text-xs text-muted-foreground">{format(mine.submittedAt, 'M월 d일 HH:mm')}</span>}
      </div>
      <div className="space-y-3 px-4 py-3">
        {mine && !editing && (
          <div className="space-y-2" data-testid="collect-mine">
            {mine.status === 'na' ? (
              <p className="text-sm">
                <b>해당 없음</b>으로 알렸습니다.{mine.reason && <span className="text-muted-foreground"> 사유: {mine.reason}</span>}
              </p>
            ) : (
              <>
                {mine.files.map((f) => (
                  <FileChip key={f.id} id={f.id} name={f.name} size={f.size} className="max-w-xl" />
                ))}
                {mine.text && <p className="selectable max-w-3xl whitespace-pre-wrap rounded-md bg-muted/50 px-3 py-2 text-sm">{mine.text}</p>}
              </>
            )}
          </div>
        )}
        {!open ? (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Lock className="size-4" aria-hidden /> {r.closedAt ? '요청한 사람이 마감해서 더는 받지 않습니다.' : '마감이 지나 더는 받지 않습니다.'}
          </p>
        ) : editing ? (
          <div className="space-y-3" data-testid="collect-submit-form">
            {late && <p className="text-sm text-important">마감이 지났습니다. 지금 내면 늦게 제출로 표시됩니다.</p>}
            {r.submitMode !== 'text' && (
              <div className="space-y-1.5">
                <div className="text-sm font-medium">제출할 파일</div>
                <AttachmentInput value={files} onChange={setFiles} />
              </div>
            )}
            {r.submitMode !== 'file' && (
              <div className="space-y-1.5">
                <div className="text-sm font-medium">{r.submitMode === 'both' ? '내용 (선택)' : '내용'}</div>
                <Textarea aria-label="제출 내용" rows={5} value={text} onChange={(e) => setText(e.target.value)} maxLength={20000} />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={!online || busy} onClick={send}>
                {submit.isPending ? <Loader2 className="animate-spin" /> : <Send />} {mine ? '다시 제출' : '제출'}
              </Button>
              {mine && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  취소
                </Button>
              )}
              {!naOpen && mine?.status !== 'na' && (
                <Button size="sm" variant="outline" className="ml-auto" disabled={!online || busy} onClick={() => setNaOpen(true)}>
                  <CircleSlash /> 해당 없음
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={!online || busy} onClick={() => setEditing(true)}>
              <Pencil /> {mine?.status === 'na' ? '제출하기' : '바꿔서 다시 제출'}
            </Button>
            {mine && canWithdraw(r, now) && (
              <Button size="sm" variant="ghost" disabled={!online || busy} onClick={() => window.confirm('낸 것을 거두어들일까요? 미제출로 돌아갑니다.') && withdraw.mutate()}>
                <Undo2 /> 제출 취소
              </Button>
            )}
            {!naOpen && mine?.status !== 'na' && (
              <Button size="sm" variant="outline" className="ml-auto" disabled={!online || busy} onClick={() => setNaOpen(true)}>
                <CircleSlash /> 해당 없음
              </Button>
            )}
          </div>
        )}
        {open && naOpen && (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/50 p-2.5" data-testid="collect-na">
            <span className="text-sm">해당 없음으로 알립니다.</span>
            <Input aria-label="해당 없음 사유" className="min-w-56 flex-1" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="사유 (선택)" />
            <Button size="sm" disabled={!online || busy} onClick={() => (mine?.files.length || mine?.text ? window.confirm('낸 파일과 내용은 지워집니다. 해당 없음으로 바꿀까요?') : true) && na.mutate()}>
              확인
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNaOpen(false)}>
              취소
            </Button>
          </div>
        )}
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </section>
  )
}

// ---------- the requester's side ----------

function StatusSection({ r, open, online }: { r: CollectDto; open: boolean; online: boolean }): React.JSX.Element {
  const dn = useDisplayName()
  const q = useQuery({ queryKey: ['collect', 'status', r.id], queryFn: () => api.get<CollectStatusDto>(`/api/collects/${r.id}/status`) })
  const [filter, setFilter] = useState<CollectStatus | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [saved, setSaved] = useState<AttachSaveResult | null>(null)
  const [busy, setBusy] = useState<'' | 'zip' | 'csv'>('')
  const remind = useMutation({
    mutationFn: () => api.post<{ count: number; online: number }>(`/api/collects/${r.id}/remind`),
    onSuccess: (x) => setMsg({ ok: true, text: x.count ? `${x.count}명에게 다시 알렸습니다.${x.count > x.online ? ` 지금 접속하지 않은 ${x.count - x.online}명은 접속하면 알림을 받습니다.` : ''}` : '알릴 사람이 없습니다.' }),
    onError: (e) => setMsg({ ok: false, text: errorMessage(e) })
  })
  const download = async (kind: 'zip' | 'csv'): Promise<void> => {
    setBusy(kind)
    setMsg(null)
    setSaved(null)
    try {
      const name = kind === 'zip' ? collectZipName(r.title, Date.now()) : collectCsvName(r.title, Date.now())
      const res = await invoke('collect:save', { id: r.id, kind, name })
      if (res.canceled) return
      if (!res.ok) setMsg({ ok: false, text: res.error ?? '내려받지 못했습니다.' })
      else setSaved(res)
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) })
    } finally {
      setBusy('')
    }
  }
  const st = q.data
  const c = st?.counts
  const rows = (st?.rows ?? []).filter((x) => !filter || x.status === filter)
  const handedIn = c ? c.submitted + c.late : 0
  const toggle = (s: CollectStatus): void => setFilter((f) => (f === s ? null : s))

  return (
    <section className="rounded-lg border border-border bg-card" data-testid="collect-status">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
        <h2 className="mr-auto text-sm font-bold">제출 현황</h2>
        {c && (
          <div className="flex flex-wrap gap-1.5" data-testid="collect-summary">
            <CountBox label="대상" value={c.total} active={!filter} onClick={() => setFilter(null)} />
            <CountBox label="제출" value={c.submitted} cls="text-success" active={filter === 'submitted'} onClick={() => toggle('submitted')} />
            <CountBox label="늦게 제출" value={c.late} cls={c.late ? 'text-important' : ''} active={filter === 'late'} onClick={() => toggle('late')} />
            <CountBox label="해당 없음" value={c.na} active={filter === 'na'} onClick={() => toggle('na')} />
            <CountBox label="미제출" value={c.none} cls={c.none ? 'text-urgent' : ''} active={filter === 'none'} onClick={() => toggle('none')} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <Button size="sm" variant="outline" disabled={!online || !open || !c?.none || remind.isPending} onClick={() => remind.mutate()} title={!open ? '마감되어 더 받지 않는 요청입니다' : undefined}>
          {remind.isPending ? <Loader2 className="animate-spin" /> : <BellRing />} 미제출자에게 다시 알림
        </Button>
        <Button size="sm" variant="outline" disabled={!online || !!busy || !handedIn} onClick={() => void download('zip')}>
          {busy === 'zip' ? <Loader2 className="animate-spin" /> : <FileArchive />} 한꺼번에 내려받기 (ZIP)
        </Button>
        <Button size="sm" variant="outline" disabled={!online || !!busy || !c?.total} onClick={() => void download('csv')}>
          {busy === 'csv' ? <Loader2 className="animate-spin" /> : <FileSpreadsheet />} 목록 저장 (CSV)
        </Button>
        {c && <span className="ml-auto text-xs text-muted-foreground">{c.total ? `${Math.round(((handedIn + c.na) / c.total) * 100)}% 응답` : ''}</span>}
      </div>
      {(msg || saved) && (
        <div className="border-b border-border px-4 py-2">
          {msg && <p className={cn('text-sm', msg.ok ? 'text-success' : 'text-urgent')} data-testid="collect-msg">{msg.text}</p>}
          {saved && <SavedLine r={saved} onReveal={() => saved.token && void invoke('attach:reveal', { token: saved.token })} />}
        </div>
      )}
      {!st ? (
        q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <Loading />
      ) : !rows.length ? (
        <EmptyNote>{filter ? `${COLLECT_STATUS_LABEL[filter]} 인원이 없습니다.` : '대상이 없습니다.'}</EmptyNote>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="collect-status-table">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-1.5 font-medium">부서</th>
                <th className="px-2 py-1.5 font-medium">이름</th>
                <th className="px-2 py-1.5 font-medium">상태</th>
                <th className="px-2 py-1.5 font-medium">제출 시각</th>
                <th className="px-2 py-1.5 font-medium">파일 · 글</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.memberId} className="border-b border-border align-top last:border-0" data-testid="collect-status-row" data-status={x.status}>
                  <td className="px-4 py-2 text-muted-foreground" title={deptPathText(x.deptPath) || undefined}>
                    {x.deptName || '부서 미지정'}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 font-medium">
                    <MemberLink memberId={x.memberId} name={x.name}>
                      {dn({ id: x.memberId, name: x.name })}
                    </MemberLink>{' '}
                    <span className="text-xs font-normal text-muted-foreground">{x.title}</span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2">
                    <StatusBadge status={x.status} />
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted-foreground">{x.submittedAt ? format(x.submittedAt, 'M/d HH:mm') : ''}</td>
                  <td className="px-2 py-2">
                    <div className="flex max-w-xl flex-col gap-1">
                      {x.files.map((f) => (
                        <button
                          key={f.id}
                          className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left text-primary hover:underline"
                          title="내려받아 엽니다"
                          onClick={() => void invoke('attach:save', { id: f.id, name: f.name, open: true })}
                        >
                          <FileText className="size-3.5 shrink-0" aria-hidden />
                          <span className="truncate">{f.name}</span>
                        </button>
                      ))}
                      {x.text && (
                        <p className="selectable line-clamp-3 whitespace-pre-wrap" title={x.text}>
                          {x.text}
                        </p>
                      )}
                      {x.reason && <p className="text-muted-foreground">사유: {x.reason}</p>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
