import { useEffect } from 'react'
import { api } from '@renderer/lib/api'
import { invoke, onMain } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { queryClient } from '@renderer/lib/query-client'

/**
 * Tells the server PC which extensions this PC has installed and turned on (지시 92): after
 * connecting, after every reconnect and whenever the list changes. The 확장 기능 page shows from
 * it who uses what.
 */
export function usePluginInventory(online: boolean): void {
  useEffect(() => {
    if (!online) return
    let timer: number | null = null
    const report = (): void => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void invoke('plugins:list')
          .then((list) => api.put('/api/plugins/installed', { plugins: list.map((p) => ({ id: p.manifest.id, version: p.manifest.version, enabled: p.enabled })) }))
          .then(() => queryClient.invalidateQueries({ queryKey: ['plugins', 'installs'] }))
          .catch(() => undefined)
      }, 1500)
    }
    report()
    const offs = [onMain('plugins:changed', report), realtime.onReconnect(report)]
    return () => {
      if (timer) window.clearTimeout(timer)
      offs.forEach((o) => o())
    }
  }, [online])
}
