/* Copilot helper UI. Copilot has no supported way to receive a question from another
 * program, so this screen writes the question, copies it and opens Copilot; the user pastes.
 * Nothing is sent by TeamHub itself. */
;(function () {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const P = window.CopilotPrompts
  // line icons come from TeamHub (TeamHub.icon); an older TeamHub without them shows the text only
  const icon = (n, o) => (window.TeamHub.icon ? window.TeamHub.icon(n, o) : '')
  const call = (m, p) => window.TeamHub.call(m, p)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  let task = 'summary'
  let custom = []
  let history = []
  /** the question box was edited by hand: typing on the left no longer overwrites it */
  let edited = false

  function toast(msg, ms) {
    const t = $('toast')
    t.textContent = msg
    t.classList.add('show')
    clearTimeout(toast.t)
    toast.t = setTimeout(() => t.classList.remove('show'), ms || 3000)
  }
  const store = (key, value) => call('storage.set', { key, value }).catch(() => undefined)

  function renderTasks() {
    $('tasks').innerHTML = P.TASKS.concat(custom)
      .map((t) => `<button type="button" role="radio" aria-checked="${t.id === task}" data-task="${esc(t.id)}">${icon(t.icon, { fallback: 'star' })} ${esc(t.name)}${t.custom ? `<span class="del" data-del="${esc(t.id)}" title="이 틀 지우기">${icon('x') || '×'}</span>` : ''}</button>`)
      .join('')
    const t = P.taskOf(task, custom)
    $('inputLabel').textContent = `2. ${t.input || '내용'}`
    $('extraBox').classList.toggle('hidden', !t.extra)
    if (t.extra) {
      $('extraLabel').textContent = t.extra
      $('extra').placeholder = t.extraDefault || ''
    }
  }

  function rebuild(force) {
    if (edited && !force) return
    const r = P.build({ task, custom, text: $('text').value, extra: $('extra').value, tone: $('tone').value, length: $('length').value, format: $('format').value })
    $('prompt').value = r.prompt || ''
    edited = false
    count()
  }
  const count = () => ($('count').textContent = $('prompt').value ? `${$('prompt').value.length.toLocaleString()}자` : '')

  /** Ask once more when the question seems to carry personal information. */
  async function safeToSend(text) {
    let found
    try {
      found = await call('pii.scan', { text })
    } catch {
      return true // older TeamHub without the check
    }
    if (!found.length) return true
    return window.confirm(`개인정보로 보이는 내용이 있습니다.\n\n${found.map((f) => `· ${f.label} ${f.count}건: ${f.samples.join(', ')}`).join('\n')}\n\nCopilot에 붙여넣으면 Microsoft로 전송됩니다. 지우고 보내는 것이 안전합니다.\n그래도 복사할까요?`)
  }

  async function send(open) {
    const prompt = $('prompt').value.trim()
    if (!prompt) {
      const r = P.build({ task, custom, text: $('text').value })
      return toast(r.error || '보낼 질문이 없습니다.')
    }
    if (!(await safeToSend(prompt))) return
    try {
      await call('clipboard.write', { text: prompt })
    } catch (e) {
      return toast(e.message || '복사하지 못했습니다.')
    }
    history = [{ at: Date.now(), prompt: prompt.slice(0, 20000) }].concat(history.filter((h) => h.prompt !== prompt)).slice(0, 20)
    void store('history', history)
    if (!open) return toast('질문을 복사했습니다. Copilot에 붙여넣으세요(Ctrl+V).')
    try {
      const r = await call('copilot.open')
      if (r && r.ok) toast(r.where === 'web' ? '질문을 복사했고, 브라우저에서 Copilot을 열었습니다. 입력칸에 Ctrl+V → Enter.' : '질문을 복사했고, Copilot을 열었습니다. 입력칸에 Ctrl+V → Enter.', 6000)
      else toast((r && r.error) || 'Copilot을 열지 못했습니다. 질문은 복사되어 있습니다.', 6000)
    } catch (e) {
      toast(e.message || 'Copilot을 열지 못했습니다. 질문은 복사되어 있습니다.', 6000)
    }
  }

  function renderHistory() {
    $('historyList').innerHTML = history.length
      ? history
          .map((h, i) => {
            const d = new Date(h.at)
            return `<div class="hist"><div><b>${esc(P.titleOf(h.prompt))}</b><span class="muted small">${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} · ${h.prompt.length.toLocaleString()}자</span></div><button type="button" data-use="${i}">다시 쓰기</button></div>`
          })
          .join('')
      : '<p class="muted">아직 보낸 질문이 없습니다.</p>'
  }

  async function init() {
    const opts = (o) => Object.keys(o).map((k) => `<option value="${k}">${esc(o[k].replace(/\(.*\)/, '').trim() || '자유롭게')}</option>`).join('')
    $('tone').innerHTML = opts(P.TONES)
    $('length').innerHTML = opts(P.LENGTHS)
    $('length').value = 'medium'
    $('format').innerHTML = opts(P.FORMATS)

    try {
      const [c, h, last] = await Promise.all([call('storage.get', { key: 'tasks' }), call('storage.get', { key: 'history' }), call('storage.get', { key: 'last' })])
      if (Array.isArray(c)) custom = c.filter((t) => t && t.id && t.name && t.ask).map((t) => Object.assign({}, t, { custom: true }))
      if (Array.isArray(h)) history = h.filter((x) => x && typeof x.prompt === 'string')
      if (last && P.taskOf(last.task, custom).id === last.task) task = last.task
      if (last && P.TONES[last.tone]) $('tone').value = last.tone
    } catch {
      /* starts with the defaults */
    }
    renderTasks()

    $('tasks').addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]')
      if (del) {
        if (!window.confirm('이 질문 틀을 지울까요?')) return
        custom = custom.filter((t) => t.id !== del.dataset.del)
        void store('tasks', custom)
        if (task === del.dataset.del) task = 'summary'
      } else {
        const b = e.target.closest('[data-task]')
        if (!b) return
        task = b.dataset.task
      }
      void store('last', { task, tone: $('tone').value })
      renderTasks()
      rebuild(true)
    })
    for (const id of ['text', 'extra']) $(id).addEventListener('input', () => rebuild(false))
    for (const id of ['tone', 'length', 'format'])
      $(id).addEventListener('change', () => {
        void store('last', { task, tone: $('tone').value })
        rebuild(true)
      })
    $('prompt').addEventListener('input', () => {
      edited = !!$('prompt').value
      count()
    })
    $('go').addEventListener('click', () => void send(true))
    $('copyOnly').addEventListener('click', () => void send(false))
    $('openOnly').addEventListener('click', () => call('copilot.open').then((r) => r && !r.ok && toast(r.error || 'Copilot을 열지 못했습니다.'), (err) => toast(err.message)))

    $('addTask').addEventListener('click', () => {
      $('taskForm').reset()
      $('taskDialog').showModal()
    })
    $('tCancel').addEventListener('click', () => $('taskDialog').close())
    $('taskForm').addEventListener('submit', (e) => {
      e.preventDefault()
      const t = P.customTask($('tName').value, $('tAsk').value)
      if (!t) return
      custom = custom.concat(t).slice(-20)
      void store('tasks', custom)
      task = t.id
      $('taskDialog').close()
      renderTasks()
      rebuild(true)
    })

    $('historyBtn').addEventListener('click', () => {
      renderHistory()
      $('history').showModal()
    })
    $('historyClose').addEventListener('click', () => $('history').close())
    $('historyClear').addEventListener('click', () => {
      if (!history.length || !window.confirm('최근 질문을 모두 지울까요?')) return
      history = []
      void store('history', [])
      renderHistory()
    })
    $('historyList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-use]')
      if (!b) return
      $('prompt').value = history[Number(b.dataset.use)].prompt
      edited = true
      count()
      $('history').close()
    })
  }

  void init()
})()
