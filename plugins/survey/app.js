/* Survey UI. Talks to TeamHub only via TeamHub.call (see __sdk.js).
 *
 * One survey is one room: the questions are the room's shared data (only the person who
 * made it can change or close it) and every member's answers are that member's own entry.
 * The look comes from TeamHub (__ui.css, the th-* classes); style.css holds the layout only. */
;(function () {
  'use strict'
  // line icons come from TeamHub (TeamHub.icon); an older TeamHub without them shows the text only
  const icon = (n, o) => (window.TeamHub.icon ? window.TeamHub.icon(n, o) : '')
  const $ = (id) => document.getElementById(id)
  const S = window.Survey
  const call = (m, p) => window.TeamHub.call(m, p)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  let me = null
  let members = []
  let rooms = []
  let tab = 'open'
  let current = null // id of the survey being shown
  let draft = {} // my answers while filling in
  let editingAnswers = false
  let bq = [] // questions in the builder

  function toast(msg) {
    const t = $('toast')
    t.textContent = msg
    t.classList.add('show')
    clearTimeout(toast.t)
    toast.t = setTimeout(() => t.classList.remove('show'), 2600)
  }
  const fmt = (t) => {
    const d = new Date(t)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const empty = (pic, title, body, action) => `<div class="th-empty empty">${pic}<p class="th-empty-title">${esc(title)}</p><p>${esc(body)}</p>${action || ''}</div>`
  // the state of a survey: `badge` is kept as a class for whoever looks for it
  const badge = (kind, text) => `<span class="th-badge${kind ? ` th-badge-${kind}` : ''} badge">${text}</span>`
  const scopeName = (r) => (r.scope.type === 'team' ? '팀 전체' : '지정한 사람')
  const room = () => rooms.find((r) => r.id === current) || null
  const answered = (r) => !!(r.entries && r.entries[me.id])
  /** People asked to answer: the listed members, or the whole team. */
  const audience = (r) => (r.scope.type === 'members' ? r.scope.members.map((m) => m.name) : members.map((m) => m.name))

  async function load() {
    rooms = (await call('rooms.list')).filter((r) => S.isSurvey(r.shared))
  }
  function put(r) {
    const i = rooms.findIndex((x) => x.id === r.id)
    if (i >= 0) rooms[i] = r
    else rooms.unshift(r)
  }

  // ---------- list ----------
  function renderList() {
    document.querySelectorAll('nav [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)))
    const now = Date.now()
    const list = rooms.filter((r) => (tab === 'mine' ? r.createdBy === me.id : tab === 'open' ? S.isOpen(r, now) : !S.isOpen(r, now)))
    list.sort((a, b) => (tab === 'open' ? Number(answered(a)) - Number(answered(b)) : 0) || b.createdAt - a.createdAt)
    $('main').innerHTML = list.length
      ? `<div class="grid">${list
          .map((r) => {
            const open = S.isOpen(r, now)
            const n = Object.keys(r.entries || {}).length
            const who = audience(r).length
            return `<button class="th-card card" data-open="${esc(r.id)}">
              <span class="card-top"><b>${esc(r.title)}</b>${open ? (answered(r) ? badge('success', '응답함') : badge('important', '응답 필요')) : badge('muted', '마감')}</span>
              <span class="meta th-xs th-muted"><span>${esc(r.createdByName)}</span><span>문항 ${r.shared.questions.length}개</span><span>응답 ${n}${who ? ` / ${who}` : ''}명</span>${r.shared.deadline ? `<span>마감 ${fmt(r.shared.deadline)}</span>` : ''}${r.shared.anonymous ? '<span>이름 숨김</span>' : ''}<span>${scopeName(r)}</span></span>
              ${who ? `<span class="th-meter" aria-hidden="true"><i style="width:${Math.min(100, Math.round((n / who) * 100))}%"></i></span>` : ''}
            </button>`
          })
          .join('')}</div>`
      : tab === 'open'
        ? empty(icon('chart-column'), '진행 중인 설문이 없습니다', '[새 설문 만들기]로 팀원의 의견을 모아 보세요.')
        : tab === 'closed'
          ? empty(icon('folder-archive'), '끝난 설문이 없습니다', '마감한 설문과 결과가 여기에 모입니다.')
          : empty(icon('pencil'), '내가 만든 설문이 없습니다', '[새 설문 만들기]를 눌러 시작하세요.')
  }

  // ---------- one survey ----------
  function questionHtml(q, i) {
    const v = draft[q.id]
    const head = `<h3 class="q-title">${i + 1}. ${esc(q.text)}${q.required ? ' <span class="req" title="꼭 답해야 하는 문항">*</span>' : ''}${q.type === 'multi' ? ' <span class="th-xs th-muted">(여러 개 선택)</span>' : ''}</h3>`
    let body
    if (q.type === 'single' || q.type === 'multi')
      body = q.options
        .map((o, k) => {
          const on = q.type === 'single' ? v === o : Array.isArray(v) && v.includes(o)
          return `<label class="th-check choice"><input type="${q.type === 'single' ? 'radio' : 'checkbox'}" name="q-${esc(q.id)}" data-q="${esc(q.id)}" data-k="${k}"${on ? ' checked' : ''} /> ${esc(o)}</label>`
        })
        .join('')
    else if (q.type === 'rating') body = `<div class="stars" role="radiogroup" aria-label="별점">${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="${v === n}" aria-label="${n}점" data-q="${esc(q.id)}" data-star="${n}" class="${v >= n ? 'on' : ''}">${icon('star', { fill: true }) || `${n}점`}</button>`).join('')}</div>`
    else body = `<textarea class="th-input" rows="3" maxlength="${S.LIMITS.answer}" data-q="${esc(q.id)}" data-text="1" placeholder="답을 적어 주세요.">${esc(v || '')}</textarea>`
    return `<div class="th-card question">${head}${body}</div>`
  }
  const barRow = (label, percent, count, top, title) => `<div class="bar-row${top ? ' top' : ''}" title="${title || ''}"><span class="bar-label">${label}</span><div class="th-meter"><i style="width:${percent}%"></i></div><span class="count th-xs th-nums">${count}</span></div>`

  function resultHtml(r) {
    const hide = r.shared.anonymous
    return S.tally(r)
      .map((t, i) => {
        let body
        if (t.options)
          body = t.options.map((o) => barRow(esc(o.label), o.percent, `${o.count}명 · ${o.percent}%`, o.count && o.count === t.top, hide ? '' : esc(o.names.join(', ')))).join('')
        else if (t.type === 'rating')
          body = `<p class="avg"><b class="big th-nums">${icon('star', { fill: true, cls: 'star-on' })} ${t.average.toFixed(1)}</b> <span class="th-muted">/ 5 · ${t.answered}명</span></p>${t.counts
            .map((c, k) => barRow(`${k + 1}점`, t.answered ? Math.round((c / t.answered) * 100) : 0, `${c}명`))
            .reverse()
            .join('')}`
        else body = t.texts.length ? `<ul class="texts">${t.texts.map((x) => `<li>${esc(x.text)}${hide ? '' : ` <span class="th-xs th-muted">— ${esc(x.name)}</span>`}</li>`).join('')}</ul>` : '<p class="th-muted none">아직 답이 없습니다.</p>'
        return `<div class="th-card question"><h3 class="q-title">${i + 1}. ${esc(t.text)} <span class="th-xs th-muted">응답 ${t.answered}명</span></h3>${body}</div>`
      })
      .join('')
  }

  function renderSurvey() {
    const r = room()
    if (!r) {
      current = null
      return renderList()
    }
    const now = Date.now()
    const open = S.isOpen(r, now)
    const mine = r.createdBy === me.id
    const done = answered(r)
    const filling = open && (!done || editingAnswers)
    const names = Object.keys(r.entries || {}).map((id) => r.entries[id].name)
    const waiting = audience(r).filter((n) => !names.includes(n))
    const see = S.canSeeResults(r, me.id, now)
    const scroll = $('main').scrollTop

    const tool = (name, body, cls) => `<button class="th-btn th-btn-sm ${cls || 'th-btn-outline'}" data-act="${name}">${body}</button>`
    const fact = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`
    // the survey itself on the side (above, in a narrow window); answering and the results in the wide column
    $('main').innerHTML = `<div class="detail">
      <aside class="stack side">
        <div><button class="th-btn th-btn-ghost th-btn-sm" data-act="back">${icon('chevron-left')} 목록으로</button></div>
        <section class="th-card">
          <div class="th-card-header card-top"><h2 class="th-card-title">${esc(r.title)}</h2>${open ? badge('', '진행 중') : badge('muted', '마감')}</div>
          <div class="th-card-body stack tight">
            ${r.shared.desc ? `<p class="desc">${esc(r.shared.desc)}</p>` : ''}
            <dl class="facts">
              ${fact('만든 사람', esc(r.createdByName))}
              ${fact('시작', fmt(r.createdAt))}
              ${r.shared.deadline ? fact('마감', fmt(r.shared.deadline)) : ''}
              ${fact('받는 사람', scopeName(r))}
              ${fact('결과 공개', esc(S.RESULTS[r.shared.results]))}
              ${r.shared.anonymous ? fact('이름', '숨김') : ''}
            </dl>
          </div>
          ${mine ? `<div class="card-foot btns">${open ? tool('close', `${icon('lock')} 지금 마감하기`) : ''}${tool('copy', `${icon('copy')} 결과 복사`)}${tool('csv', `${icon('download')} CSV로 저장`)}<span class="th-grow"></span>${tool('delete', `${icon('trash-2')} 설문 삭제`, 'th-btn-ghost danger')}</div>` : ''}
        </section>
        ${
          r.shared.anonymous
            ? ''
            : `<section class="th-card people">
                <div class="th-card-header"><h2 class="th-card-title">응답한 사람 ${names.length}명</h2></div>
                <div class="th-card-body who">${names.map((n) => `<span class="th-badge th-badge-success">${esc(n)}</span>`).join('') || '<span class="th-xs th-muted no">아직 없음</span>'}</div>
                ${waiting.length ? `<div class="th-card-header mid"><h2 class="th-card-title">아직 응답하지 않은 사람 ${waiting.length}명</h2></div><div class="th-card-body who">${waiting.map((n) => `<span class="th-badge th-badge-muted no">${esc(n)}</span>`).join('')}</div>` : ''}
              </section>`
        }
      </aside>
      <div class="stack">
        ${
          filling
            ? `<form id="answerForm" class="stack">${r.shared.questions.map(questionHtml).join('')}
                <div class="btns"><button type="submit" class="th-btn">${done ? '응답 고치기' : '응답 보내기'}</button>${done ? '<button type="button" class="th-btn th-btn-outline" data-act="cancelEdit">취소</button>' : ''}<span class="th-xs th-muted">* 표시는 꼭 답해야 하는 문항입니다. 마감 전까지 고칠 수 있습니다.</span></div>
              </form>`
            : `<div class="th-card"><div class="th-card-body btns"><b class="${done ? 'done' : ''}">${done ? `${icon('circle-check')} 응답했습니다.` : open ? '' : '마감된 설문입니다. 응답하지 않았습니다.'}</b><span class="th-grow"></span>${done && open ? `<button class="th-btn th-btn-outline th-btn-sm" data-act="edit">${icon('pencil')} 내 응답 고치기</button>` : ''}</div></div>`
        }
        ${
          !filling || mine
            ? see
              ? `<div class="sub-head"><h3>결과</h3><span class="th-xs th-muted th-nums">응답 ${names.length}명${audience(r).length ? ` / ${audience(r).length}명` : ''}</span></div>${resultHtml(r)}`
              : `<div class="th-card"><div class="th-card-body th-muted">결과는 ${esc(S.RESULTS[r.shared.results])} 볼 수 있습니다.</div></div>`
            : ''
        }
      </div>
    </div>`
    $('main').scrollTop = scroll
  }

  const render = () => (current ? renderSurvey() : renderList())

  function openSurvey(id) {
    current = id
    const r = room()
    draft = r && answered(r) ? Object.assign({}, r.entries[me.id].value && r.entries[me.id].value.answers) : {}
    editingAnswers = false
    render()
    $('main').scrollTop = 0
  }

  async function submitAnswers() {
    const r = room()
    const checked = S.cleanAnswers(r.shared, draft)
    if (checked.error) return toast(checked.error)
    try {
      put(await call('rooms.setEntry', { roomId: r.id, value: { answers: checked.answers } }))
      editingAnswers = false
      toast('응답을 보냈습니다.')
      render()
      $('main').scrollTop = 0
    } catch (e) {
      toast(e.message || '보내지 못했습니다.')
    }
  }

  async function act(name) {
    const r = room()
    if (name === 'back') {
      current = null
      return render()
    }
    if (!r) return
    try {
      if (name === 'edit') {
        editingAnswers = true
        render()
      } else if (name === 'cancelEdit') openSurvey(r.id)
      else if (name === 'close') {
        if (!window.confirm('설문을 지금 마감할까요? 마감하면 더 응답할 수 없습니다.')) return
        put(await call('rooms.setShared', { roomId: r.id, shared: r.shared, close: true }))
        toast('마감했습니다.')
        render()
      } else if (name === 'delete') {
        if (!window.confirm(`'${r.title}' 설문과 모든 응답을 지울까요? 되돌릴 수 없습니다.`)) return
        await call('rooms.delete', { roomId: r.id })
        rooms = rooms.filter((x) => x.id !== r.id)
        current = null
        toast('지웠습니다.')
        render()
      } else if (name === 'copy') {
        await call('clipboard.write', { text: S.summaryText(r) })
        toast('결과를 복사했습니다. 메신저에 붙여넣으세요(Ctrl+V).')
      } else if (name === 'csv') {
        const res = await call('file.save', { name: `설문_${r.title.replace(/[\\/:*?"<>|]/g, ' ').slice(0, 40)}.csv`, text: S.toCsv(r) })
        if (res && res.ok) toast('저장했습니다.')
      }
    } catch (e) {
      toast(e.message || '하지 못했습니다.')
    }
  }

  // ---------- builder ----------
  const blankQuestion = () => ({ id: S.newId(), type: 'single', text: '', options: '', required: true })
  function renderBuilder() {
    $('bQuestions').innerHTML = bq
      .map(
        (q, i) => `<div class="bq" data-i="${i}">
        <div class="bq-head"><b>문항 ${i + 1}</b>
          <select class="th-input" data-f="type" aria-label="문항 종류">${Object.keys(S.TYPES).map((t) => `<option value="${t}"${q.type === t ? ' selected' : ''}>${esc(S.TYPES[t])}</option>`).join('')}</select>
          <span class="th-grow"></span>
          <button type="button" class="th-btn th-btn-ghost th-btn-sm th-btn-icon" data-b="up" aria-label="위로" title="위로"${i === 0 ? ' disabled' : ''}>${icon('arrow-up') || '위'}</button>
          <button type="button" class="th-btn th-btn-ghost th-btn-sm th-btn-icon" data-b="down" aria-label="아래로" title="아래로"${i === bq.length - 1 ? ' disabled' : ''}>${icon('arrow-down') || '아래'}</button>
          <button type="button" class="th-btn th-btn-ghost th-btn-sm th-btn-icon" data-b="del" aria-label="문항 지우기" title="문항 지우기"${bq.length === 1 ? ' disabled' : ''}>${icon('trash-2') || '지우기'}</button>
        </div>
        <input class="th-input" type="text" data-f="text" maxlength="${S.LIMITS.question}" placeholder="질문을 적으세요" aria-label="질문" value="${esc(q.text)}" />
        ${q.type === 'single' || q.type === 'multi' ? `<textarea class="th-input" data-f="options" rows="3" aria-label="보기" placeholder="보기를 한 줄에 하나씩 적으세요&#10;예) 5월 10일(금)&#10;5월 17일(금)">${esc(q.options)}</textarea>` : ''}
        <label class="th-check"><input type="checkbox" data-f="required"${q.required ? ' checked' : ''} /> 꼭 답해야 함</label>
      </div>`
      )
      .join('')
    $('bAdd').disabled = bq.length >= S.LIMITS.questions
  }
  function openBuilder() {
    bq = [blankQuestion()]
    $('builderForm').reset()
    $('bResults').value = 'answered'
    $('bError').textContent = ''
    $('bMembers').classList.add('hidden')
    $('bMembers').innerHTML = members
      .filter((m) => m.id !== me.id)
      .map((m) => `<label class="th-check"><input type="checkbox" value="${esc(m.id)}" /> ${esc(m.name)} <small>${esc(m.deptName || '')}</small></label>`)
      .join('') || '<p class="th-hint">다른 팀원이 없습니다.</p>'
    renderBuilder()
    $('builder').showModal()
    $('bTitle').focus()
  }
  async function createSurvey() {
    const fail = (m) => void ($('bError').textContent = m)
    const title = $('bTitle').value.trim()
    if (!title) return fail('설문 제목을 적으세요.')
    const when = $('bDeadline').value ? new Date($('bDeadline').value).getTime() : null
    if (when !== null && !(when > Date.now())) return fail('마감 일시는 지금보다 뒤여야 합니다.')
    const made = S.cleanSurvey({ desc: $('bDesc').value, questions: bq, anonymous: $('bAnon').checked, results: $('bResults').value, deadline: when })
    if (made.error) return fail(made.error)
    const toTeam = document.querySelector('input[name=bScope]:checked').value === 'team'
    const ids = [...$('bMembers').querySelectorAll('input:checked')].map((i) => i.value)
    if (!toTeam && !ids.length) return fail('받는 사람을 한 명 이상 고르세요.')
    try {
      const r = await call('rooms.create', { title, scope: { type: toTeam ? 'team' : 'members', groupIds: [], memberIds: toTeam ? [] : ids }, shared: made.survey })
      put(r)
      $('builder').close()
      toast('설문을 시작했습니다.')
      tab = 'open'
      openSurvey(r.id)
    } catch (e) {
      fail(e.message || '만들지 못했습니다.')
    }
  }

  // ---------- events ----------
  function onMainInput(e) {
    const el = e.target
    const q = el.dataset && el.dataset.q
    if (!q) return
    const r = room()
    const question = r && r.shared.questions.find((x) => x.id === q)
    if (!question) return
    if (el.dataset.text) draft[q] = el.value
    else if (el.type === 'radio') draft[q] = question.options[Number(el.dataset.k)]
    else if (el.type === 'checkbox') {
      const o = question.options[Number(el.dataset.k)]
      const list = Array.isArray(draft[q]) ? draft[q].filter((x) => x !== o) : []
      if (el.checked) list.push(o)
      draft[q] = list
    }
  }
  function onMainClick(e) {
    const card = e.target.closest('[data-open]')
    if (card) return openSurvey(card.dataset.open)
    const star = e.target.closest('[data-star]')
    if (star) {
      const n = Number(star.dataset.star)
      draft[star.dataset.q] = draft[star.dataset.q] === n ? undefined : n
      star.parentElement.querySelectorAll('[data-star]').forEach((b) => {
        const on = draft[star.dataset.q] >= Number(b.dataset.star)
        b.classList.toggle('on', !!on)
        b.setAttribute('aria-checked', String(draft[star.dataset.q] === Number(b.dataset.star)))
      })
      return
    }
    const b = e.target.closest('[data-act]')
    if (b) void act(b.dataset.act)
  }

  // an older TeamHub does not give extension frames its look (__ui.css): say so

  async function init() {
    $('bResults').innerHTML = Object.keys(S.RESULTS).map((k) => `<option value="${k}">${esc(S.RESULTS[k])}</option>`).join('')
    document.querySelector('nav').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]')
      if (!b || !me) return
      tab = b.dataset.tab
      current = null
      render()
    })
    $('main').addEventListener('click', onMainClick)
    $('main').addEventListener('input', onMainInput)
    $('main').addEventListener('submit', (e) => {
      e.preventDefault()
      void submitAnswers()
    })
    $('newBtn').addEventListener('click', () => me && openBuilder())
    $('bCancel').addEventListener('click', () => $('builder').close())
    $('bAdd').addEventListener('click', () => {
      bq.push(blankQuestion())
      renderBuilder()
    })
    $('bQuestions').addEventListener('input', (e) => {
      const box = e.target.closest('.bq')
      const f = e.target.dataset.f
      if (!box || !f) return
      const q = bq[Number(box.dataset.i)]
      q[f] = f === 'required' ? e.target.checked : e.target.value
      if (f === 'type') renderBuilder()
    })
    $('bQuestions').addEventListener('click', (e) => {
      const b = e.target.closest('[data-b]')
      if (!b) return
      const i = Number(b.closest('.bq').dataset.i)
      if (b.dataset.b === 'del') bq.splice(i, 1)
      else {
        const j = b.dataset.b === 'up' ? i - 1 : i + 1
        ;[bq[i], bq[j]] = [bq[j], bq[i]]
      }
      renderBuilder()
    })
    document.querySelectorAll('input[name=bScope]').forEach((el) => el.addEventListener('change', () => $('bMembers').classList.toggle('hidden', el.value !== 'members' || !el.checked)))
    $('builderForm').addEventListener('submit', (e) => {
      e.preventDefault()
      void createSurvey()
    })

    try {
      me = await call('me')
      if (!me) throw new Error('서버에 연결된 뒤에 쓸 수 있습니다.')
      members = await call('members').catch(() => [])
      await load()
      // opened from an invitation: go straight to that survey
      if (window.TeamHub.room && rooms.some((r) => r.id === window.TeamHub.room)) openSurvey(window.TeamHub.room)
      else render()
    } catch (e) {
      $('main').innerHTML = empty(icon('wifi-off'), '설문을 불러오지 못했습니다', e.message || '서버 연결을 확인하세요.', `<button id="retry" class="th-btn">${icon('refresh-cw')} 다시 시도</button>`)
      $('retry').addEventListener('click', () => location.reload())
    }

    window.TeamHub.on('room.changed', async ({ roomId, deleted }) => {
      if (!me) return
      try {
        if (deleted) {
          rooms = rooms.filter((r) => r.id !== roomId)
          if (current === roomId) {
            current = null
            toast('설문이 삭제되었습니다.')
          }
        } else {
          const r = await call('rooms.get', { roomId })
          if (S.isSurvey(r.shared)) put(r)
        }
        // do not redraw over answers being typed; counts refresh after sending
        const r = room()
        if (current && r && S.isOpen(r) && (!answered(r) || editingAnswers)) return
        render()
      } catch {
        /* keep showing what we have */
      }
    })
    // a deadline passing while the screen is open
    setInterval(() => {
      if (me && !current) renderList()
    }, 60000)
  }

  void init()
})()
