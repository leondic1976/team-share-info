import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { CheckCircle2, Circle, Plus, Trash2, Users } from 'lucide-react'
import { MEMO_COLORS, type MemoColor, type SharedMemoDto } from '@shared/schemas/tools'
import type { ScopeInput } from '@shared/schemas/scope'
import { Button } from '@renderer/components/ui/button'
import { Label, Textarea } from '@renderer/components/ui/input'
import { Dialog, confirmDialog } from '@renderer/components/Dialog'
import { LinkedText } from '@renderer/components/LinkedText'
import { EmptyState, OfflineState } from '@renderer/components/EmptyState'
import { ScopePicker, ScopeTags, defaultScope, scopeIsValid } from '@renderer/components/ScopePicker'
import { sendOrQueue } from '@renderer/lib/outbox'
import { api, errorMessage } from '@renderer/lib/api'
import { useMe } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import { useSpace } from '@renderer/app/space-store'
import { cn } from '@renderer/lib/utils'
import { confirmPii } from '@renderer/lib/pii'
import type { PiiAck } from '@shared/pii'
import { ColorPicker } from '@renderer/features/memos/ColorPicker'
import { RoleMark } from '@renderer/components/RoleMark'

/** Shared memo board (6.12 ①): short messages to the team, a group or people. */
export function SharedMemosView(): React.JSX.Element {
  const qc = useQueryClient()
  const online = useConn((s) => s.state === 'online')
  const space = useSpace((s) => s.space)
  const { data: me } = useMe()
  const [open, setOpen] = useState(false)
  const q = useQuery({
    queryKey: ['shared-memos', space],
    queryFn: () => api.get<SharedMemoDto[]>('/api/shared-memos', { groupId: space === 'team' ? undefined : space }),
    enabled: online
  })
  const check = useMutation({
    mutationFn: (v: { id: string; checked: boolean }) => api.post(`/api/shared-memos/${v.id}/check`, { checked: v.checked }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['shared-memos'] })
  })
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/shared-memos/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['shared-memos'] })
  })
  if (!online && !q.data) return <OfflineState />
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mb-3 flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          팀·그룹·지정한 사람이 함께 보는 전달 메모판입니다(전화 메모 등). 받은 사람 중 누군가 확인하면 표시되고, 확인된 메모는 7일 뒤 목록에서 사라집니다.
        </p>
        <Button className="ml-auto shrink-0" size="sm" onClick={() => setOpen(true)}>
          <Plus /> 공유 메모 남기기
        </Button>
      </div>
      {!q.data?.length ? (
        <EmptyState icon={Users} title="공유 메모가 없습니다" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="shared-memos">
          {q.data.map((m) => (
            <div key={m.id} className={cn('flex flex-col rounded-md p-3 text-sm text-slate-900 shadow-sm', m.checkedAt && 'opacity-60')} style={{ background: MEMO_COLORS[m.color] }} data-testid="shared-memo">
              <p className="selectable flex-1 whitespace-pre-wrap break-words">
                <LinkedText text={m.body} className="text-primary" />
              </p>
              <div className="mt-2 flex items-center gap-1.5 text-xs text-slate-600">
                <span>
                  <span className="font-semibold">{m.authorName}</span>
                  <RoleMark memberId={m.authorId} />
                </span>
                <span>{format(m.createdAt, 'M/d HH:mm')}</span>
                <span className="ml-auto">
                  <ScopeTags scope={m.scope} />
                </span>
              </div>
              <div className="mt-2 flex items-center gap-1 border-t border-black/10 pt-2">
                <button className="flex cursor-pointer items-center gap-1 text-xs font-medium" onClick={() => check.mutate({ id: m.id, checked: !m.checkedAt })}>
                  {m.checkedAt ? <CheckCircle2 className="size-4 text-green-700" /> : <Circle className="size-4" />}
                  {m.checkedAt ? `${m.checkedByName} 확인 · ${format(m.checkedAt, 'M/d HH:mm')}` : '확인'}
                </button>
                {(m.authorId === me?.id || me?.role === 'admin') && (
                  <button className="ml-auto cursor-pointer rounded p-1 hover:bg-black/10" aria-label="공유 메모 삭제" onClick={() => confirmDialog('이 공유 메모를 지울까요?') && del.mutate(m.id)}>
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <SharedMemoDialog open={open} onClose={() => setOpen(false)} />
    </div>
  )
}

function SharedMemoDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const space = useSpace((s) => s.space)
  const [body, setBody] = useState('')
  const [color, setColor] = useState<MemoColor>('yellow')
  const [scope, setScope] = useState<ScopeInput>(defaultScope(space))
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: (pii: PiiAck) => sendOrQueue({ kind: 'shared-memo', label: `공유 메모: ${body.trim().slice(0, 60)}`, path: '/api/shared-memos', body: { body, color, scope, ...pii } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shared-memos'] })
      setBody('')
      onClose()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="공유 메모 남기기"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button disabled={!body.trim() || !scopeIsValid(scope) || save.isPending} onClick={() => {
              const pii = confirmPii([body], '공개 범위의 모든 사람이 보게 되며,')
              if (pii) save.mutate(pii)
            }}
          >
            남기기
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Textarea aria-label="공유 메모 내용" rows={5} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="예: ○○과 김주무관 전화 왔음. 회신 부탁 (010-…)" />
        <ColorPicker value={color} onChange={setColor} />
        <div>
          <Label>받는 사람(공개 범위)</Label>
          <ScopePicker value={scope} onChange={setScope} />
        </div>
        <p className="text-xs text-muted-foreground">중요 보안 내용, 개인정보, 비공개 정보는 공유할 수 없습니다.</p>
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}
