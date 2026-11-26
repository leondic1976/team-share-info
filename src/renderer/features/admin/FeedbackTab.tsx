import { EmptyNote } from '@renderer/components/EmptyState'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Send, Trash2 } from 'lucide-react'
import type { FeedbackAdminDto, FeedbackBundleDto, FeedbackItemDto, FeedbackItemState } from '@shared/schemas/feedback'
import { api, errorMessage } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Card } from '@renderer/components/ui/card'
import { cn } from '@renderer/lib/utils'
import { OwnerOnlyNote, useIsOwner } from './owner'

const ITEM_STATE: Record<FeedbackItemState, string> = { received: '접수됨', bundled: '묶음에 포함', uploaded: '전달됨' }
const when = (t: number): string => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const date = (t: number): string => new Date(t).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })

function bundleState(b: FeedbackBundleDto): { label: string; tone: string } {
  if (b.state === 'uploaded') return { label: b.issueNumber ? `전달됨 (${date(b.uploadedAt ?? b.createdAt)})` : `직접 전달함 (${date(b.uploadedAt ?? b.createdAt)})`, tone: 'text-success' }
  if (b.state === 'failed') return { label: `실패: ${b.lastError ?? '알 수 없는 이유'} (${b.tries}회 시도, 하루 한 번 다시 보냅니다)`, tone: 'text-urgent' }
  return { label: b.lastError ? `대기: ${b.lastError}` : '대기', tone: 'text-muted-foreground' }
}

/**
 * Admin: 기능요청·오류신고 the member PCs handed to this server, and the weekly bundles that go
 * to the developer. 서무 can read, open, remove and save; sending out is the 최종관리자's.
 */
export function FeedbackTab(): React.JSX.Element {
  const qc = useQueryClient()
  const owner = useIsOwner()
  const [open, setOpen] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const q = useQuery({ queryKey: ['admin', 'feedback'], queryFn: () => api.get<FeedbackAdminDto>('/api/admin/feedback'), refetchInterval: 30000 })
  const done = {
    onSettled: () => void qc.invalidateQueries({ queryKey: ['admin', 'feedback'] }),
    onError: (e: unknown) => setNote({ ok: false, text: errorMessage(e) })
  }
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/admin/feedback/items/${id}`), ...done, onSuccess: () => setNote(null) })
  const sendNow = useMutation({
    mutationFn: () => api.post<{ made: number; uploaded: number; failed: number; waiting: number; message: string }>('/api/admin/feedback/send-now'),
    ...done,
    onSuccess: (r) =>
      setNote({
        ok: r.failed === 0,
        text: [r.made ? `묶음 ${r.made}개를 만들었습니다.` : '', r.uploaded ? `${r.uploaded}개를 개발자에게 전달했습니다.` : '', r.waiting ? `${r.waiting}개가 대기 중입니다.` : '', r.message].filter(Boolean).join(' ') || '보낼 글이 없습니다.'
      })
  })
  const delivered = useMutation({ mutationFn: (id: string) => api.post(`/api/admin/feedback/bundles/${id}/delivered`), ...done, onSuccess: () => setNote(null) })

  const save = async (b: FeedbackBundleDto): Promise<void> => {
    try {
      const f = await api.get<{ name: string; text: string }>(`/api/admin/feedback/bundles/${b.id}/file`)
      const url = URL.createObjectURL(new Blob([f.text], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = f.name
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setNote({ ok: false, text: errorMessage(e) })
    }
  }

  const d = q.data
  const items: FeedbackItemDto[] = d?.items ?? []
  const waiting = items.filter((i) => i.state === 'received').length
  return (
    <div className="max-w-4xl space-y-4" data-testid="admin-feedback">
      <p className="text-sm text-muted-foreground">
        구성원이 [설정 → 기능요청 및 오류신고]에서 보낸 글이 이 서버 PC에 모입니다. 서버 PC가 주 1회 묶어 개발자에게 보내고, 확인을 통과한 글은 공개 게시판에 실립니다. 개발자에게 가는 묶음에는 기관·팀 이름, 구성원 정보, IP 주소가 들어가지 않습니다.
      </p>
      {d && !d.canUpload && (
        <OwnerOnlyNote>
          이 프로그램에는 보내기 기능이 아직 설정되지 않았습니다. 프로그램 관리자(배포 담당)가 한 번 설정하면 자동으로 보냅니다. 그때까지 묶음은 대기 상태로 남고, [파일로 저장]해서 개발자에게 직접 전달할 수 있습니다.
        </OwnerOnlyNote>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => window.confirm('지금까지 받은 글을 묶어 개발자에게 보낼까요?') && sendNow.mutate()} disabled={!owner || sendNow.isPending} title={owner ? undefined : '최종관리자(서버 PC)만 할 수 있습니다.'} data-testid="feedback-send-now">
          <Send /> 지금 묶어 보내기
        </Button>
        <span className="text-sm text-muted-foreground">
          대기 중인 글 {waiting}건{d?.nextBundleAt ? ` · 다음 묶음 ${date(d.nextBundleAt)} 이후` : ''}
        </span>
      </div>
      {note && (
        <p className={cn('text-sm', note.ok ? 'text-success' : 'text-urgent')} role="status">
          {note.text}
        </p>
      )}

      <div>
        <h3 className="mb-1 text-sm font-semibold">받은 글</h3>
        <Card className="hover-rows divide-y divide-border">
          {items.map((i) => (
            <div key={i.id} className="text-sm" data-testid="admin-feedback-item">
              <div className="flex items-center gap-3 px-4 py-1.5">
                <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-xs', i.kind === 'bug' ? 'bg-urgent/10 text-urgent' : 'bg-primary/10 text-primary')}>{i.kind === 'bug' ? '오류신고' : '기능요청'}</span>
                <button type="button" className="min-w-0 flex-1 cursor-pointer truncate text-left hover:underline" aria-expanded={open === i.id} onClick={() => setOpen(open === i.id ? null : i.id)}>
                  {i.title}
                </button>
                <span className="shrink-0 text-xs text-muted-foreground">{i.memberName}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{when(i.receivedAt)}</span>
                <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{ITEM_STATE[i.state]}</span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`${i.title} 삭제`}
                  disabled={i.state !== 'received'}
                  title={i.state === 'received' ? '지우면 개발자에게 보내지 않습니다.' : '이미 묶음에 들어간 글은 지울 수 없습니다.'}
                  onClick={() => window.confirm(`"${i.title}" 글을 지울까요? 지운 글은 개발자에게 보내지 않습니다.`) && del.mutate(i.id)}
                >
                  <Trash2 />
                </Button>
              </div>
              {open === i.id && (
                <div className="space-y-1 border-t border-border bg-muted/40 px-4 py-2">
                  <p className="selectable whitespace-pre-wrap break-words">{i.body}</p>
                  <p className="text-xs text-muted-foreground">
                    접수번호 {i.receipt} · 작성자 표시 {i.author || '익명'}
                  </p>
                </div>
              )}
            </div>
          ))}
          {d && items.length === 0 && <EmptyNote>받은 글이 없습니다.</EmptyNote>}
        </Card>
      </div>

      <div>
        <h3 className="mb-1 text-sm font-semibold">주간 묶음</h3>
        <Card className="hover-rows divide-y divide-border">
          {(d?.bundles ?? []).map((b) => {
            const s = bundleState(b)
            return (
              <div key={b.id} className="flex items-center gap-3 px-4 py-1.5 text-sm" data-testid="admin-feedback-bundle">
                <span className="w-32 shrink-0 text-muted-foreground">
                  {date(b.periodFrom)} ~ {date(b.periodTo)}
                </span>
                <span className="w-14 shrink-0">{b.itemCount}건</span>
                <span className={cn('min-w-0 flex-1 text-xs', s.tone)}>{s.label}</span>
                <Button size="sm" variant="outline" onClick={() => void save(b)}>
                  <Download /> 파일로 저장
                </Button>
                {b.state !== 'uploaded' && owner && (
                  <Button size="sm" variant="ghost" onClick={() => window.confirm('이 묶음을 파일로 개발자에게 직접 전달했나요? 전달함으로 표시하면 다시 보내지 않습니다.') && delivered.mutate(b.id)}>
                    직접 전달함
                  </Button>
                )}
              </div>
            )
          })}
          {d && d.bundles.length === 0 && <EmptyNote>아직 만든 묶음이 없습니다.</EmptyNote>}
        </Card>
      </div>
    </div>
  )
}
