/**
 * The sound of a new message (지시 83): a short two-note chime and a voice that says "팀뿌요~".
 * The voice is the Korean voice of Windows (Microsoft Heami, part of Korean Windows), so no
 * recording is shipped. Without a Korean voice only the chime plays.
 */

let last = 0

function chime(): void {
  try {
    const ctx = new AudioContext()
    const notes = [
      [1318.5, 0],
      [1760, 0.11]
    ] as const
    for (const [f, t] of notes) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = f
      const at = ctx.currentTime + t
      g.gain.setValueAtTime(0.0001, at)
      g.gain.exponentialRampToValueAtTime(0.12, at + 0.015)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22)
      o.connect(g).connect(ctx.destination)
      o.start(at)
      o.stop(at + 0.25)
    }
    setTimeout(() => void ctx.close(), 800)
  } catch {
    // no audio device
  }
}

function koreanVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? []
  return voices.find((v) => v.lang.toLowerCase().startsWith('ko') && /heami/i.test(v.name)) ?? voices.find((v) => v.lang.toLowerCase().startsWith('ko')) ?? null
}

function say(): void {
  const synth = window.speechSynthesis
  if (!synth) return
  const speak = (): void => {
    const voice = koreanVoice()
    if (!voice) return
    const u = new SpeechSynthesisUtterance('팀뿌요~')
    u.voice = voice
    u.lang = voice.lang
    u.pitch = 1.7
    u.rate = 1.25
    u.volume = 0.9
    synth.cancel()
    synth.speak(u)
  }
  // the list of voices may still be loading the first time
  if (synth.getVoices().length) speak()
  else synth.addEventListener('voiceschanged', speak, { once: true })
}

/** Plays the message sound; several messages in a moment make one sound. */
export function playMessageSound(): void {
  const now = Date.now()
  if (now - last < 1500) return
  last = now
  // counted for the tests (E2E reads it)
  const w = window as unknown as { __thSounds?: number }
  w.__thSounds = (w.__thSounds ?? 0) + 1
  chime()
  setTimeout(say, 260)
}
