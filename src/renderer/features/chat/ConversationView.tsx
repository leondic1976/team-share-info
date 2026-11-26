import { useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format, isSameDay } from 'date-fns'
import { ko } from 'date-fns/locale'
import { Paperclip, Send, Bell, BellOff, Users, LogOut, Pencil, Loader2, Trash2, Video, MoreHorizontal, TriangleAlert, Smile, Ban, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/input'
import { Dialog } from '@renderer/components/Dialog'
import { PresenceDot } from '@renderer/components/PresenceDot'
import { AuthImage } from '@renderer/components/AuthImage'
import { LinkedText } from '@renderer/components/LinkedText'
import { ExpiredFileChip, FileChip, uploadAttachment } from '@renderer/components/Attachments'
import { api, ApiError, errorMessage } from '@renderer/lib/api'
import { realtime } from '@renderer/lib/realtime'
import { invoke } from '@renderer/lib/bridge'
import { useMe, useMembers } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import { CHAT_FONT_MAX, CHAT_FONT_MIN, usePrefs } from '@renderer/app/prefs-store'
import { MESSAGE_EDIT_WINDOW_MS, type ConversationChangedPayload, type MessageChangedPayload, type MessageDto, type MessageNewPayload } from '@shared/schemas/chat'
import { useChatUi } from './chat-store'
import { GROUP_LEAVE_HINT, leaveConversation } from './leave'
import { convTitle } from './title'
import { displayName } from '@shared/schemas/auth'
import { ParticipantsDialog, type ConversationDetail } from './Participants'
import { cn } from '@renderer/lib/utils'
import { startMeeting } from '@renderer/features/meetings/MeetingsPage'
import { confirmPii } from '@renderer/lib/pii'
import { sendOrQueue, useOutbox } from '@renderer/lib/outbox'
import { EmoticonPicker } from './EmoticonPicker'
import { emojiOnly } from './emoticons'
import { RoleMark } from '@renderer/components/RoleMark'

const PAGE = 50
/** messages of a conversation kept for reading while the server is off */
const KEEP = 200
/** pasted images waiting to be sent (shown above the input until Enter or 보내기) */
const STAGE_MAX = 10

/** The message text is text-sm of the app's 글자 크기 until the person picks a size of their own. */
const chatBasePx = (appPx: number): number => Math.round(appPx * 0.875)

/** 가- / size / 가+ for the message text of every conversation (a personal preference, 지시 108). */
function ChatFontControl(): React.JSX.Element {
  const chat = usePrefs((s) => s.chatFontSize)
  const base = chatBasePx(usePrefs((s) => s.fontSize))
  const update = usePrefs((s) => s.update)
  const px = chat || base
  return (
    // a click here keeps the "…" menu of a small window open
    <div role="group" aria-label="메시지 글자 크기" className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()} data-testid="chat-font">
      <Button size="icon-sm" variant="outline" aria-label="메시지 글자 작게" title={`메시지 글자 작게 (지금 ${px}px)`} disabled={px <= CHAT_FONT_MIN} onClick={() => update({ chatFontSize: px - 1 })}>
        가-
      </Button>
      <button
        type="button"
        className="h-8 min-w-11 cursor-pointer rounded-md px-1 text-center text-xs tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
        aria-label="메시지 글자 기본 크기로"
        title={chat ? `메시지 글자 ${px}px · 누르면 기본 크기(${base}px)로` : `메시지 글자 ${px}px (기본)`}
        disabled={!chat}
        onClick={() => update({ chatFontSize: 0 })}
        data-testid="chat-font-size"
      >
        {px}px
      </button>
      <Button size="icon-sm" variant="outline" aria-label="메시지 글자 크게" title={`메시지 글자 크게 (지금 ${px}px)`} disabled={px >= CHAT_FONT_MAX} onClick={() => update({ chatFontSize: px + 1 })}>
        가+
      </Button>
    </div>
  )
}

/** A pasted screen capture gets a name that says when it was taken. */
const pastedName = (f: File, i: number): File => (f.name && f.name !== 'image.png' ? f : new File([f], `캡처_${format(new Date(), 'yyyyMMdd_HHmmss')}${i ? `_${i}` : ''}.png`, { type: f.type }))

export interface ConversationViewProps {
  id: string
  /** I left, was taken out, or the conversation is no longer mine to see */
  onLeft: () => void
  /** go on with another conversation (people were added to a 1:1, which makes a new room) */
  onSwitch?: (id: string) => void
  /** small messenger window (ChatDock): tighter spacing, header actions under "…" */
  compact?: boolean
  /** false while a small window is minimised: it stays mounted (the draft is kept) but is not being looked at */
  active?: boolean
  /** compact: the window's own buttons, at the end of the header */
  controls?: ReactNode
  /** compact: put on the header row (the handle the window is dragged by) */
  headerProps?: HTMLAttributes<HTMLDivElement>
}

export function ConversationView({ id, onLeft, onSwitch, compact = false, active = true, controls, headerProps }: ConversationViewProps): React.JSX.Element {
  const qc = useQueryClient()
  const { data: me } = useMe()
  const { data: team } = useMembers()
  const online = useConn((s) => s.state === 'online')
  const chatFontSize = usePrefs((s) => s.chatFontSize)
  const view = useChatUi((s) => s.view)
  const unview = useChatUi((s) => s.unview)
  const [messages, setMessages] = useState<MessageDto[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const [people, setPeople] = useState(false)
  const [menu, setMenu] = useState(false)
  const [viewer, setViewer] = useState<string | null>(null)
  /** my message whose text is being changed */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  /** pasted files waiting for Enter / 보내기 (url: a preview of an image) */
  const [staged, setStaged] = useState<{ file: File; url: string | null }[]>([])
  const [picker, setPicker] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const msgRef = useRef<MessageDto[]>([])
  msgRef.current = messages
  const stickBottom = useRef(true)
  const keepOffset = useRef<number | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const onLeftRef = useRef(onLeft)
  onLeftRef.current = onLeft

  const conv = useQuery({ queryKey: ['chat', 'conv', id], queryFn: () => api.get<ConversationDetail>(`/api/conversations/${id}`) })

  /** Taken out of the room (or it is gone): nothing of it stays readable on this PC. */
  const gone = useCallback(() => {
    qc.setQueryData(['chat', 'msgs', id], [])
    qc.removeQueries({ queryKey: ['chat', 'conv', id] })
    onLeftRef.current()
  }, [id, qc])

  const markRead = useCallback(
    (list: MessageDto[]) => {
      const last = list[list.length - 1]
      if (!last || !activeRef.current || !document.hasFocus() || document.visibilityState !== 'visible') return
      // hidden to the tray the page still claims focus and visibility: only what is really on screen is read
      void invoke('window:inFront')
        .catch(() => true)
        .then((front) => {
          if (!front) return
          void api.post(`/api/conversations/${id}/read`, { seq: last.seq }).then(() => void qc.invalidateQueries({ queryKey: ['chat', 'list'] }))
          void qc.invalidateQueries({ queryKey: ['chat', 'unread'] })
        })
    },
    [id, qc]
  )

  // The last messages seen are kept (sealed, with the other cached data) so the conversation can be read while the server PC is off.
  const keep = useCallback((list: MessageDto[]) => qc.setQueryData(['chat', 'msgs', id], list.slice(-KEEP)), [id, qc])
  const waiting = useOutbox((s) => s.items).filter((i) => i.kind === 'chat.message' && i.path === `/api/conversations/${id}/messages`)

  const loadLatest = useCallback(async () => {
    const list = await api.get<MessageDto[]>(`/api/conversations/${id}/messages`, { limit: PAGE })
    setMessages(list)
    keep(list)
    setHasMore(list.length === PAGE)
    stickBottom.current = true
    markRead(list)
  }, [id, markRead, keep])

  /** Fetch messages newer than what we have (and refresh read counts of recent ones). */
  const refresh = useCallback(async () => {
    const cur = msgRef.current
    const from = cur.length ? Math.max(0, cur[Math.max(0, cur.length - PAGE)].seq - 1) : 0
    const fresh = await api.get<MessageDto[]>(`/api/conversations/${id}/messages`, { after: from, limit: 200 })
    const map = new Map(msgRef.current.map((m) => [m.seq, m]))
    for (const m of fresh) map.set(m.seq, m)
    const merged = [...map.values()].sort((a, b) => a.seq - b.seq)
    setMessages(merged)
    keep(merged)
    markRead(merged)
  }, [id, markRead, keep])

  useEffect(() => {
    setMessages(qc.getQueryData<MessageDto[]>(['chat', 'msgs', id]) ?? [])
    // while the server is off these fail and the kept messages stay on screen;
    // "not found" is the server's answer once I am no longer in the conversation
    const latest = (): void =>
      void loadLatest().catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) gone()
      })
    const newer = (): void => void refresh().catch(() => undefined)
    latest()
    const off1 = realtime.on('message.new', (p) => {
      if ((p as MessageNewPayload).conversationId === id) newer()
    })
    const off2 = realtime.on('conversation.read', (p) => {
      if ((p as { id: string }).id === id) newer()
    })
    const offChanged = realtime.on('message.changed', (raw) => {
      const p = raw as MessageChangedPayload
      if (p.conversationId !== id || !msgRef.current.some((m) => m.id === p.id)) return
      void api
        .get<MessageDto[]>(`/api/conversations/${id}/messages`, { after: p.seq - 1, limit: 1 })
        .then((list) => {
          const fresh = list.find((m) => m.id === p.id)
          if (!fresh) return
          setMessages((cur) => {
            const next = cur.map((m) => (m.id === fresh.id ? fresh : m))
            keep(next)
            return next
          })
        })
        .catch(() => undefined)
    })
    const off3 = realtime.on('conversation.changed', (raw) => {
      const p = raw as ConversationChangedPayload
      if (p.id !== id) return
      const meId = useConn.getState().memberId
      if (meId && p.removed?.includes(meId)) gone()
      else latest()
    })
    const offRe = realtime.onReconnect(latest)
    const onFocus = (): void => markRead(msgRef.current)
    window.addEventListener('focus', onFocus)
    return () => {
      off1()
      off2()
      off3()
      offChanged()
      offRe()
      window.removeEventListener('focus', onFocus)
    }
  }, [id, loadLatest, refresh, markRead, qc, gone, keep])

  // "Being looked at" (no alert, messages count as read) only while shown: a minimised small window is not.
  useEffect(() => {
    if (!active) return
    view(id)
    // the card of this conversation near the tray is not needed any more
    void invoke('preview:read', { key: id }).catch(() => undefined)
    const el = listRef.current
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight
    markRead(msgRef.current)
    return () => unview(id)
  }, [id, active, view, unview, markRead])

  // compact: the "…" menu closes on a click anywhere else and on Esc
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(false)
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (keepOffset.current !== null) {
      el.scrollTop = el.scrollHeight - keepOffset.current
      keepOffset.current = null
    } else if (stickBottom.current) el.scrollTop = el.scrollHeight
  }, [messages])

  // previews of pasted images are released when they leave (sent, removed, or the view closes)
  const stagedRef = useRef(staged)
  stagedRef.current = staged
  useEffect(() => () => stagedRef.current.forEach((x) => x.url && URL.revokeObjectURL(x.url)), [])
  const unstage = (i: number): void =>
    setStaged((cur) => {
      const x = cur[i]
      if (x?.url) URL.revokeObjectURL(x.url)
      return cur.filter((_, j) => j !== i)
    })
  const stage = (files: File[]): void => {
    if (!files.length) return
    setErr('')
    setStaged((cur) => {
      const room = STAGE_MAX - cur.length
      if (files.length > room) setErr(`한 번에 ${STAGE_MAX}개까지 보낼 수 있습니다.`)
      return [...cur, ...files.slice(0, Math.max(0, room)).map((f, i) => ({ file: pastedName(f, cur.length + i), url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null }))]
    })
    inputRef.current?.focus()
  }

  /** The emoticon goes where the cursor is in the message being written. */
  const insertEmoticon = (e: string): void => {
    const el = inputRef.current
    const at = el ? el.selectionStart : text.length
    const end = el ? el.selectionEnd : text.length
    const next = text.slice(0, at) + e + text.slice(end)
    setText(next)
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(at + e.length, at + e.length)
    })
  }

  const saveEdit = async (): Promise<void> => {
    if (!editing) return
    const body = editing.text
    if (!body.trim()) return setErr('내용을 입력하세요. 지우려면 삭제를 누르세요.')
    if (!confirmPii([body], '이 대화방의 모든 사람이 보게 되며,')) return
    try {
      await api.patch(`/api/messages/${editing.id}`, { body })
      setMessages((cur) => cur.map((m) => (m.id === editing.id ? { ...m, body, editedAt: Date.now() } : m)))
      setEditing(null)
      setErr('')
    } catch (e) {
      setErr(errorMessage(e))
    }
  }
  const removeMessage = async (m: MessageDto): Promise<void> => {
    if (!window.confirm('이 메시지를 지울까요? 대화방의 모든 사람에게서 지워지고 "삭제된 메시지입니다."로 보입니다.')) return
    try {
      await api.del(`/api/messages/${m.id}`)
      setMessages((cur) => cur.map((x) => (x.id === m.id ? { ...x, deleted: true, body: '', attachments: [], kind: 'text', editedAt: null, unreadBy: 0 } : x)))
      if (editing?.id === m.id) setEditing(null)
      void qc.invalidateQueries({ queryKey: ['chat', 'list'] })
    } catch (e) {
      setErr(errorMessage(e))
    }
  }

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
    const files = staged
    if (!body.trim() && !attachmentIds.length && !files.length) return
    if (!confirmPii([body], '이 대화방의 모든 사람이 보게 되며,')) return
    if (files.length && !online) return setErr('사진·파일은 서버에 연결되어 있을 때 보낼 수 있습니다.')
    setSending(true)
    setErr('')
    try {
      if (files.length) {
        // the pasted images go first (each its own message), then the text, in one send
        const ids = [...attachmentIds]
        for (const x of files) ids.push((await uploadAttachment(x.file)).id)
        await api.post(`/api/conversations/${id}/messages`, { body, attachmentIds: ids })
        files.forEach((x) => x.url && URL.revokeObjectURL(x.url))
        setStaged([])
        setText('')
        stickBottom.current = true
        await refresh()
        void qc.invalidateQueries({ queryKey: ['chat', 'list'] })
        return
      }
      // text can wait for the server on this PC; files cannot (they are stored on the server)
      const r = attachmentIds.length
        ? await api.post(`/api/conversations/${id}/messages`, { body, attachmentIds }).then(() => ({ queued: false }))
        : await sendOrQueue({ kind: 'chat.message', label: `메시지 → ${conv.data?.title || '대화'}: ${body.trim().slice(0, 60)}`, path: `/api/conversations/${id}/messages`, body: { body, attachmentIds: [] } })
      if (!attachmentIds.length || body.trim()) setText('')
      stickBottom.current = true
      if (r.queued) return
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
  // 1:1: the other person, for the presence dot of a small window
  const other = compact && c?.kind === 'dm' ? team?.find((m) => m.id !== me?.id && c.memberIds.includes(m.id)) : undefined
  // 1:1: the other person, for the 서무 mark next to the title (main page and small window)
  const dmOther = c?.kind === 'dm' ? team?.find((m) => m.id !== me?.id && c.memberIds.includes(m.id)) : undefined
  const meet = (): void => {
    if (!c) return
    void startMeeting({
      title: `${c.title} 회의`,
      mode: 'video',
      scope: c.groupId ? { type: 'group', groupIds: [c.groupId], memberIds: [] } : { type: 'members', groupIds: [], memberIds: c.members.map((m) => m.id) },
      conversationId: c.id
    }).catch((e: unknown) => window.alert(errorMessage(e)))
  }
  const toggleMute = async (): Promise<void> => {
    await api.patch(`/api/conversations/${id}`, { muted: !c?.muted })
    void qc.invalidateQueries({ queryKey: ['chat'] })
  }
  const rename = async (): Promise<void> => {
    const t = window.prompt('대화방 이름', c?.title ?? '')
    if (t === null) return
    await api.patch(`/api/conversations/${id}`, { title: t })
    void qc.invalidateQueries({ queryKey: ['chat'] })
  }
  const leave = async (): Promise<void> => {
    if (!c || !(await leaveConversation(c, me?.name ?? ''))) return
    onLeft()
  }
  const report = (e: unknown): void => setErr(errorMessage(e))
  /** "본명(필명)" of a participant, from the members list */
  const nameOf = (m: { id: string; name: string }): string => {
    const full = team?.find((x) => x.id === m.id)
    return full ? displayName(full) : m.name
  }
  const menuItem = 'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted [&_svg]:size-4 [&_svg]:shrink-0'
  // Dialogs opened from a small window go to the document body: inside the window they would be stacked with it, below other layers.
  const layer = (node: ReactNode): ReactNode => (compact ? createPortal(node, document.body) : node)
  return (
    <div
      className="flex h-full min-w-0 flex-col"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        void sendFiles([...e.dataTransfer.files])
      }}
    >
      <div {...(compact ? headerProps : undefined)} className={cn('flex shrink-0 items-center border-b border-border', compact ? 'relative gap-1.5 bg-muted/60 py-1 pl-2.5 pr-1' : 'gap-2 px-4 py-2.5', compact && headerProps?.className)}>
        {c?.groupColor && <span className="size-3 shrink-0 rounded-full" style={{ background: c.groupColor }} />}
        {other && <PresenceDot presence={other.presence} />}
        <h2 className={cn('truncate font-bold', compact && 'text-sm')} data-testid="conv-title">
          {c ? convTitle(c, team, me?.id) : '…'}
        </h2>
        {dmOther && <RoleMark role={dmOther.role} isOwner={dmOther.isOwner} className="ml-0" />}
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded px-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-default"
          title={c ? `${c.members.map((m) => nameOf(m)).join(', ')} · 눌러서 참가자 보기` : undefined}
          disabled={!c}
          onClick={() => setPeople(true)}
          data-testid="conv-count"
        >
          {c?.memberCount}명
        </button>
        {compact ? (
          <div className="ml-auto flex shrink-0 items-center">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="대화방 메뉴"
              title="대화방 메뉴"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={(e) => {
                // keep this click from reaching the "click anywhere else" listener that closes the menu
                e.stopPropagation()
                setMenu((v) => !v)
              }}
            >
              <MoreHorizontal />
            </Button>
            {controls}
            {menu && (
              <div role="menu" className="absolute right-1 top-full z-10 mt-0.5 w-56 rounded-md border border-border bg-card py-1 shadow-lg" data-testid="conv-menu">
                <div className="flex items-center cursor-default justify-between gap-2 border-b border-border px-3 pb-1.5 pt-0.5 text-sm">
                  글자 크기
                  <ChatFontControl />
                </div>
                <button type="button" role="menuitem" className={menuItem} disabled={!c} onClick={() => setPeople(true)}>
                  <Users /> 참가자
                </button>
                <button type="button" role="menuitem" className={menuItem} onClick={() => void toggleMute().catch(report)}>
                  {c?.muted ? <Bell /> : <BellOff />} {c?.muted ? '알림 켜기' : '알림 끄기'}
                </button>
                {c?.kind === 'room' && (
                  <button type="button" role="menuitem" className={menuItem} onClick={() => void rename().catch(report)}>
                    <Pencil /> 대화방 이름 바꾸기
                  </button>
                )}
                {c && (
                  <button type="button" role="menuitem" className={menuItem} onClick={meet}>
                    <Video /> 이 대화방에서 회의 시작
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className={cn(menuItem, 'border-t border-border text-urgent disabled:cursor-not-allowed disabled:opacity-50')}
                  disabled={!c || c.kind === 'group' || !online}
                  title={c?.kind === 'group' ? GROUP_LEAVE_HINT : !online ? '서버에 연결되어 있을 때 나갈 수 있습니다.' : undefined}
                  onClick={() => void leave().catch(report)}
                  data-testid="dock-leave"
                >
                  <LogOut /> 나가기
                  {c?.kind === 'group' && <span className="ml-auto text-[0.65rem] font-normal text-muted-foreground">그룹에서 나가기</span>}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="ml-auto flex items-center gap-1">
            <ChatFontControl />
            <span className="mx-1 h-5 w-px bg-border" aria-hidden />
            {c && (
              <Button size="icon-sm" variant="ghost" aria-label="이 대화방에서 회의 시작" title="이 대화방에서 회의 시작" onClick={meet}>
                <Video />
              </Button>
            )}
            <Button size="icon-sm" variant="ghost" aria-label={c?.muted ? '알림 켜기' : '알림 끄기'} title={c?.muted ? '알림 켜기' : '알림 끄기'} onClick={() => void toggleMute()}>
              {c?.muted ? <BellOff /> : <Bell />}
            </Button>
            {c?.kind === 'room' && (
              <Button size="icon-sm" variant="ghost" aria-label="대화방 이름 바꾸기" title="대화방 이름 바꾸기" onClick={() => void rename()}>
                <Pencil />
              </Button>
            )}
            <Button size="icon-sm" variant="ghost" aria-label="참가자" title="참가자 (추가·내보내기)" disabled={!c} onClick={() => setPeople(true)}>
              <Users />
            </Button>
            <span title={c?.kind === 'group' ? GROUP_LEAVE_HINT : '대화방 나가기'}>
              <Button size="icon-sm" variant="ghost" aria-label="대화방 나가기" disabled={!c || c.kind === 'group' || !online} onClick={() => void leave().catch(report)}>
                <LogOut />
              </Button>
            </span>
          </div>
        )}
      </div>
      <div
        ref={listRef}
        className={cn('selectable min-h-0 flex-1 space-y-1 overflow-y-auto text-sm leading-[1.43]', compact ? 'px-3 py-2' : 'px-4 py-3')}
        style={chatFontSize ? { fontSize: chatFontSize } : undefined}
        data-testid="message-list"
        onScroll={(e) => {
          const el = e.currentTarget
          stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
          if (el.scrollTop < 40) void loadOlder()
        }}
      >
        {loadingOlder && <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />}
        {!hasMore && messages.length > 0 && <p className="py-2 text-center text-[0.86em] text-muted-foreground">대화의 시작입니다</p>}
        {messages.map((m, i) => {
          const prev = messages[i - 1]
          const newDay = !prev || !isSameDay(prev.createdAt, m.createdAt)
          const mine = m.senderId === me?.id
          const grouped = prev && prev.senderId === m.senderId && !newDay && m.createdAt - prev.createdAt < 120000 && prev.kind !== 'system'
          return (
            <div key={m.id}>
              {newDay && <div className="my-3 text-center text-[0.86em] text-muted-foreground">{format(m.createdAt, 'yyyy년 M월 d일 EEEE', { locale: ko })}</div>}
              {m.kind === 'system' ? (
                <p className="my-1 text-center text-[0.86em] text-muted-foreground">{m.body}</p>
              ) : (
                <div className={cn('group flex items-end gap-1.5', mine ? 'flex-row-reverse' : '', !grouped && 'mt-2')} data-testid="message">
                  <div className={cn(compact ? 'max-w-[78%]' : 'max-w-[70%]', mine ? 'items-end' : 'items-start', 'flex flex-col')}>
                    {!mine && !grouped && (
                      <span className="mb-0.5 text-[0.86em] font-semibold">
                        <span>{m.senderName}</span>
                        <RoleMark memberId={m.senderId} />
                      </span>
                    )}
                    {m.deleted ? (
                      <div className="flex items-center gap-1.5 rounded-2xl border border-dashed border-border px-3 py-1.5 text-muted-foreground italic" data-testid="message-deleted">
                        <Ban className="size-3.5 shrink-0" aria-hidden /> 삭제된 메시지입니다.
                      </div>
                    ) : editing?.id === m.id ? (
                      <div className={cn('flex flex-col gap-1', compact ? 'w-60' : 'w-80')} data-testid="message-edit">
                        <Textarea
                          aria-label="메시지 고치기"
                          className="min-h-16 resize-none text-[1em]"
                          autoFocus
                          value={editing.text}
                          onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                              e.preventDefault()
                              void saveEdit()
                            } else if (e.key === 'Escape') {
                              e.stopPropagation()
                              setEditing(null)
                            }
                          }}
                        />
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                            취소
                          </Button>
                          <Button size="sm" onClick={() => void saveEdit()} disabled={!editing.text.trim() || !online}>
                            고치기
                          </Button>
                        </div>
                      </div>
                    ) : m.kind === 'text' && emojiOnly(m.body) ? (
                      <div className="text-[2.57em] leading-tight" data-testid="message-emoticon">
                        {m.body.trim()}
                      </div>
                    ) : (m.kind === 'image' || m.kind === 'file') && m.fileExpired ? (
                      <ExpiredFileChip name={m.fileExpired.name} size={m.fileExpired.size} at={m.fileExpired.at} image={m.kind === 'image'} className={compact ? 'w-60' : 'w-80'} />
                    ) : m.kind === 'image' && m.attachments[0] ? (
                      <AuthImage path={`/api/attachments/${m.attachments[0].id}`} alt={m.body} className="max-h-60 cursor-zoom-in rounded-lg border border-border" onClick={() => setViewer(m.attachments[0].id)} />
                    ) : m.kind === 'file' && m.attachments[0] ? (
                      <FileChip id={m.attachments[0].id} name={m.attachments[0].name} size={m.attachments[0].size} className={compact ? 'w-60' : 'w-80'} />
                    ) : (
                      <div className={cn('rounded-2xl px-3 py-1.5 whitespace-pre-wrap break-words', mine ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm bg-muted')} data-testid="message-body">
                        <LinkedText text={m.body} className={mine ? 'text-primary-foreground' : 'text-primary'} />
                      </div>
                    )}
                  </div>
                  <div className={cn('flex shrink-0 flex-col text-[0.78em] leading-tight', mine ? 'items-end' : 'items-start')}>
                    {m.unreadBy > 0 && (
                      <span className="font-bold text-important" title="아직 읽지 않은 사람 수" data-testid="unread-by">
                        {m.unreadBy}
                      </span>
                    )}
                    {m.editedAt && !m.deleted && (
                      <span className="text-muted-foreground" title={`${format(m.editedAt, 'M월 d일 a h:mm', { locale: ko })}에 수정함`} data-testid="message-edited">
                        수정됨
                      </span>
                    )}
                    <span className="text-muted-foreground">{format(m.createdAt, 'a h:mm', { locale: ko })}</span>
                  </div>
                  {mine && !m.deleted && editing?.id !== m.id && (
                    <div className="invisible flex shrink-0 items-center gap-0.5 self-center text-muted-foreground group-hover:visible group-focus-within:visible">
                      {m.kind === 'text' && Date.now() - m.createdAt < MESSAGE_EDIT_WINDOW_MS && (
                        <button className="cursor-pointer rounded p-0.5 hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-40" aria-label="메시지 고치기" title="고치기 (보낸 뒤 24시간까지)" disabled={!online} onClick={() => setEditing({ id: m.id, text: m.body })}>
                          <Pencil className="size-3.5" />
                        </button>
                      )}
                      <button className="cursor-pointer rounded p-0.5 hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-40" aria-label="메시지 삭제" title="삭제 (모든 사람에게서)" disabled={!online} onClick={() => void removeMessage(m)}>
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {waiting.map((w) => (
          <div key={w.id} className="mt-2 flex flex-row-reverse items-end gap-1.5" data-testid="message-waiting">
            <div className="max-w-[70%] rounded-2xl rounded-br-sm border border-dashed border-primary/60 bg-primary/10 px-3 py-1.5 whitespace-pre-wrap break-words">{(w.body as { body: string }).body}</div>
            <span className={cn('shrink-0 text-[0.78em]', w.state === 'failed' ? 'text-urgent' : 'text-muted-foreground')}>{w.state === 'failed' ? '보내지 못함' : '서버 연결 시 전송'}</span>
          </div>
        ))}
      </div>
      {err && <p className="px-4 text-xs text-urgent">{err}</p>}
      {staged.length > 0 && (
        <div className={cn('flex shrink-0 flex-wrap items-end gap-2 border-t border-border bg-muted/40', compact ? 'px-2 py-1.5' : 'px-3 py-2')} data-testid="staged-files">
          {staged.map((x, i) => (
            <div key={`${x.file.name}-${i}`} className="relative" title={x.file.name}>
              {x.url ? (
                <img src={x.url} alt={x.file.name} className={cn('rounded-md border border-border object-cover', compact ? 'size-14' : 'size-20')} />
              ) : (
                <div className={cn('flex items-center justify-center rounded-md border border-border bg-card p-1 text-center text-[0.65rem] break-all', compact ? 'size-14' : 'size-20')}>{x.file.name}</div>
              )}
              <button type="button" className="absolute -right-1.5 -top-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full border border-border bg-card shadow hover:bg-muted" aria-label={`${x.file.name} 빼기`} title="빼기" onClick={() => unstage(i)}>
                <X className="size-3" />
              </button>
            </div>
          ))}
          <span className="ml-1 self-center text-xs text-muted-foreground">Enter 또는 보내기를 누르면 보냅니다</span>
        </div>
      )}
      <div className={cn('relative flex shrink-0 items-end border-t border-border', compact ? 'gap-1 p-2' : 'gap-2 p-3')}>
        {picker && <EmoticonPicker compact={compact} onClose={() => setPicker(false)} onPick={insertEmoticon} />}
        <Button size="icon" variant="ghost" aria-label="파일 보내기" onClick={() => fileInput.current?.click()} disabled={!online || sending}>
          <Paperclip />
        </Button>
        <Button size="icon" variant="ghost" aria-label="이모티콘" title="이모티콘" aria-expanded={picker} data-emoticon-toggle onClick={() => setPicker((v) => !v)}>
          <Smile />
        </Button>
        <input ref={fileInput} type="file" multiple className="hidden" aria-label="보낼 파일" onChange={(e) => void sendFiles([...(e.target.files ?? [])]).then(() => fileInput.current && (fileInput.current.value = ''))} />
        <Textarea
          ref={inputRef}
          aria-label="메시지 입력"
          className="max-h-40 min-h-10 flex-1 resize-none"
          rows={1}
          placeholder={
            compact
              ? online
                ? '메시지 입력 (Enter 보내기)'
                : '서버 꺼짐 · 켜지면 보냅니다'
              : online
                ? '메시지 입력 (Enter 보내기, Shift+Enter 줄바꿈) · 캡처 이미지를 붙여넣을 수 있습니다'
                : '서버가 꺼져 있습니다. 쓴 메시지는 보관했다가 서버가 켜지면 보냅니다'
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          onPaste={(e) => {
            // a pasted image (or file) is shown above the input first; Enter or 보내기 sends it
            const files = [...e.clipboardData.files]
            if (files.length) {
              e.preventDefault()
              stage(files)
            }
          }}
        />
        <Button size="icon" aria-label="보내기" onClick={() => void send()} disabled={sending || (!text.trim() && !staged.length)}>
          {sending ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
      </div>
      <p className={cn('shrink-0 text-[var(--notice-fg)]', compact ? 'px-2.5 pb-1 text-[0.65rem]' : 'px-4 pb-1.5 text-[0.7rem]')}><TriangleAlert className="mr-1 inline size-3.5 align-[-0.15em]" aria-hidden />중요 보안 내용, 개인정보, 비공개 정보는 보낼 수 없습니다.</p>
      {people && c && layer(<ParticipantsDialog conv={c} onClose={() => setPeople(false)} onSwitch={(next) => onSwitch?.(next)} onLeft={onLeft} />)}
      {viewer &&
        layer(
          <Dialog open onClose={() => setViewer(null)} title="사진" width="max-w-5xl">
            <AuthImage path={`/api/attachments/${viewer}`} alt="사진" className="mx-auto max-h-[75vh]" />
          </Dialog>
        )}
    </div>
  )
}
