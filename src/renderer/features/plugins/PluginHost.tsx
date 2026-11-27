import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { InstalledPlugin, PluginRoomDto } from '@shared/schemas/plugins'
import type { DepartmentDto } from '@shared/schemas/org'
import type { DutyBoardDto } from '@shared/schemas/duty'
import { absenceRange, bridgeRefusal, orderedDepartments, pluginAbsences } from '@shared/plugin-bridge'
import type { MemberDto } from '@shared/schemas/auth'
import type { UnregisteredDto } from '@shared/schemas/unregistered'
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
import { coreManifest, isCorePlugin } from '@shared/corePlugins'

type Msg = { th: 1; id: string; method: string; params: Record<string, unknown> | null }

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
  // part of the program (식사 신청): nothing to install or switch on
  if (isCorePlugin(id)) return <PluginHost fixedId={id} />
  return <InstalledMenuPlugin id={id} />
}

function InstalledMenuPlugin({ id }: { id: string }): React.JSX.Element {
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
  const core = isCorePlugin(id)
  const [coreEntry] = useState<InstalledPlugin | null>(() => (core ? { manifest: coreManifest(id), installedAt: 0, source: 'builtin', enabled: true } : null))
  const plugin: InstalledPlugin | undefined = coreEntry ?? list.data?.find((p) => p.manifest.id === id)
  const [src, setSrc] = useState('')
  const room = params.get('room')
  // a screen that never asks the host for anything did not start (a file that did not load, an
  // error before its first call): say so and offer to load it again instead of a blank page
  const heard = useRef(false)
  const [stuck, setStuck] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!src) return
    heard.current = false
    setStuck(false)
    const t = window.setTimeout(() => {
      if (!heard.current) setStuck(true)
    }, 20000)
    return () => window.clearTimeout(t)
  }, [src, reload])

  // opened on this PC: counted as using it (확장 기능 page, 지시 92); offline it is simply not counted
  const enabled = !!plugin?.enabled
  useEffect(() => {
    if (enabled && !core) void api.post(`/api/plugins/${encodeURIComponent(id)}/used`).catch(() => undefined)
  }, [enabled, id, core])

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
          // isOwner: this PC is the server PC (최종관리자), e.g. 식사 신청 shows it the statistics
          return me ? { id: me.id, name: me.name, deptName: me.deptName ?? null, isAdmin: me.role === 'admin', isOwner: !!me.isOwner } : null
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
          // the same kept list as the rest of the program: readable while the server PC is off.
          // orgSort: the place inside the department an admin set (0: none), for lists in 직제순
          return (await cachedRead(['members'], () => api.get<MemberDto[]>('/api/members')))
            .filter((x) => x.status === 'active')
            .map((x) => ({ id: x.id, name: x.name, deptId: x.deptId, deptName: x.deptName, title: x.title, presence: x.presence, orgSort: x.orgSort ?? 0 }))
        case 'departments':
          // the departments in the order of the org chart (설정 → 조직 관리): [{ id, name, path, order }]
          return orderedDepartments(await cachedRead(['members', 'departments'], () => api.get<DepartmentDto[]>('/api/departments')))
        case 'absences': {
          // 근무현황: who is away between two dates (both included, 100 days at most), active members
          // only, repeats expanded; just the reason and the time, not the place or the note
          const range = absenceRange(str('from', 10), str('to', 10))
          if ((me?.disabledFeatures ?? []).includes('duty')) return []
          const board = await cachedRead(['plugin', 'absences', range.from, range.to], () => api.get<DutyBoardDto>('/api/duty', { from: range.from, to: range.to }))
          return pluginAbsences(board.entries)
        }
        case 'unregistered':
          // 미등록 인원 (관리): everybody ever on the list - `gone` deleted, `as` merged into that member
          return (await cachedRead(['unregistered'], () => api.get<UnregisteredDto[]>('/api/unregistered'))).map((x) => ({
            id: x.id,
            name: x.name,
            dept: x.dept,
            title: x.title,
            memo: x.memo,
            at: x.updatedAt,
            by: x.createdBy,
            ...(x.deleted ? { gone: true } : {}),
            ...(x.mergedInto ? { as: x.mergedInto } : {})
          }))
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
      if (!heard.current) {
        heard.current = true
        setStuck(false)
      }
      const m = e.data as Msg
      if (!m || m.th !== 1 || typeof m.id !== 'string' || typeof m.method !== 'string') return
      const refused = bridgeRefusal(m.method, perms)
      if (refused) return post({ th: 1, id: m.id, error: refused })
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
    const offUnreg = realtime.on('unregistered.changed', () => {
      if (perms.has('members')) post({ th: 1, event: 'unregistered.changed', data: {} })
    })
    // members, departments or their order changed (조직 관리): lists in 직제순 follow
    const offMember = realtime.on('member.changed', () => {
      if (perms.has('members')) post({ th: 1, event: 'members.changed', data: {} })
    })
    // an absence of 근무현황 (or another calendar event) changed: the frame reads its absences again
    const offAbsence = realtime.on('event.changed', () => {
      if (perms.has('duty')) post({ th: 1, event: 'absences.changed', data: {} })
    })
    return () => {
      window.removeEventListener('message', onMessage)
      offRoom()
      offUnreg()
      offMember()
      offAbsence()
    }
  }, [plugin, id, me, navigate])

  // 관리대장 used to be the plugin "ledger": old links and invitations land on the built-in screen
  if (id === 'ledger') return <Navigate to={`/ledger${room ? `?room=${room}` : ''}`} replace />
  // extensions with a menu of their own are opened there
  if (!fixedId && MENU_PLUGINS[id]) return <Navigate to={`${MENU_PLUGINS[id]}${room ? `?room=${room}` : ''}`} replace />
  if (!core && list.isFetched && !plugin)
    return <EmptyState icon={Puzzle} title="설치되지 않은 확장 기능입니다" action={<Button onClick={() => navigate(`/plugins?install=${id}`)}>확장 기능 화면으로</Button>} />
  if (plugin && !plugin.enabled) return <EmptyState icon={Puzzle} title={`${plugin.manifest.name}이(가) 꺼져 있습니다`} description="확장 기능 화면에서 켤 수 있습니다." />
  return (
    <div className="flex h-full flex-col">
      {stuck && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-important/10 px-5 py-2 text-sm" role="alert" data-testid="plugin-stuck">
          <span className="min-w-0 flex-1">{plugin?.manifest.name ?? '화면'}이(가) 열리지 않고 있습니다. 다시 불러오세요. 계속되면 서버 연결을 확인하거나 TeamHub를 다시 시작하세요.</span>
          <Button size="sm" variant="outline" onClick={() => setReload((n) => n + 1)}>
            다시 불러오기
          </Button>
        </div>
      )}
      {src && (
        <iframe
          ref={frame}
          key={`${src}#${reload}`}
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
