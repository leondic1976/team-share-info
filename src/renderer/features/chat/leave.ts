import type { ConversationDto } from '@shared/schemas/chat'
import { api } from '@renderer/lib/api'
import { queryClient } from '@renderer/lib/query-client'
import { useChatDock } from './dock-store'

/** Why a group chat cannot be left from the messenger. */
export const GROUP_LEAVE_HINT = '그룹 대화방은 그룹에서 나가야 빠집니다.'

/** One sentence that says what leaving does (it differs for a room and a 1:1 conversation). */
export function leaveConfirmText(kind: ConversationDto['kind'], myName: string): string {
  return kind === 'dm'
    ? '이 1:1 대화를 내 목록에서 지울까요? 상대에게는 알리지 않으며, 상대가 다시 메시지를 보내거나 내가 다시 대화를 시작하면 이전 내용과 함께 다시 나타납니다.'
    : `대화방에서 나갈까요? 내 목록에서 사라지고 남은 사람들에게 "${myName}님이 나갔습니다."라고 표시됩니다.`
}

/**
 * Ask, then leave. Resolves to false when the user said no. The small messenger window showing
 * the conversation closes; a page showing it is closed by the caller.
 */
export async function leaveConversation(c: Pick<ConversationDto, 'id' | 'kind'>, myName: string): Promise<boolean> {
  if (c.kind === 'group') return false
  if (!window.confirm(leaveConfirmText(c.kind, myName))) return false
  await api.del(`/api/conversations/${c.id}/members/me`)
  useChatDock.getState().close(c.id)
  // nothing of a conversation I left stays readable on this PC
  queryClient.setQueryData(['chat', 'msgs', c.id], [])
  queryClient.removeQueries({ queryKey: ['chat', 'conv', c.id] })
  void queryClient.invalidateQueries({ queryKey: ['chat'] })
  return true
}
