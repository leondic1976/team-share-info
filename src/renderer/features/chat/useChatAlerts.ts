import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { MessageNewPayload } from '@shared/schemas/chat'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { useConn } from '@renderer/app/conn-store'
import { inDoNotDisturb, usePrefs } from '@renderer/app/prefs-store'
import { playMessageSound } from '@renderer/lib/message-sound'
import { isViewingConversation } from './chat-store'

export function useChatUnread(): { messages: number; notes: number } {
  const online = useConn((s) => s.state === 'online')
  const q = useQuery({ queryKey: ['chat', 'unread'], queryFn: () => api.get<{ messages: number; notes: number }>('/api/chat/unread'), enabled: online, placeholderData: (p) => p })
  return q.data ?? { messages: 0, notes: 0 }
}

/**
 * A new message or note: a card near the tray (or a Windows notification when the card is
 * turned off in 설정) and the "팀뿌요~" sound (지시 83). Focus mode holds both back.
 */
async function alert(o: { key: string; title: string; body: string; route: string }): Promise<void> {
  const prefs = usePrefs.getState()
  let shown = true
  if (prefs.msgPreview) shown = await invoke('notify:preview', { ...o, sound: prefs.msgSound }).catch(() => false)
  else void invoke('notify:toast', { title: o.title, body: o.body, route: o.route })
  if (shown && prefs.msgSound) playMessageSound()
}

/** Alerts for new messages and notes (M5-2). Muted chats and the open chat stay silent. */
export function useChatAlerts(): void {
  const memberId = useConn((s) => s.memberId)
  useEffect(() => {
    const offMsg = realtime.on('message.new', (raw) => {
      const p = raw as MessageNewPayload
      if (p.senderId === memberId) return
      // on the messenger page or in an expanded small window (a minimised one does not count)
      // a window hidden to the tray still says in the page that it is visible and has the focus:
      // the main process is asked (지시 83). A small messenger window counts like the page.
      const viewing = async (): Promise<boolean> => isViewingConversation(p.conversationId) && document.hasFocus() && (await invoke('window:inFront').catch(() => true))
      if (inDoNotDisturb()) return
      void Promise.all([viewing(), api.get<{ muted: boolean }>(`/api/conversations/${p.conversationId}`)])
        .then(async ([seen, c]) => {
          // looked at in the meantime: nothing to tell
          if (!seen && !c.muted && !(await viewing())) void alert({ key: p.conversationId, title: p.title, body: `${p.senderName ?? ''}: ${p.preview}`, route: `/chat/${p.conversationId}` })
        })
        .catch(() => undefined)
    })
    const offNote = realtime.on('note.new', (raw) => {
      const p = raw as { fromName: string; preview: string }
      if (!inDoNotDisturb()) void alert({ key: 'notes', title: `쪽지 · ${p.fromName}`, body: p.preview, route: '/chat/notes' })
    })
    return () => {
      offMsg()
      offNote()
    }
  }, [memberId])
}
