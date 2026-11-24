/* Restaurant board logic (no DOM). Exposed as globalThis.Matjip; unit-tested in tests/plugins. */
;(function (g) {
  'use strict'

  const CATS = ['한식', '중식', '일식', '양식', '분식', '카페·디저트', '술집', '기타']
  const PRICES = ['8천원 이하', '8천~1만2천원', '1만2천~2만원', '2만원 이상']
  const TAGS = ['혼밥', '단체', '회식', '가성비', '빨리 나옴', '웨이팅', '포장', '주차']
  /** A member's whole entry must fit in the room entry limit of the server (64KB). */
  const LIMITS = { posts: 60, comments: 300, name: 40, menu: 60, text: 500, comment: 200, bytes: 60000 }

  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max)
  const int = (v, min, max, d) => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
  }
  const keyOf = (memberId, postId) => memberId + ':' + postId
  const newId = () => Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)

  function cleanPost(p) {
    if (!p || typeof p !== 'object') return null
    const name = str(p.name, LIMITS.name)
    const id = str(p.id, 24)
    if (!name || !id) return null
    return {
      id,
      name,
      cat: CATS.includes(p.cat) ? p.cat : '기타',
      rating: int(p.rating, 1, 5, 3),
      menu: str(p.menu, LIMITS.menu),
      price: PRICES.includes(p.price) ? p.price : '',
      walk: p.walk === null || p.walk === undefined || p.walk === '' ? null : int(p.walk, 0, 120, null),
      text: str(p.text, LIMITS.text),
      tags: Array.isArray(p.tags) ? TAGS.filter((t) => p.tags.includes(t)) : [],
      at: int(p.at, 0, 9e15, 0),
      editedAt: p.editedAt ? int(p.editedAt, 0, 9e15, 0) : null
    }
  }

  /** What one member stores: their posts, the posts they liked / visited, their comments. Anything malformed is dropped. */
  function normalize(value) {
    const v = value && typeof value === 'object' ? value : {}
    const keys = (a) => (Array.isArray(a) ? [...new Set(a.filter((k) => typeof k === 'string' && k.length < 80))] : [])
    return {
      v: 1,
      posts: (Array.isArray(v.posts) ? v.posts : []).map(cleanPost).filter(Boolean).slice(0, LIMITS.posts),
      likes: keys(v.likes),
      visits: keys(v.visits),
      comments: (Array.isArray(v.comments) ? v.comments : [])
        .map((c) => (c && typeof c === 'object' && str(c.text, LIMITS.comment) && typeof c.key === 'string' ? { id: str(c.id, 24), key: c.key, text: str(c.text, LIMITS.comment), at: int(c.at, 0, 9e15, 0) } : null))
        .filter(Boolean)
        .slice(0, LIMITS.comments)
    }
  }

  const fits = (value) => JSON.stringify(value).length <= LIMITS.bytes

  /** entries: { memberId: { name, value } } as the room returns them. */
  function postKeys(entries) {
    const out = new Set()
    for (const id of Object.keys(entries || {})) for (const p of normalize(entries[id].value).posts) out.add(keyOf(id, p.id))
    return out
  }

  /** Drop my likes, visits and comments that point at posts which no longer exist. */
  function prune(value, keys) {
    value.likes = value.likes.filter((k) => keys.has(k))
    value.visits = value.visits.filter((k) => keys.has(k))
    value.comments = value.comments.filter((c) => keys.has(c.key))
    return value
  }

  /** Every post of every member with its likes, visits and comments gathered from the others. */
  function buildFeed(entries, meId) {
    const all = Object.keys(entries || {}).map((id) => ({ id, name: str(entries[id].name, 40) || '?', value: normalize(entries[id].value) }))
    const feed = []
    const byKey = new Map()
    for (const m of all)
      for (const p of m.value.posts) {
        const post = Object.assign({}, p, { key: keyOf(m.id, p.id), authorId: m.id, authorName: m.name, mine: m.id === meId, likes: [], visits: [], comments: [], liked: false, visited: false })
        feed.push(post)
        byKey.set(post.key, post)
      }
    for (const m of all) {
      for (const k of m.value.likes) {
        const p = byKey.get(k)
        if (!p) continue
        p.likes.push(m.name)
        if (m.id === meId) p.liked = true
      }
      for (const k of m.value.visits) {
        const p = byKey.get(k)
        if (!p) continue
        p.visits.push(m.name)
        if (m.id === meId) p.visited = true
      }
      for (const c of m.value.comments) {
        const p = byKey.get(c.key)
        if (p) p.comments.push({ id: c.id, authorId: m.id, authorName: m.name, mine: m.id === meId, text: c.text, at: c.at })
      }
    }
    for (const p of feed) p.comments.sort((a, b) => a.at - b.at)
    return sortFeed(feed, 'new')
  }

  function sortFeed(feed, mode) {
    const by = {
      new: (a, b) => b.at - a.at,
      likes: (a, b) => b.likes.length + b.visits.length - (a.likes.length + a.visits.length) || b.at - a.at,
      rating: (a, b) => b.rating - a.rating || b.likes.length - a.likes.length || b.at - a.at
    }
    return feed.slice().sort(by[mode] || by.new)
  }

  function filterFeed(feed, f) {
    const q = str(f && f.q, 60).toLowerCase()
    return feed.filter(
      (p) =>
        (!f || !f.cat || p.cat === f.cat) &&
        (!f || !f.mine || p.mine) &&
        (!q || [p.name, p.menu, p.text, p.authorName, p.cat].concat(p.tags).join(' ').toLowerCase().includes(q))
    )
  }

  /** Same restaurant recommended by several people counts once: spaces and letter case are ignored. */
  const sameName = (name) => str(name, 60).toLowerCase().replace(/\s+/g, '')

  function ranking(feed) {
    const map = new Map()
    for (const p of feed) {
      const k = sameName(p.name)
      const r = map.get(k) || { name: p.name, cats: {}, posts: 0, sum: 0, likes: new Set(), visits: new Set(), menus: [], latest: 0 }
      r.posts++
      r.sum += p.rating
      r.cats[p.cat] = (r.cats[p.cat] || 0) + 1
      p.likes.forEach((n) => r.likes.add(n))
      p.visits.forEach((n) => r.visits.add(n))
      if (p.menu && !r.menus.includes(p.menu)) r.menus.push(p.menu)
      r.latest = Math.max(r.latest, p.at)
      map.set(k, r)
    }
    return [...map.values()]
      .map((r) => {
        const avg = r.sum / r.posts
        return {
          name: r.name,
          cat: Object.keys(r.cats).sort((a, b) => r.cats[b] - r.cats[a])[0],
          posts: r.posts,
          avg: Math.round(avg * 10) / 10,
          likes: r.likes.size,
          visits: r.visits.size,
          menus: r.menus.slice(0, 3),
          latest: r.latest,
          // rating first, then how many people back it up
          score: Math.round((avg * 2 + r.likes.size + r.visits.size * 0.5 + (r.posts - 1)) * 10) / 10
        }
      })
      .sort((a, b) => b.score - a.score || b.latest - a.latest)
  }

  /** Pick one post; better rated and more liked places come up more often. rnd() is in [0, 1). */
  function pick(feed, rnd) {
    if (!feed.length) return null
    const w = feed.map((p) => p.rating + p.likes.length)
    let x = (rnd || Math.random)() * w.reduce((a, b) => a + b, 0)
    for (let i = 0; i < feed.length; i++) {
      x -= w[i]
      if (x < 0) return feed[i]
    }
    return feed[feed.length - 1]
  }

  function timeAgo(at, now) {
    const s = Math.max(0, Math.floor(((now || Date.now()) - at) / 1000))
    if (s < 60) return '방금'
    if (s < 3600) return Math.floor(s / 60) + '분 전'
    if (s < 86400) return Math.floor(s / 3600) + '시간 전'
    if (s < 86400 * 30) return Math.floor(s / 86400) + '일 전'
    const d = new Date(at)
    return d.getFullYear() + '.' + (d.getMonth() + 1) + '.' + d.getDate()
  }

  /** Rating as text (copied to the clipboard for the messenger). */
  const stars = (n) => `별점 ${n}/5`

  function shareText(p) {
    return ['[맛집 추천] ' + p.name + ' (' + p.cat + ') ' + stars(p.rating), [p.menu && '대표 메뉴: ' + p.menu, p.price, p.walk !== null && '걸어서 ' + p.walk + '분'].filter(Boolean).join(' · '), p.text, '- ' + p.authorName]
      .filter(Boolean)
      .join('\n')
  }

  g.Matjip = { CATS, PRICES, TAGS, LIMITS, normalize, cleanPost, fits, keyOf, newId, postKeys, prune, buildFeed, sortFeed, filterFeed, ranking, pick, timeAgo, stars, shareText }
})(typeof window !== 'undefined' ? window : globalThis)
