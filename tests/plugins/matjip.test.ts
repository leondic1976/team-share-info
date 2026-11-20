import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx: Record<string, any> = {}
runInNewContext(readFileSync(join(import.meta.dirname, '../../plugins/matjip/matjip.js'), 'utf8'), ctx)
const M = ctx.Matjip

const post = (id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ id, name, cat: '한식', rating: 4, menu: '', price: '', walk: 5, text: '', tags: [], at: 1000, ...over })
const entries = (): Record<string, { name: string; value: unknown }> => ({
  a: { name: '김', value: { posts: [post('p1', '할매 순대국', { rating: 5, menu: '순대국', at: 2000 }), post('p2', '스시집', { cat: '일식', rating: 3, at: 3000 })], likes: [], visits: [], comments: [] } },
  b: { name: '이', value: { posts: [post('p9', '할매순대국', { rating: 4, at: 1500 })], likes: ['a:p1', 'a:gone'], visits: ['a:p1'], comments: [{ id: 'c1', key: 'a:p1', text: '저도 좋아해요', at: 2500 }] } },
  c: { name: '박', value: { likes: ['a:p1'], comments: [{ id: 'c2', key: 'a:p1', text: '   ', at: 1 }] } }
})

describe('matjip plugin: the feed is built from the entry each member owns', () => {
  it('gathers likes, visits and comments from the other members', () => {
    const feed = M.buildFeed(entries(), 'b')
    expect(feed.map((p: any) => p.key)).toEqual(['a:p2', 'a:p1', 'b:p9']) // newest first
    const p1 = feed.find((p: any) => p.key === 'a:p1')
    expect(p1.likes).toEqual(['이', '박'])
    expect(p1.liked).toBe(true)
    expect(p1.visited).toBe(true)
    expect(p1.mine).toBe(false)
    expect(p1.comments.map((c: any) => [c.authorName, c.text, c.mine])).toEqual([['이', '저도 좋아해요', true]]) // the blank comment is dropped
    expect(feed.find((p: any) => p.key === 'b:p9').mine).toBe(true)
  })

  it('drops malformed data and keeps values inside their limits', () => {
    const v = M.normalize({ posts: [{ id: 'x', name: '  ' }, { id: 'y', name: 'a'.repeat(99), cat: '우주식', rating: 9, walk: 'x', tags: ['혼밥', '해킹'], text: 'b'.repeat(900) }, null, 'str'], likes: ['k', 'k', 5], comments: 'no' })
    expect(v.posts).toHaveLength(1)
    expect(v.posts[0]).toMatchObject({ id: 'y', cat: '기타', rating: 5, walk: null, tags: ['혼밥'] })
    expect(v.posts[0].name).toHaveLength(M.LIMITS.name)
    expect(v.posts[0].text).toHaveLength(M.LIMITS.text)
    expect(v.likes).toEqual(['k'])
    expect(v.comments).toEqual([])
    expect(M.normalize(undefined)).toEqual({ v: 1, posts: [], likes: [], visits: [], comments: [] })
  })

  it('prunes what points at deleted posts and checks the size limit', () => {
    const e = entries()
    const mine = M.normalize(e.b.value)
    M.prune(mine, M.postKeys(e))
    expect(mine.likes).toEqual(['a:p1'])
    expect(M.fits(mine)).toBe(true)
    expect(M.fits({ posts: Array.from({ length: 200 }, (_, i) => post(`p${i}`, '가게', { text: '가'.repeat(500) })) })).toBe(false)
  })

  it('filters, sorts and ranks; the same restaurant counts once', () => {
    const feed = M.buildFeed(entries(), 'a')
    expect(M.filterFeed(feed, { cat: '일식' }).map((p: any) => p.name)).toEqual(['스시집'])
    expect(M.filterFeed(feed, { q: '순대' })).toHaveLength(2)
    expect(M.filterFeed(feed, { mine: true })).toHaveLength(2)
    expect(M.sortFeed(feed, 'likes')[0].key).toBe('a:p1')
    expect(M.sortFeed(feed, 'rating')[0].key).toBe('a:p1')
    const rank = M.ranking(feed)
    expect(rank).toHaveLength(2)
    expect(rank[0]).toMatchObject({ name: '할매 순대국', posts: 2, avg: 4.5, likes: 2, visits: 1 })
  })

  it('picks one place, never outside the list', () => {
    const feed = M.buildFeed(entries(), 'a')
    expect(M.pick([], Math.random)).toBeNull()
    expect(M.pick(feed, () => 0).key).toBe(feed[0].key)
    expect(M.pick(feed, () => 0.999999).key).toBe(feed[feed.length - 1].key)
    expect(M.shareText(feed.find((p: any) => p.key === 'a:p1'))).toContain('[맛집 추천] 할매 순대국 (한식) ★★★★★')
    expect(M.timeAgo(0, 30_000)).toBe('방금')
    expect(M.timeAgo(0, 2 * 3600_000)).toBe('2시간 전')
  })
})
