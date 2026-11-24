import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { MessageSquare, Mail, ListTodo } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Dialog } from '@renderer/components/Dialog'
import { PresenceDot, PRESENCE_LABEL } from '@renderer/components/PresenceDot'
import { useMe } from '@renderer/lib/queries'
import { openChatWith } from '@renderer/features/chat/dock-store'
import { displayName, roleLabel, type MemberDto } from '@shared/schemas/auth'
import { NewTaskDialog } from '@renderer/features/tasks/TaskDialogs'

/**
 * A team member's details with the quick actions (메시지 / 쪽지 / 업무 요청); used by the
 * directory and the org chart. `today` is whatever the caller knows about today (e.g. 연가).
 */
export function MemberCard({ m, onClose, today }: { m: MemberDto; onClose: () => void; today?: ReactNode }): React.JSX.Element {
  const navigate = useNavigate()
  const { data: me } = useMe()
  const [task, setTask] = useState(false)
  // the conversation opens in a small messenger window over the page the card was opened from
  const openChat = (): void => {
    void openChatWith(m.id)
    onClose()
  }
  return (
    <Dialog open onClose={onClose} title={displayName(m)} width="max-w-md">
      <div className="space-y-3 text-sm" data-testid="member-detail">
        <div className="flex flex-wrap items-center gap-2">
          <PresenceDot presence={m.presence} /> {PRESENCE_LABEL[m.presence]}
          {m.statusMessage && <span className="text-muted-foreground">· {m.statusMessage}</span>}
          {m.role === 'admin' && <Badge variant={m.isOwner ? 'important' : 'default'}>{roleLabel(m)}</Badge>}
        </div>
        {today}
        <dl className="selectable grid grid-cols-[5rem_1fr] gap-y-1.5">
          <dt className="text-muted-foreground">부서</dt>
          <dd>{m.deptName ?? '-'}</dd>
          <dt className="text-muted-foreground">직위</dt>
          <dd>{m.title ?? '-'}</dd>
          {m.rank && (
            <>
              <dt className="text-muted-foreground">직급</dt>
              <dd>{m.rank}</dd>
            </>
          )}
          <dt className="text-muted-foreground">내선</dt>
          <dd>{m.ext ?? '-'}</dd>
          <dt className="text-muted-foreground">휴대폰</dt>
          <dd>{m.mobile ?? '-'}</dd>
          <dt className="text-muted-foreground">담당 업무</dt>
          <dd className="whitespace-pre-wrap">{m.duty ?? '-'}</dd>
        </dl>
        {m.id !== me?.id && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button size="sm" onClick={openChat}>
              <MessageSquare /> 메시지
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate('/chat/notes', { state: { noteTo: m.id } })}>
              <Mail /> 쪽지
            </Button>
            <Button size="sm" variant="outline" onClick={() => setTask(true)}>
              <ListTodo /> 업무 요청
            </Button>
          </div>
        )}
      </div>
      {task && <NewTaskDialog onClose={() => setTask(false)} />}
    </Dialog>
  )
}
