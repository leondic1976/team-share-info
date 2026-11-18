import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import type { DeviceDto, MemberDto } from '@shared/schemas/auth'
import { api, errorMessage } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { PresenceDot } from '@renderer/components/PresenceDot'
import { Loading } from '@renderer/components/EmptyState'
import { useConn } from '@renderer/app/conn-store'
import { DepartmentsCard } from './DepartmentsCard'
import { BanDialog, BlockedPcsCard, type BanTarget } from './PcBlock'
import { MemberEditDialog } from './MemberEditDialog'
import { displayName } from '@shared/schemas/auth'

export function MembersTab(): React.JSX.Element {
  const qc = useQueryClient()
  const myDevice = useConn((s) => s.deviceId)
  const [err, setErr] = useState('')
  const [ban, setBan] = useState<BanTarget | null>(null)
  const [editing, setEditing] = useState<MemberDto | null>(null)
  const members = useQuery({ queryKey: ['admin', 'members'], queryFn: () => api.get<MemberDto[]>('/api/admin/members') })
  const devices = useQuery({ queryKey: ['admin', 'devices'], queryFn: () => api.get<DeviceDto[]>('/api/admin/devices') })
  const done = {
    onSuccess: () => {
      setErr('')
      void qc.invalidateQueries({ queryKey: ['admin'] })
      void qc.invalidateQueries({ queryKey: ['members'] })
    },
    onError: (e: unknown) => setErr(errorMessage(e))
  }
  const patchMember = useMutation({ mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/api/admin/members/${id}`, body), ...done })
  const patchDevice = useMutation({ mutationFn: ({ id, action }: { id: string; action: string }) => api.patch(`/api/admin/devices/${id}`, { action }), ...done })

  if (members.isLoading || devices.isLoading) return <Loading />
  return (
    <div className="space-y-4">
      {err && <p className="text-sm text-urgent">{err}</p>}
      <Card>
        <CardHeader>
          <CardTitle>구성원 ({members.data?.length ?? 0})</CardTitle>
        </CardHeader>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2">이름</th>
              <th>부서·직위</th>
              <th>역할</th>
              <th>상태</th>
              <th className="w-64" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {members.data?.map((m) => (
              <tr key={m.id} data-testid={`member-row-${m.name}`}>
                <td className="px-4 py-2">
                  <span className="flex items-center gap-2">
                    <PresenceDot presence={m.presence} /> {displayName(m)}
                  </span>
                </td>
                <td className="text-muted-foreground">{[m.deptName, m.title].filter(Boolean).join(' · ')}</td>
                <td>{m.role === 'admin' ? <Badge>관리자</Badge> : <span className="text-muted-foreground">일반</span>}</td>
                <td>{m.status === 'active' ? <Badge variant="success">사용 중</Badge> : <Badge variant="urgent">중지</Badge>}</td>
                <td className="space-x-1 pr-4 text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(m)}>
                    정보 수정
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => patchMember.mutate({ id: m.id, body: { role: m.role === 'admin' ? 'member' : 'admin' } })}>
                    {m.role === 'admin' ? '관리자 해제' : '관리자 지정'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={m.status === 'active' ? 'text-urgent' : ''}
                    onClick={() => patchMember.mutate({ id: m.id, body: { status: m.status === 'active' ? 'suspended' : 'active' } })}
                  >
                    {m.status === 'active' ? '사용 중지' : '다시 사용'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <DepartmentsCard members={members.data ?? []} />

      <Card>
        <CardHeader>
          <CardTitle>승인된 PC ({devices.data?.length ?? 0})</CardTitle>
        </CardHeader>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2">구성원</th>
              <th>PC / 계정</th>
              <th>IP</th>
              <th>버전</th>
              <th>마지막 접속</th>
              <th className="w-56" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {devices.data?.map((d) => (
              <tr key={d.id} className={d.revokedAt ? 'opacity-60' : ''} data-testid={`device-row-${d.memberName}`}>
                <td className="px-4 py-2">
                  <span className="flex items-center gap-2">
                    <span className={`inline-block size-2 rounded-full ${d.online ? 'bg-success' : 'bg-muted-foreground/40'}`} />
                    {d.memberName}
                  </span>
                </td>
                <td className="text-muted-foreground">
                  {d.pcName} / {d.winUser}
                  {d.pcUid && <span className="ml-2 text-xs text-muted-foreground">고유값 {d.pcUid}</span>}
                </td>
                <td>
                  {d.lastIp ?? d.approvedIp}
                  {d.ipChanged && (
                    <Badge variant="important" className="ml-1" title={`승인 당시 ${d.approvedIp}`}>
                      IP 변경
                    </Badge>
                  )}
                </td>
                <td className="text-muted-foreground">{d.appVersion ?? '-'}</td>
                <td className="text-muted-foreground">{d.lastSeenAt ? format(d.lastSeenAt, 'M/d HH:mm') : '-'}</td>
                <td className="space-x-1 pr-4 text-right">
                  {d.ipChanged && (
                    <Button size="sm" variant="ghost" onClick={() => patchDevice.mutate({ id: d.id, action: 'accept-ip' })}>
                      새 IP 인정
                    </Button>
                  )}
                  {d.id !== myDevice &&
                    (d.revokedAt ? (
                      <Button size="sm" variant="ghost" title="이 PC가 이전 승인 그대로 다시 접속할 수 있게 합니다" onClick={() => patchDevice.mutate({ id: d.id, action: 'restore' })}>
                        차단 해제
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" className="text-urgent" title="접속을 끊습니다. 이 PC는 다시 사용 신청을 할 수 있습니다" onClick={() => patchDevice.mutate({ id: d.id, action: 'revoke' })}>
                        차단
                      </Button>
                    ))}
                  {d.id !== myDevice && !d.isServer && (
                    <Button size="sm" variant="ghost" className="text-urgent" title="다시 신청도 할 수 없게 막습니다" onClick={() => setBan({ deviceId: d.id, who: d.memberName, pc: `${d.pcName} / ${d.winUser}` })}>
                      영구 차단
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-4 py-2 text-xs text-muted-foreground">
          <b>차단</b>: 접속을 끊습니다. 그 PC는 다시 사용 신청을 할 수 있고, 승인하면 같은 계정으로 연결됩니다. <b>영구 차단</b>: 신청 자체를 받지 않습니다(아래 목록에서 해제할 때까지).
        </p>
      </Card>

      <BlockedPcsCard />
      {ban && <BanDialog target={ban} onClose={() => setBan(null)} />}
      {editing && <MemberEditDialog member={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
