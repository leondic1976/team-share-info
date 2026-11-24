/* 관리대장 UI. Talks to TeamHub only via TeamHub.call (see __sdk.js). Logic lives in formula.js / sheet.js / store.js.
   Three kinds of ledger: 개인용 (rows in this PC's local DB), 팀용 (server, whole team or a group) and
   지정자용 (server, named people only). Every ledger is saved row by row as it is edited; on the server
   several people edit at once and a cell changed by two people is never overwritten silently. */
;(function () {
  'use strict'
  const F = window.LedgerFormula
  const S = window.LedgerSheet
  const L = window.LedgerStore
  const call = (m, p) => window.TeamHub.call(m, p)
  const $ = (id) => document.getElementById(id)
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
  // line icons of the program (TeamHub.icon); a stored value from an older version (an emoji) maps to its icon
  const icon = (n, o) => window.TeamHub.icon(n, o)
  // names sent to the server stay within 8 characters: an older server accepts no more
  const bookIcon = (v) => icon(v, { fallback: 'file' })
  /** A ticked check cell is drawn as an icon; its value (and what is copied or saved) stays the text mark. */
  const TICK = '\u2713'
  const shownText = (text) => (text === TICK ? icon('check', { label: '체크됨' }) : esc(text))
  const TYPE_ICON = { text: 'Aa', number: '123', date: '날짜', select: '목록', check: '체크', member: '팀원', calc: 'fx' }
  const MAX_ROWS = 100000
  /** Height of one row in pixels; measured after the first rows are drawn (zoom and fonts change it). */
  let ROW_H = 26
  /** Rows drawn above and below what is visible. */
  const BUFFER = 40
  const PRINT_ROWS = 20000

  // ---------- state ----------
  let index = [] // personal ledgers of this PC: [{ id, name, updatedAt, rows, icon }]
  let book = null
  let comp = null
  let view = [] // visible book row indices
  let sel = { r: 0, c: 0, r2: 0, c2: 0 } // r = position in view, c = column index
  let editing = null // { mode: 'enter' | 'edit', via: 'cell' | 'fx', rowId }
  let undoStack = []
  let redoStack = []
  let filters = {}
  let query = ''
  let members = []
  let me = null
  let saveTimer = null
  let viewing = null // shared room shown read-only

  // where the open ledger is kept, and the rows as they are stored there (see store.js)
  let src = null // { kind: 'local' | 'team', id }
  let shadow = null
  let team = null // meta of the open team ledger; null while a ledger of this PC is open
  let teamList = []
  let teamError = ''
  let online = true
  let saveFailed = false
  let saveChain = Promise.resolve()
  let teamDialogMode = null // 'create' | 'move' | 'scope'
  let pendingTeam = null
  let lastBy = '' // who changed the open team ledger last, for the bar
  const compCache = {}
  let win = { a: 0, b: 0 } // rows of `view` that are in the table right now
  let printing = false

  const grid = $('grid')
  const wrap = $('gridWrap')
  const editor = $('editor')
  const fx = $('fx')

  // ---------- helpers ----------
  function toast(text, bad) {
    const t = $('toast')
    t.textContent = text
    t.className = 'th-toast show' + (bad ? ' bad' : '')
    t.hidden = false
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => (t.hidden = true), bad ? 6000 : 2500)
  }
  const bytes = (s) => new TextEncoder().encode(s).length
  const curRow = () => view[sel.r]
  const rect = () => ({ r1: Math.min(sel.r, sel.r2), r2: Math.max(sel.r, sel.r2), c1: Math.min(sel.c, sel.c2), c2: Math.max(sel.c, sel.c2) })
  const addrOf = (vr, c) => (view[vr] === undefined ? F.colLetters(c) : F.colLetters(c) + (view[vr] + 1))
  const pad = (n) => String(n).padStart(2, '0')
  const fmtDate = (t) => {
    const d = new Date(t)
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const num = (n) => Number(n).toLocaleString('ko-KR')
  function uniqueColName(base) {
    const taken = new Set(book.cols.map((c) => c.name.toLowerCase()))
    let n = base
    for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${base} ${i}`
    return n
  }
  const iconOf = (b) => (S.TEMPLATES.find((t) => t.key === b.template) || {}).icon || 'file'
  /** The row at index r of a sheet being changed (rows are never changed in place, see store.js). */
  const W = (b, r) => L.writable(b, r)
  const setState = (text, cls) => {
    const el = $('saveState')
    el.textContent = text
    el.className = `th-badge state ${cls === 'ok' ? 'th-badge-success' : cls === 'bad' ? 'th-badge-urgent' : cls === 'busy' ? '' : 'th-badge-muted'}`
  }

  // ---------- storage: every ledger is saved by what changed ----------
  async function loadIndex() {
    index = (await call('local.list').catch(() => null)) || []
    renderBooks()
  }
  function scheduleSave() {
    setState('저장 중…', 'busy')
    clearTimeout(saveTimer)
    saveTimer = setTimeout(flush, 300)
  }
  /** Saves (and reading what others changed) run one after another. */
  function flush() {
    clearTimeout(saveTimer)
    saveTimer = null
    const p = saveChain.then(save)
    saveChain = p.catch(() => undefined)
    return p
  }
  /** Everything typed so far is saved (or has failed) when this resolves. */
  const settle = () => (saveTimer ? flush() : saveChain)
  const metaNow = () => (team ? team : src ? index.find((x) => x.id === src.id) : null)
  function savedState() {
    if (!book) return
    setState(team ? '서버에 저장됨' : '이 PC에 저장됨', 'ok')
  }

  async function save() {
    if (!book || !shadow || !src) return
    const at = src
    const sh = shadow
    const d = L.diff(book, sh)
    if (!d) return void (saveFailed || savedState())
    if (book.rows.length > MAX_ROWS) {
      setState('저장 실패: 행이 너무 많습니다', 'bad')
      return toast(`한 대장에는 ${num(MAX_ROWS)}행까지 담을 수 있습니다. 실행 취소(Ctrl+Z)로 되돌리거나 오래된 행을 다른 대장으로 나눠 주세요.`, true)
    }
    try {
      for (const piece of L.pieces(d)) {
        const answer = await call(`${at.kind}.save`, { id: at.id, change: Object.assign({}, piece, { since: sh.version, icon: piece.head ? iconOf(book) : undefined }) })
        if (src !== at) return
        took(answer.meta)
        adopt(L.settle(book, sh, piece, d, answer), '')
      }
      saveFailed = false
      // typed while the save was on its way: the next save is already scheduled
      if (!saveTimer) savedState()
    } catch (err) {
      if (src !== at) return
      if (at.kind === 'team' && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND')) {
        // I may no longer edit (or see) it: what I typed is kept as a ledger of this PC
        const mine = L.plain(book)
        src = null
        await keepCopy(mine, mine.rows, '저장 못 한 내 변경')
        setState('저장 실패', 'bad')
        toast(`${err.message} 저장하지 못한 내 내용은 "개인용 대장"에 사본으로 남겼습니다.`, true)
        loadTeamList()
        if (err.code === 'NOT_FOUND') closeSheet()
        else loadTeam(at.id, true)
      } else if (err.code === 'BAD_REQUEST' || at.kind === 'local') {
        setState('저장 실패', 'bad')
        saveFailed = true
        toast(`저장하지 못했습니다: ${err.message}`, true)
      } else {
        setState('서버에 저장하지 못함 · 다시 시도 중', 'bad')
        if (!saveFailed) toast(`서버에 저장하지 못했습니다: ${err.message} 연결되면 다시 저장합니다.`, true)
        saveFailed = true
        if (!saveTimer) saveTimer = setTimeout(flush, 5000)
      }
    }
  }
  /** New facts about the open ledger (version, row count, who saved) into its list entry. */
  function took(meta) {
    if (team) {
      Object.assign(team, meta)
      const e = teamList.find((x) => x.id === team.id)
      if (e) Object.assign(e, meta, { unseen: false })
      else teamList.unshift(Object.assign({}, meta))
    } else {
      const e = index.find((x) => x.id === meta.id)
      if (e) Object.assign(e, meta)
      else index.unshift(meta)
    }
    renderBooks()
  }
  /**
   * The result of a save or of reading others' changes goes on screen: the selection stays
   * on its row, undo is emptied (it would undo other people's work), my rows that lost
   * against someone else's edit are kept as a personal ledger.
   */
  function adopt(res, by) {
    if (res.lost && res.lost.length) {
      const lost = res.lost.map((r) => ({ id: r.id, c: r.c }))
      keepCopy(L.plain(book), lost, '저장 못 한 내 변경').then((name) =>
        toast(`다른 사람이 같은 칸을 먼저 고쳐 내 입력 ${lost.length}행은 반영되지 않았습니다. 내 입력은 개인용 대장${name ? ` "${name}"` : ''}에 남겼습니다.`, true)
      )
    }
    if (res.headRefused) toast('다른 사람이 열·이름·설명을 먼저 바꿔 내 변경은 반영되지 않았습니다. 화면을 최신 내용으로 바꿨습니다.', true)
    if (!res.rows && !res.head) return
    const keepId = (vi) => (view[vi] !== undefined && book.rows[view[vi]] ? book.rows[view[vi]].id : null)
    const a = keepId(sel.r)
    const b = keepId(sel.r2)
    book = res.book
    undoStack = []
    redoStack = []
    if (by) lastBy = `${by}님이 방금 고침 · ${fmtDate(Date.now())}`
    if (res.head) {
      $('bookName').value = book.name
      $('note').value = book.note || ''
      $('note').hidden = !book.note
      filters = {}
    }
    recompute()
    const find = (id, was) => {
      if (id === null) return Math.min(was, Math.max(0, view.length - 1))
      for (let i = 0; i < view.length; i++) if (book.rows[view[i]].id === id) return i
      return Math.min(was, Math.max(0, view.length - 1))
    }
    sel.r = find(a, sel.r)
    sel.r2 = find(b, sel.r2)
    if (editing && editing.via === 'cell' && (view[sel.r] === undefined || book.rows[view[sel.r]].id !== editing.rowId)) {
      editing = null
      editor.value = ''
      toast('고치던 행을 다른 사람이 지웠습니다.', true)
    }
    render()
    teamBar()
  }
  /** Rows of mine that could not be saved to the team ledger, kept as a ledger of this PC. Resolves to its name. */
  async function keepCopy(head, rows, why) {
    try {
      const copy = Object.assign({}, head, { name: `${head.name} (${why})`.slice(0, 60), rows })
      delete copy.share
      const meta = await call('local.create', { doc: copy, icon: iconOf(copy) })
      index.unshift(meta)
      renderBooks()
      return copy.name
    } catch {
      return '' // nothing more can be done
    }
  }

  // ---------- book list ----------
  const collapsed = new Set()
  function renderBooks() {
    const q = $('bookSearch').value.trim().toLowerCase()
    const hit = (b) => !q || b.name.toLowerCase().includes(q)
    const mine = index.filter(hit).sort((a, b) => b.updatedAt - a.updatedAt)
    $('books').innerHTML =
      mine.map((b) => `<li data-id="${esc(b.id)}" class="${src && src.kind === 'local' && src.id === b.id ? 'on' : ''}" title="${esc(b.name)}"><span class="n">${bookIcon(b.icon)} ${esc(b.name)}</span><span class="m">${num(b.rows)}행 · ${fmtDate(b.updatedAt)}</span></li>`).join('') ||
      '<li class="th-muted th-xs none">대장이 없습니다</li>'
    const shared = (picked) =>
      teamList
        .filter((t) => hit(t) && isPicked(t) === picked)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(
          (t) =>
            `<li data-team="${esc(t.id)}" class="${team && team.id === t.id ? 'on' : ''}" title="${esc(t.name)}"><span class="n">${t.unseen && !(team && team.id === t.id) ? '<i class="dot" title="다른 사람이 고친 새 내용이 있습니다"></i>' : ''}${bookIcon(t.icon)} ${esc(t.name)}${t.canEdit ? '' : ' <span class="th-badge th-badge-muted tag">보기</span>'}</span><span class="m">${num(t.rows)}행 · ${esc(t.updatedByName || t.ownerName)} · ${fmtDate(t.updatedAt)}</span></li>`
        )
    const teams = shared(false)
    const picks = shared(true)
    $('teamBooks').innerHTML = teams.join('') || `<li class="th-muted th-xs none">${esc(teamError || '팀용 대장이 없습니다')}</li>`
    $('pickBooks').innerHTML = picks.join('') || `<li class="th-muted th-xs none">${esc(teamError || '지정자용 대장이 없습니다')}</li>`
    $('cntLocal').textContent = mine.length || ''
    $('cntTeam').textContent = teams.length || ''
    $('cntPick').textContent = picks.length || ''
    for (const h of document.querySelectorAll('#side .grp')) {
      const off = collapsed.has(h.dataset.list)
      h.classList.toggle('off', off)
      $(h.dataset.list).hidden = off
    }
  }
  $('books').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]')
    if (li) openBook(li.dataset.id)
  })
  for (const list of ['teamBooks', 'pickBooks'])
    $(list).addEventListener('click', (e) => {
      const li = e.target.closest('li[data-team]')
      if (li) openTeam(li.dataset.team)
    })
  $('bookSearch').addEventListener('input', renderBooks)
  for (const h of document.querySelectorAll('#side .grp'))
    h.addEventListener('click', () => {
      if (collapsed.has(h.dataset.list)) collapsed.delete(h.dataset.list)
      else collapsed.add(h.dataset.list)
      renderBooks()
    })

  async function openBook(id) {
    await settle()
    let full
    try {
      full = await call('local.open', { id })
    } catch (err) {
      return toast(`대장을 열지 못했습니다: ${err.message}`, true)
    }
    const { doc, ...meta } = full
    const e = index.find((x) => x.id === id)
    if (e) Object.assign(e, meta)
    show(doc, meta, 'local')
  }
  /** Put a stored sheet on screen. kind: where it is kept. */
  function show(doc, meta, kind) {
    const o = L.open(doc, meta)
    book = o.book
    book.id = meta.id
    shadow = o.shadow
    src = { kind, id: meta.id }
    team = kind === 'team' ? meta : null
    lastBy = ''
    saveFailed = false
    viewing = null
    undoStack = []
    redoStack = []
    filters = {}
    query = ''
    $('search').value = ''
    sel = { r: 0, c: 0, r2: 0, c2: 0 }
    $('empty').hidden = true
    $('viewer').hidden = true
    $('sheet').hidden = false
    $('bookName').value = book.name
    $('note').value = book.note || ''
    $('note').hidden = !book.note
    wrap.scrollTop = 0
    wrap.scrollLeft = 0
    syncTeamUi()
    recompute()
    render()
    renderBooks()
    savedState()
    focusGrid()
    call('storage.set', { key: 'last', value: team ? { team: team.id } : { book: meta.id } }).catch(() => undefined)
  }
  /** A new ledger of this PC from a whole sheet ({ …head, rows: [{ id, c }] }). */
  async function addBook(doc) {
    await settle()
    const d = Object.assign({}, doc)
    delete d.id
    delete d.share
    const meta = await call('local.create', { doc: d, icon: iconOf(d) })
    index.unshift(meta)
    await openBook(meta.id)
  }
  function closeSheet() {
    book = null
    team = null
    src = null
    shadow = null
    $('sheet').hidden = true
    $('empty').hidden = false
    syncTeamUi()
    renderBooks()
  }

  // ---------- team ledgers (server) ----------
  const canEditNow = () => !team || (team.canEdit && online)
  const whyNot = () => (team.oldServer ? '서버 PC의 프로그램이 예전 버전이라 이 대장을 고칠 수 없습니다. 서버 PC를 먼저 업데이트하세요.' : !team.canEdit ? '보기 전용 대장입니다. 만든 사람과 관리자만 고칠 수 있습니다.' : '서버에 연결되지 않아 이 대장을 고칠 수 없습니다(보기만 가능).')
  /** 지정자용: shared with named people only. 팀용: the whole team or a group. */
  const isPicked = (t) => t.scope.type === 'members'
  /** HTML: icon + name of the kind of a shared ledger */
  const kindName = (t) => (isPicked(t) ? `${icon('user')} 지정자용` : `${icon('users')} 팀용`)
  const scopeText = (sc) => (sc.type === 'team' ? '팀 전체' : sc.type === 'group' ? `${sc.groups.map((g) => g.name).join(', ')} 그룹` : `지정한 사람 ${sc.members.length}명(${sc.members.map((m) => m.name).join(', ')})`)

  async function loadTeamList() {
    try {
      teamList = (await call('team.list')) || []
      teamError = ''
    } catch (err) {
      teamList = []
      teamError = online ? `불러오지 못했습니다: ${err.message}` : '서버에 연결되면 보입니다'
    }
    renderBooks()
  }
  async function openTeam(id, keep) {
    await settle()
    return loadTeam(id, keep)
  }
  /** Read a team ledger and show it. keep: stay where I was (the same ledger read again). */
  async function loadTeam(id, keep) {
    let full
    try {
      full = await call('team.open', { id })
    } catch (err) {
      return toast(`대장을 열지 못했습니다: ${err.message}`, true)
    }
    const { doc, ...meta } = full
    const at = keep && team && team.id === id ? { sel: { ...sel }, filters, query, top: wrap.scrollTop, left: wrap.scrollLeft } : null
    const e = teamList.find((x) => x.id === id)
    if (e) Object.assign(e, meta, { unseen: false })
    show(doc, meta, 'team')
    call('seen').catch(() => undefined)
    if (at) {
      sel = at.sel
      filters = at.filters
      query = at.query
      $('search').value = query
      recompute()
      render()
      wrap.scrollTop = at.top
      wrap.scrollLeft = at.left
    }
  }
  /** Somebody else saved: their rows go into the sheet on screen, mine stay. */
  function pull(id, version, by) {
    const p = saveChain.then(async () => {
      if (!team || team.id !== id || !shadow || version <= shadow.version) return
      const at = src
      let ch
      try {
        ch = await call('team.pull', { id, since: shadow.version })
      } catch {
        return
      }
      if (src !== at) return
      if (ch.full) {
        // away for too long to catch up row by row
        await save()
        if (src === at) await loadTeam(id, true)
        return
      }
      adopt(L.merge(book, shadow, ch), by)
      team.version = shadow.version
      team.rows = book.rows.length
      team.name = book.name
      status()
      call('seen').catch(() => undefined)
    })
    saveChain = p.catch(() => undefined)
    return p
  }
  function teamBar() {
    const bar = $('teamBar')
    bar.hidden = !src
    document.body.classList.toggle('readonly', !!team && !canEditNow())
    if (!src) return
    if (!team) {
      bar.className = 'teambar local'
      bar.innerHTML = '<b>' + icon('lock') + ' 개인용</b><span>이 PC의 로컬 DB에 저장 · 나만 봅니다</span><span class="st">고치는 대로 자동 저장</span>'
      return
    }
    const [state, cls, pic] = team.oldServer
      ? ['서버 PC를 업데이트해야 고칠 수 있습니다 · 보기만 가능', 'ro', 'triangle-alert']
      : !team.canEdit
        ? ['보기 전용 · 만든 사람과 관리자만 고칩니다', 'ro', 'eye']
      : !online
        ? ['서버에 연결되지 않음 · 보기만 가능', 'ro', 'triangle-alert']
        : [lastBy || '함께 편집 · 고치는 대로 저장되고 다른 사람 화면에 바로 보입니다', lastBy ? 'me' : '']
    bar.className = `teambar ${cls}`
    bar.innerHTML = `<b>${kindName(team)}</b><span>${esc(scopeText(team.scope))}</span><span>만든 사람 ${esc(team.ownerName)}</span><span class="st" id="teamState2">${pic ? icon(pic) + ' ' : ''}${esc(state)}</span>`
  }
  function syncTeamUi() {
    teamBar()
    const item = (act) => $('moreMenu').querySelector(`[data-act="${act}"]`)
    item('share').hidden = !!team
    item('toTeam').hidden = !!team
    item('teamScope').hidden = !team || !team.canManage
    item('delete').hidden = !!team && !team.canManage
    item('dup').textContent = team ? '개인용 대장으로 사본 받기' : '대장 복제'
    $('bookName').readOnly = !!team && !team.canEdit
    $('note').readOnly = !!team && !team.canEdit
  }
  window.TeamHub.on('online', (d) => {
    online = !!(d && d.online)
    if (!online) teamError = '서버에 연결되면 보입니다'
    teamBar()
    // what could not be saved while the server was away goes now
    if (online && saveFailed && team) flush()
  })
  let deaf = false
  let listTimer = null
  /** The list follows other people's saves a little later (somebody typing saves several times a second). */
  const listSoon = () => {
    if (!listTimer)
      listTimer = setTimeout(() => {
        listTimer = null
        loadTeamList()
      }, 3000)
  }
  window.TeamHub.on('team.changed', async (d) => {
    if (deaf) return
    if (d && d.id && d.version && !d.deleted && !d.shared) {
      // somebody saved rows
      const e = teamList.find((x) => x.id === d.id)
      if (team && team.id === d.id) {
        if (e) e.unseen = false
        if (shadow && d.version > shadow.version) pull(d.id, d.version, me && d.byId === me.id ? '' : d.byName || '')
      } else if (e && !(me && d.byId === me.id)) {
        e.unseen = true
        renderBooks()
      }
      return listSoon()
    }
    await loadTeamList()
    const t = team
    if (!t || (d && d.id && d.id !== t.id)) return
    if (d && d.deleted) {
      closeSheet()
      return toast('이 대장은 삭제되었습니다(만든 사람과 관리자는 휴지통에서 되살릴 수 있습니다).', true)
    }
    const m = teamList.find((x) => x.id === t.id)
    if (!m) {
      if (teamError) return
      closeSheet()
      return toast('이 대장을 더 볼 수 없게 되었습니다(볼 수 있는 사람이 바뀌었거나 삭제됨).', true)
    }
    if (shadow && m.version > shadow.version) return pull(t.id, m.version, me && m.updatedById === me.id ? '' : m.updatedByName || '')
    const { unseen: _u, ...rest } = m
    Object.assign(t, rest)
    syncTeamUi()
  })

  // audience dialog: new team ledger, move a ledger of this PC to the team, change the audience
  async function openTeamDialog(mode, kind) {
    teamDialogMode = mode
    const sc = mode === 'scope' ? team.scope : null
    $('teamTitle').textContent = mode === 'scope' ? '볼 수 있는 사람 · 편집 권한' : mode === 'move' ? '팀용·지정자용으로 올리기' : kind === 'members' ? '새 지정자용 대장' : '새 팀용 대장'
    $('teamGo').textContent = mode === 'scope' ? '저장' : mode === 'move' ? '올리기' : '만들기'
    $('teamKeepRow').hidden = mode !== 'move'
    $('teamKeep').checked = false
    $('teamStateMsg').textContent = ''
    $('teamEdit').value = mode === 'scope' ? team.editMode : 'all'
    try {
      members = (await call('members')) || members
    } catch {
      /* keep what we have */
    }
    const groups = (await call('groups').catch(() => [])) || []
    const type = sc ? sc.type : kind === 'members' ? 'members' : 'team'
    const gOn = new Set(sc ? sc.groups.map((g) => g.id) : [])
    const mOn = new Set(sc ? sc.members.map((m) => m.id) : [])
    // groups I am not in (an admin may have picked them) stay listed so saving does not drop them
    const allGroups = [...groups, ...(sc ? sc.groups.filter((g) => !groups.some((x) => x.id === g.id)) : [])]
    $('teamGroups').innerHTML = allGroups.map((g) => `<label class="th-check"><input type="checkbox" value="${esc(g.id)}"${gOn.has(g.id) ? ' checked' : ''} /> ${esc(g.name)}</label>`).join('') || '<span class="th-muted th-xs">내가 속한 그룹이 없습니다.</span>'
    $('teamMembers').innerHTML = members
      .filter((m) => !me || m.id !== me.id)
      .map((m) => `<label class="th-check"><input type="checkbox" value="${esc(m.id)}"${mOn.has(m.id) ? ' checked' : ''} /> ${esc(m.name)}</label>`)
      .join('')
    document.querySelector(`input[name="teamTo"][value="${type}"]`).checked = true
    syncTeamDialog()
    $('teamDialog').showModal()
  }
  function syncTeamDialog() {
    const type = document.querySelector('input[name="teamTo"]:checked').value
    $('teamGroups').hidden = type !== 'group'
    $('teamMembers').hidden = type !== 'members'
  }
  document.querySelectorAll('input[name="teamTo"]').forEach((r) => r.addEventListener('change', syncTeamDialog))
  $('teamGo').onclick = async () => {
    const mode = teamDialogMode
    const type = document.querySelector('input[name="teamTo"]:checked').value
    const groupIds = type === 'group' ? [...$('teamGroups').querySelectorAll('input:checked')].map((x) => x.value) : []
    const memberIds = type === 'members' ? [...$('teamMembers').querySelectorAll('input:checked')].map((x) => x.value) : []
    if (type === 'group' && !groupIds.length) return ($('teamStateMsg').textContent = '그룹을 고르세요.')
    if (type === 'members' && !memberIds.length) return ($('teamStateMsg').textContent = '함께 쓸 사람을 지정하세요.')
    const scope = { type, groupIds, memberIds }
    const editMode = $('teamEdit').value
    $('teamStateMsg').textContent = '저장하는 중…'
    try {
      if (mode === 'scope') {
        const meta = await call('team.update', { id: team.id, scope, editMode })
        Object.assign(team, meta)
        syncTeamUi()
        toast('볼 수 있는 사람과 편집 권한을 바꿨습니다.')
      } else {
        if (mode === 'move') await settle()
        const from = mode === 'move' ? src : null
        const doc = mode === 'move' ? L.plain(book) : pendingTeam
        const oldShare = doc.share
        delete doc.share
        delete doc.id
        const full = await call('team.create', { doc, scope, editMode, icon: iconOf(doc) })
        if (from && !$('teamKeep').checked) {
          // one ledger, one place: the copy on this PC (and its read-only share) goes to the trash
          if (oldShare) await call('rooms.delete', { roomId: oldShare.roomId }).catch(() => undefined)
          await call('local.delete', { id: from.id })
          index = index.filter((x) => x.id !== from.id)
        }
        const { doc: saved, ...meta } = full
        show(saved, meta, 'team')
        toast(`${isPicked(meta) ? '지정자용' : '팀용'} 대장${mode === 'move' ? '으로 올렸습니다. 이제 함께 쓸 수 있습니다.' : '을 만들었습니다.'}`)
      }
      pendingTeam = null
      $('teamDialog').close()
      loadTeamList()
    } catch (err) {
      $('teamStateMsg').textContent = `하지 못했습니다: ${err.message}`
    }
  }

  // ---------- compute & render ----------
  function recompute() {
    comp = S.compute(book, compCache)
    view = S.filterRows(book, comp.values, query, filters)
    sel.r = Math.min(sel.r, Math.max(0, view.length - 1))
    sel.r2 = Math.min(sel.r2, Math.max(0, view.length - 1))
    sel.c = Math.max(0, Math.min(sel.c, book.cols.length - 1))
    sel.c2 = Math.max(0, Math.min(sel.c2, book.cols.length - 1))
    $('clearFilter').hidden = !query && !Object.keys(filters).length
  }

  function cellHtml(vi, r, c) {
    const col = book.cols[c]
    const v = comp.values[r][c]
    const raw = book.rows[r].c[col.id]
    const cls = []
    if (col.type === 'calc') cls.push('calc')
    if (typeof raw === 'string' && raw.startsWith('=') && col.type !== 'calc') cls.push('fml')
    if (F.isErr(v)) cls.push('err')
    else if (typeof v === 'number') cls.push('num')
    if (col.type === 'check') cls.push('chk')
    if (S.invalid(col, raw)) cls.push('bad')
    const text = S.display(v, col)
    return `<td data-v="${vi}" data-c="${c}"${cls.length ? ` class="${cls.join(' ')}"` : ''}${text.length > 12 ? ` title="${esc(text)}"` : ''}>${shownText(text)}</td>`
  }

  /** Head, totals and the visible rows. Only the rows near what is visible are in the table (large ledgers). */
  function render() {
    const cols = book.cols
    let h = '<colgroup><col style="width:52px">' + cols.map((c) => `<col style="width:${c.width || 120}px">`).join('') + '</colgroup><thead><tr><th class="rn">No.</th>'
    cols.forEach((c, i) => {
      h += `<th data-c="${i}"><div class="hc${filters[i] ? ' filtered' : ''}" data-h="${i}"><span class="l">${F.colLetters(i)}<span class="ty">${TYPE_ICON[c.type] || ''}</span></span><span class="t" title="${esc(c.name)}${c.type === 'calc' ? ' · ' + esc(c.calc || '') : ''}">${esc(c.name)}</span><button class="menuBtn" data-menu="${i}" tabindex="-1" aria-label="${esc(c.name)} 열 메뉴">${icon('chevron-down')}</button><span class="rz" data-rz="${i}"></span></div></th>`
    })
    h += '</tr></thead><tbody></tbody>'
    if (cols.some((c) => c.total && c.total !== 'none')) {
      h += '<tfoot><tr><td class="rn">합계</td>'
      cols.forEach((c, i) => {
        const kind = c.total || 'none'
        if (kind === 'none') return (h += `<td data-total="${i}"></td>`)
        const t = S.total(comp.values, i, kind, view)
        const shown = kind === 'count' || kind === 'checked' ? String(t) : S.display(t, c)
        h += `<td data-total="${i}" class="num" title="${esc(S.TOTALS[kind])}"><span class="k">${esc(S.TOTALS[kind].replace(/\(.*\)/, ''))}</span>${esc(shown)}</td>`
      })
      h += '</tr></tfoot>'
    }
    grid.innerHTML = h
    renderRows()
    status()
  }
  function renderRows() {
    const n = view.length
    // printing: from the first row; on screen: around what is visible
    const b = printing ? Math.min(n, PRINT_ROWS) : Math.min(n, Math.ceil((wrap.scrollTop + (wrap.clientHeight || 600)) / ROW_H) + BUFFER)
    const a = printing ? 0 : Math.max(0, Math.min(Math.floor(wrap.scrollTop / ROW_H) - BUFFER, b - 2 * BUFFER))
    const cols = book.cols.length
    const gap = (rows) => (rows > 0 ? `<tr class="sp"><td colspan="${cols + 1}" style="height:${rows * ROW_H}px"></td></tr>` : '')
    const parts = [gap(a)]
    for (let vi = a; vi < b; vi++) {
      const r = view[vi]
      let row = `<tr data-v="${vi}"><td class="rn" data-rn="${vi}">${r + 1}</td>`
      for (let c = 0; c < cols; c++) row += cellHtml(vi, r, c)
      parts.push(row + '</tr>')
    }
    parts.push(gap(n - b))
    grid.tBodies[0].innerHTML = parts.join('')
    win = { a, b }
    painted = []
    if (b > a && !printing) {
      const h = grid.tBodies[0].rows[a > 0 ? 1 : 0].getBoundingClientRect().height
      if (h > 8 && Math.abs(h - ROW_H) > 0.01) {
        // the rows are not as high as assumed: lay the table out again with the real height
        const top = wrap.scrollTop / ROW_H
        ROW_H = h
        wrap.scrollTop = top * ROW_H
        return renderRows()
      }
    }
    paint()
  }
  /** Scrolled near the end of the rows that are in the table: put the next ones in. */
  function onScroll() {
    if (!book || printing) return
    const first = Math.floor(wrap.scrollTop / ROW_H)
    const last = Math.ceil((wrap.scrollTop + wrap.clientHeight) / ROW_H)
    if ((win.a > 0 && first < win.a + 8) || (win.b < view.length && last > win.b - 8)) renderRows()
    else if (editing && editing.via === 'cell') placeEditor()
  }

  let painted = []
  function tdAt(vi, c) {
    if (vi < win.a || vi >= win.b) return null
    const tr = grid.tBodies[0] && grid.tBodies[0].rows[vi - win.a + (win.a > 0 ? 1 : 0)]
    return tr ? tr.cells[c + 1] : null
  }
  function paint() {
    for (const td of painted) td.classList.remove('in', 'cur')
    painted = []
    if (!view.length || !book.cols.length) return placeEditor()
    const { r1, r2, c1, c2 } = rect()
    const many = r1 !== r2 || c1 !== c2
    if (many)
      for (let r = Math.max(r1, win.a); r <= Math.min(r2, win.b - 1); r++)
        for (let c = c1; c <= c2; c++) {
          const td = tdAt(r, c)
          if (td) {
            td.classList.add('in')
            painted.push(td)
          }
        }
    const cur = tdAt(sel.r, sel.c)
    if (cur) {
      cur.classList.add('cur')
      painted.push(cur)
    }
    $('addr').textContent = many ? `${addrOf(r1, c1)}:${addrOf(r2, c2)}` : addrOf(sel.r, sel.c)
    if (!(editing && editing.via === 'fx')) fx.value = curRow() === undefined ? '' : S.editText(book.cols[sel.c], book.rows[curRow()].c[book.cols[sel.c].id])
    selInfo()
    placeEditor()
  }
  function status() {
    const filtered = view.length !== book.rows.length
    $('stat').textContent = `${filtered ? `${num(view.length)}행 보임 / ` : ''}${num(book.rows.length)}행 · ${book.cols.length}열`
  }
  function selInfo() {
    const { r1, r2, c1, c2 } = rect()
    if (r1 === r2 && c1 === c2) return ($('selInfo').textContent = '')
    let n = 0
    let cnt = 0
    let sum = 0
    for (let r = r1; r <= r2; r++)
      for (let c = c1; c <= c2; c++) {
        const v = comp.values[view[r]] ? comp.values[view[r]][c] : ''
        if (v !== '' && v !== false) cnt++
        if (typeof v === 'number') {
          n++
          sum += v
        }
      }
    $('selInfo').textContent = n ? `합계 ${S.display(sum, {})} · 평균 ${S.display(Math.round((sum / n) * 100) / 100, {})} · 개수 ${num(cnt)}` : `개수 ${num(cnt)}`
  }

  function scrollToCell() {
    const head = grid.tHead ? grid.tHead.offsetHeight : 0
    const foot = grid.tFoot ? grid.tFoot.offsetHeight : 0
    const top = head + sel.r * ROW_H
    if (top - head < wrap.scrollTop) wrap.scrollTop = top - head
    else if (top + ROW_H > wrap.scrollTop + wrap.clientHeight - foot) wrap.scrollTop = top + ROW_H - wrap.clientHeight + foot
    if (sel.r < win.a || sel.r >= win.b) renderRows()
    const td = tdAt(sel.r, sel.c)
    if (!td) return
    // the row is in the table now: its real place decides
    if (td.offsetTop - head < wrap.scrollTop) wrap.scrollTop = td.offsetTop - head
    else if (td.offsetTop + td.offsetHeight > wrap.scrollTop + wrap.clientHeight - foot) wrap.scrollTop = td.offsetTop + td.offsetHeight - wrap.clientHeight + foot
    const left = 52
    if (td.offsetLeft - left < wrap.scrollLeft) wrap.scrollLeft = td.offsetLeft - left
    else if (td.offsetLeft + td.offsetWidth > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = td.offsetLeft + td.offsetWidth - wrap.clientWidth
  }

  // The editor input sits over the active cell all the time (invisible until typing), so that
  // Korean IME input starts in the right place and copy/paste events reach us.
  function placeEditor() {
    const td = tdAt(sel.r, sel.c)
    if (!td) {
      editor.style.left = '-9999px'
      return
    }
    editor.style.left = `${td.offsetLeft}px`
    editor.style.top = `${td.offsetTop}px`
    editor.style.width = `${Math.max(td.offsetWidth, editing ? 160 : 0)}px`
    editor.style.height = `${td.offsetHeight}px`
    editor.style.opacity = editing && editing.via === 'cell' ? '1' : '0'
  }
  function focusGrid() {
    editor.hidden = false
    if (!editing) editor.value = ''
    placeEditor()
    editor.focus({ preventScroll: true })
  }

  // ---------- changes ----------
  /**
   * Every edit goes through here. `fn` changes the sheet; rows are written through W() (a
   * row is never changed in place), so undo only has to remember the old list of rows.
   */
  function change(fn) {
    if (!canEditNow()) return toast(whyNot(), true)
    undoStack.push({ head: L.headText(book), rows: book.rows })
    while (undoStack.length > 80 || (undoStack.length > 5 && undoStack.length * book.rows.length > 4e6)) undoStack.shift()
    redoStack = []
    book.rows = book.rows.slice()
    fn(book)
    L.seal(book.rows)
    recompute()
    render()
    scheduleSave()
  }
  function undo(dir) {
    const from = dir > 0 ? redoStack : undoStack
    const to = dir > 0 ? undoStack : redoStack
    if (!from.length) return
    if (!canEditNow()) return toast(whyNot(), true)
    to.push({ head: L.headText(book), rows: book.rows })
    const e = from.pop()
    book = Object.assign(JSON.parse(e.head), { id: book.id, rows: e.rows })
    $('bookName').value = book.name
    $('note').value = book.note || ''
    recompute()
    render()
    scheduleSave()
  }
  $('undo').onclick = () => (undo(-1), focusGrid())
  $('redo').onclick = () => (undo(1), focusGrid())

  function move(dr, dc, extend) {
    if (!view.length) return
    const r = Math.max(0, Math.min(view.length - 1, (extend ? sel.r2 : sel.r) + dr))
    const c = Math.max(0, Math.min(book.cols.length - 1, (extend ? sel.c2 : sel.c) + dc))
    if (extend) {
      sel.r2 = r
      sel.c2 = c
    } else sel = { r, c, r2: r, c2: c }
    const keep = { r: sel.r, c: sel.c }
    if (extend) {
      sel.r = sel.r2
      sel.c = sel.c2
      scrollToCell()
      sel.r = keep.r
      sel.c = keep.c
    } else scrollToCell()
    paint()
  }
  function setCell(b, r, c, text) {
    const col = b.cols[c]
    if (col.type === 'calc') {
      const f = String(text).trim()
      col.calc = f === '' ? '' : f.startsWith('=') ? f : `=${f}`
      return
    }
    const v = S.parseInput(col, text)
    const row = W(b, r)
    if (v === '') delete row.c[col.id]
    else row.c[col.id] = v
  }

  // ---------- editing ----------
  function startEdit(mode, via, initial) {
    if (!view.length || !book.cols.length) return
    if (!canEditNow()) {
      editor.value = '' // the key that was typed must not stay in the input box over the cell
      return toast(whyNot(), true)
    }
    const col = book.cols[sel.c]
    if (col.type === 'check' && via === 'cell') {
      editor.value = ''
      toggleChecks()
      return
    }
    if (via === 'cell') scrollToCell()
    editing = { mode, via, rowId: book.rows[curRow()].id, was: S.editText(col, book.rows[curRow()].c[col.id]) }
    if (via === 'cell') {
      if (initial !== undefined) editor.value = initial
      else editor.value = S.editText(col, book.rows[curRow()].c[col.id])
      const opts = col.type === 'select' ? col.options || [] : col.type === 'member' ? members.map((m) => m.name) : []
      $('editorList').innerHTML = opts.map((o) => `<option value="${esc(o)}"></option>`).join('')
      if (opts.length) editor.setAttribute('list', 'editorList')
      else editor.removeAttribute('list')
      placeEditor()
      editor.focus({ preventScroll: true })
      if (mode === 'edit') editor.setSelectionRange(editor.value.length, editor.value.length)
      if (col.type === 'calc') toast('계산 열: 고친 식이 이 열의 모든 행에 적용됩니다.')
    }
  }
  function commit(text) {
    const r = curRow()
    const c = sel.c
    const was = editing ? editing.was : undefined
    editing = null
    editor.removeAttribute('list')
    if (r === undefined) return
    const col = book.cols[c]
    const now = S.editText(col, book.rows[r].c[col.id])
    if (now === text) return paint()
    if (team && was !== undefined && now !== was) {
      // somebody else's value arrived in this very cell while I was typing: theirs is not overwritten
      paint()
      return toast(`입력하는 동안 다른 사람이 이 칸을 “${now}”(으)로 고쳤습니다. 내 입력 “${text}”은(는) 반영하지 않았습니다. 필요하면 다시 입력하세요.`, true)
    }
    change((b) => setCell(b, r, c, text))
  }
  function cancelEdit() {
    editing = null
    editor.value = ''
    editor.removeAttribute('list')
    paint()
    focusGrid()
  }

  editor.addEventListener('compositionstart', () => {
    if (!editing) {
      editor.value = ''
      startEdit('enter', 'cell', '')
    }
  })
  editor.addEventListener('input', () => {
    if (!editing) startEdit('enter', 'cell', editor.value)
  })
  editor.addEventListener('blur', () => {
    if (editing && editing.via === 'cell' && !editor.matches(':focus')) {
      const t = editor.value
      setTimeout(() => {
        if (editing && editing.via === 'cell' && document.activeElement !== editor) {
          commit(t)
          editor.value = ''
        }
      }, 0)
    }
  })

  editor.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return
    if (editing) {
      if (e.key === 'Enter' && !e.altKey) {
        e.preventDefault()
        const t = editor.value
        editor.value = ''
        commit(t)
        move(e.shiftKey ? -1 : 1, 0)
      } else if (e.key === 'Tab') {
        e.preventDefault()
        const t = editor.value
        editor.value = ''
        commit(t)
        move(0, e.shiftKey ? -1 : 1)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancelEdit()
      } else if (editing.mode === 'enter' && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault()
        const t = editor.value
        editor.value = ''
        commit(t)
        move(e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0, e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0)
      } else if (e.key === 'F2') {
        editing.mode = editing.mode === 'edit' ? 'enter' : 'edit'
      }
      return
    }
    navKey(e)
  })

  function navKey(e) {
    const ctrl = e.ctrlKey || e.metaKey
    const k = e.key
    const nav = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    const page = Math.max(5, Math.floor(wrap.clientHeight / ROW_H) - 3)
    if (nav[k]) {
      e.preventDefault()
      const [dr, dc] = nav[k]
      if (ctrl) {
        const r = dr ? (dr < 0 ? 0 : view.length - 1) : e.shiftKey ? sel.r2 : sel.r
        const c = dc ? (dc < 0 ? 0 : book.cols.length - 1) : e.shiftKey ? sel.c2 : sel.c
        move(r - (e.shiftKey ? sel.r2 : sel.r), c - (e.shiftKey ? sel.c2 : sel.c), e.shiftKey)
      } else move(dr, dc, e.shiftKey)
    } else if (k === 'Tab') {
      e.preventDefault()
      move(0, e.shiftKey ? -1 : 1)
    } else if (k === 'Enter') {
      e.preventDefault()
      move(e.shiftKey ? -1 : 1, 0)
    } else if (k === 'F2') {
      e.preventDefault()
      startEdit('edit', 'cell')
    } else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault()
      clearSelection()
    } else if (k === 'Home') {
      e.preventDefault()
      move(ctrl ? -sel.r : 0, -sel.c)
    } else if (k === 'End') {
      e.preventDefault()
      move(ctrl ? view.length - 1 - sel.r : 0, book.cols.length - 1 - sel.c)
    } else if (k === 'PageDown' || k === 'PageUp') {
      e.preventDefault()
      move(k === 'PageDown' ? page : -page, 0, e.shiftKey)
    } else if (k === ' ' && book.cols[sel.c] && book.cols[sel.c].type === 'check') {
      e.preventDefault()
      toggleChecks()
    } else if (ctrl && (k === 'z' || k === 'Z') && !e.shiftKey) {
      e.preventDefault()
      undo(-1)
    } else if (ctrl && (k === 'y' || k === 'Y' || ((k === 'z' || k === 'Z') && e.shiftKey))) {
      e.preventDefault()
      undo(1)
    } else if (ctrl && (k === 'a' || k === 'A')) {
      e.preventDefault()
      sel = { r: 0, c: 0, r2: view.length - 1, c2: book.cols.length - 1 }
      paint()
    } else if (ctrl && (k === 'f' || k === 'F')) {
      e.preventDefault()
      $('search').focus()
      $('search').select()
    } else if (ctrl && (k === 's' || k === 'S')) {
      e.preventDefault()
      if (e.shiftKey) openSaveAs()
      else flush().then(() => saveFailed || toast('저장되었습니다. 대장은 고치는 대로 자동 저장됩니다.'))
    } else if (ctrl && k === ';') {
      e.preventDefault()
      const r = curRow()
      const c = sel.c
      if (r !== undefined) change((b) => setCell(b, r, c, F.serialToDate(F.todaySerial())))
    } else if (k === 'ContextMenu' || (e.shiftKey && k === 'F10')) {
      e.preventDefault()
      const td = tdAt(sel.r, sel.c)
      if (td) {
        const b = td.getBoundingClientRect()
        cellMenu(b.left + 10, b.bottom)
      }
    }
  }

  function toggleChecks() {
    const { r1, r2, c1, c2 } = rect()
    const cols = []
    for (let c = c1; c <= c2; c++) if (book.cols[c].type === 'check') cols.push(c)
    if (!cols.length) return
    const allOn = cols.every((c) => {
      for (let r = r1; r <= r2; r++) if (comp.values[view[r]][c] !== true) return false
      return true
    })
    const rows = view.slice(r1, r2 + 1)
    change((b) => {
      for (const r of rows) {
        const row = W(b, r)
        for (const c of cols) row.c[b.cols[c].id] = !allOn
      }
    })
  }
  function clearSelection() {
    const { r1, r2, c1, c2 } = rect()
    const rows = view.slice(r1, r2 + 1)
    change((b) => {
      for (const r of rows) {
        let row = null
        for (let c = c1; c <= c2; c++) {
          const id = b.cols[c].id
          if (b.cols[c].type === 'calc' || b.rows[r].c[id] === undefined) continue
          row = row || W(b, r)
          delete row.c[id]
        }
      }
    })
  }

  // formula bar
  fx.addEventListener('focus', () => {
    if (curRow() !== undefined) editing = { mode: 'edit', via: 'fx', rowId: book.rows[curRow()].id, was: S.editText(book.cols[sel.c], book.rows[curRow()].c[book.cols[sel.c].id]) }
  })
  fx.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      editing = null
      commit(fx.value)
      focusGrid()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      editing = null
      paint()
      focusGrid()
    }
  })
  fx.addEventListener('blur', () => {
    if (editing && editing.via === 'fx') editing = null
  })

  // ---------- mouse ----------
  let dragging = false
  wrap.addEventListener('mousedown', (e) => {
    if (e.target === editor) return
    if (e.button === 2) return
    const td = e.target.closest('td[data-c]')
    const rn = e.target.closest('td[data-rn]')
    const hc = e.target.closest('[data-h]')
    if (e.target.dataset.rz !== undefined) return startResize(e, +e.target.dataset.rz)
    if (e.target.dataset.menu !== undefined) {
      e.preventDefault()
      const b = e.target.getBoundingClientRect()
      return colMenu(+e.target.dataset.menu, b.left, b.bottom)
    }
    if (editing && editing.via === 'cell') {
      const t = editor.value
      editor.value = ''
      commit(t)
    }
    if (td) {
      e.preventDefault()
      const vi = +td.dataset.v
      const c = +td.dataset.c
      if (e.shiftKey) {
        sel.r2 = vi
        sel.c2 = c
      } else sel = { r: vi, c, r2: vi, c2: c }
      dragging = true
      paint()
      focusGrid()
      if (!e.shiftKey && book.cols[c].type === 'check' && e.detail === 1 && e.offsetX >= 0) toggleChecks()
    } else if (rn) {
      e.preventDefault()
      const vi = +rn.dataset.rn
      if (e.shiftKey) sel.r2 = vi
      else sel = { r: vi, c: 0, r2: vi, c2: book.cols.length - 1 }
      sel.c = 0
      sel.c2 = book.cols.length - 1
      dragging = 'rows'
      paint()
      focusGrid()
    } else if (hc) {
      e.preventDefault()
      const c = +hc.dataset.h
      if (e.shiftKey) sel.c2 = c
      else sel = { r: 0, c, r2: Math.max(0, view.length - 1), c2: c }
      paint()
      focusGrid()
    } else if (e.target.closest('td[data-total]')) {
      e.preventDefault()
      openColDialog(+e.target.closest('td[data-total]').dataset.total, 'total')
    }
  })
  wrap.addEventListener('mousemove', (e) => {
    if (!dragging || !(e.buttons & 1)) return (dragging = false)
    const td = e.target.closest(dragging === 'rows' ? 'td[data-rn], td[data-c]' : 'td[data-c]')
    if (!td) return
    const vi = +(td.dataset.v ?? td.dataset.rn)
    if (dragging === 'rows') sel.r2 = vi
    else {
      sel.r2 = vi
      sel.c2 = +td.dataset.c
    }
    paint()
  })
  window.addEventListener('mouseup', () => (dragging = false))
  wrap.addEventListener('dblclick', (e) => {
    const td = e.target.closest('td[data-c]')
    if (td && book.cols[+td.dataset.c].type !== 'check') startEdit('edit', 'cell')
    if (e.target.closest('.hc .t')) openColDialog(+e.target.closest('[data-h]').dataset.h)
  })
  wrap.addEventListener('contextmenu', (e) => {
    const td = e.target.closest('td[data-c], td[data-rn]')
    const hc = e.target.closest('[data-h]')
    if (!td && !hc) return
    e.preventDefault()
    if (hc) return colMenu(+hc.dataset.h, e.clientX, e.clientY)
    const vi = +(td.dataset.v ?? td.dataset.rn)
    const { r1, r2 } = rect()
    if (vi < r1 || vi > r2) {
      const c = td.dataset.c !== undefined ? +td.dataset.c : 0
      sel = { r: vi, c, r2: vi, c2: c }
      paint()
    }
    cellMenu(e.clientX, e.clientY)
  })

  function startResize(e, c) {
    e.preventDefault()
    const startX = e.clientX
    const startW = book.cols[c].width || 120
    const colEl = grid.querySelectorAll('colgroup col')[c + 1]
    let w = startW
    const mm = (ev) => {
      w = Math.max(40, Math.min(600, startW + ev.clientX - startX))
      colEl.style.width = `${w}px`
    }
    const mu = () => {
      window.removeEventListener('mousemove', mm)
      window.removeEventListener('mouseup', mu)
      if (w !== startW) change((b) => (b.cols[c].width = Math.round(w)))
    }
    window.addEventListener('mousemove', mm)
    window.addEventListener('mouseup', mu)
  }

  // ---------- menus ----------
  function openMenu(el, items, x, y) {
    el.innerHTML = items.map((it, i) => (it === '-' ? '<hr />' : `<button data-i="${i}"${it.danger ? ' class="th-menu-danger"' : ''}>${esc(it.label)}</button>`)).join('')
    el.hidden = false
    const w = el.offsetWidth
    const h = el.offsetHeight
    el.style.left = `${Math.min(x, innerWidth - w - 8)}px`
    el.style.top = `${Math.min(y, innerHeight - h - 8)}px`
    el.onclick = (ev) => {
      const b = ev.target.closest('button[data-i]')
      if (!b) return
      el.hidden = true
      items[+b.dataset.i].run()
      if (!document.querySelector('dialog[open]')) focusGrid()
    }
  }
  // close pop-ups on an outside click; capture phase, so the click that opens a menu runs after this
  document.addEventListener(
    'mousedown',
    (e) => {
      for (const id of ['ctx', 'filterPop', 'moreMenu']) if (!$(id).hidden && !$(id).contains(e.target) && e.target.id !== 'moreBtn') $(id).hidden = true
    },
    true
  )
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') for (const id of ['ctx', 'filterPop', 'moreMenu']) $(id).hidden = true
  })

  function cellMenu(x, y) {
    const { r1, r2 } = rect()
    const n = r2 - r1 + 1
    openMenu(
      $('ctx'),
      [
        { label: '위에 행 넣기', run: () => insertRows(view[r1], 1) },
        { label: '아래에 행 넣기', run: () => insertRows(view[r2] + 1, 1) },
        { label: n > 1 ? `고른 ${num(n)}행 복제` : '행 복제', run: () => duplicateRows() },
        '-',
        { label: '복사 (Ctrl+C)', run: () => call('clipboard.write', { text: selectionText() }).then(() => toast('복사했습니다.')) },
        { label: '칸 지우기 (Delete)', run: clearSelection },
        '-',
        { label: n > 1 ? `고른 ${num(n)}행 삭제` : '행 삭제', danger: true, run: deleteRows }
      ],
      x,
      y
    )
  }
  function colMenu(c, x, y) {
    const col = book.cols[c]
    openMenu(
      $('ctx'),
      [
        { label: '오름차순 정렬 (가→하, 1→9)', run: () => sortBy(c, 'asc') },
        { label: '내림차순 정렬', run: () => sortBy(c, 'desc') },
        { label: filters[c] ? '필터 바꾸기…' : '이 열로 거르기(필터)…', run: () => filterPop(c, x, y) },
        '-',
        { label: '열 설정…', run: () => openColDialog(c) },
        { label: '왼쪽에 열 넣기', run: () => insertCol(c) },
        { label: '오른쪽에 열 넣기', run: () => insertCol(c + 1) },
        '-',
        { label: `“${col.name}” 열 삭제`, danger: true, run: () => deleteCol(c) }
      ],
      x,
      y
    )
  }

  // ---------- row / column operations ----------
  const full = (n) => (book.rows.length + n > MAX_ROWS ? (toast(`한 대장에는 ${num(MAX_ROWS)}행까지 담을 수 있습니다. 오래된 행을 다른 대장으로 나눠 주세요.`, true), true) : false)
  function insertRows(at, n) {
    if (full(n)) return
    change((b) => {
      for (let i = 0; i < n; i++) b.rows.splice(at, 0, { id: S.uid('r'), c: {} })
    })
    const vi = view.indexOf(at)
    if (vi >= 0) {
      sel = { r: vi, c: sel.c, r2: vi, c2: sel.c }
      paint()
      scrollToCell()
    }
  }
  function duplicateRows() {
    const { r1, r2 } = rect()
    const rows = view.slice(r1, r2 + 1)
    if (full(rows.length)) return
    const last = rows[rows.length - 1]
    change((b) => b.rows.splice(last + 1, 0, ...rows.map((r) => ({ id: S.uid('r'), c: Object.assign({}, b.rows[r].c) }))))
  }
  function deleteRows() {
    const { r1, r2 } = rect()
    const rows = new Set(view.slice(r1, r2 + 1))
    if (rows.size > 1 && !confirm(`${num(rows.size)}행을 삭제할까요?\n실행 취소(Ctrl+Z)나 "변경 이력"으로 되돌릴 수 있습니다.`)) return
    change((b) => (b.rows = b.rows.filter((_, i) => !rows.has(i))))
    sel = { r: Math.min(r1, Math.max(0, view.length - 1)), c: sel.c, r2: Math.min(r1, Math.max(0, view.length - 1)), c2: sel.c }
    paint()
  }
  function insertCol(at) {
    if (book.cols.length >= 200) return toast('열은 200개까지 만들 수 있습니다.', true)
    const col = { id: S.uid('c'), name: uniqueColName('새 열'), type: 'text', width: 120, total: 'none' }
    change((b) => b.cols.splice(at, 0, col))
    shiftFilters(at, 1)
    openColDialog(at)
  }
  function shiftFilters(at, d) {
    const nf = {}
    for (const k of Object.keys(filters)) {
      const i = +k
      if (d < 0 && i === at) continue
      nf[i >= at ? i + d : i] = filters[k]
    }
    filters = nf
  }
  function deleteCol(c) {
    const col = book.cols[c]
    if (book.cols.length <= 1) return toast('열이 하나뿐이라 지울 수 없습니다.', true)
    const ref = new RegExp(`\\[@?\\s*${col.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]`, 'i')
    const users = book.cols.filter((x) => x.type === 'calc' && ref.test(x.calc || '')).map((x) => x.name)
    const filled = book.rows.filter((r) => r.c[col.id] !== undefined && r.c[col.id] !== '').length
    const msg = `“${col.name}” 열을 삭제할까요?${filled ? `\n값이 들어 있는 칸 ${num(filled)}개도 함께 지워집니다.` : ''}${users.length ? `\n이 열을 쓰는 계산 열(${users.join(', ')})은 #REF!가 됩니다.` : ''}\n실행 취소(Ctrl+Z)나 "변경 이력"으로 되돌릴 수 있습니다.`
    if (!confirm(msg)) return
    change((b) => {
      b.cols.splice(c, 1)
      for (let i = 0; i < b.rows.length; i++) if (b.rows[i].c[col.id] !== undefined) delete W(b, i).c[col.id]
    })
    shiftFilters(c, -1)
    recompute()
    render()
  }
  function sortBy(c, dir) {
    if (Object.keys(filters).length || query) {
      toast('필터나 찾기를 해제한 뒤 정렬하세요.', true)
      return
    }
    const order = S.sortOrder(comp.values, c, dir)
    change((b) => (b.rows = order.map((i) => b.rows[i])))
    toast(`“${book.cols[c].name}” ${dir === 'asc' ? '오름차순' : '내림차순'}으로 정렬했습니다. (Ctrl+Z로 되돌리기)`)
  }

  function filterPop(c, x, y) {
    const col = book.cols[c]
    const counts = new Map()
    for (let r = 0; r < book.rows.length; r++) {
      const t = S.display(comp.values[r][c], col)
      counts.set(t, (counts.get(t) || 0) + 1)
    }
    const all = [...counts.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'ko', { numeric: true })))
    // a column of a large ledger may hold more different values than a list can show
    const vals = all.slice(0, 2000)
    const cur = filters[c] ? filters[c].values : null
    const el = $('filterPop')
    el.innerHTML = `<b>${esc(col.name)} 거르기</b><input type="search" placeholder="값 찾기" aria-label="값 찾기" class="th-input fq" /><div class="btnrow"><button class="th-btn th-btn-ghost th-btn-sm all">모두</button><button class="th-btn th-btn-ghost th-btn-sm none">모두 해제</button></div><div class="vals">${vals
      .map((v, i) => `<label class="th-check"><input type="checkbox" data-i="${i}"${!cur || cur.has(v) ? ' checked' : ''} /> ${v === '' ? '<span class="th-muted">(빈 칸)</span>' : shownText(v)} <span class="th-muted th-xs th-nums">${counts.get(v)}</span></label>`)
      .join('')}</div>${all.length > vals.length ? `<p class="th-hint">값이 ${num(all.length)}가지라 앞의 ${num(vals.length)}가지만 보입니다. 위쪽 "찾기"로 좁히세요.</p>` : ''}<div class="btnrow"><button class="th-btn th-btn-ghost th-btn-sm clear">이 열 필터 해제</button><span class="th-grow"></span><button class="th-btn th-btn-sm ok">적용</button></div>`
    el.hidden = false
    el.style.left = `${Math.min(x, innerWidth - 260)}px`
    el.style.top = `${Math.min(y, innerHeight - 360)}px`
    const boxes = () => [...el.querySelectorAll('.vals input')]
    el.querySelector('.fq').oninput = (e) => {
      const q = e.target.value.trim().toLowerCase()
      boxes().forEach((b) => (b.parentElement.hidden = q && !vals[+b.dataset.i].toLowerCase().includes(q)))
    }
    el.querySelector('.all').onclick = () => boxes().forEach((b) => (b.checked = true))
    el.querySelector('.none').onclick = () => boxes().forEach((b) => (b.checked = false))
    el.querySelector('.clear').onclick = () => {
      delete filters[c]
      el.hidden = true
      recompute()
      render()
      focusGrid()
    }
    el.querySelector('.ok').onclick = () => {
      const on = boxes().filter((b) => b.checked)
      if (on.length === vals.length && all.length === vals.length) delete filters[c]
      else filters[c] = { values: new Set(on.map((b) => vals[+b.dataset.i])) }
      el.hidden = true
      sel = { r: 0, c, r2: 0, c2: c }
      wrap.scrollTop = 0
      recompute()
      render()
      focusGrid()
    }
  }
  let searchTimer = null
  $('search').addEventListener('input', (e) => {
    // a large ledger is searched once typing pauses
    clearTimeout(searchTimer)
    const run = () => {
      query = e.target.value
      sel = { r: 0, c: sel.c, r2: 0, c2: sel.c }
      wrap.scrollTop = 0
      recompute()
      render()
    }
    if (book.rows.length > 5000) searchTimer = setTimeout(run, 250)
    else run()
  })
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      if (e.key === 'Escape') {
        e.target.value = ''
        query = ''
        recompute()
        render()
      }
      focusGrid()
    }
  })
  $('clearFilter').onclick = () => {
    filters = {}
    query = ''
    $('search').value = ''
    recompute()
    render()
    focusGrid()
  }

  $('addRow').onclick = () => {
    if (full(1)) return
    if (Object.keys(filters).length || query) {
      filters = {}
      query = ''
      $('search').value = ''
    }
    change((b) => b.rows.push({ id: S.uid('r'), c: {} }))
    sel = { r: view.length - 1, c: 0, r2: view.length - 1, c2: 0 }
    scrollToCell()
    paint()
    focusGrid()
  }
  $('addCol').onclick = () => insertCol(book.cols.length)

  // ---------- clipboard (events, so no clipboard-read permission is needed) ----------
  const plainCell = (v, col) => {
    if (F.isErr(v)) return v.code
    if (typeof v === 'boolean') return col.type === 'check' ? (v ? 'O' : '') : v ? 'TRUE' : 'FALSE'
    if (typeof v === 'number') return col.type === 'date' || col.format === 'date' ? F.serialToDate(v) : String(Math.round(v * 1e10) / 1e10)
    return v
  }
  function selectionMatrix() {
    const { r1, r2, c1, c2 } = rect()
    const out = []
    for (let r = r1; r <= r2; r++) {
      const line = []
      for (let c = c1; c <= c2; c++) line.push(plainCell(comp.values[view[r]][c], book.cols[c]))
      out.push(line)
    }
    return out
  }
  const selectionText = () => S.toDelimited(selectionMatrix(), '\t')
  editor.addEventListener('copy', (e) => {
    if (editing) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', selectionText())
    toast('복사했습니다. 엑셀이나 다른 칸에 붙여 넣으세요.')
  })
  editor.addEventListener('cut', (e) => {
    if (editing) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', selectionText())
    clearSelection()
  })
  editor.addEventListener('paste', (e) => {
    if (editing) return
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    if (!text || curRow() === undefined) return
    const at = view[sel.r]
    const lines = text.replace(/\r?\n$/, '').split('\n').length
    if (at + lines > MAX_ROWS) return void full(at + lines - book.rows.length)
    let area = null
    change((b) => (area = S.pasteBlock(b, at, sel.c, text, W)))
    if (area) {
      const r2 = view.indexOf(area.r2)
      sel = { r: sel.r, c: area.c1, r2: r2 >= 0 ? r2 : sel.r, c2: area.c2 }
      paint()
    }
  })

  // ---------- column dialog ----------
  function fillSelect(el, map) {
    el.innerHTML = Object.entries(map)
      .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)
      .join('')
  }
  fillSelect($('colType'), S.TYPES)
  fillSelect($('colFormat'), S.FORMATS)
  fillSelect($('colTotal'), S.TOTALS)
  let colEditing = -1
  function syncColDialog() {
    const t = $('colType').value
    $('colOptionsRow').hidden = t !== 'select'
    $('colCalcRow').hidden = t !== 'calc'
    previewCalc()
  }
  function previewCalc() {
    if ($('colType').value !== 'calc') return
    const f = $('colCalc').value.trim()
    if (!f) return ($('colCalcPreview').textContent = '')
    // tried on the first rows only: a large ledger is not computed at every key
    const trial = Object.assign({}, book, { cols: JSON.parse(JSON.stringify(book.cols)), rows: book.rows.slice(0, 200) })
    const c = trial.cols[colEditing]
    c.type = 'calc'
    c.calc = f.startsWith('=') ? f : `=${f}`
    c.name = $('colName').value.trim() || c.name
    c.format = $('colFormat').value
    const res = S.compute(trial)
    const v = res.values.length ? res.values[0][colEditing] : ''
    $('colCalcPreview').textContent = res.values.length ? `첫 행 결과: ${S.display(v, c) || '(빈 값)'}` : ''
    $('colCalcPreview').className = 'th-xs ' + (F.isErr(v) ? 'warn' : 'th-muted')
  }
  $('colType').onchange = syncColDialog
  $('colCalc').oninput = previewCalc
  function openColDialog(c, focus) {
    colEditing = c
    const col = book.cols[c]
    $('colTitle').textContent = `열 설정 — ${F.colLetters(c)}`
    $('colName').value = col.name
    $('colType').value = col.type
    $('colOptions').value = (col.options || []).join('\n')
    $('colCalc').value = col.calc || ''
    $('colFormat').value = col.format || (col.type === 'date' ? 'date' : 'auto')
    $('colTotal').value = col.total || 'none'
    $('colWidth').value = col.width || 120
    syncColDialog()
    $('colDialog').showModal()
    ;(focus === 'total' ? $('colTotal') : $('colName')).focus()
  }
  $('colDelete').onclick = () => {
    $('colDialog').close()
    deleteCol(colEditing)
  }
  $('colDialog').addEventListener('close', () => {
    if ($('colDialog').returnValue !== 'ok') return focusGrid()
    const c = colEditing
    const name = $('colName').value.trim()
    if (!name) return toast('열 이름을 넣으세요.', true)
    if (book.cols.some((x, i) => i !== c && x.name.toLowerCase() === name.toLowerCase())) return toast('같은 이름의 열이 있습니다.', true)
    const type = $('colType').value
    const calc = $('colCalc').value.trim()
    change((b) => {
      const bc = b.cols[c]
      if (bc.name !== name) S.renameColumn(b, bc.id, name, W)
      if (type !== bc.type && type !== 'calc')
        for (let i = 0; i < b.rows.length; i++) {
          const old = b.rows[i].c[bc.id]
          if (old === undefined) continue
          const v = S.parseInput({ type }, S.editText(bc, old))
          if (v !== old) W(b, i).c[bc.id] = v
        }
      bc.type = type
      bc.options = type === 'select' ? [...new Set($('colOptions').value.split('\n').map((s) => s.trim()).filter(Boolean))] : undefined
      bc.calc = type === 'calc' ? (calc ? (calc.startsWith('=') ? calc : `=${calc}`) : '') : undefined
      bc.format = $('colFormat').value
      bc.total = $('colTotal').value
      bc.width = Math.max(40, Math.min(600, +$('colWidth').value || 120))
    })
    focusGrid()
  })

  // ---------- save as (다른 이름으로 저장): xlsx / xls / csv / db / ledger file ----------
  const XL_FORMAT = { int: '#,##0', dec1: '#,##0.0', dec2: '#,##0.00', won: '#,##0"원"', pct: '0.0%' }
  /** The table as plain values with a kind per column (numbers stay numbers, dates stay dates in Excel). */
  function exportSheet(rowIdx) {
    const columns = book.cols.map((c, i) => {
      const isDate = c.type === 'date' || c.format === 'date'
      let kind = c.type === 'check' ? 'check' : isDate ? 'date' : c.type === 'number' ? 'number' : 'text'
      if (c.type === 'calc' && !isDate) {
        // a calculated column is a number column when its first results are numbers
        let n = 0
        let t = 0
        for (let k = 0; k < rowIdx.length && n + t < 50; k++) {
          const v = comp.values[rowIdx[k]][i]
          if (typeof v === 'number') n++
          else if (v !== '' && v !== null && v !== undefined) t++
        }
        if (n && !t) kind = 'number'
      }
      return { name: c.name, kind, format: kind === 'number' ? XL_FORMAT[c.format] : undefined, width: c.width || 120 }
    })
    const rows = rowIdx.map((r) =>
      comp.values[r].map((v, i) => {
        if (v === '' || v === null || v === undefined) return null
        if (F.isErr(v)) return v.code
        if (typeof v === 'number') return columns[i].kind === 'date' ? F.serialToDate(v) : v
        if (typeof v === 'boolean') return columns[i].kind === 'check' ? v : v ? 'TRUE' : 'FALSE'
        return String(v)
      })
    )
    return { columns, rows }
  }
  function openSaveAs() {
    if (!book) return
    const filtered = view.length !== book.rows.length
    $('saveAsScope').hidden = !filtered
    $('saveAsVisible').checked = filtered
    $('saveAsCount').textContent = filtered ? `(지금 ${num(view.length)}행 보임 / 전체 ${num(book.rows.length)}행)` : ''
    $('saveAsMsg').textContent = ''
    document.querySelector('input[name="saveAsFormat"][value="xlsx"]').checked = true
    $('saveAsDialog').showModal()
  }
  $('saveAs').onclick = openSaveAs
  $('saveAsGo').onclick = async () => {
    const format = document.querySelector('input[name="saveAsFormat"]:checked').value
    const whole = format === 'json' || $('saveAsScope').hidden || !$('saveAsVisible').checked
    const idx = whole ? book.rows.map((_, i) => i) : view
    if (format === 'xls' && idx.length > 65535) return ($('saveAsMsg').textContent = 'Excel 97-2003 통합 문서(.xls)는 65,535행까지 담을 수 있습니다. Excel 통합 문서(.xlsx)를 고르세요.')
    $('saveAsMsg').textContent = '저장하는 중…'
    try {
      const mine = L.plain(book)
      delete mine.share
      const sheet = format === 'json' ? { columns: [], rows: [] } : exportSheet(idx)
      const r = await call('file.saveAs', { name: book.name, format, columns: sheet.columns, rows: sheet.rows, book: mine })
      if (r && r.ok) {
        $('saveAsDialog').close()
        toast(`저장했습니다: ${r.path}`)
      } else $('saveAsMsg').textContent = r && r.error ? r.error : ''
    } catch (err) {
      $('saveAsMsg').textContent = `저장하지 못했습니다: ${err.message}`
    }
  }

  // ---------- change history (변경 이력) ----------
  const WHY = { edit: '고치기 전', bulk: '여러 행·열을 지우기 전', restore: '되돌리기 전', manual: '직접 보관' }
  let versions = []
  async function openHistory() {
    if (!src) return
    await settle()
    $('historyList').innerHTML = '<li class="th-muted">불러오는 중…</li>'
    $('historyKeep').hidden = !canEditNow()
    $('historyDialog').showModal()
    try {
      versions = (await call(`${src.kind}.versions`, { id: src.id })) || []
      drawHistory()
    } catch (err) {
      $('historyList').innerHTML = `<li class="warn">${esc(err.message)}</li>`
    }
  }
  function drawHistory() {
    const edit = canEditNow()
    $('historyList').innerHTML =
      versions
        .map(
          (v) =>
            `<li><span class="th-grow"><b>${fmtDate(v.createdAt)}</b> · ${esc(WHY[v.reason] || v.reason)}<br /><span class="th-muted th-xs">${num(v.rows)}행${v.byName ? ` · ${esc(v.byName)}` : ''}${v.name !== book.name ? ` · 이름 “${esc(v.name)}”` : ''}</span></span><button type="button" class="th-btn th-btn-outline th-btn-sm" data-copy="${esc(v.id)}">사본으로 열기</button>${edit ? `<button type="button" class="th-btn th-btn-outline th-btn-sm" data-back="${esc(v.id)}">이 시점으로</button>` : ''}</li>`
        )
        .join('') || '<li class="th-muted">아직 보관된 시점이 없습니다. 대장을 고치기 시작하면 그 전 모습이 자동으로 보관됩니다.</li>'
  }
  $('history').onclick = openHistory
  $('historyKeep').onclick = async () => {
    try {
      versions = await call(`${src.kind}.keep`, { id: src.id })
      drawHistory()
      toast('지금 모습을 보관했습니다.')
    } catch (err) {
      toast(err.message, true)
    }
  }
  $('historyList').addEventListener('click', async (e) => {
    const b = e.target.closest('button')
    if (!b || !src) return
    const v = versions.find((x) => x.id === (b.dataset.copy || b.dataset.back))
    if (!v) return
    try {
      if (b.dataset.copy) {
        const doc = await call(`${src.kind}.version`, { id: src.id, versionId: v.id })
        $('historyDialog').close()
        doc.name = `${doc.name} (${fmtDate(v.createdAt)} 시점)`.slice(0, 60)
        await addBook(doc)
        toast('그 시점의 모습을 개인용 대장으로 열었습니다. 원래 대장은 그대로입니다.')
      } else {
        if (!confirm(`대장을 ${fmtDate(v.createdAt)} 시점(${num(v.rows)}행)으로 되돌릴까요?\n지금 모습도 변경 이력에 보관되어 다시 돌아올 수 있습니다.${team ? '\n함께 쓰는 모든 사람의 화면이 바뀝니다.' : ''}`)) return
        const at = src
        await settle()
        await call(`${at.kind}.revert`, { id: at.id, versionId: v.id })
        $('historyDialog').close()
        if (src === at) await (at.kind === 'team' ? loadTeam(at.id, true) : openBook(at.id))
        toast('되돌렸습니다.')
      }
    } catch (err) {
      toast(`하지 못했습니다: ${err.message}`, true)
    }
  })

  // ---------- trash (휴지통) ----------
  async function openTrash() {
    $('trashList').innerHTML = '<li class="th-muted">불러오는 중…</li>'
    $('trashDialog').showModal()
    const mine = ((await call('local.trash').catch(() => [])) || []).map((x) => Object.assign({ kind: 'local' }, x))
    const shared = ((await call('team.trash').catch(() => [])) || []).map((x) => Object.assign({ kind: 'team' }, x))
    $('trashList').innerHTML =
      [...mine, ...shared]
        .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
        .map(
          (x) =>
            `<li><span class="th-grow"><b>${bookIcon(x.icon)} ${esc(x.name)}</b><br /><span class="th-muted th-xs">${x.kind === 'local' ? `${icon('lock')} 개인용` : kindName(x)} · ${num(x.rows)}행 · ${fmtDate(x.deletedAt)}에 삭제${x.kind === 'team' ? ` · 만든 사람 ${esc(x.ownerName)}` : ''}</span></span><button type="button" class="th-btn th-btn-outline th-btn-sm" data-kind="${x.kind}" data-restore="${esc(x.id)}">되살리기</button><button type="button" class="th-btn th-btn-ghost th-btn-sm danger" data-kind="${x.kind}" data-purge="${esc(x.id)}" data-name="${esc(x.name)}">완전히 삭제</button></li>`
        )
        .join('') || '<li class="th-muted">휴지통이 비어 있습니다.</li>'
  }
  $('trashBtn').onclick = openTrash
  $('trashList').addEventListener('click', async (e) => {
    const b = e.target.closest('button')
    if (!b) return
    const kind = b.dataset.kind
    try {
      if (b.dataset.restore) {
        await call(`${kind}.restore`, { id: b.dataset.restore })
        toast('되살렸습니다.')
      } else {
        if (!confirm(`“${b.dataset.name}” 대장을 완전히 삭제할까요?\n변경 이력까지 모두 지워지며 되돌릴 수 없습니다.`)) return
        await call(`${kind}.purge`, { id: b.dataset.purge })
      }
      await loadIndex()
      await loadTeamList()
      openTrash()
    } catch (err) {
      toast(`하지 못했습니다: ${err.message}`, true)
    }
  })

  // ---------- book actions ----------
  $('bookName').addEventListener('change', (e) => {
    const n = e.target.value.trim() || '이름 없는 대장'
    e.target.value = n
    change((b) => (b.name = n))
    e.target.value = book.name // unchanged when this ledger is read-only for me
  })
  $('bookName').addEventListener('keydown', (e) => e.key === 'Enter' && focusGrid())
  $('note').addEventListener('change', (e) => change((b) => (b.note = e.target.value)))

  $('moreBtn').onclick = () => ($('moreMenu').hidden = !$('moreMenu').hidden)
  $('moreMenu').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]')
    if (!b) return
    $('moreMenu').hidden = true
    const act = b.dataset.act
    try {
      if (act === 'saveAs') openSaveAs()
      else if (act === 'history') openHistory()
      else if (act === 'copyAll') {
        if (view.length > 20000) return toast('표가 커서 한 번에 복사할 수 없습니다(20,000행까지). "다른 이름으로 저장"으로 엑셀 파일을 만드세요.', true)
        const head = book.cols.map((c) => c.name)
        const body = view.map((r) => comp.values[r].map((v, c) => plainCell(v, book.cols[c])))
        await call('clipboard.write', { text: S.toDelimited([head, ...body], '\t') })
        toast(`표 전체(${num(view.length)}행)를 복사했습니다. 엑셀에 붙여 넣으세요.`)
      } else if (act === 'print') {
        if (view.length > PRINT_ROWS) toast(`앞의 ${num(PRINT_ROWS)}행만 인쇄됩니다. 찾기·필터로 필요한 행만 보이게 하거나 엑셀 파일로 저장해 인쇄하세요.`, true)
        $('printTitle').textContent = book.name
        window.print()
      } else if (act === 'share') openShare()
      else if (act === 'toTeam') {
        if (!online) return toast('서버에 연결되어야 올릴 수 있습니다.', true)
        openTeamDialog('move')
      } else if (act === 'teamScope') openTeamDialog('scope')
      else if (act === 'dup') {
        await settle()
        const wasTeam = !!team
        const copy = L.plain(book)
        copy.name = `${book.name} (사본)`.slice(0, 60)
        copy.rows = copy.rows.map((r) => ({ id: S.uid('r'), c: r.c }))
        await addBook(copy)
        toast(wasTeam ? '개인용 대장으로 사본을 받았습니다. 이 사본은 이 PC에만 있습니다.' : '복제했습니다.')
      } else if (act === 'note') {
        $('note').hidden = false
        $('note').focus()
      } else if (act === 'delete') {
        const at = src
        if (!confirm(`“${book.name}” 대장을 삭제할까요?\n${team ? '함께 쓰던 모든 사람에게서 사라집니다. ' : ''}삭제한 대장은 30일 동안 휴지통에 있고 그 안에 되살릴 수 있습니다.`)) return
        await settle()
        if (book.share) await call('rooms.delete', { roomId: book.share.roomId }).catch(() => undefined)
        await call(`${at.kind}.delete`, { id: at.id })
        if (src === at) closeSheet()
        await loadIndex()
        loadTeamList()
        toast('휴지통으로 옮겼습니다. 왼쪽 아래 "휴지통"에서 되살릴 수 있습니다.')
      }
    } catch (err) {
      toast(err.message, true)
    }
  })
  window.addEventListener('beforeprint', () => {
    if (!book) return
    printing = true
    renderRows()
  })
  window.addEventListener('afterprint', () => {
    printing = false
    if (book) renderRows()
  })

  // ---------- new / import ----------
  $('templates').innerHTML = S.TEMPLATES.map((t) => `<button type="button" class="th-card tpl" data-t="${t.key}"><span class="ic">${icon(t.icon)}</span><span><b>${esc(t.name)}</b><small>${esc(t.desc)}</small></span></button>`).join('')
  function openNew(where) {
    $('newName').value = ''
    for (const v of ['team', 'members']) document.querySelector(`input[name="newWhere"][value="${v}"]`).disabled = !online
    document.querySelector(`input[name="newWhere"][value="${where && (where === 'local' || online) ? where : 'local'}"]`).checked = true
    $('newDialog').showModal()
    $('newName').focus()
  }
  $('newBook').onclick = () => openNew('local')
  $('empty').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-new]')
    if (b) openNew(b.dataset.new)
  })
  $('templates').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-t]')
    if (!b) return
    $('newDialog').close()
    const made = S.fromTemplate(b.dataset.t, $('newName').value.trim() || undefined)
    const where = document.querySelector('input[name="newWhere"]:checked').value
    if (where !== 'local') {
      pendingTeam = made
      return openTeamDialog('create', where)
    }
    try {
      await addBook(made)
    } catch (err) {
      toast(`만들지 못했습니다: ${err.message}`, true)
    }
  })
  $('importFile').onclick = async () => {
    try {
      const r = await call('file.open')
      if (!r || !r.ok) return r && r.error && toast(r.error, true)
      let b
      if (r.kind === 'book') {
        b = r.book
        if (!b || !Array.isArray(b.cols) || !Array.isArray(b.rows)) throw new Error('관리대장 파일이 아닙니다.')
      } else if (r.kind === 'rows') b = S.fromMatrix(r.rows, r.name)
      else b = S.fromCSV(r.text, r.name)
      if (b.rows.length > MAX_ROWS) throw new Error(`행이 너무 많습니다(${num(MAX_ROWS)}행까지).`)
      if (index.some((x) => x.name === b.name)) b.name = `${b.name} (가져옴)`.slice(0, 60)
      await addBook(b)
      toast(r.kind === 'book' ? '대장을 열었습니다. 개인용 대장으로 저장됩니다.' : `${num(b.rows.length)}행 ${b.cols.length}열을 가져왔습니다. 열 머리글의 화살표 단추 → 열 설정에서 종류를 확인하세요.`)
    } catch (err) {
      toast(`가져오지 못했습니다: ${err.message}`, true)
    }
  }

  // ---------- sharing (read-only copy for teammates, server room) ----------
  function snapshot() {
    const cols = book.cols.map((c) => ({ name: c.name, type: c.type === 'calc' ? 'text' : c.type, num: c.type === 'number' || (c.type === 'calc' && view.some((r) => typeof comp.values[r][book.cols.indexOf(c)] === 'number')), width: c.width || 120 }))
    const rows = view.map((r) => book.cols.map((c, i) => S.display(comp.values[r][i], c)))
    const totals = book.cols.map((c, i) => (c.total && c.total !== 'none' ? `${S.TOTALS[c.total].replace(/\(.*\)/, '')} ${c.total === 'count' || c.total === 'checked' ? S.total(comp.values, i, c.total, view) : S.display(S.total(comp.values, i, c.total, view), c)}` : ''))
    return { kind: 'ledger', name: book.name, note: book.note || '', cols, rows, totals, at: Date.now(), by: me ? me.name : '' }
  }
  async function openShare() {
    await settle()
    $('shareState').textContent = book.share ? `공유 중 (${fmtDate(book.share.at)}에 마지막 갱신)` : ''
    $('shareGo').textContent = book.share ? '공유 갱신' : '공유하기'
    $('shareStop').hidden = !book.share
    try {
      members = (await call('members')) || members
    } catch {
      /* not connected */
    }
    $('shareMembers').innerHTML = members
      .filter((m) => !me || m.id !== me.id)
      .map((m) => `<label class="th-check"><input type="checkbox" value="${esc(m.id)}"${book.share && book.share.memberIds && book.share.memberIds.includes(m.id) ? ' checked' : ''} /> ${esc(m.name)}</label>`)
      .join('')
    const to = book.share && book.share.type === 'members' ? 'members' : 'team'
    document.querySelector(`input[name="shareTo"][value="${to}"]`).checked = true
    $('shareMembers').hidden = to !== 'members'
    $('shareDialog').showModal()
  }
  document.querySelectorAll('input[name="shareTo"]').forEach((r) => r.addEventListener('change', () => ($('shareMembers').hidden = document.querySelector('input[name="shareTo"]:checked').value !== 'members')))
  $('shareGo').onclick = async () => {
    const type = document.querySelector('input[name="shareTo"]:checked').value
    const memberIds = [...$('shareMembers').querySelectorAll('input:checked')].map((x) => x.value)
    if (type === 'members' && !memberIds.length) return ($('shareState').textContent = '공유할 팀원을 고르세요.')
    if (view.length > 3000) return ($('shareState').textContent = '표가 커서 공유할 수 없습니다. 함께 볼 대장은 "팀용·지정자용으로 올리기"를 쓰세요.')
    const shared = snapshot()
    if (bytes(JSON.stringify(shared)) > 63 * 1024) return ($('shareState').textContent = '표가 커서 공유할 수 없습니다(64KB). 찾기·필터로 필요한 행만 보이게 한 뒤 공유하거나, "팀용·지정자용으로 올리기"를 쓰세요.')
    $('shareState').textContent = '공유하는 중…'
    try {
      const scope = { type, groupIds: [], memberIds: type === 'members' ? memberIds : [] }
      let room = null
      if (book.share && book.share.type === type && JSON.stringify(book.share.memberIds || []) === JSON.stringify(memberIds)) {
        const cur = await call('rooms.get', { roomId: book.share.roomId }).catch(() => null)
        if (cur) room = await call('rooms.setShared', { roomId: cur.id, shared, version: cur.version })
      }
      if (!room) {
        if (book.share) await call('rooms.delete', { roomId: book.share.roomId }).catch(() => undefined)
        room = await call('rooms.create', { title: book.name, scope, shared })
      }
      change((b) => (b.share = { roomId: room.id, type, memberIds, at: Date.now() }))
      $('shareDialog').close()
      toast('공유했습니다. 받는 사람에게 알림이 갑니다.')
    } catch (err) {
      $('shareState').textContent = `공유하지 못했습니다: ${err.message}`
    }
  }
  $('shareStop').onclick = async () => {
    if (!book.share) return
    await call('rooms.delete', { roomId: book.share.roomId }).catch(() => undefined)
    change((b) => delete b.share)
    $('shareDialog').close()
    toast('공유를 그만했습니다.')
  }

  $('sharedBtn').onclick = async () => {
    $('sharedList').innerHTML = '<li class="th-muted">불러오는 중…</li>'
    $('sharedDialog').showModal()
    try {
      const rooms = ((await call('rooms.list')) || []).filter((r) => r.shared && r.shared.kind === 'ledger')
      $('sharedList').innerHTML =
        rooms
          .map((r) => `<li><span class="th-grow"><b>${esc(r.title)}</b><br /><span class="th-muted th-xs">${esc(r.createdByName)} · ${fmtDate(r.updatedAt)} · ${r.shared.rows.length}행${me && r.createdBy === me.id ? ' · 내가 공유' : ''}</span></span><button type="button" class="th-btn th-btn-outline th-btn-sm" data-room="${esc(r.id)}">보기</button></li>`)
          .join('') || '<li class="th-muted">공유받은 대장이 없습니다.</li>'
    } catch (err) {
      $('sharedList').innerHTML = `<li class="warn">${esc(err.message)}</li>`
    }
  }
  $('sharedList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-room]')
    if (!b) return
    $('sharedDialog').close()
    openRoom(b.dataset.room)
  })

  async function openRoom(id) {
    try {
      const room = await call('rooms.get', { roomId: id })
      if (!room.shared || room.shared.kind !== 'ledger') return toast('관리대장 공유가 아닙니다.', true)
      await settle()
      team = null
      src = null
      shadow = null
      syncTeamUi()
      viewing = room
      const s = room.shared
      $('empty').hidden = true
      $('sheet').hidden = true
      $('viewer').hidden = false
      $('viewTitle').innerHTML = `${icon('eye')} ${esc(s.name)}`
      $('viewMeta').textContent = `${room.createdByName}님이 공유 · ${fmtDate(s.at)} 기준 · 보기 전용`
      let h = '<colgroup><col style="width:52px">' + s.cols.map((c) => `<col style="width:${c.width}px">`).join('') + '</colgroup><thead><tr><th class="rn">No.</th>'
      h += s.cols.map((c) => `<th><div class="hc"><span class="t">${esc(c.name)}</span></div></th>`).join('') + '</tr></thead><tbody>'
      h += s.rows.map((r, i) => `<tr><td class="rn">${i + 1}</td>${r.map((v, j) => `<td${s.cols[j].num ? ' class="num"' : ''}>${shownText(v)}</td>`).join('')}</tr>`).join('')
      h += '</tbody>'
      if (s.totals.some(Boolean)) h += `<tfoot><tr><td class="rn">합계</td>${s.totals.map((t) => `<td class="num">${esc(t)}</td>`).join('')}</tr></tfoot>`
      $('viewGrid').innerHTML = h
      book = null
      renderBooks()
    } catch (err) {
      toast(`열지 못했습니다: ${err.message}`, true)
    }
  }
  $('viewClose').onclick = () => {
    viewing = null
    $('viewer').hidden = true
    $('empty').hidden = false
  }
  $('viewCopy').onclick = async () => {
    if (!viewing) return
    const s = viewing.shared
    const cols = s.cols.map((c) => ({ id: S.uid('c'), name: c.name, type: c.type === 'member' || c.type === 'select' ? 'text' : c.type, width: c.width, total: 'none', format: c.num ? 'auto' : undefined }))
    const rows = s.rows.map((r) => ({ id: S.uid('r'), c: Object.fromEntries(r.map((v, j) => [cols[j].id, S.parseInput(cols[j], cols[j].type === 'check' ? (v ? 'O' : '') : v)]).filter(([, v]) => v !== '')) }))
    await addBook({ name: `${s.name} (${viewing.createdByName})`.slice(0, 60), cols, rows, note: s.note || '' })
    toast('내 대장으로 복사했습니다. 계산식은 값으로 바뀌었습니다.')
  }
  window.TeamHub.on('room.changed', ({ roomId, deleted }) => {
    if (viewing && viewing.id === roomId) {
      if (deleted) {
        toast('공유한 사람이 공유를 그만했습니다.')
        $('viewClose').onclick()
      } else openRoom(roomId)
    }
  })

  // ---------- help ----------
  const FN_HELP = {
    SUM: 'SUM(범위, …) 합계',
    AVERAGE: 'AVERAGE(범위) 평균',
    MIN: 'MIN(범위) 최솟값',
    MAX: 'MAX(범위) 최댓값',
    COUNT: 'COUNT(범위) 숫자 칸 개수',
    COUNTA: 'COUNTA(범위) 빈칸이 아닌 칸 개수',
    COUNTBLANK: 'COUNTBLANK(범위) 빈칸 개수',
    IF: 'IF(조건, 참일 때, 거짓일 때)',
    IFERROR: 'IFERROR(식, 오류일 때 값)',
    AND: 'AND(조건, …) 모두 참', OR: 'OR(조건, …) 하나라도 참', NOT: 'NOT(조건)',
    ROUND: 'ROUND(수, 자릿수) 반올림', ROUNDUP: 'ROUNDUP(수, 자릿수) 올림', ROUNDDOWN: 'ROUNDDOWN(수, 자릿수) 내림',
    INT: 'INT(수) 정수로 내림', ABS: 'ABS(수) 절댓값', MOD: 'MOD(수, 나눌 수) 나머지', POWER: 'POWER(수, 지수) 거듭제곱', SQRT: 'SQRT(수) 제곱근',
    LEN: 'LEN(글자) 글자 수', LEFT: 'LEFT(글자, 개수) 왼쪽에서', RIGHT: 'RIGHT(글자, 개수) 오른쪽에서', MID: 'MID(글자, 시작, 개수) 가운데',
    TRIM: 'TRIM(글자) 앞뒤·겹친 공백 정리', UPPER: 'UPPER(글자) 대문자', LOWER: 'LOWER(글자) 소문자', CONCAT: 'CONCAT(값, …) 이어 붙이기 (& 와 같음)',
    TEXT: 'TEXT(값, "형식") 예: "#,##0" "0.0%" "yyyy.mm.dd"', VALUE: 'VALUE(글자) 숫자로',
    TODAY: 'TODAY() 오늘 날짜', NOW: 'NOW() 오늘 날짜', DATE: 'DATE(년, 월, 일)', YEAR: 'YEAR(날짜)', MONTH: 'MONTH(날짜)', DAY: 'DAY(날짜)',
    DAYS: 'DAYS(끝, 시작) 두 날짜 사이 일 수', DATEDIF: 'DATEDIF(시작, 끝, "Y"|"M"|"D") 만 나이·개월·일 수',
    ISBLANK: 'ISBLANK(값) 빈칸인가', ISNUMBER: 'ISNUMBER(값) 숫자인가', ISERROR: 'ISERROR(값) 오류인가',
    SUMIF: 'SUMIF(조건 범위, 조건, 합할 범위) 예: SUMIF([상태],"완료",[금액])',
    COUNTIF: 'COUNTIF(범위, 조건) 예: COUNTIF([상태],"<>완료") COUNTIF(B1:B9,">=10")',
    AVERAGEIF: 'AVERAGEIF(조건 범위, 조건, 평균 낼 범위)',
    VLOOKUP: 'VLOOKUP(찾을 값, 표 범위, 열 번호, FALSE) 첫 열에서 찾아 같은 행의 값',
    MATCH: 'MATCH(찾을 값, 범위) 몇 번째인가', INDEX: 'INDEX(범위, 행, 열) 그 위치의 값',
    ROW: 'ROW() 지금 행 번호', CUMSUM: 'CUMSUM([열]) 첫 행부터 지금 행까지 누적 합계'
  }
  $('fnTable').innerHTML = F.FUNCTIONS.map((n) => `<tr><td>${n}</td><td>${esc((FN_HELP[n] || '').replace(/^\S+\(.*?\)\s*/, '') || '')}<br /><span class="th-muted">${esc((FN_HELP[n] || n).match(/^\S+\(.*?\)/) ? FN_HELP[n].match(/^\S+\(.*?\)/)[0] : n)}</span></td></tr>`).join('')
  $('helpBtn').onclick = () => $('helpDialog').showModal()

  // ---------- start ----------
  let scrollFrame = 0
  wrap.addEventListener('scroll', () => {
    if (scrollFrame) return
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0
      onScroll()
    })
  })
  window.addEventListener('resize', () => book && !printing && renderRows())
  window.addEventListener('beforeunload', () => {
    if (saveTimer) void flush()
  })
  // leaving the screen (clicking another menu) takes the focus away first: save what is pending
  window.addEventListener('blur', () => {
    if (saveTimer) void flush()
  })
  ;(async () => {
    online = !!(await call('online').catch(() => false))
    me = await call('me').catch(() => null)
    members = (await call('members').catch(() => null)) || []
    await loadIndex()
    await loadTeamList()
    const last = await call('storage.get', { key: 'last' }).catch(() => null)
    if (window.TeamHub.room) openRoom(window.TeamHub.room)
    else if (last && last.team && teamList.some((t) => t.id === last.team)) openTeam(last.team)
    else if (last && last.book && index.some((b) => b.id === last.book)) openBook(last.book)
    else if (index.length) openBook([...index].sort((a, b) => b.updatedAt - a.updatedAt)[0].id)
    else if (teamList.length) openTeam(teamList[0].id)
  })()
  window.__ledger = { get book() { return book }, get view() { return view }, get sel() { return sel }, get team() { return team }, get src() { return src }, get shadow() { return shadow }, get win() { return win }, flush, settle, metaNow, set deaf(v) { deaf = !!v } }
})()
