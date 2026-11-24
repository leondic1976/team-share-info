/* Equipment register logic (no DOM). Exposed as globalThis.Bipum; unit-tested in tests/plugins.
 *
 * One register ("대장") = one head room + as many volume rooms as the items need, all made
 * by the same member (the manager). A room's shared data holds at most 64KB on the server and
 * only its creator may write it, so:
 *  - items live in the shared data, packed as arrays, spread over the head and the volumes;
 *  - what every member records themselves (lending, issuing, inventory checks) lives in
 *    their own entry of the head room, and each screen merges all entries. */
;(function (g) {
  'use strict'

  const STATUS = ['사용중', '보관', '수리중', '불용', '폐기']
  const KINDS = ['비품', '소모품']
  const CHECKS = { 1: '확인', 2: '없음', 3: '이상' }
  const DEFAULT_CATS = ['전산장비', '사무기기', '사무가구', '가전제품', '소모품', '기타']
  const LIMITS = { title: 40, name: 60, cat: 20, spec: 80, no: 30, unit: 8, loc: 40, holder: 30, note: 200, qtyMax: 9999999, priceMax: 99999999999, lifeMax: 99, roomBudget: 60000, entryBudget: 60000, volumesMax: 30, importMax: 5000 }
  const DAY = 86400000

  const pad = (n) => String(n).padStart(2, '0')
  const ymd = (ms) => {
    const d = new Date(ms)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  const text = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max)
  const int = (v, max) => {
    const n = Math.round(Number(typeof v === 'string' ? v.replace(/[,\s원개]/g, '') : v))
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0
  }
  /** 2024-03-05, 2024.3.5, 2024/3/5, 20240305 → 2024-03-05; anything else → ''. */
  function cleanDate(v) {
    const s = String(v == null ? '' : v).trim()
    const m = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?\.?$/.exec(s) || /^(\d{4})(\d{2})(\d{2})$/.exec(s)
    if (!m) return ''
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const t = new Date(y, mo - 1, d)
    if (y < 1900 || y > 2200 || t.getMonth() !== mo - 1 || t.getDate() !== d) return ''
    return `${y}-${pad(mo)}-${pad(d)}`
  }
  const addYears = (date, n) => {
    const [y, m, d] = date.split('-').map(Number)
    return ymd(new Date(y + n, m - 1, d).getTime())
  }

  // ---------- items ----------
  const FIELDS = ['id', 'kind', 'name', 'cat', 'spec', 'no', 'qty', 'unit', 'got', 'price', 'life', 'loc', 'holder', 'status', 'min', 'lend', 'note', 'baseAt', 'auditAt']

  /** A valid item from loose input (form, CSV, stored array). `error` when it cannot be one. */
  function cleanItem(input) {
    const c = input && typeof input === 'object' ? input : {}
    const name = text(c.name, LIMITS.name)
    if (!name) return { error: '품명을 입력하세요.' }
    const kind = Number(c.kind) === 1 ? 1 : 0
    const status = Math.round(Number(c.status))
    return {
      item: {
        id: text(c.id, 12),
        kind,
        name,
        cat: text(c.cat, LIMITS.cat),
        spec: text(c.spec, LIMITS.spec),
        no: text(c.no, LIMITS.no),
        qty: int(c.qty, LIMITS.qtyMax),
        unit: text(c.unit, LIMITS.unit) || '개',
        got: cleanDate(c.got),
        // price of one unit
        price: int(c.price, LIMITS.priceMax),
        life: int(c.life, LIMITS.lifeMax),
        loc: text(c.loc, LIMITS.loc),
        holder: text(c.holder, LIMITS.holder),
        status: status >= 0 && status < STATUS.length ? status : 0,
        // consumables: warn when the stock is at or below this
        min: kind === 1 ? int(c.min, LIMITS.qtyMax) : 0,
        // equipment anyone may borrow
        lend: kind === 0 && !!c.lend && c.lend !== '0',
        note: text(c.note, LIMITS.note),
        // consumables: issues recorded after this moment are taken off qty
        baseAt: int(c.baseAt, 9e15),
        auditAt: cleanDate(c.auditAt)
      }
    }
  }
  const pack = (it) => FIELDS.map((f) => (f === 'lend' ? (it.lend ? 1 : 0) : it[f]))
  function unpack(a) {
    if (!Array.isArray(a)) return null
    const o = {}
    FIELDS.forEach((f, i) => (o[f] = a[i]))
    const r = cleanItem(o)
    return r.item && r.item.id ? r.item : null
  }
  function makeId(taken, rand) {
    const r = rand || Math.random
    for (;;) {
      const id = Math.floor(r() * 36 ** 6)
        .toString(36)
        .padStart(6, '0')
      if (!taken.has(id)) return id
    }
  }

  // ---------- rooms ----------
  const isHead = (r) => !!r && !!r.shared && r.shared.kind === 'bipum' && r.shared.t === 'head'
  const isVol = (r) => !!r && !!r.shared && r.shared.kind === 'bipum' && r.shared.t === 'vol' && typeof r.shared.head === 'string'
  const cleanAudit = (a) => (a && typeof a === 'object' && typeof a.id === 'string' && a.id ? { id: text(a.id, 12), title: text(a.title, LIMITS.title) || '재물조사', at: int(a.at, 9e15) } : null)
  function cleanLast(a) {
    if (!a || typeof a !== 'object' || !a.closedAt) return null
    const o = { title: text(a.title, LIMITS.title), at: int(a.at, 9e15), closedAt: int(a.closedAt, 9e15) }
    for (const k of ['total', 'ok', 'missing', 'bad', 'todo', 'diff']) o[k] = int(a[k], 1e7)
    return o
  }
  const headShared = (meta, items) => ({ kind: 'bipum', v: 1, t: 'head', audit: cleanAudit(meta && meta.audit), last: cleanLast(meta && meta.last), items: items.map(pack) })
  const volShared = (headId, items) => ({ kind: 'bipum', v: 1, t: 'vol', head: headId, items: items.map(pack) })

  /**
   * Registers among the rooms I can see. A volume counts only when the manager of the
   * register made it: anybody can create a room, nobody else may add items this way.
   */
  function books(rooms) {
    const list = (Array.isArray(rooms) ? rooms : []).filter(isHead).sort((a, b) => a.createdAt - b.createdAt)
    return list.map((head) => ({
      head,
      vols: rooms.filter((r) => isVol(r) && r.shared.head === head.id && r.createdBy === head.createdBy).sort((a, b) => a.createdAt - b.createdAt)
    }))
  }
  /** The register a room id belongs to (an invitation may point at a volume). */
  const bookOf = (list, roomId) => list.find((b) => b.head.id === roomId || b.vols.some((v) => v.id === roomId)) || null
  const roomItems = (r) => (Array.isArray(r.shared.items) ? r.shared.items : []).map(unpack).filter(Boolean)
  /** Every item of a register; the first one wins should an id ever appear twice. */
  function itemsOf(book) {
    const seen = new Set()
    const out = []
    for (const r of [book.head, ...book.vols])
      for (const it of roomItems(r)) {
        if (seen.has(it.id)) continue
        seen.add(it.id)
        out.push(it)
      }
    return out
  }
  const scopeInput = (scope) => ({ type: scope && scope.type === 'members' ? 'members' : scope && scope.type === 'group' ? 'group' : 'team', groupIds: ((scope && scope.groups) || []).map((x) => x.id), memberIds: ((scope && scope.members) || []).map((x) => x.id) })

  /**
   * Spread the given items over the rooms of a register within the size limit of a room.
   * An item stays in the room it is in while it fits; new and displaced items fill the free
   * space; what is left opens new volumes. Returns only what has to be written:
   *   { writes: [{ roomId, version, shared }], creates: [shared], error? }
   */
  function distribute(book, items, meta) {
    const m = meta || { audit: book.head.shared.audit, last: book.head.shared.last }
    const rooms = [book.head, ...book.vols]
    const buckets = rooms.map((r, i) => ({ room: r, items: [], size: JSON.stringify(i === 0 ? headShared(m, []) : volShared(book.head.id, [])).length }))
    const home = new Map()
    rooms.forEach((r, i) => roomItems(r).forEach((it) => home.has(it.id) || home.set(it.id, i)))
    const cost = (it) => JSON.stringify(pack(it)).length + 1
    const fits = (b, it) => b.size + cost(it) <= LIMITS.roomBudget
    const put = (b, it) => {
      b.items.push(it)
      b.size += cost(it)
    }
    const waiting = []
    for (const it of items) {
      const b = buckets[home.get(it.id)]
      if (b && fits(b, it)) put(b, it)
      else waiting.push(it)
    }
    for (const it of waiting) {
      let b = buckets.find((x) => fits(x, it))
      if (!b) {
        if (buckets.length > LIMITS.volumesMax) return { writes: [], creates: [], error: '대장이 가득 찼습니다. 폐기한 물품을 지우거나 새 대장을 만드세요.' }
        b = { room: null, items: [], size: JSON.stringify(volShared(book.head.id, [])).length }
        buckets.push(b)
      }
      put(b, it)
    }
    const writes = []
    const creates = []
    buckets.forEach((b, i) => {
      const shared = i === 0 ? headShared(m, b.items) : volShared(book.head.id, b.items)
      if (!b.room) creates.push(shared)
      else if (JSON.stringify(shared) !== JSON.stringify(b.room.shared)) writes.push({ roomId: b.room.id, version: b.room.version, shared, gain: b.items.length - roomItems(b.room).length })
    })
    // rooms that gain items are written first: if a later write fails, an item that moved is
    // in two rooms for a moment (itemsOf keeps one) instead of in none
    writes.sort((a, b) => b.gain - a.gain)
    return { writes, creates }
  }

  // ---------- members' records: lending, issuing ----------
  // loan: [id, type(0 lend, 1 issue), itemId, qty, at, due, backAt, note, who]
  function cleanLoan(a) {
    if (!Array.isArray(a) || typeof a[0] !== 'string' || !a[0] || typeof a[2] !== 'string' || !a[2]) return null
    const qty = int(a[3], LIMITS.qtyMax)
    if (!qty) return null
    return { id: text(a[0], 12), type: Number(a[1]) === 1 ? 1 : 0, itemId: text(a[2], 12), qty, at: int(a[4], 9e15), due: cleanDate(a[5]), backAt: int(a[6], 9e15), note: text(a[7], LIMITS.note), who: text(a[8], LIMITS.holder) }
  }
  const packLoan = (l) => [l.id, l.type, l.itemId, l.qty, l.at, l.due, l.backAt, l.note, l.who]
  function cleanCheck(a) {
    if (!Array.isArray(a) || !CHECKS[a[0]]) return null
    return [Number(a[0]), int(a[1], LIMITS.qtyMax), text(a[2], LIMITS.note), int(a[3], 9e15)]
  }
  /** A member's entry: { v, loans, ret, audit }. */
  function cleanEntry(v) {
    const c = v && typeof v === 'object' ? v : {}
    const ret = {}
    if (c.ret && typeof c.ret === 'object') for (const [k, at] of Object.entries(c.ret)) if (/^[\w-]{1,60}:[\w-]{1,12}$/.test(k) && int(at, 9e15)) ret[k] = int(at, 9e15)
    let audit = null
    if (c.audit && typeof c.audit === 'object' && typeof c.audit.id === 'string' && c.audit.c && typeof c.audit.c === 'object') {
      const checks = {}
      for (const [k, a] of Object.entries(c.audit.c)) {
        const ch = cleanCheck(a)
        if (ch && /^[\w-]{1,12}$/.test(k)) checks[k] = ch
      }
      audit = { id: text(c.audit.id, 12), c: checks }
    }
    return { v: 1, loans: (Array.isArray(c.loans) ? c.loans : []).map(cleanLoan).filter(Boolean).map(packLoan), ret, audit }
  }
  const entryOf = (head, memberId) => cleanEntry(head && head.entries && head.entries[memberId] ? head.entries[memberId].value : null)

  /**
   * Everybody's records, newest first. A loan is back when the borrower returned it, or when
   * the manager of the register marked it returned (in the manager's own entry).
   */
  function allLoans(head) {
    const entries = (head && head.entries) || {}
    const manager = entries[head.createdBy] ? cleanEntry(entries[head.createdBy].value).ret : {}
    const out = []
    for (const [memberId, e] of Object.entries(entries))
      for (const a of cleanEntry(e.value).loans) {
        const l = cleanLoan(a)
        const key = `${memberId}:${l.id}`
        const backAt = l.type === 1 ? 0 : l.backAt || manager[key] || 0
        out.push({ ...l, key, memberId, by: e.name, name: l.who || e.name, backAt, open: l.type === 0 && !backAt })
      }
    return out.sort((a, b) => b.at - a.at)
  }
  // records by item, worked out once per list (a list from allLoans is never changed afterwards)
  const byItem = new WeakMap()
  const NONE = []
  function of(loans, itemId) {
    let m = byItem.get(loans)
    if (!m) {
      m = new Map()
      for (const l of loans) {
        if (m.has(l.itemId)) m.get(l.itemId).push(l)
        else m.set(l.itemId, [l])
      }
      byItem.set(loans, m)
    }
    return m.get(itemId) || NONE
  }
  /** Units out on loan right now. */
  const outQty = (loans, itemId) => of(loans, itemId).reduce((n, l) => (l.open ? n + l.qty : n), 0)
  /** Units of a consumable issued since its quantity was last counted. */
  const issuedQty = (loans, item) => of(loans, item.id).reduce((n, l) => (l.type === 1 && l.at > item.baseAt ? n + l.qty : n), 0)
  /** What is on the shelf: consumables minus what was issued, equipment minus what is lent. */
  const stockOf = (item, loans) => Math.max(0, item.qty - (item.kind === 1 ? issuedQty(loans, item) : outQty(loans, item.id)))
  const isLow = (item, loans) => item.kind === 1 && item.min > 0 && item.status < 3 && stockOf(item, loans) <= item.min
  const isOverdue = (loan, today) => loan.open && !!loan.due && loan.due < today
  const lifeEnd = (item) => (item.life > 0 && item.got ? addYears(item.got, item.life) : '')
  /** Past its service life and still on the books. */
  const lifeOver = (item, today) => item.status < 4 && !!lifeEnd(item) && lifeEnd(item) <= today

  /** Drop the oldest records that no longer matter until the entry fits the server's limit. */
  function fitEntry(entry, items) {
    const size = (e) => JSON.stringify(e).length
    if (size(entry) <= LIMITS.entryBudget) return { entry }
    const byId = new Map(items.map((it) => [it.id, it]))
    const loans = entry.loans.map(cleanLoan)
    // oldest first: returned loans, and issues already taken into the counted quantity
    const droppable = loans.filter((l) => !byId.has(l.itemId) || (l.type === 0 ? l.backAt : l.at <= byId.get(l.itemId).baseAt)).sort((a, b) => a.at - b.at)
    const gone = new Set()
    for (const l of droppable) {
      gone.add(l.id)
      const e = { ...entry, loans: loans.filter((x) => !gone.has(x.id)).map(packLoan) }
      if (size(e) <= LIMITS.entryBudget) return { entry: e }
    }
    return { error: '내 기록이 가득 찼습니다. 담당자에게 소모품 재고 정리(입고·재고 조정)를 요청하세요.' }
  }

  /**
   * Lend (equipment) or issue (consumable) an item. `req`: { qty, due, note, who }.
   * `who` is set when the manager records it for somebody else.
   */
  function takeOut(entry, item, loans, req, now, rand) {
    if (item.status >= 2) return { error: `${STATUS[item.status]} 상태인 물품은 ${item.kind === 1 ? '지급' : '대여'}할 수 없습니다.` }
    if (item.kind === 0 && !item.lend) return { error: '대여용으로 등록된 물품만 대여할 수 있습니다.' }
    const qty = int(req && req.qty, LIMITS.qtyMax)
    if (!qty) return { error: '수량을 1 이상으로 입력하세요.' }
    const left = stockOf(item, loans)
    if (qty > left) return { error: `남은 수량은 ${left}${item.unit}입니다.` }
    const e = cleanEntry(entry)
    const id = makeId(new Set(e.loans.map((l) => l[0])), rand)
    const loan = { id, type: item.kind === 1 ? 1 : 0, itemId: item.id, qty, at: now, due: item.kind === 1 ? '' : cleanDate(req && req.due), backAt: 0, note: text(req && req.note, LIMITS.note), who: text(req && req.who, LIMITS.holder) }
    return { entry: { ...e, loans: [...e.loans, packLoan(loan)] }, loan }
  }
  /** Return my own loan. */
  function giveBack(entry, loanId, now) {
    const e = cleanEntry(entry)
    let found = false
    const loans = e.loans.map((a) => {
      if (a[0] !== loanId || a[1] !== 0 || a[6]) return a
      found = true
      const n = a.slice()
      n[6] = now
      return n
    })
    return found ? { entry: { ...e, loans } } : { error: '반납할 대여 기록을 찾지 못했습니다.' }
  }
  /** The manager marks somebody else's loan as returned. */
  function markReturned(entry, loanKey, now) {
    const e = cleanEntry(entry)
    return { entry: { ...e, ret: { ...e.ret, [loanKey]: now } } }
  }
  /** Take one of my records back (a mistake). Issues already counted into the stock stay. */
  function cancelLoan(entry, loanId) {
    const e = cleanEntry(entry)
    return { entry: { ...e, loans: e.loans.filter((a) => a[0] !== loanId) } }
  }

  // ---------- inventory check (재물조사) ----------
  /** Items an inventory check covers: everything not written off as disposed. */
  const auditTargets = (items) => items.filter((it) => it.status < 4)
  /** What the books say should be there: consumables minus what was issued; equipment as registered (lent units included). */
  const expected = (item, loans) => (item.kind === 1 ? stockOf(item, loans) : item.qty)
  /** My check of one item. `check`: { code: 1 확인 | 2 없음 | 3 이상 | 0 지움, qty, note }. */
  function setCheck(entry, audit, item, check, now, loans) {
    if (!audit) return { error: '진행 중인 재물조사가 없습니다.' }
    const e = cleanEntry(entry)
    const mine = e.audit && e.audit.id === audit.id ? { ...e.audit.c } : {}
    const code = Number(check && check.code)
    if (!CHECKS[code]) delete mine[item.id]
    else mine[item.id] = [code, code === 2 ? 0 : check.qty === undefined || check.qty === '' || check.qty === null ? expected(item, loans || []) : int(check.qty, LIMITS.qtyMax), text(check.note, LIMITS.note), now]
    return { entry: { ...e, audit: { id: audit.id, c: mine } } }
  }
  /** The newest check of every item, whoever made it: Map(itemId → { code, qty, note, at, memberId, name }). */
  function auditMap(head) {
    const audit = cleanAudit(head && head.shared && head.shared.audit)
    const map = new Map()
    if (!audit) return map
    for (const [memberId, e] of Object.entries((head && head.entries) || {})) {
      const a = cleanEntry(e.value).audit
      if (!a || a.id !== audit.id) continue
      for (const [itemId, c] of Object.entries(a.c)) {
        const have = map.get(itemId)
        if (!have || c[3] > have.at) map.set(itemId, { code: c[0], qty: c[1], note: c[2], at: c[3], memberId, name: e.name })
      }
    }
    return map
  }
  function auditStats(items, map, loans) {
    const s = { total: 0, ok: 0, missing: 0, bad: 0, todo: 0, diff: 0 }
    for (const it of auditTargets(items)) {
      s.total++
      const c = map.get(it.id)
      if (!c) s.todo++
      else if (c.code === 2) s.missing++
      else {
        if (c.code === 3) s.bad++
        else s.ok++
        if (c.qty !== expected(it, loans || [])) s.diff++
      }
    }
    return s
  }
  /**
   * Close the check: every item that was found gets the date; a consumable takes the counted
   * quantity as its new stock. Equipment keeps its quantity: a difference there is for the
   * manager to settle (the result lists it). Returns { items, last }.
   */
  function closeAudit(items, map, audit, now, loans) {
    const targets = new Set(auditTargets(items).map((it) => it.id))
    const out = items.map((it) => {
      const c = targets.has(it.id) ? map.get(it.id) : null
      if (!c || c.code === 2) return it
      const n = { ...it, auditAt: ymd(c.at || now) }
      if (it.kind === 1) {
        // the count becomes the stock; issues recorded after the count still come off
        n.qty = c.qty
        n.baseAt = c.at
      }
      return n
    })
    return { items: out, last: { title: audit.title, at: audit.at, closedAt: now, ...auditStats(items, map, loans) } }
  }

  // ---------- list: search, filter, sort, summary ----------
  /** f: { q, cat, status, loc, kind, flag: 'low' | 'over' | 'out' | 'lend' }; '' means any. */
  function filterItems(items, filter, ctx) {
    const f = filter || {}
    const loans = (ctx && ctx.loans) || []
    const today = (ctx && ctx.today) || ''
    const words = text(f.q, 100).toLowerCase().split(' ').filter(Boolean)
    const has = (v) => v !== undefined && v !== null && v !== ''
    return items.filter((it) => {
      if (has(f.cat) && it.cat !== f.cat) return false
      if (has(f.loc) && it.loc !== f.loc) return false
      if (has(f.status) && it.status !== Number(f.status)) return false
      // the disposed stay out of sight unless asked for
      if (!has(f.status) && !f.all && it.status === 4) return false
      if (has(f.kind) && it.kind !== Number(f.kind)) return false
      if (f.flag === 'low' && !isLow(it, loans)) return false
      if (f.flag === 'over' && !lifeOver(it, today)) return false
      if (f.flag === 'out' && !outQty(loans, it.id)) return false
      if (f.flag === 'lend' && !(it.lend && it.status < 2)) return false
      if (!words.length) return true
      const hay = [it.name, it.cat, it.spec, it.no, it.loc, it.holder, it.note].join(' ').toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }
  function sortItems(items, key, dir, ctx) {
    const loans = (ctx && ctx.loans) || []
    const num = { qty: (it) => it.qty, price: (it) => it.price, amount: (it) => it.price * it.qty, life: (it) => it.life, status: (it) => it.status, kind: (it) => it.kind, stock: (it) => stockOf(it, loans) }
    const d = dir === 'desc' ? -1 : 1
    // "의자 2" before "의자 10"
    const byName = (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }) || a.no.localeCompare(b.no, 'ko', { numeric: true })
    return [...items].sort((a, b) => {
      let c
      if (num[key]) c = num[key](a) - num[key](b)
      else if (key === 'name') return d * byName(a, b)
      else {
        const [x, y] = [String(a[key] || ''), String(b[key] || '')]
        // blanks last, whichever way the column is sorted
        if (!x !== !y) return x ? -1 : 1
        c = x.localeCompare(y, 'ko', { numeric: true })
      }
      return d * c || byName(a, b)
    })
  }
  function summary(items, loans, today) {
    const live = items.filter((it) => it.status < 4)
    const group = (keyOf) => {
      const m = new Map()
      for (const it of live) {
        const k = keyOf(it)
        const r = m.get(k) || { name: k, count: 0, qty: 0, amount: 0 }
        r.count++
        r.qty += it.qty
        r.amount += it.price * it.qty
        m.set(k, r)
      }
      return [...m.values()]
    }
    return {
      count: live.length,
      qty: live.reduce((n, it) => n + it.qty, 0),
      amount: live.reduce((n, it) => n + it.price * it.qty, 0),
      disposed: items.length - live.length,
      low: live.filter((it) => isLow(it, loans)).length,
      out: loans.filter((l) => l.open).length,
      overdue: loans.filter((l) => isOverdue(l, today)).length,
      over: live.filter((it) => lifeOver(it, today)).length,
      byCat: group((it) => it.cat || '분류 없음').sort((a, b) => b.amount - a.amount || b.count - a.count || a.name.localeCompare(b.name, 'ko')),
      byStatus: STATUS.map((name, i) => ({ name, count: items.filter((it) => it.status === i).length, qty: items.filter((it) => it.status === i).reduce((n, it) => n + it.qty, 0) })),
      byLoc: group((it) => it.loc || '위치 없음').sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko'))
    }
  }
  /** Choices for the 분류 and 위치 boxes: what the items use, plus the usual categories. */
  const catsOf = (items) => Array.from(new Set([...items.map((it) => it.cat).filter(Boolean), ...DEFAULT_CATS])).sort((a, b) => a.localeCompare(b, 'ko'))
  const locsOf = (items) => Array.from(new Set(items.map((it) => it.loc).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }))

  // ---------- CSV (Excel: UTF-8 with BOM, CRLF) ----------
  const COLUMNS = [
    ['kind', '구분', ['종류']],
    ['name', '품명', ['물품명', '품목', '품목명', '비품명']],
    ['cat', '분류', ['분류명', '물품분류']],
    ['spec', '규격·모델', ['규격', '모델', '모델명', '규격/모델', '규격모델']],
    ['no', '관리번호', ['물품번호', '자산번호', '물품관리번호', '번호']],
    ['qty', '수량', ['보유수량', '재고']],
    ['unit', '단위', []],
    ['got', '취득일', ['취득일자', '구입일', '구입일자', '구매일']],
    ['price', '취득가액', ['취득단가', '단가', '취득가액(단가)', '구입가', '구입가격']],
    ['life', '내용연수', ['내용연수(년)']],
    ['loc', '보관 위치', ['위치', '보관위치', '보관장소', '설치장소', '장소']],
    ['holder', '사용자', ['담당자', '담당자/사용자', '사용자(담당자)', '관리자']],
    ['status', '상태', []],
    ['min', '최소 재고', ['최소재고', '안전재고']],
    ['lend', '대여용', ['대여', '공용']],
    ['note', '비고', ['메모']]
  ]
  // a cell beginning with = + - @ would run as a formula in Excel
  const csvCell = (v) => {
    const s = /^[=+\-@\t\r]/.test(String(v)) && typeof v !== 'number' ? `'${v}` : String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csvText = (rows) => '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
  const itemRow = (it) => [KINDS[it.kind], it.name, it.cat, it.spec, it.no, it.qty, it.unit, it.got, it.price || '', it.life || '', it.loc, it.holder, STATUS[it.status], it.kind === 1 && it.min ? it.min : '', it.lend ? 'O' : '', it.note]
  /** The register as a file that can be read back by importCsv; the last columns are for reading only. */
  function toCsv(items, ctx) {
    const loans = (ctx && ctx.loans) || []
    return csvText([[...COLUMNS.map((c) => c[1]), '금액', '현재 재고', '대여 중', '내용연수 만료일', '최근 조사일'], ...items.map((it) => [...itemRow(it), it.price * it.qty || '', stockOf(it, loans), outQty(loans, it.id) || '', lifeEnd(it), it.auditAt])])
  }
  const templateCsv = () =>
    csvText([
      COLUMNS.map((c) => c[1]),
      ['비품', '노트북', '전산장비', 'LG gram 16', '2025-전산-001', 1, '대', '2025-03-10', 1850000, 5, '3층 사무실', '홍길동', '사용중', '', '', ''],
      ['비품', '빔프로젝터', '사무기기', 'EB-X51', '2023-사무-004', 1, '대', '2023-06-01', 720000, 6, '회의실 캐비닛', '', '보관', '', 'O', '공용 대여'],
      ['소모품', 'A4 복사용지', '소모품', '80g 2500매', '', 12, '박스', '', 24000, '', '탕비실 창고', '', '사용중', 3, '', '']
    ])
  /** Rows of a CSV or tab-separated text; quotes and line breaks inside quotes are honoured. */
  function parseCsv(input) {
    const s = String(input || '').replace(/^\uFEFF/, '')
    const first = s.split(/\r?\n/, 1)[0]
    const sep = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ','
    const rows = []
    let row = []
    let cell = ''
    let quoted = false
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (quoted) {
        if (ch === '"' && s[i + 1] === '"') cell += s[++i]
        else if (ch === '"') quoted = false
        else cell += ch
      } else if (ch === '"' && cell === '') quoted = true
      else if (ch === sep) {
        row.push(cell)
        cell = ''
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++
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
    return rows.filter((r) => r.some((c) => c.trim() !== ''))
  }
  const norm = (h) => String(h).replace(/[\s·_\-()]/g, '').replace(/^'/, '').toLowerCase()
  /**
   * Read items from a CSV. A row whose 관리번호 is already in the register updates that item;
   * every other row is a new item. Returns { items (the whole new list), added, updated,
   * skipped: [{ line, reason }], error? }.
   */
  function importCsv(input, existing, rand) {
    const rows = parseCsv(input)
    if (rows.length < 2) return { error: '내용이 없습니다. 첫 줄은 제목(품명, 수량 …), 둘째 줄부터 물품입니다.' }
    const head = rows[0].map(norm)
    const col = {}
    for (const [key, label, alias] of COLUMNS) {
      const names = [label, ...alias].map(norm)
      const i = head.findIndex((h) => names.includes(h))
      if (i >= 0) col[key] = i
    }
    if (col.name === undefined) return { error: '첫 줄에 "품명" 열이 있어야 합니다.' }
    if (rows.length - 1 > LIMITS.importMax) return { error: `한 번에 ${LIMITS.importMax.toLocaleString('ko-KR')}줄까지 가져올 수 있습니다.` }
    const items = existing.slice()
    const byNo = new Map(items.map((it, i) => [it.no, i]).filter(([no]) => no))
    const taken = new Set(items.map((it) => it.id))
    const skipped = []
    let added = 0
    let updated = 0
    rows.slice(1).forEach((r, n) => {
      const get = (k) => (col[k] === undefined ? undefined : String(r[col[k]] == null ? '' : r[col[k]]).trim().replace(/^'(?=[=+\-@])/, ''))
      const raw = {}
      for (const [key] of COLUMNS) if (get(key) !== undefined) raw[key] = get(key)
      // an empty 구분 or 상태 cell keeps what the item has
      if (raw.kind === '') delete raw.kind
      else if (raw.kind !== undefined) raw.kind = /소모/.test(raw.kind) ? 1 : 0
      if (raw.status === '') delete raw.status
      else if (raw.status !== undefined) raw.status = Math.max(0, STATUS.indexOf(raw.status.replace(/\s/g, '')))
      if (raw.lend !== undefined) raw.lend = /^(o|y|yes|예|가능|대여|1|true|○|ㅇ)$/i.test(raw.lend)
      const at = raw.no ? byNo.get(text(raw.no, LIMITS.no)) : undefined
      const base = at === undefined ? {} : items[at]
      const c = cleanItem({ ...base, ...raw })
      if (c.error) return void skipped.push({ line: n + 2, reason: c.error })
      if (raw.got && !c.item.got) skipped.push({ line: n + 2, reason: `취득일 "${raw.got}"을(를) 읽지 못해 비워 두었습니다.` })
      if (at !== undefined) {
        items[at] = c.item
        updated++
      } else {
        c.item.id = makeId(taken, rand)
        taken.add(c.item.id)
        if (c.item.no) byNo.set(c.item.no, items.length)
        items.push(c.item)
        added++
      }
    })
    return { items, added, updated, skipped }
  }
  /** History (대여·지급 이력) as a file. */
  function loansCsv(loans, items) {
    const byId = new Map(items.map((it) => [it.id, it]))
    const dt = (ms) => (ms ? `${ymd(ms)} ${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}` : '')
    return csvText([
      ['구분', '일시', '품명', '관리번호', '수량', '단위', '받은 사람', '기록한 사람', '반납 예정일', '반납 일시', '상태', '비고'],
      ...loans.map((l) => {
        const it = byId.get(l.itemId)
        return [l.type === 1 ? '지급' : '대여', dt(l.at), it ? it.name : '(지운 물품)', it ? it.no : '', l.qty, it ? it.unit : '', l.name, l.by, l.due, dt(l.backAt), l.type === 1 ? '지급' : l.open ? '대여 중' : '반납', l.note]
      })
    ])
  }
  /** Result of the running inventory check as a file. */
  function auditCsv(items, map, loans) {
    const dt = (ms) => (ms ? ymd(ms) : '')
    return csvText([
      ['관리번호', '품명', '규격·모델', '분류', '보관 위치', '사용자', '장부 수량', '조사 수량', '결과', '조사한 사람', '조사일', '메모'],
      ...auditTargets(items).map((it) => {
        const c = map.get(it.id)
        return [it.no, it.name, it.spec, it.cat, it.loc, it.holder, expected(it, loans || []), c ? c.qty : '', c ? CHECKS[c.code] : '미확인', c ? c.name : '', c ? dt(c.at) : '', c ? c.note : '']
      })
    ])
  }

  // ---------- backup: hand a register over to a new manager ----------
  const BACKUP = 'teamhub-bipum@1'
  /** Consumables are saved with the stock of this moment: the new register starts without records. */
  const toBackup = (title, items, loans) => JSON.stringify({ format: BACKUP, title, items: items.map((it) => ({ ...it, qty: it.kind === 1 ? stockOf(it, loans || []) : it.qty, baseAt: 0 })) }, null, 1)
  function fromBackup(input) {
    let j
    try {
      j = JSON.parse(String(input || '').replace(/^\uFEFF/, ''))
    } catch {
      return { error: '백업 파일을 읽지 못했습니다.' }
    }
    if (!j || j.format !== BACKUP || !Array.isArray(j.items)) return { error: '비품관리대장 백업 파일이 아닙니다.' }
    const taken = new Set()
    const items = []
    for (const raw of j.items) {
      const c = cleanItem(raw)
      if (!c.item) continue
      if (!c.item.id || taken.has(c.item.id)) c.item.id = makeId(taken)
      taken.add(c.item.id)
      items.push(c.item)
    }
    return { title: text(j.title, LIMITS.title), items }
  }

  g.Bipum = { STATUS, KINDS, CHECKS, DEFAULT_CATS, LIMITS, COLUMNS, DAY, ymd, cleanDate, addYears, cleanItem, pack, unpack, makeId, isHead, isVol, headShared, volShared, books, bookOf, itemsOf, scopeInput, distribute, cleanEntry, entryOf, allLoans, outQty, issuedQty, stockOf, isLow, isOverdue, lifeEnd, lifeOver, fitEntry, takeOut, giveBack, markReturned, cancelLoan, auditTargets, expected, setCheck, auditMap, auditStats, closeAudit, filterItems, sortItems, summary, catsOf, locsOf, csvText, toCsv, templateCsv, parseCsv, importCsv, loansCsv, auditCsv, toBackup, fromBackup }
})(typeof window !== 'undefined' ? window : globalThis)
