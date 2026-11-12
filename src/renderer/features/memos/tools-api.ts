import { useEffect } from 'react'
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import type { MainEvent } from '@shared/ipc'
import { invoke, onMain } from '@renderer/lib/bridge'

/** Local (this PC) query that refetches when the main process reports a change. */
export function useLocalQuery<T>(key: QueryKey, fn: () => Promise<T>, events: MainEvent[]) {
  const qc = useQueryClient()
  // Local reads are cheap; changes made while unmounted must show on mount.
  const q = useQuery({ queryKey: ['local', ...key], queryFn: fn, networkMode: 'always', refetchOnMount: 'always' })
  const evKey = events.join(',')
  useEffect(() => {
    const offs = evKey.split(',').map((e) => onMain(e as MainEvent, () => void qc.invalidateQueries({ queryKey: ['local', key[0]] })))
    return () => offs.forEach((o) => o())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, evKey, String(key[0])])
  return q
}

export const useMemos = (q: string) => useLocalQuery(['memos', q], () => invoke('local:memos.list', { q }), ['memos:changed'])
export const useAlarms = () => useLocalQuery(['alarms'], () => invoke('local:alarms.list'), ['alarms:changed'])
export const useSnippets = () => useLocalQuery(['snippets'], () => invoke('local:snippets.list'), [])
export const useClipboard = () => useLocalQuery(['clipboard'], () => invoke('local:clipboard.list'), ['clipboard:changed'])
export const useFavorites = () => useLocalQuery(['favorites'], () => invoke('local:favorites.list'), ['favorites:changed'])
export const useFocus = () => useLocalQuery(['focus'], () => invoke('focus:state'), ['focus:state'])

/** First line of a memo body as plain text (for titles of converted items). */
export function memoTitle(html: string, max = 60): string {
  const div = document.createElement('div')
  div.innerHTML = html.replace(/<\/(p|li|h\d|div)>/g, '</$1>\n')
  const line = (div.textContent ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}
