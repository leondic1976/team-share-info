import { describe, it, expect } from 'vitest'
import {
  ORG_BOX_MIN,
  ORG_CARD_GAP,
  ORG_CARD_MIN,
  ORG_BOX_PAD,
  ORG_COMPACT_DEPTH,
  ORG_FIT_FLOOR,
  ORG_INDENT,
  ORG_MAX_ZOOM,
  ORG_MIN_ZOOM,
  ORG_NODE_PAD,
  ORG_ROOT_MIN,
  ORG_SPINE,
  boxWidth,
  evenRows,
  fitColumns,
  fitScale,
  memberColumnsFor,
  narrowestWidth,
  neededColumns,
  overflowsAtFloor,
  planBranch,
  planOrgChart,
  stepZoom,
  wantedColumns,
  wrapRows,
  type OrgBranchPlan,
  type OrgKidsPlan,
  type OrgLayoutItem
} from '../../src/shared/orgLayout'

let seq = 0
const d = (cards: number, children: OrgLayoutItem[] = []): OrgLayoutItem => ({ id: `d${seq++}`, cards, children })
const all = (k: OrgKidsPlan | null): OrgBranchPlan[] => (k ? k.rows.flat().flatMap((p) => [p, ...all(p.kids)]) : [])
const sizes = (k: OrgKidsPlan): number[] => k.rows.map((r) => r.length)

/** Chart width in layout units for a window: sidebar 240px, 2rem padding, at the default 14px font. */
const windowUnits = (px: number): number => Math.floor(((px - 240) * 16) / 14 - 32)
const W1280 = windowUnits(1280)
const W1600 = windowUnits(1600)
const W1920 = windowUnits(1920)

/** Everything the screen relies on: boxes never narrower than the minimum, cards never squeezed, children inside their parent. */
function check(k: OrgKidsPlan): void {
  for (const p of all(k)) {
    expect(p.box).toBeGreaterThanOrEqual(ORG_BOX_MIN)
    expect(p.box).toBeLessThanOrEqual(p.outer)
    expect(p.cols).toBeGreaterThanOrEqual(1)
    expect(p.cols).toBeLessThanOrEqual(4)
    // the cards of the box are at least the minimum card width
    expect((p.box - ORG_BOX_PAD - (p.cols - 1) * ORG_CARD_GAP) / p.cols).toBeGreaterThanOrEqual(ORG_CARD_MIN)
    if (p.kids) {
      expect(p.kids.width + (p.kids.mode === 'stack' ? ORG_INDENT : 0)).toBeLessThanOrEqual(p.outer)
      for (const row of p.kids.rows) {
        const used = row.reduce((sum, c) => sum + c.outer + (p.kids!.mode === 'rows' ? 2 * ORG_NODE_PAD : 0), 0)
        expect(used).toBeLessThanOrEqual(p.kids.width)
      }
      if (p.kids.mode === 'stack') for (const [c] of p.kids.rows) expect(c.box).toBe(p.box - ORG_INDENT)
    }
  }
}

describe('org chart layout: boxes and member columns', () => {
  it('sizes a box from its columns of cards, with a minimum width', () => {
    expect(boxWidth(1)).toBe(ORG_BOX_MIN)
    expect(boxWidth(2)).toBe(2 * ORG_CARD_MIN + ORG_CARD_GAP + ORG_BOX_PAD)
    expect(boxWidth(4)).toBe(4 * ORG_CARD_MIN + 3 * ORG_CARD_GAP + ORG_BOX_PAD)
    for (const cols of [1, 2, 3, 4]) expect(fitColumns(boxWidth(cols))).toBe(cols)
    expect(fitColumns(boxWidth(2) - 1)).toBe(1)
    expect(fitColumns(100)).toBe(1)
    expect(fitColumns(5000)).toBe(4)
  })

  it('chooses 1 to 4 columns from the head count and the room', () => {
    expect([0, 1, 2, 4, 5, 9, 10, 60].map(wantedColumns)).toEqual([1, 1, 2, 2, 3, 3, 4, 4])
    expect([1, 8, 9, 20, 21, 60].map(neededColumns)).toEqual([1, 1, 2, 2, 3, 3])
    expect(memberColumnsFor(3, 2000)).toBe(2)
    expect(memberColumnsFor(20, 2000)).toBe(4)
    expect(memberColumnsFor(20, boxWidth(3))).toBe(3)
    expect(memberColumnsFor(20, 260)).toBe(1)
    // asked to match narrower neighbours, but a big department keeps the columns it needs
    expect(memberColumnsFor(6, 2000, 1)).toBe(1)
    expect(memberColumnsFor(26, 2000, 1)).toBe(3)
  })
})

describe('org chart layout: rows', () => {
  it('evens out rows and keeps a too wide item on its own row', () => {
    expect(evenRows(6, 2)).toEqual([3, 3])
    expect(evenRows(7, 3)).toEqual([3, 2, 2])
    expect(wrapRows([260, 260, 260, 260, 260, 260], 1100)).toEqual([3, 3])
    expect(wrapRows([260, 260, 260], 1100)).toEqual([3])
    expect(wrapRows([2000, 260, 260], 1100)).toEqual([1, 2])
    // evening out would overflow the first row: keep the greedy rows
    expect(wrapRows([300, 300, 900, 100], 1000)).toEqual([2, 2])
    expect(wrapRows([500, 100, 900, 100, 100], 1000)).toEqual([2, 2, 1])
  })

  it('puts a few small departments in one row at every window size', () => {
    for (const avail of [W1280, W1600, W1920]) {
      const plan = planOrgChart([d(2), d(1)], avail)
      expect(sizes(plan.kids)).toEqual([2])
      expect(plan.width).toBeLessThanOrEqual(avail)
      expect(plan.width).toBeGreaterThanOrEqual(ORG_ROOT_MIN)
      check(plan.kids)
    }
    // 8 people in 2 departments: both get the columns they would like
    const two = planOrgChart([d(4), d(2)], W1280)
    expect(two.kids.rows[0].map((p) => p.cols)).toEqual([2, 2])
  })

  it('wraps six departments onto two even rows at 1280 and keeps one row when there is room', () => {
    const six = (): OrgLayoutItem[] => [d(4), d(3), d(5), d(2), d(3), d(1)]
    const narrow = planOrgChart(six(), W1280)
    expect(sizes(narrow.kids)).toEqual([3, 3])
    expect(narrow.width).toBeLessThanOrEqual(W1280)
    check(narrow.kids)
    const wide = planOrgChart(six(), W1920)
    expect(sizes(wide.kids)).toEqual([6])
    expect(wide.width).toBeLessThanOrEqual(W1920)
    check(wide.kids)
  })

  it('gives wrapped rows the same columns: a roomier last row does not get wider boxes', () => {
    const plan = planOrgChart([d(4), d(3), d(3), d(2), d(2)], W1280)
    expect(sizes(plan.kids)).toEqual([3, 2])
    expect(new Set(plan.kids.rows.flat().map((p) => p.cols))).toEqual(new Set([1]))
    // ... but a big department still gets the columns it needs
    const big = planOrgChart([d(4), d(3), d(3), d(2), d(26)], W1280)
    expect(big.kids.rows.flat().at(-1)!.cols).toBeGreaterThanOrEqual(3)
    check(big.kids)
  })

  it('wrapped rows leave room for the line that joins them', () => {
    const plan = planOrgChart(Array.from({ length: 15 }, () => d(3)), W1280)
    expect(plan.kids.rows.length).toBeGreaterThan(1)
    const widest = Math.max(...plan.kids.rows.map((r) => r.reduce((sum, p) => sum + p.outer + 2 * ORG_NODE_PAD, 0)))
    expect(plan.kids.width).toBe(widest + ORG_SPINE)
    expect(plan.width).toBeLessThanOrEqual(W1280)
  })

  it('one big department uses up to four columns of cards', () => {
    const plan = planOrgChart([d(26), d(9)], W1920)
    expect(plan.kids.rows[0].map((p) => p.cols)).toEqual([4, 3])
    const tight = planOrgChart([d(26), d(9)], W1280)
    expect(tight.width).toBeLessThanOrEqual(W1280)
    check(tight.kids)
  })
})

describe('org chart layout: levels', () => {
  it('keeps the teams of the only department in wrapped rows below it', () => {
    const plan = planOrgChart([d(0, [d(4), d(3), d(3), d(2), d(2)])], W1280)
    const top = plan.kids.rows[0][0]
    expect(top.kids?.mode).toBe('rows')
    expect(sizes(top.kids!)).toEqual([3, 2])
    expect(sizes(planOrgChart([d(0, [d(4), d(3), d(3), d(2), d(2)])], W1920).kids.rows[0][0].kids!)).toEqual([5])
    check(plan.kids)
  })

  it(`stacks departments from depth ${ORG_COMPACT_DEPTH} below their parent, each as wide as the stack`, () => {
    const org = (): OrgLayoutItem[] => [
      d(0, [d(1, [d(4), d(3), d(2)]), d(1, [d(5), d(4)]), d(6)]),
      d(0, [d(2, [d(4), d(3)]), d(11), d(5)])
    ]
    for (const avail of [W1280, W1600, W1920]) {
      const plan = planOrgChart(org(), avail)
      expect(plan.width).toBeLessThanOrEqual(avail)
      check(plan.kids)
      for (const top of plan.kids.rows.flat()) {
        expect(top.kids?.mode).toBe('rows')
        for (const mid of top.kids!.rows.flat()) if (mid.kids) expect(mid.kids.mode).toBe('stack')
      }
    }
    // 1280: one bureau per row, its divisions side by side; 1920 is wide enough for more
    expect(sizes(planOrgChart(org(), W1280).kids)).toEqual([1, 1])
    expect(sizes(planOrgChart(org(), W1280).kids.rows[0][0].kids!)).toEqual([3])
  })

  it('stays legible six levels deep: the width grows by one indent per stacked level only', () => {
    const deep = d(2, [d(1, [d(3, [d(4, [d(2, [d(3), d(2)])]), d(2)])]), d(3)])
    expect(narrowestWidth(deep)).toBe(ORG_BOX_MIN + 5 * ORG_INDENT)
    const plan = planOrgChart([deep, d(2)], W1280)
    expect(plan.width).toBeLessThanOrEqual(W1280)
    check(plan.kids)
    const boxes = all(plan.kids)
    expect(boxes).toHaveLength(10)
    expect(Math.min(...boxes.map((p) => p.box))).toBeGreaterThanOrEqual(ORG_BOX_MIN)
  })

  it('stacks the children when not even two fit side by side', () => {
    const top = planBranch(d(1, [d(2), d(2), d(2)]), 0, 400)
    expect(top.kids?.mode).toBe('stack')
    expect(top.outer).toBeLessThanOrEqual(400)
    expect(top.kids!.rows.map((r) => r[0].box)).toEqual([top.box - ORG_INDENT, top.box - ORG_INDENT, top.box - ORG_INDENT])
  })

  it('a chosen department is the top of the chart', () => {
    const plan = planOrgChart([d(3, [d(2), d(2)])], W1280, true)
    expect(sizes(plan.kids)).toEqual([1])
    expect(plan.width).toBe(plan.kids.rows[0][0].outer)
    expect(planOrgChart([], W1280).kids.rows).toEqual([])
  })

  it('fits the width for many shapes of organisation (or is as narrow as it can be)', () => {
    let seed = 7
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n)
    const make = (depth: number): OrgLayoutItem => d(rnd(12) === 0 ? 30 : rnd(9), depth < 5 && rnd(3) > 0 ? Array.from({ length: 1 + rnd(depth === 0 ? 6 : 3) }, () => make(depth + 1)) : [])
    for (let i = 0; i < 300; i++) {
      const roots = Array.from({ length: 1 + rnd(8) }, () => make(0))
      for (const avail of [500, 800, W1280, W1600, W1920]) {
        const plan = planOrgChart(roots, avail)
        check(plan.kids)
        const least = Math.max(...roots.map(narrowestWidth)) + 2 * ORG_NODE_PAD + ORG_SPINE
        expect(plan.width).toBeLessThanOrEqual(Math.max(avail, least))
        expect(all(plan.kids)).toHaveLength(all({ mode: 'rows', width: 0, rows: [roots.map(function ids(r): OrgBranchPlan { return { id: r.id, box: 0, cols: 1, outer: 0, kids: r.children.length ? { mode: 'rows', width: 0, rows: [r.children.map(ids)] } : null } })] }).length)
      }
    }
  })
})

describe('org chart layout: zoom', () => {
  it('fits by scaling down only as far as the floor', () => {
    expect(fitScale(1000, 800)).toBe(1)
    expect(fitScale(1000, 1000)).toBe(1)
    expect(fitScale(1000, 1100)).toBe(0.9)
    expect(fitScale(1000, 1250)).toBe(ORG_FIT_FLOOR)
    expect(fitScale(1000, 5000)).toBe(ORG_FIT_FLOOR)
    expect(fitScale(0, 5000)).toBe(1)
    expect(overflowsAtFloor(1000, 1250)).toBe(false)
    expect(overflowsAtFloor(1000, 1300)).toBe(true)
  })

  it('a fitted chart shows more departments per row and still fits the window', () => {
    const roots = Array.from({ length: 5 }, () => d(3))
    expect(sizes(planOrgChart(roots, W1280).kids)).toEqual([3, 2])
    const widest = planOrgChart(roots, W1280 / ORG_FIT_FLOOR).width
    const scale = fitScale(W1280, widest)
    expect(scale).toBeGreaterThanOrEqual(ORG_FIT_FLOOR)
    expect(scale).toBeLessThan(1)
    const fitted = planOrgChart(roots, Math.floor(W1280 / scale))
    expect(sizes(fitted.kids)).toEqual([5])
    expect(fitted.width * scale).toBeLessThanOrEqual(W1280)
  })

  it('steps the zoom by 10% between the limits', () => {
    expect(stepZoom(1, -0.1)).toBe(0.9)
    expect(stepZoom(0.84, 0.1)).toBe(0.9)
    expect(stepZoom(ORG_MIN_ZOOM, -0.1)).toBe(ORG_MIN_ZOOM)
    expect(stepZoom(ORG_MAX_ZOOM, 0.1)).toBe(ORG_MAX_ZOOM)
    expect(ORG_MIN_ZOOM).toBeGreaterThanOrEqual(0.6)
  })
})
