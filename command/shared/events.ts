/** 긴급구조지휘대: realtime events the server sends (the host carries them over its own channel). */
export const COMMAND_EVENTS = ['command.changed', 'command.drill'] as const
export type CommandEvent = (typeof COMMAND_EVENTS)[number]

/** command.changed: 편성·설정·공지·자료 changed (what: which part, for the screens to refresh). */
export interface CommandChangedPayload {
  what: 'setup' | 'notice' | 'material' | 'scenario'
  /** notice: a new one (for the alert) */
  id?: string
  title?: string
  by?: string
  byId?: string
}

/** command.drill: something happened in a drill. */
export interface CommandDrillPayload {
  drillId: string
  kind: 'state' | 'message' | 'answer' | 'grade' | 'mark' | 'note' | 'remind'
  msgId?: string
  /** message / remind: the message should pop up (훈련 창) */
  popup?: boolean
  /** state: the new state */
  state?: string
}
