/* Sheet model for 스마트 대장 (no DOM): computing values, totals, sort, filter, CSV/TSV, templates.
 * Exposed as globalThis.LedgerSheet; unit-tested in tests/plugins/ledger.test.ts. Needs formula.js first. */
;(function (g) {
  'use strict'
  const F = g.LedgerFormula

  /**
   * book = { id, name, cols: Col[], rows: Row[], note? }
   * Col  = { id, name, type: 'text'|'number'|'date'|'select'|'check'|'member'|'calc', width?, options?: string[],
   *          format?: 'auto'|'int'|'dec1'|'dec2'|'won'|'pct'|'date', calc?: '=…', total?: 'none'|'sum'|'avg'|'min'|'max'|'count'|'checked' }
   * Row  = { id, c: { [colId]: raw } }     raw: text, number, boolean, or a formula '=…'
   */
  const TYPES = { text: '글자', number: '숫자', date: '날짜', select: '목록에서 고르기', check: '체크', member: '팀원', calc: '계산(수식)' }
  const FORMATS = { auto: '자동', int: '정수 (1,234)', dec1: '소수 1자리', dec2: '소수 2자리', won: '원 (1,234원)', pct: '백분율 (12.5%)', date: '날짜' }
  const TOTALS = { none: '없음', sum: '합계', avg: '평균', min: '최소', max: '최대', count: '개수(값 있는 칸)', checked: '체크한 개수' }

  let seq = 0
  const uid = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`

  /** Normalise typed input: "2026.3.5" → "2026-03-05"; "1,234" stays text until computed. */
  function normalizeDate(s) {
    const m = /^\s*(\d{4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})\s*일?\s*$/.exec(String(s))
    if (!m) return null
    const v = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
    return F.dateToSerial(v) === null ? null : v
  }

  /** Value of a non-formula cell as the formula engine sees it. */
  function typed(col, raw) {
    if (raw === undefined || raw === null || raw === '') return ''
    switch (col.type) {
      case 'number': {
        if (typeof raw === 'number') return raw
        const n = F.toNum(raw)
        return F.isErr(n) ? String(raw) : n
      }
      case 'check':
        return raw === true || raw === 'TRUE' || raw === 'true' || raw === 1 || raw === '1' || raw === 'O' || raw === 'o' || raw === '✓'
      case 'date':
        return normalizeDate(raw) || String(raw)
      default:
        return typeof raw === 'number' ? raw : String(raw)
    }
  }

  /**
   * Compute every cell. Returns { get(r, c) → value, values: value[][] } (0-based row/col).
   * Formulas: column calc (every row) or a cell starting with '='. Cycles → #CYCLE!.
   */
  function compute(book) {
    const cols = book.cols
    const rows = book.rows
    const memo = new Map()
    const visiting = new Set()
    const byName = new Map(cols.map((c, i) => [c.name.trim().toLowerCase(), i]))
    const colCache = new Map()
    const emptyRow = rows.map((row) => !cols.some((c) => c.type !== 'calc' && row.c[c.id] !== undefined && row.c[c.id] !== '' && row.c[c.id] !== false))
    function formulaOf(r, c) {
      const col = cols[c]
      // a calculated column stays blank on rows where nothing was entered yet
      if (col.type === 'calc') return emptyRow[r] ? '' : col.calc || ''
      const raw = rows[r].c[col.id]
      return typeof raw === 'string' && raw.startsWith('=') && raw.length > 1 ? raw : null
    }
    function get(r, c) {
      if (c < 0 || c >= cols.length) return F.ERR.ref
      if (r < 0 || r >= rows.length) return ''
      const key = r * 4096 + c
      if (memo.has(key)) return memo.get(key)
      const f = formulaOf(r, c)
      if (f === null) {
        const v = typed(cols[c], rows[r].c[cols[c].id])
        memo.set(key, v)
        return v
      }
      if (f === '') return ''
      if (visiting.has(key)) return F.ERR.cycle
      visiting.add(key)
      let v
      const comp = F.compile(f)
      if (comp.err) v = comp.err
      else {
        try {
          v = F.scalar(F.evaluate(comp.ast, ctx(r)))
        } catch (e) {
          v = F.isErr(e) ? e : F.ERR.value
        }
      }
      if (v && v.range) v = F.ERR.value
      if (typeof v === 'number' && !isFinite(v)) v = F.ERR.num
      if (v === undefined || v === null) v = ''
      visiting.delete(key)
      memo.set(key, v)
      return v
    }
    function ctx(r) {
      return {
        row: r + 1,
        cell: (c, row) => get(row - 1, c),
        range: (c1, r1, c2, r2) => {
          if (c2 >= cols.length || c1 < 0) return F.ERR.ref
          const last = Math.min(r2, rows.length)
          const out = []
          for (let y = r1; y <= last; y++) {
            const line = []
            for (let x = c1; x <= c2; x++) line.push(get(y - 1, x))
            out.push(line)
          }
          return out
        },
        column: (name) => {
          const i = byName.get(name.trim().toLowerCase())
          if (i === undefined) return null
          if (colCache.has(i)) return colCache.get(i)
          // a column that needs itself (=SUM([금액]) inside 금액) shows #CYCLE! through the visiting set
          const cells = []
          for (let y = 0; y < rows.length; y++) cells.push([get(y, i)])
          const res = { cells }
          colCache.set(i, res)
          return res
        }
      }
    }
    const values = []
    for (let r = 0; r < rows.length; r++) {
      const line = []
      for (let c = 0; c < cols.length; c++) line.push(get(r, c))
      values.push(line)
    }
    return { get, values }
  }

  function addCommas(s) {
    const [i, d] = s.split('.')
    return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d !== undefined ? '.' + d : '')
  }
  /** Text shown in a cell. */
  function display(v, col) {
    if (F.isErr(v)) return v.code
    if (v === '' || v === null || v === undefined) return ''
    if (typeof v === 'boolean') return col && col.type === 'check' ? (v ? '✓' : '') : v ? 'TRUE' : 'FALSE'
    const fmt = (col && col.format) || 'auto'
    if (typeof v === 'number') {
      if (fmt === 'date' || (col && col.type === 'date')) return F.serialToDate(v)
      const neg = v < 0 ? '-' : ''
      const a = Math.abs(v)
      switch (fmt) {
        case 'int':
          return neg + addCommas(Math.round(a).toString())
        case 'dec1':
          return neg + addCommas(a.toFixed(1))
        case 'dec2':
          return neg + addCommas(a.toFixed(2))
        case 'won':
          return neg + addCommas(Math.round(a).toString()) + '원'
        case 'pct':
          return neg + addCommas((a * 100).toFixed(1).replace(/\.0$/, '')) + '%'
        default: {
          const r = Math.round(a * 1e10) / 1e10
          return neg + (Number.isInteger(r) ? addCommas(r.toString()) : addCommas(String(r)))
        }
      }
    }
    return String(v)
  }

  /** A typed cell that does not fit its column type (shown with a red mark). */
  function invalid(col, raw) {
    if (raw === undefined || raw === null || raw === '' || (typeof raw === 'string' && raw.startsWith('='))) return false
    if (col.type === 'number') return typeof raw !== 'number' && F.isErr(F.toNum(raw))
    if (col.type === 'date') return !normalizeDate(raw)
    if (col.type === 'select') return Array.isArray(col.options) && col.options.length > 0 && !col.options.includes(String(raw))
    return false
  }

  /** Total of a column over the given rows (indices). */
  function total(values, c, kind, rowIdx) {
    if (!kind || kind === 'none') return ''
    const vs = rowIdx.map((r) => values[r][c])
    if (kind === 'count') return vs.filter((v) => v !== '' && v !== false && !F.isErr(v)).length
    if (kind === 'checked') return vs.filter((v) => v === true).length
    const ns = vs.filter((v) => typeof v === 'number')
    if (vs.some((v) => F.isErr(v))) return vs.find((v) => F.isErr(v))
    if (kind === 'sum') return ns.reduce((s, x) => s + x, 0)
    if (!ns.length) return ''
    if (kind === 'avg') return ns.reduce((s, x) => s + x, 0) / ns.length
    if (kind === 'min') return Math.min(...ns)
    return Math.max(...ns)
  }

  /** Stable sort of row indices by one column; blanks last. */
  function sortOrder(values, c, dir) {
    const idx = values.map((_, i) => i)
    const key = (v) => (F.isErr(v) ? '￿' : v === '' ? null : v)
    idx.sort((a, b) => {
      const x = key(values[a][c])
      const y = key(values[b][c])
      if (x === null && y === null) return a - b
      if (x === null) return 1
      if (y === null) return -1
      let d
      if (typeof x === 'number' && typeof y === 'number') d = x - y
      else if (typeof x === 'boolean' || typeof y === 'boolean') d = (x === true ? 1 : 0) - (y === true ? 1 : 0)
      else d = String(x).localeCompare(String(y), 'ko', { numeric: true })
      return (dir === 'desc' ? -d : d) || a - b
    })
    return idx
  }

  /** Visible rows: text search over shown values + per-column filters { [colIdx]: { values?: Set<string>, blank?: bool } }. */
  function filterRows(book, values, query, colFilters) {
    const q = String(query || '').trim().toLowerCase()
    const out = []
    for (let r = 0; r < values.length; r++) {
      let ok = true
      if (q) ok = values[r].some((v, c) => display(v, book.cols[c]).toLowerCase().includes(q))
      if (ok && colFilters)
        for (const k of Object.keys(colFilters)) {
          const f = colFilters[k]
          if (!f || !f.values) continue
          if (!f.values.has(display(values[r][+k], book.cols[+k]))) {
            ok = false
            break
          }
        }
      if (ok) out.push(r)
    }
    return out
  }

  // ---------- CSV / TSV ----------
  function parseDelimited(text, delim) {
    const s = String(text).replace(/^\uFEFF/, '')
    if (!delim) {
      const first = s.split(/\r?\n/, 1)[0] || ''
      delim = first.split('\t').length > first.split(',').length ? '\t' : ','
    }
    const rows = []
    let row = []
    let cell = ''
    let q = false
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (q) {
        if (ch === '"') {
          if (s[i + 1] === '"') {
            cell += '"'
            i++
          } else q = false
        } else cell += ch
        continue
      }
      if (ch === '"' && cell === '') q = true
      else if (ch === delim) {
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
    return rows
  }
  const quote = (v, delim) => {
    const s = String(v)
    return s.includes('"') || s.includes(delim) || /[\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  function toDelimited(matrix, delim) {
    return matrix.map((r) => r.map((v) => quote(v === null || v === undefined ? '' : v, delim)).join(delim)).join('\r\n')
  }

  /** CSV of the visible rows (shown values, numbers without thousands separators so Excel reads them as numbers). */
  function toCSV(book, values, rowIdx) {
    const head = book.cols.map((c) => c.name)
    const body = rowIdx.map((r) =>
      values[r].map((v, c) => {
        if (F.isErr(v)) return v.code
        if (typeof v === 'boolean') return book.cols[c].type === 'check' ? (v ? 'O' : '') : v ? 'TRUE' : 'FALSE'
        if (typeof v === 'number' && (book.cols[c].type === 'date' || book.cols[c].format === 'date')) return F.serialToDate(v)
        return v
      })
    )
    return '\uFEFF' + toDelimited([head, ...body], ',')
  }

  /** A new book from CSV text: first line = column names, column types guessed. */
  function fromCSV(text, name) {
    const rows = parseDelimited(text).filter((r) => r.some((x) => x.trim() !== ''))
    if (!rows.length) throw new Error('빈 파일입니다.')
    const width = Math.max(...rows.map((r) => r.length))
    const head = rows[0]
    const used = new Set()
    const cols = []
    for (let i = 0; i < width; i++) {
      let n = (head[i] || '').trim() || F.colLetters(i)
      while (used.has(n.toLowerCase())) n += '_'
      used.add(n.toLowerCase())
      const vals = rows
        .slice(1)
        .map((r) => (r[i] || '').trim())
        .filter(Boolean)
      let type = 'text'
      if (vals.length && vals.every((v) => normalizeDate(v))) type = 'date'
      else if (vals.length && vals.every((v) => !F.isErr(F.toNum(v)) && !/^0\d/.test(v.replace(/,/g, '')))) type = 'number'
      else if (vals.length && vals.every((v) => /^(o|x|✓|true|false)$/i.test(v))) type = 'check'
      cols.push({ id: uid('c'), name: n, type, width: type === 'text' ? 160 : 110, format: type === 'number' ? 'auto' : undefined, total: type === 'number' ? 'sum' : 'none' })
    }
    const out = rows.slice(1).map((r) => {
      const c = {}
      cols.forEach((col, i) => {
        const v = (r[i] || '').trim()
        if (!v) return
        if (col.type === 'number') c[col.id] = F.toNum(v)
        else if (col.type === 'date') c[col.id] = normalizeDate(v)
        else if (col.type === 'check') c[col.id] = /^(o|✓|true)$/i.test(v)
        else c[col.id] = v
      })
      return { id: uid('r'), c }
    })
    return { id: uid('b'), name: name || '가져온 대장', cols, rows: out, note: '' }
  }

  /** Paste a block of text (from Excel, TSV) at (r, c); grows rows as needed. Returns the changed area. */
  function pasteBlock(book, r0, c0, text) {
    const block = parseDelimited(String(text).replace(/\r?\n$/, ''), text.includes('\t') ? '\t' : ',')
    if (!block.length) return null
    let rows = 0
    block.forEach((line, i) => {
      const r = r0 + i
      while (book.rows.length <= r) book.rows.push({ id: uid('r'), c: {} })
      line.forEach((v, j) => {
        const col = book.cols[c0 + j]
        if (!col || col.type === 'calc') return
        book.rows[r].c[col.id] = parseInput(col, v)
      })
      rows++
    })
    return { r1: r0, r2: r0 + rows - 1, c1: c0, c2: Math.min(book.cols.length - 1, c0 + Math.max(...block.map((l) => l.length)) - 1) }
  }

  /** What the user typed → stored raw value for the column type. */
  function parseInput(col, text) {
    const s = String(text)
    if (s === '') return ''
    if (s.startsWith('=') && s.length > 1) return s
    switch (col.type) {
      case 'number': {
        const n = F.toNum(s.trim())
        return F.isErr(n) ? s : n
      }
      case 'date':
        return normalizeDate(s) || s.trim()
      case 'check':
        return /^(o|✓|true|1|y|예)$/i.test(s.trim())
      default:
        return s
    }
  }

  /** Raw value as shown in the editor / formula bar. */
  function editText(col, raw) {
    if (col.type === 'calc') return col.calc || ''
    if (raw === undefined || raw === null) return ''
    if (typeof raw === 'boolean') return raw ? 'TRUE' : 'FALSE'
    return String(raw)
  }

  // ---------- templates ----------
  function col(name, type, more) {
    return Object.assign({ id: uid('c'), name, type, width: type === 'text' ? 140 : type === 'check' ? 64 : 110, total: 'none' }, more || {})
  }
  const TEMPLATES = [
    { key: 'blank', icon: '📄', name: '빈 대장', desc: '열을 직접 만듭니다', cols: () => [col('항목', 'text', { width: 180 }), col('내용', 'text', { width: 240 }), col('수량', 'number', { total: 'sum' }), col('비고', 'text')] },
    {
      key: 'asset',
      icon: '📦',
      name: '물품(비품) 관리 대장',
      desc: '관리번호·수량·단가·금액(자동)·상태',
      cols: () => [
        col('관리번호', 'text', { width: 100 }),
        col('품명', 'text', { width: 160 }),
        col('규격', 'text'),
        col('수량', 'number', { format: 'int', total: 'sum', width: 70 }),
        col('단가', 'number', { format: 'won' }),
        col('금액', 'calc', { calc: '=[수량]*[단가]', format: 'won', total: 'sum' }),
        col('취득일', 'date'),
        col('위치', 'text', { width: 110 }),
        col('담당자', 'member', { width: 90 }),
        col('상태', 'select', { options: ['사용중', '보관', '수리중', '불용'], width: 90 }),
        col('비고', 'text')
      ],
      sample: [{ 관리번호: 'A-001', 품명: '노트북', 규격: '15인치', 수량: 2, 단가: 1250000, 취득일: '2026-03-02', 위치: '3층 사무실', 상태: '사용중' }]
    },
    {
      key: 'docs',
      icon: '📨',
      name: '문서 수발신 대장',
      desc: '수신/발신·처리 상태·처리 기간(자동)',
      cols: () => [
        col('구분', 'select', { options: ['수신', '발신'], width: 70 }),
        col('문서번호', 'text', { width: 120 }),
        col('일자', 'date'),
        col('제목', 'text', { width: 220 }),
        col('상대 기관', 'text', { width: 130 }),
        col('담당자', 'member', { width: 90 }),
        col('처리 상태', 'select', { options: ['접수', '처리중', '완료'], width: 90, total: 'count' }),
        col('처리일', 'date'),
        col('처리 기간', 'calc', { calc: '=IF(OR([처리일]="",[일자]=""),"",[처리일]-[일자])', format: 'int', width: 80, total: 'avg' }),
        col('비고', 'text')
      ]
    },
    {
      key: 'budget',
      icon: '💰',
      name: '예산 집행 대장',
      desc: '집행액·누적 집행액·잔액(자동)',
      cols: () => [
        col('집행일', 'date'),
        col('예산 과목', 'select', { options: ['사무용품비', '여비', '업무추진비', '교육비', '기타'], width: 110 }),
        col('적요', 'text', { width: 200 }),
        col('거래처', 'text', { width: 120 }),
        col('집행액', 'number', { format: 'won', total: 'sum' }),
        col('누적 집행액', 'calc', { calc: '=CUMSUM([집행액])', format: 'won', width: 120 }),
        col('잔액', 'calc', { calc: '=IF([예산]="","",[예산]-[누적 집행액])', format: 'won', width: 120 }),
        col('예산', 'number', { format: 'won', width: 110 }),
        col('증빙', 'check', { total: 'checked' }),
        col('비고', 'text')
      ],
      note: '“예산” 열에 첫 행만 예산액을 넣으면 잔액이 그 행에만 계산됩니다. 모든 행에 잔액을 보려면 예산 칸에 =$H$1 처럼 첫 칸을 가리키는 수식을 넣으세요.'
    },
    {
      key: 'vehicle',
      icon: '🚗',
      name: '차량 운행 일지',
      desc: '출발·도착 거리 → 운행 거리(자동)',
      cols: () => [
        col('운행일', 'date'),
        col('운전자', 'member', { width: 90 }),
        col('목적지', 'text', { width: 140 }),
        col('용무', 'text', { width: 160 }),
        col('출발 거리', 'number', { format: 'int' }),
        col('도착 거리', 'number', { format: 'int' }),
        col('운행 거리', 'calc', { calc: '=IF([도착 거리]="","",[도착 거리]-[출발 거리])', format: 'int', total: 'sum' }),
        col('주유(L)', 'number', { format: 'dec1', total: 'sum', width: 80 }),
        col('비고', 'text')
      ]
    },
    {
      key: 'rental',
      icon: '🔑',
      name: '대여·반납 대장',
      desc: '반납 예정일이 지나면 “연체” 자동 표시',
      cols: () => [
        col('품목', 'text', { width: 140 }),
        col('대여자', 'member', { width: 90 }),
        col('대여일', 'date'),
        col('반납 예정일', 'date'),
        col('반납일', 'date'),
        col('상태', 'calc', { calc: '=IF([반납일]<>"","반납",IF([반납 예정일]="","대여중",IF(TODAY()>[반납 예정일],"연체","대여중")))', width: 80 }),
        col('연체 일수', 'calc', { calc: '=IF(AND([반납일]="",[반납 예정일]<>"",TODAY()>[반납 예정일]),TODAY()-[반납 예정일],"")', format: 'int', width: 80 }),
        col('비고', 'text')
      ]
    },
    {
      key: 'trip',
      icon: '🧳',
      name: '출장 대장',
      desc: '기간 → 일수(자동), 여비 합계, 정산 체크',
      cols: () => [
        col('출장자', 'member', { width: 90 }),
        col('출장지', 'text', { width: 130 }),
        col('시작일', 'date'),
        col('종료일', 'date'),
        col('일수', 'calc', { calc: '=IF(OR([시작일]="",[종료일]=""),"",[종료일]-[시작일]+1)', format: 'int', width: 60, total: 'sum' }),
        col('목적', 'text', { width: 180 }),
        col('여비', 'number', { format: 'won', total: 'sum' }),
        col('정산', 'check', { total: 'checked' }),
        col('비고', 'text')
      ]
    },
    {
      key: 'training',
      icon: '🎓',
      name: '교육 이수 현황',
      desc: '교육 시간 합계·이수 인원',
      cols: () => [col('이름', 'member', { width: 90 }), col('부서', 'text'), col('교육명', 'text', { width: 200 }), col('이수일', 'date'), col('시간', 'number', { format: 'dec1', total: 'sum', width: 70 }), col('이수', 'check', { total: 'checked' }), col('비고', 'text')]
    }
  ]

  function fromTemplate(key, name) {
    const t = TEMPLATES.find((x) => x.key === key) || TEMPLATES[0]
    const cols = t.cols()
    const rows = (t.sample || []).map((s) => {
      const c = {}
      for (const k of Object.keys(s)) {
        const cl = cols.find((x) => x.name === k)
        if (cl) c[cl.id] = s[k]
      }
      return { id: uid('r'), c }
    })
    while (rows.length < 5) rows.push({ id: uid('r'), c: {} })
    return { id: uid('b'), name: name || t.name, cols, rows, note: t.note || '', template: t.key }
  }

  /** Renaming a column rewrites [이름] references in calc columns and cell formulas. */
  function renameColumn(book, colId, newName) {
    const col = book.cols.find((c) => c.id === colId)
    if (!col) return
    const old = col.name
    col.name = newName
    const esc = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\[(@?)\\s*${esc}\\s*\\]`, 'gi')
    const fix = (f) => f.replace(re, (_m, at) => `[${at}${newName}]`)
    for (const c of book.cols) if (c.type === 'calc' && c.calc) c.calc = fix(c.calc)
    for (const r of book.rows) for (const k of Object.keys(r.c)) if (typeof r.c[k] === 'string' && r.c[k].startsWith('=')) r.c[k] = fix(r.c[k])
  }

  /** Approximate stored size (storage values are limited to 512 KB). */
  const sizeOf = (book) => JSON.stringify(book).length

  g.LedgerSheet = { TYPES, FORMATS, TOTALS, TEMPLATES, uid, compute, display, invalid, total, sortOrder, filterRows, parseDelimited, toDelimited, toCSV, fromCSV, pasteBlock, parseInput, editText, normalizeDate, fromTemplate, renameColumn, sizeOf }
})(typeof window !== 'undefined' ? window : globalThis)
