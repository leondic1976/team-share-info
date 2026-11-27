import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Minus, X } from 'lucide-react'
import type { ConversationDto } from '@shared/schemas/chat'
import { Button } from '@renderer/components/ui/button'
import { PresenceDot } from '@renderer/components/PresenceDot'
import { api } from '@renderer/lib/api'
import { useMembers } from '@renderer/lib/queries'
import { cn } from '@renderer/lib/utils'
import { useConn } from '@renderer/app/conn-store'
import { ConversationView } from './ConversationView'
import { useChatDock, type DockPanel } from './dock-store'
import { convTitle } from './title'
import { RoleMark } from '@renderer/components/RoleMark'

const PANEL_W = 340
const PANEL_H = 460
const TAB_W = 168
const GAP = 8
/** heights of the top bar and the status bar (TopBar.tsx, StatusBar.tsx): windows stay between them */
const TOP_H = 44
const STATUS_H = 52

/**
 * Small messenger windows (layers, not dialogs): the page behind them stays usable. They sit
 * in a row along the bottom right, above the status bar and beside the transfer panel, and can
 * be dragged by their header. Mounted once in MainShell so they survive moving between pages.
 */
export function ChatDock(): React.JSX.Element {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const online = useConn((s) => s.state === 'online')
  const meId = useConn((s) => s.memberId)
  const panels = useChatDock((s) => s.panels)
  const notice = useChatDock((s) => s.notice)
  const focus = useChatDock((s) => s.focus)
  const { close, setMinimized, replace, move, setCapacity, say, reset } = useChatDock.getState()
  const { data: team } = useMembers()
  // Titles and unread counts of minimised windows; also what openChatWith looks a 1:1 up in while the server is off.
  const list = useQuery({ queryKey: ['chat', 'list'], queryFn: () => api.get<ConversationDto[]>('/api/conversations'), enabled: online, placeholderData: (p) => p })
  const root = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState({ right: 16, width: 2 * PANEL_W, winW: window.innerWidth, winH: window.innerHeight })
  const [front, setFront] = useState<string | null>(null)
  const [more, setMore] = useState(false)

  // Room for the row: from the page area's left edge to the right edge, less the transfer panel when it is showing.
  useLayoutEffect(() => {
    const measure = (): void => {
      const transfer = document.querySelector<HTMLElement>('[data-testid="transfer-panel"]')
      const right = transfer ? Math.round(window.innerWidth - transfer.getBoundingClientRect().left) + GAP : 16
      const left = document.querySelector('main')?.getBoundingClientRect().left ?? 0
      const width = Math.max(PANEL_W, Math.round(window.innerWidth - right - left - GAP))
      setRoom((p) => (p.right === right && p.width === width && p.winW === window.innerWidth && p.winH === window.innerHeight ? p : { right, width, winW: window.innerWidth, winH: window.innerHeight }))
      setCapacity(Math.max(1, Math.min(4, Math.floor((width + GAP) / (PANEL_W + GAP)))))
    }
    measure()
    window.addEventListener('resize', measure)
    // the transfer panel is a sibling that comes and goes; the sidebar can change the page area's width
    const parent = root.current?.parentElement
    const mo = new MutationObserver(measure)
    if (parent) mo.observe(parent, { childList: true })
    const main = document.querySelector('main')
    const ro = new ResizeObserver(measure)
    if (main) ro.observe(main)
    return () => {
      window.removeEventListener('resize', measure)
      mo.disconnect()
      ro.disconnect()
    }
  }, [setCapacity])

  // windows belong to the member in use: none are left when the shell goes away
  useEffect(() => reset, [reset])

  useEffect(() => {
    if (!focus) return
    setFront(focus.id)
    const t = window.setTimeout(() => root.current?.querySelector<HTMLTextAreaElement>(`[data-conv="${CSS.escape(focus.id)}"] textarea`)?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [focus])

  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => say(''), 6000)
    return () => window.clearTimeout(t)
  }, [notice, say])

  useEffect(() => {
    if (!more) return
    const off = (): void => setMore(false)
    window.addEventListener('click', off)
    return () => window.removeEventListener('click', off)
  }, [more])

  const height = Math.max(240, Math.min(PANEL_H, room.winH - TOP_H - STATUS_H - 24))
  const clamp = (pos: { x: number; y: number }): { x: number; y: number } => ({
    x: Math.round(Math.min(Math.max(0, pos.x), Math.max(0, room.winW - PANEL_W))),
    y: Math.round(Math.min(Math.max(TOP_H + 4, pos.y), Math.max(TOP_H + 4, room.winH - STATUS_H - height - 4)))
  })

  const startDrag = (p: DockPanel) => (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, [role="link"], [role="menu"]')) return
    const el = e.currentTarget.closest<HTMLElement>('[data-testid="chat-panel"]')
    if (!el) return
    const box = el.getBoundingClientRect()
    const from = { x: e.clientX, y: e.clientY }
    let moved = false
    const onMove = (ev: MouseEvent): void => {
      // a click on the header is not a drag
      if (!moved && Math.abs(ev.clientX - from.x) + Math.abs(ev.clientY - from.y) < 4) return
      moved = true
      move(p.id, clamp({ x: box.left + ev.clientX - from.x, y: box.top + ev.clientY - from.y }))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    // no text selection while dragging
    e.preventDefault()
  }

  const info = (id: string): { title: string; unread: number; otherId: string | null } => {
    const c = list.data?.find((x) => x.id === id) ?? qc.getQueryData<ConversationDto>(['chat', 'conv', id])
    return { title: c ? convTitle(c, team, meId) : '대화', unread: c?.unread ?? 0, otherId: c?.kind === 'dm' ? (c.memberIds.find((m) => m !== meId) ?? null) : null }
  }

  // Minimised windows are tabs in the row; when they do not fit, the ones minimised longest ago go under "+N".
  const expanded = panels.filter((p) => !p.minimized && !p.pos).length
  const tabs = panels.filter((p) => p.minimized)
  const tabRoom = Math.max(1, Math.floor((room.width - expanded * (PANEL_W + GAP) + GAP) / (TAB_W + GAP)))
  const under = tabs.length > tabRoom ? tabs.slice(0, tabs.length - (tabRoom - 1)) : []
  const underIds = new Set(under.map((p) => p.id))

  return (
    <div ref={root} className="no-print pointer-events-none fixed z-30 flex flex-col items-end gap-2" style={{ right: room.right, bottom: STATUS_H + 8 }} data-testid="chat-dock">
      {notice && (
        <div role="status" className="pointer-events-auto flex max-w-sm items-start gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs shadow-lg" data-testid="chat-dock-notice">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" className="cursor-pointer rounded p-0.5 hover:bg-muted" aria-label="안내 닫기" onClick={() => say('')}>
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div className="flex flex-row-reverse items-end gap-2">
        {panels.map((p) => {
          const floating = !!p.pos && !p.minimized
          const at = floating ? clamp(p.pos!) : null
          const i = p.minimized ? info(p.id) : null
          const other = i?.otherId ? team?.find((m) => m.id === i.otherId) : undefined
          return (
            <section
              key={p.id}
              aria-label="작은 메신저 창"
              data-testid="chat-panel"
              data-conv={p.id}
              data-minimized={p.minimized}
              className={cn(
                'pointer-events-auto flex-col overflow-hidden border border-border bg-card shadow-xl',
                underIds.has(p.id) ? 'hidden' : 'flex',
                floating ? 'fixed rounded-lg' : 'rounded-t-lg',
                front === p.id && 'ring-1 ring-primary/40'
              )}
              style={p.minimized ? { width: TAB_W } : at ? { width: PANEL_W, height, left: at.x, top: at.y, zIndex: front === p.id ? 2 : 1 } : { width: PANEL_W, height }}
              onMouseDown={() => setFront(p.id)}
            >
              {i && (
                <div className="flex items-center bg-muted/60">
                  <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1.5 pl-2.5 text-left text-sm font-semibold hover:bg-muted" title={`${i.title} · 눌러서 펼치기`} onClick={() => setMinimized(p.id, false)} data-testid="chat-tab">
                    {other && <PresenceDot presence={other.presence} />}
                    <span className="truncate">{i.title}</span>
                    {other && <RoleMark memberId={other.id} role={other.role} isOwner={other.isOwner} className="ml-0" />}
                    {i.unread > 0 && (
                      <span className="ml-auto shrink-0 rounded-full bg-urgent px-1.5 text-[0.7rem] font-bold text-white" data-testid="chat-tab-unread">
                        {i.unread}
                      </span>
                    )}
                  </button>
                  <button type="button" className="cursor-pointer rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="창 닫기" title="창 닫기" onClick={() => close(p.id)}>
                    <X className="size-3.5" />
                  </button>
                </div>
              )}
              {/* stays mounted while minimised: the draft and the scroll position are kept */}
              <div className={cn('min-h-0 flex-1', p.minimized && 'hidden')}>
                <ConversationView
                  id={p.id}
                  compact
                  active={!p.minimized}
                  onLeft={() => close(p.id)}
                  onSwitch={(to) => replace(p.id, to)}
                  headerProps={{ onMouseDown: startDrag(p), className: 'cursor-move' }}
                  controls={
                    <>
                      <Button size="icon-sm" variant="ghost" aria-label="최소화" title="최소화" onClick={() => setMinimized(p.id, true)}>
                        <Minus />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="메신저에서 열기"
                        title="메신저에서 열기"
                        onClick={() => {
                          close(p.id)
                          navigate(`/chat/${p.id}`)
                        }}
                      >
                        <ExternalLink />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label="창 닫기" title="창 닫기" onClick={() => close(p.id)}>
                        <X />
                      </Button>
                    </>
                  }
                />
              </div>
            </section>
          )
        })}
        {under.length > 0 && (
          <div className="pointer-events-auto relative">
            <button
              type="button"
              className="cursor-pointer rounded-t-lg border border-border bg-card px-2.5 py-1.5 text-sm font-semibold shadow-xl hover:bg-muted"
              title="최소화한 다른 대화 보기"
              aria-haspopup="menu"
              aria-expanded={more}
              data-testid="chat-dock-more"
              onClick={(e) => {
                e.stopPropagation()
                setMore((v) => !v)
              }}
            >
              +{under.length}
              {under.some((p) => info(p.id).unread > 0) && <span className="ml-1 inline-block size-2 rounded-full bg-urgent align-middle" />}
            </button>
            {more && (
              <div role="menu" className="absolute bottom-full right-0 mb-1 max-h-72 w-56 overflow-y-auto rounded-md border border-border bg-card py-1 shadow-lg">
                {under.map((p) => {
                  const u = info(p.id)
                  return (
                    <button key={p.id} type="button" role="menuitem" className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted" onClick={() => setMinimized(p.id, false)}>
                      <span className="truncate">{u.title}</span>
                      {u.unread > 0 && <span className="ml-auto shrink-0 rounded-full bg-urgent px-1.5 text-[0.7rem] font-bold text-white">{u.unread}</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
