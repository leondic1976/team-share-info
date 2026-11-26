/* Meal request logic (no DOM). Exposed as globalThis.Meal; unit-tested in tests/plugins.
 *
 * One room for the whole team, made by an admin (the owner): its shared data holds the
 * settings (which meals, until what time a request may be changed), who is in charge
 * (식수서무, at most two) and the menus. Every member keeps their own requests, by date, in
 * their own entry of that room.
 *
 * The server lets only the owner write the shared data, so a 식수서무 writes settings and
 * menus into their OWN entry ({ settings, settingsAt, menus }) and every screen merges them
 * with the shared data: the newest wins (settings as a whole, menus per day and slot).
 * Entries of people the owner did not name are ignored for this. See effective(). */
;(function (g) {
  'use strict'

  const MEALS = { lunch: '점심', dinner: '저녁' }
  const MEAL_KEYS = ['lunch', 'dinner']
  const DEFAULT_CUTOFF = { lunch: '10:30', dinner: '15:30' }
  const MENU_SLOTS = ['lunch', 'dinner', 'note']
  const LIMITS = {
    notice: 300,
    aheadMax: 14,
    keepDays: 100,
    proxyKeepDays: 62,
    clerksMax: 30,
    stewardsMax: 2,
    // one menu cell: lines and characters; the note of a day is one line
    menuLines: 8,
    menuText: 200,
    menuNote: 60,
    // menus are kept from this many weeks before the current week to this many after it
    menuWeeksBack: 8,
    menuWeeksAhead: 8,
    // people registered by hand (staff who do not use TeamHub): how many, and the length of each field
    peopleMax: 100,
    personName: 30,
    personDept: 30,
    personTitle: 20,
    personMemo: 60,
    // the server refuses shared data and an entry above 64 KB; stay below it
    stateMax: 60000,
    // 식대 (1.7.0): the price of one meal in 원, and how many price changes are kept
    priceMax: 1000000,
    pricesMax: 60
  }
  const DAY = 86400000
  const NO_DEPT_NAME = '부서 미지정'
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

  const isId = (x) => typeof x === 'string' && x.length > 0 && x.length <= 40

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
      // 식수서무: may change the settings, register menus and request for others (the owner names them)
      stewards: Array.from(new Set((Array.isArray(c.stewards) ? c.stewards : []).filter(isId))).slice(0, LIMITS.stewardsMax),
      // before 1.2.0: members who could request for somebody else (since 1.4.0 everybody can).
      // Offered as 식수서무 until the owner saves the settings again, which drops them.
      clerks: Array.from(new Set((Array.isArray(c.clerks) ? c.clerks : []).filter(isId))).slice(0, LIMITS.clerksMax),
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

  /**
   * One member's requests as stored in their entry: { days: { 'YYYY-MM-DD': { lunch: { on, at, firm? } } } }.
   * `firm` (확실히 신청안함, 1.6.0) is a "no" the member set for themselves: while it stands nobody
   * else's request or cancel for that meal counts (see resolve()). It is kept only in the member's
   * own days (`own`), never in what somebody wrote for others.
   */
  function cleanDays(src, own) {
    const days = {}
    if (!src || typeof src !== 'object') return days
    for (const date of Object.keys(src)) {
      if (!isYmd(date)) continue
      const day = {}
      for (const k of MEAL_KEYS) {
        const r = src[date] && src[date][k]
        if (r && typeof r === 'object') {
          day[k] = { on: !!r.on, at: Number(r.at) || 0 }
          if (own && !r.on && r.firm) day[k].firm = true
        }
      }
      if (Object.keys(day).length) days[date] = day
    }
    return days
  }
  /** `for` holds what this member requested for others: { memberId: { name, days } }. */
  function cleanEntry(value) {
    const v = value && typeof value === 'object' ? value : {}
    const out = { v: 1, days: cleanDays(v.days, true) }
    if (v.for && typeof v.for === 'object') {
      const others = {}
      for (const id of Object.keys(v.for)) {
        const days = cleanDays(v.for[id] && v.for[id].days)
        if (id.length <= 40 && Object.keys(days).length) others[id] = { name: String((v.for[id] && v.for[id].name) || '').slice(0, 60), days }
      }
      if (Object.keys(others).length) out.for = others
    }
    // what a 식수서무 decided (counts only while the owner names them, see effective())
    if (v.settings && typeof v.settings === 'object' && Number(v.settingsAt) > 0) {
      out.settings = pickSettings(cleanConfig(v.settings))
      out.settingsAt = Number(v.settingsAt)
    }
    const menus = cleanMenus(v.menus, false)
    if (Object.keys(menus).length) out.menus = menus
    const people = cleanPeople(v.people, false)
    if (Object.keys(people).length) out.people = people
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
    // the same words as the server's refusal (src/server/plugin-locks.ts), which keeps the deadline since 1.7.0
    if (st === 'closed') return `${dateLabel(date, '')} ${MEALS[meal]}은 마감 시각(${config.meals[meal].cutoff})이 지나 바꿀 수 없습니다.`
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
  /**
   * `firm` (with on = false): 확실히 신청안함 — the member says for certain they will not eat, and
   * from then on nobody else can request or cancel that meal for them. Only they can take it
   * back, by requesting (on = true) or cancelling plainly (on = false without firm).
   */
  function apply(value, config, date, meal, on, now, firm) {
    const error = refusal(config, date, meal, now)
    if (error) return { error }
    const entry = prune(cleanEntry(value), now)
    const rec = { on: !!on, at: now }
    if (!on && firm) rec.firm = true
    entry.days[date] = Object.assign({}, entry.days[date], { [meal]: rec })
    return { entry }
  }
  /** Has the member (their own entry, or the member a person registered by hand was merged into) marked 확실히 신청안함? */
  function isFirm(room, id, date, meal) {
    const hand = effective(room).people
    const tid = isManualId(id) && hand[id] && hand[id].as ? hand[id].as : id
    const e = room && room.entries && room.entries[tid]
    const r = e && cleanDays(e.value && e.value.days, true)[date]
    return !!(r && r[meal] && r[meal].firm)
  }
  /** Why somebody else cannot request or cancel for `target` ('' = they can). */
  function firmRefusal(room, target, date, meal) {
    if (!room || !target || !isFirm(room, target.id, date, meal)) return ''
    return `${target.name ? `${target.name} 님이` : '본인이'} ${dateLabel(date, '')} ${MEALS[meal] || ''}을 '확실히 신청안함'으로 정해 두어 다른 사람이 대신 신청·취소할 수 없습니다. 본인만 바꿀 수 있습니다.`
  }

  /** In charge of meals: the admin who made the settings (the owner) and the 식수서무 they named. */
  const canManage = (room, id) => !!room && !!id && (room.createdBy === id || cleanConfig(room.shared).stewards.includes(id))
  /**
   * Who may request for somebody else: every member (1.4.0; before, only those in charge and
   * the clerks named before 1.2.0). A record made for another is written into the entry of the
   * one who made it, so every screen shows who did it ("○○○ 대신"), and the member can change it
   * again until the deadline (the newest counts).
   */
  const canProxy = (room, id) => !!room && isId(id)
  /**
   * Request or cancel for another member (target = { id, name }), under the same deadline.
   * Anybody may (see canProxy), except for a meal the member marked 확실히 신청안함 (`room`,
   * the newest one read before saving, is needed to see that; resolve() ignores such a record
   * anyway).
   * It is written into the entry of the one who does it (`value`); the newest of the member's
   * own request and the ones made for them counts, so the member can still change it.
   */
  function applyFor(value, config, target, date, meal, on, now, room) {
    if (!target || typeof target.id !== 'string' || !target.id) return { error: '대신 신청할 사람을 고르세요.' }
    const error = refusal(config, date, meal, now) || firmRefusal(room, target, date, meal)
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
   * where days[date][meal] = { on, at, by, byName, firm? } (by = who requested it for them, '' = themselves).
   * The newest record counts; at the same moment the member's own. A meal the member marked
   * 확실히 신청안함 (`firm`) keeps their own record whatever others wrote for them, at any time:
   * this is where the mark is enforced, for every screen, count and file.
   */
  function resolve(room, members) {
    const entries = (room && room.entries) || {}
    const info = new Map((members || []).filter((m) => m && !m.manual).map((m) => [m.id, m]))
    const hand = effective(room).people
    const out = new Map()
    const person = (id, name) => {
      let p = out.get(id)
      if (!p) {
        const m = info.get(id)
        p = { id, name: name || (m && m.name) || '(이름 없음)', deptName: (m && m.deptName) || '', days: {} }
        if (isManualId(id)) {
          // registered by hand; one no longer on the list keeps the name of the list or of the record
          const h = hand[id]
          p.manual = true
          p.gone = !h || !!h.gone
          p.name = (h && h.name) || name || '(이름 없음)'
          p.deptName = (h && h.dept) || ''
        }
        out.set(id, p)
      }
      return p
    }
    // a person registered by hand who turned out to be a member: shown under that member
    const alias = (id) => (isManualId(id) && hand[id] && hand[id].as ? hand[id].as : id)
    // a record made for somebody else is never later than the moment the server stored the entry
    // it is in (entries[id].at), so a wrong or forged clock cannot win over the member's own
    const put = (p, days, by, byName, cap) => {
      for (const date of Object.keys(days)) {
        for (const k of Object.keys(days[date])) {
          const r = days[date][k]
          const rAt = by && cap > 0 ? Math.min(r.at, cap) : r.at
          const cur = p.days[date] && p.days[date][k]
          if (cur && by && cur.firm) continue
          if (cur && (rAt < cur.at || (rAt === cur.at && by))) continue
          const rec = { on: r.on, at: rAt, by, byName }
          if (!by && r.firm) rec.firm = true
          p.days[date] = Object.assign({}, p.days[date], { [k]: rec })
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
      // anybody may request for others, but only for somebody who exists: a member, one with
      // their own entry, or a person registered by hand. Those in charge are trusted as before
      // (a member who has since left keeps the meals they were given).
      const trusted = canManage(room, id)
      for (const raw of Object.keys(clean[id].for)) {
        if (raw === id) continue
        const tid = alias(raw)
        const m = info.get(tid)
        if (!trusted && !m && !entries[tid] && !(isManualId(tid) && hand[tid])) continue
        put(person(tid, (m && m.name) || (tid === raw ? clean[id].for[raw].name : '')), clean[id].for[raw].days, tid === id ? '' : id, tid === id ? '' : entries[id].name || '', Number(entries[id].at) || 0)
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
      if (r && r.on) out.push({ id: p.id, name: p.name, deptName: p.deptName, at: r.at, by: r.by, byName: r.byName, manual: !!p.manual })
    }
    return out.sort(byDeptName)
  }
  /** Who marked that meal of that day 확실히 신청안함 themselves (they are not eating, for certain). */
  function declinedList(room, date, meal, members) {
    const out = []
    for (const p of resolve(room, members).values()) {
      const r = p.days[date] && p.days[date][meal]
      if (r && r.firm) out.push({ id: p.id, name: p.name, deptName: p.deptName, at: r.at, manual: !!p.manual })
    }
    return out.sort(byDeptName)
  }
  /** Meals per person in a month ('YYYY-MM'). Only days whose deadline has passed count, unless `all`. */
  function monthTally(room, month, members, now, all) {
    const config = effective(room).config
    const rows = []
    for (const p of resolve(room, members).values()) {
      const row = { id: p.id, name: p.name, deptName: p.deptName, lunch: 0, dinner: 0, manual: !!p.manual, gone: !!p.gone }
      for (const date of Object.keys(p.days)) {
        if (!date.startsWith(month + '-')) continue
        for (const k of MEAL_KEYS) if (p.days[date][k] && p.days[date][k].on && (all || now >= cutoffAt(config, date, k))) row[k]++
      }
      if (row.lunch || row.dinner) rows.push(row)
    }
    rows.sort(byDeptName)
    return { rows, lunch: rows.reduce((s, r) => s + r.lunch, 0), dinner: rows.reduce((s, r) => s + r.dinner, 0) }
  }

  // ---------- statistics (지시 90·91) ----------
  /** Every date of a month ('YYYY-MM'). */
  function monthDays(month) {
    const [y, m] = month.split('-').map(Number)
    const n = new Date(y, m, 0).getDate()
    return Array.from({ length: n }, (_, i) => `${month}-${pad(i + 1)}`)
  }
  /**
   * Day by day: [{ date, served, why, meals: { lunch: { count, closed, proxied, manual, declined } … } }].
   * `count` is every request that stands; `closed` says whether it is final (deadline passed);
   * `declined` those who marked 확실히 신청안함 (a "no", not a missing answer).
   */
  function dailyTally(room, month, members, now) {
    const config = effective(room).config
    const people = Array.from(resolve(room, members).values())
    return monthDays(month).map((date) => {
      const meals = {}
      for (const k of MEAL_KEYS) {
        if (!config.meals[k].on) continue
        let count = 0
        let proxied = 0
        let manual = 0
        let declined = 0
        for (const p of people) {
          const r = p.days[date] && p.days[date][k]
          if (r && r.firm) declined++
          if (!r || !r.on) continue
          count++
          if (r.by) proxied++
          if (p.manual) manual++
        }
        meals[k] = { count, closed: now >= cutoffAt(config, date, k), proxied, manual, declined }
      }
      return { date, served: isServed(config, date), why: holidayName(config, date), meals }
    })
  }
  /** Per department: [{ dept, people, lunch, dinner }] (final requests only), in the order of the per-person table. */
  function deptTally(room, month, members, now) {
    const out = []
    const at = new Map()
    for (const r of monthTally(room, month, members, now, false).rows) {
      const dept = r.deptName || NO_DEPT_NAME
      if (!at.has(dept)) {
        at.set(dept, out.length)
        out.push({ dept, people: 0, lunch: 0, dinner: 0 })
      }
      const d = out[at.get(dept)]
      d.people++
      d.lunch += r.lunch
      d.dinner += r.dinner
    }
    return out
  }
  /**
   * The whole month at a glance (final requests only, unless said otherwise):
   *  { lunch, dinner, total, days, avgLunch, avgDinner, peak: { date, meal, count } | null,
   *    people, manualPeople, proxied, pending: { lunch, dinner }, declined: { lunch, dinner } } where
   * `days` are the served days already closed, `pending` the requests of the days still open and
   * `declined` the meals people marked 확실히 신청안함 (closed days).
   */
  function monthSummary(room, month, members, now) {
    const daily = dailyTally(room, month, members, now)
    const t = monthTally(room, month, members, now, false)
    const out = { lunch: t.lunch, dinner: t.dinner, total: t.lunch + t.dinner, days: 0, avgLunch: 0, avgDinner: 0, peak: null, people: t.rows.length, manualPeople: t.rows.filter((r) => r.manual).length, proxied: 0, pending: { lunch: 0, dinner: 0 }, declined: { lunch: 0, dinner: 0 } }
    const closedDays = { lunch: 0, dinner: 0 }
    for (const d of daily) {
      if (!d.served) continue
      let anyClosed = false
      for (const k of Object.keys(d.meals)) {
        const m = d.meals[k]
        if (m.closed) {
          anyClosed = true
          closedDays[k]++
          out.proxied += m.proxied
          out.declined[k] += m.declined
          if (!out.peak || m.count > out.peak.count) out.peak = { date: d.date, meal: k, count: m.count }
        } else out.pending[k] += m.count
      }
      if (anyClosed) out.days++
    }
    out.avgLunch = closedDays.lunch ? Math.round((out.lunch / closedDays.lunch) * 10) / 10 : 0
    out.avgDinner = closedDays.dinner ? Math.round((out.dinner / closedDays.dinner) * 10) / 10 : 0
    if (out.peak && !out.peak.count) out.peak = null
    return out
  }
  /**
   * One person's month (내 기록): days = [{ date, any, meals: { lunch: { on, by, byName, at, closed, firm } | null } }]
   * for the served days, done = final counts { lunch, dinner }, open = requests still open,
   * declined = meals marked 확실히 신청안함 (counted as a "no", not as no answer).
   */
  function personMonth(room, members, id, month, now) {
    const config = effective(room).config
    const p = resolve(room, members).get(id)
    const days = []
    const done = { lunch: 0, dinner: 0 }
    const open = { lunch: 0, dinner: 0 }
    const declined = { lunch: 0, dinner: 0 }
    for (const date of monthDays(month)) {
      if (!isServed(config, date)) continue
      const meals = {}
      let any = false
      for (const k of MEAL_KEYS) {
        if (!config.meals[k].on) continue
        const r = p && p.days[date] && p.days[date][k]
        const closed = now >= cutoffAt(config, date, k)
        meals[k] = r ? { on: !!r.on, by: r.by || '', byName: r.byName || '', at: r.at, closed } : null
        if (r && r.firm) meals[k].firm = true
        if (r) any = true
        if (r && r.on) (closed ? done : open)[k]++
        if (r && r.firm) declined[k]++
      }
      days.push({ date, any, meals })
    }
    return { days, done, open, declined }
  }
  /** The recent months (this one first) with what one person had (final): [{ month, lunch, dinner }]. */
  function personMonths(room, members, id, now, n) {
    const out = []
    const d = new Date(now)
    for (let i = 0; i < (n || 4); i++) {
      const month = ymd(new Date(d.getFullYear(), d.getMonth() - i, 1).getTime()).slice(0, 7)
      const r = monthTally(room, month, members, now, false).rows.find((x) => x.id === id)
      out.push({ month, lunch: r ? r.lunch : 0, dinner: r ? r.dinner : 0 })
    }
    return out
  }
  /**
   * What the statistics keep of a month (saved on the PC of the one in charge when the month is over).
   * Since 1.7.0 each row also has `dates` ({ lunch: [dates], dinner: [dates] }, the final meals),
   * so the 식대 정산 of a saved month is priced again with the prices of each date.
   */
  function statsSnapshot(room, month, members, now) {
    const t = monthTally(room, month, members, now, false)
    const dates = new Map(mealDates(room, month, members, now).map((r) => [r.id, r.dates]))
    return {
      v: 1,
      month,
      savedAt: now,
      summary: monthSummary(room, month, members, now),
      rows: t.rows.map((r) => ({ id: r.id, name: r.name, deptName: r.deptName, lunch: r.lunch, dinner: r.dinner, manual: !!r.manual, dates: dates.get(r.id) || { lunch: [], dinner: [] } })),
      daily: dailyTally(room, month, members, now).map((d) => ({ date: d.date, served: d.served, why: d.why, lunch: d.meals.lunch ? d.meals.lunch.count : null, dinner: d.meals.dinner ? d.meals.dinner.count : null })),
      depts: deptTally(room, month, members, now)
    }
  }
  /** Of what is kept now and a saved snapshot, the fuller one counts (old records are dropped after 100 days). */
  const betterOf = (live, saved) => (saved && saved.v === 1 && saved.summary && saved.summary.total > live.summary.total ? saved : live)
  const csvOf = (rows) => '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
  function dailyCsv(snap) {
    const has = (k) => snap.daily.some((d) => d[k] !== null)
    const head = ['날짜', ...(has('lunch') ? ['점심'] : []), ...(has('dinner') ? ['저녁'] : []), '합계', '비고']
    return csvOf([head, ...snap.daily.map((d) => [d.date, ...(has('lunch') ? [d.served ? d.lunch || 0 : ''] : []), ...(has('dinner') ? [d.served ? d.dinner || 0 : ''] : []), d.served ? (d.lunch || 0) + (d.dinner || 0) : '', d.served ? '' : d.why ? `공휴일(${d.why})` : '받지 않는 날'])])
  }
  function deptCsv(snap) {
    return csvOf([['부서', '인원', '점심', '저녁', '합계'], ...snap.depts.map((d) => [d.dept, d.people, d.lunch, d.dinner, d.lunch + d.dinner]), ['합계', snap.summary.people, snap.summary.lunch, snap.summary.dinner, snap.summary.total]])
  }
  function personCsv(snap) {
    return csvOf([['부서', '이름', '점심', '저녁', '합계'], ...snap.rows.map((r) => [r.deptName, r.manual ? `${r.name} (미등록)` : r.name, r.lunch, r.dinner, r.lunch + r.dinner]), ['', '합계', snap.summary.lunch, snap.summary.dinner, snap.summary.total]])
  }

  // ---------- 식대: prices that change over time, and the monthly settlement (1.7.0) ----------
  /*
   * The prices live in a room of their own (shared.kind = 'meal-price'), not in the settings:
   * a client older than 1.7.0 rewrites the settings room's shared data and its entries without
   * the fields it does not know, which would drop them; it never looks at this room.
   * The list is [{ from: 'YYYY-MM-DD', lunch, dinner }] (원), oldest first. A price applies from
   * its date until the next one, so a change keeps the price that applied on every earlier date.
   * The room's creator writes its shared data { kind, v, prices, at }; the others in charge write
   * their own entry { v, prices, at }. The newest list of those in charge of the settings room
   * counts (as with the settings: a time is never later than when the server stored it, and what
   * a 식수서무 wrote before being named does not count).
   */
  const won = (v) => {
    const n = Math.round(Number(String(v == null ? '' : v).replace(/[,\s원]/g, '')))
    return Number.isFinite(n) && n > 0 ? Math.min(n, LIMITS.priceMax) : 0
  }
  /** The price list as stored: valid dates only, one per date (the later one wins), oldest first. */
  function cleanPrices(list) {
    const by = new Map()
    for (const p of Array.isArray(list) ? list : []) if (p && isYmd(p.from)) by.set(p.from, { from: p.from, lunch: won(p.lunch), dinner: won(p.dinner) })
    return Array.from(by.values())
      .sort((a, b) => (a.from < b.from ? -1 : 1))
      .slice(-LIMITS.pricesMax)
  }
  const isPriceRoom = (r) => !!r && !!r.shared && r.shared.kind === 'meal-price'
  /** The price room: the oldest one, so a second one made at the same moment changes nothing. */
  const pickPriceRoom = (rooms) => (rooms || []).filter(isPriceRoom).sort((a, b) => a.createdAt - b.createdAt)[0] || null
  /** The prices that count: { prices, at, by } (prices [] = none set yet). */
  function effectivePrices(room, priceRoom) {
    let out = { prices: [], at: 0, by: '' }
    if (!room || !priceRoom) return out
    const since = cleanSince(room.shared && room.shared.since)
    const take = (list, at, by) => {
      if (!(at > out.at) || !canManage(room, by) || (by !== room.createdBy && at < (since[by] || 0))) return
      out = { prices: cleanPrices(list), at, by }
    }
    const sh = priceRoom.shared || {}
    const cap = (x) => (Number(x) > 0 ? Number(x) : Infinity)
    if (Number(sh.at) > 0) take(sh.prices, Math.min(Number(sh.at), cap(priceRoom.updatedAt)), priceRoom.createdBy)
    for (const id of Object.keys(priceRoom.entries || {})) {
      const e = priceRoom.entries[id]
      const v = e && e.value
      if (v && typeof v === 'object' && Number(v.at) > 0) take(v.prices, Math.min(Number(v.at), cap(e.at)), id)
    }
    return out
  }
  /** The price of one meal on a date (null = no price applies yet). */
  function priceAt(prices, date, meal) {
    let out = null
    for (const p of prices || []) if (p.from <= date) out = p[meal]
    return out
  }
  /** The prices that apply in a month: the one in force on the 1st and those that start later in it. */
  function monthPrices(prices, month) {
    const first = `${month}-01`
    const list = cleanPrices(prices)
    const start = list.filter((p) => p.from <= first).pop()
    return (start ? [start] : []).concat(list.filter((p) => p.from > first && p.from.slice(0, 7) === month))
  }
  /**
   * A save of the price list by somebody in charge (`now` = the server's clock):
   * { create } (no price room yet: make it with this shared data), { shared } (the room's
   * creator), { entry } (anybody else in charge), { same } (nothing changed) or { error }.
   */
  function savePrices(room, priceRoom, id, now, list) {
    if (!room || !canManage(room, id)) return { error: '설정을 만든 관리자와 식수서무만 할 수 있습니다.' }
    const given = Array.isArray(list) ? list : []
    if (given.some((p) => !p || !isYmd(p.from))) return { error: '식대 단가의 적용 시작일을 고르세요.' }
    if (new Set(given.map((p) => p.from)).size !== given.length) return { error: '같은 적용 시작일이 두 번 있습니다.' }
    if (given.length > LIMITS.pricesMax) return { error: `식대 단가는 ${LIMITS.pricesMax}개까지 둘 수 있습니다.` }
    const prices = cleanPrices(given)
    if (JSON.stringify(prices) === JSON.stringify(effectivePrices(room, priceRoom).prices)) return { same: true }
    if (!priceRoom) return { create: { kind: 'meal-price', v: 1, prices, at: now } }
    if (priceRoom.createdBy === id) return { shared: { kind: 'meal-price', v: 1, prices, at: now } }
    return { entry: { v: 1, prices, at: now } }
  }
  /** Per person, the dates of the final meals (deadline passed) of a month: [{ id, name, deptName, manual, gone, dates: { lunch, dinner } }]. */
  function mealDates(room, month, members, now) {
    const config = effective(room).config
    const out = []
    for (const p of resolve(room, members).values()) {
      const dates = { lunch: [], dinner: [] }
      for (const date of Object.keys(p.days).sort()) {
        if (!date.startsWith(month + '-')) continue
        for (const k of MEAL_KEYS) if (p.days[date][k] && p.days[date][k].on && now >= cutoffAt(config, date, k)) dates[k].push(date)
      }
      if (dates.lunch.length || dates.dinner.length) out.push({ id: p.id, name: p.name, deptName: p.deptName, manual: !!p.manual, gone: !!p.gone, dates })
    }
    return out.sort(byDeptName)
  }
  /**
   * 식대 정산 of people with their final meal dates (mealDates() or the rows of a snapshot):
   *  { rows: [{ id, name, deptName, manual, lunch, dinner, lunchAmt, dinnerAmt, amount }],
   *    depts: [{ dept, people, lunch, dinner, lunchAmt, dinnerAmt, amount }],
   *    total: { people, manual, lunch, dinner, lunchAmt, dinnerAmt, amount }, unpriced }
   * Each meal is priced on its own date; `unpriced` counts the meals no price applied to yet.
   */
  function settle(people, prices) {
    const list = cleanPrices(prices)
    const rows = []
    let unpriced = 0
    for (const p of people || []) {
      const d = p.dates || { lunch: [], dinner: [] }
      const row = { id: p.id, name: p.name, deptName: p.deptName || '', manual: !!p.manual, lunch: d.lunch.length, dinner: d.dinner.length, lunchAmt: 0, dinnerAmt: 0, amount: 0 }
      for (const k of MEAL_KEYS) {
        for (const date of d[k]) {
          const price = priceAt(list, date, k)
          if (price === null) unpriced++
          else row[`${k}Amt`] += price
        }
      }
      row.amount = row.lunchAmt + row.dinnerAmt
      if (row.lunch || row.dinner) rows.push(row)
    }
    rows.sort(byDeptName)
    const depts = []
    const at = new Map()
    const total = { people: rows.length, manual: rows.filter((r) => r.manual).length, lunch: 0, dinner: 0, lunchAmt: 0, dinnerAmt: 0, amount: 0 }
    for (const r of rows) {
      const dept = r.deptName || NO_DEPT_NAME
      if (!at.has(dept)) {
        at.set(dept, depts.length)
        depts.push({ dept, people: 0, lunch: 0, dinner: 0, lunchAmt: 0, dinnerAmt: 0, amount: 0 })
      }
      const g = depts[at.get(dept)]
      g.people++
      for (const k of ['lunch', 'dinner', 'lunchAmt', 'dinnerAmt', 'amount']) {
        g[k] += r[k]
        total[k] += r[k]
      }
    }
    return { rows, depts, total, unpriced }
  }
  /** 식대 정산 of a month from the requests kept now. */
  const settlement = (room, month, members, now, prices) => settle(mealDates(room, month, members, now), prices)
  /** The settlement of a statistics snapshot, or null when it was saved before 1.7.0 (no dates). */
  const snapSettlement = (snap, prices) => (snap && snap.rows && snap.rows.every((r) => r.dates) ? settle(snap.rows, prices) : null)
  /** 12,345 */
  const wonText = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  /** The settlement as CSV: the people of each department, its subtotal, then the total. */
  function settleCsv(s) {
    const out = [['부서', '이름', '점심(회)', '저녁(회)', '점심 금액(원)', '저녁 금액(원)', '합계(원)']]
    for (const d of s.depts) {
      for (const r of s.rows.filter((x) => (x.deptName || NO_DEPT_NAME) === d.dept)) out.push([r.deptName, r.manual ? `${r.name} (미등록)` : r.name, r.lunch, r.dinner, r.lunchAmt, r.dinnerAmt, r.amount])
      out.push([d.dept, `소계 ${d.people}명`, d.lunch, d.dinner, d.lunchAmt, d.dinnerAmt, d.amount])
    }
    out.push(['', `합계 ${s.total.people}명`, s.total.lunch, s.total.dinner, s.total.lunchAmt, s.total.dinnerAmt, s.total.amount])
    return csvOf(out)
  }

  // ---------- people registered by hand (staff who do not use TeamHub) ----------
  /** Ids of people registered by hand start with "x:", which no member id does. */
  const isManualId = (x) => typeof x === 'string' && /^x:[a-z0-9]{6,24}$/.test(x)
  /** A new id from a random number in [0, 1) and the time: "x:" + letters and digits. */
  const newManualId = (rand, now) => `x:${Math.floor((Number(now) || 0) % 2176782336).toString(36)}${Math.floor((Number(rand) || 0) * 2176782336).toString(36)}`.slice(0, 26).padEnd(8, '0')
  const line = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max).trim()
  /** One person as typed: { name, dept, title, memo } (name '' = not usable). */
  const cleanPerson = (p) => ({ name: line(p && p.name, LIMITS.personName), dept: line(p && p.dept, LIMITS.personDept), title: line(p && p.title, LIMITS.personTitle), memo: line(p && p.memo, LIMITS.personMemo) })
  /**
   * { 'x:…': { name, dept, title, memo, at, by?, gone?, as? } }. `gone` = removed (kept so the
   * past stays readable and an older copy cannot bring the person back); `as` = the member this
   * person turned out to be: their records are shown under that member.
   */
  function cleanPeople(src, withBy) {
    const out = {}
    if (!src || typeof src !== 'object') return out
    for (const id of Object.keys(src)) {
      const r = src[id]
      if (!isManualId(id) || !r || typeof r !== 'object' || !(Number(r.at) > 0)) continue
      const p = cleanPerson(r)
      if (!p.name) continue
      p.at = Number(r.at)
      if (r.gone) p.gone = true
      if (isId(r.as) && !isManualId(r.as)) p.as = r.as
      if (withBy && isId(r.by)) p.by = r.by
      out[id] = p
    }
    return out
  }
  /** Those on the list now: [{ id, name, deptName, title, memo, manual: true }] in the order of name. */
  function manualList(people) {
    return Object.keys(people || {})
      .filter((id) => !people[id].gone && !people[id].as)
      .map((id) => ({ id, name: people[id].name, deptName: people[id].dept, title: people[id].title, memo: people[id].memo, manual: true }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko') || (a.id < b.id ? -1 : 1))
  }
  /** Members followed by the people registered by hand: everybody a request can be made for. */
  const roster = (room, members) => (members || []).concat(manualList(effective(room).people))
  /** Is there somebody of that name already? 'member', 'manual' or '' (namesakes exist: a warning, not an error). */
  function nameClash(name, members, people, selfId) {
    const n = line(name, LIMITS.personName)
    if (!n) return ''
    if ((members || []).some((m) => m.name === n)) return 'member'
    return manualList(people).some((p) => p.id !== selfId && p.name === n) ? 'manual' : ''
  }
  /** How many of a list (dayList, tally rows) are registered by hand: { total, manual }. */
  const splitCount = (list) => ({ total: (list || []).length, manual: (list || []).filter((p) => p.manual).length })
  /** "23명" or "23명 (미등록 3명 포함)". */
  const countText = (list) => {
    const c = splitCount(list)
    return `${c.total}명${c.manual ? ` (미등록 ${c.manual}명 포함)` : ''}`
  }

  // ---------- menus and the people in charge ----------
  const SETTING_KEYS = ['meals', 'weekend', 'holidays', 'ahead', 'notice']
  /** The part of the settings a 식수서무 may change (not who is in charge). */
  function pickSettings(config) {
    const out = {}
    for (const k of SETTING_KEYS) out[k] = k === 'meals' ? { lunch: Object.assign({}, config.meals.lunch), dinner: Object.assign({}, config.meals.dinner) } : config[k]
    return out
  }
  /** One cell as typed: trimmed lines without blanks; the note of a day is a single line. */
  function cleanMenuText(slot, v) {
    const s = String(v == null ? '' : v).replace(/\r\n?/g, '\n')
    if (slot === 'note') return s.replace(/\s+/g, ' ').trim().slice(0, LIMITS.menuNote).trim()
    return s
      .split('\n')
      .map((x) => x.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, LIMITS.menuLines)
      .join('\n')
      .slice(0, LIMITS.menuText)
      .trim()
  }
  /** { 'YYYY-MM-DD': { lunch: { t, at, by? }, dinner: …, note: … } }; an empty t is a cleared cell. */
  function cleanMenus(src, withBy) {
    const out = {}
    if (!src || typeof src !== 'object') return out
    for (const date of Object.keys(src)) {
      if (!isYmd(date) || !src[date] || typeof src[date] !== 'object') continue
      const day = {}
      for (const slot of MENU_SLOTS) {
        const r = src[date][slot]
        if (!r || typeof r !== 'object' || !(Number(r.at) > 0)) continue
        day[slot] = { t: cleanMenuText(slot, r.t), at: Number(r.at) }
        if (withBy && isId(r.by)) day[slot].by = r.by
      }
      if (Object.keys(day).length) out[date] = day
    }
    return out
  }
  const cleanSince = (src) => {
    const out = {}
    if (src && typeof src === 'object') for (const id of Object.keys(src)) if (isId(id) && Number(src[id]) > 0) out[id] = Number(src[id])
    return out
  }
  /** Monday of the week of a date. */
  const weekStart = (date) => addDays(date, -((new Date(dayStart(date)).getDay() + 6) % 7))
  /** The days whose menus are kept: the current week, 8 weeks before it and 8 after it. */
  function menuWindow(now) {
    const mon = weekStart(ymd(now))
    return { from: addDays(mon, -7 * LIMITS.menuWeeksBack), to: addDays(mon, 7 * LIMITS.menuWeeksAhead + 6) }
  }
  function pruneMenus(menus, now) {
    const w = menuWindow(now)
    for (const d of Object.keys(menus)) if (d < w.from || d > w.to) delete menus[d]
    return menus
  }
  /**
   * Makes `obj` (shared data or an entry, with `obj.menus`) fit the size limit by dropping
   * whole days of menus: the oldest past day first, then the farthest future day. Nothing
   * else is touched (never somebody's requests). Returns how many days were dropped.
   */
  function fitMenus(obj, today, max) {
    let n = 0
    const limit = max || LIMITS.stateMax
    while (obj.menus && JSON.stringify(obj).length > limit) {
      const dates = Object.keys(obj.menus).sort()
      if (!dates.length) break
      delete obj.menus[dates[0] < today ? dates[0] : dates[dates.length - 1]]
      n++
    }
    if (obj.menus && !Object.keys(obj.menus).length) delete obj.menus
    return n
  }

  /**
   * What counts right now: the owner's shared data merged with what the 식수서무 wrote into
   * their own entries. Returns { config, stewards, settingsAt, settingsBy, menus, people }
   * where menus[date][slot] = { t, at, by } and people[id] = { name, dept, …, at, by } (the
   * people registered by hand, the newest record of each).
   *  - Only entries of members named in the shared data count; anybody else is ignored.
   *  - The newest wins: the settings as a whole, a menu per day and slot. At the same moment
   *    the shared data wins, then the 식수서무 named first.
   *  - A time written by a member is never taken as later than the moment the server stored
   *    their entry (entries[id].at), so a wrong or forged clock cannot win.
   *  - What a member wrote before the owner named them (shared.since[id]) does not count.
   *    So once removed, their edits are gone unless the owner's save folded them in (saveAs).
   */
  function effective(room) {
    const shared = (room && room.shared) || {}
    const base = cleanConfig(shared)
    const owner = (room && room.createdBy) || ''
    const stewards = base.stewards.filter((id) => id !== owner)
    const since = cleanSince(shared.since)
    let settings = pickSettings(base)
    let settingsAt = Number(shared.settingsAt) > 0 ? Number(shared.settingsAt) : 0
    let settingsBy = isId(shared.settingsBy) ? shared.settingsBy : owner
    const menus = cleanMenus(shared.menus, true)
    for (const d of Object.keys(menus)) for (const slot of Object.keys(menus[d])) if (!menus[d][slot].by) menus[d][slot].by = owner
    const people = cleanPeople(shared.people, true)
    for (const pid of Object.keys(people)) if (!people[pid].by) people[pid].by = owner
    const entries = (room && room.entries) || {}
    for (const id of stewards) {
      if (!entries[id]) continue
      const v = cleanEntry(entries[id].value)
      const cap = Number(entries[id].at) > 0 ? Number(entries[id].at) : Infinity
      const from = since[id] || 0
      if (v.settings) {
        const at = Math.min(v.settingsAt, cap)
        if (at >= from && at > settingsAt) {
          settings = v.settings
          settingsAt = at
          settingsBy = id
        }
      }
      for (const date of Object.keys(v.menus || {})) {
        for (const slot of Object.keys(v.menus[date])) {
          const at = Math.min(v.menus[date][slot].at, cap)
          const cur = menus[date] && menus[date][slot]
          if (at < from || (cur && cur.at >= at)) continue
          menus[date] = Object.assign({}, menus[date], { [slot]: { t: v.menus[date][slot].t, at, by: id } })
        }
      }
      // people registered by hand: the newest record of each person
      for (const pid of Object.keys(v.people || {})) {
        const at = Math.min(v.people[pid].at, cap)
        if (at < from || (people[pid] && people[pid].at >= at)) continue
        people[pid] = Object.assign({}, v.people[pid], { at, by: id })
      }
    }
    return { config: Object.assign({}, base, settings, { stewards }), stewards, settingsAt, settingsBy, menus, people }
  }
  /** The text of one cell ('' = nothing registered). */
  const menuOf = (menus, date, slot) => (menus && menus[date] && menus[date][slot] ? menus[date][slot].t : '')
  /** The newest change among some days: { at, by } or null. */
  function menuStamp(menus, dates) {
    let out = null
    for (const d of dates) for (const slot of MENU_SLOTS) if (menus && menus[d] && menus[d][slot] && (!out || menus[d][slot].at > out.at)) out = { at: menus[d][slot].at, by: menus[d][slot].by || '' }
    return out
  }
  /** Mon–Fri (Mon–Sun when weekends are served) of a week: [{ date, served, why }] (why = holiday name). */
  function weekDays(config, monday) {
    const out = []
    for (let i = 0; i < (config.weekend ? 7 : 5); i++) {
      const date = addDays(monday, i)
      out.push({ date, served: isServed(config, date), why: holidayName(config, date) })
    }
    return out
  }
  /** The meals of the menu table: those offered, in order. */
  const menuMeals = (config) => MEAL_KEYS.filter((k) => config.meals[k].on)

  /**
   * Save by somebody in charge. patch = { settings?, stewards?, menus? } where menus is a list
   * of { date, slot, t } (cells that were changed). `now` must be the server's clock.
   *  - the owner → { shared }: the merged state folded into the shared data (so it stays the
   *    base), plus the patch. Only the owner's `stewards` is taken; naming them again drops the
   *    clerks of before 1.2.0.
   *  - a 식수서무 → { entry }: their own entry with the patch; what the shared data already
   *    holds is dropped from it. `stewards` in the patch is ignored.
   * Too big: old menus are dropped first (`trimmed` days), never requests. Else { error }.
   */
  function saveAs(room, id, now, patch) {
    const p = patch || {}
    if (!room || !canManage(room, id)) return { error: '설정을 만든 관리자와 식수서무만 할 수 있습니다.' }
    const eff = effective(room)
    const today = ymd(now)
    const owner = room.createdBy === id
    let settings = null
    if (p.settings) {
      settings = pickSettings(cleanConfig(p.settings))
      if (!settings.meals.lunch.on && !settings.meals.dinner.on) return { error: '점심과 저녁 가운데 하나는 받아야 합니다.' }
    }
    const win = menuWindow(now)
    const edits = []
    for (const e of Array.isArray(p.menus) ? p.menus : []) {
      if (!e || !isYmd(e.date) || !MENU_SLOTS.includes(e.slot) || e.date < win.from || e.date > win.to) continue
      const t = cleanMenuText(e.slot, e.t)
      if (t !== menuOf(eff.menus, e.date, e.slot)) edits.push({ date: e.date, slot: e.slot, t })
    }
    // people registered by hand: [{ id, name, dept, title, memo, gone?, as? }]
    const persons = []
    for (const e of Array.isArray(p.people) ? p.people : []) {
      if (!e || !isManualId(e.id)) continue
      // what the patch does not mention stays as it is (removing or linking sends the id only)
      const cur = eff.people[e.id] || {}
      const pick = (k) => (e[k] === undefined ? cur[k] : e[k])
      const rec = cleanPerson({ name: pick('name'), dept: pick('dept'), title: pick('title'), memo: pick('memo') })
      if (!rec.name) return { error: '이름을 적으세요.' }
      if (pick('gone')) rec.gone = true
      if (isId(pick('as')) && !isManualId(pick('as'))) rec.as = pick('as')
      rec.at = now
      persons.push({ id: e.id, rec })
    }
    if (persons.length) {
      const next = Object.assign({}, eff.people)
      for (const x of persons) next[x.id] = x.rec
      if (manualList(next).length > LIMITS.peopleMax && manualList(next).length > manualList(eff.people).length) return { error: `직접 등록은 ${LIMITS.peopleMax}명까지 할 수 있습니다.` }
    }
    if (owner) {
      const shared = Object.assign({}, eff.config, settings || {})
      shared.settingsAt = settings ? now : eff.settingsAt
      shared.settingsBy = settings ? id : eff.settingsBy
      const since = cleanSince(room.shared && room.shared.since)
      if (Array.isArray(p.stewards)) {
        shared.stewards = Array.from(new Set(p.stewards.filter((x) => isId(x) && x !== id))).slice(0, LIMITS.stewardsMax)
        shared.clerks = []
        shared.since = {}
        for (const s of shared.stewards) {
          const t = eff.stewards.includes(s) ? since[s] || 0 : now
          if (t) shared.since[s] = t
        }
      } else {
        shared.since = {}
        for (const s of shared.stewards) if (since[s]) shared.since[s] = since[s]
      }
      const menus = eff.menus
      for (const e of edits) menus[e.date] = Object.assign({}, menus[e.date], { [e.slot]: { t: e.t, at: now, by: id } })
      shared.menus = pruneMenus(menus, now)
      // the list of people is never cut to make room: only menus are (fitMenus)
      shared.people = eff.people
      for (const x of persons) shared.people[x.id] = Object.assign({ by: id }, x.rec)
      const trimmed = fitMenus(shared, today)
      return { shared, trimmed }
    }
    const base = cleanMenus(room.shared && room.shared.menus, true)
    const baseAt = Number(room.shared && room.shared.settingsAt) || 0
    const from = cleanSince(room.shared && room.shared.since)[id] || 0
    const mine = room.entries && room.entries[id] ? room.entries[id].value : null
    const entry = prune(cleanEntry(mine), now)
    if (settings) {
      entry.settings = settings
      entry.settingsAt = now
    } else if (entry.settings && (entry.settingsAt <= baseAt || entry.settingsAt < from)) {
      delete entry.settings
      delete entry.settingsAt
    }
    const menus = entry.menus || {}
    for (const e of edits) menus[e.date] = Object.assign({}, menus[e.date], { [e.slot]: { t: e.t, at: now } })
    // what the owner's shared data already holds (or what no longer counts) need not be kept twice
    for (const d of Object.keys(menus)) {
      for (const slot of Object.keys(menus[d])) {
        const b = base[d] && base[d][slot]
        if (menus[d][slot].at < from || (b && b.at >= menus[d][slot].at)) delete menus[d][slot]
      }
      if (!Object.keys(menus[d]).length) delete menus[d]
    }
    entry.menus = pruneMenus(menus, now)
    const basePeople = cleanPeople(room.shared && room.shared.people, true)
    const people = entry.people || {}
    for (const x of persons) people[x.id] = x.rec
    for (const pid of Object.keys(people)) if (people[pid].at < from || (basePeople[pid] && basePeople[pid].at >= people[pid].at)) delete people[pid]
    if (Object.keys(people).length) entry.people = people
    else delete entry.people
    const trimmed = fitMenus(entry, today)
    return { entry, trimmed }
  }

  /** The week as text: "주간 메뉴 11/23(월)~11/27(금)" and a block per day. */
  function weekText(config, menus, monday) {
    const days = weekDays(config, monday)
    const meals = menuMeals(config)
    const lines = [`주간 메뉴 ${dateLabel(days[0].date, '')}~${dateLabel(days[days.length - 1].date, '')}`]
    for (const d of days) {
      const note = menuOf(menus, d.date, 'note')
      lines.push('', `${dateLabel(d.date, '')}${note ? ` (${note})` : ''}`)
      if (!d.served) {
        lines.push(`  ${d.why ? `공휴일(${d.why})` : '신청을 받지 않는 날'}`)
        continue
      }
      for (const k of meals) lines.push(`  ${MEALS[k]}: ${menuOf(menus, d.date, k).split('\n').join(', ') || '메뉴 미등록'}`)
    }
    return lines.join('\n')
  }
  /** A block copied from a spreadsheet (tabs between cells, quotes around cells with line breaks) → rows of cells. */
  function parseBlock(text) {
    const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n')
    const rows = []
    let row = []
    let cell = ''
    let quoted = false
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (quoted) {
        if (ch !== '"') cell += ch
        else if (s[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else if (ch === '"' && cell === '') quoted = true
      else if (ch === '\t') {
        row.push(cell)
        cell = ''
      } else if (ch === '\n') {
        row.push(cell)
        rows.push(row)
        row = []
        cell = ''
      } else cell += ch
    }
    if (cell !== '' || row.length) {
      row.push(cell)
      rows.push(row)
    }
    return rows
  }
  /**
   * Where the cells of a pasted block go in a grid of nRows days by nCols slots, starting at
   * (r0, c0): [{ r, c, t }]. A block that is wider than the grid but fits when turned (days
   * across, meals down, as most menu sheets are) is turned.
   */
  function placeBlock(block, nRows, nCols, r0, c0) {
    let rows = (block || []).filter((r) => Array.isArray(r))
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0)
    if (width > nCols - c0 && rows.length <= nCols - c0) {
      const turned = []
      for (let c = 0; c < width; c++) turned.push(rows.map((r) => (r[c] == null ? '' : r[c])))
      rows = turned
    }
    const out = []
    rows.forEach((cells, i) => {
      cells.forEach((t, j) => {
        if (r0 + i < nRows && c0 + j < nCols) out.push({ r: r0 + i, c: c0 + j, t: String(t) })
      })
    })
    return out
  }

  // ---------- requests for many people at once (anybody, see canProxy) ----------
  const NO_DEPT = '부서 미지정'
  /**
   * Members by department for the pick list: [{ dept, own, members }]. Departments and the
   * people in them stay in the order the list arrives in (TeamHub already orders them the way
   * the admins set it); the department of the one who acts comes first.
   */
  function deptGroups(members, ownDept) {
    const groups = []
    const at = new Map()
    for (const m of members || []) {
      if (!m || !isId(m.id)) continue
      const dept = m.deptName || NO_DEPT
      if (!at.has(dept)) {
        at.set(dept, groups.length)
        groups.push({ dept, own: dept === (ownDept || NO_DEPT), members: [] })
      }
      groups[at.get(dept)].members.push(m)
    }
    return groups.filter((g) => g.own).concat(groups.filter((g) => !g.own))
  }
  /** The header checkbox of a department: 'all', 'some' or 'none' of `ids` are in `selected` (a Set or an array). */
  function groupState(ids, selected) {
    const has = (id) => (selected && typeof selected.has === 'function' ? selected.has(id) : Array.from(selected || []).includes(id))
    const n = (ids || []).filter(has).length
    return !n ? 'none' : n === ids.length ? 'all' : 'some'
  }
  /** Every day and meal offered for a bulk request: [{ date, meal, open, why }] (why = the reason it cannot be changed). */
  function bulkSlots(config, dates, now) {
    const out = []
    for (const date of dates || []) {
      for (const meal of MEAL_KEYS) {
        if (!config.meals[meal].on) continue
        const st = stateOf(config, date, meal, now)
        const why = st === 'closed' ? `${config.meals[meal].cutoff} 마감됨` : st === 'off' ? (holidayName(config, date) ? `공휴일(${holidayName(config, date)})` : '받지 않는 날') : upcoming(config, now).includes(date) ? '' : '아직 받지 않는 날짜'
        out.push({ date, meal, open: !why, why })
      }
    }
    return out
  }
  /** Is any of the slots marked 확실히 신청안함 by `id` themselves? (people = resolve()) */
  function firmAny(people, id, slots) {
    const p = people && people.get(id)
    return (slots || []).some((s) => !!(p && p.days[s.date] && p.days[s.date][s.meal] && p.days[s.date][s.meal].firm))
  }
  /**
   * Nothing to do for `id` over the slots: each says `on` already or was marked 확실히 신청안함
   * (which nobody else may change). Such a person cannot be picked in the bulk list.
   */
  function settled(people, id, slots, on) {
    const p = people && people.get(id)
    return (
      (slots || []).length > 0 &&
      slots.every((s) => {
        const r = p && p.days[s.date] && p.days[s.date][s.meal]
        return !!(r && r.firm) || !!(r && r.on) === !!on
      })
    )
  }
  /** Does the record that counts for `id` already say `on` for every one of the slots? (people = resolve()) */
  function alreadySet(people, id, slots, on) {
    const p = people && people.get(id)
    return (slots || []).length > 0 && slots.every((s) => !!(p && p.days[s.date] && p.days[s.date][s.meal] && p.days[s.date][s.meal].on) === !!on)
  }
  /**
   * What the record that counts says for `id` over the chosen slots, for the marks of the bulk
   * list (people = resolve()):
   *  { kind: 'none' }                     nothing recorded
   *  { kind: 'self' }                     requested by the person themselves
   *  { kind: 'proxy', byName }            requested for them by somebody else
   *  { kind: 'cancelSelf' }               requested, then cancelled by themselves
   *  { kind: 'cancelProxy', byName }      cancelled for them by somebody else
   *  { kind: 'firm' }                     marked 확실히 신청안함 by themselves: nobody else may change it
   *  { kind: 'mixed' }                    the slots differ
   */
  function pickStatus(people, id, slots) {
    const p = people && people.get(id)
    let out = null
    for (const s of slots || []) {
      const r = p && p.days[s.date] && p.days[s.date][s.meal]
      const one = !r ? { kind: 'none' } : r.firm ? { kind: 'firm' } : r.on ? (r.by ? { kind: 'proxy', byName: r.byName || '' } : { kind: 'self' }) : r.by ? { kind: 'cancelProxy', byName: r.byName || '' } : { kind: 'cancelSelf' }
      if (!out) out = one
      else if (out.kind !== one.kind || (out.byName || '') !== (one.byName || '')) return { kind: 'mixed' }
    }
    return out || { kind: 'none' }
  }
  /**
   * Request (on) or cancel for many members, days and meals in one save of the entry of the one
   * who acts (`id`): targets = [{ id, name }], slots = [{ date, meal }]. `now` is the server's
   * clock at the moment of saving; `config` the settings with the holidays of that moment.
   * Returns { entry, result } or { error }; result counts requests (one per person, day and meal):
   *  - applied: written
   *  - already: skipped, the record that counts says so already (a cancel of nothing as well)
   *  - closed:  skipped, the deadline has passed or the day takes no requests
   *  - firm:    skipped, the person marked that meal 확실히 신청안함 themselves
   *  - unfit:   not written because the entry would pass the size limit
   *  - trimmed: days of old records made for others (and old menus) dropped to make room
   * The acting person's own requests are never dropped. Their own name among the targets is
   * written as their own request.
   */
  function applyBulk(room, id, config, targets, slots, on, now, members, max) {
    if (!room || !canProxy(room, id)) return { error: '대신 신청할 권한이 없습니다.' }
    const people = []
    const seen = new Set()
    for (const t of targets || []) {
      if (!t || !isId(t.id) || seen.has(t.id)) continue
      seen.add(t.id)
      people.push({ id: t.id, name: String(t.name || '').slice(0, 60) })
    }
    const wanted = []
    const seenSlot = new Set()
    for (const s of slots || []) {
      if (!s || !isYmd(s.date) || !MEALS[s.meal] || seenSlot.has(`${s.date}|${s.meal}`)) continue
      seenSlot.add(`${s.date}|${s.meal}`)
      wanted.push({ date: s.date, meal: s.meal })
    }
    if (!people.length) return { error: '대신 신청할 사람을 고르세요.' }
    if (!wanted.length) return { error: '날짜와 식사를 고르세요.' }
    const result = { applied: 0, already: 0, closed: 0, firm: 0, unfit: 0, trimmed: 0 }
    const open = wanted.filter((s) => !refusal(config, s.date, s.meal, now))
    result.closed = (wanted.length - open.length) * people.length
    const mine = room.entries && room.entries[id] ? room.entries[id].value : null
    const entry = prune(cleanEntry(mine), now)
    const current = resolve(room, members)
    const done = [] // what was written, in order, so the last can be taken back when it does not fit
    for (const p of people) {
      for (const s of open) {
        // a "no" the person set for themselves is theirs alone to change
        if (p.id !== id && firmAny(current, p.id, [s])) {
          result.firm++
          continue
        }
        if (alreadySet(current, p.id, [s], on)) {
          result.already++
          continue
        }
        let days
        if (p.id === id) days = entry.days
        else {
          const others = entry.for || (entry.for = {})
          const t = others[p.id] || (others[p.id] = { name: '', days: {} })
          t.name = p.name || t.name
          days = t.days
        }
        const before = days[s.date] && days[s.date][s.meal]
        days[s.date] = Object.assign({}, days[s.date], { [s.meal]: { on: !!on, at: now } })
        done.push({ p, s, before })
      }
    }
    // too big for the server: old menus and the oldest days of records made for others go first
    const limit = max || LIMITS.stateMax
    const today = ymd(now)
    const size = () => JSON.stringify(entry).length
    while (entry.menus && size() > limit) {
      const old = Object.keys(entry.menus).sort()[0]
      if (!old || old >= today) break
      delete entry.menus[old]
      result.trimmed++
    }
    if (entry.menus && !Object.keys(entry.menus).length) delete entry.menus
    while (entry.for && size() > limit) {
      let oldest = ''
      for (const pid of Object.keys(entry.for)) for (const d of Object.keys(entry.for[pid].days)) if (d < today && (!oldest || d < oldest)) oldest = d
      if (!oldest) break
      for (const pid of Object.keys(entry.for)) {
        delete entry.for[pid].days[oldest]
        if (!Object.keys(entry.for[pid].days).length) delete entry.for[pid]
      }
      result.trimmed++
    }
    // still too big: take back what was written last, one request at a time
    while (done.length && size() > limit) {
      const { p, s, before } = done.pop()
      const days = p.id === id ? entry.days : entry.for[p.id].days
      if (before) days[s.date][s.meal] = before
      else {
        delete days[s.date][s.meal]
        if (!Object.keys(days[s.date]).length) delete days[s.date]
      }
      if (p.id !== id && !Object.keys(days).length) delete entry.for[p.id]
      result.unfit++
    }
    if (entry.for && !Object.keys(entry.for).length) delete entry.for
    result.applied = done.length
    return { entry, result }
  }
  /** "9명 신청, 2명은 이미 신청함, 1명은 마감되어 제외" (건 instead of 명 when several days or meals were asked). */
  function bulkSummary(result, on, many) {
    const u = many ? '건' : '명'
    const parts = [`${result.applied}${u} ${on ? '신청' : '취소'}`]
    if (result.already) parts.push(`${result.already}${u}은 ${on ? '이미 신청함' : '신청하지 않아 그대로'}`)
    if (result.closed) parts.push(`${result.closed}${u}은 마감되어 제외`)
    if (result.firm) parts.push(`${result.firm}${u}은 본인이 '확실히 신청안함'으로 정해 제외`)
    if (result.unfit) parts.push(`${result.unfit}${u}은 저장 공간이 모자라 반영하지 못함`)
    if (result.trimmed) parts.push(`지난 기록 ${result.trimmed}일치를 지움`)
    return parts.join(', ')
  }

  /** Text for ordering: "11/23(월) 점심 3명: 김○○, 이○○, 박○○". */
  function orderText(room, date, members, today) {
    const config = effective(room).config
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
    const rows = [['부서', '이름', '점심', '저녁', '합계'], ...t.rows.map((r) => [r.deptName, r.manual ? `${r.name} (미등록)` : r.name, r.lunch, r.dinner, r.lunch + r.dinner]), ['', '합계', t.lunch, t.dinner, t.lunch + t.dinner]]
    return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
  }

  g.Meal = { cleanPrices, isPriceRoom, pickPriceRoom, effectivePrices, priceAt, monthPrices, savePrices, mealDates, settle, settlement, snapSettlement, wonText, settleCsv, isFirm, firmRefusal, declinedList, firmAny, settled, monthDays, dailyTally, deptTally, monthSummary, personMonth, personMonths, statsSnapshot, betterOf, dailyCsv, deptCsv, personCsv, isManualId, newManualId, cleanPerson, cleanPeople, manualList, roster, nameClash, splitCount, countText, MEALS, MEAL_KEYS, MENU_SLOTS, LIMITS, deptGroups, groupState, bulkSlots, alreadySet, pickStatus, applyBulk, bulkSummary, weekStart, menuWindow, cleanMenuText, cleanMenus, pickSettings, effective, menuOf, menuStamp, weekDays, menuMeals, saveAs, fitMenus, weekText, parseBlock, placeBlock, canManage, ymd, addDays, dateLabel, cleanConfig, isConfig, pickRoom, withHolidays, holidayName, skipped, isServed, cutoffAt, stateOf, upcoming, remaining, cleanEntry, wants, requestedAt, apply, canProxy, applyFor, resolve, recordOf, dayList, monthTally, orderText, monthCsv }
})(typeof window !== 'undefined' ? window : globalThis)
