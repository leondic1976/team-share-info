import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Ban, ShieldAlert } from 'lucide-react'
import type { BlockedPcDto } from '@shared/schemas/auth'
import { api, errorMessage } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Card, CardHeader, CardTitle } from '@renderer/components/ui/card'

export interface BanTarget {
  deviceId?: string
  requestId?: string
  /** Whose PC, and which one: shown in the question. */
  who: string
  pc: string
}

/**
 * Shutting a PC out for good is asked twice on purpose: the reason has to be written down
 * and the consequences confirmed. An ordinary block (차단) is the lighter choice.
 */
export function BanDialog({ target, onClose }: { target: BanTarget; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const [sure, setSure] = useState(false)
  const [err, setErr] = useState('')
  const ban = useMutation({
    mutationFn: () => api.post('/api/admin/blocked-pcs', { deviceId: target.deviceId, requestId: target.requestId, reason: reason.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] })
      void qc.invalidateQueries({ queryKey: ['members'] })
      onClose()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="PC 영구 차단">
      <div className="w-full max-w-md space-y-3 rounded-lg border border-border bg-card p-5 shadow-xl">
        <div className="flex items-center gap-2 text-base font-bold text-urgent">
          <ShieldAlert className="size-5" /> PC 영구 차단
        </div>
        <p className="text-sm">
          <b>{target.who}</b>의 PC <b>{target.pc}</b>를 영구 차단합니다.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>이 PC의 접속이 바로 끊기고, 이 PC에서는 <b className="text-foreground">사용 신청도 할 수 없습니다.</b></li>
          <li>프로그램을 다시 설치해도 풀리지 않습니다. 아래 <b className="text-foreground">영구 차단한 PC</b> 목록에서 해제해야 다시 신청할 수 있습니다.</li>
          <li>구성원 계정과 그 사람이 올린 자료는 지워지지 않습니다.</li>
          <li>잠깐 막으려는 것이라면 영구 차단 대신 <b className="text-foreground">차단</b>을 쓰세요(차단한 PC는 다시 신청할 수 있습니다).</li>
        </ul>
        <label className="block space-y-1">
          <span className="text-sm font-medium">차단 사유 (필수, 기록에 남습니다)</span>
          <Input aria-label="차단 사유" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="예: 퇴직자 PC, 분실, 무단 사용" autoFocus />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={sure} onChange={(e) => setSure(e.target.checked)} aria-label="영구 차단 확인" />
          위 내용을 확인했고, 이 PC를 영구 차단합니다.
        </label>
        {err && (
          <p className="text-sm text-urgent" role="alert">
            {err}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button className="bg-urgent text-white hover:bg-urgent/90" disabled={!sure || reason.trim().length < 2 || ban.isPending} onClick={() => ban.mutate()}>
            <Ban /> 영구 차단
          </Button>
        </div>
      </div>
    </div>
  )
}

/** The list of PCs shut out for good; taking one off lets it ask for access again. */
export function BlockedPcsCard(): React.JSX.Element {
  const qc = useQueryClient()
  const [err, setErr] = useState('')
  const q = useQuery({ queryKey: ['admin', 'blocked-pcs'], queryFn: () => api.get<BlockedPcDto[]>('/api/admin/blocked-pcs') })
  const unblock = useMutation({
    mutationFn: (id: string) => api.del(`/api/admin/blocked-pcs/${id}`),
    onSuccess: () => {
      setErr('')
      void qc.invalidateQueries({ queryKey: ['admin'] })
    },
    onError: (e) => setErr(errorMessage(e))
  })
  const list = q.data ?? []
  return (
    <Card data-testid="blocked-pcs">
      <CardHeader>
        <CardTitle>영구 차단한 PC ({list.length})</CardTitle>
        <span className="text-xs text-muted-foreground">해제하면 그 PC에서 다시 사용 신청을 할 수 있고, 승인하면 이전 계정으로 연결됩니다.</span>
      </CardHeader>
      {err && <p className="px-4 pb-2 text-sm text-urgent">{err}</p>}
      {list.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">영구 차단한 PC가 없습니다.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2">구성원</th>
              <th>PC / 계정</th>
              <th>사유</th>
              <th>차단한 날 · 사람</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.map((b) => (
              <tr key={b.id} data-testid="blocked-pc">
                <td className="px-4 py-2">{b.memberName ?? '-'}</td>
                <td className="text-muted-foreground">
                  {b.pcName} / {b.winUser}
                  {b.pcUid && <span className="ml-2 text-xs">고유값 {b.pcUid}</span>}
                </td>
                <td>{b.reason}</td>
                <td className="text-muted-foreground">
                  {format(b.createdAt, 'yyyy-M-d')} · {b.blockedByName ?? '-'}
                </td>
                <td className="pr-4 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (window.confirm(`${b.pcName} PC의 영구 차단을 해제할까요?\n해제하면 그 PC에서 다시 사용 신청을 할 수 있습니다(승인은 따로 해야 합니다).`)) unblock.mutate(b.id)
                    }}
                  >
                    차단 해제
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
