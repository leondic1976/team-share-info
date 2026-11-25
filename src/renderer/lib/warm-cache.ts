import { startOfDay, startOfMonth, startOfWeek, addMonths } from 'date-fns'
import type { QueryKey } from '@tanstack/react-query'
import type { ConversationDto, MessageDto, NoteDto } from '@shared/schemas/chat'
import type { NoticeSummaryDto } from '@shared/schemas/notices'
import type { MemberDto } from '@shared/schemas/auth'
import { queryClient } from './query-client'
import { api, ApiError } from './api'

/**
 * Server PC off (지시 81, 2026-11-25): what a member has looked at is kept and shown again
 * (query-persist), but a screen never opened was empty. While connected, the main shared screens
 * are loaded quietly in the background with exactly the keys the screens use, so they are kept
 * too and can be read when the server is off.
 *
 * Only reads without side effects are made: a post is not opened (that counts a view); a
 * notice is (that only notes it as delivered to this PC, which it then is).
 */

const DAY = 86_400_000
const FRESH = 4 * 60_000
const CHATS = 20
const MESSAGES = 50
const NOTICES = 20

/** A request that failed because the server PC cannot be reached (not refused by it). */
export function isOffline(e: unknown): boolean {
  return !(e instanceof ApiError) || e.code === 'NETWORK' || e.code === 'NO_SERVER' || e.status === 0 || e.status >= 502
}

/**
 * Read through the kept results: asks the server and keeps the answer; when the server cannot
 * be reached, answers with what was kept (or fails when there is nothing).
 */
export async function cachedRead<T>(key: QueryKey, fetcher: () => Promise<T>): Promise<T> {
  try {
    const v = await fetcher()
    queryClient.setQueryData(key, v)
    return v
  } catch (e) {
    const kept = queryClient.getQueryData<T>(key)
    if (kept !== undefined && isOffline(e)) return kept
    throw e
  }
}

/** The wide range of shared events kept for the calendar while the server is off. */
export function warmEventsRange(now = Date.now()): { from: number; to: number } {
  const from = startOfMonth(addMonths(now, -1)).getTime() - 7 * DAY
  return { from, to: startOfMonth(addMonths(now, 3)).getTime() + 7 * DAY }
}
export const warmEventsKey = (groupId: string | undefined): QueryKey => ['events', 'warm', groupId ?? '']

const prefetch = <T>(queryKey: QueryKey, queryFn: () => Promise<T>): Promise<T | undefined> =>
  queryClient
    .fetchQuery({ queryKey, queryFn, staleTime: FRESH })
    .catch(() => undefined)

let running = false
let lastAt = 0

/**
 * Loads what the shared screens show first (team space and `space`), a few requests at a time.
 * Does nothing when it ran less than `minGapMs` ago.
 */
export async function warmCache(space: string, opts: { minGapMs?: number; meal?: boolean } = {}): Promise<void> {
  if (running || Date.now() - lastAt < (opts.minGapMs ?? 5 * 60_000)) return
  running = true
  lastAt = Date.now()
  const groupId = space === 'team' ? undefined : space
  try {
    // 메신저: the list, the latest messages of the recent conversations, received notes
    const convs = await prefetch(['chat', 'list'], () => api.get<ConversationDto[]>('/api/conversations'))
    for (const c of [...(convs ?? [])].sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0)).slice(0, CHATS)) {
      const list = await api.get<MessageDto[]>(`/api/conversations/${c.id}/messages`, { limit: MESSAGES }).catch(() => null)
      // a conversation open on screen keeps more than this: never replace it with less
      const kept = queryClient.getQueryData<MessageDto[]>(['chat', 'msgs', c.id])
      if (list && (!kept || !kept.length || kept[kept.length - 1]!.seq <= list[list.length - 1]?.seq)) queryClient.setQueryData(['chat', 'msgs', c.id], kept && kept.length > list.length ? [...kept.filter((m) => m.seq < (list[0]?.seq ?? 0)), ...list] : list)
    }
    await prefetch(['chat', 'notes', 'inbox'], () => api.get<NoteDto[]>('/api/notes', { box: 'inbox' }))
    await prefetch(['members'], () => api.get<MemberDto[]>('/api/members'))

    // 공지: the list and the newest notices themselves
    for (const sp of new Set(['team', space])) {
      const notices = await prefetch(['notices', 'list', 'all', sp], () => api.get<NoticeSummaryDto[]>('/api/notices', { filter: 'all', groupId: sp === 'team' ? undefined : sp }))
      for (const n of (notices ?? []).slice(0, NOTICES)) await prefetch(['notices', n.id], () => api.get(`/api/notices/${n.id}`))
    }

    // 게시판: the boards and the first page of each (posts are not opened: that counts a view)
    const boards = await prefetch(['boards', 'all'], () => api.get<{ id: string }[]>('/api/boards'))
    for (const b of boards ?? []) await prefetch(['boards', 'list', b.id, ''], () => api.get(`/api/boards/${b.id}/posts`, { q: '' }))

    // 자료실: the top folder
    await prefetch(['files', 'view', 'root', space], () => api.get('/api/files/view', { folderId: undefined, groupId }))

    // 기록: each kind of document
    for (const kind of ['mustread', 'manual', 'handover', 'minutes', 'faq']) await prefetch(['docs', 'list', kind, '', space], () => api.get('/api/docs', { kind, q: '', groupId }))

    // 근무현황: this week (일별·주간) and this month (목록)
    const day = startOfDay(Date.now()).getTime()
    const week = startOfWeek(day, { weekStartsOn: 1 }).getTime()
    await prefetch(['events', 'duty', week, week + 7 * DAY], () => api.get('/api/duty', { from: week, to: week + 7 * DAY }))
    const month = startOfMonth(day).getTime()
    const monthEnd = addMonths(month, 1).getTime()
    await prefetch(['events', 'duty', month, monthEnd], () => api.get('/api/duty', { from: month, to: monthEnd }))

    // 일정: a wide range the calendar falls back on (see useServerEvents)
    const r = warmEventsRange()
    await prefetch(warmEventsKey(groupId), () => api.get('/api/events', { from: r.from, to: r.to, groupId }))

    // 식사 신청: the room with the settings, menus and requests
    if (opts.meal !== false) await prefetch(['plugin', 'meal', 'rooms'], () => api.get('/api/plugins/meal/rooms'))
  } finally {
    running = false
  }
}

/** For tests: run again at once. */
export function resetWarmCache(): void {
  lastAt = 0
}
