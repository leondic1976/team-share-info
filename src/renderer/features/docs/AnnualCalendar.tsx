import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input, Select } from '@renderer/components/ui/input'
import { Card } from '@renderer/components/ui/card'
import { Dialog } from '@renderer/components/Dialog'
import { Editor, RichView } from '@renderer/components/Editor'
import { ScopePicker, ScopeTags, defaultScope, scopeIsValid } from '@renderer/components/ScopePicker'
import { Field } from '@renderer/features/setup/SetupFrame'
import { api, errorMessage } from '@renderer/lib/api'
import { useConn } from '@renderer/app/conn-store'
import { useSpace } from '@renderer/app/space-store'
import type { AnnualTaskDto } from '@shared/schemas/docs'
import type { ScopeInput } from '@shared/schemas/scope'
import { RoleMark } from '@renderer/components/RoleMark'

export function useAnnualTasks() {
  const online = useConn((s) => s.state === 'online')
  return useQuery({ queryKey: ['docs', 'annual'], queryFn: () => api.get<AnnualTaskDto[]>('/api/annual-tasks'), enabled: online, placeholderData: (p) => p })
}

function AnnualDialog({ edit, onClose }: { edit?: AnnualTaskDto; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const space = useSpace((s) => s.space)
  const [month, setMonth] = useState(edit?.month ?? new Date().getMonth() + 1)
  const [day, setDay] = useState<string>(edit?.day ? String(edit.day) : '')
  const [title, setTitle] = useState(edit?.title ?? '')
  const [body, setBody] = useState(edit?.bodyHtml ?? '')
  const [remind, setRemind] = useState(String(edit?.remindDaysBefore ?? 7))
  const [scope, setScope] = useState<ScopeInput>(edit ? { type: edit.scope.type, groupIds: edit.scope.groups.map((g) => g.id), memberIds: edit.scope.members.map((m) => m.id) } : defaultScope(space))
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: () => {
      const body2 = { month, day: day ? Number(day) : null, title, bodyHtml: body, remindDaysBefore: Number(remind) || 0, scope }
      return edit ? api.patch(`/api/annual-tasks/${edit.id}`, body2) : api.post('/api/annual-tasks', body2)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['docs', 'annual'] })
      onClose()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title={edit ? '연간 업무 고치기' : '연간 업무 추가'}
      footer={
        <Button onClick={() => save.mutate()} disabled={!title.trim() || !scopeIsValid(scope)}>
          저장
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="업무 이름">
          <Input aria-label="연간 업무 이름" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="월">
            <Select aria-label="월" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}월
                </option>
              ))}
            </Select>
          </Field>
          <Field label="일 (선택)" hint="비우면 그 달 전체">
            <Input aria-label="일" value={day} onChange={(e) => setDay(e.target.value.replace(/\D/g, '').slice(0, 2))} />
          </Field>
          <Field label="미리 알림 (일 전)">
            <Input aria-label="미리 알림" value={remind} onChange={(e) => setRemind(e.target.value.replace(/\D/g, ''))} />
          </Field>
        </div>
        <Field label="내용 (참고 사항, 근거, 지난해 자료 위치 등)">
          <Editor value={body} onChange={setBody} minHeight={100} />
        </Field>
        <Field label="공개 범위">
          <ScopePicker value={scope} onChange={setScope} />
        </Field>
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}

/** Recurring yearly work by month (6.11 연간 업무 달력). Also shown on the calendar with reminders. */
export function AnnualCalendar(): React.JSX.Element {
  const qc = useQueryClient()
  const q = useAnnualTasks()
  const [dialog, setDialog] = useState<null | { edit?: AnnualTaskDto }>(null)
  const [open, setOpen] = useState<AnnualTaskDto | null>(null)
  const now = new Date().getMonth() + 1
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">해마다 돌아오는 업무(예산, 감사, 행사, 보고 기한)를 정리합니다. 일정 달력에 표시되고 정한 날짜 전에 알림이 옵니다.</p>
        <Button className="ml-auto" onClick={() => setDialog({})}>
          <Plus /> 연간 업무 추가
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
          <Card key={m} className={m === now ? 'border-primary' : ''} data-testid={`annual-month-${m}`}>
            <div className="border-b border-border px-3 py-1.5 text-sm font-bold">{m}월</div>
            <div className="min-h-16 space-y-1 p-2">
              {(q.data ?? [])
                .filter((t) => t.month === m)
                .map((t) => (
                  <button key={t.id} className="flex w-full cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-muted" onClick={() => setOpen(t)}>
                    <span className="w-8 shrink-0 text-xs text-muted-foreground">{t.day ? `${t.day}일` : '중'}</span>
                    <span className="truncate">{t.title}</span>
                  </button>
                ))}
            </div>
          </Card>
        ))}
      </div>
      {dialog && <AnnualDialog edit={dialog.edit} onClose={() => setDialog(null)} />}
      {open && (
        <Dialog
          open
          onClose={() => setOpen(null)}
          title={`${open.month}월${open.day ? ` ${open.day}일` : ''} · ${open.title}`}
          footer={
            open.canEdit && (
              <>
                <Button
                  variant="ghost"
                  className="mr-auto text-urgent"
                  onClick={async () => {
                    await api.del(`/api/annual-tasks/${open.id}`)
                    void qc.invalidateQueries({ queryKey: ['docs', 'annual'] })
                    setOpen(null)
                  }}
                >
                  <Trash2 /> 삭제
                </Button>
                <Button
                  onClick={() => {
                    setDialog({ edit: open })
                    setOpen(null)
                  }}
                >
                  <Pencil /> 고치기
                </Button>
              </>
            )
          }
        >
          <div className="space-y-2 text-sm">
            <ScopeTags scope={open.scope} />
            <p className="text-muted-foreground">
              {open.remindDaysBefore}일 전 알림 · 등록 {open.authorName}
              <RoleMark memberId={open.authorId} />
            </p>
            <RichView html={open.bodyHtml || '<p>-</p>'} />
          </div>
        </Dialog>
      )}
    </div>
  )
}
