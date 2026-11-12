/* Ladder logic (no DOM). Exposed as globalThis.Ladder; unit-tested in tests/plugins. */
;(function (g) {
  'use strict'

  /** Random integers from crypto (fair draw); falls back to Math.random only if unavailable. */
  function rand(n) {
    if (g.crypto && g.crypto.getRandomValues) {
      const a = new Uint32Array(1)
      g.crypto.getRandomValues(a)
      return a[0] % n
    }
    return Math.floor(Math.random() * n)
  }

  /** Deterministic generator for a seed (so a shared game can be checked again). */
  function seeded(seed) {
    let s = seed >>> 0 || 1
    return function (n) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      return (s >>> 0) % n
    }
  }

  /**
   * Rungs: rows × (lines-1) booleans. Two rungs never touch in the same row, and every
   * gap gets at least one rung so that everyone can move.
   */
  function generate(lines, rows, seed) {
    const r = seed !== undefined ? seeded(seed) : rand
    const grid = []
    for (let y = 0; y < rows; y++) {
      const row = []
      for (let x = 0; x < lines - 1; x++) row.push(!row[x - 1] && r(100) < 45)
      grid.push(row)
    }
    // Every gap needs a rung. Prefer a row whose neighbours are free; otherwise take a row
    // where the left gap keeps another rung and clear the neighbours (the right gap is
    // handled next, so it is fixed again if needed).
    const count = (x) => grid.reduce((n, row) => n + (row[x] ? 1 : 0), 0)
    for (let x = 0; x < lines - 1; x++) {
      if (count(x) > 0) continue
      const order = shuffle(Array.from({ length: rows }, (_, i) => i), r)
      let y = order.find((yy) => !grid[yy][x - 1] && !grid[yy][x + 1])
      if (y === undefined) y = order.find((yy) => !grid[yy][x - 1] || count(x - 1) > 1)
      if (y === undefined) y = order[0]
      if (x > 0) grid[y][x - 1] = false
      if (x < lines - 2) grid[y][x + 1] = false
      grid[y][x] = true
    }
    return grid
  }

  /** Follow line `start` down; returns the end column and the path as [col,row] steps. */
  function trace(grid, start) {
    let x = start
    const steps = [[x, -1]]
    for (let y = 0; y < grid.length; y++) {
      steps.push([x, y])
      if (x > 0 && grid[y][x - 1]) x -= 1
      else if (grid[y][x]) x += 1
      steps.push([x, y])
    }
    steps.push([x, grid.length])
    return { end: x, steps }
  }

  /** start column → end column for every line (always a permutation). */
  function mapping(grid, lines) {
    const out = []
    for (let i = 0; i < lines; i++) out.push(trace(grid, i).end)
    return out
  }

  function shuffle(list, r) {
    const a = list.slice()
    const f = r || rand
    for (let i = a.length - 1; i > 0; i--) {
      const j = f(i + 1)
      const t = a[i]
      a[i] = a[j]
      a[j] = t
    }
    return a
  }

  /** Result lists for the presets. */
  function preset(kind, n, opts) {
    const o = opts || {}
    const fill = (arr) => {
      const a = arr.slice(0, n)
      while (a.length < n) a.push('꽝')
      return a
    }
    switch (kind) {
      case 'winner': {
        const k = Math.max(1, Math.min(n - 1, o.winners || 1))
        return fill(Array.from({ length: k }, () => o.prize || '당첨'))
      }
      case 'order':
        return Array.from({ length: n }, (_, i) => `${i + 1}등`)
      case 'teams': {
        const t = Math.max(2, Math.min(6, o.teams || 2))
        const names = ['A팀', 'B팀', 'C팀', 'D팀', 'E팀', 'F팀']
        return Array.from({ length: n }, (_, i) => names[i % t])
      }
      case 'coffee':
        return fill([o.prize || '☕ 커피 쏘기'])
      case 'penalty': {
        const list = (o.penalties && o.penalties.length ? o.penalties : ['노래 한 곡', '간식 사기', '회의록 쓰기', '청소 당번']).slice(0, n)
        return fill(list)
      }
      default:
        return fill(o.custom || [])
    }
  }

  function parseList(text) {
    return String(text || '')
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  g.Ladder = { generate, trace, mapping, shuffle, preset, parseList, rand }
})(typeof window !== 'undefined' ? window : globalThis)
