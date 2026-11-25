import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { InstalledPlugin, PluginPermission, PluginRoomDto } from '@shared/schemas/plugins'
import type { MemberDto } from '@shared/schemas/auth'
import { EmptyState } from '@renderer/components/EmptyState'
import { Button } from '@renderer/components/ui/button'
import { invoke } from '@renderer/lib/bridge'
import { api, errorMessage } from '@renderer/lib/api'
import { realtime } from '@renderer/lib/realtime'
import { useMe } from '@renderer/lib/queries'
import { usePrefs } from '@renderer/app/prefs-store'
import { MENU_PLUGINS } from '@renderer/app/menu'
import { Puzzle } from 'lucide-react'
import { detectPii, PII_LABEL } from '@shared/pii'
import { cachedRead } from '@renderer/lib/warm-cache'

type Msg = { th: 1; id: string; method: string; params: Record<string, unknown> | null }

/** Which permission each bridge method needs (manifest.permissions). */
const NEEDS: Record<string, PluginPermission | null> = {
  me: null,
  time: null,
  holidays: null,
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
  'ocr.recognize': 'ocr',
  'copilot.open': 'copilot',
  'pii.scan': null,
  openRoute: null
}

/**
 * Runs an installed plugin in a sandboxed iframe (own origin, no network: CSP set by
 * main) and answers its postMessage calls within the declared permissions.
 */
/**
 * A built-in extension shown as a left-menu item of its own (식사 신청): installed from the
 * program's own bundle the first time it is opened - no internet, no question - then run like
 * any other extension.
 */
export function MenuPlugin({ id }: { id: string }): React.JSX.Element {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['local', 'plugins'], queryFn: () => invoke('plugins:list'), networkMode: 'always' })
  const have = list.data?.find((p) => p.manifest.id === id)
  const [err, setErr] = useState('')
  const tried = useRef(false)
  useEffect(() => {
    if (!list.isFetched || tried.current || (have && have.enabled)) return
    tried.current = true
    void (async () => {
      try {
        if (!have) {
          const r = await invoke('plugins:installCatalog', { id, builtin: true })
          if (!r.ok) return setErr(r.error ?? '준비하지 못했습니다.')
        } else await invoke('plugins:setEnabled', { id, enabled: true })
        await qc.invalidateQueries({ queryKey: ['local', 'plugins'] })
      } catch (e) {
        setErr(errorMessage(e))
      }
    })()
  }, [list.isFetched, have, id, qc])
  if (err) return <EmptyState icon={Puzzle} title="화면을 준비하지 못했습니다" description={err} />
  if (!have?.enabled) return <EmptyState icon={Puzzle} title="준비하는 중…" />
  return <PluginHost fixedId={id} />
}

export function PluginHost({ fixedId }: { fixedId?: string } = {}): React.JSX.Element {
  const { id: routeId = '' } = useParams()
  const id = fixedId ?? routeId
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
          return me ? { id: me.id, name: me.name, deptName: me.deptName ?? null, isAdmin: me.role === 'admin' } : null
        case 'time':
          // the server's clock: deadlines must not depend on the clock of each PC
          return api.get<{ now: number }>('/api/time')
        case 'holidays': {
          // public holidays of TeamHub (관리 → 공휴일) between two dates
          const from = str('from', 10)
          const to = str('to', 10)
          return cachedRead(['plugin', 'holidays', from, to], () => api.get<{ date: string; name: string }[]>('/api/holidays', { from, to }))
        }
        case 'members':
          // the same kept list as the rest of the program: readable while the server PC is off
          return (await cachedRead(['members'], () => api.get<MemberDto[]>('/api/members'))).filter((x) => x.status === 'active').map((x) => ({ id: x.id, name: x.name, deptName: x.deptName, title: x.title, presence: x.presence }))
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
        // reads are kept (지시 81): an extension such as 식사 신청 shows its last state while the
        // server PC is off; writing needs the server and says so
        case 'rooms.list':
          return cachedRead(['plugin', id, 'rooms'], () => api.get<PluginRoomDto[]>(rooms))
        case 'rooms.get': {
          const roomId = str('roomId', 40)
          return cachedRead(['plugin', id, 'room', roomId], () => api.get<PluginRoomDto>(`${rooms}/${encodeURIComponent(roomId)}`))
        }
        case 'rooms.create':
          return api.post<PluginRoomDto>(rooms, { title: str('title', 100), scope: p.scope, shared: p.shared ?? {} })
        case 'rooms.setShared':
          return api.put<PluginRoomDto>(`${rooms}/${encodeURIComponent(str('roomId', 40))}/shared`, { shared: p.shared, version: p.version, close: p.close })
        case 'rooms.setEntry':
          return api.put<PluginRoomDto>(`${rooms}/${encodeURIComponent(str('roomId', 40))}/entry`, { value: p.value })
        case 'rooms.delete':
          return api.del(`${rooms}/${encodeURIComponent(str('roomId', 40))}`)
        case 'notify':
          return invoke('notify:toast', { title: str('title', 100), body: str('body', 300), route: `/plugins/${id}` })
        case 'clipboard.write':
          return invoke('clipboard:write', { text: str('text', 100_000) })
        case 'file.save':
          return invoke('plugins:saveFile', { id, name: str('name', 200), text: str('text', 6_000_000) })
        case 'file.open':
          return invoke('plugins:openFile', { id, exts: Array.isArray(p.exts) ? p.exts.filter((x): x is string => typeof x === 'string').slice(0, 6) : [] })
        case 'ocr.recognize':
          // image: a PNG/JPEG data URL made by the plugin; '' asks only for the languages of this PC
          return invoke('plugins:ocr', { id, image: typeof p.image === 'string' ? str('image', 17_000_000) : '', lang: typeof p.lang === 'string' ? str('lang', 20) : undefined })
        case 'copilot.open':
          return invoke('plugins:openCopilot', { id })
        case 'pii.scan':
          // what looks like personal information in a text (nothing is sent anywhere)
          return detectPii(str('text', 200_000)).map((f) => ({ kind: f.kind, label: PII_LABEL[f.kind], count: f.count, samples: f.samples }))
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

  // 관리대장 used to be the plugin "ledger": old links and invitations land on the built-in screen
  if (id === 'ledger') return <Navigate to={`/ledger${room ? `?room=${room}` : ''}`} replace />
  // extensions with a menu of their own are opened there
  if (!fixedId && MENU_PLUGINS[id]) return <Navigate to={`${MENU_PLUGINS[id]}${room ? `?room=${room}` : ''}`} replace />
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
