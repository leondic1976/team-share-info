import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { LogOut, UserMinus, UserPlus } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Dialog } from '@renderer/components/Dialog'
import { MemberPicker } from '@renderer/components/ScopePicker'
import { MemberLink } from '@renderer/components/MemberLink'
import { PresenceDot } from '@renderer/components/PresenceDot'
import { api, ApiError, errorMessage } from '@renderer/lib/api'
import { useMembers } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import { displayName } from '@shared/schemas/auth'
import type { ConversationDto } from '@shared/schemas/chat'
import { GROUP_LEAVE_HINT, leaveConversation } from './leave'

export type ConversationDetail = ConversationDto & { members: { id: string; name: string }[] }

/**
 * Who is in a conversation, with adding, removing and leaving (used by the messenger page and
 * the small messenger windows).
 * - 1:1: adding people makes a new room (`onSwitch`); the pair itself never changes.
 * - group chat: follows the group, so nothing can be changed here.
 */
export function ParticipantsDialog({ conv, onClose, onSwitch, onLeft }: { conv: ConversationDetail; onClose: () => void; onSwitch: (id: string) => void; onLeft: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const meId = useConn((s) => s.memberId)
  const online = useConn((s) => s.state === 'online')
  const { data: all } = useMembers()
  const [ids, setIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const isGroup = conv.kind === 'group'
  const fresh = ids.filter((x) => !conv.memberIds.includes(x))

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      await fn()
      void qc.invalidateQueries({ queryKey: ['chat'] })
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const add = (): Promise<void> =>
    run(async () => {
      let next: string | undefined
      try {
        next = (await api.post<{ conversationId?: string }>(`/api/conversations/${conv.id}/members`, { memberIds: fresh })).conversationId
      } catch (e) {
        // a server older than this app does not add to a 1:1: make the room the way [새 대화] does
        if (conv.kind !== 'dm' || !(e instanceof ApiError) || e.status !== 400) throw e
        next = (await api.post<ConversationDto>('/api/conversations', { memberIds: [...conv.memberIds, ...fresh] })).id
      }
      setIds([])
      if (next && next !== conv.id) {
        onClose()
        onSwitch(next)
      }
    })

  const remove = (m: { id: string; name: string }): void => {
    if (!window.confirm(`${m.name}님을 대화방에서 내보낼까요?\n내보낸 사람은 이 대화방의 이전 대화도 볼 수 없게 됩니다.`)) return
    void run(() => api.del(`/api/conversations/${conv.id}/members/${m.id}`))
  }

  const leave = (): void =>
    void run(async () => {
      if (!(await leaveConversation(conv, conv.members.find((m) => m.id === meId)?.name ?? ''))) return
      onClose()
      onLeft()
    })

  return (
    <Dialog
      open
      onClose={onClose}
      title="참가자"
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" className="mr-auto text-urgent" disabled={isGroup || !online || busy} title={isGroup ? GROUP_LEAVE_HINT : undefined} onClick={leave}>
            <LogOut /> 나가기
          </Button>
          <Button disabled={isGroup || !online || busy || !fresh.length} onClick={() => void add()}>
            <UserPlus /> 추가
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm" data-testid="participants">
        <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {conv.members.map((m) => {
            const full = all?.find((x) => x.id === m.id)
            return (
              <li key={m.id} className="flex items-center gap-2 px-2.5 py-1.5" data-testid={`participant-${m.name}`}>
                <PresenceDot presence={full?.presence ?? 'offline'} />
                <MemberLink memberId={m.id} name={m.name} className="truncate font-medium" onOpen={onClose}>
                  {full ? displayName(full) : m.name}
                </MemberLink>
                {m.id === meId && <Badge variant="success">나</Badge>}
                {conv.kind === 'room' && conv.createdBy === m.id && <Badge variant="muted">만든 사람</Badge>}
                {conv.kind === 'room' && conv.canRemove && m.id !== meId && (
                  <Button size="sm" variant="ghost" className="ml-auto text-urgent" disabled={!online || busy} aria-label={`${m.name} 내보내기`} onClick={() => remove(m)}>
                    <UserMinus /> 내보내기
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
        {isGroup ? (
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">그룹 대화방의 참가자는 그룹 구성원을 그대로 따릅니다. 사람을 추가하거나 내보내려면 그룹 메뉴에서 그룹 구성원을 바꾸세요.</p>
        ) : (
          <>
            <p className="text-xs font-semibold text-muted-foreground">추가할 사람</p>
            <MemberPicker value={ids} onChange={setIds} excludeSelf />
            {conv.kind === 'dm' ? (
              <p className="text-xs text-muted-foreground">1:1 대화에 사람을 추가하면 새 대화방이 만들어집니다. 이전 대화 내용은 새 대화방으로 옮겨지지 않습니다.</p>
            ) : (
              !conv.canRemove && <p className="text-xs text-muted-foreground">내보내기는 대화방을 만든 사람과 관리자만 할 수 있습니다.</p>
            )}
          </>
        )}
        {!online && <p className="text-xs text-muted-foreground">서버가 꺼져 있는 동안에는 참가자를 바꿀 수 없습니다.</p>}
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}
