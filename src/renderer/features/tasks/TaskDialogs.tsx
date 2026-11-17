import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Lock, Send, Trash2, Play, CheckCheck, RotateCcw, ThumbsUp, Check, Undo2 } from 'lucide-react'
import { Dialog } from '@renderer/components/Dialog'
import { Button } from '@renderer/components/ui/button'
import { Input, Select, Textarea } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Editor, RichView } from '@renderer/components/Editor'
import { AttachmentInput, AttachmentList, type Att } from '@renderer/components/Attachments'
import { Comments } from '@renderer/components/Comments'
import { MemberPicker, ScopeTags } from '@renderer/components/ScopePicker'
import { Field } from '@renderer/features/setup/SetupFrame'
import { api, errorMessage } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { fromInputValue, toInputValue } from '@renderer/lib/dates'
import { useMe } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import { useSpace } from '@renderer/app/space-store'
import { MAX_TASK_ASSIGNEES, PRIORITY_LABEL, TASK_STATE_LABEL, canTransition, isTaskAssignee, taskProgress, type TaskDto, type TaskState } from '@shared/schemas/work'
import type { PersonalTaskDto } from '@shared/schemas/personal'
import { cn } from '@renderer/lib/utils'

function refreshAll(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: ['tasks'] })
  void qc.invalidateQueries({ queryKey: ['local', 'tasks'] })
}

export function NewTaskDialog({ onClose, personal: initialPersonal }: { onClose: () => void; personal?: boolean }): React.JSX.Element {
  const qc = useQueryClient()
  const online = useConn((s) => s.state === 'online')
  const space = useSpace((s) => s.space)
  const [personal, setPersonal] = useState(initialPersonal ?? !online)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [note, setNote] = useState('')
  const [assignees, setAssignees] = useState<string[]>([])
  const [each, setEach] = useState(false)
  const [due, setDue] = useState('')
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal')
  const [atts, setAtts] = useState<Att[]>([])
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: async () => {
      const dueAt = due ? fromInputValue(due) : null
      if (personal) await invoke('local:tasks.save', { title, note, dueAt, priority })
      else
        await api.post('/api/tasks', {
          title,
          bodyHtml: body,
          // assigneeId is what a server older than this client reads.
          assigneeId: assignees[0],
          assigneeIds: assignees,
          doneMode: each && assignees.length > 1 ? 'each' : 'any',
          dueAt,
          priority,
          attachmentIds: atts.map((a) => a.id),
          scope: space === 'team' ? undefined : { type: 'group', groupIds: [space], memberIds: [] }
        })
    },
    onSuccess: () => {
      refreshAll(qc)
      onClose()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title={personal ? '새 할 일' : '업무 요청'}
      width="max-w-2xl"
      footer={
        <Button onClick={() => save.mutate()} disabled={!title.trim() || (!personal && (!assignees.length || assignees.length > MAX_TASK_ASSIGNEES)) || save.isPending}>
          <Send /> {personal ? '저장' : '요청 보내기'}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="종류">
          <button type="button" role="radio" aria-checked={personal} onClick={() => setPersonal(true)} className={cn('cursor-pointer rounded-md border-2 px-3 py-2 text-left', personal ? 'border-primary bg-primary/5' : 'border-border')}>
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <Lock className="size-4" /> 개인 할 일
            </div>
            <div className="text-xs text-muted-foreground">내 PC에만 저장</div>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!personal}
            disabled={!online}
            onClick={() => setPersonal(false)}
            className={cn('cursor-pointer rounded-md border-2 px-3 py-2 text-left disabled:opacity-50', !personal ? 'border-primary bg-primary/5' : 'border-border')}
          >
            <div className="text-sm font-semibold">업무 요청</div>
            <div className="text-xs text-muted-foreground">팀원(또는 나)에게 담당 지정 · 여러 명 가능</div>
          </button>
        </div>
        <Field label="제목">
          <Input aria-label="할 일 제목" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        {!personal && (
          <Field label={`담당자${assignees.length ? ` (${assignees.length}명)` : ''}`}>
            <div data-testid="task-assignees">
              <MemberPicker value={assignees} onChange={setAssignees} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">한 명 이상 고릅니다. 나 자신도 고를 수 있습니다.</p>
            {assignees.length > 1 && (
              <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={each} onChange={(e) => setEach(e.target.checked)} aria-label="담당자마다 각자 완료" />
                <span>
                  담당자마다 각자 완료 표시
                  <span className="block text-xs text-muted-foreground">
                    {each ? '각자 자기 몫을 완료로 표시하고, 모두 끝나야 업무가 완료됩니다(예: 전원 제출·전원 확인).' : '끄면 업무 하나를 함께 맡아, 담당자 누구나 시작·완료를 누를 수 있습니다.'}
                  </span>
                </span>
              </label>
            )}
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="마감">
            <Input aria-label="마감" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
          <Field label="우선순위">
            <Select aria-label="우선순위" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
              <option value="high">높음</option>
              <option value="normal">보통</option>
              <option value="low">낮음</option>
            </Select>
          </Field>
        </div>
        {personal ? (
          <Field label="메모">
            <Textarea aria-label="메모" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        ) : (
          <>
            <Field label="내용">
              <Editor value={body} onChange={setBody} minHeight={100} />
            </Field>
            <AttachmentInput value={atts} onChange={setAtts} />
            <p className="text-xs text-muted-foreground">요청한 사람과 담당자 모두에게 보입니다{space !== 'team' ? ' (지금 고른 그룹 구성원에게도 보입니다)' : ''}.</p>
          </>
        )}
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}

const NEXT: { to: TaskState; label: string; icon: typeof Play }[] = [
  { to: 'doing', label: '시작', icon: Play },
  { to: 'done', label: '완료', icon: CheckCheck },
  { to: 'confirmed', label: '확인', icon: ThumbsUp },
  { to: 'requested', label: '요청 상태로', icon: RotateCcw }
]

export function stateBadge(s: TaskState): React.JSX.Element {
  const v = s === 'requested' ? 'important' : s === 'doing' ? 'default' : s === 'done' ? 'success' : 'muted'
  return <Badge variant={v}>{TASK_STATE_LABEL[s]}</Badge>
}

export function TaskDetailDialog({ id, onClose }: { id: string; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const { data: me } = useMe()
  const [err, setErr] = useState('')
  const q = useQuery({ queryKey: ['tasks', 'detail', id], queryFn: () => api.get<TaskDto & { attachments: Att[] }>(`/api/tasks/${id}`) })
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/tasks/${id}`, body),
    onSuccess: () => {
      setErr('')
      refreshAll(qc)
    },
    onError: (e) => setErr(errorMessage(e))
  })
  const del = useMutation({
    mutationFn: () => api.del(`/api/tasks/${id}`),
    onSuccess: () => {
      refreshAll(qc)
      onClose()
    }
  })
  const t = q.data
  if (!t) return <Dialog open onClose={onClose} title="업무">{q.error ? <p className="text-sm text-urgent">{errorMessage(q.error)}</p> : <p className="text-sm">불러오는 중…</p>}</Dialog>
  const role = { assignee: isTaskAssignee(t, me?.id), requester: t.requesterId === me?.id }
  const progress = taskProgress(t)
  const mine = t.assignees?.find((a) => a.id === me?.id)
  // each assignee finishes on their own: "완료" and taking it back are their own marks, not the task's state
  const next = NEXT.filter((n) => canTransition(t.state, n.to, role)).filter((n) => !progress || (n.to === 'doing' ? t.state === 'requested' || role.requester : n.to === 'confirmed' ? role.requester : n.to === 'requested' ? t.state === 'doing' && progress.done === 0 : false))
  const overdue = t.dueAt && t.dueAt < Date.now() && (t.state === 'requested' || t.state === 'doing')
  return (
    <Dialog open onClose={onClose} title={t.title} width="max-w-2xl">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {stateBadge(t.state)}
          <Badge variant={t.priority === 'high' ? 'urgent' : 'muted'}>우선순위 {PRIORITY_LABEL[t.priority]}</Badge>
          <span>
            {t.requesterName} → <b>{t.assigneeName}</b>
          </span>
          {t.dueAt && <span className={cn('text-muted-foreground', overdue && 'font-semibold text-urgent')}>마감 {format(t.dueAt, 'M/d HH:mm')}</span>}
          <ScopeTags scope={t.scope} />
        </div>
        <div className="flex flex-wrap gap-2" data-testid="task-actions">
          {next.map((n) => (
            <Button key={n.to} size="sm" variant={n.to === 'requested' ? 'outline' : 'default'} onClick={() => patch.mutate({ state: n.to })}>
              <n.icon /> {progress && n.to === 'doing' && t.state !== 'requested' ? '다시 진행(모두 다시)' : n.label}
            </Button>
          ))}
          {progress && mine && t.state !== 'confirmed' && (
            <Button size="sm" variant={mine.doneAt ? 'outline' : 'default'} onClick={() => patch.mutate({ myDone: !mine.doneAt })}>
              {mine.doneAt ? <Undo2 /> : <Check />} {mine.doneAt ? '내 완료 취소' : '내 몫 완료'}
            </Button>
          )}
          {(role.requester || me?.role === 'admin') && (
            <Button size="sm" variant="ghost" className="ml-auto text-urgent" onClick={() => window.confirm('이 업무 요청을 삭제할까요?') && del.mutate()}>
              <Trash2 /> 삭제
            </Button>
          )}
        </div>
        {progress && (
          <div className="rounded-md border border-border p-2 text-sm" data-testid="task-progress">
            <div className="mb-1 font-semibold">
              담당자별 완료 {progress.done}/{progress.total}
              <span className="ml-2 text-xs font-normal text-muted-foreground">모두 완료하면 업무가 완료됩니다</span>
            </div>
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {t.assignees.map((a) => (
                <li key={a.id} className={cn('flex items-center gap-1', !a.doneAt && 'text-muted-foreground')}>
                  {a.doneAt ? <Check className="size-3.5 text-success" /> : <span className="inline-block size-3.5 rounded-full border border-border" />}
                  {a.name}
                  {a.doneAt ? <span className="text-xs text-muted-foreground">{format(a.doneAt, 'M/d HH:mm')}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}
        {err && <p className="text-sm text-urgent">{err}</p>}
        <RichView html={t.bodyHtml || '<p class="text-muted-foreground">내용 없음</p>'} />
        <AttachmentList items={t.attachments} />
        <p className="text-xs text-muted-foreground">
          요청 {format(t.createdAt, 'M/d HH:mm')}
          {t.doneAt ? ` · 완료 ${format(t.doneAt, 'M/d HH:mm')}` : ''}
          {t.confirmedAt ? ` · 확인 ${format(t.confirmedAt, 'M/d HH:mm')}` : ''}
        </p>
        <Comments type="task" id={t.id} />
      </div>
    </Dialog>
  )
}

export function PersonalTaskDialog({ task, onClose }: { task: PersonalTaskDto; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const [title, setTitle] = useState(task.title)
  const [note, setNote] = useState(task.note)
  const [due, setDue] = useState(task.dueAt ? toInputValue(task.dueAt) : '')
  const [priority, setPriority] = useState(task.priority)
  const save = async (): Promise<void> => {
    await invoke('local:tasks.save', { id: task.id, title, note, dueAt: due ? fromInputValue(due) : null, priority })
    refreshAll(qc)
    onClose()
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="개인 할 일"
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto text-urgent"
            onClick={async () => {
              await invoke('local:tasks.delete', { id: task.id })
              refreshAll(qc)
              onClose()
            }}
          >
            <Trash2 /> 삭제
          </Button>
          <Button onClick={() => void save()} disabled={!title.trim()}>
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="flex items-center gap-1 text-xs text-personal">
          <Lock className="size-3" /> 내 PC에만 저장됩니다.
        </p>
        <Field label="제목">
          <Input aria-label="할 일 제목" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="마감">
            <Input aria-label="마감" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
          <Field label="우선순위">
            <Select aria-label="우선순위" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
              <option value="high">높음</option>
              <option value="normal">보통</option>
              <option value="low">낮음</option>
            </Select>
          </Field>
        </div>
        <Field label="메모">
          <Textarea aria-label="메모" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  )
}
