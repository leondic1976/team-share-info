import { displayName, type MemberDto } from '@shared/schemas/auth'
import type { ConversationDto } from '@shared/schemas/chat'

/**
 * Title of a conversation as shown in lists and headers. The server names a 1:1 conversation
 * after the other person's real name; here it becomes "본명(필명)" when that person has a pen
 * name. Rooms and group chats keep their own title.
 */
export function convTitle(c: Pick<ConversationDto, 'kind' | 'title' | 'memberIds'>, members: MemberDto[] | undefined, meId: string | null | undefined): string {
  if (c.kind !== 'dm') return c.title
  const otherId = c.memberIds.find((m) => m !== meId)
  const other = otherId ? members?.find((m) => m.id === otherId) : undefined
  return other ? displayName(other) : c.title
}
