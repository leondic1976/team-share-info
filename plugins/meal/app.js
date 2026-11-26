/* Meal request UI. Talks to TeamHub only via TeamHub.call (see __sdk.js).
 *
 * One team room made by an admin holds the settings, who is in charge (식수서무) and the menus;
 * my requests are my own entry of that room. A 식수서무 cannot write the room's shared data
 * (the server lets only its maker), so their settings and menus go into their own entry and
 * Meal.effective() merges everything. Deadlines and the times of saves follow the server's
 * clock (TeamHub.call('time')). The look comes from TeamHub (__ui.css, the th-* classes). */
;(function () {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const M = window.Meal
  // line icons come from TeamHub (TeamHub.icon); an older TeamHub without them shows the text only
  const icon = (n, o) => (window.TeamHub.icon ? window.TeamHub.icon(n, o) : '')
  const call = (m, p) => window.TeamHub.call(m, p)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  let me = null
  let members = []
  let room = null
  let priceRoom = null // 식대 단가 (1.7.0): a room of its own, see Meal.effectivePrices
  let tab = 'apply'
  let offset = 0 // server clock - this PC's clock
  let statusDate = ''
  let month = ''
  let menuWeek = '' // Monday of the week shown in the 메뉴 tab
  let menuEdit = false
  let snap = {} // 'date|slot' → text when a menu form was opened: only cells changed since are saved
  let busy = false
  let holidays = [] // [{ date, name }] from TeamHub (관리 → 공휴일)
  const proxySel = { lunch: '', dinner: '' } // who is picked in "대신 신청"
  let statsView = 'summary' // 통계: summary | daily | person | dept
  let mineMonth = '' // 내 기록: the month shown
  const saved = {} // 통계: month -> snapshot kept on this PC (undefined: not read yet)

  const now = () => Date.now() + offset
  let effOf = null
  let effValue = null
  /** The settings and menus that count: the owner's shared data merged with the 식수서무's entries. */
  const eff = () => {
    if (effOf !== room || !effValue) {
      effOf = room
      effValue = M.effective(room)
    }
    return effValue
  }
  const config = () => M.withHolidays(eff().config, holidays)
  /** The price list that counts: [{ from, lunch, dinner }]. */
  const prices = () => M.effectivePrices(room, priceRoom).prices
  const canProxy = () => M.canProxy(room, me.id)
  const canManage = () => M.canManage(room, me.id)
  const isOwner = () => !!room && room.createdBy === me.id
  /** 통계: those in charge (the admin who made the settings, the 식수서무) and the server PC (지시 90). */
  const canStats = () => canManage() || !!me.isOwner
  const mine = () => (room && room.entries && room.entries[me.id] ? room.entries[me.id].value : null)
  const pad = (n) => String(n).padStart(2, '0')
  const hm = (ms) => {
    const d = new Date(ms)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const stamp = (ms) => {
    const d = new Date(ms)
    return `${d.getMonth() + 1}/${d.getDate()} ${hm(ms)}`
  }
  const nameOf = (id) => {
    const m = members.find((x) => x.id === id)
    if (m) return m.name
    if (M.isManualId(id) && eff().people[id]) return eff().people[id].name
    if (room && room.entries && room.entries[id] && room.entries[id].name) return room.entries[id].name
    return room && room.createdBy === id ? room.createdByName || '관리자' : '(이름 없음)'
  }
  const byDept = (a, b) => (a.deptName || '').localeCompare(b.deptName || '', 'ko') || a.name.localeCompare(b.name, 'ko')
  /** "식수서무 김○○, 이○○ · 관리자 박○○": whom to ask. */
  const chargeText = () => `식수서무 ${eff().stewards.map(nameOf).join(', ') || '지정 안 됨'} · 관리자 ${nameOf(room.createdBy)}`
  function toast(msg, ms) {
    const t = $('toast')
    t.textContent = msg
    t.classList.add('show')
    clearTimeout(toast.t)
    toast.t = setTimeout(() => t.classList.remove('show'), ms || 3200)
  }
  const empty = (name, title, body, action) => `<div class="th-empty empty">${icon(name)}<p class="th-empty-title">${esc(title)}</p><p>${esc(body)}</p>${action || ''}</div>`
  const badge = (kind, text) => `<span class="th-badge${kind ? ` th-badge-${kind}` : ''}">${text}</span>`
  const noMenu = () => badge('muted', '메뉴 미등록')
  /** Members and the people registered by hand: everybody a request can be made for. */
  const everyone = () => M.roster(room, members)
  /** The mark of somebody registered by hand (staff who do not use TeamHub). */
  const MANUAL_TIP = 'TeamHub를 쓰지 않는 직원(미등록 인원) — TeamHub 관리에 등록됨'
  const manualMark = (p) => (p && p.manual ? ` <span class="th-badge th-badge-important" title="${MANUAL_TIP}">미등록</span>` : '')
  /** " (미등록 3명 포함)" after a count, when there are any. */
  const manualNote = (list) => (M.splitCount(list).manual ? ` <span class="th-xs th-muted">(미등록 ${M.splitCount(list).manual}명 포함)</span>` : '')
  const menuLines = (t) => `<p class="menu-lines">${esc(t)}</p>`

  async function syncClock() {
    try {
      const before = Date.now()
      const r = await call('time')
      // half of the round trip is a fair guess of when the server read its clock
      offset = r.now - (before + Date.now()) / 2
    } catch {
      offset = 0 // an older TeamHub without the call: this PC's clock
    }
  }
  async function loadHolidays() {
    try {
      const w = M.menuWindow(now())
      holidays = await call('holidays', { from: w.from, to: w.to })
    } catch {
      holidays = [] // an older TeamHub without the call: no holiday is skipped
    }
  }
  /** 1.8.0: TeamHub's one list of 미등록 인원 (관리); an older TeamHub without it: the room's own list as before. */
  async function loadPeople() {
    try {
      M.setCorePeople(await call('unregistered'))
    } catch {
      M.setCorePeople(null)
    }
  }
  async function load() {
    const all = await call('rooms.list')
    room = M.pickRoom(all)
    priceRoom = M.pickPriceRoom(all)
  }

  // ---------- 신청 ----------
  function mealTile(c, date, meal) {
    const st = M.stateOf(c, date, meal, now())
    if (st === 'off') return ''
    // the newest of my own request and one somebody made for me
    const rec = M.recordOf(room, members, me.id, date, meal)
    const on = !!(rec && rec.on)
    const firm = !!(rec && rec.firm)
    const at = rec ? rec.at : 0
    const who = rec && rec.by ? ` · ${esc(rec.byName)} 대신` : ''
    const count = M.dayList(room, date, meal, members).length
    const cut = M.cutoffAt(c, date, meal)
    const open = st === 'open'
    const text = M.menuOf(eff().menus, date, meal)
    const btn = (act, label, cls, title) => `<button class="th-btn th-btn-sm ${cls}" data-act="${act}" data-date="${date}" data-meal="${meal}" ${title ? `title="${title}"` : ''} ${busy ? 'disabled' : ''}>${label}</button>`
    // 확실히 신청안함: my own certain "no"; while it stands nobody else can request or cancel this meal for me
    const state = firm
      ? `${badge('urgent', `${icon('lock')} 확실히 신청안함`)}<span class="th-xs th-muted th-nums">${hm(at)} 본인 표시</span><span class="th-xs th-muted">대신 신청 불가</span>`
      : `${on ? badge('success', `${icon('circle-check')} 신청함`) : badge('muted', open ? '신청 안 함' : '신청하지 않음')}${at ? `<span class="th-xs th-muted th-nums">${hm(at)} ${on ? '신청' : '취소'}${who}</span>` : ''}`
    const acts = !open
      ? badge('muted', '마감')
      : firm
        ? `${btn('unfirm', '표시 풀기', 'th-btn-outline', '확실히 신청안함을 풉니다. 그 뒤에는 신청할 수 있고, 다른 사람도 대신 신청할 수 있습니다.')}${btn('apply', '신청', '')}`
        : `${btn('firm', '확실히 신청안함', 'th-btn-outline firm-btn', '이 식사는 먹지 않습니다. 표시해 두면 다른 사람이 대신 신청하거나 취소할 수 없고, 본인만 풀 수 있습니다.')}${btn(on ? 'cancel' : 'apply', on ? '취소' : at ? '다시 신청' : '신청', on ? 'th-btn-outline cancel' : '')}`
    return `<div class="tile ${on ? 'on' : ''} ${firm ? 'firm' : ''} ${open ? '' : 'locked'}" data-tile="${date}:${meal}">
      <div class="meal"><b>${M.MEALS[meal]}</b><span class="count th-xs th-muted th-nums">${count}명 신청</span></div>
      <div class="menu">${text ? esc(text.split('\n').join(', ')) : noMenu()}</div>
      <div class="state">${state}</div>
      <div class="deadline th-xs th-nums ${open ? '' : 'over'}">${open ? `${c.meals[meal].cutoff} 마감 · ${M.remaining(cut - now())}` : `${c.meals[meal].cutoff} 마감됨`}</div>
      <div class="act">${acts}</div>
    </div>`
  }
  function summaryCard(c, today) {
    const meals = M.menuMeals(c)
    const served = meals.filter((k) => M.stateOf(c, today, k, now()) !== 'off')
    const counts = served.length
      ? served.map((k) => `<span>${M.MEALS[k]} <b class="big">${M.dayList(room, today, k, members).length}</b>명${manualNote(M.dayList(room, today, k, members))}</span>`).join('')
      : `<span class="th-muted">${M.holidayName(c, today) ? `공휴일(${esc(M.holidayName(c, today))})이라 신청을 받지 않습니다` : '오늘은 신청을 받지 않습니다'}</span>`
    return `<section class="th-card" data-summary><div class="th-card-header">
      <h2 class="th-card-title">${M.dateLabel(today, today)}</h2>${counts}
      <span class="th-muted">마감 ${meals.map((k) => `${M.MEALS[k]} ${c.meals[k].cutoff}`).join(' · ')}</span>
      <span class="push th-xs th-muted" data-charge>${esc(chargeText())}</span>
    </div></section>`
  }
  function todayMenuCard(c, today) {
    const menus = eff().menus
    const meals = M.menuMeals(c).filter((k) => M.stateOf(c, today, k, now()) !== 'off')
    const note = M.menuOf(menus, today, 'note')
    const body = meals.length
      ? `${note ? `<div class="th-notice" style="margin-bottom:0.75rem">${esc(note)}</div>` : ''}${meals.map((k) => `<div class="slot" data-today-menu="${k}"><div class="slot-name">${M.MEALS[k]}</div>${M.menuOf(menus, today, k) ? menuLines(M.menuOf(menus, today, k)) : noMenu()}</div>`).join('')}`
      : '<p class="th-hint">오늘은 식사 신청을 받지 않는 날입니다.</p>'
    return `<section class="th-card today-menu" id="todayMenu"><div class="th-card-header" style="align-items:center">
      <h2 class="th-card-title">오늘의 메뉴</h2><span class="th-xs th-muted">${M.dateLabel(today, '')}</span>
      ${canManage() && meals.length ? `<button class="th-btn th-btn-ghost th-btn-sm push" data-menu-day="${today}">${icon('pencil')} 메뉴 등록</button>` : ''}
    </div><div class="th-card-body">${body}</div></section>`
  }
  function mineCard(c, days) {
    const rows = days
      .map((date) => ({ date, meals: M.MEAL_KEYS.filter((k) => M.stateOf(c, date, k, now()) !== 'off' && (M.recordOf(room, members, me.id, date, k) || {}).on) }))
      .filter((r) => r.meals.length)
    const t = M.monthTally(room, M.ymd(now()).slice(0, 7), members, now(), false).rows.find((r) => r.id === me.id) || { lunch: 0, dinner: 0 }
    return `<section class="th-card" id="mineCard"><div class="th-card-header"><h2 class="th-card-title">내 신청</h2><span class="th-xs th-muted">오늘부터 ${c.ahead}일</span></div>
      <div class="th-card-body">${rows.length ? `<ul class="mine-list">${rows.map((r) => `<li><span>${M.dateLabel(r.date, M.ymd(now()))}</span><b>${r.meals.map((k) => M.MEALS[k]).join(' · ')}</b></li>`).join('')}</ul>` : '<p class="th-hint">신청한 식사가 없습니다.</p>'}</div>
      <div class="card-foot th-xs th-muted">이번 달 확정: 점심 <b class="th-nums">${t.lunch}</b>회 · 저녁 <b class="th-nums">${t.dinner}</b>회</div></section>`
  }
  function renderApply() {
    const c = config()
    const today = M.ymd(now())
    const days = M.upcoming(c, now())
    const off = M.skipped(c, now())
    const menus = eff().menus
    const legacy = isOwner() ? eff().config.clerks : []
    const list = [
      ...days.map((date) => ({
        date,
        html: `<section class="th-card day ${date === today ? 'today' : ''}" data-day="${date}"><div class="th-card-header">
          <h2 class="th-card-title">${M.dateLabel(date, today)}</h2>${M.menuOf(menus, date, 'note') ? `<span class="th-xs th-muted day-note">${esc(M.menuOf(menus, date, 'note'))}</span>` : ''}
          ${canManage() ? `<button class="th-btn th-btn-ghost th-btn-sm push" data-menu-day="${date}">${icon('pencil')} 메뉴 등록</button>` : ''}
        </div><div class="rows">${M.MEAL_KEYS.map((k) => mealTile(c, date, k)).join('')}</div></section>`
      })),
      ...off.map((h) => ({
        date: h.date,
        html: `<section class="th-card offday" data-holiday="${h.date}"><div class="th-card-header"><h2 class="th-card-title">${M.dateLabel(h.date, today)}</h2>${badge('muted', '공휴일')}<span class="th-xs th-muted">${esc(h.name)} · 신청을 받지 않습니다</span></div></section>`
      }))
    ].sort((a, b) => (a.date < b.date ? -1 : 1))
    return `<div class="stack">
      ${summaryCard(c, today)}
      ${c.notice ? `<div class="th-notice notice">${esc(c.notice)}</div>` : ''}
      ${legacy.length ? `<div class="th-notice" id="legacyNote">예전에 정한 서무 ${legacy.length}명(${esc(legacy.map(nameOf).join(', '))})은 아직 식수서무가 아닙니다. 대신 신청은 이제 누구나 할 수 있습니다. 설정 변경·메뉴 등록을 함께 맡기려면 [설정]에서 식수서무를 2명까지 정해 저장하세요.</div>` : ''}
      <div class="cols">
        <div class="stack tight">
          ${list.length ? list.map((x) => x.html).join('') : `<section class="th-card">${empty('utensils', '신청을 받는 날이 없습니다', '관리자와 식수서무가 설정에서 받는 식사와 요일을 정합니다.')}</section>`}
          <p class="th-hint">마감 시각 전에는 신청·취소·다시 신청을 마음대로 할 수 있습니다. 마감 뒤에는 바꿀 수 없습니다. 먹지 않을 식사에 [확실히 신청안함]을 눌러 두면 다른 사람이 대신 신청·취소할 수 없고, 본인만 [표시 풀기]로 풉니다.</p>
        </div>
        <aside class="stack tight">${todayMenuCard(c, today)}${mineCard(c, days)}</aside>
      </div>
    </div>`
  }
  /**
   * 확실히 신청안함 asks once more before it is set (지시 120): it takes away a request already made,
   * also one somebody made for me, and from then on nobody else can request or cancel this meal.
   */
  let firmAsk = null
  function askFirm(date, meal, on) {
    firmAsk = { date, meal }
    $('firmTitle').textContent = `${M.dateLabel(date, M.ymd(now()))} ${M.MEALS[meal]}을 확실히 신청안함으로 정할까요?`
    const points = [
      ...(on ? ['지금 신청되어 있는 이 식사는 바로 취소됩니다(다른 사람이 대신 신청해 둔 것도).'] : []),
      '다른 사람은(관리자·식수서무 포함) 이 식사를 대신 신청하거나 취소할 수 없습니다.',
      '본인만 [표시 풀기]로 풀 수 있습니다. 마감 뒤에는 바꿀 수 없습니다.'
    ]
    $('firmBody').innerHTML = points.map((p) => `<li>${esc(p)}</li>`).join('')
    $('firmDlg').showModal()
  }

  /**
   * target = { id, name }: request or cancel for that member (anybody may, except for a meal they
   * marked 확실히 신청안함). firm (my own, with on = false): mark the meal 확실히 신청안함.
   */
  async function change(date, meal, on, target, firm) {
    if (busy) return
    busy = true
    try {
      await syncClock()
      // read the newest state first: the settings may have changed and my entry is replaced as a whole
      room = await call('rooms.get', { roomId: room.id })
      const was = !target && M.isFirm(room, me.id, date, meal)
      const r = !target ? M.apply(mine(), config(), date, meal, on, now(), firm) : canProxy() ? M.applyFor(mine(), config(), target, date, meal, on, now(), room) : { error: '대신 신청할 권한이 없습니다.' }
      if (r.error) toast(r.error)
      else {
        room = await call('rooms.setEntry', { roomId: room.id, value: r.entry })
        const what = `${target ? `${target.name} 님의 ` : ''}${M.dateLabel(date, M.ymd(now()))} ${M.MEALS[meal]}을`
        toast(firm ? `${what} 확실히 신청안함으로 정했습니다. 다른 사람은 대신 신청할 수 없습니다.` : was && !on ? `${what} 확실히 신청안함에서 풀었습니다.` : `${what} ${on ? '신청했습니다' : '취소했습니다'}.`)
      }
    } catch (e) {
      // the server refuses a change after the deadline by its own clock (1.7.0): say why, a bit
      // longer, and show what stands now
      toast(e.message || '저장하지 못했습니다.', 6000)
      try {
        await syncClock()
        room = await call('rooms.get', { roomId: room.id })
      } catch {
        // keep what is shown
      }
    }
    busy = false
    render()
  }

  /**
   * A save by somebody in charge (patch: see Meal.saveAs). The owner writes the shared data,
   * a 식수서무 their own entry; both read the newest room first and stamp with the server's clock.
   */
  async function saveAs(patch, done) {
    if (busy) return false
    busy = true
    let ok = false
    try {
      await syncClock()
      room = await call('rooms.get', { roomId: room.id })
      const r = M.saveAs(room, me.id, now(), patch)
      if (r.error) toast(r.error)
      else {
        room = r.shared ? await call('rooms.setShared', { roomId: room.id, shared: r.shared }) : await call('rooms.setEntry', { roomId: room.id, value: r.entry })
        toast(r.trimmed ? `${done} 저장 공간이 모자라 오래된 메뉴 ${r.trimmed}일치를 지웠습니다.` : done)
        ok = true
      }
    } catch (e) {
      toast(e.message || '저장하지 못했습니다.')
    }
    busy = false
    return ok
  }

  // ---------- 메뉴 ----------
  const weekLabel = (days) => `${M.dateLabel(days[0].date, '')} ~ ${M.dateLabel(days[days.length - 1].date, '')}`
  const slotName = (slot) => (slot === 'note' ? '메모' : M.MEALS[slot])
  /** A cell of a menu form; `snap` remembers what it showed. */
  function menuInput(date, slot, id) {
    const t = M.menuOf(eff().menus, date, slot)
    snap[`${date}|${slot}`] = t
    const label = `${M.dateLabel(date, '')} ${slotName(slot)}`
    return slot === 'note'
      ? `<input class="th-input" ${id ? `id="${id}"` : ''} data-date="${date}" data-slot="note" maxlength="${M.LIMITS.menuNote}" value="${esc(t)}" placeholder="예: 행사로 외식" aria-label="${label}" />`
      : `<textarea class="th-input" ${id ? `id="${id}"` : ''} data-date="${date}" data-slot="${slot}" rows="5" maxlength="${M.LIMITS.menuText}" placeholder="한 줄에 하나씩" aria-label="${label}">${esc(t)}</textarea>`
  }
  /** The cells of a form that differ from what it showed when opened. */
  const menuEdits = (root) => Array.from(root.querySelectorAll('[data-date][data-slot]')).filter((el) => M.cleanMenuText(el.dataset.slot, el.value) !== snap[`${el.dataset.date}|${el.dataset.slot}`]).map((el) => ({ date: el.dataset.date, slot: el.dataset.slot, t: el.value }))
  function renderMenu() {
    const c = config()
    const today = M.ymd(now())
    if (!menuWeek) menuWeek = M.weekStart(today)
    const days = M.weekDays(c, menuWeek)
    const meals = M.menuMeals(c)
    const menus = eff().menus
    const edit = menuEdit && canManage()
    if (edit) snap = {}
    const rows = days
      .map((d) => {
        const date = `<td class="date"><b>${M.dateLabel(d.date, '')}</b>${d.date === today ? ` ${badge('', '오늘')}` : ''}</td>`
        if (!d.served) return `<tr class="off" data-menu-row="${d.date}">${date}<td colspan="${meals.length + 1}">${badge('muted', d.why ? '공휴일' : '쉬는 날')} ${d.why ? `${esc(d.why)} · ` : ''}신청을 받지 않습니다</td></tr>`
        const cell = (slot) => (edit ? menuInput(d.date, slot) : M.menuOf(menus, d.date, slot) ? menuLines(M.menuOf(menus, d.date, slot)) : slot === 'note' ? '' : noMenu())
        return `<tr class="${d.date === today ? 'today' : ''}" data-menu-row="${d.date}">${date}${meals.map((k) => `<td data-menu-cell="${k}">${cell(k)}</td>`).join('')}<td class="note" data-menu-cell="note">${cell('note')}</td></tr>`
      })
      .join('')
    const last = M.menuStamp(
      menus,
      days.map((d) => d.date)
    )
    return `<div class="stack">
      <div id="printHead" class="th-print-only"><h1>주간 메뉴 ${weekLabel(days)}</h1><p>${esc(chargeText())}</p></div>
      <${edit ? 'form id="menuForm"' : 'section'} class="th-card" data-week="${menuWeek}">
        <div class="th-card-header"><h2 class="th-card-title">${edit ? '메뉴 등록' : '주간 메뉴'}</h2><span>${weekLabel(days)}</span><span class="push th-xs th-muted" data-charge>${esc(chargeText())}</span></div>
        <div class="th-table-wrap"><table class="th-table week ${edit ? 'edit' : ''}"><thead><tr><th>날짜</th>${meals.map((k) => `<th>${M.MEALS[k]}</th>`).join('')}<th>메모</th></tr></thead><tbody>${rows}</tbody></table></div>
        <div class="card-foot th-xs th-muted" id="menuStamp">${
          edit
            ? `한 칸에 ${M.LIMITS.menuLines}줄, ${M.LIMITS.menuText}자까지 씁니다. 엑셀에서 복사한 표를 칸에 붙여넣으면 그 칸부터 채워집니다. [저장]을 눌러야 반영됩니다.`
            : last
              ? `마지막으로 고친 사람: ${esc(nameOf(last.by))} · ${stamp(last.at)}`
              : '이 주에는 등록된 메뉴가 없습니다.'
        }</div>
      </${edit ? 'form' : 'section'}>
    </div>`
  }
  async function saveWeek() {
    const form = $('menuForm')
    if (!form) return
    const edits = menuEdits(form)
    if (edits.length && !(await saveAs({ menus: edits }, '메뉴를 저장했습니다.'))) return render.bars()
    if (!edits.length) toast('바뀐 내용이 없습니다.')
    menuEdit = false
    render()
  }
  /** Fill the form (not saved yet): the week before, or nothing. */
  function fillWeek(from) {
    const form = $('menuForm')
    if (!form) return
    for (const el of form.querySelectorAll('[data-date][data-slot]')) el.value = from ? M.menuOf(eff().menus, M.addDays(el.dataset.date, -7), el.dataset.slot) : ''
    toast(from ? '앞 주의 메뉴를 가져왔습니다. [저장]을 눌러야 반영됩니다.' : '칸을 모두 비웠습니다. [저장]을 눌러야 반영됩니다.')
  }
  /** A table copied from a spreadsheet, pasted into a cell: fills the grid from that cell on. */
  function pasteBlock(e) {
    const el = e.target
    const form = $('menuForm')
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : ''
    if (!form || !el.dataset || !el.dataset.slot || !form.contains(el) || !text.includes('\t')) return
    e.preventDefault()
    const dates = Array.from(form.querySelectorAll('[data-menu-row]')).map((tr) => tr.dataset.menuRow)
    const slots = [...M.menuMeals(config()), 'note']
    let n = 0
    for (const cell of M.placeBlock(M.parseBlock(text), dates.length, slots.length, dates.indexOf(el.dataset.date), slots.indexOf(el.dataset.slot))) {
      const target = form.querySelector(`[data-date="${dates[cell.r]}"][data-slot="${slots[cell.c]}"]`)
      if (!target) continue // a day that is not served
      target.value = M.cleanMenuText(slots[cell.c], cell.t)
      n++
    }
    toast(`붙여넣은 표로 ${n}칸을 채웠습니다. [저장]을 눌러야 반영됩니다.`)
  }
  function openDay(date) {
    if (!canManage()) return
    const c = config()
    const meals = M.isServed(c, date) ? M.menuMeals(c) : []
    snap = {}
    $('dayTitle').textContent = `${M.dateLabel(date, M.ymd(now()))} 메뉴`
    $('dayBody').innerHTML = [...meals, 'note'].map((slot) => `<div class="th-field"><label class="th-label" for="day-${slot}">${slotName(slot)}</label>${menuInput(date, slot, `day-${slot}`)}${slot === 'note' ? '<p class="th-hint">그날 모두에게 알릴 말(선택). 날짜 옆에 보입니다.</p>' : ''}</div>`).join('')
    const last = M.menuStamp(eff().menus, [date])
    $('dayStamp').textContent = last ? `마지막으로 고친 사람: ${nameOf(last.by)} · ${stamp(last.at)}` : ''
    $('dayError').textContent = ''
    $('dayDlg').showModal()
  }
  async function saveDay() {
    const edits = menuEdits($('dayBody'))
    if (edits.length && !(await saveAs({ menus: edits }, '메뉴를 저장했습니다.'))) return
    $('dayDlg').close()
    render()
  }

  // ---------- 현황 ----------
  function renderStatus() {
    const c = config()
    const today = M.ymd(now())
    if (!statusDate) statusDate = today
    const meals = M.menuMeals(c)
    const lists = Object.fromEntries(meals.map((k) => [k, M.dayList(room, statusDate, k, members)]))
    const declined = Object.fromEntries(meals.map((k) => [k, M.declinedList(room, statusDate, k, members)]))
    const blocks = meals
      .map((k) => {
        const list = lists[k]
        const st = M.stateOf(c, statusDate, k, now())
        const proxy = canProxy() && st === 'open'
        const rest = proxy
          ? everyone()
              .filter((m) => m.id !== me.id && !list.some((p) => p.id === m.id))
              .sort(byDept)
          : []
        const state = st === 'open' ? badge('important', `신청 받는 중 · ${c.meals[k].cutoff} 마감`) : st === 'closed' ? badge('success', '마감 · 확정') : badge('muted', M.holidayName(c, statusDate) ? `공휴일(${esc(M.holidayName(c, statusDate))})` : '받지 않는 날')
        const text = M.menuOf(eff().menus, statusDate, k)
        const no = declined[k]
        const firmIds = new Set(no.map((p) => p.id))
        const depts = new Map()
        for (const p of list) depts.set(p.deptName || '부서 미지정', [...(depts.get(p.deptName || '부서 미지정') || []), p])
        return `<section class="th-card" data-status="${k}"><div class="th-card-header" style="align-items:center"><h2 class="th-card-title">${M.MEALS[k]}</h2><span><b class="big primary total">${list.length}</b>명${manualNote(list)}</span>${state}${text ? `<span class="th-xs th-muted">${esc(text.split('\n').join(', '))}</span>` : ''}</div>
          <div class="rows">
          ${list.length ? [...depts].map(([d, ps]) => `<div class="dept"><span class="dept-name th-xs th-muted">${esc(d)} <b class="th-nums">${ps.length}</b></span><div class="who">${ps.map((p) => `<span data-who="${esc(p.id)}" title="${hm(p.at)} ${p.by ? `${esc(p.byName)} 님이 대신 신청` : '신청'}">${esc(p.name)}${manualMark(p)}${p.by ? ' <small>대신</small>' : ''}${proxy && p.id !== me.id ? `<button class="x" data-unproxy="${esc(p.id)}" data-meal="${k}" aria-label="${esc(p.name)} 신청 대신 취소" title="대신 취소" ${busy ? 'disabled' : ''}>${icon('x') || '취소'}</button>` : ''}</span>`).join('')}</div></div>`).join('') : '<p class="line th-xs th-muted">신청한 사람이 없습니다.</p>'}
          ${no.length ? `<div class="dept declined" data-declined="${k}"><span class="dept-name th-xs th-muted">확실히 신청안함 <b class="th-nums">${no.length}</b></span><div class="who">${no.map((p) => `<span data-firm="${esc(p.id)}" title="${hm(p.at)} 본인이 확실히 신청안함으로 정함 · 다른 사람은 대신 신청·취소할 수 없음">${icon('lock')}${esc(p.name)}</span>`).join('')}</div></div>` : ''}
          ${proxy ? `<div class="proxy"><label for="proxy-${k}" class="th-xs th-muted">대신 신청</label><select class="th-input" id="proxy-${k}" data-proxy-sel="${k}"><option value="">사람 고르기</option>${rest.map((m) => (firmIds.has(m.id) ? `<option value="${esc(m.id)}" disabled>${esc(`${m.deptName ? `${m.deptName} · ` : ''}${m.name} (본인이 확실히 신청안함 · 대신 신청 불가)`)}</option>` : `<option value="${esc(m.id)}" ${proxySel[k] === m.id ? 'selected' : ''}>${esc(`${m.deptName ? `${m.deptName} · ` : ''}${m.name}${m.manual ? ' (미등록)' : ''}`)}</option>`)).join('')}</select><button class="th-btn th-btn-outline th-btn-sm" data-proxy="${k}" ${busy ? 'disabled' : ''}>대신 신청</button></div>` : ''}
          </div>
        </section>`
      })
      .join('')
    const note = M.menuOf(eff().menus, statusDate, 'note')
    return `<div class="stack">
      <section class="th-card" data-summary><div class="th-card-header"><h2 class="th-card-title">신청 인원</h2>${meals.map((k) => `<span>${M.MEALS[k]} <b class="big">${lists[k].length}</b>명${manualNote(lists[k])}</span>`).join('')}${note ? `<span class="th-xs th-muted">${esc(note)}</span>` : ''}<span class="push th-xs th-muted">${M.dateLabel(statusDate, today)} 기준</span></div></section>
      ${blocks}
    </div>`
  }

  // ---------- 통계 (those in charge and the server PC, 지시 90) ----------
  const pctOf = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-')
  const mealCols = () => M.menuMeals(config())
  /**
   * The numbers of a month: worked out from the requests kept now, or the copy this PC saved
   * when the month was over (requests are kept 100 days, those made for others 62).
   */
  function statsOf(m) {
    const live = M.statsSnapshot(room, m, members, now())
    const best = M.betterOf(live, saved[m])
    // a finished month is saved on this PC so it can still be counted later
    if (m < M.ymd(now()).slice(0, 7) && live.summary.total > 0 && (!saved[m] || live.summary.total >= saved[m].summary.total) && live !== saved[m]) {
      saved[m] = live
      void call('storage.set', { key: `stats:${m}`, value: live }).catch(() => undefined)
    }
    return { snap: best, fromSaved: best !== live }
  }
  /** Reads the copy saved on this PC once per month, then draws again. */
  function loadSaved(m) {
    if (m in saved) return
    saved[m] = null
    void call('storage.get', { key: `stats:${m}` })
      .then((v) => {
        if (v && v.v === 1) {
          saved[m] = v
          if (tab === 'month' && month === m) render()
        }
      })
      .catch(() => undefined)
  }
  const kpi = (label, value, sub) => `<div class="kpi"><span class="th-xs th-muted">${label}</span><b class="big th-nums">${value}</b>${sub ? `<span class="th-xs th-muted">${sub}</span>` : ''}</div>`
  function renderMonth() {
    if (!month) month = M.ymd(now()).slice(0, 7)
    loadSaved(month)
    const { snap, fromSaved } = statsOf(month)
    const sm = snap.summary
    const [y, mo] = month.split('-').map(Number)
    const meals = mealCols()
    const note = `<p class="th-hint">마감이 지난 신청만 셉니다(확정). ${fromSaved ? `<b>이 PC에 보관한 집계</b>(${stamp(snap.savedAt)} 기준)를 보여 줍니다 — 신청 기록은 ${M.LIMITS.keepDays}일(대신 신청은 ${M.LIMITS.proxyKeepDays}일)만 남기 때문에, 지난달 집계는 담당자 PC에 자동으로 보관됩니다.` : `신청 기록은 ${M.LIMITS.keepDays}일(대신 신청은 ${M.LIMITS.proxyKeepDays}일) 남고, 지난달 집계는 이 화면을 연 담당자 PC에 자동으로 보관됩니다.`}</p>`
    if (!sm.total && !sm.pending.lunch && !sm.pending.dinner)
      return `<div class="stack"><section class="th-card">${empty('chart-column', `${y}년 ${mo}월에는 신청이 없습니다`, '마감이 지난 신청이 여기에 모입니다.')}</section>${note}</div>`
    let body
    if (statsView === 'summary') {
      const peak = sm.peak ? `${M.dateLabel(sm.peak.date, '')} ${M.MEALS[sm.peak.meal]} ${sm.peak.count}명` : '-'
      body = `<section class="th-card" data-stats="summary"><div class="th-card-header"><h2 class="th-card-title">${y}년 ${mo}월 통합</h2></div>
        <div class="th-card-body"><div class="kpis">
          ${meals.includes('lunch') ? kpi('점심', `${sm.lunch}회`, `하루 평균 ${sm.avgLunch}명`) : ''}
          ${meals.includes('dinner') ? kpi('저녁', `${sm.dinner}회`, `하루 평균 ${sm.avgDinner}명`) : ''}
          ${kpi('합계', `${sm.total}회`, `받은 날 ${sm.days}일`)}
          ${kpi('먹은 사람', `${sm.people}명`, sm.manualPeople ? `미등록 ${sm.manualPeople}명 포함` : '')}
          ${kpi('대신 신청', pctOf(sm.proxied, sm.total), `${sm.proxied}회`)}
          ${kpi('가장 많은 때', peak, '')}
          ${sm.declined && sm.declined.lunch + sm.declined.dinner ? kpi('확실히 신청안함', `${sm.declined.lunch + sm.declined.dinner}회`, '본인이 먹지 않는다고 정한 식사(미신청과 따로 셈)') : ''}
          ${sm.pending.lunch + sm.pending.dinner ? kpi('신청 받는 중', `${sm.pending.lunch + sm.pending.dinner}회`, '아직 마감 전(확정에 들어가지 않음)') : ''}
        </div></div></section>
        <section class="th-card"><div class="th-card-header"><h2 class="th-card-title">부서별</h2></div>${deptTable(snap)}</section>`
    } else if (statsView === 'daily') {
      const rows = snap.daily.filter((d) => d.served || d.why)
      body = `<section class="th-card" data-stats="daily"><div class="th-card-header"><h2 class="th-card-title">${y}년 ${mo}월 일별</h2></div>
        <div class="th-table-wrap"><table class="th-table"><thead><tr><th>날짜</th>${meals.map((k) => `<th class="th-num">${M.MEALS[k]}</th>`).join('')}<th class="th-num">합계</th><th>비고</th></tr></thead><tbody>
        ${rows
          .map((d) => {
            const today = M.ymd(now())
            const open = !fromSaved && d.served && meals.some((k) => M.stateOf(config(), d.date, k, now()) === 'open')
            return `<tr data-day-row="${d.date}" class="${d.date === today ? 'today' : ''}"><td class="th-nums">${M.dateLabel(d.date, today)}</td>${meals.map((k) => `<td class="th-num">${d.served ? d[k] || 0 : ''}</td>`).join('')}<td class="th-num"><b>${d.served ? meals.reduce((s, k) => s + (d[k] || 0), 0) : ''}</b></td><td class="th-xs th-muted">${d.served ? (open ? badge('important', '신청 받는 중') : '') : d.why ? `공휴일(${esc(d.why)})` : ''}</td></tr>`
          })
          .join('')}
        </tbody><tfoot><tr><td>합계(확정)</td>${meals.map((k) => `<td class="th-num">${sm[k]}</td>`).join('')}<td class="th-num">${sm.total}</td><td></td></tr></tfoot></table></div></section>`
    } else if (statsView === 'settle') {
      body = renderSettle(snap, fromSaved)
    } else if (statsView === 'dept') {
      body = `<section class="th-card" data-stats="dept"><div class="th-card-header"><h2 class="th-card-title">${y}년 ${mo}월 부서별</h2></div>${deptTable(snap)}</section>`
    } else {
      body = `<section class="th-card" data-stats="person"><div class="th-card-header"><h2 class="th-card-title">${y}년 ${mo}월 개인별</h2><span class="th-xs th-muted">${sm.people}명</span></div>
        ${
          snap.rows.length
            ? `<div class="th-table-wrap"><table class="th-table tally"><thead><tr><th>부서</th><th>이름</th><th class="th-num">점심</th><th class="th-num">저녁</th><th class="th-num">합계</th></tr></thead><tbody>
            ${snap.rows.map((r) => `<tr><td class="th-muted">${esc(r.deptName)}</td><td data-tally="${esc(r.id)}">${esc(r.name)}${manualMark(r)}</td><td class="th-num">${r.lunch}</td><td class="th-num">${r.dinner}</td><td class="th-num"><b>${r.lunch + r.dinner}</b></td></tr>`).join('')}
            </tbody><tfoot><tr><td></td><td>합계</td><td class="th-num">${sm.lunch}</td><td class="th-num">${sm.dinner}</td><td class="th-num">${sm.total}</td></tr></tfoot></table></div>`
            : empty('receipt', '이 달에 확정된 신청이 없습니다', '마감이 지난 신청이 여기에 사람별로 모입니다.')
        }</section>`
    }
    return `<div class="stack">${body}${note}</div>`
  }
  /** 식대 정산 of a month: a saved month is priced again with the prices of each date (1.7.0). */
  const settleOf = (snap) => M.snapSettlement(snap, prices()) || M.settlement(room, snap.month, members, now(), prices())
  const fromText = (d) => d.split('-').map(Number).join('.')
  const priceText = (m) => {
    const meals = mealCols()
    const list = M.monthPrices(prices(), m)
    return list.length ? list.map((p) => `${fromText(p.from)}부터 ${meals.map((k) => `${M.MEALS[k]} ${M.wonText(p[k])}원`).join(' · ')}`).join(' / ') : '정한 단가 없음'
  }
  function renderSettle(snap) {
    const s = settleOf(snap)
    const meals = mealCols()
    const [y, mo] = snap.month.split('-').map(Number)
    const amt = (n) => `${M.wonText(n)}`
    const cells = (r) => `${meals.map((k) => `<td class="th-num">${r[k]}</td>`).join('')}${meals.map((k) => `<td class="th-num">${amt(r[`${k}Amt`])}</td>`).join('')}<td class="th-num"><b>${amt(r.amount)}</b></td>`
    const head = `<tr><th>부서</th><th>이름</th>${meals.map((k) => `<th class="th-num">${M.MEALS[k]}(회)</th>`).join('')}${meals.map((k) => `<th class="th-num">${M.MEALS[k]} 금액</th>`).join('')}<th class="th-num">합계(원)</th></tr>`
    const body = s.depts
      .map((d) => {
        const people = s.rows.filter((r) => (r.deptName || '부서 미지정') === d.dept)
        return `${people.map((r) => `<tr data-settle="${esc(r.id)}"><td class="th-muted">${esc(r.deptName)}</td><td>${esc(r.name)}${manualMark(r)}</td>${cells(r)}</tr>`).join('')}<tr class="sub" data-settle-dept="${esc(d.dept)}"><td>${esc(d.dept)}</td><td class="th-muted">소계 ${d.people}명</td>${cells(d)}</tr>`
      })
      .join('')
    const warn = !prices().length
      ? `<div class="th-notice th-no-print" data-settle-warn>식대 단가가 없어 금액을 셀 수 없습니다. [설정 → 식대 단가]에서 정하세요.</div>`
      : s.unpriced
        ? `<div class="th-notice th-no-print" data-settle-warn>단가를 정하기 전 날짜의 식사 ${s.unpriced}회는 금액에 넣지 않았습니다. [설정 → 식대 단가]에서 그날부터의 단가를 더하세요.</div>`
        : ''
    return `<section class="th-card" data-stats="settle">
      <div id="printHead" class="th-print-only"><h1>${y}년 ${mo}월 식대 정산</h1><p>적용 단가 ${esc(priceText(snap.month))} · ${esc(chargeText())}</p></div>
      <div class="th-card-header th-no-print"><h2 class="th-card-title">${y}년 ${mo}월 식대 정산</h2><span class="th-xs th-muted">${esc(priceText(snap.month))}</span></div>
      ${warn ? `<div class="th-card-body th-no-print">${warn}</div>` : ''}
      ${
        s.rows.length
          ? `<div class="th-table-wrap"><table class="th-table tally settle"><thead>${head}</thead><tbody>${body}</tbody>
            <tfoot><tr data-settle-total><td>합계</td><td>${s.total.people}명${s.total.manual ? ` <span class="th-xs th-muted">(미등록 ${s.total.manual}명 포함)</span>` : ''}</td>${cells(s.total)}</tr></tfoot></table></div>`
          : empty('receipt', '이 달에 정산할 식사가 없습니다', '마감이 지난 신청이 여기에 금액과 함께 모입니다.')
      }</section>`
  }
  function deptTable(snap) {
    if (!snap.depts.length) return `<div class="th-card-body"><p class="th-hint">확정된 신청이 없습니다.</p></div>`
    return `<div class="th-table-wrap"><table class="th-table"><thead><tr><th>부서</th><th class="th-num">인원</th><th class="th-num">점심</th><th class="th-num">저녁</th><th class="th-num">합계</th><th class="th-num">비율</th></tr></thead><tbody>
      ${snap.depts.map((d) => `<tr data-dept-row="${esc(d.dept)}"><td>${esc(d.dept)}</td><td class="th-num">${d.people}</td><td class="th-num">${d.lunch}</td><td class="th-num">${d.dinner}</td><td class="th-num"><b>${d.lunch + d.dinner}</b></td><td class="th-num th-muted">${pctOf(d.lunch + d.dinner, snap.summary.total)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td>합계</td><td class="th-num">${snap.summary.people}</td><td class="th-num">${snap.summary.lunch}</td><td class="th-num">${snap.summary.dinner}</td><td class="th-num">${snap.summary.total}</td><td></td></tr></tfoot></table></div>`
  }

  // ---------- 내 기록 (everybody, 지시 91) ----------
  function renderMine() {
    if (!mineMonth) mineMonth = M.ymd(now()).slice(0, 7)
    const today = M.ymd(now())
    const meals = mealCols()
    const pm = M.personMonth(room, members, me.id, mineMonth, now())
    const [y, mo] = mineMonth.split('-').map(Number)
    const cell = (r, closed) => {
      if (!r) return `<span class="th-xs th-muted">${closed ? '-' : ''}</span>`
      const who = r.by ? `${esc(r.byName)} 대신` : '본인'
      if (r.firm) return `<span class="th-badge th-badge-urgent" data-firm title="${hm(r.at)} 본인이 확실히 신청안함으로 정함">${icon('lock')} 신청안함</span> <span class="th-xs th-muted">본인 확정</span>`
      if (r.on) return `<span class="th-badge th-badge-success" title="${hm(r.at)} ${who} 신청">${r.closed ? '먹음' : '신청함'}</span> <span class="th-xs th-muted">${who}</span>`
      return `<span class="th-badge th-badge-muted" title="${hm(r.at)} ${who} 취소">취소</span> <span class="th-xs th-muted">${who}</span>`
    }
    const history = M.personMonths(room, members, me.id, now(), 4)
    return `<div class="stack">
      <section class="th-card" data-mine="summary"><div class="th-card-header"><h2 class="th-card-title">${y}년 ${mo}월 내 식사</h2></div>
        <div class="th-card-body"><div class="kpis">
          ${meals.includes('lunch') ? kpi('점심(확정)', `${pm.done.lunch}회`, pm.open.lunch ? `신청 중 ${pm.open.lunch}회` : '') : ''}
          ${meals.includes('dinner') ? kpi('저녁(확정)', `${pm.done.dinner}회`, pm.open.dinner ? `신청 중 ${pm.open.dinner}회` : '') : ''}
          ${kpi('합계(확정)', `${pm.done.lunch + pm.done.dinner}회`, '')}
          ${pm.declined.lunch + pm.declined.dinner ? kpi('확실히 신청안함', `${pm.declined.lunch + pm.declined.dinner}회`, '본인이 먹지 않는다고 정한 식사') : ''}
        </div></div></section>
      <section class="th-card"><div class="th-card-header"><h2 class="th-card-title">날짜별 기록</h2><span class="th-xs th-muted">본인 신청·대신 신청·취소·확실히 신청안함이 모두 보입니다</span></div>
        ${
          pm.days.some((d) => d.any)
            ? `<div class="th-table-wrap"><table class="th-table" data-mine="days"><thead><tr><th>날짜</th>${meals.map((k) => `<th>${M.MEALS[k]}</th>`).join('')}</tr></thead><tbody>
              ${pm.days
                .filter((d) => d.any || d.date === today)
                .map((d) => `<tr class="${d.date === today ? 'today' : ''}"><td class="th-nums">${M.dateLabel(d.date, today)}</td>${meals.map((k) => `<td>${cell(d.meals[k], d.meals[k] ? d.meals[k].closed : M.stateOf(config(), d.date, k, now()) !== 'open')}</td>`).join('')}</tr>`)
                .join('')}
              </tbody></table></div>`
            : `<div class="th-card-body">${empty('receipt', '이 달에는 신청한 기록이 없습니다', '')}</div>`
        }</section>
      <section class="th-card"><div class="th-card-header"><h2 class="th-card-title">최근 달</h2><span class="th-xs th-muted">확정된 횟수 · 기록은 ${M.LIMITS.keepDays}일 동안 남습니다</span></div>
        <div class="th-table-wrap"><table class="th-table" data-mine="months"><thead><tr><th>달</th>${meals.map((k) => `<th class="th-num">${M.MEALS[k]}</th>`).join('')}<th class="th-num">합계</th></tr></thead><tbody>
        ${history.map((h) => `<tr><td>${Number(h.month.slice(0, 4))}년 ${Number(h.month.slice(5))}월</td>${meals.map((k) => `<td class="th-num">${h[k]}</td>`).join('')}<td class="th-num"><b>${meals.reduce((s, k) => s + h[k], 0)}</b></td></tr>`).join('')}
        </tbody></table></div></section>
    </div>`
  }

  // ---------- 설정 (the owner and the 식수서무) ----------
  function renderSettings() {
    const e = eff()
    const c = e.config
    const owner = !room || isOwner()
    const may = !room || canManage()
    const off = may ? '' : 'disabled'
    const ownerId = room ? room.createdBy : me.id
    // the clerks of before 1.2.0 are offered as 식수서무 (the first two) until the owner saves
    const picked = c.stewards.length ? c.stewards : c.clerks.slice(0, M.LIMITS.stewardsMax)
    const legacy = owner && room ? c.clerks : []
    const row = (k) => `<div class="set-row"><label class="th-check"><input type="checkbox" id="on-${k}" ${c.meals[k].on ? 'checked' : ''} ${off} /> ${M.MEALS[k]} 받기</label><div class="th-field"><label class="th-label" for="cut-${k}">${M.MEALS[k]} 신청 마감 시각</label><input class="th-input th-nums" type="time" id="cut-${k}" value="${c.meals[k].cutoff}" ${off} /></div></div>`
    return `<form id="settings" class="stack narrow">
      ${may ? '' : `<p class="th-error" id="setDenied">설정은 처음 만든 관리자(${esc(room.createdByName)})와 식수서무만 바꿀 수 있습니다.</p>`}
      <section class="th-card"><div class="th-card-header"><h2 class="th-card-title">받는 식사와 마감 시각</h2></div><div class="th-card-body stack tight">
        ${row('lunch')}${row('dinner')}
        <p class="th-hint">마감 시각이 지나면 그날 그 식사는 누구도 신청·취소할 수 없습니다. 시각은 서버 PC의 시계를 따릅니다.</p>
      </div></section>
      <section class="th-card"><div class="th-card-header"><h2 class="th-card-title">신청을 받는 날</h2></div><div class="th-card-body stack tight">
        <div class="set-row"><div class="th-field"><label class="th-label" for="ahead">며칠 앞까지 신청</label><input class="th-input th-nums" type="number" id="ahead" min="1" max="${M.LIMITS.aheadMax}" value="${c.ahead}" ${off} /><p class="th-hint">1 = 오늘만, ${M.LIMITS.aheadMax}일까지</p></div></div>
        <label class="th-check"><input type="checkbox" id="weekend" ${c.weekend ? 'checked' : ''} ${off} /> 토·일요일에도 받기</label>
        <div><label class="th-check"><input type="checkbox" id="holidays" ${c.holidays ? 'checked' : ''} ${off} /> 공휴일에는 받지 않기</label><p class="th-hint">공휴일 목록은 관리 → 공휴일에서 정합니다.</p></div>
      </div></section>
      <section class="th-card"><div class="th-card-header"><h2 class="th-card-title">식수서무</h2><span class="th-xs th-muted">2명까지</span></div><div class="th-card-body stack tight">
        <p class="th-hint">식사 신청을 맡는 사람입니다. 이 설정을 바꾸고, 메뉴를 등록하고, 직접 등록한 사람을 관리합니다. 식수서무는 설정을 만든 관리자(${esc(room ? room.createdByName : me.name)})만 정합니다. 다른 사람의 식사를 대신 신청·취소하는 일은 모든 구성원이 할 수 있습니다.</p>
        ${legacy.length ? `<div class="th-notice" id="legacySet">예전에 정한 서무 ${legacy.length}명(${esc(legacy.map(nameOf).join(', '))}) 가운데 앞의 ${Math.min(legacy.length, M.LIMITS.stewardsMax)}명을 식수서무로 골라 두었습니다. 바꿀 수 있습니다. 저장하면 고른 사람이 식수서무가 됩니다(대신 신청은 누구나 계속 할 수 있습니다).</div>` : ''}
        <div class="members" id="stewards">${
          members
            .filter((m) => m.id !== ownerId)
            .sort(byDept)
            .map((m) => `<label class="th-check"><input type="checkbox" value="${esc(m.id)}" ${picked.includes(m.id) ? 'checked' : ''} ${owner ? '' : 'disabled'} /> ${esc(m.name)} <span class="th-xs th-muted">${esc(m.deptName || '')}</span></label>`)
            .join('') || '<p class="th-hint">팀원이 없습니다.</p>'
        }</div>
      </div></section>
      ${priceCard(off)}
      <section class="th-card"><div class="th-card-header"><h2 class="th-card-title">안내 글</h2><span class="th-xs th-muted">선택</span></div><div class="th-card-body"><div class="th-field">
        <textarea class="th-input" id="notice" rows="2" maxlength="${M.LIMITS.notice}" placeholder="예: 구내식당 4,000원, 식권은 식수서무에게" aria-label="안내 글" ${off}>${esc(c.notice)}</textarea>
        <p class="th-hint">신청 화면 맨 위에 보입니다.</p>
      </div></div></section>
      <div class="form-foot">
        <span class="th-xs th-muted" id="setStamp">${room && e.settingsAt ? `마지막 저장: ${esc(nameOf(e.settingsBy))} · ${stamp(e.settingsAt)}` : ''}</span>
        <span class="th-grow"></span>
        <p id="setError" class="th-error" role="alert"></p>
        ${may ? `<button type="submit" class="th-btn">${room ? '저장' : '식사 신청 시작'}</button>` : ''}
      </div>
    </form>`
  }
  /** 식대 단가 (1.7.0): one row per price change; a past row keeps the price of its days. */
  const priceRow = (p, off) => `<tr data-price-row>
      <td><input class="th-input th-nums" type="date" data-price="from" value="${esc(p.from || '')}" aria-label="적용 시작일" ${off} /></td>
      <td class="th-num"><input class="th-input th-nums" type="number" min="0" max="${M.LIMITS.priceMax}" step="10" data-price="lunch" value="${p.lunch || ''}" placeholder="0" aria-label="점심 단가(원)" ${off} /> 원</td>
      <td class="th-num"><input class="th-input th-nums" type="number" min="0" max="${M.LIMITS.priceMax}" step="10" data-price="dinner" value="${p.dinner || ''}" placeholder="0" aria-label="저녁 단가(원)" ${off} /> 원</td>
      <td class="acts">${off ? '' : `<button type="button" class="th-btn th-btn-ghost th-btn-sm" data-price-del aria-label="이 줄 지우기">${icon('trash-2')} 지우기</button>`}</td></tr>`
  function priceCard(off) {
    const ep = M.effectivePrices(room, priceRoom)
    const list = ep.prices.slice().reverse()
    return `<section class="th-card" id="priceCard"><div class="th-card-header"><h2 class="th-card-title">식대 단가</h2><span class="th-xs th-muted">한 끼 · 원</span></div><div class="th-card-body stack tight">
        <p class="th-hint">통계의 [식대 정산]에서 사람별 금액을 셉니다. 단가가 바뀌면 줄을 더해 적용 시작일과 새 단가를 적으세요. 그 전 날짜의 식사는 그때의 단가로 셈하므로 지난 줄은 남겨 둡니다.</p>
        <div class="th-table-wrap"><table class="th-table prices"><thead><tr><th>적용 시작일</th><th class="th-num">점심</th><th class="th-num">저녁</th><th></th></tr></thead>
        <tbody id="priceRows">${list.map((p) => priceRow(p, off)).join('')}</tbody></table></div>
        <p class="th-hint" id="priceEmpty" ${list.length ? 'hidden' : ''}>아직 정한 단가가 없습니다.</p>
        <div class="price-foot">${off ? '' : `<button type="button" class="th-btn th-btn-outline th-btn-sm" id="priceAdd">${icon('plus')} 단가 추가</button>`}<span class="th-xs th-muted push" id="priceStamp">${ep.at ? `마지막 저장: ${esc(nameOf(ep.by))} · ${stamp(ep.at)}` : ''}</span></div>
      </div></section>`
  }
  /** The rows of the price form (a row left blank is skipped). */
  const priceForm = () =>
    Array.from(document.querySelectorAll('#priceRows tr'))
      .map((tr) => ({ from: tr.querySelector('[data-price="from"]').value, lunch: tr.querySelector('[data-price="lunch"]').value, dinner: tr.querySelector('[data-price="dinner"]').value }))
      .filter((p) => p.from || p.lunch || p.dinner)
  function addPriceRow() {
    const rows = priceForm()
    const last = rows.slice().sort((a, b) => (a.from < b.from ? -1 : 1)).pop()
    // the first day of next month, with the prices of the newest row to change from
    const d = new Date(now())
    const from = M.ymd(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime())
    $('priceRows').insertAdjacentHTML('afterbegin', priceRow({ from: last && last.from >= from ? '' : from, lunch: last ? last.lunch : '', dinner: last ? last.dinner : '' }, ''))
    $('priceEmpty').hidden = true
    $('priceRows').querySelector('input').focus()
  }
  /** Saves the price list into its room (made by the first save); false = nothing changed. */
  async function savePriceList(list) {
    const all = await call('rooms.list')
    room = M.pickRoom(all)
    priceRoom = M.pickPriceRoom(all)
    await syncClock()
    const r = M.savePrices(room, priceRoom, me.id, now(), list)
    if (r.error) throw new Error(r.error)
    if (r.same) return false
    if (r.create) priceRoom = await call('rooms.create', { title: '식대 단가', scope: { type: 'team', groupIds: [], memberIds: [] }, shared: r.create })
    else if (r.shared) priceRoom = await call('rooms.setShared', { roomId: priceRoom.id, shared: r.shared })
    else priceRoom = await call('rooms.setEntry', { roomId: priceRoom.id, value: r.entry })
    return true
  }
  async function saveSettings() {
    const settings = {
      meals: { lunch: { on: $('on-lunch').checked, cutoff: $('cut-lunch').value }, dinner: { on: $('on-dinner').checked, cutoff: $('cut-dinner').value } },
      ahead: $('ahead').value,
      weekend: $('weekend').checked,
      holidays: $('holidays').checked,
      notice: $('notice').value
    }
    const stewards = Array.from(document.querySelectorAll('#stewards input:checked')).map((x) => x.value)
    if (!settings.meals.lunch.on && !settings.meals.dinner.on) return ($('setError').textContent = '점심과 저녁 가운데 하나는 받아야 합니다.')
    if (stewards.length > M.LIMITS.stewardsMax) return ($('setError').textContent = `식수서무는 ${M.LIMITS.stewardsMax}명까지 정할 수 있습니다.`)
    // the price list is checked before anything is saved
    const priceList = $('priceRows') ? priceForm() : null
    if (priceList) {
      const check = M.savePrices({ createdBy: me.id, shared: {}, entries: {} }, null, me.id, now(), priceList)
      if (check.error) return ($('setError').textContent = check.error)
    }
    try {
      if (room) {
        // only the owner's list of 식수서무 is taken (Meal.saveAs)
        if (!(await saveAs(isOwner() ? { settings, stewards } : { settings }, '설정을 저장했습니다.'))) return
      } else {
        // somebody may have started it a moment ago
        await load()
        if (!room) {
          await syncClock()
          const first = M.saveAs({ createdBy: me.id, shared: {}, entries: {} }, me.id, now(), { settings, stewards })
          room = await call('rooms.create', { title: '식사 신청', scope: { type: 'team', groupIds: [], memberIds: [] }, shared: first.shared })
        }
        toast('설정을 저장했습니다.')
      }
      if (priceList && (await savePriceList(priceList))) toast('설정과 식대 단가를 저장했습니다.')
      tab = 'apply'
      render()
    } catch (e) {
      $('setError').textContent = e.message || '저장하지 못했습니다.'
    }
  }

  // ---------- 직접 등록한 사람 (staff who do not use TeamHub; those in charge keep the list) ----------
  let delAsk = '' // the id whose 삭제 was pressed once
  let personId = '' // the person being edited in the dialog ('' = a new one)
  function peopleCard() {
    if (!room || !canManage()) return ''
    const people = eff().people
    // 1.8.0: TeamHub keeps the list (관리 → 구성원·PC → 미등록 인원); here it is only shown
    if (M.usesCorePeople()) {
      const listed = M.manualList(people)
      const rows = listed.map((p) => `<tr data-person="${esc(p.id)}"><td>${esc(p.name)}${manualMark(p)}</td><td class="th-muted">${esc(p.deptName)}</td><td class="th-muted">${esc([p.title, p.memo].filter(Boolean).join(' · '))}</td></tr>`).join('')
      return `<section class="th-card people-card" id="peopleCard">
      <div class="th-card-header" style="align-items:center"><h2 class="th-card-title">미등록 인원</h2><span class="th-xs th-muted">${listed.length}명</span></div>
      <div class="th-card-body"><p class="th-hint">TeamHub를 쓰지 않는 직원(미등록 인원)은 TeamHub의 <b>관리 → 구성원·PC → 미등록 인원</b>에서 서버 PC와 서무가 등록·고치기·삭제·구성원과 합치기를 합니다. 긴급구조지휘대와 함께 쓰는 하나의 명단이며, 여기서는 [여러 명 대신 신청]이나 현황의 [대신 신청]으로 식사를 넣습니다. 이름 옆에 "미등록"이 붙습니다.</p></div>
      ${rows ? `<div class="th-table-wrap" style="border-top:1px solid var(--border)"><table class="th-table people"><thead><tr><th>이름</th><th>부서</th><th>직위·메모</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
    </section>`
    }
    const list = M.manualList(people)
    const linked = Object.keys(people).filter((id) => people[id].as && !people[id].gone)
    const act = (attr, text, cls) => `<button type="button" class="th-btn th-btn-ghost th-btn-sm ${cls || ''}" ${attr}>${text}</button>`
    const rows = list
      .map(
        (p) => `<tr data-person="${esc(p.id)}"><td>${esc(p.name)}${manualMark(p)}</td><td class="th-muted">${esc(p.deptName)}</td><td class="th-muted">${esc([p.title, p.memo].filter(Boolean).join(' · '))}</td>
        <td class="th-xs th-muted">${esc(nameOf(people[p.id].by))} · ${stamp(people[p.id].at)}</td>
        <td class="acts">${act(`data-person-edit="${esc(p.id)}"`, '고치기')}${act(`data-person-link="${esc(p.id)}"`, '구성원과 합치기')}${act(`data-person-del="${esc(p.id)}"`, delAsk === p.id ? '정말 삭제' : '삭제', 'cancel')}</td></tr>`
      )
      .join('')
    const merged = linked
      .map((id) => `<tr data-person="${esc(id)}"><td>${esc(people[id].name)}</td><td colspan="3" class="th-muted">구성원 ${esc(nameOf(people[id].as))}의 기록으로 합침</td><td class="acts">${act(`data-person-unlink="${esc(id)}"`, '합치기 취소')}</td></tr>`)
      .join('')
    return `<section class="th-card people-card" id="peopleCard">
      <div class="th-card-header" style="align-items:center"><h2 class="th-card-title">직접 등록한 사람</h2><span class="th-xs th-muted">${list.length}명 / ${M.LIMITS.peopleMax}명까지</span><button type="button" class="th-btn th-btn-outline th-btn-sm push" id="personAdd">${icon('plus')} 사람 추가</button></div>
      <div class="th-card-body"><p class="th-hint">TeamHub를 쓰지 않아 구성원이 아닌 직원을 식사 신청에만 쓰려고 등록합니다. 식사는 [여러 명 대신 신청]이나 현황의 [대신 신청]으로 넣고, 이름 옆에 "미등록"이 붙습니다.</p></div>
      ${rows || merged ? `<div class="th-table-wrap" style="border-top:1px solid var(--border)"><table class="th-table people"><thead><tr><th>이름</th><th>부서</th><th>직위·메모</th><th>등록</th><th></th></tr></thead><tbody>${rows}${merged}</tbody></table></div>` : ''}
    </section>`
  }
  const redrawPeople = () => {
    const el = $('peopleCard')
    if (el) el.outerHTML = peopleCard()
    if ($('bulkDlg').open) renderBulkPeople()
  }
  /** id = '' for a new person; link = open it to pick the member this person turned out to be. */
  function openPerson(id, link) {
    if (!canManage()) return
    personId = id || ''
    const p = id ? eff().people[id] : null
    const depts = Array.from(new Set(everyone().map((m) => m.deptName).filter(Boolean)))
    $('personTitle').textContent = !id ? '사람 추가' : link ? '구성원과 합치기' : '사람 고치기'
    $('personBody').innerHTML = `
      <div class="th-field"><label class="th-label" for="p-name">이름</label><input class="th-input" id="p-name" maxlength="${M.LIMITS.personName}" value="${esc(p ? p.name : '')}" required ${link ? 'disabled' : ''} /><p class="th-hint" id="personWarn"></p></div>
      <div class="th-field"><label class="th-label" for="p-dept">부서</label><input class="th-input" id="p-dept" list="p-depts" maxlength="${M.LIMITS.personDept}" value="${esc(p ? p.dept : '')}" placeholder="고르거나 적기" ${link ? 'disabled' : ''} /><datalist id="p-depts">${depts.map((d) => `<option value="${esc(d)}"></option>`).join('')}</datalist></div>
      ${link ? '' : `<div class="set-row"><div class="th-field"><label class="th-label" for="p-title">직위</label><input class="th-input" id="p-title" maxlength="${M.LIMITS.personTitle}" value="${esc(p ? p.title : '')}" placeholder="선택" /></div><div class="th-field th-grow"><label class="th-label" for="p-memo">메모</label><input class="th-input" id="p-memo" style="width:100%" maxlength="${M.LIMITS.personMemo}" value="${esc(p ? p.memo : '')}" placeholder="선택" /></div></div>`}
      ${
        link
          ? `<div class="th-field"><label class="th-label" for="p-as">합칠 구성원</label><select class="th-input" id="p-as"><option value="">구성원 고르기</option>${[...members]
              .sort(byDept)
              .map((m) => `<option value="${esc(m.id)}" ${m.name === p.name ? 'selected' : ''}>${esc(m.deptName ? `${m.deptName} · ${m.name}` : m.name)}</option>`)
              .join('')}</select><p class="th-hint">이 사람이 TeamHub에 가입했을 때 씁니다. 지금까지 대신 신청한 기록과 앞으로의 기록이 그 구성원의 것으로 보이고 "미등록" 표시가 없어집니다. 같은 날 양쪽에 신청이 있어도 한 번만 셉니다.</p></div>`
          : ''
      }`
    $('personError').textContent = ''
    $('personSave').textContent = link ? '합치기' : '저장'
    $('personDlg').dataset.link = link ? '1' : ''
    $('personDlg').showModal()
    warnPerson()
  }
  function warnPerson() {
    const el = $('p-name')
    if (!el || el.disabled) return
    const clash = M.nameClash(el.value, members, eff().people, personId)
    $('personWarn').textContent = clash === 'member' ? '같은 이름의 구성원이 있습니다. 다른 사람이면 그대로 저장하세요.' : clash === 'manual' ? '같은 이름으로 직접 등록한 사람이 있습니다. 다른 사람이면 그대로 저장하세요.' : ''
  }
  async function savePerson() {
    const link = !!$('personDlg').dataset.link
    let rec
    if (link) {
      if (!$('p-as').value) return ($('personError').textContent = '합칠 구성원을 고르세요.')
      rec = { id: personId, as: $('p-as').value }
    } else {
      rec = { id: personId || M.newManualId(Math.random(), Date.now()), name: $('p-name').value, dept: $('p-dept').value, title: $('p-title').value, memo: $('p-memo').value }
      if (!M.cleanPerson(rec).name) return ($('personError').textContent = '이름을 적으세요.')
    }
    if (!(await saveAs({ people: [rec] }, link ? '구성원의 기록으로 합쳤습니다.' : personId ? '고쳤습니다.' : '등록했습니다.'))) return
    $('personDlg').close()
    redrawPeople()
  }
  async function patchPerson(patch, done) {
    delAsk = ''
    if (await saveAs({ people: [patch] }, done)) redrawPeople()
  }

  // ---------- 여러 명 대신 신청 (anybody) ----------
  const bulk = { on: true, slots: new Set(), sel: new Set(), open: new Set(), filter: '', dates: [] }
  const slotKey = (s) => `${s.date}|${s.meal}`
  const bulkChosen = () => M.bulkSlots(config(), bulk.dates, now()).filter((s) => s.open && bulk.slots.has(slotKey(s)))
  function openBulk(base) {
    if (!canProxy()) return
    const today = M.ymd(now())
    const day = base && base >= today ? base : today
    // the days of that week from today on
    const monday = M.weekStart(day)
    bulk.dates = Array.from({ length: 7 }, (_, i) => M.addDays(monday, i)).filter((d) => d >= today && (d === day || M.upcoming(config(), now()).includes(d)))
    bulk.on = true
    bulk.filter = ''
    bulk.sel = new Set()
    bulk.slots = new Set(M.bulkSlots(config(), [day], now()).filter((s) => s.open).map(slotKey))
    const own = M.deptGroups(everyone(), me.deptName).find((g) => g.own)
    bulk.open = new Set(own ? [own.dept] : [])
    $('bulkFilter').value = ''
    $('bulkAddPerson').hidden = !canManage() || M.usesCorePeople()
    $('bulkResult').hidden = true
    $('bulkError').textContent = ''
    renderBulk()
    $('bulkDlg').showModal()
  }
  function renderBulk() {
    const today = M.ymd(now())
    const slots = M.bulkSlots(config(), bulk.dates, now())
    for (const s of slots) if (!s.open) bulk.slots.delete(slotKey(s))
    const meals = M.menuMeals(config())
    $('bulkBody').innerHTML = `
      <div class="bulk-top">
        <div class="th-field"><span class="th-label">할 일</span><div class="bulk-act" role="radiogroup" aria-label="할 일">
          <label class="th-check"><input type="radio" name="bulkAct" value="on" ${bulk.on ? 'checked' : ''} /> 신청</label>
          <label class="th-check"><input type="radio" name="bulkAct" value="off" ${bulk.on ? '' : 'checked'} /> 취소</label>
        </div></div>
        <div class="th-field th-grow"><span class="th-label">날짜와 식사</span>
          <table class="th-table bulk-slots"><tbody>${bulk.dates
            .map(
              (d) => `<tr><td class="date">${M.dateLabel(d, today)}</td>${meals
                .map((k) => {
                  const s = slots.find((x) => x.date === d && x.meal === k)
                  return `<td><label class="th-check"><input type="checkbox" data-bslot="${d}|${k}" ${s.open && bulk.slots.has(slotKey(s)) ? 'checked' : ''} ${s.open ? '' : 'disabled'} /> ${M.MEALS[k]}${s.open ? '' : ` <span class="th-xs th-muted">${esc(s.why)}</span>`}</label></td>`
                })
                .join('')}</tr>`
            )
            .join('')}</tbody></table>
        </div>
      </div>`
    renderBulkPeople()
  }
  /** The mark after a name: who requested or cancelled the chosen meal(s) (지시 78). */
  function statusMark(st) {
    const by = (n) => esc(n || '다른 사람')
    switch (st.kind) {
      case 'self':
        return ` <span class="th-badge th-badge-success" data-bstatus="self" title="본인이 직접 신청했습니다">본인 신청</span>`
      case 'proxy':
        return ` <span class="th-badge th-badge-success" data-bstatus="proxy" title="${by(st.byName)} 님이 대신 신청했습니다">${by(st.byName)} 대신 신청</span>`
      case 'cancelSelf':
        return ` <span class="th-badge th-badge-important" data-bstatus="cancelSelf" title="신청했다가 본인이 취소했습니다">본인 취소</span>`
      case 'cancelProxy':
        return ` <span class="th-badge th-badge-important" data-bstatus="cancelProxy" title="신청했다가 ${by(st.byName)} 님이 대신 취소했습니다">${by(st.byName)} 대신 취소</span>`
      case 'firm':
        return ` <span class="th-badge th-badge-urgent" data-bstatus="firm" title="본인이 확실히 신청안함으로 정해 두어 다른 사람이 대신 신청·취소할 수 없습니다">${icon('lock')} 본인 신청안함</span> <span class="th-xs th-muted" data-bwhy>대신 신청 불가</span>`
      case 'mixed':
        return ` <span class="th-badge th-badge-muted" data-bstatus="mixed" title="고른 날짜·식사마다 다릅니다">날짜마다 다름</span>`
      default:
        return ''
    }
  }
  function renderBulkPeople() {
    const chosen = bulkChosen()
    const people = M.resolve(room, members)
    const q = bulk.filter.trim()
    // somebody who has it already (or, for a cancel, has nothing to cancel), or who marked the
    // meal(s) 확실히 신청안함 themselves, cannot be picked
    const done = (id) => M.settled(people, id, chosen, bulk.on)
    const all = everyone()
    for (const id of Array.from(bulk.sel)) if (done(id) || !all.some((m) => m.id === id)) bulk.sel.delete(id)
    const groups = M.deptGroups(all, me.deptName)
    $('bulkPeople').innerHTML =
      groups
        .map((g) => {
          const shown = g.members.filter((m) => !q || m.name.includes(q))
          if (!shown.length) return ''
          const free = g.members.filter((m) => !done(m.id)).map((m) => m.id)
          const state = M.groupState(free, bulk.sel)
          const open = !!q || bulk.open.has(g.dept)
          const picked = free.filter((id) => bulk.sel.has(id)).length
          return `<div class="bulk-group" data-bgroup="${esc(g.dept)}">
          <div class="bulk-head"><input type="checkbox" data-bdept="${esc(g.dept)}" data-state="${state}" ${state === 'all' ? 'checked' : ''} ${free.length ? '' : 'disabled'} aria-label="${esc(g.dept)} 모두" />
            <button type="button" class="bulk-toggle" data-btoggle="${esc(g.dept)}" aria-expanded="${open}">${icon(open ? 'chevron-down' : 'chevron-right')}<b>${esc(g.dept)}</b>${g.own ? ` ${badge('', '내 부서')}` : ''}<span class="th-xs th-muted th-nums">${g.members.length}명${picked ? ` · ${picked}명 선택` : ''}</span></button></div>
          ${
            open
              ? `<div class="bulk-list">${shown
                  .map((m) => {
                    const d = done(m.id)
                    const st = chosen.length ? M.pickStatus(people, m.id, chosen) : { kind: 'none' }
                    // a "no" the person set for themselves is not ticked: nothing was requested
                    const firm = st.kind === 'firm'
                    return `<label class="th-check${firm ? ' firm' : ''}"><input type="checkbox" data-bid="${esc(m.id)}" ${d ? (bulk.on && !firm ? 'checked disabled' : 'disabled') : bulk.sel.has(m.id) ? 'checked' : ''} /> <span>${esc(m.name)}</span>${manualMark(m)}${m.id === me.id ? ` ${badge('muted', '나')}` : ''}${statusMark(st)}</label>`
                  })
                  .join('')}</div>`
              : ''
          }</div>`
        })
        .join('') || '<p class="th-hint" style="padding:0.75rem">찾는 사람이 없습니다.</p>'
    for (const el of $('bulkPeople').querySelectorAll('[data-bdept]')) el.indeterminate = el.dataset.state === 'some'
    $('bulkCount').textContent = `${bulk.sel.size}명 선택`
    $('bulkGo').textContent = bulk.on ? '대신 신청' : '대신 취소'
    $('bulkGo').disabled = busy || !bulk.sel.size || !chosen.length
  }
  /** Everybody who can still be picked: of a department, or of all (the name filter counts). */
  function bulkFree(dept) {
    const chosen = bulkChosen()
    const people = M.resolve(room, members)
    const q = bulk.filter.trim()
    return M.deptGroups(everyone(), me.deptName)
      .filter((g) => dept === undefined || g.dept === dept)
      .flatMap((g) => g.members)
      .filter((m) => (!q || m.name.includes(q)) && !M.settled(people, m.id, chosen, bulk.on))
      .map((m) => m.id)
  }
  async function applyBulk() {
    if (busy) return
    const chosen = bulkChosen().map((s) => ({ date: s.date, meal: s.meal }))
    const all = everyone()
    const targets = all.filter((m) => bulk.sel.has(m.id)).map((m) => ({ id: m.id, name: m.name }))
    busy = true
    $('bulkGo').disabled = true
    $('bulkError').textContent = ''
    try {
      // the newest room and the server's clock right before saving: what closed meanwhile is left out
      await syncClock()
      room = await call('rooms.get', { roomId: room.id })
      const r = M.applyBulk(room, me.id, config(), targets, chosen, bulk.on, now(), everyone())
      if (r.error) $('bulkError').textContent = r.error
      else {
        if (r.result.applied) room = await call('rooms.setEntry', { roomId: room.id, value: r.entry })
        $('bulkResult').textContent = M.bulkSummary(r.result, bulk.on, chosen.length > 1)
        $('bulkResult').hidden = false
        bulk.sel = new Set()
      }
    } catch (e) {
      $('bulkError').textContent = e.message || '저장하지 못했습니다.'
    }
    busy = false
    renderBulk()
  }

  // ---------- the bars above the page: actions, date navigation, tools ----------
  const arrow = (dir, attr, label, off) => `<button class="th-btn th-btn-ghost th-btn-sm th-btn-icon" ${attr} aria-label="${label}" ${off ? 'disabled' : ''}>${icon(dir < 0 ? 'chevron-left' : 'chevron-right') || (dir < 0 ? '&lt;' : '&gt;')}</button>`
  const bulkButton = () => tool('id="bulkOpen"', `${icon('users')} 여러 명 대신 신청`)
  const tool = (attr, html, cls, off) => `<button class="th-btn th-btn-sm ${cls === undefined ? 'th-btn-outline' : cls}" ${attr} ${off ? 'disabled' : ''}>${html}</button>`
  function renderBars() {
    const today = M.ymd(now())
    let nav = ''
    let tools = ''
    let actions = ''
    if (room && tab === 'menu') {
      const w = M.menuWindow(now())
      const days = M.weekDays(config(), menuWeek || M.weekStart(today))
      const edit = menuEdit && canManage()
      const thisWeek = M.weekStart(today)
      nav = `${arrow(-1, 'data-week="-1"', '앞 주', edit || M.addDays(menuWeek, -7) < w.from)}<span class="label" id="weekLabel">${weekLabel(days)}</span>${arrow(1, 'data-week="1"', '다음 주', edit || M.addDays(menuWeek, 7) > w.to)}
        ${tool('data-week="this"', '이번 주', undefined, edit || menuWeek === thisWeek)}${tool('data-week="next"', '다음 주', undefined, edit || menuWeek === M.addDays(thisWeek, 7))}`
      tools = edit
        ? `${tool('id="copyPrev"', `${icon('copy')} 앞 주 복사`)}${tool('id="clearWeek"', `${icon('trash-2')} 이 주 비우기`)}${tool('id="closeEdit"', '닫기')}${tool('id="saveWeek"', `${icon('save')} 저장`, '', busy)}`
        : `${tool('id="copyWeek"', `${icon('copy')} 글로 복사`)}${tool('id="printWeek"', `${icon('file-text')} 인쇄`)}`
      if (canManage() && !edit) actions = tool('id="editWeek"', `${icon('pencil')} 메뉴 등록`, '')
    } else if (room && tab === 'status') {
      nav = `${arrow(-1, 'data-move="-1"', '전날')}<span class="label" id="statusDate">${M.dateLabel(statusDate || today, today)}</span>${arrow(1, 'data-move="1"', '다음 날')}
        ${tool('data-move="0"', '오늘', undefined, (statusDate || today) === today)}<input class="th-input th-nums" type="date" id="statusPick" aria-label="날짜 고르기" value="${statusDate || today}" />`
      tools = `${canProxy() ? bulkButton() : ''}${tool('id="copyDay"', `${icon('copy')} 주문용 글 복사`)}`
    } else if (room && tab === 'month') {
      const cur = month || today.slice(0, 7)
      const [y, m] = cur.split('-').map(Number)
      nav = `${arrow(-1, 'data-month="-1"', '지난달')}<span class="label">${y}년 ${m}월</span>${arrow(1, 'data-month="1"', '다음 달')}${tool('data-month="0"', '이번 달', undefined, cur === today.slice(0, 7))}`
      const views = [
        ['summary', '통합'],
        ['daily', '일별'],
        ['person', '개인별'],
        ['dept', '부서별'],
        ['settle', '식대 정산']
      ]
      tools = `<span class="seg" role="group" aria-label="통계 보기">${views.map(([k, l]) => tool(`data-stats-view="${k}" aria-pressed="${statsView === k}"`, l, statsView === k ? '' : 'th-btn-outline')).join('')}</span>${statsView === 'settle' ? tool('id="printSettle"', `${icon('file-text')} 인쇄`, undefined, !statsOf(cur).snap.summary.total) : ''}${tool('id="csvMonth"', `${icon('download')} CSV로 저장`, undefined, !statsOf(cur).snap.summary.total)}`
    } else if (room && tab === 'mine') {
      const cur = mineMonth || today.slice(0, 7)
      const [y, m] = cur.split('-').map(Number)
      nav = `${arrow(-1, 'data-mine-month="-1"', '지난달')}<span class="label">${y}년 ${m}월</span>${arrow(1, 'data-mine-month="1"', '다음 달')}${tool('data-mine-month="0"', '이번 달', undefined, cur === today.slice(0, 7))}`
    } else if (room && tab === 'apply') actions = `${canProxy() ? bulkButton() : ''}${canManage() ? tool('id="editWeek"', `${icon('pencil')} 메뉴 등록`, '') : ''}`
    $('nav').innerHTML = nav
    $('tools').innerHTML = tools
    $('actions').innerHTML = actions
  }

  function render() {
    const manage = room ? canManage() || me.isAdmin : me.isAdmin
    if (tab === 'settings' && !manage) tab = 'apply'
    if (tab === 'month' && !(room && canStats())) tab = 'apply'
    if (!room && tab !== 'settings') tab = 'apply'
    document.querySelectorAll('nav [role=tab]').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab))
      b.classList.toggle('hidden', b.dataset.tab === 'settings' ? !manage : b.dataset.tab === 'month' ? !(room && canStats()) : b.dataset.tab !== 'apply' && !room)
    })
    $('clock').textContent = `서버 시각 ${hm(now())}`
    if (tab !== 'menu') menuEdit = false
    if (room && !statusDate) statusDate = M.ymd(now())
    if (room && !menuWeek) menuWeek = M.weekStart(M.ymd(now()))
    renderBars()
    if (!room && tab !== 'settings') {
      $('main').innerHTML = me.isAdmin
        ? empty('utensils', '식사 신청을 시작하세요', '점심·저녁의 신청 마감 시각을 정하면 팀원이 신청할 수 있습니다.', '<button class="th-btn" id="goSettings" style="margin-top:0.5rem">설정 열기</button>')
        : empty('utensils', '아직 식사 신청을 받지 않습니다', '관리자(서버 PC)가 신청 마감 시각을 정하면 여기서 신청할 수 있습니다.')
      return
    }
    $('main').innerHTML = tab === 'apply' ? renderApply() : tab === 'menu' ? renderMenu() : tab === 'status' ? renderStatus() : tab === 'month' ? renderMonth() : tab === 'mine' ? renderMine() : `<div class="stack">${renderSettings()}${peopleCard()}</div>`
  }
  render.bars = renderBars
  /** Something is being typed that a redraw would throw away. */
  const typing = () => tab === 'settings' || menuEdit || $('dayDlg').open || $('bulkDlg').open || $('personDlg').open || $('firmDlg').open

  document.querySelector('nav').addEventListener('click', (e) => {
    const b = e.target.closest('[role=tab]')
    if (!b) return
    tab = b.dataset.tab
    render()
  })
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button')
    if (!t || t.closest('nav')) return
    if (t.dataset.act === 'firm') return askFirm(t.dataset.date, t.dataset.meal, !!t.closest('.tile.on'))
    if (t.dataset.act) return void change(t.dataset.date, t.dataset.meal, t.dataset.act === 'apply', null, false)
    if (t.dataset.proxy || t.dataset.unproxy) {
      const meal = t.dataset.proxy || t.dataset.meal
      const id = t.dataset.unproxy || proxySel[meal]
      const m = everyone().find((x) => x.id === id)
      const name = m ? m.name : (M.dayList(room, statusDate, meal, members).find((p) => p.id === id) || {}).name
      if (!id || !name) return toast('대신 신청할 사람을 고르세요.')
      proxySel[meal] = ''
      return void change(statusDate, meal, !t.dataset.unproxy, { id, name })
    }
    if (t.dataset.menuDay) return openDay(t.dataset.menuDay)
    if (t.dataset.priceDel !== undefined) {
      t.closest('tr').remove()
      $('priceEmpty').hidden = !!document.querySelector('#priceRows tr')
      return
    }
    // 직접 등록한 사람
    if (t.dataset.personEdit) return openPerson(t.dataset.personEdit, false)
    if (t.dataset.personLink) return openPerson(t.dataset.personLink, true)
    if (t.dataset.personUnlink) return void patchPerson({ id: t.dataset.personUnlink, as: '' }, '합치기를 취소했습니다.')
    if (t.dataset.personDel) {
      // asked twice: the first press turns the button into "정말 삭제"
      if (delAsk !== t.dataset.personDel) {
        delAsk = t.dataset.personDel
        return redrawPeople()
      }
      return void patchPerson({ id: t.dataset.personDel, gone: true }, '목록에서 지웠습니다. 지난 기록은 집계에 남습니다.')
    }
    // 여러 명 대신 신청
    if (t.dataset.btoggle !== undefined) {
      if (bulk.open.has(t.dataset.btoggle)) bulk.open.delete(t.dataset.btoggle)
      else bulk.open.add(t.dataset.btoggle)
      return renderBulkPeople()
    }
    if (t.dataset.move !== undefined) {
      statusDate = t.dataset.move === '0' ? M.ymd(now()) : M.addDays(statusDate, Number(t.dataset.move))
      return render()
    }
    if (t.dataset.week) {
      const cur = M.weekStart(M.ymd(now()))
      menuWeek = t.dataset.week === 'this' ? cur : t.dataset.week === 'next' ? M.addDays(cur, 7) : M.addDays(menuWeek, 7 * Number(t.dataset.week))
      return render()
    }
    if (t.dataset.statsView) {
      statsView = t.dataset.statsView
      return render()
    }
    if (t.dataset.mineMonth) {
      const [y, m] = (mineMonth || M.ymd(now()).slice(0, 7)).split('-').map(Number)
      const d = t.dataset.mineMonth === '0' ? new Date(now()) : new Date(y, m - 1 + Number(t.dataset.mineMonth), 1)
      mineMonth = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
      return render()
    }
    if (t.dataset.month) {
      const [y, m] = month.split('-').map(Number)
      const d = t.dataset.month === '0' ? new Date(now()) : new Date(y, m - 1 + Number(t.dataset.month), 1)
      month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
      return render()
    }
    switch (t.id) {
      case 'bulkOpen':
        return openBulk(tab === 'status' ? statusDate : M.ymd(now()))
      case 'bulkClose':
        return $('bulkDlg').close()
      case 'bulkAll':
        for (const id of bulkFree()) bulk.sel.add(id)
        return renderBulkPeople()
      case 'bulkNone':
        bulk.sel = new Set()
        return renderBulkPeople()
      case 'personAdd':
      case 'bulkAddPerson':
        return openPerson('', false)
      case 'personClose':
        return $('personDlg').close()
      case 'goSettings':
        tab = 'settings'
        return render()
      case 'editWeek':
        tab = 'menu'
        menuEdit = true
        return render()
      case 'closeEdit':
        menuEdit = false
        return render()
      case 'saveWeek':
        return void saveWeek()
      case 'copyPrev':
        return fillWeek(true)
      case 'clearWeek':
        return fillWeek(false)
      case 'dayClose':
        $('dayDlg').close()
        return render()
      case 'firmClose':
        firmAsk = null
        return $('firmDlg').close()
      case 'printWeek':
      case 'printSettle':
        return window.print()
      case 'priceAdd':
        return addPriceRow()
      case 'copyWeek':
        return void call('clipboard.write', { text: M.weekText(config(), eff().menus, menuWeek) }).then(
          () => toast('주간 메뉴를 글로 복사했습니다.'),
          (err) => toast(err.message)
        )
      case 'copyDay':
        return void call('clipboard.write', { text: M.orderText(room, statusDate, members, M.ymd(now())) }).then(
          () => toast('주문용 글을 복사했습니다.'),
          (err) => toast(err.message)
        )
      case 'csvMonth': {
        const snap = statsOf(month).snap
        const kind = statsView === 'daily' ? ['일별', M.dailyCsv(snap)] : statsView === 'dept' ? ['부서별', M.deptCsv(snap)] : statsView === 'settle' ? ['식대정산', M.settleCsv(settleOf(snap))] : ['개인별', M.personCsv(snap)]
        return void call('file.save', { name: `식사신청_${month}_${kind[0]}.csv`, text: kind[1] }).then(
          (r) => r && r.ok && toast('저장했습니다.'),
          (err) => toast(err.message)
        )
      }
    }
  })
  document.addEventListener('change', (e) => {
    const el = e.target
    if (el.dataset && el.dataset.proxySel) proxySel[el.dataset.proxySel] = el.value
    if (el.id === 'statusPick' && el.value) {
      statusDate = el.value
      render()
    }
    // 여러 명 대신 신청: what to do, which days and meals, who
    if (el.name === 'bulkAct') {
      bulk.on = el.value === 'on'
      bulk.sel = new Set()
      return renderBulkPeople()
    }
    if (el.dataset && el.dataset.bslot) {
      if (el.checked) bulk.slots.add(el.dataset.bslot)
      else bulk.slots.delete(el.dataset.bslot)
      return renderBulkPeople()
    }
    if (el.dataset && el.dataset.bid) {
      if (el.checked) bulk.sel.add(el.dataset.bid)
      else bulk.sel.delete(el.dataset.bid)
      return renderBulkPeople()
    }
    if (el.dataset && el.dataset.bdept !== undefined) {
      // the whole department (those who can still be picked): all of them, or none
      for (const id of bulkFree(el.dataset.bdept)) {
        if (el.checked) bulk.sel.add(id)
        else bulk.sel.delete(id)
      }
      return renderBulkPeople()
    }
    // 식수서무: two at most
    if (el.closest && el.closest('#stewards') && document.querySelectorAll('#stewards input:checked').length > M.LIMITS.stewardsMax) {
      el.checked = false
      toast(`식수서무는 ${M.LIMITS.stewardsMax}명까지 정할 수 있습니다.`)
    }
  })
  document.addEventListener('submit', (e) => {
    e.preventDefault()
    if (e.target.id === 'settings') void saveSettings()
    if (e.target.id === 'menuForm') void saveWeek()
    if (e.target.id === 'dayForm') void saveDay()
    if (e.target.id === 'bulkForm') void applyBulk()
    if (e.target.id === 'personForm') void savePerson()
    if (e.target.id === 'firmForm' && firmAsk) {
      const { date, meal } = firmAsk
      firmAsk = null
      $('firmDlg').close()
      void change(date, meal, false, null, true)
    }
  })
  document.addEventListener('input', (e) => {
    if (e.target.id === 'bulkFilter') {
      bulk.filter = e.target.value
      renderBulkPeople()
    }
    if (e.target.id === 'p-name') warnPerson()
  })
  $('bulkDlg').addEventListener('close', () => render())
  document.addEventListener('paste', pasteBlock)
  $('dayDlg').addEventListener('close', () => render())

  window.TeamHub.on('room.changed', async () => {
    // a saved menu, a changed deadline or a request of somebody else: show it at once, but do
    // not redraw a form somebody is typing in
    await load().catch(() => undefined)
    if (!typing()) render()
    // lists that can follow without losing what is typed
    else if ($('bulkDlg').open && !$('personDlg').open && !busy) renderBulkPeople()
    else if (tab === 'settings' && !$('personDlg').open) redrawPeople()
  })
  // the 서무 changed the list of 미등록 인원 (관리)
  window.TeamHub.on('unregistered.changed', async () => {
    await loadPeople()
    if (!typing()) render()
    else if ($('bulkDlg').open && !busy) renderBulkPeople()
  })
  // countdowns, and the lock at the deadline
  setInterval(() => {
    // not while a list or a date field is open: a redraw would close it
    const a = document.activeElement
    if (me && !typing() && !busy && !(a && ['SELECT', 'INPUT', 'TEXTAREA'].includes(a.tagName))) render()
  }, 20000)
  setInterval(() => void syncClock().then(loadHolidays), 10 * 60000)

  ;(async () => {
    try {
      me = await call('me')
      await syncClock()
      members = await call('members').catch(() => [])
      await loadPeople()
      await loadHolidays()
      await load()
      render()
    } catch (e) {
      $('main').innerHTML = empty('triangle-alert', '불러오지 못했습니다', e.message || '서버 연결을 확인하세요.')
    }
  })()
})()
