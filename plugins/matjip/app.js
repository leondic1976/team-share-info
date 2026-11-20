/* Restaurant board UI. Talks to TeamHub only via TeamHub.call (see __sdk.js).
 *
 * One team-wide room holds the board. The server lets each member write only their own
 * entry, so a member's entry carries their posts plus their likes, visits and comments on
 * other people's posts; the feed is put together from all entries (matjip.js). */
;(function () {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const M = window.Matjip
  const call = (m, p) => window.TeamHub.call(m, p)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const ROOM_TITLE = '맛집 게시판'
  const AVATARS = ['#ef4444', '#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5']

  let me = null
  let depts = new Map()
  let room = null
  let tab = 'feed'
  let cat = ''
  let sort = 'new'
  let editing = null // post being edited, or null for a new one
  let rating = 4
  let tags = new Set()
  let lastPick = null
  const openComments = new Set()

  function toast(msg) {
    const t = $('toast')
    t.textContent = msg
    t.classList.add('show')
    clearTimeout(toast.t)
    toast.t = setTimeout(() => t.classList.remove('show'), 2600)
  }

  // ---------- data ----------
  async function loadRoom() {
    const rooms = await call('rooms.list')
    const boards = rooms.filter((r) => r.title === ROOM_TITLE && r.scope && r.scope.type === 'team').sort((a, b) => a.createdAt - b.createdAt)
    // The first person to open the board creates it; if two did at once, everyone uses the older one.
    room = boards[0] || (await call('rooms.create', { title: ROOM_TITLE, scope: { type: 'team', groupIds: [], memberIds: [] }, shared: { app: 'matjip' } }))
  }

  const myValue = () => M.normalize(room.entries[me.id] && room.entries[me.id].value)
  const feed = () => M.buildFeed(room.entries, me.id)

  /** Read the latest board, change my own entry, save it. */
  async function mutate(change) {
    try {
      room = await call('rooms.get', { roomId: room.id })
      const v = myValue()
      if (change(v) === false) return false
      const entries = Object.assign({}, room.entries, { [me.id]: { name: me.name, value: v } })
      M.prune(v, M.postKeys(entries))
      if (!M.fits(v)) throw new Error('내 글과 댓글이 너무 많습니다. 오래된 것을 지운 뒤 다시 하세요.')
      room = await call('rooms.setEntry', { roomId: room.id, value: v })
      render()
      return true
    } catch (e) {
      toast(e.message || '저장하지 못했습니다.')
      return false
    }
  }

  // ---------- render ----------
  function avatar(id, name) {
    let h = 0
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    return `<span class="avatar" style="background:${AVATARS[h % AVATARS.length]}" aria-hidden="true">${esc(String(name).slice(0, 1))}</span>`
  }
  const names = (list) => (list.length ? esc(list.join(', ')) : '')

  function postHtml(p) {
    const dept = depts.get(p.authorId)
    const facts = [p.menu && `🍽 ${esc(p.menu)}`, p.price && `💰 ${esc(p.price)}`, p.walk !== null && `🚶 걸어서 ${p.walk}분`].filter(Boolean)
    const open = openComments.has(p.key)
    return `<article class="post" data-key="${esc(p.key)}">
      <div class="post-head">
        ${avatar(p.authorId, p.authorName)}
        <div class="who"><b>${esc(p.authorName)}</b><span class="muted small">${dept ? esc(dept) + ' · ' : ''}${M.timeAgo(p.at)}${p.editedAt ? ' · 고침' : ''}</span></div>
        ${p.mine ? '<button data-act="edit">고치기</button><button data-act="del">지우기</button>' : ''}
      </div>
      <div class="place"><strong>${esc(p.name)}</strong><span class="badge">${esc(p.cat)}</span><span class="stars" aria-label="별점 ${p.rating}점">${M.stars(p.rating)}</span></div>
      ${facts.length ? `<div class="facts">${facts.map((f) => `<span>${f}</span>`).join('')}</div>` : ''}
      ${p.tags.length ? `<div class="facts">${p.tags.map((t) => `<span class="badge tag">#${esc(t)}</span>`).join('')}</div>` : ''}
      ${p.text ? `<p class="text">${esc(p.text)}</p>` : ''}
      <div class="actions">
        <button data-act="like" class="${p.liked ? 'on' : ''}" aria-pressed="${p.liked}" title="${names(p.likes)}">${p.liked ? '❤️' : '🤍'} 좋아요 ${p.likes.length || ''}</button>
        <button data-act="visit" class="${p.visited ? 'on' : ''}" aria-pressed="${p.visited}" title="${names(p.visits)}">😋 가봤어요 ${p.visits.length || ''}</button>
        <button data-act="comments" aria-expanded="${open}">💬 댓글 ${p.comments.length || ''}</button>
        <span class="grow"></span>
        <button data-act="share" title="메신저에 붙여넣을 수 있게 복사">📋 복사</button>
      </div>
      ${
        open
          ? `<div class="comments">
        ${p.comments.map((c) => `<div class="comment"><b>${esc(c.authorName)}</b><p>${esc(c.text)}</p><span class="muted small">${M.timeAgo(c.at)}</span>${c.mine ? `<button data-act="delComment" data-id="${esc(c.id)}" aria-label="댓글 지우기">✕</button>` : ''}</div>`).join('')}
        <form class="comment-form" data-act="comment"><input maxlength="200" placeholder="댓글 달기" aria-label="댓글" /><button type="submit">등록</button></form>
      </div>`
          : ''
      }
    </article>`
  }

  function empty(icon, title, body) {
    return `<div class="empty"><div class="big">${icon}</div><h2>${esc(title)}</h2><p>${esc(body)}</p></div>`
  }

  function render() {
    document.querySelectorAll('nav [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)))
    $('filters').style.display = tab === 'rank' ? 'none' : ''
    const list = $('list')
    if (!room) return
    // keep what is being typed in comment boxes across a redraw (other people's changes arrive at any time)
    const drafts = new Map()
    let focusKey = null
    list.querySelectorAll('.post').forEach((el) => {
      const input = el.querySelector('.comment-form input')
      if (!input) return
      if (input.value) drafts.set(el.dataset.key, input.value)
      if (document.activeElement === input) focusKey = el.dataset.key
    })
    const scroll = list.scrollTop

    const all = feed()
    if (tab === 'rank') {
      const rows = M.ranking(all)
      list.innerHTML = rows.length
        ? `<div class="rank">${rows
            .map(
              (r, i) => `<button class="rank-row" data-act="rank" data-name="${esc(r.name)}">
            <span class="rank-no">${['🥇', '🥈', '🥉'][i] || i + 1}</span>
            <span class="rank-main"><b>${esc(r.name)}</b> <span class="badge">${esc(r.cat)}</span><br /><span class="muted small">${r.menus.length ? esc(r.menus.join(', ')) + ' · ' : ''}추천 ${r.posts}건</span></span>
            <span class="stars">★ ${r.avg.toFixed(1)}</span>
            <span class="muted small">❤️ ${r.likes} · 😋 ${r.visits}</span>
          </button>`
            )
            .join('')}</div>`
        : empty('🏆', '아직 랭킹이 없습니다', '맛집을 추천하면 별점과 좋아요로 순위가 매겨집니다.')
    } else {
      const shown = M.sortFeed(M.filterFeed(all, { cat, q: $('q').value, mine: tab === 'mine' }), sort)
      list.innerHTML = shown.length
        ? `<div class="feed">${shown.map(postHtml).join('')}</div>`
        : all.length && (cat || $('q').value || tab === 'mine')
          ? empty('🔍', tab === 'mine' ? '내가 쓴 추천 글이 없습니다' : '조건에 맞는 맛집이 없습니다', tab === 'mine' ? '[맛집 추천하기]로 단골집을 알려 주세요.' : '종류나 검색어를 바꿔 보세요.')
          : empty('🍜', '첫 맛집을 추천해 주세요', '사무실 주변에서 자주 가는 곳을 올리면 팀원 모두가 봅니다.')
    }
    list.scrollTop = scroll
    list.querySelectorAll('.post').forEach((el) => {
      const input = el.querySelector('.comment-form input')
      if (!input) return
      if (drafts.has(el.dataset.key)) input.value = drafts.get(el.dataset.key)
      if (focusKey === el.dataset.key) input.focus()
    })
  }

  function renderCats() {
    $('cats').innerHTML = ['']
      .concat(M.CATS)
      .map((c) => `<button class="chip" role="radio" aria-checked="${cat === c}" data-cat="${esc(c)}">${c ? esc(c) : '전체'}</button>`)
      .join('')
  }

  // ---------- editor ----------
  function renderRating() {
    $('fRating').innerHTML = [1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="${rating === n}" aria-label="${n}점" data-n="${n}" class="${n <= rating ? 'on' : ''}">★</button>`).join('')
  }
  function renderTags() {
    $('fTags').innerHTML = M.TAGS.map((t) => `<button type="button" class="chip" aria-pressed="${tags.has(t)}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')
  }
  function openEditor(post) {
    editing = post || null
    $('editorTitle').textContent = post ? '추천 글 고치기' : '맛집 추천하기'
    $('editorSave').textContent = post ? '저장' : '올리기'
    $('fName').value = post ? post.name : ''
    $('fCat').value = post ? post.cat : M.CATS[0]
    $('fMenu').value = post ? post.menu : ''
    $('fPrice').value = post ? post.price : ''
    $('fWalk').value = post && post.walk !== null ? post.walk : ''
    $('fText').value = post ? post.text : ''
    rating = post ? post.rating : 4
    tags = new Set(post ? post.tags : [])
    renderRating()
    renderTags()
    $('editor').showModal()
    $('fName').focus()
  }
  async function saveEditor() {
    const input = M.cleanPost({ id: editing ? editing.id : M.newId(), name: $('fName').value, cat: $('fCat').value, rating, menu: $('fMenu').value, price: $('fPrice').value, walk: $('fWalk').value, text: $('fText').value, tags: [...tags], at: editing ? editing.at : Date.now(), editedAt: editing ? Date.now() : null })
    if (!input) return toast('가게 이름을 적어 주세요.')
    const was = editing
    const ok = await mutate((v) => {
      if (was) {
        const i = v.posts.findIndex((p) => p.id === was.id)
        if (i < 0) throw new Error('이미 지워진 글입니다.')
        v.posts[i] = input
      } else {
        if (v.posts.length >= M.LIMITS.posts) throw new Error(`추천 글은 ${M.LIMITS.posts}개까지 올릴 수 있습니다. 오래된 글을 지워 주세요.`)
        v.posts.unshift(input)
      }
    })
    if (!ok) return
    $('editor').close()
    toast(was ? '고쳤습니다.' : '추천 글을 올렸습니다.')
    if (!was && tab === 'rank') tab = 'feed'
    render()
  }

  // ---------- today's pick ----------
  function showPick() {
    const pool = M.filterFeed(feed(), { cat, q: $('q').value })
    if (!pool.length) return toast('뽑을 맛집이 없습니다. 먼저 추천 글을 올려 주세요.')
    let p = M.pick(pool)
    // not the same place twice in a row when there is a choice
    for (let i = 0; i < 5 && pool.length > 1 && lastPick === p.key; i++) p = M.pick(pool)
    lastPick = p.key
    $('pickResult').innerHTML = `<div class="place"><strong>${esc(p.name)}</strong><span class="badge">${esc(p.cat)}</span><span class="stars">${M.stars(p.rating)}</span></div>
      <div class="facts">${[p.menu && `🍽 ${esc(p.menu)}`, p.price && `💰 ${esc(p.price)}`, p.walk !== null && `🚶 걸어서 ${p.walk}분`].filter(Boolean).map((f) => `<span>${f}</span>`).join('')}</div>
      ${p.text ? `<p class="text">${esc(p.text)}</p>` : ''}
      <p class="muted small">${esc(p.authorName)}님의 추천${cat ? ` · ${esc(cat)} 중에서` : ''}</p>`
    if (!$('picker').open) $('picker').showModal()
  }

  // ---------- events ----------
  function onListClick(e) {
    const btn = e.target.closest('[data-act]')
    if (!btn || btn.tagName === 'FORM') return
    const act = btn.dataset.act
    if (act === 'rank') {
      tab = 'feed'
      cat = ''
      $('q').value = btn.dataset.name
      renderCats()
      return render()
    }
    const el = btn.closest('.post')
    const post = el && feed().find((p) => p.key === el.dataset.key)
    if (!post) return
    const toggle = (list) => (v) => {
      const i = v[list].indexOf(post.key)
      if (i >= 0) v[list].splice(i, 1)
      else v[list].push(post.key)
    }
    if (act === 'like') void mutate(toggle('likes'))
    else if (act === 'visit') void mutate(toggle('visits'))
    else if (act === 'comments') {
      if (openComments.has(post.key)) openComments.delete(post.key)
      else openComments.add(post.key)
      render()
      const input = $('list').querySelector(`.post[data-key="${CSS.escape(post.key)}"] .comment-form input`)
      if (input) input.focus()
    } else if (act === 'share') call('clipboard.write', { text: M.shareText(post) }).then(() => toast('복사했습니다. 메신저에 붙여넣으세요(Ctrl+V).'), (err) => toast(err.message))
    else if (act === 'edit') openEditor(post)
    else if (act === 'del') {
      if (window.confirm(`'${post.name}' 추천 글을 지울까요? 달린 좋아요와 댓글도 함께 사라집니다.`)) void mutate((v) => void (v.posts = v.posts.filter((p) => p.id !== post.id)))
    } else if (act === 'delComment') void mutate((v) => void (v.comments = v.comments.filter((c) => c.id !== btn.dataset.id)))
  }

  async function onListSubmit(e) {
    const form = e.target.closest('form[data-act="comment"]')
    if (!form) return
    e.preventDefault()
    const input = form.querySelector('input')
    const text = input.value.trim()
    const key = form.closest('.post').dataset.key
    if (!text) return
    input.value = ''
    const ok = await mutate((v) => {
      if (v.comments.length >= M.LIMITS.comments) throw new Error('댓글이 너무 많습니다. 예전 댓글을 지운 뒤 다시 하세요.')
      v.comments.push({ id: M.newId(), key, text, at: Date.now() })
    })
    if (!ok) {
      const again = $('list').querySelector(`.post[data-key="${CSS.escape(key)}"] .comment-form input`)
      if (again) again.value = text
    }
  }

  async function init() {
    $('fCat').innerHTML = M.CATS.map((c) => `<option>${esc(c)}</option>`).join('')
    $('fPrice').innerHTML = '<option value="">모름</option>' + M.PRICES.map((p) => `<option>${esc(p)}</option>`).join('')
    renderCats()
    document.querySelector('nav').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]')
      if (!b) return
      tab = b.dataset.tab
      render()
    })
    $('cats').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]')
      if (!b) return
      cat = b.dataset.cat
      renderCats()
      render()
    })
    $('q').addEventListener('input', render)
    $('sort').addEventListener('change', () => {
      sort = $('sort').value
      render()
    })
    $('list').addEventListener('click', onListClick)
    $('list').addEventListener('submit', (e) => void onListSubmit(e))
    $('writeBtn').addEventListener('click', () => room && openEditor(null))
    $('pickBtn').addEventListener('click', () => room && showPick())
    $('pickAgain').addEventListener('click', showPick)
    $('pickClose').addEventListener('click', () => $('picker').close())
    $('editorCancel').addEventListener('click', () => $('editor').close())
    $('editorForm').addEventListener('submit', (e) => {
      e.preventDefault()
      void saveEditor()
    })
    $('fRating').addEventListener('click', (e) => {
      const b = e.target.closest('[data-n]')
      if (!b) return
      rating = Number(b.dataset.n)
      renderRating()
    })
    $('fTags').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tag]')
      if (!b) return
      if (tags.has(b.dataset.tag)) tags.delete(b.dataset.tag)
      else tags.add(b.dataset.tag)
      renderTags()
    })

    try {
      me = await call('me')
      if (!me) throw new Error('서버에 연결된 뒤에 쓸 수 있습니다.')
      call('members').then(
        (list) => {
          depts = new Map(list.map((m) => [m.id, m.deptName || '']))
          render()
        },
        () => undefined
      )
      await loadRoom()
      render()
    } catch (e) {
      $('list').innerHTML = empty('📡', '맛집 게시판을 불러오지 못했습니다', e.message || '서버 연결을 확인하세요.') + '<p style="text-align:center"><button id="retry" class="primary">다시 시도</button></p>'
      $('retry').addEventListener('click', () => location.reload())
    }

    window.TeamHub.on('room.changed', async ({ roomId, deleted }) => {
      if (!room || roomId !== room.id) return
      try {
        if (deleted) await loadRoom()
        else room = await call('rooms.get', { roomId })
        render()
      } catch {
        /* keep showing what we have */
      }
    })
  }

  void init()
})()
