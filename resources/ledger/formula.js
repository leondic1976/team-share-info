/* Formula engine for 스마트 대장 (no DOM). Exposed as globalThis.LedgerFormula; unit-tested in tests/plugins.
 *
 * Syntax (Excel-like):
 *   =A1+B2*2   =SUM(B1:B10)   =IF([수량]>0, [단가]*[수량], "")   =SUM([금액])   ="합계: "&TEXT(SUM([금액]),"#,##0")
 * References:
 *   A1, $A$1, A1:C5     column letter = column order, row number = data row (1 = first row)
 *   [열 이름]            the whole column; used as a single value it means "this row" (like Excel's implicit intersection)
 *   [@열 이름]           this row's value
 * Dates are kept as "YYYY-MM-DD" text and turn into day numbers (Excel serials) in arithmetic.
 */
;(function (g) {
  'use strict'

  class FErr {
    constructor(code) {
      this.code = code
    }
    toString() {
      return this.code
    }
  }
  const ERR = {
    div0: new FErr('#DIV/0!'),
    value: new FErr('#VALUE!'),
    ref: new FErr('#REF!'),
    name: new FErr('#NAME?'),
    na: new FErr('#N/A'),
    cycle: new FErr('#CYCLE!'),
    num: new FErr('#NUM!'),
    parse: new FErr('#ERROR!')
  }
  const isErr = (v) => v instanceof FErr

  // ---------- dates (Excel serial: days since 1899-12-30) ----------
  const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/
  const EPOCH = Date.UTC(1899, 11, 30)
  function dateToSerial(s) {
    const m = DATE_RE.exec(String(s).trim())
    if (!m) return null
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3])
    const d = new Date(t)
    if (d.getUTCMonth() !== +m[2] - 1) return null
    return Math.round((t - EPOCH) / 86400000)
  }
  function serialToDate(n) {
    const d = new Date(EPOCH + Math.floor(n) * 86400000)
    const p = (x) => String(x).padStart(2, '0')
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
  }
  function todaySerial() {
    const n = new Date()
    return Math.round((Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) - EPOCH) / 86400000)
  }

  // ---------- tokenizer ----------
  function tokenize(src) {
    const out = []
    let i = 0
    while (i < src.length) {
      const c = src[i]
      if (/\s/.test(c)) {
        i++
        continue
      }
      if (c === '"') {
        let j = i + 1
        let s = ''
        for (;;) {
          if (j >= src.length) throw ERR.parse
          if (src[j] === '"') {
            if (src[j + 1] === '"') {
              s += '"'
              j += 2
              continue
            }
            break
          }
          s += src[j++]
        }
        out.push({ t: 'str', v: s })
        i = j + 1
        continue
      }
      if (c === '[') {
        const j = src.indexOf(']', i)
        if (j < 0) throw ERR.parse
        let name = src.slice(i + 1, j).trim()
        const row = name.startsWith('@')
        if (row) name = name.slice(1).trim()
        out.push({ t: 'col', v: name, row })
        i = j + 1
        continue
      }
      const num = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))
      if (num) {
        out.push({ t: 'num', v: parseFloat(num[0]) })
        i += num[0].length
        continue
      }
      const ref = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?(?![\w(])/.exec(src.slice(i))
      if (ref) {
        out.push({ t: 'ref', c1: ref[1].toUpperCase(), r1: +ref[2], c2: ref[3] ? ref[3].toUpperCase() : null, r2: ref[4] ? +ref[4] : null })
        i += ref[0].length
        continue
      }
      const id = /^[A-Za-z_가-힣][\w.가-힣]*/.exec(src.slice(i))
      if (id) {
        out.push({ t: 'id', v: id[0].toUpperCase() })
        i += id[0].length
        continue
      }
      const two = src.slice(i, i + 2)
      if (two === '<=' || two === '>=' || two === '<>') {
        out.push({ t: 'op', v: two })
        i += 2
        continue
      }
      if ('+-*/^&=<>%(),;:'.includes(c)) {
        out.push({ t: c === '(' || c === ')' || c === ',' || c === ';' ? c.replace(';', ',') : 'op', v: c })
        i++
        continue
      }
      throw ERR.parse
    }
    return out
  }

  // ---------- parser (precedence climbing) ----------
  const BIN = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 }
  function parse(src) {
    const toks = tokenize(src)
    let p = 0
    const peek = () => toks[p]
    const next = () => toks[p++]
    function primary() {
      const t = next()
      if (!t) throw ERR.parse
      if (t.t === 'num') return { k: 'num', v: t.v }
      if (t.t === 'str') return { k: 'str', v: t.v }
      if (t.t === 'col') return { k: 'col', name: t.v, row: t.row }
      if (t.t === 'ref') return t.c2 ? { k: 'range', c1: t.c1, r1: t.r1, c2: t.c2, r2: t.r2 } : { k: 'cell', c: t.c1, r: t.r1 }
      if (t.t === 'op' && (t.v === '-' || t.v === '+')) return { k: 'neg', neg: t.v === '-', e: unary() }
      if (t.t === '(') {
        const e = expr(0)
        if (!peek() || peek().t !== ')') throw ERR.parse
        next()
        return e
      }
      if (t.t === 'id') {
        if (peek() && peek().t === '(') {
          next()
          const args = []
          if (peek() && peek().t === ')') next()
          else {
            for (;;) {
              if (peek() && (peek().t === ',' || peek().t === ')')) args.push({ k: 'empty' })
              else args.push(expr(0))
              const s = next()
              if (!s) throw ERR.parse
              if (s.t === ')') break
              if (s.t !== ',') throw ERR.parse
            }
          }
          return { k: 'fn', name: t.v, args }
        }
        if (t.v === 'TRUE') return { k: 'bool', v: true }
        if (t.v === 'FALSE') return { k: 'bool', v: false }
        return { k: 'name', v: t.v }
      }
      throw ERR.parse
    }
    function unary() {
      let e = primary()
      while (peek() && peek().t === 'op' && peek().v === '%') {
        next()
        e = { k: 'pct', e }
      }
      return e
    }
    function expr(min) {
      let left = unary()
      for (;;) {
        const t = peek()
        if (!t || t.t !== 'op' || !(t.v in BIN) || BIN[t.v] < min) break
        next()
        const prec = BIN[t.v]
        const right = expr(t.v === '^' ? prec : prec + 1)
        left = { k: 'bin', op: t.v, a: left, b: right }
      }
      return left
    }
    const ast = expr(0)
    if (p !== toks.length) throw ERR.parse
    return ast
  }

  // ---------- values ----------
  // A range value: { range: true, cells: [[v,...],...], row?: index of "this row" for implicit intersection, rowStart }
  const blank = (v) => v === null || v === undefined || v === ''
  function toNum(v) {
    if (isErr(v)) return v
    if (typeof v === 'number') return v
    if (typeof v === 'boolean') return v ? 1 : 0
    if (blank(v)) return 0
    const s = String(v).trim().replace(/,/g, '')
    if (/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?%?$/.test(s)) return s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s)
    const d = dateToSerial(s)
    if (d !== null) return d
    return ERR.value
  }
  function toStr(v) {
    if (isErr(v)) return v
    if (blank(v)) return ''
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
    if (typeof v === 'number') return fmtNum(v)
    return String(v)
  }
  function toBool(v) {
    if (isErr(v)) return v
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    if (blank(v)) return false
    const s = String(v).toUpperCase()
    if (s === 'TRUE') return true
    if (s === 'FALSE') return false
    const n = toNum(v)
    return isErr(n) ? ERR.value : n !== 0
  }
  function fmtNum(n) {
    if (!isFinite(n)) return '#NUM!'
    const r = Math.round(n * 1e10) / 1e10
    return String(r)
  }
  /** Flatten args (ranges spread) for aggregate functions. */
  function flat(args) {
    const out = []
    for (const a of args) {
      if (a && a.range) for (const row of a.cells) for (const v of row) out.push({ v, fromRange: true })
      else out.push({ v: a, fromRange: false })
    }
    return out
  }
  /** A range used where one value is expected: the value in "this row" (or a 1x1 range). */
  function scalar(v) {
    if (!v || !v.range) return v
    if (v.cells.length === 1 && v.cells[0].length === 1) return v.cells[0][0]
    if (v.row !== undefined && v.row !== null && v.cells[0] && v.cells[0].length === 1) {
      const i = v.row - v.rowStart
      if (i >= 0 && i < v.cells.length) return v.cells[i][0]
    }
    return ERR.value
  }
  function cmp(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b
    const na = toNum(a)
    const nb = toNum(b)
    if (!isErr(na) && !isErr(nb) && !blank(a) && !blank(b)) return na - nb
    const sa = toStr(a).toLowerCase()
    const sb = toStr(b).toLowerCase()
    return sa < sb ? -1 : sa > sb ? 1 : 0
  }

  /** COUNTIF-style criteria: ">=10", "<>완료", "사무*", 5 */
  function criteria(c) {
    if (typeof c === 'number') return (v) => !blank(v) && toNum(v) === c
    const s = toStr(c)
    const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(s)
    const op = m[1] || '='
    const rhs = m[2]
    const rn = toNum(rhs)
    const numeric = rhs !== '' && !isErr(rn)
    if (!numeric && (op === '=' || op === '<>') && /[*?]/.test(rhs)) {
      const re = new RegExp('^' + rhs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
      return op === '=' ? (v) => re.test(toStr(v)) : (v) => !re.test(toStr(v))
    }
    return (v) => {
      let d
      if (numeric) {
        if (blank(v)) return op === '<>'
        const n = toNum(v)
        if (isErr(n)) return op === '<>'
        d = n - rn
      } else d = cmp(toStr(v).toLowerCase(), rhs.toLowerCase())
      switch (op) {
        case '=':
          return numeric ? d === 0 : toStr(v).toLowerCase() === rhs.toLowerCase()
        case '<>':
          return numeric ? d !== 0 : toStr(v).toLowerCase() !== rhs.toLowerCase()
        case '<':
          return d < 0
        case '>':
          return d > 0
        case '<=':
          return d <= 0
        default:
          return d >= 0
      }
    }
  }

  function textFormat(v, f) {
    const n = toNum(v)
    if (isErr(n)) return toStr(v)
    const fmt = toStr(f)
    if (/y|m|d/i.test(fmt) && !/[#0]/.test(fmt)) {
      const [y, mo, d] = serialToDate(n).split('-')
      return fmt.replace(/yyyy/gi, y).replace(/yy/gi, y.slice(2)).replace(/mm/gi, mo).replace(/dd/gi, d)
    }
    const pct = fmt.endsWith('%')
    const body = pct ? fmt.slice(0, -1) : fmt
    const dec = (body.split('.')[1] || '').replace(/[^0#]/g, '').length
    const val = pct ? n * 100 : n
    let s = Math.abs(val).toFixed(dec)
    if (body.includes(',')) {
      const [i, d] = s.split('.')
      s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d ? '.' + d : '')
    }
    return (val < 0 ? '-' : '') + s + (pct ? '%' : '')
  }

  function round(n, d, mode) {
    const f = Math.pow(10, d)
    const x = n * f
    const r = mode === 'up' ? Math.sign(x) * Math.ceil(Math.abs(x) - 1e-9) : mode === 'down' ? Math.sign(x) * Math.floor(Math.abs(x) + 1e-9) : Math.sign(x) * Math.round(Math.abs(x) + 1e-9)
    return r / f
  }

  const AGG = {
    SUM: (vs) => vs.reduce((s, x) => s + x, 0),
    AVERAGE: (vs) => (vs.length ? vs.reduce((s, x) => s + x, 0) / vs.length : ERR.div0),
    MIN: (vs) => (vs.length ? Math.min(...vs) : 0),
    MAX: (vs) => (vs.length ? Math.max(...vs) : 0)
  }
  function nums(args) {
    const out = []
    for (const { v, fromRange } of flat(args)) {
      if (isErr(v)) return v
      if (fromRange) {
        if (typeof v === 'number') out.push(v)
        else if (!blank(v) && typeof v !== 'boolean') {
          const n = toNum(v)
          if (!isErr(n)) out.push(n)
        }
      } else {
        const n = toNum(v)
        if (isErr(n)) return n
        out.push(n)
      }
    }
    return out
  }

  /** Functions get evaluated args (ranges stay ranges), except the lazy ones (IF, IFERROR, AND, OR). */
  const FN = {
    SUM: (a) => num1(nums(a), AGG.SUM),
    AVERAGE: (a) => num1(nums(a), AGG.AVERAGE),
    MIN: (a) => num1(nums(a), AGG.MIN),
    MAX: (a) => num1(nums(a), AGG.MAX),
    COUNT: (a) => flat(a).filter(({ v, fromRange }) => (fromRange ? typeof v === 'number' || (!blank(v) && !isErr(toNum(v)) && typeof v !== 'boolean') : !isErr(toNum(v)))).length,
    COUNTA: (a) => flat(a).filter(({ v }) => !blank(v)).length,
    COUNTBLANK: (a) => flat(a).filter(({ v }) => blank(v)).length,
    ROUND: (a) => numArgs(a, 1, (n, d = 0) => round(n, Math.trunc(d), 'half')),
    ROUNDUP: (a) => numArgs(a, 1, (n, d = 0) => round(n, Math.trunc(d), 'up')),
    ROUNDDOWN: (a) => numArgs(a, 1, (n, d = 0) => round(n, Math.trunc(d), 'down')),
    INT: (a) => numArgs(a, 1, (n) => Math.floor(n)),
    ABS: (a) => numArgs(a, 1, (n) => Math.abs(n)),
    MOD: (a) => numArgs(a, 2, (n, d) => (d === 0 ? ERR.div0 : n - d * Math.floor(n / d))),
    POWER: (a) => numArgs(a, 2, (n, p) => Math.pow(n, p)),
    SQRT: (a) => numArgs(a, 1, (n) => (n < 0 ? ERR.num : Math.sqrt(n))),
    LEN: (a) => str1(a, (s) => s.length),
    LEFT: (a) => strN(a, (s, n = 1) => s.slice(0, Math.max(0, n))),
    RIGHT: (a) => strN(a, (s, n = 1) => (n <= 0 ? '' : s.slice(-n))),
    MID: (a) => strN(a, (s, st, n) => s.substr(Math.max(0, st - 1), Math.max(0, n))),
    TRIM: (a) => str1(a, (s) => s.trim().replace(/\s+/g, ' ')),
    UPPER: (a) => str1(a, (s) => s.toUpperCase()),
    LOWER: (a) => str1(a, (s) => s.toLowerCase()),
    CONCAT: (a) => {
      let s = ''
      for (const { v } of flat(a)) {
        if (isErr(v)) return v
        s += toStr(v)
      }
      return s
    },
    TEXT: (a) => (a.length < 2 ? ERR.value : textFormat(scalar(a[0]), scalar(a[1]))),
    VALUE: (a) => toNum(scalar(a[0])),
    TODAY: () => todaySerial(),
    NOW: () => todaySerial(),
    DATE: (a) =>
      numArgs(a, 3, (y, m, d) => {
        const t = Date.UTC(y, m - 1, d)
        return Math.round((t - EPOCH) / 86400000)
      }),
    YEAR: (a) => numArgs(a, 1, (n) => +serialToDate(n).slice(0, 4)),
    MONTH: (a) => numArgs(a, 1, (n) => +serialToDate(n).slice(5, 7)),
    DAY: (a) => numArgs(a, 1, (n) => +serialToDate(n).slice(8, 10)),
    DAYS: (a) => numArgs(a, 2, (e, s) => e - s),
    DATEDIF: (a) => {
      const s = toNum(scalar(a[0]))
      const e = toNum(scalar(a[1]))
      if (isErr(s)) return s
      if (isErr(e)) return e
      if (e < s) return ERR.num
      const u = toStr(scalar(a[2] ?? 'D')).toUpperCase()
      const [y1, m1, d1] = serialToDate(s).split('-').map(Number)
      const [y2, m2, d2] = serialToDate(e).split('-').map(Number)
      const months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0)
      return u === 'Y' ? Math.floor(months / 12) : u === 'M' ? months : e - s
    },
    ISBLANK: (a) => blank(scalar(a[0])),
    ISNUMBER: (a) => {
      const v = scalar(a[0])
      return typeof v === 'number' || (!blank(v) && typeof v === 'string' && !isErr(toNum(v)) && !DATE_RE.test(v))
    },
    ISERROR: (a) => isErr(scalar(a[0])),
    NOT: (a) => {
      const b = toBool(scalar(a[0]))
      return isErr(b) ? b : !b
    },
    SUMIF: (a) => ifAgg(a, 'sum'),
    COUNTIF: (a) => ifAgg(a, 'count'),
    AVERAGEIF: (a) => ifAgg(a, 'avg'),
    VLOOKUP: (a) => {
      const key = scalar(a[0])
      const table = a[1]
      const col = toNum(scalar(a[2]))
      if (!table || !table.range) return ERR.value
      if (isErr(col) || col < 1 || col > (table.cells[0] || []).length) return ERR.ref
      // like Excel: the 4th argument defaults to TRUE (approximate: last key ≤ value in a sorted first column)
      const exact = a.length >= 4 && !toBool(scalar(a[3]))
      if (exact) {
        for (const row of table.cells) if ((typeof key === 'number' && toNum(row[0]) === key) || toStr(row[0]).toLowerCase() === toStr(key).toLowerCase()) return row[col - 1]
        return ERR.na
      }
      let hit = null
      for (const row of table.cells) {
        if (blank(row[0])) continue
        if (cmp(row[0], key) <= 0) hit = row
        else break
      }
      return hit ? hit[col - 1] : ERR.na
    },
    MATCH: (a) => {
      const key = scalar(a[0])
      if (!a[1] || !a[1].range) return ERR.value
      const list = a[1].cells.map((r) => r[0])
      const i = list.findIndex((v) => cmp(v, key) === 0 && toStr(v).toLowerCase() === toStr(key).toLowerCase())
      return i < 0 ? ERR.na : i + 1
    },
    INDEX: (a) => {
      if (!a[0] || !a[0].range) return ERR.value
      const r = toNum(scalar(a[1]))
      const c = a.length > 2 ? toNum(scalar(a[2])) : 1
      if (isErr(r) || isErr(c)) return ERR.value
      const row = a[0].cells[r - 1]
      return row && c >= 1 && c <= row.length ? row[c - 1] : ERR.ref
    }
  }
  function num1(vs, f) {
    return isErr(vs) ? vs : f(vs)
  }
  function numArgs(a, need, f) {
    if (a.length < need) return ERR.value
    const ns = []
    for (const x of a) {
      const n = toNum(scalar(x))
      if (isErr(n)) return n
      ns.push(n)
    }
    return f(...ns)
  }
  function str1(a, f) {
    const s = toStr(scalar(a[0]))
    return isErr(s) ? s : f(s)
  }
  function strN(a, f) {
    const s = toStr(scalar(a[0]))
    if (isErr(s)) return s
    const rest = []
    for (const x of a.slice(1)) {
      const n = toNum(scalar(x))
      if (isErr(n)) return n
      rest.push(n)
    }
    return f(s, ...rest)
  }
  function ifAgg(a, kind) {
    const range = a[0]
    if (!range || !range.range) return ERR.value
    const test = criteria(scalar(a[1]))
    const sumRange = a[2] && a[2].range ? a[2] : range
    let s = 0
    let n = 0
    range.cells.forEach((row, i) =>
      row.forEach((v, j) => {
        if (!test(v)) return
        n++
        const sv = sumRange.cells[i] ? sumRange.cells[i][j] : undefined
        const x = toNum(sv)
        if (!isErr(x) && typeof sv !== 'boolean') s += x
      })
    )
    return kind === 'count' ? n : kind === 'sum' ? s : n ? s / n : ERR.div0
  }

  // ---------- evaluation ----------
  /**
   * ctx: { cell(col, row) → value, range(c1, r1, c2, r2) → cells[][], column(name) → { cells, rowStart } | null, row: current row (1-based) | null }
   */
  function evaluate(ast, ctx) {
    switch (ast.k) {
      case 'num':
      case 'str':
      case 'bool':
        return ast.v
      case 'empty':
        return ''
      case 'name':
        return ERR.name
      case 'cell':
        return ctx.cell(colIndex(ast.c), ast.r)
      case 'range': {
        const c1 = colIndex(ast.c1)
        const c2 = colIndex(ast.c2)
        const r1 = Math.min(ast.r1, ast.r2)
        const r2 = Math.max(ast.r1, ast.r2)
        const cells = ctx.range(Math.min(c1, c2), r1, Math.max(c1, c2), r2)
        if (isErr(cells)) return cells
        return { range: true, cells, row: ctx.row, rowStart: r1 }
      }
      case 'col': {
        const c = ctx.column(ast.name)
        if (!c) return ERR.ref
        if (isErr(c)) return c
        if (ast.row) {
          if (!ctx.row) return ERR.value
          return c.cells[ctx.row - 1] ? c.cells[ctx.row - 1][0] : ''
        }
        return { range: true, cells: c.cells, row: ctx.row, rowStart: 1 }
      }
      case 'neg': {
        const n = toNum(scalar(evaluate(ast.e, ctx)))
        return isErr(n) ? n : ast.neg ? -n : n
      }
      case 'pct': {
        const n = toNum(scalar(evaluate(ast.e, ctx)))
        return isErr(n) ? n : n / 100
      }
      case 'bin': {
        const a = scalar(evaluate(ast.a, ctx))
        const b = scalar(evaluate(ast.b, ctx))
        if (isErr(a)) return a
        if (isErr(b)) return b
        if (ast.op === '&') return toStr(a) + toStr(b)
        if (['=', '<>', '<', '>', '<=', '>='].includes(ast.op)) {
          const d = typeof a === 'string' && typeof b === 'string' && isErr(toNum(a)) ? (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0) : cmp(a, b)
          return ast.op === '=' ? d === 0 : ast.op === '<>' ? d !== 0 : ast.op === '<' ? d < 0 : ast.op === '>' ? d > 0 : ast.op === '<=' ? d <= 0 : d >= 0
        }
        const x = toNum(a)
        const y = toNum(b)
        if (isErr(x)) return x
        if (isErr(y)) return y
        switch (ast.op) {
          case '+':
            return x + y
          case '-':
            return x - y
          case '*':
            return x * y
          case '/':
            return y === 0 ? ERR.div0 : x / y
          default: {
            const r = Math.pow(x, y)
            return isFinite(r) ? r : ERR.num
          }
        }
      }
      case 'fn': {
        const name = ast.name
        if (name === 'IF') {
          const c = toBool(scalar(evaluate(ast.args[0] || { k: 'empty' }, ctx)))
          if (isErr(c)) return c
          const branch = c ? ast.args[1] : ast.args[2]
          return branch ? scalar(evaluate(branch, ctx)) : c ? true : false
        }
        if (name === 'IFERROR') {
          const v = scalar(evaluate(ast.args[0] || { k: 'empty' }, ctx))
          return isErr(v) ? scalar(evaluate(ast.args[1] || { k: 'empty' }, ctx)) : v
        }
        if (name === 'ROW') {
          if (ast.args.length && ast.args[0].k === 'cell') return ast.args[0].r
          return ctx.row || ERR.value
        }
        if (name === 'CUMSUM') {
          // running total of a column (or a one-column range) down to this row
          const v = evaluate(ast.args[0] || { k: 'empty' }, ctx)
          if (!v || !v.range || !ctx.row) return ERR.value
          let s = 0
          for (let i = 0; i <= ctx.row - v.rowStart && i < v.cells.length; i++) {
            const x = v.cells[i][0]
            if (isErr(x)) return x
            if (typeof x === 'number') s += x
          }
          return s
        }
        if (name === 'AND' || name === 'OR') {
          let any = false
          let all = true
          for (const arg of ast.args) {
            for (const { v } of flat([evaluate(arg, ctx)])) {
              const b = toBool(v)
              if (isErr(b)) return b
              any = any || b
              all = all && b
            }
          }
          return name === 'AND' ? all : any
        }
        const f = FN[name]
        if (!f) return ERR.name
        return f(ast.args.map((x) => evaluate(x, ctx)))
      }
      default:
        return ERR.parse
    }
  }

  function colIndex(letters) {
    let n = 0
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
    return n - 1
  }
  function colLetters(i) {
    let s = ''
    i++
    while (i > 0) {
      const m = (i - 1) % 26
      s = String.fromCharCode(65 + m) + s
      i = Math.floor((i - 1) / 26)
    }
    return s
  }

  const cache = new Map()
  /** Parse once per formula text (formulas repeat for every row of a calculated column). */
  function compile(src) {
    let c = cache.get(src)
    if (!c) {
      try {
        c = { ast: parse(src.replace(/^=/, '')) }
      } catch (e) {
        c = { err: isErr(e) ? e : ERR.parse }
      }
      if (cache.size > 5000) cache.clear()
      cache.set(src, c)
    }
    return c
  }

  g.LedgerFormula = { parse, evaluate, compile, isErr, ERR, FErr, toNum, toStr, toBool, scalar, colIndex, colLetters, dateToSerial, serialToDate, todaySerial, textFormat, FUNCTIONS: Object.keys(FN).concat(['IF', 'IFERROR', 'AND', 'OR', 'ROW', 'CUMSUM']).sort() }
})(typeof window !== 'undefined' ? window : globalThis)
