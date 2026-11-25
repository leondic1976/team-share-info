import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Users, Megaphone, UsersRound, ChevronUp, ChevronDown, EyeOff, Eye, LayoutGrid } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { PresenceDot, PRESENCE_LABEL } from '@renderer/components/PresenceDot'
import { MemberLink } from '@renderer/components/MemberLink'
import { displayName } from '@shared/schemas/auth'
import { Loading, OfflineState, EmptyNote } from '@renderer/components/EmptyState'
import { ScopeTags } from '@renderer/components/ScopePicker'
import { useMembers, useMe } from '@renderer/lib/queries'
import { api } from '@renderer/lib/api'
import { useConn } from '@renderer/app/conn-store'
import { usePrefs } from '@renderer/app/prefs-store'
import { useSpace } from '@renderer/app/space-store'
import type { NoticeSummaryDto } from '@shared/schemas/notices'
import type { GroupInviteDto } from '@shared/schemas/scope'
import { LevelBadge } from '@renderer/features/notices/NoticesPage'
import { cn } from '@renderer/lib/utils'
import type { DocSummaryDto } from '@shared/schemas/docs'
import { BookOpen } from 'lucide-react'
import { FavoritesWidget, TodayWorkWidget } from '@renderer/features/memos/widgets'
import { LiveMeetingsWidget } from '@renderer/features/meetings/MeetingsPage'
import { affiliationText } from '@shared/org'
import { RoleMark } from '@renderer/components/RoleMark'
import { byPresence } from '@shared/presence'

function Widget({ title, icon: Icon, right, children, testId }: { title: string; icon: typeof Users; right?: ReactNode; children: ReactNode; testId?: string }): React.JSX.Element {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Icon className="size-4" /> {title}
        </CardTitle>
        {right}
      </CardHeader>
      <CardContent className="max-h-80 overflow-y-auto p-2">{children}</CardContent>
    </Card>
  )
}

export function PresenceWidget(): React.JSX.Element {
  const online = useConn((s) => s.state === 'online')
  const { data, isLoading } = useMembers()
  const list = [...(data ?? [])].sort((a, b) => byPresence(a, b) || a.name.localeCompare(b.name))
  const onlineCount = list.filter((m) => m.presence === 'online' || m.presence === 'away').length
  return (
    <Widget title="팀원 현황" icon={Users} right={<span className="text-xs text-muted-foreground">접속 {onlineCount} / {list.length}</span>}>
      {!online && !data ? (
        <OfflineState />
      ) : isLoading ? (
        <Loading />
      ) : (
        <div className="space-y-0.5" data-testid="presence-list">
          {list.map((m) => (
            <div key={m.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted" data-testid={`presence-${m.name}`} data-presence={m.presence}>
              <PresenceDot presence={m.presence} />
              <MemberLink memberId={m.id} name={m.name} className="font-medium">
                {displayName(m)}
              </MemberLink>
              <span className="truncate text-xs text-muted-foreground" title={affiliationText(m) || undefined}>
                {[m.deptName, m.title].filter(Boolean).join(' · ')}
              </span>
              <span className="ml-auto truncate text-xs text-muted-foreground">{m.statusMessage || PRESENCE_LABEL[m.presence]}</span>
            </div>
          ))}
        </div>
      )}
    </Widget>
  )
}

function NoticesWidget(): React.JSX.Element {
  const navigate = useNavigate()
  const online = useConn((s) => s.state === 'online')
  const space = useSpace((s) => s.space)
  const q = useQuery({
    queryKey: ['notices', 'list', 'all', space],
    queryFn: () => api.get<NoticeSummaryDto[]>('/api/notices', { filter: 'all', groupId: space === 'team' ? undefined : space }),
    enabled: online,
    placeholderData: (p) => p
  })
  const list = (q.data ?? []).slice(0, 8)
  const unread = (q.data ?? []).filter((n) => n.my && !n.my.readAt).length
  return (
    <Widget
      title="공지"
      icon={Megaphone}
      testId="widget-notices"
      right={
        <Button size="sm" variant="ghost" onClick={() => navigate('/notices')}>
          {unread > 0 ? `안 읽음 ${unread}` : '전체 보기'}
        </Button>
      }
    >
      {!online && !q.data ? (
        <OfflineState />
      ) : !list.length ? (
        <EmptyNote>공지가 없습니다.</EmptyNote>
      ) : (
        list.map((n) => {
          const un = !!n.my && !n.my.readAt
          const needAck = !!n.my && n.requireAck && !n.my.ackedAt
          return (
            <button key={n.id} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => navigate(`/notices/${n.id}`)}>
              {un && <span className="size-2 shrink-0 rounded-full bg-primary" />}
              <LevelBadge level={n.level} />
              <span className={cn('truncate', un && 'font-bold')}>{n.title}</span>
              {needAck && <span className="shrink-0 text-xs font-semibold text-urgent">확인 필요</span>}
              <span className="ml-auto shrink-0">
                <ScopeTags scope={n.scope} />
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{format(n.publishedAt ?? n.publishAt, 'M/d')}</span>
            </button>
          )
        })
      )}
    </Widget>
  )
}

function InvitesWidget(): React.JSX.Element | null {
  const navigate = useNavigate()
  const online = useConn((s) => s.state === 'online')
  const q = useQuery({ queryKey: ['groups', 'invites'], queryFn: () => api.get<GroupInviteDto[]>('/api/group-invites'), enabled: online })
  if (!q.data?.length) return null
  return (
    <Widget title="그룹 초대·가입 신청" icon={UsersRound}>
      {q.data.map((i) => (
        <button key={i.id} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => navigate('/groups')}>
          <span className="size-2.5 rounded-full" style={{ background: i.groupColor }} />
          {i.kind === 'invite' ? `${i.groupName} 그룹 초대` : `${i.memberName}님의 ${i.groupName} 가입 신청`}
        </button>
      ))}
    </Widget>
  )
}

function MustReadWidget(): React.JSX.Element | null {
  const navigate = useNavigate()
  const online = useConn((s) => s.state === 'online')
  const q = useQuery({ queryKey: ['docs', 'unread'], queryFn: () => api.get<DocSummaryDto[]>('/api/docs', { unread: true }), enabled: online })
  if (!q.data?.length) return null
  return (
    <Widget title="읽어야 할 필독 문서" icon={BookOpen} testId="widget-mustread">
      {q.data.map((d) => (
        <button key={d.id} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => navigate(`/docs/mustread/${d.id}`)}>
          <span className="size-2 rounded-full bg-urgent" />
          <span className="truncate font-semibold">{d.title}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {d.authorName}
            <RoleMark memberId={d.authorId} />
          </span>
        </button>
      ))}
    </Widget>
  )
}

/** Registry of home widgets; later stages add schedule, tasks, memos... */
export const WIDGETS: { key: string; label: string; render: () => React.JSX.Element | null }[] = [
  { key: 'meetings', label: '진행 중인 회의', render: () => <LiveMeetingsWidget /> },
  { key: 'mustread', label: '필독 문서', render: () => <MustReadWidget /> },
  { key: 'todaywork', label: '오늘의 업무', render: () => <TodayWorkWidget /> },
  { key: 'notices', label: '공지', render: () => <NoticesWidget /> },
  { key: 'invites', label: '그룹 초대', render: () => <InvitesWidget /> },
  { key: 'presence', label: '팀원 현황', render: () => <PresenceWidget /> },
  { key: 'favorites', label: '즐겨찾기', render: () => <FavoritesWidget /> }
]

export function registerWidget(w: (typeof WIDGETS)[number], index?: number): void {
  if (WIDGETS.some((x) => x.key === w.key)) return
  if (index === undefined) WIDGETS.push(w)
  else WIDGETS.splice(index, 0, w)
}

export function HomePage(): React.JSX.Element {
  const { data: me } = useMe()
  const { homeWidgets, hiddenWidgets, update } = usePrefs()
  const [editing, setEditing] = useState(false)
  const order = [...WIDGETS].sort((a, b) => {
    const ia = homeWidgets.indexOf(a.key)
    const ib = homeWidgets.indexOf(b.key)
    return (ia === -1 ? 999 + WIDGETS.indexOf(a) : ia) - (ib === -1 ? 999 + WIDGETS.indexOf(b) : ib)
  })
  const move = (key: string, dir: -1 | 1): void => {
    const keys = order.map((w) => w.key)
    const i = keys.indexOf(key)
    const j = i + dir
    if (j < 0 || j >= keys.length) return
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
    update({ homeWidgets: keys })
  }
  const toggle = (key: string): void => update({ hiddenWidgets: hiddenWidgets.includes(key) ? hiddenWidgets.filter((k) => k !== key) : [...hiddenWidgets, key] })
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="홈"
        description={me ? `${me.name}님, 안녕하세요. 오늘은 ${format(new Date(), 'M월 d일')}입니다.` : undefined}
        actions={
          <Button size="sm" variant={editing ? 'default' : 'outline'} onClick={() => setEditing(!editing)}>
            <LayoutGrid /> {editing ? '편집 완료' : '위젯 편집'}
          </Button>
        }
      />
      <div className="flex-1 overflow-y-auto p-5">
        {editing && (
          <Card className="mb-4">
            <CardContent className="space-y-1">
              <p className="mb-2 text-xs text-muted-foreground">순서를 바꾸거나 숨길 위젯을 고르세요. 이 PC에 저장됩니다.</p>
              {order.map((w, i) => (
                <div key={w.key} className="flex items-center gap-2 text-sm">
                  <span className={cn('flex-1', hiddenWidgets.includes(w.key) && 'text-muted-foreground line-through')}>{w.label}</span>
                  <Button size="icon-sm" variant="ghost" aria-label={`${w.label} 위로`} disabled={i === 0} onClick={() => move(w.key, -1)}>
                    <ChevronUp />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label={`${w.label} 아래로`} disabled={i === order.length - 1} onClick={() => move(w.key, 1)}>
                    <ChevronDown />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label={`${w.label} ${hiddenWidgets.includes(w.key) ? '보이기' : '숨기기'}`} onClick={() => toggle(w.key)}>
                    {hiddenWidgets.includes(w.key) ? <Eye /> : <EyeOff />}
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
        <div className="grid auto-rows-min gap-4 lg:grid-cols-2">
          {order
            .filter((w) => !hiddenWidgets.includes(w.key))
            .map((w) => (
              <div key={w.key} data-widget={w.key}>
                <w.render />
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
