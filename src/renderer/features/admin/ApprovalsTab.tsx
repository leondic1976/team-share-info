import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, X, UserPlus } from 'lucide-react'
import { format } from 'date-fns'
import type { JoinRequestDto } from '@shared/schemas/auth'
import { api, errorMessage } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card } from '@renderer/components/ui/card'
import { EmptyState, ErrorState, Loading } from '@renderer/components/EmptyState'
import { useState } from 'react'

export function ApprovalsTab(): React.JSX.Element {
  const qc = useQueryClient()
  const [err, setErr] = useState('')
  const q = useQuery({ queryKey: ['admin', 'join-requests'], queryFn: () => api.get<JoinRequestDto[]>('/api/admin/join-requests') })
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' }) => api.patch(`/api/admin/join-requests/${id}`, { action }),
    onSuccess: () => {
      setErr('')
      void qc.invalidateQueries({ queryKey: ['admin'] })
      void qc.invalidateQueries({ queryKey: ['members'] })
    },
    onError: (e) => setErr(errorMessage(e))
  })

  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />
  const list = q.data ?? []
  if (!list.length)
    return <EmptyState icon={UserPlus} title="대기 중인 사용 신청이 없습니다" description="팀원이 TeamHub를 설치하고 이 서버 주소로 사용 신청을 하면 여기에 표시됩니다." />

  return (
    <div className="space-y-2">
      {err && <p className="text-sm text-urgent">{err}</p>}
      <Card className="divide-y divide-border">
        {list.map((r) => (
          <div key={r.id} className="flex items-center gap-4 px-4 py-3" data-testid="join-request">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{r.name}</span>
                <span className="text-sm text-muted-foreground">{[r.deptName, r.title, r.ext].filter(Boolean).join(' · ')}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                <span>
                  IP <b className="text-foreground">{r.ip}</b>
                </span>
                <span>PC {r.pcName}</span>
                <span>계정 {r.winUser}</span>
                <span>{format(r.createdAt, 'M/d HH:mm')}</span>
                {!r.inAllowedRange && <Badge variant="urgent">허용 대역 밖</Badge>}
              </div>
            </div>
            <Button size="sm" onClick={() => act.mutate({ id: r.id, action: 'approve' })} disabled={act.isPending}>
              <Check /> 승인
            </Button>
            <Button size="sm" variant="outline" onClick={() => act.mutate({ id: r.id, action: 'reject' })} disabled={act.isPending}>
              <X /> 거절
            </Button>
          </div>
        ))}
      </Card>
    </div>
  )
}
