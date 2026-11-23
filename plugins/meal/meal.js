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
  const LIMITS = { notice: 300, aheadMax: 14, keepDays: 100, proxyKeepDays: 62, clerksMax: 30 }
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
      // public holidays are not served (the list comes from TeamHub: 관리 → 공휴일)
      holidays: c.holidays === undefined ? true : !!c.holidays,
      // members who may request for somebody else, besides the admin who made the settings
      clerks: Array.from(new Set((Array.isArray(c.clerks) ? c.clerks : []).filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 40))).slice(0, LIMITS.clerksMax),
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

  /** The settings plus the holiday list ([{ date, name }]) of this moment; not stored. */
  function withHolidays(config, list) {
    const off = {}
    for (const h of list || []) if (h && isYmd(h.date)) off[h.date] = String(h.name || '공휴일')
    return Object.assign({}, config, { off })
  }
  const holidayName = (config, date) => (config.holidays && config.off && config.off[date]) || ''
  const isServed = (config, date) => (config.weekend || ![0, 6].includes(new Date(dayStart(date)).getDay())) && !holidayName(config, date)
  /** Holidays inside the request window: shown so nobody wonders why a day is missing. */
  function skipped(config, now) {
    const out = []
    const today = ymd(now)
    for (let i = 0; i < config.ahead; i++) {
      const date = addDays(today, i)
      if (holidayName(config, date)) out.push({ date, name: holidayName(config, date) })
    }
    return out
  }
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
  function cleanDays(src) {
    const days = {}
    if (!src || typeof src !== 'object') return days
    for (const date of Object.keys(src)) {
      if (!isYmd(date)) continue
      const day = {}
      for (const k of MEAL_KEYS) {
        const r = src[date] && src[date][k]
        if (r && typeof r === 'object') day[k] = { on: !!r.on, at: Number(r.at) || 0 }
      }
      if (Object.keys(day).length) days[date] = day
    }
    return days
  }
  /** `for` holds what this member requested for others: { memberId: { name, days } }. */
  function cleanEntry(value) {
    const v = value && typeof value === 'object' ? value : {}
    const out = { v: 1, days: cleanDays(v.days) }
    if (v.for && typeof v.for === 'object') {
      const others = {}
      for (const id of Object.keys(v.for)) {
        const days = cleanDays(v.for[id] && v.for[id].days)
        if (id.length <= 40 && Object.keys(days).length) others[id] = { name: String((v.for[id] && v.for[id].name) || '').slice(0, 60), days }
      }
      if (Object.keys(others).length) out.for = others
    }
    return out
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
  function refusal(config, date, meal, now) {
    if (!isYmd(date) || !MEALS[meal]) return '잘못된 신청입니다.'
    const st = stateOf(config, date, meal, now)
    if (st === 'off') return holidayName(config, date) ? `공휴일(${holidayName(config, date)})이라 신청을 받지 않습니다.` : `${MEALS[meal]} 신청을 받지 않는 날입니다.`
    if (st === 'closed') return `${MEALS[meal]} 신청이 ${config.meals[meal].cutoff}에 마감되었습니다. 바꿀 수 없습니다.`
    if (!upcoming(config, now).includes(date)) return '아직 신청을 받지 않는 날짜입니다.'
    return ''
  }
  /** Drops old days so the entry stays small (requests made for others are kept for a shorter time). */
  function prune(entry, now) {
    const oldest = ymd(now - LIMITS.keepDays * DAY)
    for (const d of Object.keys(entry.days)) if (d < oldest) delete entry.days[d]
    const oldestFor = ymd(now - LIMITS.proxyKeepDays * DAY)
    for (const id of Object.keys(entry.for || {})) {
      for (const d of Object.keys(entry.for[id].days)) if (d < oldestFor) delete entry.for[id].days[d]
      if (!Object.keys(entry.for[id].days).length) delete entry.for[id]
    }
    if (entry.for && !Object.keys(entry.for).length) delete entry.for
    return entry
  }
  function apply(value, config, date, meal, on, now) {
    const error = refusal(config, date, meal, now)
    if (error) return { error }
    const entry = prune(cleanEntry(value), now)
    entry.days[date] = Object.assign({}, entry.days[date], { [meal]: { on: !!on, at: now } })
    return { entry }
  }

  /** Who may request for somebody else: the admin who made the settings and the clerks they chose. */
  const canProxy = (room, id) => !!room && !!id && (room.createdBy === id || cleanConfig(room.shared).clerks.includes(id))
  /**
   * Request or cancel for another member (target = { id, name }), under the same deadline.
   * It is written into the entry of the one who does it (`value`); the newest of the member's
   * own request and the ones made for them counts, so the member can still change it.
   */
  function applyFor(value, config, target, date, meal, on, now) {
    if (!target || typeof target.id !== 'string' || !target.id) return { error: '대신 신청할 사람을 고르세요.' }
    const error = refusal(config, date, meal, now)
    if (error) return { error }
    const entry = prune(cleanEntry(value), now)
    const others = entry.for || (entry.for = {})
    const t = others[target.id] || (others[target.id] = { name: '', days: {} })
    t.name = String(target.name || t.name || '').slice(0, 60)
    t.days[date] = Object.assign({}, t.days[date], { [meal]: { on: !!on, at: now } })
    return { entry }
  }

  const byDeptName = (a, b) => (a.deptName || '').localeCompare(b.deptName || '', 'ko') || a.name.localeCompare(b.name, 'ko')
  /**
   * Every member with a request, own or made for them: Map id → { id, name, deptName, days }
   * where days[date][meal] = { on, at, by, byName } (by = who requested it for them, '' = themselves).
   * The newest record counts; at the same moment the member's own.
   */
  function resolve(room, members) {
    const entries = (room && room.entries) || {}
    const info = new Map((members || []).map((m) => [m.id, m]))
    const out = new Map()
    const person = (id, name) => {
      let p = out.get(id)
      if (!p) {
        const m = info.get(id)
        p = { id, name: name || (m && m.name) || '(이름 없음)', deptName: (m && m.deptName) || '', days: {} }
        out.set(id, p)
      }
      return p
    }
    const put = (p, days, by, byName) => {
      for (const date of Object.keys(days)) {
        for (const k of Object.keys(days[date])) {
          const r = days[date][k]
          const cur = p.days[date] && p.days[date][k]
          if (cur && (r.at < cur.at || (r.at === cur.at && by))) continue
          p.days[date] = Object.assign({}, p.days[date], { [k]: { on: r.on, at: r.at, by, byName } })
        }
      }
    }
    const clean = {}
    for (const id of Object.keys(entries)) {
      clean[id] = cleanEntry(entries[id].value)
      put(person(id, entries[id].name), clean[id].days, '', '')
    }
    for (const id of Object.keys(entries)) {
      if (!clean[id].for || !canProxy(room, id)) continue
      for (const tid of Object.keys(clean[id].for)) {
        if (tid === id) continue
        const m = info.get(tid)
        put(person(tid, (m && m.name) || clean[id].for[tid].name), clean[id].for[tid].days, id, entries[id].name || '')
      }
    }
    return out
  }
  /** The record that counts for one member: { on, at, by, byName } or null. */
  function recordOf(room, members, id, date, meal) {
    const p = resolve(room, members).get(id)
    return (p && p.days[date] && p.days[date][meal]) || null
  }
  /** Who asked for that meal on that day. */
  function dayList(room, date, meal, members) {
    const out = []
    for (const p of resolve(room, members).values()) {
      const r = p.days[date] && p.days[date][meal]
      if (r && r.on) out.push({ id: p.id, name: p.name, deptName: p.deptName, at: r.at, by: r.by, byName: r.byName })
    }
    return out.sort(byDeptName)
  }
  /** Meals per person in a month ('YYYY-MM'). Only days whose deadline has passed count, unless `all`. */
  function monthTally(room, month, members, now, all) {
    const config = cleanConfig(room && room.shared)
    const rows = []
    for (const p of resolve(room, members).values()) {
      const row = { id: p.id, name: p.name, deptName: p.deptName, lunch: 0, dinner: 0 }
      for (const date of Object.keys(p.days)) {
        if (!date.startsWith(month + '-')) continue
        for (const k of MEAL_KEYS) if (p.days[date][k] && p.days[date][k].on && (all || now >= cutoffAt(config, date, k))) row[k]++
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

  g.Meal = { MEALS, MEAL_KEYS, LIMITS, ymd, addDays, dateLabel, cleanConfig, isConfig, pickRoom, withHolidays, holidayName, skipped, isServed, cutoffAt, stateOf, upcoming, remaining, cleanEntry, wants, requestedAt, apply, canProxy, applyFor, resolve, recordOf, dayList, monthTally, orderText, monthCsv }
})(typeof window !== 'undefined' ? window : globalThis)
