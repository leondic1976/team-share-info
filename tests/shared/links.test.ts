import { describe, it, expect } from 'vitest'
import { splitLinks } from '../../src/shared/links'

const urls = (t: string) => splitLinks(t).filter((p) => p.url).map((p) => [p.text, p.url])

describe('splitLinks (지시 123: web addresses in messages)', () => {
  it('finds http, https and www addresses and keeps the text around them', () => {
    const parts = splitLinks('보세요 https://example.com/a?b=1&c=2#x 그리고 www.naver.com 끝')
    expect(parts.map((p) => p.text).join('')).toBe('보세요 https://example.com/a?b=1&c=2#x 그리고 www.naver.com 끝')
    expect(urls('보세요 https://example.com/a?b=1&c=2#x 그리고 www.naver.com 끝')).toEqual([
      ['https://example.com/a?b=1&c=2#x', 'https://example.com/a?b=1&c=2#x'],
      ['www.naver.com', 'http://www.naver.com']
    ])
  })
  it('leaves out Korean right after the address and sentence punctuation', () => {
    expect(urls('https://a.kr에서 받으세요.')).toEqual([['https://a.kr', 'https://a.kr']])
    expect(urls('링크: http://b.com/x.')).toEqual([['http://b.com/x', 'http://b.com/x']])
    expect(urls('(참고 https://c.com/p)')).toEqual([['https://c.com/p', 'https://c.com/p']])
    expect(urls('https://en.wikipedia.org/wiki/A_(b)')).toEqual([['https://en.wikipedia.org/wiki/A_(b)', 'https://en.wikipedia.org/wiki/A_(b)']])
    expect(urls('192.168.0.10:8080/x, http://10.0.0.5:47431/download!')).toEqual([['http://10.0.0.5:47431/download', 'http://10.0.0.5:47431/download']])
  })
  it('text without an address stays one part; a bare scheme is not a link', () => {
    expect(splitLinks('안녕하세요')).toEqual([{ text: '안녕하세요' }])
    expect(urls('http:// 와 www. 만 있음')).toEqual([])
    expect(splitLinks('')).toEqual([])
  })
})
