import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { MessageNewPayload } from '@shared/schemas/chat'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { useConn } from '@renderer/app/conn-store'
import { inDoNotDisturb } from '@renderer/app/prefs-store'
import { useChatUi } from './chat-store'

export function useChatUnread(): { messages: number; notes: number } {
  const online = useConn((s) => s.state === 'online')
  const q = useQuery({ queryKey: ['chat', 'unread'], queryFn: () => api.get<{ messages: number; notes: number }>('/api/chat/unread'), enabled: online, placeholderData: (p) => p })
  return q.data ?? { messages: 0, notes: 0 }
}

/** Windows notifications for new messages and notes (M5-2). Muted chats and the open chat stay silent. */
export function useChatAlerts(): void {
  const memberId = useConn((s) => s.memberId)
  useEffect(() => {
    const offMsg = realtime.on('message.new', (raw) => {
      const p = raw as MessageNewPayload
      if (p.senderId === memberId) return
      const viewing = useChatUi.getState().openId === p.conversationId && document.hasFocus()
      if (viewing || inDoNotDisturb()) return
      void api
        .get<{ muted: boolean }>(`/api/conversations/${p.conversationId}`)
        .then((c) => {
          if (!c.muted) void invoke('notify:toast', { title: p.title, body: `${p.senderName ?? ''}: ${p.preview}`, route: `/chat/${p.conversationId}` })
        })
        .catch(() => undefined)
    })
    const offNote = realtime.on('note.new', (raw) => {
      const p = raw as { fromName: string; preview: string }
      if (!inDoNotDisturb()) void invoke('notify:toast', { title: `쪽지 · ${p.fromName}`, body: p.preview, route: '/chat/notes' })
    })
    return () => {
      offMsg()
      offNote()
    }
  }, [memberId])
}
