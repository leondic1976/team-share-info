/* Equipment register UI. Talks to TeamHub only via TeamHub.call (see __sdk.js).
 *
 * A register is a head room plus volume rooms made by its manager (bipum.js). The manager
 * writes the items (shared data); everybody writes their own lending, issuing and inventory
 * check records into their own entry of the head room.
 * The look comes from TeamHub (__ui.css, the th-* classes); style.css holds the layout only. */
;(function () {
  'use strict'
  // line icons come from TeamHub (TeamHub.icon); an older TeamHub without them shows the text only
  const icon = (n, o) => (window.TeamHub.icon ? window.TeamHub.icon(n, o) : '')
  const $ = (id) => document.getElementById(id)
  const B = window.Bipum
  const call = (m, p) => window.TeamHub.call(m, p)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const num = (n) => Number(n || 0).toLocaleString('ko-KR')
  const won = (n) => (n ? `${num(n)}원` : '')
  const SHOW_MAX = 300

  let me = null
  let members = []
  let rooms = []
  let bookList = []
  let book = null
  let items = []
  let loans = []
  let checks = new Map()
  let wanted = window.TeamHub.room || '' // register to open: from an invitation, then the last one used
  let tab = 'list'
  let offset = 0 // server clock - this PC's clock
  let busy = false
  let showAll = false
  let forPrint = false
  let loanView = 'open'
  let auditView = 'todo'
  let auditLoc = ''
  let backup = null // items read from a backup file for the new register
  let editing = null // item in the form
  let detailId = ''
  // my own entry: what I see is what I last wrote, even while the server is still answering
  let myEntry = B.cleanEntry(null)
  let pending = 0
  let chain = Promise.resolve()
  const filter = { q: '', kind: '', cat: '', status: '', loc: '', flag: '' }
  const sort = { key: 'name', dir: 'asc' }

  const now = () => Date.now() + offset
  const today = () => B.ymd(now())
  const isManager = () => !!book && book.head.createdBy === me.id
  const audit = () => (book && book.head.shared.audit) || null
  const ctx = () => ({ loans, today: today() })
  const byId = (id) => items.find((it) => it.id === id)
  const dt = (ms) => {
    const d = new Date(ms)
    return `${B.ymd(ms).slice(5).replace('-', '/')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  function toast(msg) {
    const t = $('toast')
    t.textContent = msg
    t.classList.add('show')
    clearTimeout(toast.t)
    toast.t = setTimeout(() => t.classList.remove('show'), 3200)
  }
  const empty = (pic, title, body, action) => `<div class="th-empty empty">${pic}<p class="th-empty-title">${esc(title)}</p>${body ? `<p>${esc(body)}</p>` : ''}${action || ''}</div>`
  const mark = (kind, text) => `<span class="th-badge${kind ? ` th-badge-${kind}` : ''}">${text}</span>`
  // 사용중 · 보관 · 수리중 · 불용 · 폐기
  const STATUS_KIND = ['success', '', 'important', 'muted', 'muted']
  const badge = (it) => mark(STATUS_KIND[it.status], B.STATUS[it.status])
  const tool = (attrs, body, cls) => `<button class="th-btn th-btn-sm ${cls || 'th-btn-outline'}" ${attrs}>${body}</button>`
  const chipBtn = (attrs, on, label, n, cls) => `<button class="th-chip ${cls || ''}" ${attrs} aria-pressed="${on}">${label} <b>${num(n)}</b></button>`
  const sub = (text, cls) => `<div class="sub th-xs ${cls || 'th-muted'}">${text}</div>`

  async function syncClock() {
    try {
      const before = Date.now()
      const r = await call('time')
      offset = r.now - (before + Date.now()) / 2
    } catch {
      offset = 0 // an older TeamHub without the call: this PC's clock
    }
  }

  // ---------- data ----------
  function derive() {
    if (!book) {
      items = []
      loans = []
      checks = new Map()
      return
    }
    if (!pending) myEntry = B.entryOf(book.head, me.id)
    // my unsent records count at once
    const head = { ...book.head, entries: { ...book.head.entries, [me.id]: { name: me.name, value: myEntry, at: 0 } } }
    items = B.itemsOf(book)
    loans = B.allLoans(head)
    checks = B.auditMap(head)
  }
  async function load() {
    rooms = await call('rooms.list')
    bookList = B.books(rooms)
    book = B.bookOf(bookList, wanted) || bookList[0] || null
    wanted = book ? book.head.id : ''
    derive()
  }
  /** Only the head room: other members' records. */
  async function refreshHead() {
    if (!book) return
    const head = await call('rooms.get', { roomId: book.head.id })
    rooms = rooms.map((r) => (r.id === head.id ? head : r))
    bookList = B.books(rooms)
    book = B.bookOf(bookList, head.id)
    derive()
  }
  /**
   * The manager changes the items: read the newest state, apply `fn(items, shared)` →
   * { items, meta? } | { error }, write only the rooms that changed.
   */
  async function mutate(fn, done) {
    if (busy) return false
    busy = true
    let ok = false
    try {
      await load()
      if (!book || !isManager()) throw new Error('대장을 만든 담당자만 바꿀 수 있습니다.')
      const r = fn(items, book.head.shared)
      if (r.error) throw new Error(r.error)
      const plan = B.distribute(book, r.items, r.meta)
      if (plan.error) throw new Error(plan.error)
      let n = book.vols.length
      for (const shared of plan.creates) await call('rooms.create', { title: `${book.head.title} (${++n + 1}권)`.slice(0, 100), scope: B.scopeInput(book.head.scope), shared })
      for (const w of plan.writes) await call('rooms.setShared', { roomId: w.roomId, shared: w.shared, version: w.version })
      await load()
      ok = true
      if (done) toast(done)
    } catch (e) {
      toast(e.message || '저장하지 못했습니다.')
      await load().catch(() => undefined)
    }
    busy = false
    render()
    return ok
  }
  /** Change my own entry: `fn(entry)` → { entry } | { error }. Writes go out one after another. */
  function saveEntry(fn, done) {
    if (!book) return false
    const r = fn(myEntry)
    const fit = r.error ? r : B.fitEntry(r.entry, items)
    if (fit.error) {
      toast(fit.error)
      return false
    }
    myEntry = fit.entry
    pending++
    const roomId = book.head.id
    derive()
    chain = chain
      .then(() => call('rooms.setEntry', { roomId, value: myEntry }))
      .then(
        (room) => {
          pending--
          rooms = rooms.map((x) => (x.id === room.id ? room : x))
          bookList = B.books(rooms)
          book = B.bookOf(bookList, wanted) || book
          derive()
          if (done) toast(done)
        },
        async (e) => {
          pending--
          toast(e.message || '저장하지 못했습니다.')
          await load().catch(() => undefined)
          render()
        }
      )
    return true
  }

  // ---------- 대장 ----------
  const options = (list, cur, any) => `<option value="">${any}</option>${list.map((x) => `<option value="${esc(x)}" ${String(cur) === String(x) ? 'selected' : ''}>${esc(x)}</option>`).join('')}`
  function listShell() {
    return `<div class="stack">
      <div class="filters th-no-print">
        <input class="th-input q" id="q" type="search" placeholder="품명·규격·관리번호·위치·사용자 찾기" value="${esc(filter.q)}" aria-label="찾기" />
        <select class="th-input" id="fKind" aria-label="구분"><option value="">구분 전체</option>${B.KINDS.map((k, i) => `<option value="${i}" ${filter.kind === String(i) ? 'selected' : ''}>${k}</option>`).join('')}</select>
        <select class="th-input" id="fCat" aria-label="분류"></select>
        <select class="th-input" id="fStatus" aria-label="상태"><option value="">상태 전체(폐기 제외)</option>${B.STATUS.map((k, i) => `<option value="${i}" ${filter.status === String(i) ? 'selected' : ''}>${k}</option>`).join('')}</select>
        <select class="th-input" id="fLoc" aria-label="보관 위치"></select>
        <span class="th-grow"></span>
        ${tool('id="csvOut"', `${icon('download')} CSV 저장`)}
        ${isManager() ? tool('id="csvIn"', `${icon('upload')} CSV 가져오기`) : ''}
        ${tool('id="printBtn"', `${icon('file-text')} 인쇄`)}
      </div>
      <div class="th-chips th-no-print" id="chips"></div>
      <div id="listBody"></div>
    </div>`
  }
  const visible = () => B.sortItems(B.filterItems(items, filter, ctx()), sort.key, sort.dir, ctx())
  function qtyCell(it) {
    const out = B.outQty(loans, it.id)
    if (it.kind === 1) {
      const stock = B.stockOf(it, loans)
      return `${B.isLow(it, loans) ? `${mark('important', '재고 부족')} ` : ''}<b>${num(stock)}</b> ${esc(it.unit)}${it.min ? sub(`최소 ${num(it.min)}`) : ''}`
    }
    return `<b>${num(it.qty)}</b> ${esc(it.unit)}${out ? sub(`대여 중 ${num(out)}`, 'out') : ''}`
  }
  function listBody() {
    const c = ctx()
    const count = (flag) => B.filterItems(items, { flag }, c).length
    const chip = (flag, label, n, cls) => chipBtn(`data-flag="${flag}"`, filter.flag === flag, label, n, n && cls ? cls : '')
    $('chips').innerHTML = chip('', '전체', count('')) + chip('low', '재고 부족', count('low'), 'warn') + chip('out', '대여 중', count('out')) + chip('lend', '대여 가능', count('lend')) + chip('over', '내용연수 지남', count('over'), 'warn')
    $('fCat').innerHTML = options(B.catsOf(items), filter.cat, '분류 전체')
    $('fLoc').innerHTML = options(B.locsOf(items), filter.loc, '위치 전체')
    const list = visible()
    if (!items.length) {
      $('listBody').innerHTML = empty(icon('archive'), '등록된 물품이 없습니다', isManager() ? '[물품 등록]으로 하나씩 넣거나, 엑셀 자료를 [CSV 가져오기]로 한 번에 넣으세요.' : '담당자가 물품을 등록하면 여기에 나타납니다.', isManager() ? tool('id="tplBtn"', `${icon('download')} CSV 양식 받기`) : '')
      return
    }
    if (!list.length) {
      $('listBody').innerHTML = empty(icon('search'), '맞는 물품이 없습니다', '찾는 말이나 필터를 바꿔 보세요.')
      return
    }
    const th = (key, label, cls) => `<th class="${cls || ''}" data-sort="${key}" aria-sort="${sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${label}${sort.key === key ? ` ${icon(sort.dir === 'asc' ? 'arrow-up' : 'arrow-down')}` : ''}</th>`
    const shown = showAll ? list : list.slice(0, SHOW_MAX)
    const t = today()
    $('listBody').innerHTML = `<div class="th-card"><div class="th-table-wrap"><table class="th-table grid" id="itemTable">
        <thead><tr>${th('no', '관리번호')}${th('name', '품명')}${th('cat', '분류')}${th('stock', '수량', 'r')}${th('loc', '보관 위치')}${th('holder', '사용자')}${th('got', '취득일')}${th('amount', '금액', 'r')}${th('status', '상태')}</tr></thead>
        <tbody>${shown
          .map(
            (it) => `<tr data-item="${esc(it.id)}" tabindex="0">
            <td class="th-nums">${esc(it.no)}</td>
            <td><b>${esc(it.name)}</b>${it.kind === 1 ? ` ${mark('muted', '소모품')}` : it.lend ? ` ${mark('', '대여용')}` : ''}${it.spec ? sub(esc(it.spec)) : ''}</td>
            <td>${esc(it.cat)}</td>
            <td class="r">${qtyCell(it)}</td>
            <td>${esc(it.loc)}</td>
            <td>${esc(it.holder)}</td>
            <td class="th-nums">${esc(it.got)}${B.lifeOver(it, t) ? sub('내용연수 지남', 'over') : ''}</td>
            <td class="r">${won(it.price * it.qty)}</td>
            <td>${badge(it)}</td>
          </tr>`
          )
          .join('')}</tbody>
        <tfoot><tr><td colspan="3">${num(list.length)}개 품목${list.length < items.length ? ` <span class="th-muted">(전체 ${num(items.length)}개 가운데)</span>` : ''}</td><td class="r">${num(list.reduce((n, it) => n + it.qty, 0))}</td><td colspan="3"></td><td class="r">${won(list.reduce((n, it) => n + it.price * it.qty, 0))}</td><td></td></tr></tfoot>
      </table></div></div>
      ${shown.length < list.length ? `<div class="btns center th-no-print"><span class="th-xs th-muted">${num(shown.length)}개만 보여 줍니다.</span>${tool('id="moreRows"', `모두 보기 (${num(list.length)}개)`)}</div>` : ''}`
  }
  let shellFor = ''
  function renderList() {
    // the bar above the list is kept while typing in it; a new one for another register or role
    const key = `${book.head.id}:${isManager()}`
    if (!$('listBody') || shellFor !== key) $('main').innerHTML = listShell()
    shellFor = key
    listBody()
  }

  // ---------- item form (manager) ----------
  function openItem(it) {
    editing = it || null
    $('itemTitle').textContent = it ? '물품 수정' : '물품 등록'
    const v = it || { kind: 0, name: '', cat: '', spec: '', no: '', qty: 1, unit: '개', got: '', price: 0, life: 0, loc: '', holder: '', status: 0, min: 0, lend: false, note: '' }
    document.querySelectorAll('[name=iKind]').forEach((r) => (r.checked = Number(r.value) === v.kind))
    $('iName').value = v.name
    $('iCat').value = v.cat
    $('iSpec').value = v.spec
    $('iNo').value = v.no
    // a consumable shows what is on the shelf now; saving counts from this moment
    $('iQty').value = it && it.kind === 1 ? B.stockOf(it, loans) : v.qty
    $('iUnit').value = v.unit
    $('iMin').value = v.min
    $('iGot').value = v.got
    $('iPrice').value = v.price || ''
    $('iLife').value = v.life || ''
    $('iLoc').value = v.loc
    $('iHolder').value = v.holder
    $('iStatus').innerHTML = B.STATUS.map((s, i) => `<option value="${i}" ${v.status === i ? 'selected' : ''}>${s}</option>`).join('')
    $('iLend').checked = !!v.lend
    $('iNote').value = v.note
    $('catList').innerHTML = B.catsOf(items).map((c) => `<option value="${esc(c)}"></option>`).join('')
    $('locList').innerHTML = B.locsOf(items).map((c) => `<option value="${esc(c)}"></option>`).join('')
    $('holderList').innerHTML = members.map((m) => `<option value="${esc(m.name)}"></option>`).join('')
    $('itemError').textContent = ''
    kindChanged()
    $('itemDlg').showModal()
    $('iName').focus()
  }
  function kindChanged() {
    const consumable = document.querySelector('[name=iKind]:checked').value === '1'
    $('iMinBox').classList.toggle('hidden', !consumable)
    $('iLendBox').classList.toggle('hidden', consumable)
  }
  async function saveItem() {
    const kind = Number(document.querySelector('[name=iKind]:checked').value)
    const c = B.cleanItem({
      ...(editing || {}),
      kind,
      name: $('iName').value,
      cat: $('iCat').value,
      spec: $('iSpec').value,
      no: $('iNo').value,
      qty: $('iQty').value,
      unit: $('iUnit').value,
      min: $('iMin').value,
      got: $('iGot').value,
      price: $('iPrice').value,
      life: $('iLife').value,
      loc: $('iLoc').value,
      holder: $('iHolder').value,
      status: $('iStatus').value,
      lend: $('iLend').checked,
      note: $('iNote').value
    })
    if (c.error) return ($('itemError').textContent = c.error)
    const item = c.item
    const dup = item.no && items.find((x) => x.no === item.no && x.id !== item.id)
    if (dup) return ($('itemError').textContent = `관리번호 ${item.no}은(는) 이미 "${dup.name}"에 쓰였습니다.`)
    // the typed quantity of a consumable is its stock as of now
    if (kind === 1) item.baseAt = now()
    const isNew = !editing
    $('itemDlg').close()
    await mutate(
      (cur) => {
        if (isNew) return { items: [...cur, { ...item, id: B.makeId(new Set(cur.map((x) => x.id))) }] }
        if (!cur.some((x) => x.id === item.id)) return { error: '그 사이 지워진 물품입니다.' }
        return { items: cur.map((x) => (x.id === item.id ? item : x)) }
      },
      isNew ? `${item.name}을(를) 등록했습니다.` : '저장했습니다.'
    )
  }

  // ---------- item details ----------
  function openDetail(id) {
    detailId = id
    if (!drawDetail()) return
    if (!$('detailDlg').open) $('detailDlg').showModal()
  }
  function drawDetail() {
    const it = byId(detailId)
    if (!it) {
      if ($('detailDlg').open) $('detailDlg').close()
      return false
    }
    const t = today()
    const stock = B.stockOf(it, loans)
    const out = B.outQty(loans, it.id)
    const end = B.lifeEnd(it)
    const hist = loans.filter((l) => l.itemId === it.id)
    const lendable = it.kind === 1 || it.lend
    const can = lendable && it.status < 2 && stock > 0
    const row = (k, v) => (v ? `<div><dt>${k}</dt><dd>${v}</dd></div>` : '')
    $('detailBody').innerHTML = `
      <div class="card-top"><h2 class="th-dialog-title">${esc(it.name)}</h2>${badge(it)}</div>
      <dl class="info">
        ${row('구분', B.KINDS[it.kind] + (it.lend ? ' · 대여용' : ''))}
        ${row('분류', esc(it.cat))}
        ${row('규격·모델', esc(it.spec))}
        ${row('관리번호', esc(it.no))}
        ${row(it.kind === 1 ? '현재 재고' : '수량', `${num(it.kind === 1 ? stock : it.qty)} ${esc(it.unit)}${it.kind === 1 && it.min ? ` <span class="th-muted">(최소 ${num(it.min)})</span>` : ''}${B.isLow(it, loans) ? ` ${mark('important', '재고 부족')}` : ''}${out ? ` <span class="th-muted">· 대여 중 ${num(out)}, 남은 수량 ${num(stock)}</span>` : ''}`)}
        ${row('취득일', esc(it.got))}
        ${row('취득가액', it.price ? `${won(it.price)}${it.qty > 1 ? ` <span class="th-muted">× ${num(it.qty)} = ${won(it.price * it.qty)}</span>` : ''}` : '')}
        ${row('내용연수', it.life ? `${it.life}년${end ? ` <span class="${B.lifeOver(it, t) ? 'over' : 'th-muted'}">(${end} ${B.lifeOver(it, t) ? '지남' : '까지'})</span>` : ''}` : '')}
        ${row('보관 위치', esc(it.loc))}
        ${row('사용자', esc(it.holder))}
        ${row('최근 조사일', esc(it.auditAt))}
        ${row('비고', esc(it.note))}
      </dl>
      <div class="btns">
        ${lendable ? `<button class="th-btn" data-act="take" ${can ? '' : 'disabled'}>${it.kind === 1 ? '지급 받기' : '대여하기'}</button>` : ''}
        ${isManager() && it.kind === 1 ? '<button class="th-btn th-btn-outline" data-act="stock">입고·재고 조정</button>' : ''}
        ${lendable && !can ? `<span class="th-xs th-muted">${it.status >= 2 ? `${B.STATUS[it.status]} 상태라 ${it.kind === 1 ? '지급' : '대여'}할 수 없습니다.` : '남은 수량이 없습니다.'}</span>` : ''}
        <span class="th-grow"></span>
        ${isManager() ? `<button class="th-btn th-btn-outline" data-act="edit">${icon('pencil')} 수정</button><button class="th-btn th-btn-ghost danger" data-act="del">${icon('trash-2')} 삭제</button>` : ''}
        <button class="th-btn th-btn-outline" data-close>닫기</button>
      </div>
      <div class="sub-head"><h3>대여·지급 이력</h3><span class="th-xs th-muted">${hist.length ? `${num(hist.length)}건` : ''}</span></div>
      ${hist.length ? `<div class="th-card">${loanTable(hist.slice(0, 50), false)}</div>` : '<p class="th-hint">기록이 없습니다.</p>'}`
    return true
  }

  // ---------- 대여·지급 ----------
  function openLoan(it) {
    const stock = B.stockOf(it, loans)
    const issue = it.kind === 1
    $('loanTitle').textContent = issue ? '소모품 지급' : '대여'
    $('loanSubmit').textContent = issue ? '지급 기록' : '대여 기록'
    $('loanItem').textContent = `${it.name}${it.spec ? ` (${it.spec})` : ''} · 남은 수량 ${num(stock)}${it.unit}`
    $('lQty').max = stock
    $('lQty').value = 1
    $('lDue').value = ''
    $('lDue').min = today()
    $('lDueBox').classList.toggle('hidden', issue)
    $('lNote').value = ''
    $('lWhoBox').classList.toggle('hidden', !isManager())
    $('lWho').innerHTML = `<option value="">나 (${esc(me.name)})</option>${members.filter((m) => m.id !== me.id).map((m) => `<option value="${esc(m.name)}">${esc(m.deptName ? `${m.deptName} · ${m.name}` : m.name)}</option>`).join('')}`
    $('loanError').textContent = ''
    $('loanForm').dataset.item = it.id
    $('loanDlg').showModal()
  }
  async function submitLoan() {
    const req = { qty: $('lQty').value, due: $('lDue').value, note: $('lNote').value, who: isManager() ? $('lWho').value : '' }
    try {
      // somebody may have taken the last one a moment ago
      await syncClock()
      await refreshHead()
    } catch (e) {
      return ($('loanError').textContent = e.message || '서버에 연결하지 못했습니다.')
    }
    const it = byId($('loanForm').dataset.item)
    if (!it) return ($('loanError').textContent = '그 사이 지워진 물품입니다.')
    const r = B.takeOut(myEntry, it, loans, req, now())
    if (r.error) return ($('loanError').textContent = r.error)
    $('loanDlg').close()
    saveEntry(() => r, `${it.name} ${num(r.loan.qty)}${it.unit}을(를) ${it.kind === 1 ? '지급' : '대여'} 기록했습니다.`)
    render()
  }
  function loanTable(list, withItem) {
    const t = today()
    return `<div class="th-table-wrap"><table class="th-table grid loans">
      <thead><tr><th>일시</th>${withItem ? '<th>품명</th>' : ''}<th class="r">수량</th><th>받은 사람</th><th>반납 예정</th><th>상태</th><th>비고</th><th class="th-no-print"></th></tr></thead>
      <tbody>${list
        .map((l) => {
          const it = byId(l.itemId)
          const mine = l.memberId === me.id
          const state = l.type === 1 ? mark('muted', '지급') : l.open ? (B.isOverdue(l, t) ? mark('urgent', '반납 지연') : mark('', '대여 중')) : `${mark('success', '반납')} <span class="th-xs th-muted th-nums">${dt(l.backAt)}</span>`
          const acts = []
          if (l.open && (mine || isManager())) acts.push(tool(`data-return="${esc(l.key)}"`, '반납'))
          // a slip of the hand can be taken back for a day
          if (mine && now() - l.at < B.DAY && (l.type === 1 || l.open)) acts.push(tool(`data-cancel="${esc(l.id)}"`, '기록 취소', 'th-btn-ghost danger'))
          return `<tr>
            <td class="th-nums">${dt(l.at)}</td>
            ${withItem ? `<td>${it ? `<a href="#" data-item="${esc(it.id)}"><b>${esc(it.name)}</b></a>${it.no ? ` <span class="th-xs th-muted th-nums">${esc(it.no)}</span>` : ''}` : '<span class="th-muted">(지운 물품)</span>'}</td>` : ''}
            <td class="r">${num(l.qty)}${it ? ` ${esc(it.unit)}` : ''}</td>
            <td>${esc(l.name)}${l.who ? ` <span class="th-xs th-muted">${esc(l.by)} 기록</span>` : ''}</td>
            <td class="th-nums">${esc(l.due)}</td>
            <td>${state}</td>
            <td>${esc(l.note)}</td>
            <td class="th-no-print acts">${acts.join('')}</td>
          </tr>`
        })
        .join('')}</tbody></table></div>`
  }
  function renderLoans() {
    const open = loans.filter((l) => l.open)
    const mine = loans.filter((l) => l.memberId === me.id || l.name === me.name)
    const list = loanView === 'open' ? open : loanView === 'mine' ? mine : loans
    const chip = (v, label, n) => chipBtn(`data-loanview="${v}"`, loanView === v, label, n)
    $('main').innerHTML = `<div class="stack">
      <div class="filters th-no-print">
        <div class="th-chips">${chip('open', '대여 중', open.length)}${chip('mine', '내 기록', mine.length)}${chip('all', '전체 이력', loans.length)}</div>
        <span class="th-grow"></span>
        ${tool(`id="loanCsv" ${loans.length ? '' : 'disabled'}`, `${icon('download')} CSV 저장`)}
        ${tool(`id="printBtn" ${list.length ? '' : 'disabled'}`, `${icon('file-text')} 인쇄`)}
      </div>
      <p class="th-hint th-no-print">대여하거나 소모품을 받으려면 [대장]에서 물품을 눌러 기록합니다. 빌린 사람과 담당자가 반납을 기록할 수 있습니다.</p>
      ${list.length ? `<div class="th-card">${loanTable(list.slice(0, 500), true)}</div>` : empty(icon('package'), loanView === 'open' ? '대여 중인 물품이 없습니다' : '기록이 없습니다', '대여·반납과 소모품 지급 기록이 여기에 모입니다.')}
    </div>`
  }
  function returnLoan(key) {
    const l = loans.find((x) => x.key === key)
    if (!l || !l.open) return
    const it = byId(l.itemId)
    const label = `${it ? it.name : '물품'} 반납을 기록했습니다.`
    if (l.memberId === me.id) saveEntry((e) => B.giveBack(e, l.id, now()), label)
    else if (isManager()) saveEntry((e) => B.markReturned(e, l.key, now()), label)
    render()
  }

  // ---------- 재물조사 ----------
  function auditRow(it) {
    const c = checks.get(it.id)
    const want = B.expected(it, loans)
    const btn = (code, label) => `<button class="th-chip ck c${code} ${c && c.code === code ? 'on' : ''}" data-check="${code}" aria-pressed="${!!(c && c.code === code)}">${label}</button>`
    return `<tr data-audit="${esc(it.id)}" class="${c ? `r${c.code}` : ''}">
      <td class="th-nums">${esc(it.no)}</td>
      <td><b>${esc(it.name)}</b>${it.spec ? sub(esc(it.spec)) : ''}</td>
      <td>${esc(it.loc)}${it.holder ? sub(esc(it.holder)) : ''}</td>
      <td class="r">${num(want)} ${esc(it.unit)}</td>
      <td class="r"><input class="th-input th-nums qty" type="number" min="0" step="1" value="${c ? c.qty : ''}" placeholder="${want}" aria-label="조사 수량" data-keep /><span class="th-print-only">${c ? num(c.qty) : ''}</span></td>
      <td class="th-no-print cks">${btn(1, '확인')}${btn(2, '없음')}${btn(3, '이상')}</td>
      <td class="th-print-only">${c ? B.CHECKS[c.code] : ''}</td>
      <td><input class="th-input memo" maxlength="200" value="${c ? esc(c.note) : ''}" placeholder="메모" aria-label="메모" data-keep /><span class="th-print-only">${c ? esc(c.note) : ''}</span></td>
      <td class="th-xs th-muted th-nums who">${c ? `${esc(c.name)}<br />${dt(c.at)}` : ''}</td>
    </tr>`
  }
  const stats = (s) => `<span>확인 <b>${num(s.ok)}</b></span><span>이상 <b>${num(s.bad)}</b></span><span>없음 <b>${num(s.missing)}</b></span><span>미확인 <b>${num(s.todo)}</b></span><span>수량 차이 <b>${num(s.diff)}</b></span>`
  function auditHead() {
    const s = B.auditStats(items, checks, loans)
    const done = s.total - s.todo
    return `<div class="th-card-header card-top"><h2 class="th-card-title">${esc(audit().title)}</h2>${mark('', `진행 중 · ${B.ymd(audit().at)} 시작`)}</div>
      <div class="th-card-body stack tight">
        <div class="progress"><div class="th-meter"><i style="width:${s.total ? Math.round((done / s.total) * 100) : 0}%"></i></div><b class="th-nums">${num(done)} / ${num(s.total)}</b></div>
        <div class="meta th-xs th-muted th-nums">${stats(s)}</div>
      </div>`
  }
  function auditChips() {
    const s = B.auditStats(items, checks, loans)
    const chip = (v, label, n) => chipBtn(`data-auditview="${v}"`, auditView === v, label, n)
    return chip('todo', '미확인', s.todo) + chip('issue', '없음·이상', s.missing + s.bad) + chip('all', '전체', s.total)
  }
  function auditList() {
    const targets = B.auditTargets(items).filter((it) => !auditLoc || (it.loc || '위치 없음') === auditLoc)
    return B.sortItems(
      targets.filter((it) => {
        const c = checks.get(it.id)
        return auditView === 'all' || (auditView === 'todo' ? !c : !!c && c.code !== 1)
      }),
      'loc',
      'asc',
      ctx()
    )
  }
  function renderAudit() {
    const a = audit()
    if (!a) {
      const last = book.head.shared.last
      $('main').innerHTML = `<div class="stack">
        ${empty(icon('clipboard-list'), '진행 중인 재물조사가 없습니다', isManager() ? '재물조사를 시작하면 대장을 볼 수 있는 모두가 물품을 나누어 확인할 수 있습니다.' : '담당자가 재물조사를 시작하면 여기서 물품을 확인합니다.', isManager() ? `<div class="btns center"><input class="th-input" id="auditTitle" maxlength="40" value="${esc(`${today().slice(0, 4)}년 ${Number(today().slice(5, 7))}월 재물조사`)}" aria-label="재물조사 이름" /><button class="th-btn" id="auditStart" ${items.length ? '' : 'disabled'}>재물조사 시작</button></div>` : '')}
        ${last ? `<section class="th-card last"><div class="th-card-header"><h2 class="th-card-title">지난 재물조사</h2><span>${esc(last.title)}</span><span class="th-xs th-muted th-nums">${B.ymd(last.at)} ~ ${B.ymd(last.closedAt)}</span></div><div class="th-card-body meta th-xs th-muted th-nums"><span>대상 <b>${num(last.total)}</b></span>${stats(last)}</div></section>` : ''}
      </div>`
      return
    }
    const list = auditList()
    const locs = Array.from(new Set(B.auditTargets(items).map((it) => it.loc || '위치 없음'))).sort((x, y) => x.localeCompare(y, 'ko', { numeric: true }))
    $('main').innerHTML = `<div class="stack">
      <section class="th-card" id="auditHead">${auditHead()}</section>
      <div class="filters th-no-print">
        <div class="th-chips" id="auditChips">${auditChips()}</div>
        <select class="th-input" id="auditLoc" aria-label="보관 위치">${options(locs, auditLoc, '위치 전체')}</select>
        <span class="th-grow"></span>
        ${tool('id="auditCsv"', `${icon('download')} 결과 CSV 저장`)}
        ${tool('id="printBtn"', `${icon('file-text')} 조사표 인쇄`)}
        ${isManager() ? tool('id="auditClose"', `${icon('lock')} 조사 마감`, 'primary') : ''}
      </div>
      <p class="th-hint th-no-print">물품을 눈으로 확인하고 [확인]·[없음]·[이상]을 누르세요. 수량이 다르면 조사 수량을 고치고, 다시 누르면 지워집니다. 누가 눌렀든 가장 나중 것이 결과입니다.</p>
      ${
        list.length
          ? `<div class="th-card"><div class="th-table-wrap"><table class="th-table grid audit"><thead><tr><th>관리번호</th><th>품명</th><th>위치·사용자</th><th class="r">장부 수량</th><th class="r">조사 수량</th><th class="th-no-print">결과</th><th class="th-print-only">결과</th><th>메모</th><th>조사한 사람</th></tr></thead><tbody>${list.slice(0, 1000).map(auditRow).join('')}</tbody></table></div></div>`
          : empty(icon('circle-check'), auditView === 'todo' ? '모두 확인했습니다' : '해당하는 물품이 없습니다', auditView === 'todo' ? '[전체]에서 결과를 볼 수 있습니다.' : '')
      }
    </div>`
  }
  function doCheck(tr, code) {
    const it = byId(tr.dataset.audit)
    if (!it) return
    const cur = checks.get(it.id)
    const qty = tr.querySelector('.qty').value
    const note = tr.querySelector('.memo').value
    // pressing the chosen result again clears it
    const next = code === null ? (cur ? cur.code : 0) : cur && cur.code === code && cur.memberId === me.id ? 0 : code
    if (!next) {
      if (!cur || cur.memberId !== me.id) return
    }
    if (!saveEntry((e) => B.setCheck(e, audit(), it, { code: next, qty, note }, now(), loans))) return
    // only this row and the numbers: the list keeps its place while I walk through it
    tr.outerHTML = auditRow(it)
    if ($('auditHead')) $('auditHead').innerHTML = auditHead()
    if ($('auditChips')) $('auditChips').innerHTML = auditChips()
  }
  async function closeAuditNow() {
    const s = B.auditStats(items, checks, loans)
    if (!window.confirm(`재물조사를 마감할까요?\n\n확인 ${s.ok} · 이상 ${s.bad} · 없음 ${s.missing} · 미확인 ${s.todo}\n\n확인된 물품에 조사일이 적히고, 소모품은 조사 수량이 재고가 됩니다.\n마감하면 결과 화면은 사라지니 필요하면 먼저 [결과 CSV 저장]을 하세요.`)) return
    // mutate reads everything again first, so `checks` and `loans` are the newest when this runs
    await mutate((cur, shared) => {
      if (!shared.audit) return { error: '이미 마감된 재물조사입니다.' }
      const r = B.closeAudit(cur, checks, shared.audit, now(), loans)
      return { items: r.items, meta: { audit: null, last: r.last } }
    }, '재물조사를 마감했습니다.')
  }

  // ---------- 현황 ----------
  function renderSummary() {
    const s = B.summary(items, loans, today())
    const tile = (label, value, cls, go) => `<button class="th-card tile ${cls || ''}" ${go ? `data-go="${go}"` : 'disabled'}><span class="th-xs th-muted">${label}</span><b class="th-nums">${value}</b></button>`
    const max = (list, k) => Math.max(1, ...list.map((x) => x[k]))
    const bars = (list, k, fmt) => list.map((r) => `<div class="bar-row"><span class="bar-label">${esc(r.name)}</span><div class="th-meter"><i style="width:${Math.round((r[k] / max(list, k)) * 100)}%"></i></div><span class="count th-xs th-muted th-nums">${fmt(r)}</span></div>`).join('')
    const group = (title, body) => `<section class="th-card"><div class="th-card-header"><h2 class="th-card-title">${title}</h2></div><div class="th-card-body bars">${body || '<p class="th-hint">없음</p>'}</div></section>`
    $('main').innerHTML = `<div class="stack">
      <div class="filters th-no-print"><span class="th-xs th-muted note">폐기한 물품은 합계에서 뺍니다. 재고 부족·대여 중·내용연수 지남 칸을 누르면 해당 목록으로 갑니다.</span><span class="th-grow"></span>${tool('id="printBtn"', `${icon('file-text')} 인쇄`)}</div>
      <div class="tiles">
        ${tile('품목', `${num(s.count)}개`)}
        ${tile('수량 합계', num(s.qty))}
        ${tile('취득가액 합계', won(s.amount) || '0원')}
        ${tile('재고 부족', `${num(s.low)}개`, s.low ? 'warn' : '', 'low')}
        ${tile('대여 중', `${num(s.out)}건${s.overdue ? ` · 지연 ${num(s.overdue)}` : ''}`, s.overdue ? 'warn' : '', 'loans')}
        ${tile('내용연수 지남', `${num(s.over)}개`, s.over ? 'warn' : '', 'over')}
      </div>
      ${
        s.count || s.disposed
          ? `<div class="groups">
             ${group('분류별', bars(s.byCat, 'count', (r) => `${num(r.count)}개 · ${won(r.amount) || '0원'}`))}
             ${group('상태별', bars(s.byStatus, 'count', (r) => `${num(r.count)}개 · 수량 ${num(r.qty)}`))}
             ${group('보관 위치별', bars(s.byLoc, 'count', (r) => `${num(r.count)}개 · 수량 ${num(r.qty)}`))}
             </div>`
          : empty(icon('chart-column'), '등록된 물품이 없습니다', '물품을 등록하면 분류·상태·위치별 현황이 보입니다.')
      }
    </div>`
  }

  // ---------- register: pick, make, hand over, delete ----------
  const scopeText = (r) => (r.scope.type === 'team' ? '팀 전체' : r.scope.type === 'group' ? `그룹 ${r.scope.groups.map((x) => x.name).join(', ')}` : `지정한 사람 ${r.scope.members.length}명`)
  function drawManage() {
    $('manageBody').innerHTML = `<h2 class="th-dialog-title">대장 관리</h2>
      <div class="form">
      ${
        book
          ? `<dl class="info one">
              <div><dt>대장</dt><dd><b>${esc(book.head.title)}</b></dd></div>
              <div><dt>담당자</dt><dd>${esc(book.head.createdByName)} <span class="th-muted">(대장을 만든 사람. 물품 등록·수정·재물조사 시작)</span></dd></div>
              <div><dt>볼 수 있는 사람</dt><dd>${esc(scopeText(book.head))}</dd></div>
              <div><dt>물품</dt><dd>${num(items.length)}개 ${book.vols.length ? `<span class="th-muted">(${book.vols.length + 1}권에 나누어 저장)</span>` : ''}</dd></div>
            </dl>
            <div class="btns">
              ${tool('id="tplBtn2"', `${icon('download')} CSV 양식 받기`)}
              ${isManager() ? `${tool('id="backupBtn"', `${icon('save')} 백업 파일 저장`)}<span class="th-grow"></span>${tool('id="delBook"', `${icon('trash-2')} 이 대장 삭제`, 'th-btn-ghost danger')}` : ''}
            </div>
            <p class="th-hint">담당자가 바뀌면: 지금 담당자가 [백업 파일 저장] → 새 담당자가 [새 대장 만들기]에서 그 파일을 고름 → 예전 대장 삭제. 대여·지급 기록은 옮겨지지 않습니다(소모품은 지금 재고로 저장).</p>`
          : '<p class="th-muted">아직 볼 수 있는 대장이 없습니다.</p>'
      }
      </div>
      <div class="dlg-btns"><button class="th-btn" id="newBook">${icon('plus')} 새 대장 만들기</button><span class="th-grow"></span><button class="th-btn th-btn-outline" data-close>닫기</button></div>`
  }
  function openNew() {
    backup = null
    $('nTitle').value = ''
    $('nBackupInfo').textContent = '고르지 않으면 빈 대장으로 시작합니다. 엑셀 자료는 만든 뒤 [CSV 가져오기]로 넣습니다.'
    document.querySelector('[name=nScope][value=team]').checked = true
    $('nMembers').classList.add('hidden')
    $('nMembers').innerHTML = members.filter((m) => m.id !== me.id).map((m) => `<label class="th-check"><input type="checkbox" value="${esc(m.id)}" /> ${esc(m.name)} <small>${esc(m.deptName || '')}</small></label>`).join('') || '<p class="th-hint">팀원이 없습니다.</p>'
    $('newError').textContent = ''
    if ($('manageDlg').open) $('manageDlg').close()
    $('newDlg').showModal()
  }
  async function createBook() {
    const title = $('nTitle').value.trim()
    const toTeam = document.querySelector('[name=nScope]:checked').value === 'team'
    const ids = Array.from(document.querySelectorAll('#nMembers input:checked')).map((x) => x.value)
    if (!title) return ($('newError').textContent = '대장 이름을 입력하세요.')
    if (!toTeam && !ids.length) return ($('newError').textContent = '볼 수 있는 사람을 한 명 이상 고르세요.')
    try {
      const head = await call('rooms.create', { title, scope: { type: toTeam ? 'team' : 'members', groupIds: [], memberIds: toTeam ? [] : ids }, shared: B.headShared({}, []) })
      wanted = head.id
      const start = backup
      backup = null
      $('newDlg').close()
      await load()
      if (start && start.length) await mutate(() => ({ items: start }), `${title}: 물품 ${num(start.length)}개를 가져왔습니다.`)
      else toast(`${title}을(를) 만들었습니다.`)
      remember()
      switchTab('list')
    } catch (e) {
      $('newError').textContent = e.message || '만들지 못했습니다.'
    }
  }
  async function deleteBook() {
    if (!book || !isManager()) return
    if (!window.confirm(`"${book.head.title}" 대장을 삭제할까요?\n\n물품 ${items.length}개와 모든 대여·지급·재물조사 기록이 지워지고 되돌릴 수 없습니다.\n필요하면 먼저 [백업 파일 저장]을 하세요.`)) return
    try {
      for (const v of book.vols) await call('rooms.delete', { roomId: v.id })
      await call('rooms.delete', { roomId: book.head.id })
      wanted = ''
      $('manageDlg').close()
      await load()
      toast('대장을 삭제했습니다.')
    } catch (e) {
      toast(e.message || '삭제하지 못했습니다.')
      await load().catch(() => undefined)
    }
    render()
  }
  const remember = () => void call('storage.set', { key: 'last', value: wanted }).catch(() => undefined)
  const stamp = () => today().replace(/-/g, '')
  const save = (name, text) =>
    call('file.save', { name, text }).then(
      (r) => r && r.ok && toast('저장했습니다.'),
      (e) => toast(e.message)
    )
  async function importFile() {
    let r
    try {
      r = await call('file.open', { exts: ['csv', 'tsv', 'txt'] })
    } catch (e) {
      return toast(e.message)
    }
    if (!r || !r.ok) return r && r.error && toast(r.error)
    const first = B.importCsv(r.text, items)
    if (first.error) return toast(first.error)
    const notes = first.skipped.slice(0, 8).map((s) => `· ${s.line}번째 줄: ${s.reason}`)
    if (!window.confirm(`${r.name}\n\n새 물품 ${first.added}개, 고칠 물품 ${first.updated}개(관리번호가 같은 것)${first.skipped.length ? `\n\n확인할 줄 ${first.skipped.length}개\n${notes.join('\n')}${first.skipped.length > notes.length ? '\n…' : ''}` : ''}\n\n대장에 넣을까요?`)) return
    // read again against the newest items: somebody (me, elsewhere) may have changed them
    await mutate((cur) => {
      const again = B.importCsv(r.text, cur)
      return again.error ? again : { items: again.items }
    }, `새 물품 ${first.added}개, 고친 물품 ${first.updated}개를 넣었습니다.`)
  }

  // ---------- print ----------
  function print() {
    const names = { list: '', loans: ' — 대여·지급 이력', audit: audit() ? ` — ${audit().title} 조사표` : '', summary: ' — 현황' }
    const f = []
    if (tab === 'list') {
      if (filter.q) f.push(`찾기 "${filter.q}"`)
      if (filter.kind !== '') f.push(B.KINDS[filter.kind])
      if (filter.cat) f.push(filter.cat)
      if (filter.status !== '') f.push(B.STATUS[filter.status])
      if (filter.loc) f.push(filter.loc)
      if (filter.flag) f.push({ low: '재고 부족', out: '대여 중', lend: '대여 가능', over: '내용연수 지남' }[filter.flag])
      if (!showAll && visible().length > SHOW_MAX) {
        // paper gets every row; the screen goes back to the short list afterwards
        showAll = true
        forPrint = true
        listBody()
      }
    }
    if (tab === 'audit' && auditLoc) f.push(auditLoc)
    $('printHead').innerHTML = `<h1>${esc(book.head.title)}${esc(names[tab])}</h1><p>${today()} 기준${f.length ? ` · ${esc(f.join(', '))}` : ''} · 담당자 ${esc(book.head.createdByName)}</p>`
    window.print()
  }

  // ---------- render ----------
  function render() {
    document.querySelectorAll('nav [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)))
    $('bookSel').classList.toggle('hidden', bookList.length < 2)
    $('bookSel').innerHTML = bookList.map((b) => `<option value="${esc(b.head.id)}" ${book && b.head.id === book.head.id ? 'selected' : ''}>${esc(b.head.title)}</option>`).join('')
    $('addBtn').classList.toggle('hidden', !isManager())
    $('bar').classList.toggle('hidden', !book)
    $('bookInfo').textContent = book ? `${book.head.title} · 담당자 ${book.head.createdByName}` : ''
    document.title = book ? book.head.title : '비품관리대장'
    if (!book) {
      $('main').innerHTML = empty(icon('archive'), '비품관리대장을 만드세요', '대장을 만든 사람이 담당자가 되어 물품을 등록하고, 팀원은 찾아보고 대여·지급·재물조사를 기록합니다.', `<button class="th-btn" id="firstBook">${icon('plus')} 대장 만들기</button>`)
      return
    }
    if (tab === 'list') renderList()
    else if (tab === 'loans') renderLoans()
    else if (tab === 'audit') renderAudit()
    else renderSummary()
    if ($('detailDlg').open) drawDetail()
    if ($('manageDlg').open) drawManage()
  }
  const switchTab = (t) => {
    tab = t
    $('main').innerHTML = ''
    render()
  }

  // ---------- events ----------
  document.querySelector('nav').addEventListener('click', (e) => {
    const b = e.target.closest('[role=tab]')
    if (b) switchTab(b.dataset.tab)
  })
  $('bookSel').addEventListener('change', (e) => {
    wanted = e.target.value
    remember()
    pending = 0
    book = B.bookOf(bookList, wanted)
    derive()
    Object.assign(filter, { q: '', kind: '', cat: '', status: '', loc: '', flag: '' })
    auditLoc = ''
    switchTab(tab)
  })
  $('addBtn').addEventListener('click', () => openItem(null))
  $('manageBtn').addEventListener('click', () => {
    drawManage()
    $('manageDlg').showModal()
  })
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]')
    if (c) c.closest('dialog').close()
  })
  let typing = 0
  $('main').addEventListener('input', (e) => {
    if (e.target.id !== 'q') return
    filter.q = e.target.value
    clearTimeout(typing)
    typing = setTimeout(listBody, 150)
  })
  $('main').addEventListener('change', (e) => {
    const t = e.target
    const map = { fKind: 'kind', fCat: 'cat', fStatus: 'status', fLoc: 'loc' }
    if (map[t.id]) {
      filter[map[t.id]] = t.value
      return listBody()
    }
    if (t.id === 'auditLoc') {
      auditLoc = t.value
      return renderAudit()
    }
    // a changed count or memo of an item that already has a result
    const tr = t.closest('tr[data-audit]')
    if (tr && checks.get(tr.dataset.audit)) doCheck(tr, null)
  })
  $('main').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const tr = e.target.closest('#itemTable tr[data-item]')
    if (tr) openDetail(tr.dataset.item)
  })
  function onAction(e) {
    const t = e.target.closest('button, a[data-item], tr[data-item], th[data-sort]')
    if (!t) return
    if (t.tagName === 'A') e.preventDefault()
    const d = t.dataset
    if (d.sort) {
      sort.dir = sort.key === d.sort && sort.dir === 'asc' ? 'desc' : 'asc'
      sort.key = d.sort
      return listBody()
    }
    if (d.flag !== undefined) {
      filter.flag = d.flag
      return listBody()
    }
    if (d.loanview) {
      loanView = d.loanview
      return renderLoans()
    }
    if (d.auditview) {
      auditView = d.auditview
      return renderAudit()
    }
    if (d.check) return doCheck(t.closest('tr'), Number(d.check))
    if (d.return) return returnLoan(d.return)
    if (d.cancel) {
      if (!window.confirm('이 기록을 취소할까요? 잘못 기록한 경우에만 쓰세요.')) return
      saveEntry((en) => B.cancelLoan(en, d.cancel), '기록을 취소했습니다.')
      return render()
    }
    if (d.go) {
      if (d.go === 'loans') return switchTab('loans')
      Object.assign(filter, { q: '', kind: '', cat: '', status: '', loc: '', flag: d.go })
      return switchTab('list')
    }
    if (d.item) return openDetail(d.item)
    switch (t.id) {
      case 'moreRows':
        showAll = true
        return listBody()
      case 'csvOut':
        return void save(`${book.head.title}_${stamp()}.csv`, B.toCsv(visible(), ctx()))
      case 'csvIn':
        return void importFile()
      case 'tplBtn':
      case 'tplBtn2':
        return void save('비품관리대장_양식.csv', B.templateCsv())
      case 'loanCsv':
        return void save(`${book.head.title}_대여지급_${stamp()}.csv`, B.loansCsv(loans, items))
      case 'auditCsv':
        return void save(`${audit().title}_${stamp()}.csv`, B.auditCsv(items, checks, loans))
      case 'printBtn':
        return print()
      case 'firstBook':
      case 'newBook':
        return openNew()
      case 'backupBtn':
        return void save(`${book.head.title}_백업_${stamp()}.json`, B.toBackup(book.head.title, items, loans))
      case 'delBook':
        return void deleteBook()
      case 'auditStart': {
        const title = $('auditTitle').value.trim() || '재물조사'
        return void mutate((cur, shared) => (shared.audit ? { error: '이미 진행 중인 재물조사가 있습니다.' } : { items: cur, meta: { audit: { id: B.makeId(new Set()), title, at: now() }, last: shared.last } }), `${title}을(를) 시작했습니다.`)
      }
      case 'auditClose':
        return void closeAuditNow()
    }
  }
  $('main').addEventListener('click', onAction)
  $('manageBody').addEventListener('click', onAction)
  $('detailBody').addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.dataset.return || b.dataset.cancel) return onAction(e)
    const it = byId(detailId)
    if (!it || !b.dataset.act) return
    if (b.dataset.act === 'take') return openLoan(it)
    if (b.dataset.act === 'stock') {
      $('stockItem').textContent = `${it.name} · 지금 재고 ${num(B.stockOf(it, loans))}${it.unit}`
      $('sQty').value = ''
      $('stockError').textContent = ''
      document.querySelector('[name=sMode][value=in]').checked = true
      $('stockDlg').showModal()
      return $('sQty').focus()
    }
    if (b.dataset.act === 'edit') {
      $('detailDlg').close()
      return openItem(it)
    }
    if (b.dataset.act === 'del') {
      if (B.outQty(loans, it.id)) return toast('대여 중인 물품입니다. 반납을 기록한 뒤 지우세요.')
      if (!window.confirm(`${it.name}을(를) 대장에서 지울까요?\n\n쓰지 않게 된 물품은 지우지 말고 상태를 "불용"이나 "폐기"로 바꾸면 기록이 남습니다.`)) return
      $('detailDlg').close()
      void mutate((cur) => ({ items: cur.filter((x) => x.id !== it.id) }), `${it.name}을(를) 지웠습니다.`)
    }
  })
  document.querySelectorAll('[name=iKind]').forEach((r) => r.addEventListener('change', kindChanged))
  $('itemForm').addEventListener('submit', (e) => {
    e.preventDefault()
    void saveItem()
  })
  $('loanForm').addEventListener('submit', (e) => {
    e.preventDefault()
    void submitLoan()
  })
  $('stockForm').addEventListener('submit', (e) => {
    e.preventDefault()
    const n = Math.round(Number($('sQty').value))
    const add = document.querySelector('[name=sMode]:checked').value === 'in'
    if (!Number.isFinite(n) || n < 0 || (add && n === 0)) return ($('stockError').textContent = '수량을 입력하세요.')
    const id = detailId
    $('stockDlg').close()
    void mutate((cur) => {
      const it = cur.find((x) => x.id === id)
      if (!it) return { error: '그 사이 지워진 물품입니다.' }
      // from now on the stock is this number minus what is issued later
      const qty = Math.min(B.LIMITS.qtyMax, add ? B.stockOf(it, loans) + n : n)
      return { items: cur.map((x) => (x.id === id ? { ...x, qty, baseAt: now() } : x)) }
    }, add ? `${num(n)} 입고했습니다.` : '재고를 맞췄습니다.')
  })
  document.querySelectorAll('[name=nScope]').forEach((r) => r.addEventListener('change', () => $('nMembers').classList.toggle('hidden', document.querySelector('[name=nScope]:checked').value === 'team')))
  $('nBackup').addEventListener('click', async () => {
    try {
      const r = await call('file.open', { exts: ['json'] })
      if (!r || !r.ok) return r && r.error && ($('newError').textContent = r.error)
      const b = B.fromBackup(r.text)
      if (b.error) return ($('newError').textContent = b.error)
      backup = b.items
      $('newError').textContent = ''
      $('nBackupInfo').textContent = `${r.name}: 물품 ${num(b.items.length)}개를 가져옵니다.`
      if (!$('nTitle').value.trim()) $('nTitle').value = b.title
    } catch (e) {
      $('newError').textContent = e.message
    }
  })
  $('newForm').addEventListener('submit', (e) => {
    e.preventDefault()
    void createBook()
  })
  // what changed behind an open dialog shows when it closes
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('close', () => me && !document.querySelector('dialog[open]') && !busy && render()))
  window.addEventListener('afterprint', () => {
    $('printHead').innerHTML = ''
    if (!forPrint) return
    forPrint = false
    showAll = false
    if (tab === 'list' && $('listBody')) listBody()
  })

  // an older TeamHub does not give extension frames its look (__ui.css): say so

  let again = 0
  async function changed() {
    if (busy) return
    await load().catch(() => undefined)
    clearTimeout(again)
    const el = document.activeElement
    // not while somebody types a count or a memo, or works in a form
    if ((el && el.dataset && 'keep' in el.dataset) || document.querySelector('dialog[open]:not(#detailDlg):not(#manageDlg)')) again = setTimeout(changed, 4000)
    else render()
  }
  window.TeamHub.on('room.changed', () => void changed())

  ;(async () => {
    try {
      me = await call('me')
      if (!me) throw new Error('서버에 연결한 뒤 쓸 수 있습니다.')
      await syncClock()
      members = await call('members').catch(() => [])
      if (!wanted) wanted = (await call('storage.get', { key: 'last' }).catch(() => '')) || ''
      await load()
      render()
    } catch (e) {
      $('main').innerHTML = empty(icon('triangle-alert'), '불러오지 못했습니다', e.message || '서버 연결을 확인하세요.')
    }
  })()
  setInterval(() => void syncClock(), 10 * 60000)
})()
