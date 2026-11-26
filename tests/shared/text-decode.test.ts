import { describe, it, expect } from 'vitest'
import { decodeText, detectTextEncoding } from '../../src/shared/text-decode'

const hex = (s: string): Uint8Array => Uint8Array.from(s.split(' ').map((h) => parseInt(h, 16)))

describe('text file decoding (src/shared/text-decode.ts)', () => {
  it('reads EUC-KR (CP949) bytes as saved by Notepad or Excel', () => {
    // "한글 테스트" in EUC-KR
    const b = hex('c7 d1 b1 db 20 c5 d7 bd ba c6 ae')
    expect(detectTextEncoding(b)).toBe('euc-kr')
    expect(decodeText(b)).toBe('한글 테스트')
    // a CSV with a CRLF line end
    expect(decodeText(hex('c0 cc b8 a7 2c ba ce bc ad 0d 0a c8 ab b1 e6 b5 bf 2c c3 d1 b9 ab b0 fa'))).toBe('이름,부서\r\n홍길동,총무과')
  })

  it('reads the CP949 extension syllables too (똠 is not in plain EUC-KR)', () => {
    expect(decodeText(hex('8c 63 b9 e6 b0 a2 c7 cf'))).toBe('똠방각하')
    // first (갂 81 41) and last (힣 C6 52) of the extension, next to ASCII and KS X 1001 (힝 C8 FE)
    expect(decodeText(hex('81 41 20 c1 64 20 8c 63 61 2c 9c 58 c8 fe c6 52'))).toBe('갂 햏 똠a,쏼힝힣')
  })

  it('keeps valid UTF-8, with or without a BOM', () => {
    const utf8 = new TextEncoder().encode('근무현황 a,b')
    expect(detectTextEncoding(utf8)).toBe('utf-8')
    expect(decodeText(utf8)).toBe('근무현황 a,b')
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8])
    expect(decodeText(bom)).toBe('근무현황 a,b')
    expect(decodeText(new TextEncoder().encode('plain ascii'))).toBe('plain ascii')
    expect(decodeText(new Uint8Array())).toBe('')
  })

  it('reads UTF-16 with a BOM, both byte orders', () => {
    const le = hex('ff fe 4d d6 38 ae d9 b3')
    expect(detectTextEncoding(le)).toBe('utf-16le')
    expect(decodeText(le)).toBe('홍길동')
    const be = hex('fe ff d6 4d ae 38 b3 d9')
    expect(detectTextEncoding(be)).toBe('utf-16be')
    expect(decodeText(be)).toBe('홍길동')
  })
})
