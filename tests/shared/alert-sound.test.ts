import { describe, expect, it } from 'vitest'
import { ALERT_SENTENCES, ALERT_SOUND_GAP_MS, alertSentence, soundPlays } from '@shared/alert-sound'

describe('alert sound (지시 131)', () => {
  it('says "새로운 메시지 도착입니다." for messages and notes only', () => {
    expect(alertSentence('message')).toBe('새로운 메시지 도착입니다.')
    expect(ALERT_SENTENCES.message).toBe('새로운 메시지 도착입니다.')
  })

  it('says "새로운 알림 도착입니다." for every other alert', () => {
    for (const k of ['alert', undefined, null, '', 'notice', 'event']) expect(alertSentence(k)).toBe('새로운 알림 도착입니다.')
  })

  it('plays one sound for alerts within 1.5 s', () => {
    expect(ALERT_SOUND_GAP_MS).toBe(1500)
    expect(soundPlays(10_000, -Infinity)).toBe(true)
    expect(soundPlays(10_000, 0)).toBe(true)
    expect(soundPlays(10_000, 9_000)).toBe(false)
    expect(soundPlays(10_000, 8_500)).toBe(true)
  })
})
