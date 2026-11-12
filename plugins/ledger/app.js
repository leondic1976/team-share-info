/* 스마트 대장 UI. Talks to TeamHub only via TeamHub.call (see __sdk.js). Logic lives in formula.js / sheet.js. */
;(function () {
  'use strict'
  const F = window.LedgerFormula
  const S = window.LedgerSheet
  const call = (m, p) => window.TeamHub.call(m, p)
  const $ = (id) => document.getElementById(id)
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
  const TYPE_ICON = { text: 'Aa', number: '123', date: '날짜', select: '목록', check: '☑', member: '팀원', calc: 'fx' }
  const FORMAT = 'teamhub-ledger@1'
  const MAX_BYTES = 500 * 1024

  // ---------- state ----------
  let index = [] // [{ id, name, updatedAt, rows, icon }]
  let book = null
  let comp = null
  let view = [] // visible book row indices
  let sel = { r: 0, c: 0, r2: 0, c2: 0 } // r = position in view, c = column index
  let editing = null // { mode: 'enter' | 'edit', via: 'cell' | 'fx' }
  let undoStack = []
  let redoStack = []
  let filters = {}
  let query = ''
  let members = []
  let me = null
  let saveTimer = null
  let viewing = null // shared room shown read-only

  const grid = $('grid')
  const wrap = $('gridWrap')
  const editor = $('editor')
  const fx = $('fx')

  // ---------- helpers ----------
  function toast(text, bad) {
    const t = $('toast')
    t.textContent = text
    t.className = 'toast' + (bad ? ' bad' : '')
    t.hidden = false
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => (t.hidden = true), bad ? 5000 : 2500)
  }
  const bytes = (s) => new TextEncoder().encode(s).length
  const curRow = () => view[sel.r]
  const rect = () => ({ r1: Math.min(sel.r, sel.r2), r2: Math.max(sel.r, sel.r2), c1: Math.min(sel.c, sel.c2), c2: Math.max(sel.c, sel.c2) })
  const addrOf = (vr, c) => (view[vr] === undefined ? F.colLetters(c) : F.colLetters(c) + (view[vr] + 1))
  const fmtDate = (t) => {
    const d = new Date(t)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  function uniqueColName(base) {
    const taken = new Set(book.cols.map((c) => c.name.toLowerCase()))
    let n = base
    for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${base} ${i}`
    return n
  }

  // ---------- storage ----------
  async function loadIndex() {
    index = (await call('storage.get', { key: 'index' }).catch(() => null)) || []
    renderBooks()
  }
  async function saveIndex() {
    await call('storage.set', { key: 'index', value: index })
  }
  function scheduleSave() {
    $('saveState').textContent = '저장 중…'
    clearTimeout(saveTimer)
    saveTimer = setTimeout(flush, 300)
  }
  async function flush() {
    clearTimeout(saveTimer)
    saveTimer = null
    if (!book) return
    const b = book
    b.updatedAt = Date.now()
    const json = JSON.stringify(b)
    if (json.length > MAX_BYTES) {
      $('saveState').textContent = '저장 실패: 대장이 너무 큽니다'
      toast('대장이 너무 커서 저장하지 못했습니다(약 500KB). 오래된 행을 다른 대장으로 옮기거나 나눠 주세요.', true)
      return
    }
    try {
      await call('storage.set', { key: `book:${b.id}`, value: b })
      const e = index.find((x) => x.id === b.id)
      const entry = { id: b.id, name: b.name, updatedAt: b.updatedAt, rows: b.rows.length, icon: (S.TEMPLATES.find((t) => t.key === b.template) || {}).icon || '📄' }
      if (e) Object.assign(e, entry)
      else index.unshift(entry)
      await saveIndex()
      if (book === b) $('saveState').textContent = `저장됨 · ${(json.length / 1024).toFixed(0)}KB`
      renderBooks()
    } catch (err) {
      $('saveState').textContent = '저장 실패'
      toast(`저장하지 못했습니다: ${err.message}`, true)
    }
  }

  // ---------- book list ----------
  function renderBooks() {
    const q = $('bookSearch').value.trim().toLowerCase()
    const list = index
      .filter((b) => !q || b.name.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((b) => `<li data-id="${esc(b.id)}" class="${book && book.id === b.id ? 'on' : ''}" title="${esc(b.name)}"><span class="n">${esc(b.icon || '📄')} ${esc(b.name)}</span><span class="m">${b.rows}행 · ${fmtDate(b.updatedAt)}</span></li>`)
    $('books').innerHTML = list.join('') || '<li class="muted small">대장이 없습니다</li>'
  }
  $('books').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]')
    if (li) openBook(li.dataset.id)
  })
  $('bookSearch').addEventListener('input', renderBooks)

  async function openBook(id) {
    if (saveTimer) await flush()
    const b = await call('storage.get', { key: `book:${id}` }).catch(() => null)
    if (!b) return toast('대장을 열지 못했습니다.', true)
    show(b)
  }
  function show(b) {
    book = b
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
    $('bookName').value = b.name
    $('note').value = b.note || ''
    $('note').hidden = !b.note
    $('saveState').textContent = ''
    recompute()
    render()
    renderBooks()
    focusGrid()
  }
  async function addBook(b) {
    book = b
    await flush()
    show(b)
  }

  // ---------- compute & render ----------
  function recompute() {
    comp = S.compute(book)
    view = S.filterRows(book, comp.values, query, filters)
    sel.r = Math.min(sel.r, Math.max(0, view.length - 1))
    sel.r2 = Math.min(sel.r2, Math.max(0, view.length - 1))
    sel.c = Math.min(sel.c, book.cols.length - 1)
    sel.c2 = Math.min(sel.c2, book.cols.length - 1)
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
    return `<td data-v="${vi}" data-c="${c}"${cls.length ? ` class="${cls.join(' ')}"` : ''}${text.length > 12 ? ` title="${esc(text)}"` : ''}>${esc(text)}</td>`
  }

  function render() {
    const cols = book.cols
    let h = '<colgroup><col style="width:52px">' + cols.map((c) => `<col style="width:${c.width || 120}px">`).join('') + '</colgroup><thead><tr><th class="rn">No.</th>'
    cols.forEach((c, i) => {
      h += `<th data-c="${i}"><div class="hc${filters[i] ? ' filtered' : ''}" data-h="${i}"><span class="l">${F.colLetters(i)}<span class="ty">${TYPE_ICON[c.type] || ''}</span></span><span class="t" title="${esc(c.name)}${c.type === 'calc' ? ' · ' + esc(c.calc || '') : ''}">${esc(c.name)}</span><button class="menuBtn" data-menu="${i}" tabindex="-1" aria-label="${esc(c.name)} 열 메뉴">▾</button><span class="rz" data-rz="${i}"></span></div></th>`
    })
    h += '</tr></thead><tbody>'
    const parts = []
    for (let vi = 0; vi < view.length; vi++) {
      const r = view[vi]
      let row = `<tr data-v="${vi}"><td class="rn" data-rn="${vi}">${r + 1}</td>`
      for (let c = 0; c < cols.length; c++) row += cellHtml(vi, r, c)
      parts.push(row + '</tr>')
    }
    h += parts.join('') + '</tbody>'
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
    painted = []
    paint()
    status()
  }

  let painted = []
  function tdAt(vi, c) {
    const tr = grid.tBodies[0] && grid.tBodies[0].rows[vi]
    return tr ? tr.cells[c + 1] : null
  }
  function paint() {
    for (const td of painted) td.classList.remove('in', 'cur')
    painted = []
    if (!view.length || !book.cols.length) return placeEditor()
    const { r1, r2, c1, c2 } = rect()
    const many = r1 !== r2 || c1 !== c2
    if (many && (r2 - r1 + 1) * (c2 - c1 + 1) <= 20000)
      for (let r = r1; r <= r2; r++)
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
    $('stat').textContent = `${filtered ? `${view.length}행 보임 / ` : ''}${book.rows.length}행 · ${book.cols.length}열`
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
    $('selInfo').textContent = n ? `합계 ${S.display(sum, {})} · 평균 ${S.display(Math.round((sum / n) * 100) / 100, {})} · 개수 ${cnt}` : `개수 ${cnt}`
  }

  function scrollToCell() {
    const td = tdAt(sel.r, sel.c)
    if (!td) return
    const head = grid.tHead ? grid.tHead.offsetHeight : 0
    const foot = grid.tFoot ? grid.tFoot.offsetHeight : 0
    const left = 52
    if (td.offsetTop - head < wrap.scrollTop) wrap.scrollTop = td.offsetTop - head
    else if (td.offsetTop + td.offsetHeight > wrap.scrollTop + wrap.clientHeight - foot) wrap.scrollTop = td.offsetTop + td.offsetHeight - wrap.clientHeight + foot
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
  function change(fn) {
    undoStack.push(JSON.stringify(book))
    if (undoStack.length > 80) undoStack.shift()
    redoStack = []
    fn(book)
    recompute()
    render()
    scheduleSave()
  }
  function undo(dir) {
    const from = dir > 0 ? redoStack : undoStack
    const to = dir > 0 ? undoStack : redoStack
    if (!from.length) return
    to.push(JSON.stringify(book))
    book = JSON.parse(from.pop())
    $('bookName').value = book.name
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
    paint()
    const keep = { r: sel.r, c: sel.c }
    if (extend) {
      sel.r = sel.r2
      sel.c = sel.c2
      scrollToCell()
      sel.r = keep.r
      sel.c = keep.c
    } else scrollToCell()
    placeEditor()
  }
  function setCell(r, c, text) {
    const col = book.cols[c]
    if (col.type === 'calc') {
      const f = String(text).trim()
      col.calc = f === '' ? '' : f.startsWith('=') ? f : `=${f}`
      return
    }
    const v = S.parseInput(col, text)
    if (v === '') delete book.rows[r].c[col.id]
    else book.rows[r].c[col.id] = v
  }

  // ---------- editing ----------
  function startEdit(mode, via, initial) {
    if (!view.length || !book.cols.length) return
    const col = book.cols[sel.c]
    if (col.type === 'check' && via === 'cell') {
      editor.value = ''
      toggleChecks()
      return
    }
    editing = { mode, via }
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
    editing = null
    editor.removeAttribute('list')
    if (r === undefined) return
    const col = book.cols[c]
    if (S.editText(col, book.rows[r].c[col.id]) === text) return paint()
    change(() => setCell(r, c, text))
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
      move(k === 'PageDown' ? 15 : -15, 0, e.shiftKey)
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
    } else if (ctrl && k === ';') {
      e.preventDefault()
      if (curRow() !== undefined) change(() => setCell(curRow(), sel.c, F.serialToDate(F.todaySerial())))
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
    change((b) => {
      for (const c of cols) for (let r = r1; r <= r2; r++) b.rows[view[r]].c[b.cols[c].id] = !allOn
    })
  }
  function clearSelection() {
    const { r1, r2, c1, c2 } = rect()
    change((b) => {
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (b.cols[c].type !== 'calc') delete b.rows[view[r]].c[b.cols[c].id]
    })
  }

  // formula bar
  fx.addEventListener('focus', () => {
    if (curRow() !== undefined) editing = { mode: 'edit', via: 'fx' }
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
    el.innerHTML = items.map((it, i) => (it === '-' ? '<hr />' : `<button data-i="${i}"${it.danger ? ' class="danger"' : ''}>${esc(it.label)}</button>`)).join('')
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
        { label: n > 1 ? `고른 ${n}행 복제` : '행 복제', run: () => duplicateRows() },
        '-',
        { label: '복사 (Ctrl+C)', run: () => call('clipboard.write', { text: selectionText() }).then(() => toast('복사했습니다.')) },
        { label: '칸 지우기 (Delete)', run: clearSelection },
        '-',
        { label: n > 1 ? `고른 ${n}행 삭제` : '행 삭제', danger: true, run: deleteRows }
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
  function insertRows(at, n) {
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
    const last = rows[rows.length - 1]
    change((b) => b.rows.splice(last + 1, 0, ...rows.map((r) => ({ id: S.uid('r'), c: JSON.parse(JSON.stringify(b.rows[r].c)) }))))
  }
  function deleteRows() {
    const { r1, r2 } = rect()
    const rows = new Set(view.slice(r1, r2 + 1))
    if (rows.size > 1 && !confirm(`${rows.size}행을 삭제할까요? (실행 취소로 되돌릴 수 있습니다)`)) return
    change((b) => (b.rows = b.rows.filter((_, i) => !rows.has(i))))
    sel = { r: r1, c: sel.c, r2: r1, c2: sel.c }
    paint()
  }
  function insertCol(at) {
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
    const msg = `“${col.name}” 열을 삭제할까요?${filled ? `\n값이 들어 있는 칸 ${filled}개도 함께 지워집니다.` : ''}${users.length ? `\n이 열을 쓰는 계산 열(${users.join(', ')})은 #REF!가 됩니다.` : ''}\n(실행 취소로 되돌릴 수 있습니다)`
    if (!confirm(msg)) return
    change((b) => {
      b.cols.splice(c, 1)
      for (const r of b.rows) delete r.c[col.id]
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
    const vals = [...counts.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'ko', { numeric: true })))
    const cur = filters[c] ? filters[c].values : null
    const el = $('filterPop')
    el.innerHTML = `<b>${esc(col.name)} 거르기</b><input type="search" placeholder="값 찾기" class="fq" /><div class="btnrow"><button class="ghost all">모두</button><button class="ghost none">모두 해제</button></div><div class="vals">${vals
      .map((v, i) => `<label><input type="checkbox" data-i="${i}"${!cur || cur.has(v) ? ' checked' : ''} /> ${v === '' ? '<i class="muted">(빈 칸)</i>' : esc(v)} <span class="muted small">${counts.get(v)}</span></label>`)
      .join('')}</div><div class="btnrow"><button class="ghost clear">이 열 필터 해제</button><span class="spacer"></span><button class="primary ok">적용</button></div>`
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
      if (on.length === vals.length) delete filters[c]
      else filters[c] = { values: new Set(on.map((b) => vals[+b.dataset.i])) }
      el.hidden = true
      sel = { r: 0, c, r2: 0, c2: c }
      recompute()
      render()
      focusGrid()
    }
  }
  $('search').addEventListener('input', (e) => {
    query = e.target.value
    sel = { r: 0, c: sel.c, r2: 0, c2: sel.c }
    recompute()
    render()
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
    if (Object.keys(filters).length || query) {
      filters = {}
      query = ''
      $('search').value = ''
    }
    change((b) => b.rows.push({ id: S.uid('r'), c: {} }))
    sel = { r: view.length - 1, c: 0, r2: view.length - 1, c2: 0 }
    paint()
    scrollToCell()
    focusGrid()
  }
  $('addCol').onclick = () => insertCol(book.cols.length)

  // ---------- clipboard (events, so no clipboard-read permission is needed) ----------
  function selectionMatrix() {
    const { r1, r2, c1, c2 } = rect()
    const out = []
    for (let r = r1; r <= r2; r++) {
      const line = []
      for (let c = c1; c <= c2; c++) {
        const v = comp.values[view[r]][c]
        const col = book.cols[c]
        if (F.isErr(v)) line.push(v.code)
        else if (typeof v === 'boolean') line.push(col.type === 'check' ? (v ? 'O' : '') : v ? 'TRUE' : 'FALSE')
        else if (typeof v === 'number') line.push(col.type === 'date' || col.format === 'date' ? F.serialToDate(v) : String(Math.round(v * 1e10) / 1e10))
        else line.push(v)
      }
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
    let area = null
    change((b) => (area = S.pasteBlock(b, view[sel.r], sel.c, text)))
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
    const trial = JSON.parse(JSON.stringify(book))
    const c = trial.cols[colEditing]
    c.type = 'calc'
    c.calc = f.startsWith('=') ? f : `=${f}`
    c.name = $('colName').value.trim() || c.name
    c.format = $('colFormat').value
    const res = S.compute(trial)
    const v = res.values.length ? res.values[0][colEditing] : ''
    $('colCalcPreview').textContent = res.values.length ? `첫 행 결과: ${S.display(v, c) || '(빈 값)'}` : ''
    $('colCalcPreview').className = 'small ' + (F.isErr(v) ? 'warn' : 'muted')
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
      if (bc.name !== name) S.renameColumn(b, bc.id, name)
      if (type !== bc.type && type !== 'calc') for (const r of b.rows) if (r.c[bc.id] !== undefined) r.c[bc.id] = S.parseInput({ type }, S.editText(bc, r.c[bc.id]))
      bc.type = type
      bc.options = type === 'select' ? [...new Set($('colOptions').value.split('\n').map((s) => s.trim()).filter(Boolean))] : undefined
      bc.calc = type === 'calc' ? (calc ? (calc.startsWith('=') ? calc : `=${calc}`) : '') : undefined
      bc.format = $('colFormat').value
      bc.total = $('colTotal').value
      bc.width = Math.max(40, Math.min(600, +$('colWidth').value || 120))
    })
    focusGrid()
  })

  // ---------- book actions ----------
  $('bookName').addEventListener('change', (e) => {
    const n = e.target.value.trim() || '이름 없는 대장'
    e.target.value = n
    change((b) => (b.name = n))
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
      if (act === 'csv') {
        const r = await call('file.save', { name: `${book.name}.csv`, text: S.toCSV(book, comp.values, view) })
        if (r && r.ok) toast(`저장했습니다: ${r.path}`)
        else if (r && r.error) toast(r.error, true)
      } else if (act === 'copyAll') {
        const head = book.cols.map((c) => c.name)
        const keep = sel
        sel = { r: 0, c: 0, r2: view.length - 1, c2: book.cols.length - 1 }
        const text = S.toDelimited([head, ...(view.length ? selectionMatrix() : [])], '\t')
        sel = keep
        await call('clipboard.write', { text })
        toast(`표 전체(${view.length}행)를 복사했습니다. 엑셀에 붙여 넣으세요.`)
      } else if (act === 'json') {
        const r = await call('file.save', { name: `${book.name}.json`, text: JSON.stringify({ format: FORMAT, book }, null, 1) })
        if (r && r.ok) toast(`저장했습니다: ${r.path}`)
        else if (r && r.error) toast(r.error, true)
      } else if (act === 'print') {
        $('printTitle').textContent = book.name
        window.print()
      } else if (act === 'share') openShare()
      else if (act === 'dup') {
        await flush()
        const copy = JSON.parse(JSON.stringify(book))
        copy.id = S.uid('b')
        copy.name = `${book.name} (사본)`
        delete copy.share
        await addBook(copy)
        toast('복제했습니다.')
      } else if (act === 'note') {
        $('note').hidden = false
        $('note').focus()
      } else if (act === 'delete') {
        if (!confirm(`“${book.name}” 대장을 삭제할까요?\n이 PC에서 지워지며 되돌릴 수 없습니다. 필요하면 먼저 "대장 파일로 저장"으로 백업하세요.`)) return
        const id = book.id
        clearTimeout(saveTimer)
        saveTimer = null
        await call('storage.set', { key: `book:${id}`, value: null })
        index = index.filter((x) => x.id !== id)
        await saveIndex()
        book = null
        $('sheet').hidden = true
        $('empty').hidden = false
        renderBooks()
      }
    } catch (err) {
      toast(err.message, true)
    }
  })

  // ---------- new / import ----------
  $('templates').innerHTML = S.TEMPLATES.map((t) => `<button type="button" data-t="${t.key}"><span class="ic">${t.icon}</span><span><b>${esc(t.name)}</b><small>${esc(t.desc)}</small></span></button>`).join('')
  $('newBook').onclick = () => {
    $('newName').value = ''
    $('newDialog').showModal()
    $('newName').focus()
  }
  $('templates').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-t]')
    if (!b) return
    $('newDialog').close()
    await addBook(S.fromTemplate(b.dataset.t, $('newName').value.trim() || undefined))
  })
  $('importCsv').onclick = async () => {
    try {
      const r = await call('file.open', { exts: ['csv', 'tsv', 'txt'] })
      if (!r || !r.ok) return r && r.error && toast(r.error, true)
      const b = S.fromCSV(r.text, r.name.replace(/\.[^.]+$/, ''))
      await addBook(b)
      toast(`${b.rows.length}행 ${b.cols.length}열을 가져왔습니다. 열 머리글의 ▾ → 열 설정에서 종류를 확인하세요.`)
    } catch (err) {
      toast(`가져오지 못했습니다: ${err.message}`, true)
    }
  }
  $('importJson').onclick = async () => {
    try {
      const r = await call('file.open', { exts: ['json'] })
      if (!r || !r.ok) return r && r.error && toast(r.error, true)
      const data = JSON.parse(r.text)
      const b = data && data.format === FORMAT ? data.book : null
      if (!b || !Array.isArray(b.cols) || !Array.isArray(b.rows)) throw new Error('스마트 대장 파일이 아닙니다.')
      b.id = S.uid('b')
      delete b.share
      if (index.some((x) => x.name === b.name)) b.name = `${b.name} (가져옴)`
      await addBook(b)
      toast('대장을 열었습니다.')
    } catch (err) {
      toast(`열지 못했습니다: ${err.message}`, true)
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
    await flush()
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
      .map((m) => `<label><input type="checkbox" value="${esc(m.id)}"${book.share && book.share.memberIds && book.share.memberIds.includes(m.id) ? ' checked' : ''} /> ${esc(m.name)}</label>`)
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
    const shared = snapshot()
    if (bytes(JSON.stringify(shared)) > 63 * 1024) return ($('shareState').textContent = '표가 커서 공유할 수 없습니다(64KB). 찾기·필터로 필요한 행만 보이게 한 뒤 공유하세요(보이는 행만 공유됩니다).')
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
    $('sharedList').innerHTML = '<li class="muted">불러오는 중…</li>'
    $('sharedDialog').showModal()
    try {
      const rooms = ((await call('rooms.list')) || []).filter((r) => r.shared && r.shared.kind === 'ledger')
      $('sharedList').innerHTML =
        rooms
          .map((r) => `<li><span class="grow"><b>${esc(r.title)}</b><br /><span class="muted small">${esc(r.createdByName)} · ${fmtDate(r.updatedAt)} · ${r.shared.rows.length}행${me && r.createdBy === me.id ? ' · 내가 공유' : ''}</span></span><button type="button" data-room="${esc(r.id)}">보기</button></li>`)
          .join('') || '<li class="muted">공유받은 대장이 없습니다.</li>'
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
      if (!room.shared || room.shared.kind !== 'ledger') return toast('스마트 대장 공유가 아닙니다.', true)
      if (saveTimer) await flush()
      viewing = room
      const s = room.shared
      $('empty').hidden = true
      $('sheet').hidden = true
      $('viewer').hidden = false
      $('viewTitle').textContent = `👀 ${s.name}`
      $('viewMeta').textContent = `${room.createdByName}님이 공유 · ${fmtDate(s.at)} 기준 · 보기 전용`
      let h = '<colgroup><col style="width:52px">' + s.cols.map((c) => `<col style="width:${c.width}px">`).join('') + '</colgroup><thead><tr><th class="rn">No.</th>'
      h += s.cols.map((c) => `<th><div class="hc"><span class="t">${esc(c.name)}</span></div></th>`).join('') + '</tr></thead><tbody>'
      h += s.rows.map((r, i) => `<tr><td class="rn">${i + 1}</td>${r.map((v, j) => `<td${s.cols[j].num ? ' class="num"' : ''}>${esc(v)}</td>`).join('')}</tr>`).join('')
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
    await addBook({ id: S.uid('b'), name: `${s.name} (${viewing.createdByName})`, cols, rows, note: s.note || '' })
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
  $('fnTable').innerHTML = F.FUNCTIONS.map((n) => `<tr><td>${n}</td><td>${esc((FN_HELP[n] || '').replace(/^\S+\(.*?\)\s*/, '') || '')}<br /><span class="muted">${esc((FN_HELP[n] || n).match(/^\S+\(.*?\)/) ? FN_HELP[n].match(/^\S+\(.*?\)/)[0] : n)}</span></td></tr>`).join('')
  $('helpBtn').onclick = () => $('helpDialog').showModal()

  // ---------- start ----------
  wrap.addEventListener('scroll', () => {
    if (editing && editing.via === 'cell') placeEditor()
  })
  window.addEventListener('beforeunload', () => {
    if (saveTimer) void flush()
  })
  ;(async () => {
    me = await call('me').catch(() => null)
    members = (await call('members').catch(() => null)) || []
    await loadIndex()
    if (window.TeamHub.room) openRoom(window.TeamHub.room)
    else if (index.length) openBook([...index].sort((a, b) => b.updatedAt - a.updatedAt)[0].id)
  })()
  window.__ledger = { get book() { return book }, get view() { return view }, get sel() { return sel }, flush }
})()
