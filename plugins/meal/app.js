/* Meal request UI. Talks to TeamHub only via TeamHub.call (see __sdk.js).
 *
 * The settings are the shared data of one team room made by an admin; my requests are my
 * own entry of that room. Deadlines are judged by the server's clock (TeamHub.call('time')). */
;(function () {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const M = window.Meal
  const call = (m, p) => window.TeamHub.call(m, p)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  let me = null
  let members = []
  let room = null
  let tab = 'apply'
  let offset = 0 // server clock - this PC's clock
  let statusDate = ''
  let month = ''
  let busy = false

  const now = () => Date.now() + offset
  const config = () => M.cleanConfig(room && room.shared)
  const mine = () => (room && room.entries && room.entries[me.id] ? room.entries[me.id].value : null)
  const hm = (ms) => {
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  function toast(msg) {
    const t = $('toast')
    t.textContent = msg
    t.classList.add('show')
    clearTimeout(toast.t)
    toast.t = setTimeout(() => t.classList.remove('show'), 2800)
  }
  const empty = (icon, title, body) => `<div class="empty"><div class="big">${icon}</div><h2>${esc(title)}</h2><p>${esc(body)}</p></div>`

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
  async function load() {
    room = M.pickRoom(await call('rooms.list'))
  }

  // ---------- 신청 ----------
  function mealTile(c, date, meal) {
    const st = M.stateOf(c, date, meal, now())
    if (st === 'off') return ''
    const on = M.wants(mine(), date, meal)
    const at = M.requestedAt(mine(), date, meal)
    const count = M.dayList(room, date, meal, members).length
    const cut = M.cutoffAt(c, date, meal)
    const open = st === 'open'
    return `<div class="tile ${on ? 'on' : ''} ${open ? '' : 'locked'}" data-tile="${date}:${meal}">
      <div class="tile-top"><b>${M.MEALS[meal]}</b><span class="count">${count}명 신청</span></div>
      <div class="state">${on ? '✅ 신청함' : open ? '신청 안 함' : '신청하지 않음'}${at ? ` <span class="muted small">${hm(at)} ${on ? '신청' : '취소'}</span>` : ''}</div>
      <div class="deadline ${open ? '' : 'over'}">${open ? `${c.meals[meal].cutoff} 마감 · ${M.remaining(cut - now())}` : `${c.meals[meal].cutoff} 마감됨`}</div>
      ${open ? `<button class="${on ? 'danger' : 'primary'}" data-act="${on ? 'cancel' : 'apply'}" data-date="${date}" data-meal="${meal}" ${busy ? 'disabled' : ''}>${on ? '취소' : at ? '다시 신청' : '신청'}</button>` : ''}
    </div>`
  }
  function renderApply() {
    const c = config()
    const today = M.ymd(now())
    const days = M.upcoming(c, now())
    if (!days.length) return empty('🍱', '신청을 받는 날이 없습니다', '관리자가 설정에서 받는 식사와 요일을 정합니다.')
    return `<div class="wrap">
      ${c.notice ? `<div class="notice">${esc(c.notice)}</div>` : ''}
      <p class="muted small">마감 시각 전에는 신청·취소·다시 신청을 마음대로 할 수 있습니다. 마감 뒤에는 바꿀 수 없습니다.</p>
      ${days.map((date) => `<section class="card day ${date === today ? 'today' : ''}"><h2>${M.dateLabel(date, today)}</h2><div class="tiles">${M.MEAL_KEYS.map((k) => mealTile(c, date, k)).join('')}</div></section>`).join('')}
    </div>`
  }
  async function change(date, meal, on) {
    if (busy) return
    busy = true
    try {
      await syncClock()
      // read the newest state first: the settings may have changed and my entry is replaced as a whole
      const fresh = await call('rooms.get', { roomId: room.id })
      room = fresh
      const r = M.apply(mine(), config(), date, meal, on, now())
      if (r.error) toast(r.error)
      else {
        room = await call('rooms.setEntry', { roomId: room.id, value: r.entry })
        toast(`${M.dateLabel(date, M.ymd(now()))} ${M.MEALS[meal]}을 ${on ? '신청했습니다' : '취소했습니다'}.`)
      }
    } catch (e) {
      toast(e.message || '저장하지 못했습니다.')
    }
    busy = false
    render()
  }

  // ---------- 현황 ----------
  function renderStatus() {
    const c = config()
    const today = M.ymd(now())
    if (!statusDate) statusDate = today
    const blocks = M.MEAL_KEYS.filter((k) => c.meals[k].on)
      .map((k) => {
        const list = M.dayList(room, statusDate, k, members)
        const st = M.stateOf(c, statusDate, k, now())
        const badge = st === 'open' ? `<span class="badge todo">신청 받는 중 · ${c.meals[k].cutoff} 마감</span>` : st === 'closed' ? '<span class="badge done">마감 · 확정</span>' : '<span class="badge">받지 않는 날</span>'
        const depts = new Map()
        for (const p of list) depts.set(p.deptName || '부서 미지정', [...(depts.get(p.deptName || '부서 미지정') || []), p])
        return `<section class="card" data-status="${k}"><div class="card-top"><b>${M.MEALS[k]} <span class="total">${list.length}명</span></b>${badge}</div>
          ${list.length ? [...depts].map(([d, ps]) => `<div class="dept"><span class="muted small">${esc(d)} ${ps.length}</span><div class="who">${ps.map((p) => `<span title="${hm(p.at)} 신청">${esc(p.name)}</span>`).join('')}</div></div>`).join('') : '<p class="muted small">신청한 사람이 없습니다.</p>'}
        </section>`
      })
      .join('')
    return `<div class="wrap">
      <div class="bar-nav"><button data-move="-1" aria-label="전날">◀</button><b id="statusDate">${M.dateLabel(statusDate, today)}</b><button data-move="1" aria-label="다음 날">▶</button><button data-move="0" ${statusDate === today ? 'disabled' : ''}>오늘</button><span class="grow"></span><button id="copyDay">주문용 글 복사</button></div>
      ${blocks}
    </div>`
  }

  // ---------- 집계 ----------
  function renderMonth() {
    if (!month) month = M.ymd(now()).slice(0, 7)
    const t = M.monthTally(room, month, members, now(), false)
    const [y, m] = month.split('-').map(Number)
    return `<div class="wrap">
      <div class="bar-nav"><button data-month="-1" aria-label="지난달">◀</button><b>${y}년 ${m}월</b><button data-month="1" aria-label="다음 달">▶</button><span class="grow"></span><button id="csvMonth" ${t.rows.length ? '' : 'disabled'}>CSV로 저장</button></div>
      <p class="muted small">마감이 지나 확정된 신청만 셉니다. 신청 기록은 ${M.LIMITS.keepDays}일 동안 보관됩니다.</p>
      ${
        t.rows.length
          ? `<table class="tally"><thead><tr><th>부서</th><th>이름</th><th>점심</th><th>저녁</th><th>합계</th></tr></thead><tbody>
            ${t.rows.map((r) => `<tr><td class="muted">${esc(r.deptName)}</td><td>${esc(r.name)}</td><td>${r.lunch}</td><td>${r.dinner}</td><td><b>${r.lunch + r.dinner}</b></td></tr>`).join('')}
            </tbody><tfoot><tr><td></td><td>합계</td><td>${t.lunch}</td><td>${t.dinner}</td><td><b>${t.lunch + t.dinner}</b></td></tr></tfoot></table>`
          : empty('🧾', '이 달에 확정된 신청이 없습니다', '마감이 지난 신청이 여기에 사람별로 모입니다.')
      }
    </div>`
  }

  // ---------- 설정 (관리자) ----------
  function renderSettings() {
    const c = config()
    const own = !room || room.createdBy === me.id
    const row = (k) => `<div class="set-row"><label class="inline"><input type="checkbox" id="on-${k}" ${c.meals[k].on ? 'checked' : ''} ${own ? '' : 'disabled'} /> ${M.MEALS[k]} 받기</label><label for="cut-${k}">신청 마감 시각</label><input type="time" id="cut-${k}" value="${c.meals[k].cutoff}" ${own ? '' : 'disabled'} /></div>`
    return `<div class="wrap"><form id="settings" class="card">
      <h2>식사 신청 설정</h2>
      <p class="muted small">관리자(서버 PC)가 정합니다. 마감 시각이 지나면 그날 그 식사는 누구도 신청·취소할 수 없습니다. 시각은 서버 PC의 시계를 따릅니다.</p>
      ${own ? '' : `<p class="error">설정은 처음 만든 관리자(${esc(room.createdByName)})만 바꿀 수 있습니다.</p>`}
      ${row('lunch')}${row('dinner')}
      <div class="set-row"><label for="ahead">며칠 앞까지 신청</label><input type="number" id="ahead" min="1" max="${M.LIMITS.aheadMax}" value="${c.ahead}" ${own ? '' : 'disabled'} /><span class="muted small">1 = 오늘만</span></div>
      <label class="inline"><input type="checkbox" id="weekend" ${c.weekend ? 'checked' : ''} ${own ? '' : 'disabled'} /> 토·일요일에도 받기</label>
      <label for="notice">안내 글 <small>(선택, 신청 화면 맨 위에 보임)</small></label>
      <textarea id="notice" rows="2" maxlength="${M.LIMITS.notice}" placeholder="예: 구내식당 4,000원, 식권은 서무에게" ${own ? '' : 'disabled'}>${esc(c.notice)}</textarea>
      <p id="setError" class="error" role="alert"></p>
      <div class="btns"><span class="grow"></span>${own ? `<button type="submit" class="primary">${room ? '저장' : '식사 신청 시작'}</button>` : ''}</div>
    </form></div>`
  }
  async function saveSettings() {
    const c = M.cleanConfig({
      meals: { lunch: { on: $('on-lunch').checked, cutoff: $('cut-lunch').value }, dinner: { on: $('on-dinner').checked, cutoff: $('cut-dinner').value } },
      ahead: $('ahead').value,
      weekend: $('weekend').checked,
      notice: $('notice').value
    })
    if (!c.meals.lunch.on && !c.meals.dinner.on) return ($('setError').textContent = '점심과 저녁 가운데 하나는 받아야 합니다.')
    try {
      if (room) room = await call('rooms.setShared', { roomId: room.id, shared: c })
      else {
        // somebody may have started it a moment ago
        await load()
        room = room || (await call('rooms.create', { title: '식사 신청', scope: { type: 'team', groupIds: [], memberIds: [] }, shared: c }))
      }
      toast('설정을 저장했습니다.')
      tab = 'apply'
      render()
    } catch (e) {
      $('setError').textContent = e.message || '저장하지 못했습니다.'
    }
  }

  function render() {
    $('settingsTab').classList.toggle('hidden', !me.isAdmin)
    if (tab === 'settings' && !me.isAdmin) tab = 'apply'
    document.querySelectorAll('nav [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)))
    $('clock').textContent = `서버 시각 ${hm(now())}`
    if (!room && !(me.isAdmin && tab === 'settings')) {
      $('main').innerHTML = me.isAdmin
        ? empty('🍱', '식사 신청을 시작하세요', '[설정]에서 점심·저녁의 신청 마감 시각을 정하면 팀원이 신청할 수 있습니다.')
        : empty('🍱', '아직 식사 신청을 받지 않습니다', '관리자(서버 PC)가 신청 마감 시각을 정하면 여기서 신청할 수 있습니다.')
      return
    }
    $('main').innerHTML = tab === 'apply' ? renderApply() : tab === 'status' ? renderStatus() : tab === 'month' ? renderMonth() : renderSettings()
  }

  document.querySelector('nav').addEventListener('click', (e) => {
    const b = e.target.closest('[role=tab]')
    if (!b) return
    tab = b.dataset.tab
    render()
  })
  $('main').addEventListener('click', (e) => {
    const t = e.target.closest('button')
    if (!t) return
    if (t.dataset.act) return void change(t.dataset.date, t.dataset.meal, t.dataset.act === 'apply')
    if (t.dataset.move !== undefined) {
      statusDate = t.dataset.move === '0' ? M.ymd(now()) : M.addDays(statusDate, Number(t.dataset.move))
      return render()
    }
    if (t.dataset.month) {
      const [y, m] = month.split('-').map(Number)
      const d = new Date(y, m - 1 + Number(t.dataset.month), 1)
      month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      return render()
    }
    if (t.id === 'copyDay')
      return void call('clipboard.write', { text: M.orderText(room, statusDate, members, M.ymd(now())) }).then(
        () => toast('주문용 글을 복사했습니다.'),
        (err) => toast(err.message)
      )
    if (t.id === 'csvMonth')
      return void call('file.save', { name: `식사신청_${month}.csv`, text: M.monthCsv(room, month, members, now()) }).then(
        (r) => r && r.ok && toast('저장했습니다.'),
        (err) => toast(err.message)
      )
  })
  $('main').addEventListener('submit', (e) => {
    if (e.target.id !== 'settings') return
    e.preventDefault()
    void saveSettings()
  })

  window.TeamHub.on('room.changed', async () => {
    // do not redraw the settings form while the admin is typing in it
    await load().catch(() => undefined)
    if (tab !== 'settings') render()
  })
  // countdowns, and the lock at the deadline
  setInterval(() => {
    if (me && tab !== 'settings' && !busy) render()
  }, 20000)
  setInterval(() => void syncClock(), 10 * 60000)

  ;(async () => {
    try {
      me = await call('me')
      await syncClock()
      members = await call('members').catch(() => [])
      await load()
      render()
    } catch (e) {
      $('main').innerHTML = empty('⚠️', '불러오지 못했습니다', e.message || '서버 연결을 확인하세요.')
    }
  })()
})()
