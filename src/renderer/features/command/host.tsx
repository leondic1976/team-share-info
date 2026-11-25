/**
 * TeamHub as the host of the 긴급구조지휘대 screens (command/renderer): HTTP with TeamHub's
 * authentication, its realtime channel, its file store, its alert cards and windows.
 */
import { useMemo, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, authHeaders, buildUrl, errorMessage } from '@renderer/lib/api'
import { realtime } from '@renderer/lib/realtime'
import { invoke, onMain } from '@renderer/lib/bridge'
import { useConn } from '@renderer/app/conn-store'
import { downloadAuthed, uploadAttachment } from '@renderer/components/Attachments'
import { openChatWith } from '@renderer/features/chat/dock-store'
import { toCsv } from '@shared/csv'
import { CommandHostProvider, type CommandClientHost } from '../../../../command/renderer/host'

export const COMMAND_BASE = '/command'

function useOnline(): boolean {
  return useConn((s) => s.state === 'online')
}

export function makeCommandHost(navigate: (p: string) => void, inPopup: boolean): CommandClientHost {
  return {
    api,
    errorMessage,
    useOnline,
    on: (event, cb) => {
      const off = realtime.on(event, cb)
      // a 훈련 창 that is asked for again (new message, 다시 알림) hears it as a drill event
      if (!inPopup || event !== 'command.drill') return off
      const offPoke = onMain('command:poke', (p) => cb({ drillId: p.drillId, kind: 'remind', msgId: p.msgId ?? undefined, popup: true }))
      return () => {
        off()
        offPoke()
      }
    },
    onReconnect: (cb) => realtime.onReconnect(cb),
    upload: async (file) => {
      const a = await uploadAttachment(file)
      return { id: a.id, name: a.name, size: a.size }
    },
    blobUrl: async (id) => {
      const r = await fetch(buildUrl(`/api/attachments/${id}`, { inline: '1' }), { headers: authHeaders() })
      if (!r.ok) throw new Error('그림을 불러오지 못했습니다.')
      return URL.createObjectURL(await r.blob())
    },
    download: (id, name) => void downloadAuthed(`/api/attachments/${id}`, name).catch((e: unknown) => window.alert(errorMessage(e))),
    openChat: (memberId) => void openChatWith(memberId),
    saveCsv: (fileName, rows) => {
      const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv' }))
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 3000)
    },
    openDrillWindow: (drillId) => void invoke('command:openDrill', { drillId }),
    openControlRoom: (drillId) => void invoke('command:openControl', { drillId }),
    closeWindow: () => void invoke('command:closeWindow'),
    showMain: (path) => (inPopup ? void invoke('window:showMain', { path }) : navigate(path)),
    alert: (o) => void invoke('notify:toast', o),
    basePath: COMMAND_BASE
  }
}

export function TeamHubCommandHost({ children, popup = false }: { children: ReactNode; popup?: boolean }): React.JSX.Element {
  const navigate = useNavigate()
  const host = useMemo(() => makeCommandHost((p) => void navigate(p), popup), [navigate, popup])
  return <CommandHostProvider host={host}>{children}</CommandHostProvider>
}
