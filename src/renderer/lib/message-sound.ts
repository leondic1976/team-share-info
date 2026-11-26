/**
 * The alert sound (지시 83, 131): a short soft chime made with Web Audio, followed right after by
 * a voice that says "새로운 메시지 도착입니다." (messages, notes) or "새로운 알림 도착입니다."
 * (every other alert). The voice is the Korean voice of Windows (Microsoft Heami, part of Korean
 * Windows), so no recording is shipped. Without a Korean voice only the chime plays.
 */
import { alertSentence, soundPlays, type AlertSoundKind } from '@shared/alert-sound'

let last = -Infinity

/** length of the chime in seconds; the voice starts as it fades */
const CHIME_S = 0.5

/** Two soft bell-like tones (G5, then C6), each a sine with a quiet octave above it. */
function chime(): void {
  try {
    const ctx = new AudioContext()
    const notes = [
      [783.99, 0],
      [1046.5, 0.16]
    ] as const
    for (const [f, t] of notes) {
      for (const [mult, peak] of [
        [1, 0.1],
        [2, 0.025]
      ] as const) {
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        o.type = 'sine'
        o.frequency.value = f * mult
        const at = ctx.currentTime + t
        g.gain.setValueAtTime(0.0001, at)
        g.gain.exponentialRampToValueAtTime(peak, at + 0.02)
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.34)
        o.connect(g).connect(ctx.destination)
        o.start(at)
        o.stop(at + 0.36)
      }
    }
    setTimeout(() => void ctx.close(), 1000)
  } catch {
    // no audio device
  }
}

function koreanVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? []
  return voices.find((v) => v.lang.toLowerCase().startsWith('ko') && /heami/i.test(v.name)) ?? voices.find((v) => v.lang.toLowerCase().startsWith('ko')) ?? null
}

function say(text: string): void {
  const synth = window.speechSynthesis
  if (!synth) return
  const speak = (): void => {
    const voice = koreanVoice()
    // no Korean voice installed: the chime alone
    if (!voice) return
    const u = new SpeechSynthesisUtterance(text)
    u.voice = voice
    u.lang = voice.lang
    u.rate = 1.05
    u.volume = 0.9
    synth.cancel()
    synth.speak(u)
  }
  // the list of voices may still be loading the first time
  if (synth.getVoices().length) speak()
  else synth.addEventListener('voiceschanged', speak, { once: true })
}

/** Plays the alert sound; several alerts in a moment make one sound (the first one's sentence). */
export function playMessageSound(kind: AlertSoundKind = 'message'): void {
  const now = Date.now()
  if (!soundPlays(now, last)) return
  last = now
  const text = alertSentence(kind)
  // counted for the tests (E2E reads them)
  const w = window as unknown as { __thSounds?: number; __thSoundTexts?: string[] }
  w.__thSounds = (w.__thSounds ?? 0) + 1
  ;(w.__thSoundTexts ??= []).push(text)
  chime()
  setTimeout(() => say(text), CHIME_S * 1000)
}
