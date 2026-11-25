import { useEffect } from 'react'
import { realtime } from '@renderer/lib/realtime'
import { warmCache } from '@renderer/lib/warm-cache'
import { useSpace } from './space-store'

/**
 * While connected, keep the main shared screens loaded in the background (see warmCache) so
 * they can still be read when the server PC goes off: a few seconds after connecting, again
 * after every reconnect, and every 10 minutes.
 */
export function useWarmCache(online: boolean, meal: boolean): void {
  const space = useSpace((s) => s.space)
  useEffect(() => {
    if (!online) return
    const run = (minGapMs?: number): void => void warmCache(space, { meal, minGapMs })
    const first = window.setTimeout(() => run(60_000), 4000)
    const every = window.setInterval(() => run(), 10 * 60_000)
    const off = realtime.onReconnect(() => window.setTimeout(() => run(0), 3000))
    return () => {
      window.clearTimeout(first)
      window.clearInterval(every)
      off()
    }
  }, [online, space, meal])
}
