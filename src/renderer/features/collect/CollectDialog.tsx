import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Save, Send, TriangleAlert } from 'lucide-react'
import { COLLECT_LIMITS, COLLECT_MODE_LABEL, type CollectDto, type CollectSubmitMode } from '@shared/schemas/collect'
import type { ScopeInput } from '@shared/schemas/scope'
import { Dialog } from '@renderer/components/Dialog'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { ScopePicker, defaultScope, scopeIsValid } from '@renderer/components/ScopePicker'
import { AttachmentInput, type Att } from '@renderer/components/Attachments'
import { DateTimeInput } from '@renderer/components/DateTimeInput'
import { Field } from '@renderer/features/setup/SetupFrame'
import { useSpace } from '@renderer/app/space-store'
import { api, errorMessage } from '@renderer/lib/api'
import { confirmPii } from '@renderer/lib/pii'
import { cn } from '@renderer/lib/utils'

function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}

/** Three working days from now at 18:00: a usual first guess for a deadline. */
function defaultDeadline(): string {
  const d = new Date()
  let added = 0
  while (added < 3) {
    d.setDate(d.getDate() + 1)
    if (d.getDay() !== 0 && d.getDay() !== 6) added++
  }
  d.setHours(18, 0, 0, 0)
  return toLocalInput(d.getTime())
}

const MODES: CollectSubmitMode[] = ['file', 'text', 'both']
const MODE_HINT: Record<CollectSubmitMode, string> = { file: '파일을 올려 제출', text: '내용을 적어 제출', both: '파일이나 글, 또는 둘 다' }

/** 새 요청 (no `edit`) or 고치기 of a request: who is asked and how they answer are fixed once it is sent. */
export function CollectDialog({ edit, onClose, onSaved }: { edit?: CollectDto; onClose: () => void; onSaved: (id: string) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const space = useSpace((s) => s.space)
  const [title, setTitle] = useState(edit?.title ?? '')
  const [description, setDescription] = useState(edit?.description ?? '')
  const [deadline, setDeadline] = useState(edit ? toLocalInput(edit.deadlineAt) : defaultDeadline())
  const [allowLate, setAllowLate] = useState(edit?.allowLate ?? true)
  const [mode, setMode] = useState<CollectSubmitMode>(edit?.submitMode ?? 'file')
  const [scope, setScope] = useState<ScopeInput>(defaultScope(space))
  const [forms, setForms] = useState<Att[]>(edit?.forms ?? [])
  const [err, setErr] = useState('')

  const save = useMutation({
    mutationFn: async (): Promise<string> => {
      const deadlineAt = new Date(deadline).getTime()
      const base = { title, description, deadlineAt, allowLate, attachmentIds: forms.map((f) => f.id) }
      if (edit) {
        await api.patch(`/api/collects/${edit.id}`, { ...base, ...(deadlineAt === edit.deadlineAt ? { deadlineAt: undefined } : {}) })
        return edit.id
      }
      return (await api.post<{ id: string }>('/api/collects', { ...base, submitMode: mode, scope })).id
    },
    onSuccess: (id) => {
      void qc.invalidateQueries({ queryKey: ['collect'] })
      onSaved(id)
    },
    onError: (e) => setErr(errorMessage(e))
  })

  const submit = (): void => {
    setErr('')
    if (!title.trim()) return setErr('제목을 입력하세요.')
    if (!deadline) return setErr('마감 일시를 정하세요.')
    const at = new Date(deadline).getTime()
    if ((!edit || at !== edit.deadlineAt) && at <= Date.now()) return setErr('마감 일시는 지금보다 뒤로 정하세요.')
    if (!edit && !scopeIsValid(scope)) return setErr('대상을 고르세요.')
    if (confirmPii([title, description], '요청을 받는 모든 사람이 보게 되며,')) save.mutate()
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={edit ? '자료 취합 요청 고치기' : '새 자료 취합 요청'}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {edit ? <Save /> : <Send />} {edit ? '저장' : '요청 보내기'}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="collect-dialog">
        <Field label="제목">
          <Input aria-label="제목" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={COLLECT_LIMITS.title} placeholder="예: 2027년 예산 요구서 제출" />
        </Field>
        <Field label="설명" hint="무엇을, 어떤 양식으로 내야 하는지 적습니다.">
          <Textarea aria-label="설명" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={COLLECT_LIMITS.description} placeholder="예: 첨부한 양식에 맞춰 담당별로 작성해 제출해 주세요." />
        </Field>
        <Field label="양식 파일 (선택)" hint="받는 사람이 내려받아 채워 낼 파일입니다.">
          <AttachmentInput value={forms} onChange={setForms} />
        </Field>
        {/* the date and the time lists on one line; the switch takes the rest */}
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-[auto_1fr]">
          <Field label="마감 일시">
            <DateTimeInput label="마감 일시" value={deadline} minuteStep={10} defaultTime="18:00" min={toLocalInput(Date.now())} onChange={setDeadline} />
          </Field>
          <Field label="마감 후 제출" hint={allowLate ? '마감이 지나도 받습니다(늦게 제출로 표시).' : '마감이 지나면 받지 않습니다.'}>
            <label className="flex h-9 items-center gap-2 text-sm">
              <Switch checked={allowLate} onCheckedChange={setAllowLate} label="마감 후 제출 허용" /> 마감 후 제출 허용
            </label>
          </Field>
        </div>
        {!edit && (
          <>
            <Field label="제출 방식">
              <div className="flex gap-2" role="radiogroup" aria-label="제출 방식">
                {MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => setMode(m)}
                    className={cn('flex-1 cursor-pointer rounded-md border px-3 py-2 text-left', mode === m ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted')}
                  >
                    <div className="text-sm font-semibold">{COLLECT_MODE_LABEL[m]}</div>
                    <div className="text-xs text-muted-foreground">{MODE_HINT[m]}</div>
                  </button>
                ))}
              </div>
            </Field>
            <Field label="대상" hint="고른 사람(그룹은 그 구성원)에게 알림 카드가 갑니다. 요청한 나는 대상에서 빠집니다.">
              <ScopePicker value={scope} onChange={setScope} />
            </Field>
          </>
        )}
        <p className="text-xs text-[var(--notice-fg)]">
          <TriangleAlert className="mr-1 inline size-3.5 align-[-0.15em]" aria-hidden />
          중요 보안 내용, 개인정보, 비공개 정보는 공유할 수 없습니다.
        </p>
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}
