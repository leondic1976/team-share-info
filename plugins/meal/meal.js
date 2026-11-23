/* Meal request logic (no DOM). Exposed as globalThis.Meal; unit-tested in tests/plugins.
 *
 * One room for the whole team, made by an admin (the server PC): its shared data holds the
 * settings (which meals, until what time a request may be changed). Every member keeps their
 * own requests, by date, in their own entry of that room. */
;(function (g) {
  'use strict'

  const MEALS = { lunch: '점심', dinner: '저녁' }
  const MEAL_KEYS = ['lunch', 'dinner']
  const DEFAULT_CUTOFF = { lunch: '10:30', dinner: '15:30' }
  const LIMITS = { notice: 300, aheadMax: 14, keepDays: 100 }
  const DAY = 86400000
  const WEEK = ['일', '월', '화', '수', '목', '금', '토']

  const pad = (n) => String(n).padStart(2, '0')
  const ymd = (ms) => {
    const d = new Date(ms)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  /** Local midnight of a date string. */
  const dayStart = (date) => {
    const [y, m, d] = date.split('-').map(Number)
    return new Date(y, m - 1, d).getTime()
  }
  const addDays = (date, n) => {
    const [y, m, d] = date.split('-').map(Number)
    return ymd(new Date(y, m - 1, d + n).getTime())
  }
  const dateLabel = (date, today) => {
    const d = new Date(dayStart(date))
    const base = `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`
    return date === today ? `오늘 ${base}` : date === addDays(today, 1) ? `내일 ${base}` : base
  }
  const cleanTime = (v, fallback) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v).trim())
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return fallback
    return `${pad(Number(m[1]))}:${m[2]}`
  }

  /** Settings as stored in the room's shared data. */
  function cleanConfig(input) {
    const c = input && typeof input === 'object' ? input : {}
    const meals = {}
    for (const k of MEAL_KEYS) {
      const m = (c.meals && c.meals[k]) || {}
      meals[k] = { on: m.on === undefined ? true : !!m.on, cutoff: cleanTime(m.cutoff, DEFAULT_CUTOFF[k]) }
    }
    const ahead = Math.round(Number(c.ahead))
    return {
      kind: 'meal',
      v: 1,
      meals,
      weekend: !!c.weekend,
      // how many days ahead a request may be made (1 = today only)
      ahead: ahead >= 1 && ahead <= LIMITS.aheadMax ? ahead : 7,
      notice: String(c.notice == null ? '' : c.notice).trim().slice(0, LIMITS.notice)
    }
  }
  const isConfig = (shared) => !!shared && shared.kind === 'meal' && !!shared.meals

  /** The settings room: the oldest one, so a second room made by mistake changes nothing. */
  function pickRoom(rooms) {
    return (rooms || []).filter((r) => isConfig(r.shared)).sort((a, b) => a.createdAt - b.createdAt)[0] || null
  }

  const isServed = (config, date) => config.weekend || ![0, 6].includes(new Date(dayStart(date)).getDay())
  /** The moment after which the request for that meal of that day cannot be changed. */
  function cutoffAt(config, date, meal) {
    const [h, m] = config.meals[meal].cutoff.split(':').map(Number)
    return dayStart(date) + h * 3600000 + m * 60000
  }
  /** 'open' (may request, cancel, request again), 'closed' (deadline passed), 'off' (not served). */
  function stateOf(config, date, meal, now) {
    if (!config.meals[meal] || !config.meals[meal].on || !isServed(config, date)) return 'off'
    return now < cutoffAt(config, date, meal) ? 'open' : 'closed'
  }
  /** Days a request can be made for, from today. */
  function upcoming(config, now) {
    const out = []
    const today = ymd(now)
    for (let i = 0; i < config.ahead; i++) {
      const date = addDays(today, i)
      if (isServed(config, date) && MEAL_KEYS.some((k) => config.meals[k].on)) out.push(date)
    }
    return out
  }
  function remaining(ms) {
    if (ms <= 0) return '마감'
    const min = Math.ceil(ms / 60000)
    if (min < 60) return `${min}분 남음`
    if (min < 1440) return `${Math.floor(min / 60)}시간 ${min % 60 ? `${min % 60}분 ` : ''}남음`
    return `${Math.floor(min / 1440)}일 남음`
  }

  /** One member's requests as stored in their entry: { days: { 'YYYY-MM-DD': { lunch: { on, at } } } }. */
  function cleanEntry(value) {
    const days = {}
    const src = value && typeof value === 'object' && value.days && typeof value.days === 'object' ? value.days : {}
    for (const date of Object.keys(src)) {
      if (!isYmd(date)) continue
      const day = {}
      for (const k of MEAL_KEYS) {
        const r = src[date] && src[date][k]
        if (r && typeof r === 'object') day[k] = { on: !!r.on, at: Number(r.at) || 0 }
      }
      if (Object.keys(day).length) days[date] = day
    }
    return { v: 1, days }
  }
  const wants = (value, date, meal) => {
    const d = value && value.days && value.days[date]
    return !!(d && d[meal] && d[meal].on)
  }
  const requestedAt = (value, date, meal) => {
    const d = value && value.days && value.days[date]
    return d && d[meal] ? d[meal].at : 0
  }

  /**
   * Request (on = true) or cancel (on = false) one meal of one day. Until the deadline this
   * can be done any number of times; after it nothing changes. Old days are dropped so the
   * entry stays small. Returns { entry } or { error }.
   */
  function apply(value, config, date, meal, on, now) {
    if (!isYmd(date) || !MEALS[meal]) return { error: '잘못된 신청입니다.' }
    const st = stateOf(config, date, meal, now)
    if (st === 'off') return { error: `${MEALS[meal]} 신청을 받지 않는 날입니다.` }
    if (st === 'closed') return { error: `${MEALS[meal]} 신청이 ${config.meals[meal].cutoff}에 마감되었습니다. 바꿀 수 없습니다.` }
    if (!upcoming(config, now).includes(date)) return { error: '아직 신청을 받지 않는 날짜입니다.' }
    const entry = cleanEntry(value)
    const oldest = ymd(now - LIMITS.keepDays * DAY)
    for (const d of Object.keys(entry.days)) if (d < oldest) delete entry.days[d]
    entry.days[date] = Object.assign({}, entry.days[date], { [meal]: { on: !!on, at: now } })
    return { entry }
  }

  const byDeptName = (a, b) => (a.deptName || '').localeCompare(b.deptName || '', 'ko') || a.name.localeCompare(b.name, 'ko')
  /** Everyone who has an entry, with the department from the member list (kept when they left). */
  function people(room, members) {
    const dept = new Map((members || []).map((m) => [m.id, m.deptName || '']))
    return Object.keys((room && room.entries) || {}).map((id) => ({ id, name: room.entries[id].name, deptName: dept.get(id) || '', value: room.entries[id].value }))
  }
  /** Who asked for that meal on that day. */
  function dayList(room, date, meal, members) {
    return people(room, members)
      .filter((p) => wants(p.value, date, meal))
      .map((p) => ({ id: p.id, name: p.name, deptName: p.deptName, at: requestedAt(p.value, date, meal) }))
      .sort(byDeptName)
  }
  /** Meals per person in a month ('YYYY-MM'). Only days whose deadline has passed count, unless `all`. */
  function monthTally(room, month, members, now, all) {
    const config = cleanConfig(room && room.shared)
    const rows = []
    for (const p of people(room, members)) {
      const row = { id: p.id, name: p.name, deptName: p.deptName, lunch: 0, dinner: 0 }
      const days = (p.value && p.value.days) || {}
      for (const date of Object.keys(days)) {
        if (!date.startsWith(month + '-')) continue
        for (const k of MEAL_KEYS) if (wants(p.value, date, k) && (all || now >= cutoffAt(config, date, k))) row[k]++
      }
      if (row.lunch || row.dinner) rows.push(row)
    }
    rows.sort(byDeptName)
    return { rows, lunch: rows.reduce((s, r) => s + r.lunch, 0), dinner: rows.reduce((s, r) => s + r.dinner, 0) }
  }

  /** Text for ordering: "11/23(월) 점심 3명: 김○○, 이○○, 박○○". */
  function orderText(room, date, members, today) {
    const config = cleanConfig(room && room.shared)
    const lines = []
    for (const k of MEAL_KEYS) {
      if (!config.meals[k].on) continue
      const list = dayList(room, date, k, members)
      lines.push(`${dateLabel(date, today || '')} ${MEALS[k]} ${list.length}명${list.length ? ': ' + list.map((p) => p.name).join(', ') : ''}`)
    }
    return lines.join('\n')
  }
  const csvCell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
  function monthCsv(room, month, members, now) {
    const t = monthTally(room, month, members, now, false)
    const rows = [['부서', '이름', '점심', '저녁', '합계'], ...t.rows.map((r) => [r.deptName, r.name, r.lunch, r.dinner, r.lunch + r.dinner]), ['', '합계', t.lunch, t.dinner, t.lunch + t.dinner]]
    return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
  }

  g.Meal = { MEALS, MEAL_KEYS, LIMITS, ymd, addDays, dateLabel, cleanConfig, isConfig, pickRoom, isServed, cutoffAt, stateOf, upcoming, remaining, cleanEntry, wants, requestedAt, apply, dayList, monthTally, orderText, monthCsv }
})(typeof window !== 'undefined' ? window : globalThis)
