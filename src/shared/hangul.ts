/**
 * 초성 검색: a query whose characters are each a full character or an initial consonant
 * (ㄱ, ㄲ, ㄴ ...) matches text whose syllables start with that consonant, so "ㅎㄱㄷ",
 * "홍ㄱㄷ" and "홍길동" all find "홍길동". Double consonants are their own initials
 * (ㄲ finds 까, ㄱ does not), as on the keyboard.
 */

const SYLLABLE_FIRST = 0xac00
const SYLLABLE_LAST = 0xd7a3
/** syllables per initial consonant: 21 vowels x 28 finals */
const PER_INITIAL = 588

/** The 19 initial consonants in Unicode order, as compatibility jamo (what the keyboard types). */
export const CHOSEONG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'] as const
const CHOSEONG_SET: ReadonlySet<string> = new Set(CHOSEONG)

/** The initial consonant of a Hangul syllable ("홍" -> "ㅎ"), or null for anything else. */
export function choseongOf(ch: string): string | null {
  const c = ch.codePointAt(0)
  if (c === undefined || c < SYLLABLE_FIRST || c > SYLLABLE_LAST) return null
  return CHOSEONG[Math.floor((c - SYLLABLE_FIRST) / PER_INITIAL)] ?? null
}

/** Every syllable replaced by its initial consonant ("근무현황" -> "ㄱㅁㅎㅎ"); other characters stay. */
export function toChoseong(text: string): string {
  let out = ''
  for (const ch of text) out += choseongOf(ch) ?? ch
  return out
}

export function isChoseong(ch: string): boolean {
  return CHOSEONG_SET.has(ch)
}

/** True when the query has at least one initial consonant to match by. */
export function hasChoseong(q: string): boolean {
  for (const ch of q) if (CHOSEONG_SET.has(ch)) return true
  return false
}

/** compatibility jamo (U+3131..U+314E) -> index of that initial consonant, -1 for vowels and clusters */
const JAMO_BASE = 0x3131
const INITIAL_INDEX = new Int8Array(0x314e - JAMO_BASE + 1).fill(-1)
CHOSEONG.forEach((c, i) => (INITIAL_INDEX[c.charCodeAt(0) - JAMO_BASE] = i))

function initialIndexOfJamo(code: number): number {
  return code >= JAMO_BASE && code <= 0x314e ? (INITIAL_INDEX[code - JAMO_BASE] as number) : -1
}

/** Substring search where a 초성 in `q` also matches a syllable starting with it (both lower-cased). */
function choseongIncludes(t: string, q: string): boolean {
  const n = q.length
  // Hangul syllables and jamo are single UTF-16 units; everything else must match unit for unit
  outer: for (let i = 0; i + n <= t.length; i++) {
    for (let j = 0; j < n; j++) {
      const qc = q.charCodeAt(j)
      const tc = t.charCodeAt(i + j)
      if (qc === tc) continue
      const want = initialIndexOfJamo(qc)
      if (want < 0 || tc < SYLLABLE_FIRST || tc > SYLLABLE_LAST || Math.floor((tc - SYLLABLE_FIRST) / PER_INITIAL) !== want) continue outer
    }
    return true
  }
  return false
}

/**
 * A matcher for one query, to test many texts with (the server's SQL function, long lists).
 * Each initial consonant of the query stands for any syllable that starts with it; case is
 * ignored; an empty query matches everything.
 */
export function hangulMatcher(query: string): (text: string) => boolean {
  const q = query.trim().toLowerCase()
  if (!q) return () => true
  if (!hasChoseong(q)) return (text) => text.toLowerCase().includes(q)
  return (text) => choseongIncludes(text.toLowerCase(), q)
}

/** Does `text` contain `query`, letting each 초성 of the query stand for a whole syllable? */
export function matchesHangul(text: string, query: string): boolean {
  return hangulMatcher(query)(text)
}
