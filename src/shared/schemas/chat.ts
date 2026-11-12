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
