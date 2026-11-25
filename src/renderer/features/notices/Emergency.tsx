import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Siren, Send } from 'lucide-react'
import type { NoticeSummaryDto } from '@shared/schemas/notices'
import { Dialog } from '@renderer/components/Dialog'
import { Button } from '@renderer/components/ui/button'
import { Input, Select, Textarea } from '@renderer/components/ui/input'
import { api, errorMessage } from '@renderer/lib/api'
import { useMe, useMembers } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import { confirmPii } from '@renderer/lib/pii'
import { cn } from '@renderer/lib/utils'

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** Plain text typed in a hurry -> the HTML body a notice has. */
export const textToHtml = (s: string): string =>
  s
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('')

/** May I send an emergency notice? (The server decides again when it is sent.) */
export function useCanSendEmergency(): boolean {
  const { data: me } = useMe()
  return me?.canSendUrgent ?? me?.role === 'admin'
}

/**
 * 긴급공지: for the rare moment something has to be on every screen at once (fire, evacuation,
 * a system going down). It is a notice of the 긴급 level sent to the whole team, so it is kept
 * in 공지 with who saw and confirmed it - but it is written here in a few seconds: a title, a
 * few words, send. Ordinary notices are written with 공지 쓰기.
 */
export function EmergencyDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const online = useConn((s) => s.state === 'online')
  const { data: members } = useMembers()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [ack, setAck] = useState(true)
  const [renotify, setRenotify] = useState('5')
  const [sure, setSure] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (open) {
      setTitle('')
      setBody('')
      setAck(true)
      setRenotify('5')
      setSure(false)
      setErr('')
    }
  }, [open])

  const total = members?.filter((m) => m.status === 'active').length
  const here = members?.filter((m) => m.status === 'active' && m.presence !== 'offline').length
  const send = useMutation({
    mutationFn: () =>
      api.post<NoticeSummaryDto>('/api/notices', {
        level: 'urgent',
        title: title.trim(),
        bodyHtml: textToHtml(body),
        scope: { type: 'team', groupIds: [], memberIds: [] },
        requireAck: ack,
        replyOptions: [],
        pinned: false,
        publishAt: null,
        expiresAt: null,
        renotifyMinutes: ack && renotify ? Number(renotify) : null,
        attachmentIds: []
      }),
    onSuccess: (n) => {
      void qc.invalidateQueries({ queryKey: ['notices'] })
      onClose()
      // straight to who has seen it
      navigate(`/notices/${n.id}`)
    },
    onError: (e) => {
      setErr(errorMessage(e))
      setSure(false)
    }
  })

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title={
        <span className="flex items-center gap-2 text-urgent">
          <Siren className="size-5" /> 긴급공지 보내기
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          {sure ? (
            <Button variant="destructive" onClick={() => send.mutate()} disabled={send.isPending} data-testid="emergency-confirm">
              <Send /> 지금 팀 전체 화면에 띄우기
            </Button>
          ) : (
            <Button variant="destructive" onClick={() => confirmPii([title, body], '팀 전체의 화면에 바로 나타나며,') && setSure(true)} disabled={!title.trim() || !online}>
              <Siren /> 긴급 발송
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <p className="rounded-md border border-urgent/40 bg-urgent/10 px-3 py-2 text-sm">
          <b className="text-urgent">아주 급할 때만 씁니다.</b> 보내는 즉시 팀 전체 PC의 화면 가운데에 빨간 창이 다른 창 위로 뜨고 경보음이 납니다. 꺼져 있는 PC는 켜는 즉시 받습니다. 평소 알릴 일은{' '}
          <b>공지 쓰기</b>를 쓰세요.
        </p>
        <div>
          <label className="mb-1 block text-sm font-semibold" htmlFor="em-title">
            무슨 일인가요? <span className="font-normal text-muted-foreground">(화면에 가장 크게 나옵니다)</span>
          </label>
          <Input id="em-title" aria-label="긴급공지 제목" autoFocus maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 3층 화재 발생 — 즉시 대피" className="h-11 text-base font-bold" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-semibold" htmlFor="em-body">
            어떻게 해야 하나요? <span className="font-normal text-muted-foreground">(선택)</span>
          </label>
          <Textarea id="em-body" aria-label="긴급공지 내용" rows={4} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="예: 엘리베이터를 타지 말고 동쪽 계단으로 1층 주차장에 모이세요." />
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 각자 <b>확인</b>을 눌러야 닫힘 (누가 확인했는지 기록)
          </label>
          {ack && (
            <label className="flex items-center gap-2">
              확인하지 않은 사람에게
              <Select aria-label="다시 알림 간격" value={renotify} onChange={(e) => setRenotify(e.target.value)} className="h-8 w-28">
                <option value="">다시 알리지 않음</option>
                <option value="3">3분마다</option>
                <option value="5">5분마다</option>
                <option value="10">10분마다</option>
              </Select>
              다시 알림
            </label>
          )}
        </div>
        <div className={cn('rounded-md border-2 px-3 py-2 text-sm', sure ? 'border-urgent bg-urgent/10' : 'border-border')} role="status">
          받는 사람: <b>팀 전체{total !== undefined ? ` ${total}명` : ''}</b>
          {here !== undefined && total !== undefined && <span className="text-muted-foreground"> · 지금 켜져 있는 PC {here}명, 나머지는 켜는 즉시</span>}
          {sure && <div className="mt-1 font-semibold text-urgent">되돌릴 수 없습니다. 내용을 확인하고 아래 빨간 단추를 한 번 더 누르세요.</div>}
        </div>
        {!online && <p className="text-sm font-semibold text-urgent">서버에 연결되어 있지 않아 긴급공지를 보낼 수 없습니다. 전화 등 다른 방법으로 알리세요.</p>}
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}
