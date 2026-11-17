import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Plus, List, Columns3, Lock, MessageSquare, Paperclip } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { EmptyState } from '@renderer/components/EmptyState'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { useConn } from '@renderer/app/conn-store'
import { useSpace } from '@renderer/app/space-store'
import { assigneeLabel, taskProgress, type TaskDto, type TaskState } from '@shared/schemas/work'
import type { PersonalTaskDto } from '@shared/schemas/personal'
import { NewTaskDialog, PersonalTaskDialog, TaskDetailDialog, stateBadge } from './TaskDialogs'
import { cn } from '@renderer/lib/utils'

type Filter = 'received' | 'requested' | 'all' | 'personal'

/** Unified item: server task or personal (local) to-do (13.10 origin tag). */
type Item = ({ origin: 'server' } & TaskDto) | ({ origin: 'local'; state: TaskState } & PersonalTaskDto)

const COLUMNS: { state: TaskState; label: string }[] = [
  { state: 'requested', label: '요청·할 일' },
  { state: 'doing', label: '진행 중' },
  { state: 'done', label: '완료' },
  { state: 'confirmed', label: '확인' }
]

export function TasksPage(): React.JSX.Element {
  const qc = useQueryClient()
  const online = useConn((s) => s.state === 'online')
  const space = useSpace((s) => s.space)
  const [filter, setFilter] = useState<Filter>('received')
  const [view, setView] = useState<'list' | 'board'>('list')
  const [showDone, setShowDone] = useState(false)
  const [creating, setCreating] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)
  const [personalEdit, setPersonalEdit] = useState<PersonalTaskDto | null>(null)

  const server = useQuery({
    queryKey: ['tasks', 'list', filter, space],
    queryFn: () => api.get<TaskDto[]>('/api/tasks', { filter: filter === 'personal' ? 'received' : filter, groupId: space === 'team' ? undefined : space }),
    enabled: online && filter !== 'personal',
    placeholderData: (p) => p
  })
  const personal = useQuery({ queryKey: ['local', 'tasks'], queryFn: () => invoke('local:tasks.list', { includeDone: true }), networkMode: 'always' })

  const items: Item[] = useMemo(() => {
    const s: Item[] = filter === 'personal' ? [] : (server.data ?? []).map((t) => ({ ...t, origin: 'server' as const }))
    const p: Item[] = filter === 'received' || filter === 'personal' ? (personal.data ?? []).map((t) => ({ ...t, origin: 'local' as const, state: (t.doneAt ? 'done' : 'requested') as TaskState })) : []
    return [...s, ...p].sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
  }, [server.data, personal.data, filter])

  const visible = items.filter((i) => showDone || view === 'board' || (i.state !== 'confirmed' && !(i.origin === 'local' && i.doneAt)) )
  const toggleLocal = async (t: PersonalTaskDto): Promise<void> => {
    await invoke('local:tasks.setDone', { id: t.id, done: !t.doneAt })
    void qc.invalidateQueries({ queryKey: ['local', 'tasks'] })
  }
  const open = (i: Item): void => (i.origin === 'server' ? setDetail(i.id) : setPersonalEdit(i))

  const dueText = (i: Item): React.JSX.Element | null => {
    if (!i.dueAt) return null
    const late = i.dueAt < Date.now() && (i.origin === 'local' ? !i.doneAt : i.state === 'requested' || i.state === 'doing')
    return <span className={cn('text-xs', late ? 'font-semibold text-urgent' : 'text-muted-foreground')}>{format(i.dueAt, 'M/d HH:mm')}</span>
  }

  const card = (i: Item): React.JSX.Element => (
    <div key={`${i.origin}${i.id}`} className="cursor-pointer rounded-md border border-border bg-card p-2.5 text-sm shadow-sm hover:border-primary" onClick={() => open(i)} data-testid={`task-card-${i.title}`}>
      <div className="flex items-center gap-1.5">
        {i.origin === 'local' && <Lock className="size-3 shrink-0 text-personal" aria-label="개인 할 일" />}
        {i.priority === 'high' && <span className="size-2 shrink-0 rounded-full bg-urgent" title="우선순위 높음" />}
        <span className="truncate font-medium">{i.title}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        {i.origin === 'server' && <span>{filter === 'requested' ? `→ ${assigneeLabel(i)}` : i.requesterName}</span>}
        {i.origin === 'server' && taskProgress(i) && <span className="rounded bg-muted px-1">{taskProgress(i)!.done}/{taskProgress(i)!.total} 완료</span>}
        {dueText(i)}
        {i.origin === 'server' && i.commentCount > 0 && (
          <span className="flex items-center gap-0.5">
            <MessageSquare className="size-3" /> {i.commentCount}
          </span>
        )}
      </div>
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="할 일"
        description="🔒 개인 할 일은 내 PC에만, 업무 요청은 요청한 사람과 담당자에게 공유됩니다."
        actions={
          <>
            <div className="flex rounded-md border border-border">
              <Button size="icon-sm" variant={view === 'list' ? 'secondary' : 'ghost'} aria-label="목록 보기" onClick={() => setView('list')}>
                <List />
              </Button>
              <Button size="icon-sm" variant={view === 'board' ? 'secondary' : 'ghost'} aria-label="칸반 보기" onClick={() => setView('board')}>
                <Columns3 />
              </Button>
            </div>
            <Button onClick={() => setCreating(true)}>
              <Plus /> 새 할 일
            </Button>
          </>
        }
      />
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-5 py-2">
        {(
          [
            ['received', '내가 할 일'],
            ['requested', '내가 요청한 일'],
            ['all', '전체 업무'],
            ['personal', '개인 할 일만']
          ] as const
        ).map(([v, l]) => (
          <Button key={v} size="sm" variant={filter === v ? 'secondary' : 'ghost'} onClick={() => setFilter(v)}>
            {l}
          </Button>
        ))}
        {view === 'list' && (
          <label className="ml-auto flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> 끝난 일도 보기
          </label>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {view === 'board' ? (
          <div className="grid h-full min-w-[900px] grid-cols-4 gap-3">
            {COLUMNS.map((c) => {
              const col = visible.filter((i) => i.state === c.state)
              return (
                <div key={c.state} className="flex min-h-0 flex-col rounded-lg bg-muted/50 p-2" data-testid={`column-${c.state}`}>
                  <div className="mb-2 flex items-center gap-1.5 px-1 text-sm font-semibold">
                    {c.label} <Badge variant="muted">{col.length}</Badge>
                  </div>
                  <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">{col.map(card)}</div>
                </div>
              )
            })}
          </div>
        ) : !visible.length ? (
          <EmptyState title="할 일이 없습니다" description="[새 할 일]로 개인 할 일을 적거나 팀원에게 업무를 요청하세요." />
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {visible.map((i) => (
              <div key={`${i.origin}${i.id}`} className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-muted/60" onClick={() => open(i)} data-testid={`task-row-${i.title}`}>
                {i.origin === 'local' ? (
                  <input
                    type="checkbox"
                    aria-label={`${i.title} 완료`}
                    checked={!!i.doneAt}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => void toggleLocal(i)}
                  />
                ) : (
                  stateBadge(i.state)
                )}
                {i.origin === 'local' && <Lock className="size-3.5 text-personal" aria-label="개인 할 일" />}
                <span className={cn('truncate text-sm', i.origin === 'local' && i.doneAt && 'text-muted-foreground line-through')}>{i.title}</span>
                {i.priority === 'high' && <Badge variant="urgent">높음</Badge>}
                {i.origin === 'server' && (
                  <span className="text-xs text-muted-foreground">
                    {i.requesterName} → <span title={i.assigneeName}>{assigneeLabel(i)}</span>
                    {taskProgress(i) && <span className="ml-1.5 rounded bg-muted px-1">{taskProgress(i)!.done}/{taskProgress(i)!.total} 완료</span>}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-3">
                  {i.origin === 'server' && i.attachmentCount > 0 && <Paperclip className="size-3.5 text-muted-foreground" />}
                  {i.origin === 'server' && i.commentCount > 0 && (
                    <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                      <MessageSquare className="size-3" /> {i.commentCount}
                    </span>
                  )}
                  {dueText(i)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {creating && <NewTaskDialog onClose={() => setCreating(false)} personal={filter === 'personal'} />}
      {detail && <TaskDetailDialog id={detail} onClose={() => setDetail(null)} />}
      {personalEdit && <PersonalTaskDialog task={personalEdit} onClose={() => setPersonalEdit(null)} />}
    </div>
  )
}
