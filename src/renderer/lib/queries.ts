import { useQuery } from '@tanstack/react-query'
import { displayName, type Hello, type MeDto, type MemberDto } from '@shared/schemas/auth'
import { DEFAULT_NOTICE_TEXT } from '@shared/constants'
import { api, request } from './api'
import { useConn } from '@renderer/app/conn-store'
import { localKv } from './bridge'

/** Shared queries used across features. */

export function useHello() {
  const serverUrl = useConn((s) => s.serverUrl)
  return useQuery({
    queryKey: ['hello', serverUrl],
    queryFn: async () => {
      const h = await request<Hello>('/api/hello', { noAuth: true })
      void localKv.set('lastHello', h)
      // one per server address: a PC that uses several servers shows the right team while offline
      if (serverUrl) void localKv.set(`hello:${serverUrl}`, h)
      return h
    },
    enabled: !!serverUrl,
    staleTime: 60_000,
    // Show the last known org info while offline (13.11).
    placeholderData: (prev) => prev
  })
}

export function useOrgDisplay(): { orgName: string; teamName: string; noticeText: string } {
  const { data } = useHello()
  return {
    orgName: data?.orgName ?? '',
    teamName: data?.teamName ?? '',
    noticeText: data?.noticeText || DEFAULT_NOTICE_TEXT
  }
}

export function useMe() {
  const online = useConn((s) => s.state === 'online')
  const setMe = useConn((s) => s.setMe)
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const me = await api.get<MeDto>('/api/me')
      setMe(me)
      void localKv.set(`me:${me.id}`, me)
      return me
    },
    enabled: online,
    staleTime: 60_000
  })
}

/**
 * "본명(필명)" of a member known only by id and real name (rows the server sends with the real
 * name): looked up in the members list, the given name when the member is not in it.
 */
export function useDisplayName(): (m: { id?: string | null; name: string }) => string {
  const { data } = useMembers()
  return (m) => {
    const full = m.id ? data?.find((x) => x.id === m.id) : undefined
    return full ? displayName(full) : m.name
  }
}

export function useMembers() {
  const online = useConn((s) => s.state === 'online')
  return useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<MemberDto[]>('/api/members'),
    enabled: online
  })
}
