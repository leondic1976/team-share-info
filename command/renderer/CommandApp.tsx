/**
 * 긴급구조지휘대: the module's screen (tabs 현황·편성·내 임무·훈련·공지·자료·설정) and its
 * alerts. The host renders <CommandApp/> at its route and <DrillPopup/>, <ControlRoomWindow/> in
 * windows of their own, all inside <CommandHostProvider>.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ClipboardList, FileText, Flag, LayoutDashboard, Megaphone, Settings as Gear, Siren, UserCheck } from 'lucide-react'
import type { CommandChangedPayload, CommandDrillPayload } from '../shared/events'
import type { Drill } from '../shared/types'
import { useCommandLive, useCommandState, useServerNow } from './data'
import { useHost } from './host'
import { buildModel } from './model'
import { Overview } from './Overview'
import { Roster } from './Roster'
import { MyDuty } from './MyDuty'
import { Drills } from './Drills'
import { DrillView, MeId } from './DrillView'
import { ControlRoom } from './ControlRoom'
import { Materials, Notices } from './Notices'
import { Settings } from './Settings'
import { Badge, EmptyState, PageHeader, Select, Tabs } from './ui'

type Tab = 'overview' | 'roster' | 'mine' | 'drills' | 'notices' | 'materials' | 'settings'
const MODE_KEY = 'command.mode'

export function CommandApp(): React.JSX.Element {
  const host = useHost()
  const nav = useNavigate()
  const loc = useLocation()
  useCommandLive()
  const q = useCommandState()
  const now = useServerNow(q.data?.serverNow, 30_000)
  const rest = loc.pathname.slice(host.basePath.length).split('/').filter(Boolean)
  const tab: Tab = rest[0] === 'drill' || rest[0] === 'control' ? 'drills' : ((rest[0] as Tab) ?? 'overview')
  const drillId = rest[0] === 'drill' ? rest[1] : null
  const controlId = rest[0] === 'control' ? rest[1] : null
  const go = (p: string): void => void nav(`${host.basePath}${p ? `/${p}` : ''}`)
  const m = useMemo(() => (q.data ? buildModel(q.data, now) : null), [q.data, now])
  const [modeId, setModeId] = useState(() => localStorage.getItem(MODE_KEY) ?? '')
  useEffect(() => {
    if (m && !m.modes.some((x) => x.id === modeId)) setModeId(m.modes[0]?.id ?? '')
  }, [m, modeId])
  const pickMode = (id: string): void => {
    setModeId(id)
    localStorage.setItem(MODE_KEY, id)
  }
  const header = (
    <PageHeader
      title={
        <span className="flex items-center gap-2 text-urgent">
          <Siren className="size-5" aria-hidden /> 긴급구조지휘대
        </span>
      }
      description="긴급구조통제단 및 긴급구조현장지휘대(지휘반)의 운영·훈련·연습·숙지를 위한 곳입니다."
      actions={m?.s.managers.length ? <span className="hidden text-xs text-muted-foreground md:inline">지휘대담당 {m.s.managers.map((x) => x.name).join(', ')}</span> : null}
    />
  )
  if (!m)
    return (
      <div className="flex h-full flex-col" data-testid="command-page">
        {header}
        <EmptyState icon={Siren} title={q.isError ? '불러오지 못했습니다' : '불러오는 중…'} description={q.isError ? host.errorMessage(q.error) : undefined} />
      </div>
    )
  const manager = m.s.me.isManager
  const drillBadge = m.s.drills.reduce((s, d) => s + (d.state !== 'ended' ? d.pendingForMe : 0), 0)
  const showModes = tab === 'overview' || tab === 'roster' || tab === 'mine'
  return (
    <MeId.Provider value={m.s.me.id}>
      <div className="flex h-full flex-col" data-testid="command-page">
        {header}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-2">
          <Tabs
            value={tab}
            onChange={(t) => go(t === 'overview' ? '' : t)}
            items={[
              { key: 'overview', label: '현황', icon: LayoutDashboard },
              { key: 'roster', label: '편성', icon: ClipboardList },
              { key: 'mine', label: '내 임무', icon: UserCheck },
              { key: 'drills', label: '훈련', icon: Flag, badge: drillBadge },
              { key: 'notices', label: '공지', icon: Megaphone, badge: m.s.unreadNotices },
              { key: 'materials', label: '자료', icon: FileText },
              { key: 'settings', label: '설정', icon: Gear, hidden: !manager }
            ]}
          />
          {showModes && (
            <label className="ml-auto flex items-center gap-2 text-sm">
              <span className="whitespace-nowrap text-muted-foreground">근무 유형</span>
              <Select className="h-8 w-52" value={modeId} onChange={(e) => pickMode(e.target.value)} aria-label="근무 유형" data-testid="cmd-mode">
                {m.modes.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {manager && !showModes && <Badge tone="primary" className="ml-auto">{m.s.me.isOwner ? '서버 PC' : '지휘대담당'}</Badge>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tab === 'overview' && <Overview m={m} modeId={modeId} now={now} onOpenDrill={(id) => go(id ? `drill/${id}` : 'drills')} />}
          {tab === 'roster' && <Roster m={m} modeId={modeId} now={now} />}
          {tab === 'mine' && <MyDuty m={m} modeId={modeId} now={now} />}
          {tab === 'drills' && (controlId ? <ControlRoom m={m} id={controlId} /> : drillId ? <DrillView m={m} id={drillId} onBack={() => go('drills')} /> : <Drills m={m} now={now} onOpen={(id) => go(`drill/${id}`)} />)}
          {tab === 'notices' && <Notices manager={manager} />}
          {tab === 'materials' && <Materials manager={manager} />}
          {tab === 'settings' && manager && <Settings m={m} now={now} />}
        </div>
      </div>
    </MeId.Provider>
  )
}

/** The 훈련 통제실 in a window of its own (big, for a second screen). */
export function ControlRoomWindow({ drillId }: { drillId: string }): React.JSX.Element {
  useCommandLive()
  const q = useCommandState()
  const now = useServerNow(q.data?.serverNow, 30_000)
  const m = useMemo(() => (q.data ? buildModel(q.data, now) : null), [q.data, now])
  if (!m) return <p className="p-6 text-sm text-muted-foreground">불러오는 중…</p>
  return (
    <MeId.Provider value={m.s.me.id}>
      <div className="h-screen overflow-y-auto bg-background p-4" data-testid="control-window">
        <ControlRoom m={m} id={drillId} />
      </div>
    </MeId.Provider>
  )
}

/**
 * Runs in the host's main window all the time: the 훈련 창 pops up for a participant when a drill
 * starts or a message comes, and a new 지휘대 공지 comes as an alert card.
 */
export function useCommandAlerts(meId: string | null, enabled: boolean): void {
  const host = useHost()
  const opened = useRef(new Set<string>())
  useEffect(() => {
    if (!meId || !enabled) return
    const offDrill = host.on('command.drill', (raw) => {
      const p = raw as CommandDrillPayload
      const wanted = (p.kind === 'message' && p.popup) || p.kind === 'remind' || (p.kind === 'state' && p.state === 'running' && p.popup)
      if (!wanted) return
      void host.api
        .get<Drill>(`/api/command/drills/${p.drillId}`)
        .then((d) => {
          if (!d.members.some((x) => x.memberId === meId)) return
          opened.current.add(d.id)
          host.openDrillWindow(d.id)
        })
        .catch(() => undefined)
    })
    const offNotice = host.on('command.changed', (raw) => {
      const p = raw as CommandChangedPayload
      if (p.what !== 'notice' || !p.id || !p.title || p.byId === meId) return
      host.alert({ key: `cmd-notice:${p.id}`, title: `[지휘대 공지] ${p.title}`, body: p.by ? `${p.by} · 긴급구조지휘대 공지` : '긴급구조지휘대 공지', route: `${host.basePath}/notices` })
    })
    return () => {
      offDrill()
      offNotice()
    }
  }, [host, meId, enabled])
}
