import { useQuery } from '@tanstack/react-query'
import { format, formatDistanceToNow } from 'date-fns'
import { ko } from 'date-fns/locale'
import { api } from '@renderer/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Loading } from '@renderer/components/EmptyState'
import type { BackupHealth } from '@shared/schemas/settings'
import { BackupHealthNotice } from './BackupHealthNotice'

interface StatusDto {
  version: string
  startedAt: number
  dataDir: string
  connections: number
  onlineMembers: number
  members: number
  pendingJoins: number
  disk: { free: number; total: number } | null
  /** the 최종관리자 only (older servers: never) */
  backup?: BackupHealth
  recentErrors: { at: number; message: string }[]
}

const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(1)}GB`

export function StatusTab(): React.JSX.Element {
  const q = useQuery({ queryKey: ['admin', 'status'], queryFn: () => api.get<StatusDto>('/api/admin/status'), refetchInterval: 10000 })
  if (!q.data) return <Loading />
  const s = q.data
  const diskPct = s.disk ? Math.round((1 - s.disk.free / s.disk.total) * 100) : 0
  return (
    <div className="max-w-3xl space-y-4">
      <div className="grid grid-cols-4 gap-3">
        {[
          ['접속 중', `${s.onlineMembers} / ${s.members}명`],
          ['연결 수', String(s.connections)],
          ['승인 대기', `${s.pendingJoins}건`],
          ['디스크 사용', s.disk ? `${diskPct}%` : '-']
        ].map(([k, v]) => (
          <Card key={k}>
            <CardContent>
              <div className="text-xs text-muted-foreground">{k}</div>
              <div className="text-xl font-bold">{v}</div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="selectable grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <span className="text-muted-foreground">서버 버전</span>
          <span>v{s.version}</span>
          <span className="text-muted-foreground">실행 시작</span>
          <span>
            {format(s.startedAt, 'yyyy-MM-dd HH:mm')} ({formatDistanceToNow(s.startedAt, { locale: ko })} 전)
          </span>
          <span className="text-muted-foreground">데이터 폴더</span>
          <span className="break-all">{s.dataDir}</span>
          <span className="text-muted-foreground">디스크</span>
          <span>{s.disk ? `남은 공간 ${gb(s.disk.free)} / 전체 ${gb(s.disk.total)}` : '-'}</span>
          {s.backup && (
            <>
              <span className="text-muted-foreground">마지막 백업</span>
              <span data-testid="status-backup">
                {s.backup.lastAt ? `${format(s.backup.lastAt, 'yyyy-MM-dd HH:mm')} (${formatDistanceToNow(s.backup.lastAt, { locale: ko })} 전)` : '없음'}
                {s.backup.failed && <span className="ml-2 text-urgent">마지막 시도 실패</span>}
              </span>
              <span className="text-muted-foreground">백업 위치</span>
              <span className="break-all">
                {s.backup.root}
                {s.backup.sameDrive && <span className="ml-2 text-important">서버 자료와 같은 드라이브</span>}
              </span>
            </>
          )}
        </CardContent>
      </Card>
      {s.backup && <BackupHealthNotice health={s.backup} dataDir={s.dataDir} showOpen />}
      {diskPct >= 90 && <p className="rounded-md bg-urgent/10 px-3 py-2 text-sm text-urgent">디스크 사용량이 90%를 넘었습니다. 오래된 자료를 정리하거나 용량을 늘리세요.</p>}
      <Card>
        <CardHeader>
          <CardTitle>최근 오류</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {s.recentErrors.length === 0 ? (
            <p className="text-muted-foreground">오류가 없습니다.</p>
          ) : (
            s.recentErrors.map((e, i) => (
              <div key={i} className="selectable">
                <span className="text-muted-foreground">{format(e.at, 'M/d HH:mm:ss')}</span> {e.message}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

interface ActivityDto {
  id: string
  at: number
  memberName: string | null
  ip: string | null
  action: string
  targetType: string | null
  detail: unknown
}

const ACTION_LABEL: Record<string, string> = {
  'join.request': '사용 신청',
  'join.approve': '사용 승인',
  'join.auto-approve': '자동 승인',
  'join.reject': '사용 거절',
  'device.revoke': 'PC 사용 중지',
  'device.restore': 'PC 다시 허용',
  'device.accept-ip': '새 IP 인정',
  'member.update': '구성원 변경',
  'member.update.self': '내 정보 변경',
  'settings.update': '설정 변경',
  'release.publish': '새 버전 배포',
  'release.update': '배포 상태 변경'
}

export function ActivityTab(): React.JSX.Element {
  const q = useQuery({ queryKey: ['admin', 'activity'], queryFn: () => api.get<ActivityDto[]>('/api/admin/activity', { limit: 200 }) })
  if (!q.data) return <Loading />
  return (
    <Card>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2">시각</th>
            <th>사용자</th>
            <th>IP</th>
            <th>내용</th>
            <th>상세</th>
          </tr>
        </thead>
        <tbody className="selectable divide-y divide-border">
          {q.data.map((a) => (
            <tr key={a.id}>
              <td className="px-4 py-1.5 whitespace-nowrap text-muted-foreground">{format(a.at, 'M/d HH:mm:ss')}</td>
              <td>{a.memberName ?? '-'}</td>
              <td className="text-muted-foreground">{a.ip ?? '-'}</td>
              <td>{ACTION_LABEL[a.action] ?? a.action}</td>
              <td className="max-w-80 truncate text-xs text-muted-foreground">{a.detail ? JSON.stringify(a.detail) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
