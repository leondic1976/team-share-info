/* Survey logic (no DOM). Exposed as globalThis.Survey; unit-tested in tests/plugins. */
;(function (g) {
  'use strict'

  const TYPES = { single: '하나 고르기', multi: '여러 개 고르기', rating: '별점 (1~5)', text: '주관식' }
  const RESULTS = { always: '누구나 언제든', answered: '응답한 사람만', closed: '마감한 뒤에', creator: '만든 사람만' }
  /** The whole survey must fit in the shared data of a room (64KB on the server). */
  const LIMITS = { title: 100, desc: 500, questions: 30, options: 20, question: 200, option: 100, answer: 1000 }

  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max)
  const newId = () => 'q' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)

  function parseOptions(text) {
    const seen = new Set()
    return String(text || '')
      .split('\n')
      .map((s) => str(s, LIMITS.option))
      .filter((s) => s && !seen.has(s) && seen.add(s))
      .slice(0, LIMITS.options)
  }

  /** Survey as it is stored in the room's shared data. Returns { survey } or { error }. */
  function cleanSurvey(input) {
    const s = input && typeof input === 'object' ? input : {}
    const questions = (Array.isArray(s.questions) ? s.questions : []).slice(0, LIMITS.questions).map((q) => ({
      id: str(q && q.id, 24) || newId(),
      type: q && TYPES[q.type] ? q.type : 'single',
      text: str(q && q.text, LIMITS.question),
      options: q && (q.type === 'single' || q.type === 'multi') ? (Array.isArray(q.options) ? parseOptions(q.options.join('\n')) : parseOptions(q.options)) : [],
      required: !!(q && q.required)
    }))
    if (!questions.length) return { error: '문항을 하나 이상 만드세요.' }
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      if (!q.text) return { error: `${i + 1}번 문항의 질문을 적으세요.` }
      if ((q.type === 'single' || q.type === 'multi') && q.options.length < 2) return { error: `${i + 1}번 문항의 보기를 2개 이상 적으세요(한 줄에 하나).` }
    }
    const deadline = Number(s.deadline)
    return {
      survey: {
        app: 'survey',
        desc: str(s.desc, LIMITS.desc),
        questions,
        anonymous: !!s.anonymous,
        results: RESULTS[s.results] ? s.results : 'answered',
        deadline: Number.isFinite(deadline) && deadline > 0 ? deadline : null
      }
    }
  }

  const isSurvey = (shared) => !!shared && shared.app === 'survey' && Array.isArray(shared.questions)

  /** Closed by the creator, or the deadline has passed. */
  function isOpen(room, now) {
    return !room.closed && !(room.shared.deadline && room.shared.deadline <= (now === undefined ? Date.now() : now))
  }

  /** One member's answers checked against the survey. Returns { answers } or { error }. */
  function cleanAnswers(survey, raw) {
    const a = raw && typeof raw === 'object' ? raw : {}
    const out = {}
    for (let i = 0; i < survey.questions.length; i++) {
      const q = survey.questions[i]
      const v = a[q.id]
      let val
      if (q.type === 'single') val = q.options.includes(v) ? v : null
      else if (q.type === 'multi') {
        const list = q.options.filter((o) => Array.isArray(v) && v.includes(o))
        val = list.length ? list : null
      } else if (q.type === 'rating') {
        const n = Math.round(Number(v))
        val = n >= 1 && n <= 5 ? n : null
      } else val = str(v, LIMITS.answer) || null
      if (val === null && q.required) return { error: `${i + 1}번 문항은 꼭 답해야 합니다.` }
      if (val !== null) out[q.id] = val
    }
    return { answers: out }
  }

  /** entries: { memberId: { name, value: { answers } } } as the room returns them. */
  function responses(room) {
    return Object.keys(room.entries || {})
      .map((id) => ({ id, name: room.entries[id].name, at: room.entries[id].at, answers: cleanAnswers(Object.assign({}, room.shared, { questions: room.shared.questions.map((q) => Object.assign({}, q, { required: false })) }), room.entries[id].value && room.entries[id].value.answers).answers }))
      .sort((a, b) => a.at - b.at)
  }

  /** Per question: counts of each option, the average rating, or the written answers. */
  function tally(room) {
    const list = responses(room)
    return room.shared.questions.map((q) => {
      const given = list.filter((r) => r.answers[q.id] !== undefined)
      const base = { id: q.id, type: q.type, text: q.text, answered: given.length }
      if (q.type === 'single' || q.type === 'multi') {
        const options = q.options.map((o) => {
          const who = given.filter((r) => (q.type === 'single' ? r.answers[q.id] === o : r.answers[q.id].includes(o)))
          return { label: o, count: who.length, percent: given.length ? Math.round((who.length / given.length) * 100) : 0, names: who.map((r) => r.name) }
        })
        return Object.assign(base, { options, top: Math.max(0, ...options.map((o) => o.count)) })
      }
      if (q.type === 'rating') {
        const nums = given.map((r) => r.answers[q.id])
        const counts = [1, 2, 3, 4, 5].map((n) => nums.filter((x) => x === n).length)
        return Object.assign(base, { average: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : 0, counts })
      }
      return Object.assign(base, { texts: given.map((r) => ({ name: r.name, text: r.answers[q.id] })) })
    })
  }

  /** May this member see the results now? */
  function canSeeResults(room, meId, now) {
    if (room.createdBy === meId) return true
    const rule = room.shared.results
    if (rule === 'always') return true
    if (rule === 'creator') return false
    if (rule === 'closed') return !isOpen(room, now)
    return !!(room.entries && room.entries[meId]) || !isOpen(room, now)
  }

  const cell = (v) => {
    const s = String(v == null ? '' : v)
    // a leading = + - @ would run as a formula when the file is opened in a spreadsheet
    const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s
    return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe
  }

  /** One row per response; names are left out of a survey that hides them. */
  function toCsv(room) {
    const s = room.shared
    const head = (s.anonymous ? ['번호'] : ['이름']).concat(['응답 시각'], s.questions.map((q, i) => `${i + 1}. ${q.text}`))
    const rows = responses(room).map((r, i) => {
      const d = new Date(r.at)
      const at = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      return [s.anonymous ? i + 1 : r.name, at].concat(s.questions.map((q) => (Array.isArray(r.answers[q.id]) ? r.answers[q.id].join(' / ') : (r.answers[q.id] ?? ''))))
    })
    return '﻿' + [head].concat(rows).map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
  }

  /** Short text of the results to paste into a chat. */
  function summaryText(room) {
    const lines = [`[설문 결과] ${room.title} (응답 ${Object.keys(room.entries || {}).length}명)`]
    tally(room).forEach((t, i) => {
      lines.push(`${i + 1}. ${t.text}`)
      if (t.options) t.options.forEach((o) => lines.push(`   - ${o.label}: ${o.count}명 (${o.percent}%)`))
      else if (t.type === 'rating') lines.push(`   - 평균 ${t.average}점 (${t.answered}명)`)
      else lines.push(`   - 주관식 ${t.answered}건`)
    })
    return lines.join('\n')
  }

  g.Survey = { TYPES, RESULTS, LIMITS, newId, parseOptions, cleanSurvey, isSurvey, isOpen, cleanAnswers, responses, tally, canSeeResults, toCsv, summaryText }
})(typeof window !== 'undefined' ? window : globalThis)
