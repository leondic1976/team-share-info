import { describe, it, expect } from 'vitest'
import { parseBookmarkHtml, parseChromeBookmarks, resolveSmart, toBookmarkHtml } from '../../src/shared/organize'

describe('bookmarks and smart folders (M7-12)', () => {
  it('reads Chrome/Edge bookmark files', () => {
    const json = JSON.stringify({
      roots: {
        bookmark_bar: { children: [{ type: 'url', name: '정부24', url: 'https://www.gov.kr' }, { type: 'folder', name: '업무', children: [{ type: 'url', name: '결재', url: 'https://intra/approval' }, { type: 'url', name: 'x', url: 'javascript:1' }] }] },
        other: { children: [{ type: 'url', name: '', url: 'https://example.com' }] }
      }
    })
    expect(parseChromeBookmarks(json)).toEqual([
      { title: '정부24', url: 'https://www.gov.kr', category: '' },
      { title: '결재', url: 'https://intra/approval', category: '업무' },
      { title: 'https://example.com', url: 'https://example.com', category: '' }
    ])
    expect(parseChromeBookmarks('not json')).toEqual([])
  })

  it('exports and re-imports bookmark HTML', () => {
    const items = [
      { title: '홈택스', url: 'https://www.hometax.go.kr', category: '정부·공공' },
      { title: 'A & B <test>', url: 'https://ab.example/?a=1&b=2', category: '정부·공공' },
      { title: '네이버', url: 'https://www.naver.com', category: '' }
    ]
    const html = toBookmarkHtml(items)
    expect(parseBookmarkHtml(html).sort((a, b) => a.title.localeCompare(b.title))).toEqual([...items].sort((a, b) => a.title.localeCompare(b.title)))
  })

  it('smart folder dates are relative to now', () => {
    const now = Date.parse('2026-11-12T00:00:00Z')
    expect(resolveSmart({ q: '', category: 'doc', modifiedWithinDays: 7 }, now)).toEqual({ q: '', category: 'doc', modifiedAfter: now - 7 * 86400000, modifiedBefore: undefined })
    expect(resolveSmart({ q: '', olderThanDays: 30 }, now).modifiedBefore).toBe(now - 30 * 86400000)
  })
})
