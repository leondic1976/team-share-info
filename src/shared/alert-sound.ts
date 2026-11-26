/**
 * The alert sound (지시 131): a short chime and then a spoken sentence. Messages and notes
 * (메신저·쪽지) say "새로운 메시지 도착입니다."; every other alert (공지, 새 일정, 일정 알림, 알람,
 * 기록, 관리대장, 확장 기능, 사용 신청 …) says "새로운 알림 도착입니다.", so a notice is not
 * announced as a message.
 */

export type AlertSoundKind = 'message' | 'alert'

export const ALERT_SENTENCES: Readonly<Record<AlertSoundKind, string>> = {
  message: '새로운 메시지 도착입니다.',
  alert: '새로운 알림 도착입니다.'
}

/** The sentence for an alert; anything that is not a message or a note is an alert. */
export function alertSentence(kind?: string | null): string {
  return kind === 'message' ? ALERT_SENTENCES.message : ALERT_SENTENCES.alert
}

/** Sounds within this time of the last one are not played again (several alerts, one sound). */
export const ALERT_SOUND_GAP_MS = 1500

/** Whether a sound asked for at `now` plays, given when the last one played. */
export function soundPlays(now: number, last: number): boolean {
  return now - last >= ALERT_SOUND_GAP_MS
}
