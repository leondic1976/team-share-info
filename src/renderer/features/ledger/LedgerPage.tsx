import { useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { MemberDto } from '@shared/schemas/auth'
import type { PluginRoomDto } from '@shared/schemas/plugins'
import type { LedgerChangedPayload, LedgerDto, LedgerMeta } from '@shared/schemas/ledger'
import { invoke } from '@renderer/lib/bridge'
import { api, ApiError, errorMessage } from '@renderer/lib/api'
import { realtime } from '@renderer/lib/realtime'
import { useMe } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import { usePrefs } from '@renderer/app/prefs-store'

type Msg = { th: 1; id: string; method: string; params: Record<string, unknown> | null }

/** Same id as the former "스마트 대장" plugin: personal ledgers stay under these local keys. */
const APP = 'ledger'
const KEY = (k: string): string => `plugin:${APP}:${k}`
const ROOMS = `/api/plugins/${APP}/rooms`

/**
 * 관리대장: the sheet screen (resources/ledger) runs in an isolated frame without network
 * access and asks this page for everything — personal ledgers go to the local DB of this
 * PC, team ledgers to the server.
 */
export function LedgerPage(): React.JSX.Element {
  const [params] = useSearchParams()
  const frame = useRef<HTMLIFrameElement>(null)
  const { data: me } = useMe()
  const online = useConn((s) => s.state === 'online')
  const theme = usePrefs((s) => s.theme)
  const room = params.get('room')
  const meRef = useRef(me)
  meRef.current = me
  /** The team ledger this screen holds the edit lock of, so leaving the screen frees it at once. */
  const locked = useRef<string | null>(null)

  const src = useMemo(() => {
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    const q = new URLSearchParams({ theme: dark ? 'dark' : 'light', ...(room ? { room } : {}) })
    return `teamhub-plugin://${APP}/index.html?${q.toString()}`
  }, [theme, room])

  useEffect(() => {
    const post = (m: unknown): void => frame.current?.contentWindow?.postMessage(m, '*')
    const run = async (m: Msg): Promise<unknown> => {
      const p = m.params ?? {}
      const str = (k: string, max = 200): string => {
        const v = p[k]
        if (typeof v !== 'string' || !v || v.length > max) throw new Error(`${k} 값이 올바르지 않습니다.`)
        return v
      }
      const id = (): string => encodeURIComponent(str('id', 60))
      switch (m.method) {
        case 'online':
          return useConn.getState().state === 'online'
        case 'me': {
          const u = meRef.current
          return u ? { id: u.id, name: u.name, deptName: u.deptName ?? null, role: u.role } : null
        }
        case 'groups':
          return (meRef.current?.groups ?? []).map((g) => ({ id: g.id, name: g.name }))
        case 'members':
          return (await api.get<MemberDto[]>('/api/members')).filter((x) => x.status === 'active').map((x) => ({ id: x.id, name: x.name, deptName: x.deptName, title: x.title }))
        case 'storage.get':
          return invoke('local:kv.get', { key: KEY(str('key', 80)) })
        case 'storage.set':
          if (p.value === null || p.value === undefined) return invoke('local:kv.delete', { key: KEY(str('key', 80)) })
          if (JSON.stringify(p.value).length > 512 * 1024) throw new Error('저장할 데이터가 너무 큽니다(512KB).')
          return invoke('local:kv.set', { key: KEY(str('key', 80)), value: p.value })
        // team ledgers (server)
        case 'team.list':
          return api.get<LedgerMeta[]>('/api/ledgers')
        case 'team.get':
          return api.get<LedgerDto>(`/api/ledgers/${id()}`)
        case 'team.create':
          return api.post<LedgerDto>('/api/ledgers', { doc: p.doc, scope: p.scope, editMode: p.editMode, icon: p.icon })
        case 'team.save':
          return api.put<LedgerMeta>(`/api/ledgers/${id()}`, { doc: p.doc, version: p.version, icon: p.icon })
        case 'team.lock': {
          const r = await api.post<LedgerDto>(`/api/ledgers/${id()}/lock`)
          locked.current = r.id
          return r
        }
        case 'team.beat':
          return api.post<LedgerMeta>(`/api/ledgers/${id()}/lock?brief=1`)
        case 'team.unlock':
          if (locked.current === p.id) locked.current = null
          return api.del<LedgerMeta>(`/api/ledgers/${id()}/lock`)
        case 'team.update':
          return api.patch<LedgerMeta>(`/api/ledgers/${id()}`, { scope: p.scope, editMode: p.editMode })
        case 'team.delete':
          return api.del(`/api/ledgers/${id()}`)
        // read-only copies shared before team ledgers existed ("보기 공유")
        case 'rooms.list':
          return api.get<PluginRoomDto[]>(ROOMS)
        case 'rooms.get':
          return api.get<PluginRoomDto>(`${ROOMS}/${encodeURIComponent(str('roomId', 40))}`)
        case 'rooms.create':
          return api.post<PluginRoomDto>(ROOMS, { title: str('title', 100), scope: p.scope, shared: p.shared ?? {} })
        case 'rooms.setShared':
          return api.put<PluginRoomDto>(`${ROOMS}/${encodeURIComponent(str('roomId', 40))}/shared`, { shared: p.shared, version: p.version })
        case 'rooms.delete':
          return api.del(`${ROOMS}/${encodeURIComponent(str('roomId', 40))}`)
        case 'clipboard.write':
          return invoke('clipboard:write', { text: str('text', 600_000) })
        case 'file.save':
          return invoke('plugins:saveFile', { id: APP, name: str('name', 200), text: str('text', 6_000_000) })
        case 'file.open':
          return invoke('plugins:openFile', { id: APP, exts: Array.isArray(p.exts) ? p.exts.filter((x): x is string => typeof x === 'string').slice(0, 6) : [] })
        default:
          throw new Error(`알 수 없는 기능: ${m.method}`)
      }
    }
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frame.current?.contentWindow) return
      const m = e.data as Msg
      if (!m || m.th !== 1 || typeof m.id !== 'string' || typeof m.method !== 'string') return
      run(m).then(
        (result) => post({ th: 1, id: m.id, result: result ?? null }),
        (err: unknown) => post({ th: 1, id: m.id, error: errorMessage(err), code: err instanceof ApiError ? err.code : '' })
      )
    }
    window.addEventListener('message', onMessage)
    const offRoom = realtime.on('plugin.room', (pl) => {
      const x = pl as { pluginId: string; roomId: string; deleted?: boolean }
      if (x.pluginId === APP) post({ th: 1, event: 'room.changed', data: { roomId: x.roomId, deleted: !!x.deleted } })
    })
    const offLedger = realtime.on('ledger.changed', (pl) => post({ th: 1, event: 'team.changed', data: pl as LedgerChangedPayload }))
    // after a reconnect anything may have changed
    const offRe = realtime.onReconnect(() => post({ th: 1, event: 'team.changed', data: {} }))
    return () => {
      window.removeEventListener('message', onMessage)
      offRoom()
      offLedger()
      offRe()
    }
  }, [])

  // a reloaded frame (theme change, another room) starts without the lock its predecessor held
  useEffect(
    () => () => {
      if (locked.current) void api.del(`/api/ledgers/${encodeURIComponent(locked.current)}/lock`).catch(() => undefined)
      locked.current = null
    },
    [src]
  )

  // the frame shows whether team ledgers can be reached right now
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ th: 1, event: 'online', data: { online } }, '*')
  }, [online])

  return (
    <div className="flex h-full flex-col">
      <iframe ref={frame} key={src} src={src} title="관리대장" sandbox="allow-scripts allow-forms allow-modals" className="min-h-0 w-full flex-1 border-0 bg-background" data-testid="ledger-frame" />
    </div>
  )
}
