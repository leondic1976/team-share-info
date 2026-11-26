import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { format } from 'date-fns'
import { Plus, ClipboardList, Pin, Paperclip, MessageSquare, Eye, Vote, Trash2, Settings2, Search, Lock, TriangleAlert, X } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Dialog } from '@renderer/components/Dialog'
import { Editor, RichView } from '@renderer/components/Editor'
import { AttachmentInput, AttachmentList, type Att } from '@renderer/components/Attachments'
import { Comments } from '@renderer/components/Comments'
import { MemberLink } from '@renderer/components/MemberLink'
import { ScopePicker, ScopeTags, defaultScope, scopeIsValid } from '@renderer/components/ScopePicker'
import { EmptyState, Loading, OfflineState } from '@renderer/components/EmptyState'
import { Field } from '@renderer/features/setup/SetupFrame'
import { sendOrQueue } from '@renderer/lib/outbox'
import { api, errorMessage } from '@renderer/lib/api'
import { fromInputValue } from '@renderer/lib/dates'
import { useMe } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import { useSpace } from '@renderer/app/space-store'
import type { BoardDto, PollDto, PostDto, PostSummaryDto } from '@shared/schemas/work'
import type { ScopeInput } from '@shared/schemas/scope'
import { cn } from '@renderer/lib/utils'
import { FavoriteStar } from '@renderer/features/memos/widgets'
import { confirmPii } from '@renderer/lib/pii'
import type { PiiAck } from '@shared/pii'
import { DateTimeInput } from '@renderer/components/DateTimeInput'
import { RoleMark } from '@renderer/components/RoleMark'

const KIND_LABEL = { free: '자유', work: '업무 공유', qna: '질의응답' } as const

function BoardDialog({ edit, onClose }: { edit?: BoardDto; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const space = useSpace((s) => s.space)
  const [name, setName] = useState(edit?.name ?? '')
  const [kind, setKind] = useState<BoardDto['kind']>(edit?.kind ?? 'free')
  const [desc, setDesc] = useState(edit?.description ?? '')
  const [scope, setScope] = useState<ScopeInput>(edit ? { type: edit.scope.type, groupIds: edit.scope.groups.map((g) => g.id), memberIds: edit.scope.members.map((m) => m.id) } : defaultScope(space))
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: () => (edit ? api.patch(`/api/boards/${edit.id}`, { name, kind, description: desc, scope }) : api.post('/api/boards', { name, kind, description: desc, scope })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['boards'] })
      onClose()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title={edit ? '게시판 설정' : '게시판 만들기'}
      footer={
        <>
          {edit && (
            <Button
              variant="ghost"
              className="mr-auto text-urgent"
              onClick={async () => {
                if (!window.confirm(`'${edit.name}' 게시판을 지울까요? 글도 함께 보이지 않게 됩니다.`)) return
                await api.del(`/api/boards/${edit.id}`)
                void qc.invalidateQueries({ queryKey: ['boards'] })
                onClose()
              }}
            >
              <Trash2 /> 게시판 삭제
            </Button>
          )}
          <Button onClick={() => save.mutate()} disabled={!name.trim() || !scopeIsValid(scope)}>
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="게시판 이름">
          <Input aria-label="게시판 이름" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="종류">
          <div className="flex gap-2">
            {(Object.keys(KIND_LABEL) as BoardDto['kind'][]).map((k) => (
              <Button key={k} size="sm" variant={kind === k ? 'default' : 'outline'} onClick={() => setKind(k)}>
                {KIND_LABEL[k]}
              </Button>
            ))}
          </div>
        </Field>
        <Field label="설명 (선택)">
          <Input aria-label="게시판 설명" value={desc} onChange={(e) => setDesc(e.target.value)} />
        </Field>
        <Field label="공개 범위">
          <ScopePicker value={scope} onChange={setScope} />
        </Field>
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}

function PostCompose({ board, onClose, onCreated }: { board: BoardDto; onClose: () => void; onCreated: (id: string) => void }): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [atts, setAtts] = useState<Att[]>([])
  const [pinned, setPinned] = useState(false)
  const [withPoll, setWithPoll] = useState(false)
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<string[]>(['', ''])
  const [multiple, setMultiple] = useState(false)
  const [anonymous, setAnonymous] = useState(false)
  const [closes, setCloses] = useState('')
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: (pii: PiiAck) =>
      sendOrQueue<{ id: string }>({
        kind: 'post',
        label: `게시글(${board.name}): ${title.trim().slice(0, 60)}`,
        path: '/api/posts',
        body: {
          boardId: board.id,
          title,
          bodyHtml: body,
          pinned,
          attachmentIds: atts.map((a) => a.id),
          poll: withPoll ? { question: question || title, options: options.map((o) => o.trim()).filter(Boolean), multiple, anonymous, closesAt: closes ? fromInputValue(closes) : null } : null,
          ...pii
        }
      }),
    // kept for later (server off): there is no post to open yet
    onSuccess: (r) => (r.queued ? onClose() : onCreated(r.data.id)),
    onError: (e) => setErr(errorMessage(e))
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${board.name}에 글쓰기`}
      width="max-w-3xl"
      footer={
        <Button
          onClick={() => {
            const pii = confirmPii([title, body, question, ...options], '이 게시판을 보는 모든 사람이 보게 되며,')
            if (pii) save.mutate(pii)
          }}
          disabled={!title.trim() || save.isPending}
        >
          등록
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="제목">
          <Input aria-label="글 제목" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Editor value={body} onChange={setBody} minHeight={160} />
        <AttachmentInput value={atts} onChange={setAtts} />
        <div className="flex flex-wrap gap-4 text-sm">
          {board.canManage && (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> 맨 위에 고정
            </label>
          )}
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={withPoll} onChange={(e) => setWithPoll(e.target.checked)} /> 투표 넣기
          </label>
        </div>
        {withPoll && (
          <div className="space-y-3 rounded-md border border-border p-3">
            <Field label="질문">
              <Input aria-label="투표 질문" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={title || '예: 회식 날짜'} />
            </Field>
            <div className="space-y-1.5">
              <div className="text-sm font-medium">선택지</div>
              {options.map((o, i) => (
                <div key={i} className="flex gap-1.5">
                  <Input aria-label={`선택지 ${i + 1}`} value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} />
                  {options.length > 2 && (
                    <Button size="icon" variant="ghost" aria-label={`선택지 ${i + 1} 빼기`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                      <X />
                    </Button>
                  )}
                </div>
              ))}
              <Button size="sm" variant="outline" onClick={() => setOptions([...options, ''])} disabled={options.length >= 20}>
                <Plus /> 선택지 추가
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} /> 여러 개 선택
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} /> 익명 투표
              </label>
              <span className="flex items-center gap-1.5">
                마감 <DateTimeInput label="투표 마감" clearable defaultTime="18:00" value={closes} onChange={setCloses} />
              </span>
            </div>
          </div>
        )}
        <p className="text-xs text-[var(--notice-fg)]"><TriangleAlert className="mr-1 inline size-3.5 align-[-0.15em]" aria-hidden />중요 보안 내용, 개인정보, 비공개 정보는 올릴 수 없습니다.</p>
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}

function PollBox({ postId, poll, isAuthor }: { postId: string; poll: PollDto; isAuthor: boolean }): React.JSX.Element {
  const qc = useQueryClient()
  const [sel, setSel] = useState<string[]>(poll.myVotes)
  const [err, setErr] = useState('')
  useEffect(() => setSel(poll.myVotes), [poll.myVotes])
  const vote = useMutation({
    mutationFn: () => api.post(`/api/posts/${postId}/vote`, { optionIds: sel }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['boards'] }),
    onError: (e) => setErr(errorMessage(e))
  })
  const close = useMutation({ mutationFn: () => api.post(`/api/posts/${postId}/close-poll`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['boards'] }) })
  const max = Math.max(1, ...poll.options.map((o) => o.votes))
  return (
    <div className="space-y-3 rounded-lg border-2 border-primary/30 p-4" data-testid="poll">
      <div className="flex items-center gap-2">
        <Vote className="size-4 text-primary" />
        <b>{poll.question}</b>
        {poll.multiple && <Badge variant="muted">복수 선택</Badge>}
        {poll.anonymous && (
          <Badge variant="muted">
            <Lock className="size-3" /> 익명
          </Badge>
        )}
        {poll.closed ? <Badge variant="urgent">마감</Badge> : poll.closesAt && <span className="text-xs text-muted-foreground">{format(poll.closesAt, 'M/d HH:mm')} 마감</span>}
        <span className="ml-auto text-xs text-muted-foreground">{poll.totalVoters}명 참여</span>
      </div>
      {poll.options.map((o) => {
        const on = sel.includes(o.id)
        return (
          <label key={o.id} className={cn('relative block cursor-pointer overflow-hidden rounded-md border px-3 py-2 text-sm', on ? 'border-primary' : 'border-border', poll.closed && 'cursor-default')}>
            <span className="absolute inset-y-0 left-0 bg-primary/10" style={{ width: `${(o.votes / max) * 100}%` }} />
            <span className="relative flex items-center gap-2">
              <input
                type={poll.multiple ? 'checkbox' : 'radio'}
                name={`poll-${poll.id}`}
                disabled={poll.closed}
                checked={on}
                aria-label={o.label}
                onChange={() => setSel(poll.multiple ? (on ? sel.filter((x) => x !== o.id) : [...sel, o.id]) : [o.id])}
              />
              {o.label}
              <b className="ml-auto">{o.votes}</b>
            </span>
            {o.voters && o.voters.length > 0 && <span className="relative mt-0.5 block text-xs text-muted-foreground">{o.voters.join(', ')}</span>}
          </label>
        )
      })}
      {!poll.closed && (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => vote.mutate()} disabled={!sel.length && !poll.myVotes.length}>
            {poll.myVotes.length ? '다시 투표' : '투표'}
          </Button>
          {isAuthor && (
            <Button size="sm" variant="outline" onClick={() => window.confirm('투표를 마감할까요?') && close.mutate()}>
              마감하기
            </Button>
          )}
        </div>
      )}
      {err && <p className="text-xs text-urgent">{err}</p>}
    </div>
  )
}

function PostView({ id, onDeleted }: { id: string; onDeleted: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const { data: me } = useMe()
  const [showViews, setShowViews] = useState(false)
  const q = useQuery({ queryKey: ['boards', 'post', id], queryFn: () => api.get<PostDto>(`/api/posts/${id}`) })
  const views = useQuery({ queryKey: ['boards', 'views', id], queryFn: () => api.get<{ name: string; viewedAt: number }[]>(`/api/posts/${id}/views`), enabled: showViews })
  useEffect(() => {
    if (q.data) void qc.invalidateQueries({ queryKey: ['boards', 'list'] })
  }, [q.data, qc])
  const p = q.data
  if (!p) return <Loading />
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-6 py-5" data-testid="post-view">
      <div>
        <div className="flex items-center gap-2">
          {p.pinned && <Pin className="size-4 text-primary" />}
          <h2 className="text-xl font-bold">{p.title}</h2>
          <FavoriteStar itemType="post" itemId={p.id} title={p.title} route={`/boards/${p.boardId}/${p.id}`} />
        </div>
        <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <MemberLink memberId={p.authorId} name={p.authorName} /> · {format(p.createdAt, 'yyyy-MM-dd HH:mm')}
          <button className="flex cursor-pointer items-center gap-0.5 hover:underline" onClick={() => setShowViews(!showViews)}>
            <Eye className="size-3" /> 조회 {p.viewCount}
          </button>
        </p>
        {showViews && <p className="mt-1 text-xs text-muted-foreground">{views.data?.map((v) => `${v.name}(${format(v.viewedAt, 'M/d HH:mm')})`).join(', ') || '…'}</p>}
      </div>
      <RichView html={p.bodyHtml} />
      <AttachmentList items={p.attachments} />
      {p.poll && <PollBox postId={p.id} poll={p.poll} isAuthor={p.authorId === me?.id || me?.role === 'admin'} />}
      {p.canEdit && (
        <div className="flex gap-2 border-t border-border pt-3">
          <Button
            size="sm"
            variant="ghost"
            className="text-urgent"
            onClick={async () => {
              if (!window.confirm('이 글을 삭제할까요?')) return
              await api.del(`/api/posts/${p.id}`)
              void qc.invalidateQueries({ queryKey: ['boards'] })
              onDeleted()
            }}
          >
            <Trash2 /> 삭제
          </Button>
        </div>
      )}
      <Comments type="post" id={p.id} />
    </div>
  )
}

export function BoardsPage(): React.JSX.Element {
  const { boardId, postId } = useParams()
  const navigate = useNavigate()
  const online = useConn((s) => s.state === 'online')
  const space = useSpace((s) => s.space)
  const { data: me } = useMe()
  const [q, setQ] = useState('')
  const [dialog, setDialog] = useState<null | 'board' | 'post' | { edit: BoardDto }>(null)
  const boards = useQuery({ queryKey: ['boards', 'all'], queryFn: () => api.get<BoardDto[]>('/api/boards'), enabled: online, placeholderData: (p) => p })
  const visibleBoards = (boards.data ?? []).filter((b) => space === 'team' || b.scope.groups.some((g) => g.id === space))
  const current = visibleBoards.find((b) => b.id === boardId) ?? visibleBoards[0]
  const posts = useQuery({
    queryKey: ['boards', 'list', current?.id, q],
    queryFn: () => api.get<PostSummaryDto[]>(`/api/boards/${current!.id}/posts`, { q }),
    enabled: online && !!current,
    placeholderData: (p) => p
  })
  const canCreateBoard = me?.role === 'admin' || (space !== 'team' && me?.groups.some((g) => g.id === space && g.role === 'owner'))

  if (!online && !boards.data) return <OfflineState />
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="게시판"
        actions={
          <>
            {canCreateBoard && (
              <Button variant="outline" onClick={() => setDialog('board')}>
                <Plus /> 게시판 만들기
              </Button>
            )}
            <Button onClick={() => setDialog('post')} disabled={!current}>
              <Plus /> 글쓰기
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <aside className={cn('w-52 shrink-0 space-y-0.5 overflow-y-auto border-r border-border p-2', !visibleBoards.length && 'hidden')} aria-label="게시판 목록">
          {visibleBoards.map((b) => (
            <button
              key={b.id}
              onClick={() => navigate(`/boards/${b.id}`)}
              className={cn('flex w-full cursor-pointer items-center gap-1.5 rounded px-2.5 py-1.5 text-left text-sm hover:bg-muted', current?.id === b.id && 'bg-primary/10 font-semibold text-primary')}
            >
              <span className="truncate">{b.name}</span>
              {b.unreadCount > 0 && <span className="ml-auto rounded-full bg-primary px-1.5 text-[0.7rem] font-bold text-white">{b.unreadCount}</span>}
            </button>
          ))}
        </aside>
        {current ? (
          <div className="flex min-w-0 flex-1">
            <div className="flex w-[26rem] shrink-0 flex-col border-r border-border">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <span className="truncate text-sm font-semibold">{current.name}</span>
                <Badge variant="muted">{KIND_LABEL[current.kind]}</Badge>
                <ScopeTags scope={current.scope} />
                {current.canManage && (
                  <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="게시판 설정" onClick={() => setDialog({ edit: current })}>
                    <Settings2 />
                  </Button>
                )}
              </div>
              <div className="relative border-b border-border p-2">
                <Search className="absolute left-4 top-4.5 size-4 text-muted-foreground" />
                <Input aria-label="게시글 검색" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="제목·내용 검색" />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto" data-testid="post-list">
                {posts.isLoading ? (
                  <Loading />
                ) : !posts.data?.length ? (
                  <EmptyState icon={ClipboardList} title="글이 없습니다" />
                ) : (
                  posts.data.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => navigate(`/boards/${current.id}/${p.id}`)}
                      className={cn('block w-full cursor-pointer border-b border-border px-4 py-2.5 text-left hover:bg-muted', postId === p.id && 'bg-primary/5')}
                      data-testid={`post-item-${p.title}`}
                    >
                      <div className="flex items-center gap-1.5">
                        {!p.read && <span className="size-2 shrink-0 rounded-full bg-primary" />}
                        {p.pinned && <Pin className="size-3.5 shrink-0 text-primary" />}
                        <span className={cn('truncate text-sm', !p.read && 'font-bold')}>{p.title}</span>
                        {p.hasPoll && <Vote className="size-3.5 shrink-0 text-primary" />}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>
                          {p.authorName}
                          <RoleMark memberId={p.authorId} /> · {format(p.createdAt, 'M/d')}
                        </span>
                        <span className="ml-auto flex items-center gap-2">
                          {p.attachmentCount > 0 && <Paperclip className="size-3" />}
                          <span className="flex items-center gap-0.5">
                            <Eye className="size-3" /> {p.viewCount}
                          </span>
                          {p.commentCount > 0 && (
                            <span className="flex items-center gap-0.5">
                              <MessageSquare className="size-3" /> {p.commentCount}
                            </span>
                          )}
                        </span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto">{postId ? <PostView key={postId} id={postId} onDeleted={() => navigate(`/boards/${current.id}`)} /> : <EmptyState icon={ClipboardList} title="글을 선택하세요" />}</div>
          </div>
        ) : (
          <EmptyState icon={ClipboardList} title="게시판이 없습니다" description={me?.role === 'admin' ? '위의 [게시판 만들기]로 첫 게시판을 만드세요.' : '게시판은 최종관리자·서무나 그룹장이 만듭니다. 필요하면 요청하세요.'} />
        )}
      </div>
      {dialog === 'board' && <BoardDialog onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === 'object' && <BoardDialog edit={dialog.edit} onClose={() => setDialog(null)} />}
      {dialog === 'post' && current && (
        <PostCompose
          board={current}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setDialog(null)
            void posts.refetch()
            navigate(`/boards/${current.id}/${id}`)
          }}
        />
      )}
    </div>
  )
}
