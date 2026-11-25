import { z } from 'zod'

export const conversationCreateSchema = z.object({
  memberIds: z.array(z.string()).min(1, '대화할 사람을 고르세요').max(200),
  title: z.string().trim().max(60).optional()
})

export const messageCreateSchema = z
  .object({
    body: z.string().max(10_000).default(''),
    attachmentIds: z.array(z.string()).max(10).default([])
  })
  .refine((m) => m.body.trim().length > 0 || m.attachmentIds.length > 0, { message: '내용을 입력하세요.' })

export const noteCreateSchema = z.object({
  toIds: z.array(z.string()).min(1, '받는 사람을 고르세요').max(200),
  body: z.string().trim().min(1, '내용을 입력하세요').max(5000)
})

export interface ConversationDto {
  id: string
  kind: 'dm' | 'room' | 'group'
  title: string
  groupId: string | null
  groupColor: string | null
  memberCount: number
  memberIds: string[]
  lastSeq: number
  lastMessageAt: number | null
  lastPreview: string | null
  lastSenderName: string | null
  unread: number
  muted: boolean
  /** Who made the room (absent from servers older than removing participants). */
  createdBy?: string | null
  /** I may remove other participants: the room's maker and admins. Absent from older servers (then nobody can). */
  canRemove?: boolean
}

/** payload of conversation.changed; `removed` names members taken out of the room by someone else */
export interface ConversationChangedPayload {
  id: string
  removed?: string[]
}

export interface MessageDto {
  id: string
  conversationId: string
  seq: number
  senderId: string | null
  senderName: string | null
  kind: 'text' | 'file' | 'image' | 'system'
  body: string
  attachments: { id: string; name: string; size: number }[]
  createdAt: number
  /** members (other than the sender) who have not read it yet */
  unreadBy: number
  /** when the sender last changed the text (shown as "수정됨"); null: never */
  editedAt?: number | null
  /** deleted by the sender: shown as "삭제된 메시지입니다." (body and attachments are gone) */
  deleted?: boolean
}

/** A sender may change the text of a message for this long after sending it (like KakaoTalk). */
export const MESSAGE_EDIT_WINDOW_MS = 24 * 3600_000
/** The text an older program shows for a deleted message (a newer one draws its own). */
export const DELETED_MESSAGE_TEXT = '삭제된 메시지입니다.'

export const messageEditSchema = z.object({ body: z.string().max(10_000).refine((b) => b.trim().length > 0, { message: '내용을 입력하세요.' }) })

/** payload of the message.changed realtime event (a message was edited or deleted) */
export interface MessageChangedPayload {
  conversationId: string
  id: string
  seq: number
  deleted: boolean
}

export interface NoteDto {
  id: string
  batchId: string
  fromId: string
  fromName: string
  toId: string
  toName: string
  body: string
  createdAt: number
  readAt: number | null
}

/** payload of the message.new realtime event */
export interface MessageNewPayload {
  conversationId: string
  seq: number
  senderId: string | null
  senderName: string | null
  preview: string
  title: string
}
