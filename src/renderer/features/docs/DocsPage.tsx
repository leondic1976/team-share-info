import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { format } from 'date-fns'
import { BookOpen, Plus, Search, Pencil, History, Trash2, Printer, BellRing, CheckCircle2, AlertTriangle, CalendarRange, ChevronRight } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { RichView } from '@renderer/components/Editor'
import { AttachmentList } from '@renderer/components/Attachments'
import { ScopeTags } from '@renderer/components/ScopePicker'
import { EmptyState, Loading, OfflineState } from '@renderer/components/EmptyState'
import { api, errorMessage } from '@renderer/lib/api'
import { useConn } from '@renderer/app/conn-store'
import { useSpace } from '@renderer/app/space-store'
import { DOC_KIND_LABEL, type DocDto, type DocKind, type DocRevisionDto, type DocSummaryDto } from '@shared/schemas/docs'
import { DocEditor, type DocDraft } from './DocEditor'
import { AnnualCalendar } from './AnnualCalendar'
import { cn } from '@renderer/lib/utils'
import { FavoriteStar } from '@renderer/features/memos/widgets'

const SECTIONS: (DocKind | 'annual')[] = ['mustread', 'manual', 'handover', 'minutes', 'faq', 'annual']
const SECTION_LABEL = { ...DOC_KIND_LABEL, annual: '연간 업무 달력' }

function DocView({ id, onEdit, onDeleted }: { id: string; onEdit: (d: DocDto) => void; onDeleted: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const [panel, setPanel] = useState<null | 'revisions' | 'reads'>(null)
  const [msg, setMsg] = useState('')
  const q = useQuery({ queryKey: ['docs', 'detail', id], queryFn: () => api.get<DocDto>(`/api/docs/${id}`) })
  const revs = useQuery({ queryKey: ['docs', 'revisions', id], queryFn: () => api.get<DocRevisionDto[]>(`/api/docs/${id}/revisions`), enabled: panel === 'revisions' })
  const reads = useQuery({ queryKey: ['docs', 'reads', id], queryFn: () => api.get<{ memberId: string; name: string; readAt: number | null }[]>(`/api/docs/${id}/reads`), enabled: panel === 'reads' })
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['docs'] }),
    onError: (e) => setMsg(errorMessage(e))
  })
  const d = q.data
  const read = d?.read
  const mark = run.mutate
  useEffect(() => {
    if (d && !read) mark(() => api.post(`/api/docs/${d.id}/read`))
  }, [d, read, mark])
  if (!d) return <Loading />
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-6 py-5" data-testid="doc-view">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={d.kind === 'mustread' ? 'urgent' : 'muted'}>{DOC_KIND_LABEL[d.kind]}</Badge>
          <ScopeTags scope={d.scope} />
          {d.tags.map((t) => (
            <Badge key={t} variant="default">
              #{t}
            </Badge>
          ))}
          {d.stale && (
            <Badge variant="important">
              <AlertTriangle className="size-3" /> 내용 확인 필요
            </Badge>
          )}
        </div>
        <h2 className="mt-2 flex items-center gap-1 text-xl font-bold">
          {d.title}
          <FavoriteStar itemType="doc" itemId={d.id} title={d.title} route={`/docs/${d.kind}/${d.id}`} />
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          작성 {d.authorName} · 마지막 수정 {d.updatedByName ?? d.authorName} {format(d.updatedAt, 'yyyy-MM-dd HH:mm')}
        </p>
      </div>
      <div className="no-print flex flex-wrap gap-2">
        {d.canEdit && (
          <Button size="sm" onClick={() => onEdit(d)}>
            <Pencil /> 고치기
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => setPanel(panel === 'revisions' ? null : 'revisions')}>
          <History /> 변경 이력 {d.revisionCount}
        </Button>
        {d.readStats && (
          <Button size="sm" variant="outline" onClick={() => setPanel(panel === 'reads' ? null : 'reads')}>
            읽음 {d.readStats.read}/{d.readStats.total}
          </Button>
        )}
        {d.stale && d.canEdit && (
          <Button size="sm" variant="outline" onClick={() => run.mutate(() => api.post(`/api/docs/${d.id}/review`))}>
            <CheckCircle2 /> 내용 확인함
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => window.print()}>
          <Printer /> 인쇄·PDF
        </Button>
        {d.canDelete && (
          <Button size="sm" variant="ghost" className="ml-auto text-urgent" onClick={() => window.confirm('이 문서를 지울까요?') && run.mutate(() => api.del(`/api/docs/${d.id}`).then(onDeleted))}>
            <Trash2 /> 삭제
          </Button>
        )}
      </div>
      {msg && <p className="text-sm text-urgent">{msg}</p>}
      {panel === 'reads' && (
        <div className="rounded-md border border-border p-3 text-sm" data-testid="doc-reads">
          <div className="mb-2 flex items-center">
            <b>읽음 현황</b>
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => run.mutate(async () => setMsg(`${(await api.post<{ count: number }>(`/api/docs/${d.id}/remind`)).count}명에게 다시 알렸습니다.`))}>
              <BellRing /> 안 읽은 사람에게 알림
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {reads.data?.map((r) => (
              <span key={r.memberId} className={cn('rounded-full px-2 py-0.5 text-xs', r.readAt ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground')}>
                {r.name} {r.readAt ? format(r.readAt, 'M/d HH:mm') : '안 읽음'}
              </span>
            ))}
          </div>
        </div>
      )}
      {panel === 'revisions' && (
        <div className="space-y-1 rounded-md border border-border p-3 text-sm">
          <b>변경 이력</b>
          {revs.data?.length === 0 && <p className="text-xs text-muted-foreground">이전 버전이 없습니다.</p>}
          {revs.data?.map((r) => (
            <details key={r.id} className="rounded bg-muted/50 px-2 py-1">
              <summary className="cursor-pointer text-xs">
                {format(r.editedAt, 'yyyy-MM-dd HH:mm')} {r.editedByName}님이 고치기 전 버전 · {r.title}
              </summary>
              <RichView html={r.bodyHtml} className="mt-2 border-t border-border pt-2" />
              {d.canEdit && (
                <Button size="sm" variant="outline" className="mt-2" onClick={() => window.confirm('이 버전으로 되돌릴까요? 지금 내용은 이력에 남습니다.') && run.mutate(() => api.post(`/api/docs/${d.id}/restore`, { revisionId: r.id }))}>
                  이 버전으로 복원
                </Button>
              )}
            </details>
          ))}
        </div>
      )}
      <RichView html={d.bodyHtml || '<p>(내용 없음)</p>'} />
      <AttachmentList items={d.attachments} />
    </div>
  )
}

export function DocsPage(): React.JSX.Element {
  const { section = 'mustread', id } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const online = useConn((s) => s.state === 'online')
  const space = useSpace((s) => s.space)
  const [q, setQ] = useState('')
  const [editor, setEditor] = useState<null | { draft?: DocDraft; edit?: DocDto }>(null)
  const kind = section as DocKind | 'annual'
  const list = useQuery({
    queryKey: ['docs', 'list', kind, q, space],
    queryFn: () => api.get<DocSummaryDto[]>('/api/docs', { kind: kind === 'annual' ? undefined : kind, q, groupId: space === 'team' ? undefined : space }),
    enabled: online && kind !== 'annual',
    placeholderData: (p) => p
  })
  const unread = useQuery({ queryKey: ['docs', 'unread'], queryFn: () => api.get<DocSummaryDto[]>('/api/docs', { unread: true }), enabled: online })

  // Calendar "회의록 작성" opens here with ?new=minutes&title=&eventId=&body=
  useEffect(() => {
    const nk = params.get('new') as DocKind | null
    if (nk) setEditor({ draft: { kind: nk, title: params.get('title') ?? '', eventId: params.get('eventId'), bodyHtml: params.get('body') ?? undefined } })
  }, [params])

  // Manual tree order: parents followed by children.
  const ordered = useMemo(() => {
    const rows = list.data ?? []
    if (kind !== 'manual' || q.trim()) return rows.map((r) => ({ doc: r, depth: 0 }))
    const out: { doc: DocSummaryDto; depth: number }[] = []
    const walk = (parent: string | null, depth: number): void => {
      for (const d of rows.filter((r) => r.parentId === parent).sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title))) {
        out.push({ doc: d, depth })
        walk(d.id, depth + 1)
      }
    }
    walk(null, 0)
    for (const r of rows) if (!out.some((o) => o.doc.id === r.id)) out.push({ doc: r, depth: 0 })
    return out
  }, [list.data, kind, q])

  if (!online && !list.data) return <OfflineState />
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="기록"
        description="팀이 알아야 할 것과 업무 노하우를 쌓아 두는 곳입니다."
        actions={
          kind !== 'annual' && (
            <Button onClick={() => setEditor({ draft: { kind } })} disabled={!online}>
              <Plus /> {SECTION_LABEL[kind]} 쓰기
            </Button>
          )
        }
      />
      <div className="flex min-h-0 flex-1">
        <aside className="w-48 shrink-0 space-y-0.5 border-r border-border p-2" aria-label="기록 분류">
          {SECTIONS.map((s) => (
            <button
              key={s}
              onClick={() => navigate(`/docs/${s}`)}
              className={cn('flex w-full cursor-pointer items-center gap-1.5 rounded px-2.5 py-1.5 text-left text-sm hover:bg-muted', kind === s && 'bg-primary/10 font-semibold text-primary')}
            >
              {s === 'annual' ? <CalendarRange className="size-4" /> : <BookOpen className="size-4" />}
              {SECTION_LABEL[s]}
              {s === 'mustread' && (unread.data?.length ?? 0) > 0 && <span className="ml-auto rounded-full bg-urgent px-1.5 text-[0.7rem] font-bold text-white">{unread.data?.length}</span>}
            </button>
          ))}
        </aside>
        {kind === 'annual' ? (
          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            <AnnualCalendar />
          </div>
        ) : (
          <>
            <div className="flex w-80 shrink-0 flex-col border-r border-border">
              <div className="relative border-b border-border p-2">
                <Search className="absolute left-4 top-4.5 size-4 text-muted-foreground" />
                <Input aria-label="기록 검색" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="제목·내용·태그 검색" />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto" data-testid="doc-list">
                {list.isLoading ? (
                  <Loading />
                ) : !ordered.length ? (
                  <EmptyState icon={BookOpen} title={`${SECTION_LABEL[kind]}이(가) 없습니다`} />
                ) : (
                  ordered.map(({ doc: d, depth }) => (
                    <button
                      key={d.id}
                      onClick={() => navigate(`/docs/${kind}/${d.id}`)}
                      className={cn('block w-full cursor-pointer border-b border-border py-2 pr-3 text-left hover:bg-muted', id === d.id && 'bg-primary/5')}
                      style={{ paddingLeft: 12 + depth * 16 }}
                      data-testid={`doc-item-${d.title}`}
                    >
                      <div className="flex items-center gap-1.5">
                        {depth > 0 && <ChevronRight className="size-3 text-muted-foreground" />}
                        {d.kind === 'mustread' && !d.read && <span className="size-2 shrink-0 rounded-full bg-urgent" aria-label="안 읽음" />}
                        <span className={cn('truncate text-sm', d.kind === 'mustread' && !d.read && 'font-bold')}>{d.title}</span>
                        {d.stale && <AlertTriangle className="size-3.5 shrink-0 text-important" aria-label="내용 확인 필요" />}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        {format(d.updatedAt, 'M/d')} · {d.updatedByName ?? d.authorName}
                        {d.readStats && <span className="ml-auto">읽음 {d.readStats.read}/{d.readStats.total}</span>}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto">
              {id ? <DocView key={id} id={id} onEdit={(d) => setEditor({ edit: d })} onDeleted={() => navigate(`/docs/${kind}`)} /> : <EmptyState icon={BookOpen} title="문서를 선택하세요" />}
            </div>
          </>
        )}
      </div>
      {editor && (
        <DocEditor
          draft={editor.draft}
          edit={editor.edit}
          onClose={() => setEditor(null)}
          onSaved={(nid) => {
            const k = editor.edit?.kind ?? editor.draft?.kind ?? kind
            setEditor(null)
            navigate(`/docs/${k}/${nid}`)
          }}
        />
      )}
    </div>
  )
}

