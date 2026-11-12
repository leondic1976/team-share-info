import { useEffect } from 'react'
import type { PluginInvitePayload } from '@shared/schemas/plugins'
import { realtime } from '@renderer/lib/realtime'
import { invoke } from '@renderer/lib/bridge'

/** "OO님이 사다리타기에 초대했습니다" — opens the plugin room when clicked. */
export function usePluginInvites(): void {
  useEffect(
    () =>
      realtime.on('plugin.invite', (p) => {
        const x = p as PluginInvitePayload
        void invoke('plugins:list').then((list) => {
          const pl = list.find((i) => i.manifest.id === x.pluginId && i.enabled)
          void invoke('notify:toast', {
            title: pl ? `${pl.manifest.icon} ${pl.manifest.name} 초대` : '확장 기능 초대',
            body: pl ? `${x.fromName}님: ${x.title}` : `${x.fromName}님이 "${x.title}"에 초대했습니다. 확장 기능(${x.pluginId})을 설치하면 참여할 수 있습니다.`,
            route: pl ? `/plugins/${x.pluginId}?room=${x.roomId}` : `/plugins?install=${x.pluginId}`
          })
        })
      }),
    []
  )
}
