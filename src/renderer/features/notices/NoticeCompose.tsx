import { sendOrQueue } from '@renderer/lib/outbox'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Send, TriangleAlert } from 'lucide-react'
import { Dialog } from '@renderer/components/Dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Editor } from '@renderer/components/Editor'
import { ScopePicker, defaultScope, scopeIsValid } from '@renderer/components/ScopePicker'
import { AttachmentInput, type Att } from '@renderer/components/Attachments'
import { Field } from '@renderer/features/setup/SetupFrame'
import { errorMessage } from '@renderer/lib/api'
import { useSpace } from '@renderer/app/space-store'
import type { NoticeLevel, NoticeSummaryDto } from '@shared/schemas/notices'
import type { ScopeInput } from '@shared/schemas/scope'
import { cn } from '@renderer/lib/utils'
import { confirmPii } from '@renderer/lib/pii'
import { DateTimeInput } from '@renderer/components/DateTimeInput'

const LEVELS: { v: NoticeLevel; label: string; hint: string; cls: string }[] = [
  { v: 'normal', label: '일반', hint: '목록에만 표시', cls: 'border-border' },
  { v: 'important', label: '중요', hint: '알림 카드 + 소리', cls: 'border-important text-important' },
  { v: 'urgent', label: '긴급', hint: '화면 가운데 창 + 경보음', cls: 'border-urgent text-urgent' }
]

function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}

export function NoticeCompose({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const space = useSpace((s) => s.space)
  const [level, setLevel] = useState<NoticeLevel>('normal')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [scope, setScope] = useState<ScopeInput>(defaultScope(space))
  const [requireAck, setRequireAck] = useState(false)
  const [replies, setReplies] = useState('')
  const [pinned, setPinned] = useState(false)
  const [schedule, setSchedule] = useState('')
  const [expires, setExpires] = useState('')
  const [renotify, setRenotify] = useState('')
  const [atts, setAtts] = useState<Att[]>([])
  const [err, setErr] = useState('')

  const reset = (): void => {
    setLevel('normal')
    setTitle('')
    setBody('')
    setScope(defaultScope(space))
    setRequireAck(false)
    setReplies('')
    setPinned(false)
    setSchedule('')
    setExpires('')
    setRenotify('')
    setAtts([])
    setErr('')
  }

  const send = useMutation({
    mutationFn: () =>
      sendOrQueue<NoticeSummaryDto>({
        kind: 'notice',
        label: `공지: ${title.trim().slice(0, 60)}`,
        path: '/api/notices',
        body: {
          level,
          title,
          bodyHtml: body,
          scope,
          requireAck,
          replyOptions: requireAck
            ? replies
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean)
            : [],
          pinned,
          publishAt: schedule ? new Date(schedule).getTime() : null,
          expiresAt: expires ? new Date(expires).getTime() : null,
          renotifyMinutes: level === 'urgent' && renotify ? Number(renotify) : null,
          attachmentIds: atts.map((a) => a.id)
        }
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['notices'] })
      reset()
      onClose()
      // kept for later (server off): there is no notice to open yet
      if (!r.queued) onCreated(r.data.id)
    },
    onError: (e) => setErr(errorMessage(e))
  })

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="공지 쓰기"
      width="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button onClick={() => confirmPii([title, body], '공지를 받는 모든 사람이 보게 되며,') && send.mutate()} disabled={!title.trim() || !scopeIsValid(scope) || send.isPending} variant={level === 'urgent' ? 'destructive' : 'default'}>
            <Send /> {schedule ? '예약 발송' : level === 'urgent' ? '긴급 발송' : '게시'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="등급">
          <div className="flex gap-2" role="radiogroup" aria-label="등급">
            {LEVELS.map((l) => (
              <button
                key={l.v}
                type="button"
                role="radio"
                aria-checked={level === l.v}
                onClick={() => setLevel(l.v)}
                className={cn('flex-1 cursor-pointer rounded-md border-2 px-3 py-2 text-left', level === l.v ? l.cls + ' bg-muted' : 'border-border opacity-70')}
              >
                <div className="text-sm font-bold">{l.label}</div>
                <div className="text-xs text-muted-foreground">{l.hint}</div>
              </button>
            ))}
          </div>
        </Field>
        <Field label="받는 사람(공개 범위)">
          <ScopePicker value={scope} onChange={setScope} />
        </Field>
        <Field label="제목">
          <Input aria-label="제목" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <Field label="내용">
          <Editor value={body} onChange={setBody} />
        </Field>
        <AttachmentInput value={atts} onChange={setAtts} />
        <div className="grid gap-3 rounded-md bg-muted/50 p-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={requireAck} onChange={(e) => setRequireAck(e.target.checked)} /> 받는 사람의 "확인" 받기
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> 목록 맨 위에 고정
          </label>
          {requireAck && (
            <div className="sm:col-span-2">
              <Field label="회신 항목 (선택, 쉼표로 구분)" hint="예: 참석, 불참 — 비우면 [확인] 버튼만 표시">
                <Input aria-label="회신 항목" value={replies} onChange={(e) => setReplies(e.target.value)} />
              </Field>
            </div>
          )}
          <Field label="예약 발송 (선택)">
            <DateTimeInput label="예약 발송" clearable value={schedule} min={toLocalInput(Date.now())} onChange={setSchedule} />
          </Field>
          <Field label="만료 시각 (선택)">
            <DateTimeInput label="만료 시각" clearable defaultTime="18:00" value={expires} min={toLocalInput(Date.now())} onChange={setExpires} />
          </Field>
          {level === 'urgent' && (
            <Field label="자동 재알림 간격 (분, 선택)" hint="확인하지 않은 사람에게 이 간격으로 다시 띄웁니다.">
              <Input aria-label="자동 재알림 간격" value={renotify} onChange={(e) => setRenotify(e.target.value.replace(/\D/g, ''))} placeholder="예: 10" />
            </Field>
          )}
        </div>
        <p className="text-xs text-[var(--notice-fg)]"><TriangleAlert className="mr-1 inline size-3.5 align-[-0.15em]" aria-hidden />중요 보안 내용, 개인정보, 비공개 정보는 공유할 수 없습니다.</p>
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}
