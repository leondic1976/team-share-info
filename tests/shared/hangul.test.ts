import { describe, it, expect } from 'vitest'
import { choseongOf, hasChoseong, isChoseong, matchesHangul, toChoseong } from '../../src/shared/hangul'

describe('초성 검색 (src/shared/hangul.ts)', () => {
  it('takes the initial consonant of a syllable', () => {
    expect(choseongOf('가')).toBe('ㄱ')
    expect(choseongOf('홍')).toBe('ㅎ')
    expect(choseongOf('힣')).toBe('ㅎ')
    expect(choseongOf('까')).toBe('ㄲ')
    expect(choseongOf('또')).toBe('ㄸ')
    expect(choseongOf('빵')).toBe('ㅃ')
    expect(choseongOf('쌀')).toBe('ㅆ')
    expect(choseongOf('짜')).toBe('ㅉ')
    expect(choseongOf('a')).toBeNull()
    expect(choseongOf('ㄱ')).toBeNull()
    expect(choseongOf('')).toBeNull()
    expect(toChoseong('근무현황')).toBe('ㄱㅁㅎㅎ')
    expect(toChoseong('홍길동 A-1')).toBe('ㅎㄱㄷ A-1')
  })

  it('knows which characters are initial consonants', () => {
    expect(isChoseong('ㄱ')).toBe(true)
    expect(isChoseong('ㅉ')).toBe(true)
    expect(isChoseong('ㄳ')).toBe(false) // a final cluster, never an initial
    expect(isChoseong('ㅏ')).toBe(false)
    expect(hasChoseong('홍ㄱㄷ')).toBe(true)
    expect(hasChoseong('홍길동')).toBe(false)
    expect(hasChoseong('abc')).toBe(false)
  })

  it('matches 초성, mixed and plain queries', () => {
    expect(matchesHangul('근무현황', 'ㄱㅁㅎㅎ')).toBe(true)
    expect(matchesHangul('홍길동', 'ㅎㄱㄷ')).toBe(true)
    expect(matchesHangul('홍길동', '홍ㄱㄷ')).toBe(true)
    expect(matchesHangul('홍길동', 'ㅎ길ㄷ')).toBe(true)
    expect(matchesHangul('홍길동', '홍길동')).toBe(true)
    expect(matchesHangul('총무과 홍길동 주무관', 'ㄱㄷ')).toBe(true) // anywhere in the text
    expect(matchesHangul('홍길동', 'ㅎㄷ')).toBe(false) // in order and next to each other
    expect(matchesHangul('홍길동', '김ㄱㄷ')).toBe(false)
    expect(matchesHangul('홍길동', 'ㅎㄱㄷㅇ')).toBe(false)
    expect(matchesHangul('근무현황', 'ㄱㅈㅎㅎ')).toBe(false)
  })

  it('treats double consonants as their own initials', () => {
    expect(matchesHangul('꽃집', 'ㄲㅈ')).toBe(true)
    expect(matchesHangul('꽃집', 'ㄱㅈ')).toBe(false)
    expect(matchesHangul('떡볶이', 'ㄸㅂㅇ')).toBe(true)
    expect(matchesHangul('빵집', 'ㅃㅈ')).toBe(true)
    expect(matchesHangul('쌍둥이', 'ㅆㄷㅇ')).toBe(true)
    expect(matchesHangul('짜장면', 'ㅉㅈㅁ')).toBe(true)
  })

  it('ignores case and spaces at the ends, and an empty query matches everything', () => {
    expect(matchesHangul('TeamHub 자료실', 'teamhub ㅈㄹ')).toBe(true)
    expect(matchesHangul('TeamHub', '  hub ')).toBe(true)
    expect(matchesHangul('아무거나', '')).toBe(true)
    expect(matchesHangul('아무거나', '   ')).toBe(true)
    expect(matchesHangul('', 'ㄱ')).toBe(false)
  })

  it('still matches a typed jamo character literally', () => {
    expect(matchesHangul('ㅋㅋ 웃김', 'ㅋㅋ')).toBe(true)
  })
})
