/*
 * Org chart layout: pure decisions about where the boxes of the chart go, so that the chart
 * always fits the width it is given by wrapping instead of shrinking.
 *
 * All sizes are in "units" of 1/16 rem (a pixel when the app font size is 16px); the screen
 * turns its width into units and writes the results back as rem, so the layout follows the
 * font size setting.
 *
 * The rules:
 * - Departments below the same parent sit side by side and wrap onto more rows when they do
 *   not fit the width (rows are evened out, e.g. 3 + 3 instead of 4 + 2).
 * - From ORG_COMPACT_DEPTH on (and when not even two departments fit side by side) the
 *   departments below a box are stacked under it, indented, each as wide as the stack.
 * - People inside a box wrap into 1..4 columns of cards that are never narrower than
 *   ORG_CARD_MIN.
 */

/** Narrowest person card. */
export const ORG_CARD_MIN = 200
/** Space between two person cards. */
export const ORG_CARD_GAP = 8
/** Padding and border of a department box around its cards. */
export const ORG_BOX_PAD = 18
/** Narrowest department box. */
export const ORG_BOX_MIN = 240
/** Most columns of person cards in one box. */
export const ORG_MAX_COLS = 4
/** Space on each side of a department in a row (two neighbours are twice this apart). */
export const ORG_NODE_PAD = 10
/** Room on the left of wrapped rows for the line that joins them. */
export const ORG_SPINE = 20
/** How far stacked departments are indented below their parent. */
export const ORG_INDENT = 24
/** Narrowest top box (the organisation / team). */
export const ORG_ROOT_MIN = 256
/** Departments at this depth and deeper (top level = 0) are stacked below their parent. */
export const ORG_COMPACT_DEPTH = 2
/** "Fit to screen" never makes the chart smaller than this; below it the chart scrolls. */
export const ORG_FIT_FLOOR = 0.8
export const ORG_MIN_ZOOM = 0.6
export const ORG_MAX_ZOOM = 1.5

/** What the layout needs to know about one department. A folded department has no cards and no children. */
export interface OrgLayoutItem {
  id: string
  /** person cards in the grid of the box (the head, who takes a row of their own, is not counted) */
  cards: number
  children: OrgLayoutItem[]
}

export interface OrgKidsPlan {
  /** rows: side by side, one entry per row; stack: one below the other (one department per row) */
  mode: 'rows' | 'stack'
  rows: OrgBranchPlan[][]
  /** width of the whole group, with the room for its connector lines */
  width: number
}

export interface OrgBranchPlan {
  id: string
  /** width of the department box */
  box: number
  /** columns of person cards in the box */
  cols: number
  /** width of the box together with everything below it */
  outer: number
  kids: OrgKidsPlan | null
}

export interface OrgChartPlan {
  /** width the chart needs; more than the given width only when it cannot be made to fit */
  width: number
  /** the top-level departments (for a single department: one row with that department) */
  kids: OrgKidsPlan
}

/** Width of a department box with this many columns of cards. */
export function boxWidth(cols: number): number {
  return Math.max(ORG_BOX_MIN, cols * ORG_CARD_MIN + (cols - 1) * ORG_CARD_GAP + ORG_BOX_PAD)
}

/** How many columns of cards fit into a box this wide (1..4). */
export function fitColumns(width: number): number {
  return Math.max(1, Math.min(ORG_MAX_COLS, Math.floor((width - ORG_BOX_PAD + ORG_CARD_GAP) / (ORG_CARD_MIN + ORG_CARD_GAP))))
}

/** Columns a box would like for this many cards when there is room. */
export function wantedColumns(cards: number): number {
  if (cards <= 1) return 1
  if (cards <= 4) return 2
  if (cards <= 9) return 3
  return ORG_MAX_COLS
}

/** Columns a box should get so that it does not become a very long single column. */
export function neededColumns(cards: number): number {
  if (cards <= 8) return 1
  if (cards <= 20) return 2
  return 3
}

/**
 * Columns of cards for a box that may be up to `avail` wide: as many as it would like and as fit.
 * `most` asks for fewer (to match the boxes around it), but not fewer than the box needs.
 */
export function memberColumnsFor(cards: number, avail: number, most = ORG_MAX_COLS): number {
  return Math.min(wantedColumns(cards), fitColumns(avail), Math.max(most, neededColumns(cards)))
}

/** Columns of cards for a box of a fixed width (a stacked box fills the stack). */
function filledColumns(cards: number, width: number): number {
  return Math.max(1, Math.min(fitColumns(width), cards))
}

/** The narrowest a department and everything below it can be: all stacked, one column of cards. */
export function narrowestWidth(it: OrgLayoutItem): number {
  return it.children.reduce((w, c) => Math.max(w, ORG_INDENT + narrowestWidth(c)), ORG_BOX_MIN)
}

/**
 * The width a department asks for when rows are filled: enough for its cards not to be one long
 * column and for the departments right below it to stay side by side, but never more than `cap`.
 */
function askedWidth(it: OrgLayoutItem, depth: number, cap: number): number {
  let w = boxWidth(neededColumns(it.cards))
  if (it.children.length) {
    if (depth + 1 >= ORG_COMPACT_DEPTH) w = Math.max(w, ORG_INDENT + Math.max(...it.children.map((c) => askedWidth(c, depth + 1, cap - ORG_INDENT))))
    else w = Math.max(w, it.children.reduce((sum, c) => sum + askedWidth(c, depth + 1, cap) + 2 * ORG_NODE_PAD, 0))
  }
  return Math.max(narrowestWidth(it), Math.min(w, cap))
}

/** Row sizes for `count` things in `rows` rows, as even as possible, the fuller rows first. */
export function evenRows(count: number, rows: number): number[] {
  const base = Math.floor(count / rows)
  return Array.from({ length: rows }, (_, i) => base + (i < count % rows ? 1 : 0))
}

/**
 * Split widths (in their order) into rows no wider than `avail`. Rows are evened out by count
 * when that still fits; a single width larger than `avail` gets a row of its own.
 */
export function wrapRows(widths: number[], avail: number): number[] {
  const greedy: number[] = []
  let used = 0
  for (const w of widths) {
    if (greedy.length && used + w <= avail) {
      greedy[greedy.length - 1]++
      used += w
    } else {
      greedy.push(1)
      used = w
    }
  }
  const even = evenRows(widths.length, greedy.length)
  let at = 0
  for (const size of even) {
    const sum = widths.slice(at, at + size).reduce((a, b) => a + b, 0)
    if (size > 1 && sum > avail) return greedy
    at += size
  }
  return even
}

/** Departments side by side in as few rows as fit `avail`. */
function planRows(items: OrgLayoutItem[], depth: number, avail: number): OrgKidsPlan {
  const pad = 2 * ORG_NODE_PAD
  const cap = avail - ORG_SPINE - pad
  const asked = items.map((it) => askedWidth(it, depth, cap) + pad)
  const single = asked.reduce((a, b) => a + b, 0) <= avail
  const room = single ? avail : avail - ORG_SPINE
  const sizes = single ? [items.length] : wrapRows(asked, room)
  const first = fillRows(items, depth, sizes, asked, room)
  if (first.length < 2) return rowsPlan(first)
  // wrapped rows look like one grid: a roomier row does not get wider boxes than a row that is short of room
  const cards = new Map(items.map((it) => [it.id, it.cards]))
  const tight = first.filter((r) => r.some((p) => p.cols < wantedColumns(cards.get(p.id) ?? 0)))
  if (!tight.length) return rowsPlan(first)
  const most = Math.min(...tight.map((r) => Math.max(...r.map((p) => p.cols))))
  return rowsPlan(first.some((r) => r.some((p) => p.cols > most)) ? fillRows(items, depth, sizes, asked, room, most) : first)
}

function rowsPlan(rows: OrgBranchPlan[][]): OrgKidsPlan {
  const widest = Math.max(...rows.map((r) => r.reduce((sum, p) => sum + p.outer + 2 * ORG_NODE_PAD, 0)))
  return { mode: 'rows', rows, width: widest + (rows.length > 1 ? ORG_SPINE : 0) }
}

/** The departments of every row, sharing the width of their row; `most`: no box gets more columns of cards. */
function fillRows(items: OrgLayoutItem[], depth: number, sizes: number[], asked: number[], room: number, most = ORG_MAX_COLS): OrgBranchPlan[][] {
  const pad = 2 * ORG_NODE_PAD
  const rows: OrgBranchPlan[][] = []
  let at = 0
  for (const size of sizes) {
    const row = items.slice(at, at + size)
    const min = asked.slice(at, at + size).map((w) => w - pad)
    at += size
    // what each would take with the whole row to itself
    const free = row.map((it) => planBranch(it, depth, room - pad, undefined, most))
    if (free.reduce((sum, p) => sum + p.outer + pad, 0) <= room) {
      rows.push(free)
      continue
    }
    // not enough for all: everyone gets what they asked for, the rest goes to those who want more
    const spare = Math.max(0, room - min.reduce((sum, w) => sum + w + pad, 0))
    const grow = free.map((p, i) => Math.max(0, p.outer - min[i]))
    const growSum = grow.reduce((a, b) => a + b, 0)
    rows.push(row.map((it, i) => planBranch(it, depth, size === 1 ? room - pad : min[i] + (growSum > 0 ? Math.floor((spare * grow[i]) / growSum) : 0), undefined, most)))
  }
  return rows
}

/**
 * One department and everything below it, at most `avail` wide (wider only when even the
 * narrowest form does not fit). With `fill` the box takes exactly that width (a stacked box);
 * `most` limits the columns of cards of this box (not of the ones below it).
 */
export function planBranch(it: OrgLayoutItem, depth: number, avail: number, fill?: number, most = ORG_MAX_COLS): OrgBranchPlan {
  const room = Math.max(avail, narrowestWidth(it))
  const cols = memberColumnsFor(it.cards, room, most)
  const natural = boxWidth(cols)
  if (!it.children.length) {
    const box = fill ?? natural
    return { id: it.id, box, cols: fill === undefined ? cols : filledColumns(it.cards, fill), outer: box, kids: null }
  }
  if (fill === undefined && depth + 1 < ORG_COMPACT_DEPTH) {
    const kids = planRows(it.children, depth + 1, room)
    // one per row is a stack: draw it as one
    if (it.children.length === 1 || kids.rows.length < it.children.length) {
      return { id: it.id, box: natural, cols, outer: Math.max(natural, kids.width), kids }
    }
  }
  const width = fill ?? Math.max(natural, ORG_INDENT + Math.max(...it.children.map((c) => planBranch(c, depth + 1, room - ORG_INDENT).outer)))
  const inner = width - ORG_INDENT
  const rows = it.children.map((c) => [planBranch(c, depth + 1, inner, inner)])
  return { id: it.id, box: width, cols: filledColumns(it.cards, width), outer: width, kids: { mode: 'stack', rows, width: inner } }
}

/**
 * The whole chart for a width of `avail`. `single`: the first item is the top of the chart
 * (one chosen department); otherwise the items hang in rows below the box of the organisation.
 */
export function planOrgChart(roots: OrgLayoutItem[], avail: number, single = false): OrgChartPlan {
  if (!roots.length) return { width: 0, kids: { mode: 'rows', rows: [], width: 0 } }
  if (single) {
    const top = planBranch(roots[0], 0, avail)
    return { width: top.outer, kids: { mode: 'rows', rows: [[top]], width: top.outer } }
  }
  const kids = planRows(roots, 0, Math.max(avail, ORG_BOX_MIN + 2 * ORG_NODE_PAD + ORG_SPINE))
  return { width: Math.max(kids.width, ORG_ROOT_MIN), kids }
}

/**
 * Scale for "fit to screen" (and for paper): `widest` is the width of the chart laid out for
 * `room / floor`, the most the smallest allowed scale can show. 1 when that fits as it is,
 * otherwise just small enough, and never below `floor` (the chart then scrolls).
 */
export function fitScale(room: number, widest: number, floor = ORG_FIT_FLOOR): number {
  if (room <= 0 || widest <= room) return 1
  return Math.max(floor, Math.min(1, Math.floor((room / widest) * 100) / 100))
}

/** True when the chart cannot fit `room` even at the smallest allowed scale. */
export function overflowsAtFloor(room: number, widest: number, floor = ORG_FIT_FLOOR): boolean {
  return room > 0 && widest > room / floor + 1
}

/** The next zoom step from `scale` (steps of 10%), kept inside the allowed range. */
export function stepZoom(scale: number, step: number): number {
  return Math.min(ORG_MAX_ZOOM, Math.max(ORG_MIN_ZOOM, Math.round((scale + step) * 10) / 10))
}
