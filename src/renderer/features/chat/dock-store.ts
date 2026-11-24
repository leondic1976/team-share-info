import { create } from 'zustand'
import type { ConversationDto } from '@shared/schemas/chat'
import { api, errorMessage } from '@renderer/lib/api'
import { queryClient } from '@renderer/lib/query-client'
import { useConn } from '@renderer/app/conn-store'

/** A small messenger window (ChatDock). `pos` is set once the window has been dragged out of the row. */
export interface DockPanel {
  id: string
  minimized: boolean
  pos: { x: number; y: number } | null
}

/** More than this and the one opened first is closed. */
const MAX_PANELS = 12

interface DockStore {
  /** in the order they were opened; the first sits at the right edge */
  panels: DockPanel[]
  /** how many expanded windows fit side by side (set by the dock from the window width) */
  capacity: number
  /** the window that should take the keyboard, and a counter so asking twice works */
  focus: { id: string; tick: number } | null
  notice: string
  open: (id: string) => void
  close: (id: string) => void
  setMinimized: (id: string, minimized: boolean) => void
  /** the window showing `from` goes on with conversation `to` (people were added to a 1:1) */
  replace: (from: string, to: string) => void
  move: (id: string, pos: { x: number; y: number }) => void
  setCapacity: (n: number) => void
  say: (notice: string) => void
  reset: () => void
}

/** Minimise the windows opened first until the expanded ones in the row fit; `keep` stays open. */
function fit(panels: DockPanel[], capacity: number, keep?: string): DockPanel[] {
  let over = panels.filter((p) => !p.minimized && !p.pos).length - capacity
  if (over <= 0) return panels
  return panels.map((p) => {
    if (over <= 0 || p.minimized || p.pos || p.id === keep) return p
    over--
    return { ...p, minimized: true }
  })
}

let ticks = 0

export const useChatDock = create<DockStore>((set) => ({
  panels: [],
  capacity: 2,
  focus: null,
  notice: '',
  open: (id) =>
    set((s) => {
      const has = s.panels.some((p) => p.id === id)
      let panels = has ? s.panels.map((p) => (p.id === id ? { ...p, minimized: false } : p)) : [...s.panels, { id, minimized: false, pos: null }]
      if (panels.length > MAX_PANELS) panels = panels.slice(panels.length - MAX_PANELS)
      return { panels: fit(panels, s.capacity, id), focus: { id, tick: ++ticks } }
    }),
  close: (id) => set((s) => ({ panels: s.panels.filter((p) => p.id !== id) })),
  setMinimized: (id, minimized) =>
    set((s) => {
      const panels = s.panels.map((p) => (p.id === id ? { ...p, minimized } : p))
      return minimized ? { panels } : { panels: fit(panels, s.capacity, id), focus: { id, tick: ++ticks } }
    }),
  replace: (from, to) =>
    set((s) => ({
      // already open elsewhere: this window closes and that one comes forward
      panels: s.panels.some((p) => p.id === to) ? s.panels.filter((p) => p.id !== from).map((p) => (p.id === to ? { ...p, minimized: false } : p)) : s.panels.map((p) => (p.id === from ? { ...p, id: to } : p)),
      focus: { id: to, tick: ++ticks }
    })),
  move: (id, pos) => set((s) => ({ panels: s.panels.map((p) => (p.id === id ? { ...p, pos } : p)) })),
  setCapacity: (n) => set((s) => (n === s.capacity ? s : { capacity: n, panels: fit(s.panels, n) })),
  say: (notice) => set({ notice }),
  reset: () => set({ panels: [], focus: null, notice: '' })
}))

/**
 * Open the 1:1 conversation with a member in a small messenger window, right where the name
 * was clicked. A conversation already known from the kept list opens without the server (so it
 * can be read, and messages queued, while the server PC is off); a new one needs the server.
 */
export async function openChatWith(memberId: string): Promise<void> {
  const conn = useConn.getState()
  if (!memberId || memberId === conn.memberId) return
  const dock = useChatDock.getState()
  const known = (queryClient.getQueryData<ConversationDto[]>(['chat', 'list']) ?? []).find((c) => c.kind === 'dm' && c.memberIds.includes(memberId))
  if (known) return dock.open(known.id)
  if (conn.state !== 'online') return dock.say('서버가 꺼져 있어 새 대화를 시작할 수 없습니다. 서버가 켜진 뒤 다시 눌러 주세요.')
  try {
    const c = await api.post<ConversationDto>('/api/conversations', { memberIds: [memberId] })
    queryClient.setQueryData<ConversationDto[]>(['chat', 'list'], (old) => (old && !old.some((x) => x.id === c.id) ? [c, ...old] : old))
    dock.open(c.id)
  } catch (e) {
    dock.say(errorMessage(e))
  }
}
