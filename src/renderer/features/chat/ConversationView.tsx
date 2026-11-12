import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format, isSameDay } from 'date-fns'
import { ko } from 'date-fns/locale'
import { Paperclip, Send, Bell, BellOff, UserPlus, LogOut, Pencil, Loader2, Download, Trash2, Video } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/input'
import { Dialog } from '@renderer/components/Dialog'
import { MemberPicker } from '@renderer/components/ScopePicker'
import { AuthImage } from '@renderer/components/AuthImage'
import { downloadAuthed, formatSize, uploadAttachment } from '@renderer/components/Attachments'
import { api, errorMessage } from '@renderer/lib/api'
import { realtime } from '@renderer/lib/realtime'
import { useMe } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import type { ConversationDto, MessageDto, MessageNewPayload } from '@shared/schemas/chat'
import { useChatUi } from './chat-store'
import { cn } from '@renderer/lib/utils'
import { startMeeting } from '@renderer/features/meetings/MeetingsPage'

const PAGE = 50

export function ConversationView({ id, onLeft }: { id: string; onLeft: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const { data: me } = useMe()
  const online = useConn((s) => s.state === 'online')
  const setOpen = useChatUi((s) => s.setOpen)
  const [messages, setMessages] = useState<MessageDto[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteIds, setInviteIds] = useState<string[]>([])
  const [viewer, setViewer] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const msgRef = useRef<MessageDto[]>([])
  msgRef.current = messages
  const stickBottom = useRef(true)
  const keepOffset = useRef<number | null>(null)

  const conv = useQuery({ queryKey: ['chat', 'conv', id], queryFn: () => api.get<ConversationDto & { members: { id: string; name: string }[] }>(`/api/conversations/${id}`) })

  const markRead = useCallback(
    (list: MessageDto[]) => {
      const last = list[list.length - 1]
      if (!last || !document.hasFocus() || document.visibilityState !== 'visible') return
      void api.post(`/api/conversations/${id}/read`, { seq: last.seq }).then(() => void qc.invalidateQueries({ queryKey: ['chat', 'list'] }))
      void qc.invalidateQueries({ queryKey: ['chat', 'unread'] })
    },
    [id, qc]
  )

  const loadLatest = useCallback(async () => {
    const list = await api.get<MessageDto[]>(`/api/conversations/${id}/messages`, { limit: PAGE })
    setMessages(list)
    setHasMore(list.length === PAGE)
    stickBottom.current = true
    markRead(list)
  }, [id, markRead])

  /** Fetch messages newer than what we have (and refresh read counts of recent ones). */
  const refresh = useCallback(async () => {
    const cur = msgRef.current
    const from = cur.length ? Math.max(0, cur[Math.max(0, cur.length - PAGE)].seq - 1) : 0
    const fresh = await api.get<MessageDto[]>(`/api/conversations/${id}/messages`, { after: from, limit: 200 })
    const map = new Map(msgRef.current.map((m) => [m.seq, m]))
    for (const m of fresh) map.set(m.seq, m)
    const merged = [...map.values()].sort((a, b) => a.seq - b.seq)
    setMessages(merged)
    markRead(merged)
  }, [id, markRead])

  useEffect(() => {
    setOpen(id)
    void loadLatest()
    const off1 = realtime.on('message.new', (p) => {
      if ((p as MessageNewPayload).conversationId === id) void refresh()
    })
    const off2 = realtime.on('conversation.read', (p) => {
      if ((p as { id: string }).id === id) void refresh()
    })
    const off3 = realtime.on('conversation.changed', (p) => {
      if ((p as { id: string }).id === id) void loadLatest()
    })
    const offRe = realtime.onReconnect(() => void loadLatest())
    const onFocus = (): void => markRead(msgRef.current)
    window.addEventListener('focus', onFocus)
    return () => {
      setOpen(null)
      off1()
      off2()
      off3()
      offRe()
      window.removeEventListener('focus', onFocus)
    }
  }, [id, loadLatest, refresh, setOpen, markRead])

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (keepOffset.current !== null) {
      el.scrollTop = el.scrollHeight - keepOffset.current
      keepOffset.current = null
    } else if (stickBottom.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const loadOlder = async (): Promise<void> => {
    if (!hasMore || loadingOlder || !messages.length) return
    setLoadingOlder(true)
    const el = listRef.current!
    keepOffset.current = el.scrollHeight - el.scrollTop
    const older = await api.get<MessageDto[]>(`/api/conversations/${id}/messages`, { before: messages[0].seq, limit: PAGE })
    setHasMore(older.length === PAGE)
    setMessages((cur) => [...older, ...cur])
    setLoadingOlder(false)
  }

  const send = async (attachmentIds: string[] = []): Promise<void> => {
    const body = text
    if (!body.trim() && !attachmentIds.length) return
    setSending(true)
    setErr('')
    try {
      await api.post(`/api/conversations/${id}/messages`, { body, attachmentIds })
      if (!attachmentIds.length || body.trim()) setText('')
      stickBottom.current = true
      await refresh()
      void qc.invalidateQueries({ queryKey: ['chat', 'list'] })
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setSending(false)
    }
  }

  const sendFiles = async (files: File[]): Promise<void> => {
    if (!files.length) return
    setSending(true)
    setErr('')
    try {
      const ids: string[] = []
      for (const f of files) ids.push((await uploadAttachment(f)).id)
      await api.post(`/api/conversations/${id}/messages`, { body: '', attachmentIds: ids })
      stickBottom.current = true
      await refresh()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setSending(false)
    }
  }

  const fileInput = useRef<HTMLInputElement>(null)
  const c = conv.data
  return (
    <div
      className="flex h-full min-w-0 flex-col"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        void sendFiles([...e.dataTransfer.files])
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        {c?.groupColor && <span className="size-3 rounded-full" style={{ background: c.groupColor }} />}
        <h2 className="truncate font-bold" data-testid="conv-title">
          {c?.title ?? '…'}
        </h2>
        <span className="text-xs text-muted-foreground" title={c?.members.map((m) => m.name).join(', ')}>
          {c?.memberCount}명
        </span>
        <div className="ml-auto flex gap-1">
          {c && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="이 대화방에서 회의 시작"
              title="이 대화방에서 회의 시작"
              onClick={() =>
                void startMeeting({
                  title: `${c.title} 회의`,
                  mode: 'video',
                  scope: c.groupId ? { type: 'group', groupIds: [c.groupId], memberIds: [] } : { type: 'members', groupIds: [], memberIds: c.members.map((m) => m.id) },
                  conversationId: c.id
                }).catch((e: unknown) => window.alert(errorMessage(e)))
              }
            >
              <Video />
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" aria-label={c?.muted ? '알림 켜기' : '알림 끄기'} title={c?.muted ? '알림 켜기' : '알림 끄기'} onClick={async () => {
            await api.patch(`/api/conversations/${id}`, { muted: !c?.muted })
            void qc.invalidateQueries({ queryKey: ['chat'] })
          }}>
            {c?.muted ? <BellOff /> : <Bell />}
          </Button>
          {c?.kind === 'room' && (
            <>
              <Button size="icon-sm" variant="ghost" aria-label="대화방 이름 바꾸기" onClick={async () => {
                const t = window.prompt('대화방 이름', c.title)
                if (t !== null) {
                  await api.patch(`/api/conversations/${id}`, { title: t })
                  void qc.invalidateQueries({ queryKey: ['chat'] })
                }
              }}>
                <Pencil />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="초대하기" onClick={() => setInviting(true)}>
                <UserPlus />
              </Button>
            </>
          )}
          {c?.kind !== 'group' && (
            <Button size="icon-sm" variant="ghost" aria-label="대화방 나가기" onClick={async () => {
              if (!window.confirm('대화방에서 나갈까요?')) return
              await api.del(`/api/conversations/${id}/members/me`)
              void qc.invalidateQueries({ queryKey: ['chat'] })
              onLeft()
            }}>
              <LogOut />
            </Button>
          )}
        </div>
      </div>
      <div
        ref={listRef}
        className="selectable min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-3"
        data-testid="message-list"
        onScroll={(e) => {
          const el = e.currentTarget
          stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
          if (el.scrollTop < 40) void loadOlder()
        }}
      >
        {loadingOlder && <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />}
        {!hasMore && messages.length > 0 && <p className="py-2 text-center text-xs text-muted-foreground">대화의 시작입니다</p>}
        {messages.map((m, i) => {
          const prev = messages[i - 1]
          const newDay = !prev || !isSameDay(prev.createdAt, m.createdAt)
          const mine = m.senderId === me?.id
          const grouped = prev && prev.senderId === m.senderId && !newDay && m.createdAt - prev.createdAt < 120000 && prev.kind !== 'system'
          return (
            <div key={m.id}>
              {newDay && <div className="my-3 text-center text-xs text-muted-foreground">{format(m.createdAt, 'yyyy년 M월 d일 EEEE', { locale: ko })}</div>}
              {m.kind === 'system' ? (
                <p className="my-1 text-center text-xs text-muted-foreground">{m.body}</p>
              ) : (
                <div className={cn('group flex items-end gap-1.5', mine ? 'flex-row-reverse' : '', !grouped && 'mt-2')} data-testid="message">
                  <div className={cn('max-w-[70%]', mine ? 'items-end' : 'items-start', 'flex flex-col')}>
                    {!mine && !grouped && <span className="mb-0.5 text-xs font-semibold">{m.senderName}</span>}
                    {m.kind === 'image' && m.attachments[0] ? (
                      <AuthImage path={`/api/attachments/${m.attachments[0].id}`} alt={m.body} className="max-h-60 cursor-zoom-in rounded-lg border border-border" onClick={() => setViewer(m.attachments[0].id)} />
                    ) : m.kind === 'file' && m.attachments[0] ? (
                      <button
                        className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left text-sm hover:bg-muted"
                        onClick={() => downloadAuthed(`/api/attachments/${m.attachments[0].id}`, m.attachments[0].name).catch((e) => setErr(errorMessage(e)))}
                      >
                        <Download className="size-4 text-primary" /> {m.attachments[0].name}
                        <span className="text-xs text-muted-foreground">{formatSize(m.attachments[0].size)}</span>
                      </button>
                    ) : (
                      <div className={cn('rounded-2xl px-3 py-1.5 text-sm whitespace-pre-wrap break-words', mine ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm bg-muted')}>{m.body}</div>
                    )}
                  </div>
                  <div className={cn('flex shrink-0 flex-col text-[0.68rem] leading-tight', mine ? 'items-end' : 'items-start')}>
                    {m.unreadBy > 0 && (
                      <span className="font-bold text-important" title="아직 읽지 않은 사람 수" data-testid="unread-by">
                        {m.unreadBy}
                      </span>
                    )}
                    <span className="text-muted-foreground">{format(m.createdAt, 'a h:mm', { locale: ko })}</span>
                  </div>
                  {mine && (
                    <button
                      className="invisible cursor-pointer text-muted-foreground group-hover:visible"
                      aria-label="메시지 삭제"
                      onClick={async () => {
                        if (!window.confirm('이 메시지를 지울까요?')) return
                        await api.del(`/api/messages/${m.id}`)
                        void loadLatest()
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {err && <p className="px-4 text-xs text-urgent">{err}</p>}
      <div className="flex shrink-0 items-end gap-2 border-t border-border p-3">
        <Button size="icon" variant="ghost" aria-label="파일 보내기" onClick={() => fileInput.current?.click()} disabled={!online || sending}>
          <Paperclip />
        </Button>
        <input ref={fileInput} type="file" multiple className="hidden" aria-label="보낼 파일" onChange={(e) => void sendFiles([...(e.target.files ?? [])]).then(() => fileInput.current && (fileInput.current.value = ''))} />
        <Textarea
          aria-label="메시지 입력"
          className="max-h-40 min-h-10 flex-1 resize-none"
          rows={1}
          placeholder={online ? '메시지 입력 (Enter 보내기, Shift+Enter 줄바꿈) · 캡처 이미지를 붙여넣을 수 있습니다' : '서버에 연결되어 있지 않습니다'}
          value={text}
          disabled={!online}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (files.length) {
              e.preventDefault()
              void sendFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `캡처_${format(new Date(), 'yyyyMMdd_HHmmss')}${i ? `_${i}` : ''}.png`, { type: f.type }))))
            }
          }}
        />
        <Button size="icon" aria-label="보내기" onClick={() => void send()} disabled={!online || sending || !text.trim()}>
          {sending ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
      </div>
      <p className="shrink-0 px-4 pb-1.5 text-[0.7rem] text-[var(--notice-fg)]">⚠ 중요 보안 내용, 개인정보, 비공개 정보는 보낼 수 없습니다.</p>
      <Dialog
        open={inviting}
        onClose={() => setInviting(false)}
        title="대화방에 초대"
        footer={
          <Button
            disabled={!inviteIds.length}
            onClick={async () => {
              await api.post(`/api/conversations/${id}/members`, { memberIds: inviteIds })
              setInviting(false)
              setInviteIds([])
              void qc.invalidateQueries({ queryKey: ['chat'] })
            }}
          >
            초대
          </Button>
        }
      >
        <MemberPicker value={inviteIds} onChange={setInviteIds} excludeSelf />
      </Dialog>
      {viewer && (
        <Dialog open onClose={() => setViewer(null)} title="사진" width="max-w-5xl">
          <AuthImage path={`/api/attachments/${viewer}`} alt="사진" className="mx-auto max-h-[75vh]" />
        </Dialog>
      )}
    </div>
  )
}
