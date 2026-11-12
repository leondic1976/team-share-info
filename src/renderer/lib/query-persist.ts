import type { QueryKey } from '@tanstack/react-query'
import { queryClient } from './query-client'
import { invoke } from './bridge'

/**
 * Read cache (13.11, M8-3): the last server results the member saw are kept in the local
 * DB and shown again when TeamHub starts without a server connection. Keys are prefixed
 * with the member id, so another account on the PC never sees them. Only server lists
 * are kept (first key element below); local data does not need it.
 */
const PERSIST = new Set(['hello', 'me', 'members', 'notices', 'events', 'docs', 'tasks', 'boards', 'contacts', 'groups', 'chat', 'files', 'worklogs', 'meetings', 'shared-memos', 'launcher', 'departments'])
const MAX_VALUE = 1_000_000

let prefix = ''
let started = false
const dirty = new Map<string, string>()
let timer: number | null = null

const keyOf = (k: QueryKey): string => `${prefix}${JSON.stringify(k)}`

function flush(): void {
  timer = null
  if (!dirty.size) return
  const entries = [...dirty].map(([key, value]) => ({ key, value }))
  dirty.clear()
  void invoke('local:cache.save', { entries }).catch(() => undefined)
}

/** Restore cached results for this member, then keep saving new ones. */
export async function startQueryPersist(memberId: string): Promise<number> {
  prefix = `${memberId}:`
  let restored = 0
  try {
    for (const r of await invoke('local:cache.load', { prefix })) {
      const key = JSON.parse(r.key.slice(prefix.length)) as QueryKey
      if (queryClient.getQueryData(key) !== undefined) continue
      // older than anything fetched now, so a live answer replaces it at once
      queryClient.setQueryData(key, JSON.parse(r.value), { updatedAt: r.updatedAt - 60_000 })
      restored++
    }
  } catch {
    // cache unreadable: start empty
  }
  if (!started) {
    started = true
    queryClient.getQueryCache().subscribe((ev) => {
      if (ev.type !== 'updated' || ev.action.type !== 'success' || !prefix) return
      const k = ev.query.queryKey
      if (typeof k[0] !== 'string' || !PERSIST.has(k[0])) return
      const json = JSON.stringify(ev.query.state.data ?? null)
      if (json.length > MAX_VALUE) return
      dirty.set(keyOf(k), json)
      timer ??= window.setTimeout(flush, 3000)
    })
    window.addEventListener('beforeunload', flush)
  }
  return restored
}

export function clearQueryPersist(): void {
  prefix = ''
  dirty.clear()
  void invoke('local:cache.clear').catch(() => undefined)
}
