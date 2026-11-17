/* Saving and merging for 관리대장 (no DOM): what changed since the last save, and how changes
 * made by other people fit into the sheet on screen. Exposed as globalThis.LedgerStore;
 * unit-tested in tests/plugins/ledger-store.test.ts.
 *
 * The sheet on screen is `book = { …head, rows: Row[] }`. Rows are frozen and never changed
 * in place: an edit puts a new row object where the old one was. `shadow` remembers every
 * row as it is stored (same objects), so "what changed" is a comparison of object identity,
 * and undo is a matter of keeping the old array of rows.
 */
;(function (g) {
  'use strict'
  const STEP = 1024
  const MIN_GAP = 1e-6
  /** Rows carried by one save request (the storage refuses more). */
  const CHUNK = 2000
  const CHUNK_IDS = 20000

  const empty = (v) => v === undefined || v === null || v === ''
  const same = (a, b) => (empty(a) && empty(b)) || a === b
  const freezeRow = (r) => {
    Object.freeze(r.c)
    return Object.freeze(r)
  }
  /** Every row frozen (rows made by a change are not yet). */
  function seal(rows) {
    for (let i = 0; i < rows.length; i++) if (!Object.isFrozen(rows[i])) freezeRow(rows[i])
    return rows
  }
  /**
   * The row at index r, ready to be written: a frozen row is replaced by a copy first.
   * Use inside a change only (the copy is frozen again by seal()).
   */
  function writable(book, r) {
    const row = book.rows[r]
    if (!Object.isFrozen(row)) return row
    const copy = { id: row.id, c: Object.assign({}, row.c) }
    book.rows[r] = copy
    return copy
  }

  /** Everything but the rows and the id, as text (compared to see whether the head changed). */
  function headText(book) {
    const head = {}
    for (const k of Object.keys(book)) if (k !== 'rows' && k !== 'id') head[k] = book[k]
    return JSON.stringify(head)
  }

  /** From a stored sheet ({ …head, rows: [{ id, p, c }] }) to the sheet on screen and its shadow. */
  function open(doc, meta) {
    const rows = new Map()
    const pos = new Map()
    const list = []
    ;(doc.rows || []).forEach((r, i) => {
      if (rows.has(r.id)) return
      const row = freezeRow({ id: r.id, c: r.c || {} })
      rows.set(r.id, row)
      pos.set(r.id, typeof r.p === 'number' ? r.p : (i + 1) * STEP)
      list.push(row)
    })
    const book = Object.assign({}, doc, { rows: list })
    return { book, shadow: { head: headText(book), headRev: meta.headRev || 1, version: meta.version || 1, rows, pos } }
  }

  /** A sheet in one piece for a new ledger: rows as plain { id, c } in order. */
  function plain(book) {
    const out = JSON.parse(headText(book))
    out.rows = book.rows.map((r) => ({ id: r.id, c: r.c }))
    return out
  }

  /**
   * A position for every row, in ascending order. Rows keep the position they are stored
   * with where the order allows; the others (new rows, moved rows) are placed between their
   * neighbours. Everything is numbered again when there is no room left between two rows.
   */
  function place(rows, pos) {
    const n = rows.length
    const p = new Array(n)
    const keep = new Array(n)
    let last = -Infinity
    for (let i = 0; i < n; i++) {
      const q = pos.get(rows[i].id)
      if (q !== undefined && q > last) {
        keep[i] = true
        p[i] = q
        last = q
      }
    }
    for (let i = 0; i < n; ) {
      if (keep[i]) {
        i++
        continue
      }
      let j = i
      while (j < n && !keep[j]) j++
      const k = j - i
      const lo = i > 0 ? p[i - 1] : null
      const hi = j < n ? p[j] : null
      if (lo === null && hi === null) for (let x = 0; x < k; x++) p[i + x] = (x + 1) * STEP
      else if (hi === null) for (let x = 0; x < k; x++) p[i + x] = lo + (x + 1) * STEP
      else if (lo === null) for (let x = 0; x < k; x++) p[i + x] = hi - (k - x) * STEP
      else {
        const gap = (hi - lo) / (k + 1)
        if (gap < MIN_GAP) return rows.map((_, x) => (x + 1) * STEP)
        for (let x = 0; x < k; x++) p[i + x] = lo + gap * (x + 1)
      }
      i = j
    }
    return p
  }

  /** What a save has to carry; null when nothing changed. */
  function diff(book, shadow) {
    const rows = book.rows
    const p = place(rows, shadow.pos)
    const d = { head: undefined, headText: headText(book), add: [], set: [], move: [], remove: [], sentRows: new Map(), sentPos: new Map() }
    const seen = new Set()
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (seen.has(row.id)) continue
      seen.add(row.id)
      const base = shadow.rows.get(row.id)
      if (!base) {
        d.add.push({ id: row.id, p: p[i], c: row.c })
        d.sentRows.set(row.id, row)
        d.sentPos.set(row.id, p[i])
        continue
      }
      if (base !== row) {
        const set = {}
        const was = {}
        let any = false
        for (const k of new Set(Object.keys(row.c).concat(Object.keys(base.c)))) {
          if (same(row.c[k], base.c[k])) continue
          set[k] = empty(row.c[k]) ? null : row.c[k]
          was[k] = empty(base.c[k]) ? null : base.c[k]
          any = true
        }
        if (any) {
          d.set.push({ id: row.id, set, was })
          d.sentRows.set(row.id, row)
        } else shadow.rows.set(row.id, row) // same content in a new object
      }
      if (shadow.pos.get(row.id) !== p[i]) {
        d.move.push({ id: row.id, p: p[i] })
        d.sentPos.set(row.id, p[i])
      }
    }
    for (const id of shadow.rows.keys()) if (!seen.has(id)) d.remove.push(id)
    if (d.headText !== shadow.head) d.head = { value: JSON.parse(d.headText), rev: shadow.headRev }
    return d.head || d.add.length || d.set.length || d.move.length || d.remove.length ? d : null
  }

  /** Text one request may carry in its rows (the server reads bodies up to 5 MB). */
  const CHUNK_CHARS = 1500000
  /**
   * A large change in requests the storage accepts: at most CHUNK rows with content and
   * about CHUNK_CHARS of text each. The head and the removed rows go first.
   */
  function pieces(d) {
    const out = []
    const blank = () => ({ head: undefined, add: [], set: [], move: [], remove: [] })
    let cur = blank()
    let rows = 0
    let chars = 0
    const next = () => {
      out.push(cur)
      cur = blank()
      rows = 0
      chars = 0
    }
    const put = (list, item, size) => {
      if (rows && (rows >= CHUNK || chars + size > CHUNK_CHARS)) next()
      cur[list].push(item)
      rows++
      chars += size
    }
    cur.head = d.head
    for (let i = 0; i < d.remove.length; i += CHUNK_IDS) {
      if (cur.remove.length) next()
      cur.remove = d.remove.slice(i, i + CHUNK_IDS)
    }
    for (const a of d.add) put('add', a, JSON.stringify(a.c).length + 60)
    for (const x of d.set) put('set', x, JSON.stringify(x.set).length + JSON.stringify(x.was).length + 60)
    for (let i = 0; i < d.move.length; i += CHUNK_IDS) {
      if (cur.move.length) next()
      cur.move = d.move.slice(i, i + CHUNK_IDS)
    }
    out.push(cur)
    return out
  }

  /**
   * Changes made elsewhere go into the sheet on screen. Mine that are not saved yet stay,
   * except where the same cell was changed by both: then theirs is shown and my row is
   * handed back in `lost` (the caller keeps it for me).
   * refused: Map id → 'changed' | 'gone' of rows my save lost.
   */
  function merge(book, shadow, changes, refused, headRefused) {
    refused = refused || new Map()
    const res = { book, rows: false, head: false, lost: [] }
    const touched = (changes.rows && changes.rows.length) || (changes.gone && changes.gone.length) || refused.size
    if (touched) {
      const rows = book.rows.slice()
      const index = new Map()
      rows.forEach((r, i) => index.set(r.id, i))
      const drop = new Set()
      const insert = []
      let reorder = false
      const gone = (id, mine) => {
        const i = index.get(id)
        const base = shadow.rows.get(id)
        shadow.rows.delete(id)
        shadow.pos.delete(id)
        if (i === undefined || drop.has(id)) return
        if (mine || rows[i] !== base) res.lost.push(rows[i])
        drop.add(id)
      }
      for (const id of changes.gone || []) gone(id, false)
      for (const [id, reason] of refused) if (reason === 'gone') gone(id, true)
      for (const r of changes.rows || []) {
        const remote = freezeRow({ id: r.id, c: r.c || {} })
        const base = shadow.rows.get(r.id)
        const i = index.get(r.id)
        if (shadow.pos.get(r.id) !== r.p) reorder = true
        shadow.rows.set(r.id, remote)
        shadow.pos.set(r.id, r.p)
        if (i === undefined) {
          // a row I do not have: new from someone else — or one I removed (my removal goes with the next save)
          if (!base) insert.push(remote)
          continue
        }
        const cur = rows[i]
        if (refused.get(r.id) === 'changed') {
          res.lost.push(cur)
          rows[i] = remote
          continue
        }
        if (!base || cur === base) {
          rows[i] = remote
          continue
        }
        // both changed this row: my cells stay where theirs did not change the same cell
        const c = Object.assign({}, remote.c)
        let mine = false
        let clash = false
        for (const k of new Set(Object.keys(cur.c).concat(Object.keys(base.c)))) {
          if (same(cur.c[k], base.c[k])) continue
          if (!same(remote.c[k], base.c[k]) && !same(remote.c[k], cur.c[k])) clash = true
          else {
            if (empty(cur.c[k])) delete c[k]
            else c[k] = cur.c[k]
            mine = true
          }
        }
        if (clash) res.lost.push(cur)
        rows[i] = mine ? freezeRow({ id: r.id, c }) : remote
      }
      let list = drop.size ? rows.filter((r) => !drop.has(r.id)) : rows
      if (insert.length || reorder) {
        // by position; my new rows (no position yet) stay behind the row they follow
        list = list.concat(insert)
        const key = new Array(list.length)
        let prev = -Infinity
        for (let i = 0; i < list.length; i++) {
          const q = shadow.pos.get(list[i].id)
          key[i] = q === undefined ? prev : q
          if (i < list.length - insert.length) prev = key[i]
        }
        const known = list.map((r) => shadow.pos.has(r.id))
        // the same order as the storage reads them: by position, then by id
        const order = list.map((_, i) => i).sort((a, b) => key[a] - key[b] || (known[a] && known[b] ? (list[a].id < list[b].id ? -1 : list[a].id > list[b].id ? 1 : 0) : a - b))
        list = order.map((i) => list[i])
      }
      res.book = Object.assign({}, book, { rows: list })
      res.rows = true
    }
    if (changes.head) {
      const mineChanged = headText(res.book) !== shadow.head
      if (!mineChanged || headRefused) {
        const next = Object.assign({}, changes.head, { rows: res.book.rows })
        if (res.book.id !== undefined) next.id = res.book.id
        res.book = next
        res.head = true
        shadow.head = headText(next)
        shadow.headRev = changes.headRev
      }
      // else: my head change is still to be saved; it will be refused and theirs taken then
    }
    if (changes.version > shadow.version) shadow.version = changes.version
    return res
  }

  /** After one request of a save was answered: what was accepted is the new base, then others' changes go in. */
  function settle(book, shadow, piece, d, answer) {
    const refused = new Map((answer.refused && answer.refused.rows ? answer.refused.rows : []).map((x) => [x.id, x.reason]))
    for (const a of piece.add)
      if (!refused.has(a.id)) {
        shadow.rows.set(a.id, d.sentRows.get(a.id))
        shadow.pos.set(a.id, a.p)
      }
    for (const s of piece.set) if (!refused.has(s.id)) shadow.rows.set(s.id, d.sentRows.get(s.id))
    for (const m of piece.move) if (shadow.rows.has(m.id)) shadow.pos.set(m.id, m.p)
    for (const id of piece.remove) {
      shadow.rows.delete(id)
      shadow.pos.delete(id)
    }
    const headRefused = !!(piece.head && answer.refused && answer.refused.head)
    if (piece.head && !headRefused) {
      shadow.head = d.headText
      shadow.headRev = answer.meta.headRev
    }
    const res = merge(book, shadow, answer.changes, refused, headRefused)
    res.headRefused = headRefused
    res.refused = refused.size
    return res
  }

  g.LedgerStore = { STEP, CHUNK, CHUNK_CHARS, seal, writable, headText, open, plain, place, diff, pieces, merge, settle }
})(typeof window !== 'undefined' ? window : globalThis)
