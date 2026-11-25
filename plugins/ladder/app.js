/* Ladder plugin UI. Talks to TeamHub only via TeamHub.call (see __sdk.js). */
;(function () {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const L = window.Ladder
  const COLORS = ['#ef4444', '#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5']
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const call = (m, p) => window.TeamHub.call(m, p)
  // an older TeamHub does not give extension frames its look (__ui.css): say so once the page has loaded
  // line icons come from TeamHub (TeamHub.icon); an older TeamHub without them shows the text only
  const icon = (n, o) => (window.TeamHub.icon ? window.TeamHub.icon(n, o) : '')
  const empty = (name, title, body) => `<div class="th-empty compact">${icon(name)}<p class="th-empty-title">${esc(title)}</p>${body ? `<p>${esc(body)}</p>` : ''}</div>`

  let me = null
  let members = []
  let tab = 'quick'
  /** current board: { mode, title, people, results, hide, rows, grid, revealed:Set, roomId?, room? } */
  let game = null
  let animating = false

  function toast(msg) {
    const t = $('toast')
    t.textContent = msg
    t.classList.add('show')
    clearTimeout(toast.t)
    toast.t = setTimeout(() => t.classList.remove('show'), 2500)
  }

  // ---------- setup ----------
  function updateCount() {
    const n = L.parseList($('people').value).length
    $('peopleCount').textContent = n ? `${n}명` : ''
    if ($('preset').value !== 'custom') fillPreset()
  }
  function fillPreset() {
    const n = Math.max(2, L.parseList($('people').value).length)
    const kind = $('preset').value
    const winners = Number(($('optWinners') || {}).value || 1)
    const teams = Number(($('optTeams') || {}).value || 2)
    const prize = ($('optPrize') || {}).value
    if (kind !== 'custom') $('results').value = L.preset(kind, n, { winners, teams, prize: prize || undefined }).join('\n')
  }
  function renderPresetOpts() {
    const kind = $('preset').value
    const o = $('presetOpts')
    o.innerHTML =
      kind === 'winner'
        ? '<label class="opt">당첨 <input class="th-input" id="optWinners" type="number" min="1" max="29" value="1"> 명</label><label class="opt">당첨 이름 <input class="th-input" id="optPrize" placeholder="당첨"></label>'
        : kind === 'teams'
          ? '<label class="opt"><input class="th-input" id="optTeams" type="number" min="2" max="6" value="2"> 팀으로</label>'
          : kind === 'coffee'
            ? '<label class="opt">문구 <input class="th-input" id="optPrize" placeholder="커피 쏘기"></label>'
            : ''
    o.querySelectorAll('input').forEach((i) => i.addEventListener('input', fillPreset))
    fillPreset()
  }
  function readSetup() {
    const people = L.parseList($('people').value)
    if (people.length < 2) throw new Error('참여자를 2명 이상 적으세요.')
    if (people.length > 30) throw new Error('참여자는 30명까지입니다.')
    if (new Set(people).size !== people.length) throw new Error('같은 이름이 있습니다. 구분되게 적으세요(예: 김민수A).')
    const results = L.parseList($('results').value).slice(0, people.length)
    while (results.length < people.length) results.push('꽝')
    return { people, results, hide: $('hide').checked, rows: Number($('density').value) }
  }

  // ---------- board ----------
  const geo = (n, rows) => {
    const gap = Math.max(64, Math.min(110, Math.floor(900 / n)))
    const w = gap * n
    const rowH = 26
    const top = 52
    const h = top + rows * rowH + 64
    return { gap, w, h, top, rowH, x: (i) => gap / 2 + i * gap, y: (r) => (r < 0 ? top - 8 : r >= rows ? top + rows * rowH + 8 : top + (r + 0.5) * rowH) }
  }

  function startLabel(i) {
    if (game.mode !== 'room') return { text: game.people[i], taken: true }
    const name = claimName(i)
    return name ? { text: name, taken: true } : { text: '고르기', taken: false }
  }

  function renderBoard() {
    const n = game.people.length
    const g = geo(n, game.rows)
    const svg = $('ladder')
    svg.setAttribute('width', g.w)
    svg.setAttribute('height', g.h)
    svg.setAttribute('viewBox', `0 0 ${g.w} ${g.h}`)
    let s = ''
    for (let i = 0; i < n; i++) s += `<line class="rail" x1="${g.x(i)}" y1="${g.top - 8}" x2="${g.x(i)}" y2="${g.top + game.rows * g.rowH + 8}"/>`
    if (game.grid)
      game.grid.forEach((row, r) =>
        row.forEach((on, x) => {
          if (on) s += `<line class="rung" x1="${g.x(x)}" y1="${g.y(r)}" x2="${g.x(x + 1)}" y2="${g.y(r)}"/>`
        })
      )
    else s += `<text x="${g.w / 2}" y="${g.top + (game.rows * g.rowH) / 2}" text-anchor="middle" class="name free note">가로줄은 모두 고른 뒤 공개할 때 만들어집니다</text>`
    for (let i = 0; i < n; i++) {
      const l = startLabel(i)
      s += `<g class="start" data-i="${i}"><rect x="${g.x(i) - g.gap / 2 + 4}" y="4" width="${g.gap - 8}" height="30" rx="6" ${l.taken ? `fill="${COLORS[i % COLORS.length]}" opacity="0.18"` : 'class="free-box"'}/><text class="name${l.taken ? '' : ' free'}" x="${g.x(i)}" y="24" text-anchor="middle">${esc(l.text)}</text></g>`
    }
    const m = game.grid ? L.mapping(game.grid, n) : null
    for (let j = 0; j < n; j++) {
      // result j is shown when its owner path was revealed, or always if not hidden
      const owner = m ? m.indexOf(j) : -1
      const show = !game.hide || (owner >= 0 && game.revealed.has(owner))
      s += `<text class="prize${show ? '' : ' hidden-prize'}" x="${g.x(j)}" y="${g.h - 16}" text-anchor="middle">${show ? esc(game.results[j]) : '?'}</text>`
    }
    s += '<g id="paths"></g>'
    svg.innerHTML = s
    // paths already revealed stay drawn
    game.revealed.forEach((i) => drawPath(i, false))
    svg.querySelectorAll('.start').forEach((el) => el.addEventListener('click', () => onStartClick(Number(el.getAttribute('data-i')))))
    renderTable()
    $('boardTitle').textContent = game.title || '사다리'
    const isRoom = game.mode === 'room'
    const creator = isRoom && game.room && me && game.room.createdBy === me.id
    $('reshuffle').classList.toggle('hidden', isRoom)
    $('revealAll').textContent = isRoom && !game.grid ? '결과 공개' : '모두 공개'
    $('revealAll').disabled = isRoom ? (!game.grid && !creator) : false
    $('boardStatus').textContent = isRoom ? roomStatus() : '이름을 누르면 그 사람의 길을 따라갑니다.'
    $('fair').textContent = game.grid ? '가로줄은 무작위(암호학적 난수)로 만들었습니다. 출발점이 정해진 뒤 만들어지므로 미리 결과를 알 수 없습니다.' : ''
  }

  function drawPath(i, animate) {
    const n = game.people.length
    const g = geo(n, game.rows)
    const t = L.trace(game.grid, i)
    const pts = t.steps.map(([c, r]) => `${g.x(c)},${g.y(r)}`).join(' ')
    const box = document.getElementById('paths')
    const ns = 'http://www.w3.org/2000/svg'
    const pl = document.createElementNS(ns, 'polyline')
    pl.setAttribute('points', pts)
    pl.setAttribute('class', 'path')
    pl.setAttribute('stroke', COLORS[i % COLORS.length])
    pl.setAttribute('opacity', '0.85')
    box.appendChild(pl)
    if (!animate) return Promise.resolve(t.end)
    const len = pl.getTotalLength()
    pl.style.strokeDasharray = `${len}`
    pl.style.strokeDashoffset = `${len}`
    pl.getBoundingClientRect()
    pl.style.transition = `stroke-dashoffset ${Math.min(2.2, 0.6 + len / 900)}s linear`
    pl.style.strokeDashoffset = '0'
    return new Promise((res) => setTimeout(() => res(t.end), Math.min(2200, 600 + len / 0.9)))
  }

  async function reveal(i) {
    if (!game.grid || game.revealed.has(i) || animating) return
    animating = true
    await drawPath(i, true)
    game.revealed.add(i)
    animating = false
    renderBoard()
    if (game.revealed.size === game.people.length) finish()
  }

  async function revealAllPaths() {
    for (let i = 0; i < game.people.length; i++) if (!game.revealed.has(i)) await reveal(i)
  }

  function pairs() {
    if (!game.grid) return []
    const m = L.mapping(game.grid, game.people.length)
    return game.people.map((_, i) => ({ name: game.mode === 'room' ? claimName(i) || `${i + 1}번 자리` : game.people[i], result: game.results[m[i]], i }))
  }

  function renderTable() {
    const rows = pairs().filter((p) => !game.hide || game.revealed.has(p.i))
    $('resultTable').innerHTML = rows.length
      ? `<table class="th-table"><thead><tr><th>이름</th><th>결과</th></tr></thead><tbody>${rows
          .map((p) => `<tr><td><span class="swatch" style="background:${COLORS[p.i % COLORS.length]}"></span>${esc(p.name)}</td><td><b>${esc(p.result)}</b></td></tr>`)
          .join('')}</tbody></table>`
      : ''
  }

  async function finish() {
    const list = pairs()
    const hist = (await call('storage.get', { key: 'history' }).catch(() => null)) || []
    const key = game.roomId ? `room:${game.roomId}` : `quick:${game.startedAt}`
    if (!hist.some((h) => h.key === key)) {
      hist.unshift({ key, at: Date.now(), title: game.title || '사다리', mode: game.mode, pairs: list.map(({ name, result }) => ({ name, result })) })
      await call('storage.set', { key: 'history', value: hist.slice(0, 50) }).catch(() => undefined)
    }
  }

  function resultText() {
    return `[${game.title || '사다리타기'}]\n` + pairs().map((p) => `${p.name} → ${p.result}`).join('\n')
  }

  function onStartClick(i) {
    if (game.mode === 'room' && !game.grid) return claim(i)
    reveal(i)
  }

  function showBoard() {
    $('board').classList.remove('hidden')
    $('setup').classList.add('hidden')
    $('rooms').classList.add('hidden')
    renderBoard()
  }

  // ---------- together (rooms) ----------
  /** Valid claims: one line per member, the earliest claim of a line wins. */
  function claims() {
    const byLine = new Map()
    const entries = Object.entries(game.room.entries || {}).sort((a, b) => a[1].at - b[1].at)
    for (const [mid, e] of entries) {
      const line = e.value && Number.isInteger(e.value.line) ? e.value.line : -1
      if (line < 0 || line >= game.people.length || byLine.has(line)) continue
      byLine.set(line, { mid, name: e.name })
    }
    const assign = (game.room.shared && game.room.shared.assign) || {}
    for (const [line, name] of Object.entries(assign)) if (!byLine.has(Number(line))) byLine.set(Number(line), { mid: null, name })
    return byLine
  }
  function claimName(i) {
    const c = claims().get(i)
    return c ? c.name : ''
  }
  function myLine() {
    for (const [line, c] of claims()) if (me && c.mid === me.id) return line
    return -1
  }
  function roomStatus() {
    if (game.grid) return '결과가 공개되었습니다. 이름을 누르면 길을 따라갑니다.'
    const n = game.people.length
    const k = claims().size
    const mine = myLine()
    return `${k}/${n}명 고름 · ${mine >= 0 ? `내 자리: ${mine + 1}번` : '내 출발점을 누르세요'}${game.room.createdBy === (me && me.id) ? ' · 모두 고르면 "결과 공개"' : ' · 만든 사람이 공개하면 결과가 나옵니다'}`
  }
  async function claim(i) {
    const c = claims().get(i)
    if (c && (!me || c.mid !== me.id)) return toast(`${c.name}님이 고른 자리입니다.`)
    try {
      game.room = await call('rooms.setEntry', { roomId: game.roomId, value: c ? null : { line: i } })
      renderBoard()
    } catch (e) {
      toast(e.message)
    }
  }
  async function revealRoom() {
    const n = game.people.length
    const cl = claims()
    // people from the list who did not pick get the free lines at random
    const pickedNames = new Set([...cl.values()].map((c) => c.name))
    const free = L.shuffle(
      Array.from({ length: n }, (_, i) => i).filter((i) => !cl.has(i))
    )
    const rest = game.people.filter((p) => !pickedNames.has(p))
    const assign = Object.assign({}, (game.room.shared && game.room.shared.assign) || {})
    free.forEach((line, k) => {
      assign[line] = rest[k] || `${line + 1}번 자리`
    })
    const grid = L.generate(n, game.rows)
    try {
      game.room = await call('rooms.setShared', { roomId: game.roomId, shared: Object.assign({}, game.room.shared, { assign, grid, phase: 'revealed', revealedAt: Date.now() }), version: game.room.version, close: true })
      loadRoomIntoGame(game.room)
      renderBoard()
      revealAllPaths()
    } catch (e) {
      toast(e.message)
      openRoom(game.roomId)
    }
  }
  function loadRoomIntoGame(room) {
    const cfg = room.shared.config
    const was = game && game.roomId === room.id ? game.revealed : new Set()
    game = { mode: 'room', title: room.title, people: cfg.people, results: cfg.results, hide: cfg.hide, rows: cfg.rows, grid: room.shared.grid || null, revealed: room.shared.grid ? was : new Set(), roomId: room.id, room }
  }
  async function openRoom(id) {
    try {
      const room = await call('rooms.get', { roomId: id })
      const fresh = !game || game.roomId !== id || (!game.grid && room.shared.grid)
      loadRoomIntoGame(room)
      setTab('together', true)
      showBoard()
      if (fresh && game.grid && !game.revealed.size) revealAllPaths()
    } catch (e) {
      toast(e.message)
    }
  }
  async function createRoom() {
    try {
      const cfg = readSetup()
      const title = $('roomTitle').value.trim() || '사다리타기'
      const byName = new Map(members.map((m) => [m.name, m.id]))
      const ids = cfg.people.map((p) => byName.get(p)).filter(Boolean)
      const scope = $('everyone').checked ? { type: 'team', groupIds: [], memberIds: [] } : { type: 'members', groupIds: [], memberIds: [...new Set([...(me ? [me.id] : []), ...ids])] }
      const room = await call('rooms.create', { title, scope, shared: { config: cfg, phase: 'picking' } })
      toast(scope.type === 'members' ? `${ids.filter((x) => !me || x !== me.id).length}명에게 초대를 보냈습니다.` : '팀 전체에 열었습니다.')
      openRoom(room.id)
    } catch (e) {
      toast(e.message)
    }
  }
  async function listRooms() {
    const box = $('roomList')
    try {
      const rooms = await call('rooms.list')
      box.innerHTML = rooms.length
        ? rooms
            .map((r) => {
              const n = r.shared && r.shared.config ? r.shared.config.people.length : 0
              const k = Object.keys(r.entries || {}).length
              return `<div class="item"><span class="name">${esc(r.title)}</span><span class="th-badge ${r.closed ? 'th-badge-success' : ''} th-nums">${r.closed ? '결과 공개됨' : `${k}/${n}명 고름`}</span><span class="th-xs th-muted">${esc(r.createdByName)}</span><span class="th-grow"></span><button type="button" data-room="${r.id}" class="th-btn th-btn-sm ${r.closed ? 'th-btn-outline' : ''}">${r.closed ? '결과 보기' : '참여'}</button>${me && r.createdBy === me.id ? `<button type="button" data-del="${r.id}" class="th-btn th-btn-ghost th-btn-sm">${icon('trash-2')} 지우기</button>` : ''}</div>`
            })
            .join('')
        : empty('users', '진행 중인 방이 없습니다', '위에서 방을 만들면 여기에 보입니다.')
      box.querySelectorAll('[data-room]').forEach((b) => b.addEventListener('click', () => openRoom(b.getAttribute('data-room'))))
      box.querySelectorAll('[data-del]').forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm('이 방을 지울까요?')) return
          await call('rooms.delete', { roomId: b.getAttribute('data-del') }).catch((e) => toast(e.message))
          listRooms()
        })
      )
    } catch (e) {
      box.innerHTML = empty('wifi-off', '방 목록을 불러오지 못했습니다', `서버 연결이 필요합니다. ${e.message || ''}`)
    }
  }

  // ---------- history ----------
  async function renderHistory() {
    const hist = (await call('storage.get', { key: 'history' }).catch(() => null)) || []
    $('historyList').innerHTML = hist.length
      ? hist
          .map(
            (h) =>
              `<div class="item"><span class="name">${esc(h.title)}</span><span class="th-badge th-badge-muted">${h.mode === 'room' ? '함께' : '바로'}</span><span class="th-xs th-muted th-nums">${new Date(h.at).toLocaleString('ko-KR')}</span><div class="pairs th-xs">${h.pairs.map((p) => `${esc(p.name)} → <b>${esc(p.result)}</b>`).join(' · ')}</div></div>`
          )
          .join('')
      : empty('history', '아직 기록이 없습니다', '사다리의 결과가 모두 공개되면 여기에 남습니다.')
  }

  // ---------- tabs & wiring ----------
  function setTab(t, keepBoard) {
    tab = t
    document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)))
    document.body.classList.toggle('together', t === 'together')
    $('history').classList.toggle('hidden', t !== 'history')
    if (t === 'history') {
      $('setup').classList.add('hidden')
      $('board').classList.add('hidden')
      renderHistory()
      return
    }
    if (!keepBoard) {
      $('board').classList.add('hidden')
      $('setup').classList.remove('hidden')
      $('rooms').classList.toggle('hidden', t !== 'together')
      $('start').classList.toggle('hidden', t === 'together')
      if (t === 'together') listRooms()
    }
  }

  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)))
  $('people').addEventListener('input', updateCount)
  $('preset').addEventListener('change', renderPresetOpts)
  $('results').addEventListener('input', () => ($('preset').value = 'custom'))
  $('shufflePeople').addEventListener('click', () => {
    $('people').value = L.shuffle(L.parseList($('people').value)).join('\n')
  })
  $('loadMembers').addEventListener('click', async () => {
    try {
      members = await call('members')
      $('people').value = members.map((m) => m.name).join('\n')
      updateCount()
      toast(`팀원 ${members.length}명을 불러왔습니다. 빠질 사람은 지우세요.`)
    } catch (e) {
      toast(e.message)
    }
  })
  $('start').addEventListener('click', () => {
    try {
      const cfg = readSetup()
      game = Object.assign({ mode: 'quick', title: '사다리타기', grid: L.generate(cfg.people.length, cfg.rows), revealed: new Set(), startedAt: Date.now() }, cfg)
      showBoard()
    } catch (e) {
      toast(e.message)
    }
  })
  $('createRoom').addEventListener('click', createRoom)
  $('refreshRooms').addEventListener('click', listRooms)
  $('revealAll').addEventListener('click', () => {
    if (game.mode === 'room' && !game.grid) {
      const n = game.people.length
      if (claims().size < n && !confirm(`${n - claims().size}자리가 비어 있습니다. 비어 있는 자리는 참여자 목록의 남은 사람에게 무작위로 배정하고 공개할까요?`)) return
      return revealRoom()
    }
    revealAllPaths()
  })
  $('reshuffle').addEventListener('click', () => {
    game.grid = L.generate(game.people.length, game.rows)
    game.revealed = new Set()
    game.startedAt = Date.now()
    renderBoard()
  })
  $('copyResult').addEventListener('click', () => {
    if (!game.grid) return toast('아직 결과가 없습니다.')
    call('clipboard.write', { text: resultText() }).then(() => toast('결과를 복사했습니다. 메신저에 붙여넣으세요.'), (e) => toast(e.message))
  })
  $('backSetup').addEventListener('click', () => setTab(tab === 'history' ? 'quick' : tab))
  $('clearHistory').addEventListener('click', async () => {
    if (!confirm('기록을 모두 지울까요?')) return
    await call('storage.set', { key: 'history', value: [] })
    renderHistory()
  })

  // live updates from teammates
  window.TeamHub.on('room.changed', ({ roomId, deleted }) => {
    if (tab === 'together' && !$('rooms').classList.contains('hidden')) listRooms()
    if (game && game.roomId === roomId && !deleted) openRoom(roomId)
  })

  ;(async () => {
    me = await call('me').catch(() => null)
    members = await call('members').catch(() => [])
    const saved = await call('storage.get', { key: 'lastPeople' }).catch(() => null)
    if (saved) $('people').value = saved
    $('people').addEventListener('change', () => call('storage.set', { key: 'lastPeople', value: $('people').value }).catch(() => undefined))
    renderPresetOpts()
    updateCount()
    if (window.TeamHub.room) openRoom(window.TeamHub.room)
  })()
})()
