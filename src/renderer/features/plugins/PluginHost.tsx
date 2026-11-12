import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { InstalledPlugin, PluginPermission, PluginRoomDto } from '@shared/schemas/plugins'
import type { MemberDto } from '@shared/schemas/auth'
import { EmptyState } from '@renderer/components/EmptyState'
import { Button } from '@renderer/components/ui/button'
import { invoke } from '@renderer/lib/bridge'
import { api, errorMessage } from '@renderer/lib/api'
import { realtime } from '@renderer/lib/realtime'
import { useMe } from '@renderer/lib/queries'
import { usePrefs } from '@renderer/app/prefs-store'
import { Puzzle } from 'lucide-react'

type Msg = { th: 1; id: string; method: string; params: Record<string, unknown> | null }

/** Which permission each bridge method needs (manifest.permissions). */
const NEEDS: Record<string, PluginPermission | null> = {
  me: null,
  members: 'members',
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.keys': 'storage',
  'rooms.list': 'rooms',
  'rooms.get': 'rooms',
  'rooms.create': 'rooms',
  'rooms.setShared': 'rooms',
  'rooms.setEntry': 'rooms',
  'rooms.delete': 'rooms',
  notify: 'notify',
  'clipboard.write': 'clipboard',
  'file.save': 'files',
  'file.open': 'files',
  openRoute: null
}

/**
 * Runs an installed plugin in a sandboxed iframe (own origin, no network: CSP set by
 * main) and answers its postMessage calls within the declared permissions.
 */
export function PluginHost(): React.JSX.Element {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const frame = useRef<HTMLIFrameElement>(null)
  const { data: me } = useMe()
  const theme = usePrefs((s) => s.theme)
  const list = useQuery({ queryKey: ['local', 'plugins'], queryFn: () => invoke('plugins:list'), networkMode: 'always' })
  const plugin: InstalledPlugin | undefined = list.data?.find((p) => p.manifest.id === id)
  const [src, setSrc] = useState('')
  const room = params.get('room')

  useEffect(() => {
    if (!plugin?.enabled) return
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    const q = new URLSearchParams({ theme: dark ? 'dark' : 'light', ...(room ? { room } : {}) })
    setSrc(`teamhub-plugin://${id}/${plugin.manifest.entry}?${q.toString()}`)
  }, [plugin, id, room, theme])

  useEffect(() => {
    if (!plugin) return
    const perms = new Set(plugin.manifest.permissions)
    const post = (m: unknown): void => frame.current?.contentWindow?.postMessage(m, '*')
    const rooms = `/api/plugins/${id}/rooms`
    const run = async (m: Msg): Promise<unknown> => {
      const p = m.params ?? {}
      const str = (k: string, max = 200): string => {
        const v = p[k]
        if (typeof v !== 'string' || v.length > max) throw new Error(`${k} 값이 올바르지 않습니다.`)
        return v
      }
      switch (m.method) {
        case 'me':
          return me ? { id: me.id, name: me.name, deptName: me.deptName ?? null } : null
        case 'members':
          return (await api.get<MemberDto[]>('/api/members')).filter((x) => x.status === 'active').map((x) => ({ id: x.id, name: x.name, deptName: x.deptName, title: x.title, presence: x.presence }))
        case 'storage.get':
          return invoke('local:kv.get', { key: `plugin:${id}:${str('key', 80)}` })
        case 'storage.set': {
          const v = JSON.stringify(p.value ?? null)
          if (v.length > 512 * 1024) throw new Error('저장할 데이터가 너무 큽니다(512KB).')
          return invoke('local:kv.set', { key: `plugin:${id}:${str('key', 80)}`, value: p.value ?? null })
        }
        case 'storage.keys': {
          const all = await invoke('local:kv.all')
          return Object.keys(all)
            .filter((k) => k.startsWith(`plugin:${id}:`))
            .map((k) => k.slice(`plugin:${id}:`.length))
        }
        case 'rooms.list':
          return api.get<PluginRoomDto[]>(rooms)
        case 'rooms.get':
          return api.get<PluginRoomDto>(`${rooms}/${encodeURIComponent(str('roomId', 40))}`)
        case 'rooms.create':
          return api.post<PluginRoomDto>(rooms, { title: str('title', 100), scope: p.scope, shared: p.shared ?? {} })
        case 'rooms.setShared':
          return api.put<PluginRoomDto>(`${rooms}/${encodeURIComponent(str('roomId', 40))}/shared`, { shared: p.shared, version: p.version, close: p.close })
        case 'rooms.setEntry':
          return api.put<PluginRoomDto>(`${rooms}/${encodeURIComponent(str('roomId', 40))}/entry`, { value: p.value })
        case 'rooms.delete':
          return api.del(`${rooms}/${encodeURIComponent(str('roomId', 40))}`)
        case 'notify':
          return invoke('notify:toast', { title: `${plugin.manifest.icon} ${str('title', 100)}`, body: str('body', 300), route: `/plugins/${id}` })
        case 'clipboard.write':
          return invoke('clipboard:write', { text: str('text', 100_000) })
        case 'file.save':
          return invoke('plugins:saveFile', { id, name: str('name', 200), text: str('text', 6_000_000) })
        case 'file.open':
          return invoke('plugins:openFile', { id, exts: Array.isArray(p.exts) ? p.exts.filter((x): x is string => typeof x === 'string').slice(0, 6) : [] })
        case 'openRoute':
          // only routes of this plugin (e.g. another room)
          navigate(`/plugins/${id}${typeof p.room === 'string' && /^[\w-]{1,40}$/.test(p.room) ? `?room=${p.room}` : ''}`)
          return null
        default:
          throw new Error(`알 수 없는 기능: ${m.method}`)
      }
    }
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frame.current?.contentWindow) return
      const m = e.data as Msg
      if (!m || m.th !== 1 || typeof m.id !== 'string' || typeof m.method !== 'string') return
      const need = NEEDS[m.method]
      if (need === undefined) return post({ th: 1, id: m.id, error: `알 수 없는 기능: ${m.method}` })
      if (need && !perms.has(need)) return post({ th: 1, id: m.id, error: `권한이 없습니다(${need}). 확장 기능 정보에 권한이 선언되어야 합니다.` })
      run(m).then(
        (result) => post({ th: 1, id: m.id, result: result ?? null }),
        (err: unknown) => post({ th: 1, id: m.id, error: errorMessage(err) })
      )
    }
    window.addEventListener('message', onMessage)
    const offRoom = realtime.on('plugin.room', (pl) => {
      const x = pl as { pluginId: string; roomId: string; deleted?: boolean }
      if (x.pluginId === id) post({ th: 1, event: 'room.changed', data: { roomId: x.roomId, deleted: !!x.deleted } })
    })
    return () => {
      window.removeEventListener('message', onMessage)
      offRoom()
    }
  }, [plugin, id, me, navigate])

  if (list.isFetched && !plugin)
    return <EmptyState icon={Puzzle} title="설치되지 않은 확장 기능입니다" action={<Button onClick={() => navigate(`/plugins?install=${id}`)}>확장 기능 화면으로</Button>} />
  if (plugin && !plugin.enabled) return <EmptyState icon={Puzzle} title={`${plugin.manifest.name}이(가) 꺼져 있습니다`} description="확장 기능 화면에서 켤 수 있습니다." />
  return (
    <div className="flex h-full flex-col">
      {src && (
        <iframe
          ref={frame}
          key={src}
          src={src}
          title={plugin?.manifest.name ?? '확장 기능'}
          sandbox="allow-scripts allow-forms allow-modals"
          className="min-h-0 w-full flex-1 border-0 bg-background"
          data-testid="plugin-frame"
        />
      )}
    </div>
  )
}
