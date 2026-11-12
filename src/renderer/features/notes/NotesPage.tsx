import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { BookOpen, ChevronDown, ChevronRight, Copy, Database, FileDown, FileText, LayoutTemplate, Library, Plus, RotateCcw, Search, Send, Star, Trash2, X } from 'lucide-react'
import { NOTE_TEMPLATES, type DbProps, type NoteDto, type NoteTreeItem } from '@shared/notes'
import type { ScopeInput } from '@shared/schemas/scope'
import type { IpcReq } from '@shared/ipc'
import { DOC_KIND_LABEL } from '@shared/schemas/docs'
import { Button } from '@renderer/components/ui/button'
import { Input, Select } from '@renderer/components/ui/input'
import { Dialog, confirmDialog } from '@renderer/components/Dialog'
import { EmptyState } from '@renderer/components/EmptyState'
import { ScopePicker, defaultScope, scopeIsValid } from '@renderer/components/ScopePicker'
import { invoke } from '@renderer/lib/bridge'
import { api, errorMessage } from '@renderer/lib/api'
import { useConn } from '@renderer/app/conn-store'
import { cn } from '@renderer/lib/utils'
import { NoteEditor } from './NoteEditor'
import { DatabaseView } from './DatabaseView'

const ICONS = ['📄', '📝', '📚', '📁', '🗓️', '✅', '💡', '📌', '⭐', '🔖', '📊', '🧭', '🛠️', '📞', '🏢', '🎯', '💼', '🔒', '📎', '🧾']
const useTree = () => useQuery({ queryKey: ['local', 'notes-tree'], queryFn: () => invoke('notes:tree'), networkMode: 'always' })

function TreeNode({ item, all, depth, current, expanded, toggle, onDrop }: { item: NoteTreeItem; all: NoteTreeItem[]; depth: number; current: string | undefined; expanded: Set<string>; toggle: (id: string) => void; onDrop: (dragId: string, target: string) => void }): React.JSX.Element {
  const navigate = useNavigate()
  const kids = all.filter((n) => n.parentId === item.id && !n.isTemplate)
  const open = expanded.has(item.id)
  const [over, setOver] = useState(false)
  return (
    <div>
      <div
        className={cn('group flex items-center gap-1 rounded py-1 pr-1 text-sm hover:bg-muted', current === item.id && 'bg-primary/10 font-medium text-primary', over && 'ring-2 ring-primary')}
        style={{ paddingLeft: 4 + depth * 14 }}
        draggable
        onDragStart={(e) => e.dataTransfer.setData('text/x-note', item.id)}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOver(false)
          const id = e.dataTransfer.getData('text/x-note')
          if (id && id !== item.id) onDrop(id, item.id)
        }}
        data-testid="note-tree-item"
      >
        <button className={cn('cursor-pointer rounded p-0.5 hover:bg-background', !kids.length && 'invisible')} aria-label={open ? '접기' : '펼치기'} onClick={() => toggle(item.id)}>
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <button className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left" onClick={() => navigate(`/notes/${item.id}`)}>
          <span className="w-4 shrink-0 text-center">{item.icon || (item.kind === 'database' ? <Database className="size-3.5" /> : <FileText className="size-3.5 text-muted-foreground" />)}</span>
          <span className="truncate">{item.title || '제목 없음'}</span>
        </button>
      </div>
      {open && kids.map((k) => <TreeNode key={k.id} item={k} all={all} depth={depth + 1} current={current} expanded={expanded} toggle={toggle} onDrop={onDrop} />)}
    </div>
  )
}

function SendToDocsDialog({ note, onClose }: { note: NoteDto | null; onClose: () => void }): React.JSX.Element {
  const [kind, setKind] = useState('manual')
  const [scope, setScope] = useState<ScopeInput>(defaultScope('team'))
  const [err, setErr] = useState('')
  const navigate = useNavigate()
  const send = useMutation({
    mutationFn: () => api.post<{ id: string }>('/api/docs', { kind, title: note?.title || '제목 없음', bodyHtml: note?.bodyHtml ?? '', scope, tags: [] }),
    onSuccess: (r) => {
      onClose()
      navigate(`/docs/${kind}/${r.id}`)
    },
    onError: (e) => setErr(errorMessage(e))
  })
  return (
    <Dialog
      open={!!note}
      onClose={onClose}
      title="팀 기록으로 보내기"
      footer={
        <Button disabled={!scopeIsValid(scope) || send.isPending} onClick={() => send.mutate()}>
          <Send /> 사본 게시
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">이 페이지의 사본을 팀 기록에 올립니다. 내 노트는 그대로 이 PC에 남습니다. 중요 보안 내용, 개인정보, 비공개 정보는 공유할 수 없습니다.</p>
        <Select aria-label="기록 분류" value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(DOC_KIND_LABEL)
            .filter(([k]) => k !== 'mustread')
            .map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
        </Select>
        <ScopePicker value={scope} onChange={setScope} />
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}

function NoteView({ id, tree }: { id: string; tree: NoteTreeItem[] }): React.JSX.Element {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const online = useConn((s) => s.state === 'online')
  const q = useQuery({ queryKey: ['local', 'note', id], queryFn: () => invoke('notes:get', { id }), networkMode: 'always', staleTime: 0, refetchOnMount: 'always' })
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [saved, setSaved] = useState('')
  const [icons, setIcons] = useState(false)
  const [send, setSend] = useState<NoteDto | null>(null)
  const timer = useRef<number | null>(null)
  const loaded = useRef<string | null>(null)
  const n = q.data
  // Take fresh data from the DB unless the user has unsaved edits (cached data may be older).
  useEffect(() => {
    if (!n) return
    const key = `${n.id}:${n.updatedAt}`
    if (loaded.current === key || timer.current) return
    loaded.current = key
    setTitle(n.title)
    setBody(n.bodyHtml)
  }, [n])
  const refreshTree = (): void => void qc.invalidateQueries({ queryKey: ['local', 'notes-tree'] })
  // Pending edits are merged so a body edit does not drop an unsaved title (and vice versa).
  const pending = useRef<{ title?: string; bodyHtml?: string }>({})
  const flush = (): void => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    const patch = pending.current
    pending.current = {}
    if (patch.title === undefined && patch.bodyHtml === undefined) return
    void invoke('notes:update', { id, ...patch }).then(() => {
      setSaved('저장됨')
      if (patch.title !== undefined) refreshTree()
      void qc.invalidateQueries({ queryKey: ['local', 'note-rows'] })
    })
  }
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => () => flushRef.current(), [])
  const save = (patch: { title?: string; bodyHtml?: string }): void => {
    pending.current = { ...pending.current, ...patch }
    if (timer.current) window.clearTimeout(timer.current)
    setSaved('저장 중…')
    timer.current = window.setTimeout(() => flush(), 500)
  }
  const update = (patch: Omit<IpcReq<'notes:update'>, 'id'>): void =>
    void invoke('notes:update', { id, ...patch }).then(() => {
      void q.refetch()
      refreshTree()
    })
  const createChild = async (kind: 'page' | 'database' = 'page', t = ''): Promise<string> => {
    const nid = await invoke('notes:create', { parentId: id, kind, title: t })
    refreshTree()
    return nid
  }
  if (!n) return <div className="p-6 text-sm text-muted-foreground">{q.isFetched ? '페이지가 없습니다.' : '불러오는 중…'}</div>
  const children = tree.filter((t) => t.parentId === id && !t.isTemplate)
  return (
    <div className="mx-auto max-w-4xl px-8 py-6" data-testid="note-view">
      <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {n.path.map((p) => (
          <span key={p.id} className="flex items-center gap-1">
            <button className="cursor-pointer hover:underline" onClick={() => navigate(`/notes/${p.id}`)}>
              {p.title || '제목 없음'}
            </button>
            ›
          </span>
        ))}
        <span className="ml-auto">{saved || `수정 ${format(n.updatedAt, 'yyyy-MM-dd HH:mm')}`}</span>
        {n.trashedAt && <span className="text-urgent">휴지통에 있는 페이지</span>}
      </div>
      <div className="relative mb-1 flex items-center gap-2">
        <button className="cursor-pointer rounded px-1 text-3xl hover:bg-muted" aria-label="아이콘 고르기" onClick={() => setIcons(!icons)}>
          {n.icon || (n.kind === 'database' ? '🗃️' : '📄')}
        </button>
        {icons && (
          <div className="absolute left-0 top-12 z-20 grid w-64 grid-cols-10 gap-0.5 rounded-lg border border-border bg-card p-2 shadow-xl">
            {ICONS.map((i) => (
              <button key={i} className="cursor-pointer rounded p-0.5 text-lg hover:bg-muted" onClick={() => (setIcons(false), update({ icon: i }))}>
                {i}
              </button>
            ))}
            <button className="col-span-10 mt-1 cursor-pointer text-xs text-muted-foreground hover:underline" onClick={() => (setIcons(false), update({ icon: '' }))}>
              아이콘 없애기
            </button>
          </div>
        )}
        <input
          aria-label="페이지 제목"
          className="min-w-0 flex-1 bg-transparent text-3xl font-bold outline-none placeholder:text-muted-foreground/50"
          placeholder="제목 없음"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            save({ title: e.target.value })
          }}
        />
        <Button size="icon-sm" variant="ghost" aria-label={n.favorite ? '즐겨찾기 해제' : '즐겨찾기'} aria-pressed={n.favorite} onClick={() => update({ favorite: !n.favorite })}>
          <Star className={cn(n.favorite && 'fill-amber-400 text-amber-400')} />
        </Button>
      </div>
      <div className="mb-4 flex flex-wrap gap-1 border-b border-border pb-2">
        {n.rowValues === null && (
          <>
            <Button size="sm" variant="ghost" onClick={() => void createChild().then((c) => navigate(`/notes/${c}`))}>
              <Plus /> 하위 페이지
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void createChild('database', '새 데이터베이스').then((c) => navigate(`/notes/${c}`))}>
              <Database /> 데이터베이스
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={() => void invoke('notes:duplicate', { id, parentId: n.parentId }).then((c) => (refreshTree(), navigate(`/notes/${c}`)))}>
          <Copy /> 복제
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void invoke('notes:duplicate', { id, parentId: null, asTemplate: true }).then(refreshTree)}>
          <LayoutTemplate /> 템플릿으로 저장
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void invoke('notes:export', { id, format: 'md' })}>
          <FileDown /> Markdown
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void invoke('notes:export', { id, format: 'html' })}>
          <FileDown /> HTML
        </Button>
        {online && n.kind === 'page' && (
          <Button size="sm" variant="ghost" onClick={() => setSend(n)}>
            <Send /> 팀 기록으로
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => {
            if (!confirmDialog('이 페이지와 하위 페이지를 휴지통으로 옮길까요? (30일 동안 되살릴 수 있습니다)')) return
            void invoke('notes:toTrash', { id }).then(() => {
              refreshTree()
              navigate(n.parentId ? `/notes/${n.parentId}` : '/notes')
            })
          }}
        >
          <Trash2 /> 휴지통
        </Button>
      </div>
      {n.kind === 'database' ? (
        <DatabaseView dbId={id} props={n.props as DbProps} onProps={(p) => update({ props: p })} onOpen={(rid) => navigate(`/notes/${rid}`)} />
      ) : (
        <NoteEditor
          key={id}
          value={body}
          onChange={(h) => {
            setBody(h)
            save({ bodyHtml: h })
          }}
          pages={tree}
          onOpenPage={(pid) => navigate(`/notes/${pid}`)}
          onCreatePage={async (t) => createChild('page', t)}
        />
      )}
      {children.length > 0 && n.kind === 'page' && (
        <div className="mt-6 border-t border-border pt-3">
          <p className="mb-1 text-xs font-semibold text-muted-foreground">하위 페이지</p>
          {children.map((c) => (
            <button key={c.id} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted" onClick={() => navigate(`/notes/${c.id}`)}>
              {c.icon || <FileText className="size-4 text-muted-foreground" />} {c.title || '제목 없음'}
            </button>
          ))}
        </div>
      )}
      {n.backlinks.length > 0 && (
        <div className="mt-6 border-t border-border pt-3" data-testid="backlinks">
          <p className="mb-1 text-xs font-semibold text-muted-foreground">이 페이지를 연결한 페이지 {n.backlinks.length}</p>
          {n.backlinks.map((b) => (
            <button key={b.id} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted" onClick={() => navigate(`/notes/${b.id}`)}>
              {b.icon || <FileText className="size-4 text-muted-foreground" />} {b.title || '제목 없음'}
            </button>
          ))}
        </div>
      )}
      <SendToDocsDialog note={send} onClose={() => setSend(null)} />
    </div>
  )
}

/** Personal knowledge notes (6.18 ⑤, Notion-style). Stored only on this PC. */
export function NotesPage(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const tree = useTree()
  const all = useMemo(() => tree.data ?? [], [tree.data])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [tplOpen, setTplOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const results = useQuery({ queryKey: ['local', 'notes-search', q], queryFn: () => invoke('notes:search', { q }), enabled: q.trim().length > 0, networkMode: 'always' })
  const trash = useQuery({ queryKey: ['local', 'notes-trash'], queryFn: () => invoke('notes:trash'), enabled: trashOpen, networkMode: 'always' })
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['local'] })

  // Expand the path to the open page.
  useEffect(() => {
    if (!id || !all.length) return
    const s = new Set(expanded)
    let cur = all.find((n) => n.id === id)?.parentId
    let changed = false
    for (let i = 0; cur && i < 50; i++) {
      if (!s.has(cur)) {
        s.add(cur)
        changed = true
      }
      cur = all.find((n) => n.id === cur)?.parentId
    }
    if (changed) setExpanded(s)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, all])

  const create = async (opts: { kind?: 'page' | 'database'; title?: string; icon?: string; bodyHtml?: string } = {}): Promise<void> => {
    const nid = await invoke('notes:create', { parentId: null, ...opts })
    refresh()
    navigate(`/notes/${nid}`)
  }
  const toggle = (nid: string): void => setExpanded((s) => (s.has(nid) ? new Set([...s].filter((x) => x !== nid)) : new Set([...s, nid])))
  const drop = (dragId: string, target: string | null): void => {
    const index = all.filter((n) => n.parentId === target).length
    void invoke('notes:move', { id: dragId, parentId: target, index })
      .then(() => {
        if (target) setExpanded((s) => new Set([...s, target]))
        refresh()
      })
      .catch(() => window.alert('페이지를 자기 아래로 옮길 수 없습니다.'))
  }
  const favorites = all.filter((n) => n.favorite && !n.isTemplate)
  const templates = all.filter((n) => n.isTemplate)
  const roots = all.filter((n) => n.parentId === null && !n.isTemplate)

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/30">
        <div className="space-y-2 border-b border-border p-3">
          <h1 className="flex items-center gap-2 font-bold">
            <Library className="size-4" /> 지식 노트
          </h1>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
            <Input className="pl-8" aria-label="노트 검색" placeholder="제목·내용 검색" value={q} onChange={(e) => setQ(e.target.value)} />
            {q && (
              <button className="absolute right-2 top-2.5 cursor-pointer" aria-label="검색 지우기" onClick={() => setQ('')}>
                <X className="size-4" />
              </button>
            )}
          </div>
          <div className="flex gap-1">
            <Button size="sm" className="flex-1" onClick={() => void create()}>
              <Plus /> 새 페이지
            </Button>
            <Button size="sm" variant="outline" aria-label="템플릿에서 만들기" title="템플릿에서 만들기" onClick={() => setTplOpen(true)}>
              <LayoutTemplate />
            </Button>
            <Button size="sm" variant="outline" aria-label="새 데이터베이스" title="새 데이터베이스" onClick={() => void create({ kind: 'database', title: '새 데이터베이스' })}>
              <Database />
            </Button>
          </div>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto p-2"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const d = e.dataTransfer.getData('text/x-note')
            if (d) drop(d, null)
          }}
          data-testid="note-tree"
        >
          {q.trim() ? (
            <div className="space-y-0.5">
              {(results.data ?? []).map((r) => (
                <button key={r.id} className="block w-full cursor-pointer rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => navigate(`/notes/${r.id}`)} data-testid="note-search-hit">
                  <span className="block truncate text-sm font-medium">
                    {r.icon} {r.title || '제목 없음'}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{r.snippet}</span>
                </button>
              ))}
              {results.data && !results.data.length && <p className="px-2 text-sm text-muted-foreground">찾는 내용이 없습니다.</p>}
            </div>
          ) : (
            <>
              {favorites.length > 0 && (
                <div className="mb-3">
                  <p className="mb-1 px-2 text-xs font-semibold text-muted-foreground">즐겨찾기</p>
                  {favorites.map((f) => (
                    <button key={f.id} className={cn('flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-muted', id === f.id && 'bg-primary/10')} onClick={() => navigate(`/notes/${f.id}`)}>
                      <Star className="size-3.5 fill-amber-400 text-amber-400" /> <span className="truncate">{f.title || '제목 없음'}</span>
                    </button>
                  ))}
                </div>
              )}
              <p className="mb-1 px-2 text-xs font-semibold text-muted-foreground">페이지</p>
              {roots.map((r) => (
                <TreeNode key={r.id} item={r} all={all} depth={0} current={id} expanded={expanded} toggle={toggle} onDrop={drop} />
              ))}
              {!roots.length && <p className="px-2 text-xs text-muted-foreground">아직 페이지가 없습니다.</p>}
            </>
          )}
        </div>
        <button className="flex shrink-0 cursor-pointer items-center gap-2 border-t border-border px-4 py-2 text-sm text-muted-foreground hover:bg-muted" onClick={() => setTrashOpen(true)}>
          <Trash2 className="size-4" /> 휴지통
        </button>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {id ? (
          <NoteView key={id} id={id} tree={all} />
        ) : (
          <EmptyState
            icon={BookOpen}
            title="나만의 지식 노트"
            description="업무 지식·절차·참고 자료를 페이지로 정리하세요. 하위 페이지로 계층을 만들고, [[ 로 페이지를 서로 연결하고, 데이터베이스로 표·보드를 만듭니다. 모든 노트는 이 PC에만 저장됩니다."
            action={<Button onClick={() => void create()}>첫 페이지 만들기</Button>}
          />
        )}
      </div>
      <Dialog open={tplOpen} onClose={() => setTplOpen(false)} title="템플릿에서 만들기">
        <div className="space-y-1">
          {NOTE_TEMPLATES.map((t) => (
            <button key={t.key} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted" onClick={() => (setTplOpen(false), void create({ title: t.title, icon: t.icon, bodyHtml: t.html }))}>
              <span className="text-lg">{t.icon}</span> {t.title}
            </button>
          ))}
          {templates.length > 0 && <p className="px-2 pt-2 text-xs font-semibold text-muted-foreground">내 템플릿</p>}
          {templates.map((t) => (
            <div key={t.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
              <button className="flex flex-1 cursor-pointer items-center gap-2 text-left" onClick={() => void invoke('notes:duplicate', { id: t.id, parentId: null }).then((nid) => (setTplOpen(false), refresh(), navigate(`/notes/${nid}`)))}>
                <span className="text-lg">{t.icon || '📄'}</span> {t.title || '제목 없음'}
              </button>
              <button className="cursor-pointer p-1" aria-label={`${t.title} 템플릿 삭제`} onClick={() => confirmDialog('이 템플릿을 지울까요?') && void invoke('notes:purge', { id: t.id }).then(refresh)}>
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </Dialog>
      <Dialog open={trashOpen} onClose={() => setTrashOpen(false)} title="휴지통 (30일 뒤 자동 삭제)">
        <div className="space-y-1">
          {(trash.data ?? []).map((t) => (
            <div key={t.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
              <span className="flex-1 truncate">
                {t.icon} {t.title || '제목 없음'}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void invoke('notes:restore', { id: t.id }).then(() => (void trash.refetch(), refresh()))}>
                <RotateCcw /> 되살리기
              </Button>
              <Button size="sm" variant="ghost" onClick={() => confirmDialog('완전히 지울까요? 되살릴 수 없습니다.') && void invoke('notes:purge', { id: t.id }).then(() => void trash.refetch())}>
                영구 삭제
              </Button>
            </div>
          ))}
          {trash.data && !trash.data.length && <p className="text-sm text-muted-foreground">휴지통이 비어 있습니다.</p>}
        </div>
      </Dialog>
    </div>
  )
}
