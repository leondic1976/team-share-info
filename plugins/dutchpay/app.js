/* Cost-splitting UI. Everything stays on this PC (TeamHub storage); nothing is sent to the server.
 * The look comes from TeamHub (__ui.css, the th-* classes); style.css holds the layout only. */
;(function () {
  'use strict'
  // line icons come from TeamHub (TeamHub.icon); an older TeamHub without them shows the text only
  const icon = (n, o) => (window.TeamHub.icon ? window.TeamHub.icon(n, o) : '')
  const $ = (id) => document.getElementById(id)
  const D = window.Dutch
  const call = (m, p) => window.TeamHub.call(m, p)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const uid = () => 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)

  let tab = 'quick'
  let people = [] // [{ id, name, weight }]
  let expenses = [] // [{ id, title, amount (text), payer, sharers: [id] }]
  let history = []
  let saveTimer = null

  function toast(msg) {
    const t = $('toast')
    t.textContent = msg
    t.classList.add('show')
    clearTimeout(toast.t)
    toast.t = setTimeout(() => t.classList.remove('show'), 2600)
  }
  const store = (key, value) => call('storage.set', { key, value }).catch(() => undefined)
  /** The sheet being worked on survives closing the screen. */
  function saveDraft() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      void store('draft', {
        quick: { title: $('qTitle').value, total: $('qTotal').value, people: $('qPeople').value, deduct: $('qDeduct').value, extraPayers: $('qExtraPayers').value, extra: $('qExtra').value, unit: $('qUnit').value, mode: $('qMode').value },
        items: { title: $('iTitle').value, unit: $('iUnit').value, mode: $('iMode').value, people, expenses }
      })
    }, 400)
  }
  async function copy(text, title) {
    try {
      await call('clipboard.write', { text })
      history.unshift({ at: Date.now(), title, text })
      history = history.slice(0, 50)
      void store('history', history)
      toast('복사했습니다. 메신저에 붙여넣으세요(Ctrl+V). 기록에도 남겼습니다.')
    } catch (e) {
      toast(e.message || '복사하지 못했습니다.')
    }
  }

  // ---------- quick ----------
  function quickInput() {
    return { total: D.parseMoney($('qTotal').value), people: Number($('qPeople').value), deduct: D.parseMoney($('qDeduct').value), extraPayers: Number($('qExtraPayers').value), extra: D.parseMoney($('qExtra').value), unit: Number($('qUnit').value), mode: $('qMode').value }
  }
  function renderQuick() {
    const r = D.quick(quickInput())
    const box = $('qResult')
    if (!r.total) {
      box.innerHTML = '<p class="line th-muted">총 금액과 인원을 넣으면 1인당 금액이 나옵니다.</p>'
      return
    }
    const rest = r.people - r.extraPayers
    box.innerHTML = `
      <div class="lead">
        <span class="th-xs th-muted">${r.extraPayers && rest ? `나머지 ${rest}명은 1인당` : '1인당'}</span>
        <span class="big">${D.won(r.extraPayers && !rest ? r.eachExtra : r.each)}</span>
        ${r.extraPayers && rest ? `<span>더 내는 ${r.extraPayers}명은 <b class="th-nums">${D.won(r.eachExtra)}</b></span>` : ''}
      </div>
      <table class="th-table kv"><tbody>
        <tr><td>총 금액</td><td>${D.won(r.total)}</td></tr>
        ${r.deducted ? `<tr><td>먼저 뺀 금액</td><td>-${D.won(r.deducted)}</td></tr><tr><td>나눌 금액</td><td>${D.won(r.toSplit)}</td></tr>` : ''}
        <tr><td>인원</td><td>${r.people}명</td></tr>
        <tr><td>단위를 맞추기 전</td><td>${D.won(Math.round(r.exact * 100) / 100)}</td></tr>
        <tr><td>모이는 돈</td><td>${D.won(r.collected)}</td></tr>
        <tr><td>${r.diff >= 0 ? '남는 돈' : '모자란 돈'}</td><td class="${r.diff > 0 ? 'plus' : r.diff < 0 ? 'minus' : ''}">${D.won(Math.abs(r.diff))}</td></tr>
      </tbody></table>
      ${r.diff < 0 ? '<p class="th-notice warn">모자란 돈은 계산한 사람이 부담하게 됩니다. 단위 맞춤을 올림으로 바꾸면 모자라지 않습니다.</p>' : ''}
      <div class="card-foot btns"><button type="button" class="th-btn" id="qCopy">${icon('copy')} 결과 복사</button><button type="button" class="th-btn th-btn-outline" id="qToItems">항목별 정산으로</button></div>`
    $('qCopy').addEventListener('click', () => void copy(D.quickText(r, { title: $('qTitle').value.trim(), account: $('account').value.trim() }), $('qTitle').value.trim() || '간단 N빵'))
    $('qToItems').addEventListener('click', () => {
      // carry the bill over as one item so it can be refined (who paid, who joined)
      if (!people.length) for (let i = 1; i <= r.people; i++) people.push({ id: uid(), name: `${i}번`, weight: 1 })
      expenses.push({ id: uid(), title: $('qTitle').value.trim() || '전체', amount: String(r.toSplit), payer: people[0].id, sharers: people.map((p) => p.id) })
      setTab('items')
    })
  }

  // ---------- itemised ----------
  function addPeople(names) {
    let added = 0
    for (const raw of names) {
      const name = String(raw).trim().slice(0, 20)
      if (!name || people.some((p) => p.name === name) || people.length >= 60) continue
      const p = { id: uid(), name, weight: 1 }
      people.push(p)
      // a new person joins every item that everybody shared
      expenses.forEach((e) => e.sharers.length === people.length - 1 && e.sharers.push(p.id))
      added++
    }
    return added
  }
  function renderPeople() {
    $('people').innerHTML = people.length
      ? people.map((p) => `<span class="person" data-id="${p.id}"><span class="name">${esc(p.name)}</span><input class="th-input th-nums" type="number" min="0" max="10" step="0.5" value="${p.weight}" aria-label="${esc(p.name)} 비율" title="분담 비율" /><button type="button" class="x" aria-label="${esc(p.name)} 빼기" title="빼기">${icon('x') || '빼기'}</button></span>`).join('')
      : '<span class="th-muted">[팀원 불러오기]를 누르거나 아래에 이름을 적어 추가하세요.</span>'
  }
  function renderExpenses() {
    $('expenses').innerHTML = expenses.length
      ? expenses
          .map(
            (e) => `<div class="expense" data-id="${e.id}">
          <div class="expense-top">
            <input class="th-input" data-f="title" maxlength="40" placeholder="항목 (예: 1차 고깃집)" aria-label="항목" value="${esc(e.title)}" />
            <input class="th-input th-nums" data-f="amount" inputmode="numeric" placeholder="금액" aria-label="금액" value="${esc(e.amount)}" />
            <select class="th-input" data-f="payer" aria-label="낸 사람"><option value="">낸 사람</option>${people.map((p) => `<option value="${p.id}"${e.payer === p.id ? ' selected' : ''}>${esc(p.name)} 결제</option>`).join('')}</select>
            <button type="button" class="th-btn th-btn-ghost th-btn-sm th-btn-icon del" aria-label="항목 지우기" title="항목 지우기">${icon('trash-2') || '지우기'}</button>
          </div>
          <div class="th-chips sharers">
            ${people.length ? '<span class="th-xs th-muted">함께한 사람</span>' : ''}
            ${people.map((p) => `<label class="th-chip"><input type="checkbox" data-s="${p.id}"${e.sharers.includes(p.id) ? ' checked' : ''} />${esc(p.name)}</label>`).join('')}
            ${people.length ? '<button type="button" class="th-btn th-btn-ghost th-btn-sm" data-all="1">모두</button><button type="button" class="th-btn th-btn-ghost th-btn-sm" data-all="0">모두 해제</button>' : ''}
          </div>
        </div>`
          )
          .join('')
      : '<p class="line th-muted">[항목 추가]를 눌러 쓴 돈을 적으세요. 1차·2차·택시비처럼 여러 개를 넣을 수 있습니다.</p>'
  }
  function computeItems() {
    return D.settle(
      people,
      expenses.map((e) => ({ title: e.title, amount: D.parseMoney(e.amount), payer: e.payer, sharers: e.sharers })),
      { unit: Number($('iUnit').value), mode: $('iMode').value }
    )
  }
  function renderItemsResult() {
    const box = $('iResult')
    if (!people.length || !expenses.some((e) => D.parseMoney(e.amount))) {
      box.innerHTML = '<p class="line th-muted">사람과 쓴 돈을 넣으면 각자 부담할 금액과 보낼 돈이 나옵니다.</p>'
      return
    }
    const r = computeItems()
    const sign = (n) => (n > 0 ? `<span class="plus">받을 돈 ${D.won(n)}</span>` : n < 0 ? `<span class="minus">보낼 돈 ${D.won(-n)}</span>` : '<span class="th-muted">정산 끝</span>')
    // an arrow from the sender to the receiver (the icon set has it pointing up; style.css turns it)
    const to = icon('arrow-up', { cls: 'to', label: '에게' }) || '에게'
    box.innerHTML = `
      ${r.problems.map((p) => `<p class="th-notice warn">${esc(p)}</p>`).join('')}
      <div class="th-table-wrap"><table class="th-table money">
        <thead><tr><th>이름</th><th>부담할 금액</th><th>이미 낸 돈</th><th>정산</th></tr></thead>
        <tbody>${r.rows.map((x) => `<tr><td>${esc(x.name)}</td><td>${D.won(x.share)}</td><td>${x.paid ? D.won(x.paid) : '-'}</td><td>${sign(x.balance)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>합계</td><td>${D.won(r.total)}</td><td>${D.won(r.total)}</td><td></td></tr></tfoot>
      </table></div>
      <div class="sub-head"><h3>보낼 돈</h3>${r.transfers.length ? `<span class="th-xs th-muted">송금 ${r.transfers.length}번이면 끝납니다</span>` : ''}</div>
      <div class="transfers">${r.transfers.length ? r.transfers.map((t) => `<div class="transfer"><b>${esc(t.fromName)}</b>${to}<b>${esc(t.toName)}</b><b class="amount th-nums">${D.won(t.amount)}</b></div>`).join('') : '<p class="th-muted">주고받을 돈이 없습니다.</p>'}
      ${r.roundingDiff ? `<p class="th-xs th-muted">송금 단위를 맞추느라 받는 쪽이 모두 합쳐 ${D.won(Math.abs(r.roundingDiff))} ${r.roundingDiff > 0 ? '더 받습니다' : '덜 받습니다'}.</p>` : ''}</div>
      <div class="card-foot btns"><button type="button" class="th-btn" id="iCopy">${icon('copy')} 결과 복사</button><button type="button" class="th-btn th-btn-outline" id="iReset">새로 시작</button></div>`
    $('iCopy').addEventListener('click', () => void copy(D.settleText(r, { title: $('iTitle').value.trim(), account: $('account').value.trim() }), $('iTitle').value.trim() || '항목별 정산'))
    $('iReset').addEventListener('click', () => {
      if (!window.confirm('사람과 항목을 모두 지우고 새로 시작할까요?')) return
      people = []
      expenses = []
      $('iTitle').value = ''
      renderItems()
      saveDraft()
    })
  }
  function renderItems() {
    renderPeople()
    renderExpenses()
    renderItemsResult()
  }

  // ---------- history ----------
  function renderHistory() {
    $('historyList').innerHTML = history.length
      ? history
          .map((h, i) => {
            const d = new Date(h.at)
            return `<div class="hist"><pre>${esc(h.text)}</pre><div class="hist-side"><span class="th-xs th-muted th-nums">${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</span><button type="button" class="th-btn th-btn-outline th-btn-sm" data-copy="${i}">${icon('copy')} 다시 복사</button></div></div>`
          })
          .join('')
      : `<div class="th-empty">${icon('history')}<p class="th-empty-title">남은 기록이 없습니다</p><p>[결과 복사]를 누르면 그 내용이 여기에 남습니다.</p></div>`
  }

  function setTab(t) {
    tab = t
    document.querySelectorAll('nav [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)))
    for (const id of ['quick', 'items', 'history']) $(id).classList.toggle('hidden', id !== tab)
    if (tab === 'quick') renderQuick()
    else if (tab === 'items') renderItems()
    else renderHistory()
    saveDraft()
  }

  // an older TeamHub does not give extension frames its look (__ui.css): say so
  window.addEventListener('load', () => ($('oldApp').hidden = !!getComputedStyle(document.documentElement).getPropertyValue('--th-ui').trim()))

  async function init() {
    document.querySelectorAll('select.unit').forEach((s) => (s.innerHTML = D.UNITS.map((u) => `<option value="${u}"${u === 100 ? ' selected' : ''}>${u === 1 ? '1원 (그대로)' : D.won(u).replace('원', '') + '원 단위'}</option>`).join('')))
    document.querySelectorAll('select.mode').forEach((s) => (s.innerHTML = Object.keys(D.MODES).map((m) => `<option value="${m}">${D.MODES[m]}</option>`).join('')))
    $('iMode').value = 'round'

    try {
      const [draft, hist, account] = await Promise.all([call('storage.get', { key: 'draft' }), call('storage.get', { key: 'history' }), call('storage.get', { key: 'account' })])
      if (Array.isArray(hist)) history = hist
      if (typeof account === 'string') $('account').value = account
      if (draft && draft.quick) for (const [k, id] of [['title', 'qTitle'], ['total', 'qTotal'], ['people', 'qPeople'], ['deduct', 'qDeduct'], ['extraPayers', 'qExtraPayers'], ['extra', 'qExtra'], ['unit', 'qUnit'], ['mode', 'qMode']]) if (draft.quick[k] !== undefined && draft.quick[k] !== '') $(id).value = draft.quick[k]
      if (draft && draft.items) {
        $('iTitle').value = draft.items.title || ''
        if (draft.items.unit) $('iUnit').value = draft.items.unit
        if (draft.items.mode) $('iMode').value = draft.items.mode
        if (Array.isArray(draft.items.people)) people = draft.items.people.filter((p) => p && p.id && p.name).map((p) => ({ id: String(p.id), name: String(p.name), weight: Number(p.weight) >= 0 ? Number(p.weight) : 1 }))
        if (Array.isArray(draft.items.expenses)) expenses = draft.items.expenses.filter((e) => e && e.id).map((e) => ({ id: String(e.id), title: String(e.title || ''), amount: String(e.amount || ''), payer: String(e.payer || ''), sharers: Array.isArray(e.sharers) ? e.sharers.map(String) : [] }))
      }
    } catch {
      /* starts empty */
    }

    document.querySelector('nav').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]')
      if (b) setTab(b.dataset.tab)
    })
    $('quick').addEventListener('input', () => {
      renderQuick()
      saveDraft()
    })
    $('qMinus').addEventListener('click', () => {
      $('qPeople').value = Math.max(1, Number($('qPeople').value) - 1)
      renderQuick()
      saveDraft()
    })
    $('qPlus').addEventListener('click', () => {
      $('qPeople').value = Math.min(999, Number($('qPeople').value) + 1)
      renderQuick()
      saveDraft()
    })
    $('qAdd').addEventListener('click', (e) => {
      const b = e.target.closest('[data-add]')
      if (!b) return
      const add = Number(b.dataset.add)
      $('qTotal').value = add ? D.won(D.parseMoney($('qTotal').value) + add).replace('원', '') : ''
      renderQuick()
      saveDraft()
    })

    const addFromInput = () => {
      const n = addPeople($('newPerson').value.split(/[,\n]/))
      $('newPerson').value = ''
      if (!n) toast('추가할 이름이 없습니다(같은 이름은 한 번만).')
      renderItems()
      saveDraft()
    }
    $('addPerson').addEventListener('click', addFromInput)
    $('newPerson').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      addFromInput()
    })
    $('loadMembers').addEventListener('click', async () => {
      try {
        const n = addPeople((await call('members')).map((m) => m.name))
        toast(n ? `팀원 ${n}명을 넣었습니다. 함께하지 않은 사람은 이름 옆의 빼기 단추로 빼세요.` : '더 넣을 팀원이 없습니다.')
        renderItems()
        saveDraft()
      } catch (e) {
        toast(e.message || '팀원을 불러오지 못했습니다(서버 연결 필요).')
      }
    })
    $('people').addEventListener('input', (e) => {
      const el = e.target.closest('.person')
      const p = el && people.find((x) => x.id === el.dataset.id)
      if (!p) return
      const w = Number(e.target.value)
      p.weight = Number.isFinite(w) && w >= 0 ? w : 1
      renderItemsResult()
      saveDraft()
    })
    $('people').addEventListener('click', (e) => {
      if (!e.target.closest('button')) return
      const id = e.target.closest('.person').dataset.id
      people = people.filter((p) => p.id !== id)
      expenses.forEach((x) => {
        x.sharers = x.sharers.filter((s) => s !== id)
        if (x.payer === id) x.payer = ''
      })
      renderItems()
      saveDraft()
    })
    $('addExpense').addEventListener('click', () => {
      expenses.push({ id: uid(), title: '', amount: '', payer: people[0] ? people[0].id : '', sharers: people.map((p) => p.id) })
      renderItems()
      saveDraft()
      const rows = $('expenses').querySelectorAll('.expense')
      rows[rows.length - 1].querySelector('input').focus()
    })
    const expenseOf = (el) => expenses.find((x) => x.id === el.closest('.expense').dataset.id)
    $('expenses').addEventListener('input', (e) => {
      const x = expenseOf(e.target)
      if (!x) return
      if (e.target.dataset.f) x[e.target.dataset.f] = e.target.value
      else if (e.target.dataset.s) x.sharers = e.target.checked ? [...new Set(x.sharers.concat(e.target.dataset.s))] : x.sharers.filter((s) => s !== e.target.dataset.s)
      renderItemsResult()
      saveDraft()
    })
    $('expenses').addEventListener('click', (e) => {
      const b = e.target.closest('button')
      if (!b) return
      const x = expenseOf(b)
      if (b.classList.contains('del')) expenses = expenses.filter((y) => y !== x)
      else if (b.dataset.all !== undefined) x.sharers = b.dataset.all === '1' ? people.map((p) => p.id) : []
      renderItems()
      saveDraft()
    })
    for (const id of ['iTitle', 'iUnit', 'iMode'])
      $(id).addEventListener('input', () => {
        renderItemsResult()
        saveDraft()
      })
    $('account').addEventListener('input', () => void store('account', $('account').value.trim()))
    $('historyList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-copy]')
      if (b) call('clipboard.write', { text: history[Number(b.dataset.copy)].text }).then(() => toast('복사했습니다.'), (err) => toast(err.message))
    })
    $('clearHistory').addEventListener('click', () => {
      if (!history.length || !window.confirm('정산 기록을 모두 지울까요?')) return
      history = []
      void store('history', history)
      renderHistory()
    })

    setTab('quick')
  }

  void init()
})()
