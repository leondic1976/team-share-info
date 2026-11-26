import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { format, isToday } from 'date-fns'
import { AlarmClock, MessageSquarePlus, MessagesSquare, Mail, Search, Send, StickyNote, Trash2, Inbox, BellOff } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Dialog } from '@renderer/components/Dialog'
import { MemberPicker } from '@renderer/components/ScopePicker'
import { EmptyState, Loading, OfflineState } from '@renderer/components/EmptyState'
import { Field } from '@renderer/features/setup/SetupFrame'
import { sendOrQueue } from '@renderer/lib/outbox'
import { api, errorMessage } from '@renderer/lib/api'
import { useMe, useMembers } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import { useSpace } from '@renderer/app/space-store'
import type { ConversationDto, NoteDto } from '@shared/schemas/chat'
import { ConversationView } from './ConversationView'
import { convTitle } from './title'
import { SharedMemosView } from './SharedMemos'
import { TeamAlarmsView } from './TeamAlarms'
import { cn } from '@renderer/lib/utils'
import { confirmPii } from '@renderer/lib/pii'
import { RoleMark } from '@renderer/components/RoleMark'
import { matchesHangul } from '@shared/hangul'

const when = (t: number | null): string => (!t ? '' : isToday(t) ? format(t, 'HH:mm') : format(t, 'M/d'))

function NewChatDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }): React.JSX.Element {
  const [ids, setIds] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [err, setErr] = useState('')
  const create = useMutation({
    mutationFn: () => api.post<ConversationDto>('/api/conversations', { memberIds: ids, title: ids.length > 1 ? title || undefined : undefined }),
    onSuccess: (c) => onCreated(c.id),
    onError: (e) => setErr(errorMessage(e))
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title="새 대화"
      footer={
        <Button onClick={() => create.mutate()} disabled={!ids.length}>
          대화 시작
        </Button>
      }
    >
      <div className="space-y-3">
        <MemberPicker value={ids} onChange={setIds} excludeSelf presence />
        {ids.length > 1 && (
          <Field label="대화방 이름 (선택)">
            <Input aria-label="대화방 이름" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
        )}
        <p className="text-xs text-muted-foreground">한 명을 고르면 1:1 대화, 여러 명을 고르면 대화방이 만들어집니다.</p>
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}

type Tab = 'chat' | 'notes' | 'memos' | 'alarms'

/** Everything sent to other people lives here; the hint tells the four ways apart. */
const TABS: { key: Tab; label: string; icon: typeof Mail; hint: string }[] = [
  { key: 'chat', label: '대화', icon: MessagesSquare, hint: '실시간으로 주고받는 1:1 대화와 대화방' },
  { key: 'notes', label: '쪽지', icon: Mail, hint: '한 사람씩 받는 전달 글. 누가 읽었는지 보입니다' },
  { key: 'memos', label: '공유 메모', icon: StickyNote, hint: '팀·그룹이 함께 보는 전달 메모판' },
  { key: 'alarms', label: '팀원 알람', icon: AlarmClock, hint: '정한 시각에 팀원 PC에서 울리는 알람' }
]

/** `composeKey` goes up each time the page's [쪽지 쓰기] button is pressed. */
function NotesView({ composeKey, to }: { composeKey: number; to: string | null }): React.JSX.Element {
  const qc = useQueryClient()
  const [box, setBox] = useState<'inbox' | 'sent'>('inbox')
  const [open, setOpen] = useState<NoteDto | null>(null)
  const [composing, setComposing] = useState<null | { to: string[] }>(null)
  const [body, setBody] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => {
    if (composeKey > 0) setComposing({ to: to ? [to] : [] })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opens once per button press
  }, [composeKey])
  const q = useQuery({ queryKey: ['chat', 'notes', box], queryFn: () => api.get<NoteDto[]>('/api/notes', { box }) })
  const send = useMutation({
    mutationFn: () => sendOrQueue({ kind: 'note', label: `쪽지: ${body.trim().slice(0, 60)}`, path: '/api/notes', body: { toIds: composing!.to, body } }),
    onSuccess: () => {
      setComposing(null)
      setBody('')
      void qc.invalidateQueries({ queryKey: ['chat', 'notes'] })
    },
    onError: (e) => setErr(errorMessage(e))
  })
  // Sent notes are grouped by batch so one note to many people is one row.
  const rows: NoteDto[][] =
    box === 'inbox'
      ? (q.data ?? []).map((n) => [n])
      : Object.values((q.data ?? []).reduce<Record<string, NoteDto[]>>((acc, n) => ((acc[n.batchId] ??= []).push(n), acc), {}))
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-2">
        <Button size="sm" variant={box === 'inbox' ? 'secondary' : 'ghost'} onClick={() => setBox('inbox')}>
          <Inbox /> 받은 쪽지
        </Button>
        <Button size="sm" variant={box === 'sent' ? 'secondary' : 'ghost'} onClick={() => setBox('sent')}>
          <Send /> 보낸 쪽지
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {q.isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <EmptyState icon={Mail} title="쪽지가 없습니다" description="위의 [쪽지 쓰기]를 눌러 받는 사람을 고르고 보내세요. 받는 사람이 꺼져 있어도 다음에 켤 때 받습니다." />
        ) : (
          rows.map((g) => {
            const n = g[0]
            const unread = box === 'inbox' && !n.readAt
            const readCount = g.filter((x) => x.readAt).length
            return (
              <button
                key={n.id}
                className="block w-full cursor-pointer border-b border-border px-4 py-2.5 text-left hover:bg-muted"
                data-testid="note-item"
                onClick={() => {
                  setOpen(n)
                  if (unread) void api.post(`/api/notes/${n.id}/read`).then(() => void qc.invalidateQueries({ queryKey: ['chat'] }))
                }}
              >
                <div className="flex items-center gap-2 text-sm">
                  {unread && <span className="size-2 rounded-full bg-primary" />}
                  <span className={cn(unread && 'font-bold')}>{box === 'inbox' ? n.fromName : g.map((x) => x.toName).join(', ')}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{format(n.createdAt, 'M/d HH:mm')}</span>
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">{n.body}</div>
                {box === 'sent' && (
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    읽음 {readCount}/{g.length}
                  </div>
                )}
              </button>
            )
          })
        )}
      </div>
      {open && (
        <Dialog
          open
          onClose={() => setOpen(null)}
          title={box === 'inbox' ? `${open.fromName}님의 쪽지` : '보낸 쪽지'}
          footer={
            <>
              <Button
                variant="ghost"
                className="mr-auto text-urgent"
                onClick={async () => {
                  await api.del(`/api/notes/${open.id}`)
                  setOpen(null)
                  void qc.invalidateQueries({ queryKey: ['chat', 'notes'] })
                }}
              >
                <Trash2 /> 삭제
              </Button>
              {box === 'inbox' && (
                <Button
                  onClick={() => {
                    setComposing({ to: [open.fromId] })
                    setOpen(null)
                  }}
                >
                  답장
                </Button>
              )}
            </>
          }
        >
          <p className="text-xs text-muted-foreground">
            {format(open.createdAt, 'yyyy-MM-dd HH:mm')}
            {box === 'sent' && ` · ${open.toName} ${open.readAt ? `${format(open.readAt, 'M/d HH:mm')} 읽음` : '안 읽음'}`}
          </p>
          <p className="selectable mt-3 text-sm whitespace-pre-wrap">{open.body}</p>
        </Dialog>
      )}
      {composing && (
        <Dialog
          open
          onClose={() => setComposing(null)}
          title="쪽지 쓰기"
          footer={
            <Button onClick={() => confirmPii([body]) && send.mutate()} disabled={!composing.to.length || !body.trim()}>
              <Send /> 보내기
            </Button>
          }
        >
          <div className="space-y-3">
            <Field label="받는 사람">
              <MemberPicker value={composing.to} onChange={(to) => setComposing({ to })} excludeSelf presence />
            </Field>
            <Field label="내용">
              <Textarea aria-label="쪽지 내용" value={body} onChange={(e) => setBody(e.target.value)} className="min-h-28" />
            </Field>
            {err && <p className="text-sm text-urgent">{err}</p>}
          </div>
        </Dialog>
      )}
    </div>
  )
}

export function ChatPage(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const online = useConn((s) => s.state === 'online')
  const space = useSpace((s) => s.space)
  const location = useLocation()
  const [tab, setTab] = useState<Tab>(id === 'notes' ? 'notes' : 'chat')
  // "쪽지" on a member card (주소록) opens the compose dialog with that member chosen.
  const [noteTo, setNoteTo] = useState<string | null>(null)
  useEffect(() => {
    const st = location.state as { noteTo?: string } | null
    if (!st?.noteTo) return
    setTab('notes')
    setNoteTo(st.noteTo)
    setComposeKey((k) => k + 1)
    navigate('/chat/notes', { replace: true, state: null })
  }, [location.state, navigate])
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [composeKey, setComposeKey] = useState(0)
  const list = useQuery({ queryKey: ['chat', 'list'], queryFn: () => api.get<ConversationDto[]>('/api/conversations'), enabled: online, placeholderData: (p) => p })
  const search = useQuery({
    queryKey: ['chat', 'search', q],
    queryFn: () => api.get<{ id: string; conversationId: string; body: string; senderId?: string | null; senderName: string | null; createdAt: number }[]>('/api/messages/search', { q }),
    enabled: online && q.trim().length > 1
  })
  useEffect(() => {
    if (id === 'notes') setTab('notes')
  }, [id])
  // A press of [쪽지 쓰기] is spent once the 쪽지 tab is left: coming back by the tab must not reopen the dialog.
  useEffect(() => {
    if (tab !== 'notes') setComposeKey(0)
  }, [tab])

  const convs = (list.data ?? []).filter((c) => space === 'team' || c.groupId === space)
  const { data: me } = useMe()
  // 나가기 is inside the conversation (its header), not on the rows of the list (지시 82)
  const { data: team } = useMembers()
  const titleOf = (c: ConversationDto): string => convTitle(c, team, me?.id)
  // matches the title as shown (a 1:1 shows "본명(필명)") and the plain one
  const filtered = q.trim() ? convs.filter((c) => matchesHangul(c.title, q) || matchesHangul(titleOf(c), q)) : convs
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="메신저"
        description="팀원에게 보내는 것은 모두 여기에 있습니다. [새 대화]나 [쪽지 쓰기]를 누르고 받는 사람을 고르세요."
        actions={
          <>
            <Button
              size="sm"
              disabled={!online}
              onClick={() => {
                setTab('chat')
                setCreating(true)
              }}
            >
              <MessageSquarePlus /> 새 대화
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setTab('notes')
                setNoteTo(null)
                setComposeKey((k) => k + 1)
              }}
            >
              <Send /> 쪽지 쓰기
            </Button>
          </>
        }
      />
      <div className="flex shrink-0 gap-1 border-b border-border px-5 py-2">
        {TABS.map((t) => (
          <Button key={t.key} size="sm" variant={tab === t.key ? 'default' : 'ghost'} title={t.hint} onClick={() => setTab(t.key)}>
            <t.icon /> {t.label}
          </Button>
        ))}
        <span className="ml-auto self-center truncate text-xs text-muted-foreground">{TABS.find((t) => t.key === tab)?.hint}</span>
      </div>
      {tab === 'memos' ? (
        <SharedMemosView />
      ) : tab === 'alarms' ? (
        <TeamAlarmsView />
      ) : !online && !list.data ? (
        <OfflineState />
      ) : tab === 'notes' ? (
        <NotesView composeKey={composeKey} to={noteTo} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-80 shrink-0 flex-col border-r border-border">
            <div className="relative border-b border-border p-2">
              <Search className="absolute left-4 top-4.5 size-4 text-muted-foreground" />
              <Input aria-label="대화 검색" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="대화방·메시지 검색" />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto" data-testid="conv-list">
              {filtered.map((c) => (
                <div key={c.id} className="group relative border-b border-border">
                <button
                  onClick={() => navigate(`/chat/${c.id}`)}
                  className={cn('block w-full cursor-pointer px-3 py-2.5 text-left hover:bg-muted', id === c.id && 'bg-primary/5')}
                  data-testid={`conv-${c.title}`}
                >
                  <div className="flex items-center gap-1.5">
                    {c.groupColor && <span className="size-2.5 shrink-0 rounded-full" style={{ background: c.groupColor }} />}
                    <span className={cn('truncate text-sm', c.unread ? 'font-bold' : 'font-medium')}>{titleOf(c)}</span>
                    {c.kind === 'dm' && <RoleMark memberId={c.memberIds.find((x) => x !== me?.id)} className="ml-0" />}
                    {c.kind !== 'dm' && <span className="text-xs text-muted-foreground">{c.memberCount}</span>}
                    {c.muted && <BellOff className="size-3 text-muted-foreground" />}
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{when(c.lastMessageAt)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1">
                    <span className="truncate text-xs text-muted-foreground">{c.lastPreview ?? '대화가 없습니다'}</span>
                    {c.unread > 0 && <span className="ml-auto shrink-0 rounded-full bg-urgent px-1.5 text-[0.7rem] font-bold text-white">{c.unread}</span>}
                  </div>
                </button>
                </div>
              ))}
              {q.trim().length > 1 && (search.data?.length ?? 0) > 0 && (
                <div className="border-t border-border">
                  <p className="px-3 pt-2 text-xs font-semibold text-muted-foreground">메시지</p>
                  {search.data!.map((m) => (
                    <button key={m.id} className="block w-full cursor-pointer px-3 py-1.5 text-left hover:bg-muted" onClick={() => navigate(`/chat/${m.conversationId}`)}>
                      <div className="truncate text-xs">
                        <b>{m.senderName}</b>
                        <RoleMark memberId={m.senderId} /> {m.body}
                      </div>
                      <div className="text-[0.7rem] text-muted-foreground">{format(m.createdAt, 'M/d HH:mm')}</div>
                    </button>
                  ))}
                </div>
              )}
              {!filtered.length && !q && <EmptyState icon={MessagesSquare} title="대화가 없습니다" description="위의 [새 대화]를 눌러 대화할 사람을 고르세요." />}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            {id && id !== 'notes' ? <ConversationView key={id} id={id} onLeft={() => navigate('/chat')} onSwitch={(next) => navigate(`/chat/${next}`)} /> : <EmptyState icon={MessagesSquare} title="대화를 선택하세요" description="새로 시작하려면 위의 [새 대화]를 누르세요." />}
          </div>
        </div>
      )}
      {creating && (
        <NewChatDialog
          onClose={() => setCreating(false)}
          onCreated={(cid) => {
            setCreating(false)
            void list.refetch()
            navigate(`/chat/${cid}`)
          }}
        />
      )}
    </div>
  )
}
