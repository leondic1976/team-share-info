import { z } from 'zod'
import { scopeSchema, type ScopeDto } from './scope'

/** Video meetings and screen sharing (6.17). The server only relays signals; media is P2P. */

export const MAX_VIDEO_PEERS = 8
export const RECOMMENDED_VIDEO_PEERS = 6

export const meetingInputSchema = z.object({
  title: z.string().trim().min(1, '회의 제목을 입력하세요').max(100),
  mode: z.enum(['video', 'screen']).default('video'),
  scope: scopeSchema,
  conversationId: z.string().nullable().default(null),
  eventId: z.string().nullable().default(null)
})
export type MeetingInput = z.input<typeof meetingInputSchema>

export interface MeetingParticipantDto {
  memberId: string
  name: string
  joinedAt: number
  leftAt: number | null
}

export interface MeetingDto {
  id: string
  title: string
  mode: 'video' | 'screen'
  hostId: string
  hostName: string
  state: 'live' | 'ended'
  scope: ScopeDto
  conversationId: string | null
  eventId: string | null
  startedAt: number
  endedAt: number | null
  participants: MeetingParticipantDto[]
}

/** meeting.invite payload */
export interface MeetingInvitePayload {
  id: string
  title: string
  mode: 'video' | 'screen'
  hostName: string
}

/** rtc.signal payload (server → client) */
export interface RtcSignalPayload {
  meetingId: string
  from: string
  data: RtcData
}

/** What clients put in `data`; the server never reads it. */
export type RtcData =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'ice'; candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } }
  | { kind: 'state'; mic: boolean; cam: boolean; screen: boolean; hand: boolean }
  | { kind: 'chat'; text: string; at: number }
  | { kind: 'pointer'; x: number; y: number }

/**
 * Mesh rule: for each pair, the member whose id sorts lower makes the offer.
 * Avoids "glare" (both sides offering at once).
 */
export const isOfferer = (me: string, other: string): boolean => me < other
