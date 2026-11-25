/* OCR UI. The picture is drawn on a canvas here and handed to TeamHub ('ocr.recognize'),
 * which reads it with the recognizer built into Windows on this PC. Nothing is uploaded. */
;(function () {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const T = window.OcrText
  const call = (m, p) => window.TeamHub.call(m, p)
  // an older TeamHub does not give extension frames its look (__ui.css): say so once the page has loaded
  // line icons come from TeamHub (TeamHub.icon); an older TeamHub without them shows the text only
  const icon = (n, o) => (window.TeamHub.icon ? window.TeamHub.icon(n, o) : '')
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const LANG_NAMES = { ko: '한국어', en: '영어', ja: '일본어', zh: '중국어' }

  /** pictures waiting to be read: { img, url, text, done } */
  let images = []
  let current = -1
  /** selected part of the current picture, in picture pixels */
  let sel = null
  let busy = false
  let history = []

  function toast(msg) {
    const t = $('toast')
    t.textContent = msg
    t.classList.add('show')
    clearTimeout(toast.t)
    toast.t = setTimeout(() => t.classList.remove('show'), 2800)
  }
  const status = (s) => ($('status').textContent = s)

  // ---------- pictures ----------
  function addFiles(files) {
    const list = [...files].filter((f) => f && /^image\//.test(f.type)).slice(0, 20)
    if (!list.length) return toast('이미지 파일이 아닙니다.')
    let left = list.length
    const first = images.length
    for (const f of list) {
      const url = URL.createObjectURL(f)
      const img = new Image()
      const item = { img, url, text: '', done: false }
      img.onload = img.onerror = (e) => {
        if (e.type === 'load') images.push(item)
        else URL.revokeObjectURL(url)
        if (--left) return
        if (images.length > first) show(first)
        else toast('이미지를 열지 못했습니다.')
      }
      img.src = url
    }
  }

  function show(i) {
    current = i
    sel = null
    const it = images[i]
    $('drop').classList.toggle('hidden', !!it)
    $('stage').classList.toggle('hidden', !it)
    $('run').disabled = !it || busy
    $('sel').classList.add('hidden')
    if (!it) return
    const c = $('canvas')
    c.width = it.img.naturalWidth
    c.height = it.img.naturalHeight
    c.getContext('2d').drawImage(it.img, 0, 0)
    $('thumbs').innerHTML = images.length > 1 ? images.map((x, k) => `<button type="button" data-i="${k}" aria-current="${k === i}" class="${x.done ? 'done' : ''}" aria-label="${k + 1}번째 이미지"><img src="${x.url}" alt="" /></button>`).join('') : ''
    $('run').textContent = images.length > 1 ? `글자 읽기 (${images.length}장)` : '글자 읽기'
    $('hint').textContent = images.length > 1 ? '여러 장은 차례로 읽어 이어 붙입니다. 한 장만 고르고 끌면 그 부분만 읽습니다.' : '이미지 위를 끌면 그 부분만 읽습니다. 한 번 누르면 선택이 풀립니다.'
  }

  function reset() {
    images.forEach((x) => URL.revokeObjectURL(x.url))
    images = []
    show(-1)
  }

  /** The picture (or the selected part) as a PNG, sized and cleaned up for reading. */
  function prepare(it, part) {
    const src = part || { x: 0, y: 0, w: it.img.naturalWidth, h: it.img.naturalHeight }
    const size = T.targetSize(src.w, src.h, $('enlarge').checked)
    const c = document.createElement('canvas')
    c.width = size.width
    c.height = size.height
    const g = c.getContext('2d')
    // a transparent picture would turn black: text is read on white
    g.fillStyle = '#fff'
    g.fillRect(0, 0, c.width, c.height)
    g.imageSmoothingQuality = 'high'
    if ($('contrast').checked) g.filter = 'grayscale(1) contrast(1.6)'
    g.drawImage(it.img, src.x, src.y, src.w, src.h, 0, 0, c.width, c.height)
    return c.toDataURL('image/png')
  }

  async function run() {
    if (busy || current < 0) return
    busy = true
    $('run').disabled = true
    const lang = $('lang').value || undefined
    // a selection reads only that part of the picture on screen; otherwise every picture in turn
    const jobs = sel ? [{ it: images[current], part: sel }] : images.map((it) => ({ it, part: null }))
    const texts = []
    try {
      for (let k = 0; k < jobs.length; k++) {
        status(jobs.length > 1 ? `읽는 중… ${k + 1} / ${jobs.length}` : '읽는 중…')
        const r = await call('ocr.recognize', { image: prepare(jobs[k].it, jobs[k].part), lang })
        if (!r || !r.ok) throw new Error((r && r.error) || '글자를 읽지 못했습니다.')
        jobs[k].it.done = !jobs[k].part
        jobs[k].it.text = r.text || ''
        if (r.text) texts.push(r.text)
      }
      const text = texts.join('\n\n')
      if (!text) {
        status('글자를 찾지 못했습니다.')
        toast('글자를 찾지 못했습니다. [작은 글자 키우기]나 [흑백 대비 높이기]를 바꿔 다시 해 보세요.')
      } else {
        // keep what was already read when another part is added
        const box = $('text')
        box.value = sel && box.value.trim() ? box.value.replace(/\s+$/, '') + '\n\n' + text : text
        const n = T.count(text)
        status(`${n.lines}줄 · ${n.chars}자를 읽었습니다.`)
        history.unshift({ at: Date.now(), text: text.slice(0, 20000) })
        history = history.slice(0, 20)
        void call('storage.set', { key: 'history', value: history }).catch(() => undefined)
      }
      if (!sel) show(current)
    } catch (e) {
      status('')
      toast(e.message || '글자를 읽지 못했습니다.')
    } finally {
      busy = false
      $('run').disabled = current < 0
    }
  }

  // ---------- selecting a part ----------
  function setupSelection() {
    const c = $('canvas')
    let start = null
    const point = (e) => {
      const r = c.getBoundingClientRect()
      return { x: Math.min(r.width, Math.max(0, e.clientX - r.left)), y: Math.min(r.height, Math.max(0, e.clientY - r.top)), r }
    }
    const draw = (a, b) => {
      const box = $('sel')
      box.classList.remove('hidden')
      box.style.left = c.offsetLeft + Math.min(a.x, b.x) + 'px'
      box.style.top = c.offsetTop + Math.min(a.y, b.y) + 'px'
      box.style.width = Math.abs(a.x - b.x) + 'px'
      box.style.height = Math.abs(a.y - b.y) + 'px'
    }
    c.addEventListener('pointerdown', (e) => {
      if (current < 0) return
      start = point(e)
      c.setPointerCapture(e.pointerId)
      sel = null
      $('sel').classList.add('hidden')
    })
    c.addEventListener('pointermove', (e) => start && draw(start, point(e)))
    c.addEventListener('pointerup', (e) => {
      if (!start) return
      const end = point(e)
      const k = c.width / end.r.width // screen pixels -> picture pixels
      const w = Math.abs(end.x - start.x) * k
      const h = Math.abs(end.y - start.y) * k
      if (w > 12 && h > 12) {
        sel = { x: Math.round(Math.min(start.x, end.x) * k), y: Math.round(Math.min(start.y, end.y) * k), w: Math.round(w), h: Math.round(h) }
        $('run').textContent = '고른 부분 읽기'
      } else {
        sel = null
        $('sel').classList.add('hidden')
        $('run').textContent = images.length > 1 ? `글자 읽기 (${images.length}장)` : '글자 읽기'
      }
      start = null
    })
  }

  // ---------- history ----------
  function renderHistory() {
    $('historyList').innerHTML = history.length
      ? history
          .map((h, i) => {
            const d = new Date(h.at)
            const n = T.count(h.text)
            return `<div class="hist"><div><b>${esc(T.titleOf(h.text))}</b><span class="th-xs th-muted th-nums">${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} · ${n.chars}자</span></div><button type="button" class="th-btn th-btn-outline th-btn-sm" data-use="${i}">불러오기</button><button type="button" class="th-btn th-btn-outline th-btn-sm" data-copy="${i}">${icon('copy')} 복사</button></div>`
          })
          .join('')
      : `<div class="th-empty compact">${icon('scan-text')}<p class="th-empty-title">아직 읽은 글자가 없습니다</p><p>글자를 읽으면 여기에 20개까지 남습니다.</p></div>`
  }

  async function init() {
    setupSelection()
    $('pick').addEventListener('click', () => $('file').click())
    $('drop').addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && $('file').click())
    $('file').addEventListener('change', () => {
      addFiles($('file').files)
      $('file').value = ''
    })
    $('another').addEventListener('click', reset)
    $('run').addEventListener('click', () => void run())
    $('thumbs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]')
      if (b) show(Number(b.dataset.i))
    })
    document.addEventListener('paste', (e) => {
      const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => /^image\//.test(f.type))
      if (!files.length) return // plain text pasted into the result box
      e.preventDefault()
      reset()
      addFiles(files)
    })
    for (const id of ['drop', 'stage']) {
      const el = $(id)
      el.addEventListener('dragover', (e) => {
        e.preventDefault()
        el.classList.add('over')
      })
      el.addEventListener('dragleave', () => el.classList.remove('over'))
      el.addEventListener('drop', (e) => {
        e.preventDefault()
        el.classList.remove('over')
        if (e.dataTransfer && e.dataTransfer.files.length) {
          reset()
          addFiles(e.dataTransfer.files)
        }
      })
    }

    $('copy').addEventListener('click', () => {
      const text = $('text').value
      if (!text.trim()) return toast('복사할 글자가 없습니다.')
      call('clipboard.write', { text }).then(() => toast('복사했습니다. 붙여넣을 곳에서 Ctrl+V를 누르세요.'), (err) => toast(err.message))
    })
    $('save').addEventListener('click', async () => {
      const text = $('text').value
      if (!text.trim()) return toast('저장할 글자가 없습니다.')
      try {
        const r = await call('file.save', { name: `글자읽기_${new Date().toISOString().slice(0, 10)}.txt`, text })
        if (r && r.ok) toast('저장했습니다.')
        else if (r && r.error) toast(r.error)
      } catch (e) {
        toast(e.message)
      }
    })
    $('joinLines').addEventListener('click', () => {
      const box = $('text')
      if (!box.value.trim()) return
      box.value = T.joinLines(box.value)
      toast('줄 끝에서 끊긴 문장을 이었습니다.')
    })
    $('historyBtn').addEventListener('click', () => {
      renderHistory()
      $('history').showModal()
    })
    $('historyClose').addEventListener('click', () => $('history').close())
    $('historyClear').addEventListener('click', () => {
      if (!history.length || !window.confirm('최근 결과를 모두 지울까요?')) return
      history = []
      void call('storage.set', { key: 'history', value: [] })
      renderHistory()
    })
    $('historyList').addEventListener('click', (e) => {
      const use = e.target.closest('[data-use]')
      const cp = e.target.closest('[data-copy]')
      if (use) {
        $('text').value = history[Number(use.dataset.use)].text
        $('history').close()
      } else if (cp) call('clipboard.write', { text: history[Number(cp.dataset.copy)].text }).then(() => toast('복사했습니다.'), (err) => toast(err.message))
    })

    try {
      const h = await call('storage.get', { key: 'history' })
      if (Array.isArray(h)) history = h.filter((x) => x && typeof x.text === 'string')
    } catch {
      /* starts empty */
    }
    // which languages can this PC read?
    try {
      const r = await call('ocr.recognize', { image: '' })
      const langs = (r && r.languages) || []
      $('lang').innerHTML = langs.length ? langs.map((l) => `<option value="${esc(l)}"${r.language === l ? ' selected' : ''}>${esc(LANG_NAMES[l.toLowerCase().split('-')[0]] || l)}</option>`).join('') : '<option value="">자동</option>'
      if (r && !r.ok && r.error) status(r.error)
    } catch (e) {
      $('lang').innerHTML = '<option value="">자동</option>'
      status(e.message || '')
    }
  }

  void init()
})()
