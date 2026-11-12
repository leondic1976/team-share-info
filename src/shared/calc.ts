/** Calculation tools (6.12 ③): calculator, date math, unit conversion. Pure functions. */

// ---------- calculator ----------
/**
 * Evaluate + - * / % ^ and parentheses without eval(). Accepts 1,234.5 style
 * thousands separators and × ÷. Throws on invalid input.
 */
export function evalExpression(src: string): number {
  const s = src.replace(/,/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/\s+/g, '')
  let i = 0
  const peek = (): string => s[i] ?? ''
  const fail = (): never => {
    throw new Error('계산식이 올바르지 않습니다.')
  }
  const number = (): number => {
    const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(s.slice(i))
    if (!m) return fail()
    i += m[0].length
    return Number(m[0])
  }
  const factor = (): number => {
    const c = peek()
    if (c === '+') {
      i++
      return factor()
    }
    if (c === '-') {
      i++
      return -factor()
    }
    let v: number
    if (c === '(') {
      i++
      v = expr()
      if (peek() !== ')') fail()
      i++
    } else v = number()
    if (peek() === '%') {
      i++
      v /= 100
    }
    if (peek() === '^') {
      i++
      v = Math.pow(v, factor())
    }
    return v
  }
  const term = (): number => {
    let v = factor()
    for (;;) {
      const c = peek()
      if (c === '*') {
        i++
        v *= factor()
      } else if (c === '/') {
        i++
        const d = factor()
        if (d === 0) throw new Error('0으로 나눌 수 없습니다.')
        v /= d
      } else return v
    }
  }
  const expr = (): number => {
    let v = term()
    for (;;) {
      const c = peek()
      if (c === '+') {
        i++
        v += term()
      } else if (c === '-') {
        i++
        v -= term()
      } else return v
    }
  }
  if (!s) fail()
  const v = expr()
  if (i !== s.length || !Number.isFinite(v)) fail()
  // Hide binary float noise (0.1 + 0.2).
  return Number(v.toPrecision(15))
}

// ---------- dates (local calendar days, 'YYYY-MM-DD') ----------
const parse = (ymd: string): Date => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const fmt = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Calendar days from a to b (b - a). Uses noon to avoid DST edges. */
export function daysBetween(a: string, b: string): number {
  const x = parse(a)
  const y = parse(b)
  x.setHours(12)
  y.setHours(12)
  return Math.round((y.getTime() - x.getTime()) / 86400000)
}

/** "D-3", "D-Day", "D+2" for a target date seen from today. */
export function dDay(target: string, today: string): string {
  const n = daysBetween(today, target)
  return n === 0 ? 'D-Day' : n > 0 ? `D-${n}` : `D+${-n}`
}

export function addDays(date: string, n: number): string {
  const d = parse(date)
  d.setDate(d.getDate() + n)
  return fmt(d)
}

const isWorkday = (d: Date, holidays: Set<string>): boolean => d.getDay() !== 0 && d.getDay() !== 6 && !holidays.has(fmt(d))

/** Working days in [from, to] inclusive, excluding weekends and holidays. */
export function workdaysBetween(from: string, to: string, holidays: Set<string> = new Set()): number {
  let [a, b] = [from, to]
  if (daysBetween(a, b) < 0) [a, b] = [b, a]
  let n = 0
  for (let d = parse(a); fmt(d) <= b; d.setDate(d.getDate() + 1)) if (isWorkday(d, holidays)) n++
  return n
}

/** Date that is n working days after (n > 0) or before (n < 0) the given date. */
export function addWorkdays(date: string, n: number, holidays: Set<string> = new Set()): string {
  const d = parse(date)
  const step = n < 0 ? -1 : 1
  let left = Math.abs(n)
  while (left > 0) {
    d.setDate(d.getDate() + step)
    if (isWorkday(d, holidays)) left--
  }
  return fmt(d)
}

// ---------- unit conversion ----------
export interface UnitCategory {
  label: string
  units: Record<string, { label: string; factor: number }>
}

/** factor = value of 1 unit in the base unit of the category. */
export const UNITS: Record<string, UnitCategory> = {
  length: {
    label: '길이',
    units: {
      mm: { label: 'mm', factor: 0.001 },
      cm: { label: 'cm', factor: 0.01 },
      m: { label: 'm', factor: 1 },
      km: { label: 'km', factor: 1000 },
      in: { label: '인치', factor: 0.0254 },
      ft: { label: '피트', factor: 0.3048 },
      yd: { label: '야드', factor: 0.9144 },
      mi: { label: '마일', factor: 1609.344 },
      ja: { label: '자(尺)', factor: 10 / 33 }
    }
  },
  area: {
    label: '넓이',
    units: {
      m2: { label: '㎡', factor: 1 },
      pyeong: { label: '평', factor: 400 / 121 },
      a: { label: '아르(a)', factor: 100 },
      ha: { label: '헥타르(ha)', factor: 10_000 },
      km2: { label: '㎢', factor: 1_000_000 },
      ft2: { label: '제곱피트', factor: 0.09290304 }
    }
  },
  weight: {
    label: '무게',
    units: {
      g: { label: 'g', factor: 1 },
      kg: { label: 'kg', factor: 1000 },
      t: { label: '톤', factor: 1_000_000 },
      lb: { label: '파운드', factor: 453.59237 },
      oz: { label: '온스', factor: 28.349523125 },
      don: { label: '돈', factor: 3.75 },
      geun: { label: '근(600g)', factor: 600 }
    }
  },
  data: {
    label: '데이터',
    units: {
      B: { label: 'B', factor: 1 },
      KB: { label: 'KB', factor: 1024 },
      MB: { label: 'MB', factor: 1024 ** 2 },
      GB: { label: 'GB', factor: 1024 ** 3 },
      TB: { label: 'TB', factor: 1024 ** 4 }
    }
  },
  temperature: {
    label: '온도',
    units: {
      C: { label: '섭씨(℃)', factor: 1 },
      F: { label: '화씨(℉)', factor: 1 },
      K: { label: '켈빈(K)', factor: 1 }
    }
  }
}

export function convertUnit(category: string, value: number, from: string, to: string): number {
  if (category === 'temperature') {
    const c = from === 'C' ? value : from === 'F' ? ((value - 32) * 5) / 9 : value - 273.15
    const out = to === 'C' ? c : to === 'F' ? (c * 9) / 5 + 32 : c + 273.15
    return Number(out.toPrecision(12))
  }
  const cat = UNITS[category]
  const f = cat?.units[from]
  const t = cat?.units[to]
  if (!f || !t) throw new Error('알 수 없는 단위입니다.')
  return Number(((value * f.factor) / t.factor).toPrecision(12))
}
