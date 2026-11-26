/**
 * Realtime (WebSocket) protocol (13.7). Events say *what changed*; clients refetch.
 * Exceptions carrying full payloads: notice.urgent, alarm.fire, rtc.signal.
 */
import type { Presence } from './schemas/auth'

export type ClientMessage =
  | { type: 'hello'; deviceId: string; deviceKey: string; winUser: string; protocol: number; appVersion: string }
  | { type: 'presence'; state: 'online' | 'away' }
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'rtc'; meetingId: string; to: string; data: unknown }

export type ServerMessage =
  | { type: 'welcome'; memberId: string; serverTime: number }
  | { type: 'rejected'; code: string; message: string }
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'event'; name: EventName; payload: unknown; at: number }

export type EventName =
  | 'presence.changed'
  | 'join.requested'
  | 'member.changed'
  | 'device.changed'
  | 'settings.changed'
  | 'group.changed'
  | 'group.membership'
  | 'notice.changed'
  | 'notice.urgent'
  | 'notice.receipt'
  | 'event.changed'
  | 'worklog.changed'
  | 'file.changed'
  | 'folder.changed'
  | 'message.new'
  | 'message.changed'
  | 'conversation.changed'
  | 'conversation.read'
  | 'note.new'
  | 'note.changed'
  | 'task.changed'
  | 'post.changed'
  | 'board.changed'
  | 'contact.changed'
  | 'doc.changed'
  | 'memo.changed'
  | 'alarm.fire'
  | 'launcher.changed'
  | 'plugin.room'
  | 'ledger.changed'
  | 'command.changed'
  | 'command.drill'
  | 'collect.changed'
  | 'plugin.invite'
  | 'meeting.invite'
  | 'meeting.changed'
  | 'rtc.signal'
  | 'update.available'
  | 'server.shutdown'

export interface PresencePayload {
  memberId: string
  presence: Presence
}
