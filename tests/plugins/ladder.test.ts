import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

interface LadderApi {
  generate: (lines: number, rows: number, seed?: number) => boolean[][]
  trace: (grid: boolean[][], start: number) => { end: number; steps: number[][] }
  mapping: (grid: boolean[][], lines: number) => number[]
  preset: (kind: string, n: number, o?: Record<string, unknown>) => string[]
  parseList: (t: string) => string[]
}
const ctx: { Ladder?: LadderApi; crypto: typeof globalThis.crypto } = { crypto: globalThis.crypto }
runInNewContext(readFileSync(join(import.meta.dirname, '../../plugins/ladder/ladder.js'), 'utf8'), ctx)
const L = ctx.Ladder!

describe('ladder plugin logic', () => {
  it('rungs never touch, every gap has a rung, result is a permutation', () => {
    for (let t = 0; t < 3000; t++) {
      const lines = 2 + (t % 29)
      const g = L.generate(lines, [4, 8, 12, 18][t % 4])
      for (const row of g) for (let x = 1; x < row.length; x++) expect(row[x] && row[x - 1]).toBe(false)
      for (let x = 0; x < lines - 1; x++) expect(g.some((r) => r[x])).toBe(true)
      expect([...L.mapping(g, lines)].sort((a, b) => a - b)).toEqual(Array.from({ length: lines }, (_, i) => i))
    }
  })

  it('seeded ladders are reproducible and trace follows rungs', () => {
    expect(L.generate(6, 10, 42)).toEqual(L.generate(6, 10, 42))
    const g = [
      [true, false, false],
      [false, true, false],
      [false, false, true]
    ]
    expect(L.trace(g, 0).end).toBe(3)
    expect(L.mapping(g, 4)).toEqual([3, 0, 1, 2])
  })

  it('presets fit the number of lines', () => {
    expect(L.preset('winner', 5, { winners: 2 })).toEqual(['당첨', '당첨', '꽝', '꽝', '꽝'])
    expect(L.preset('order', 3)).toEqual(['1등', '2등', '3등'])
    expect(L.preset('teams', 5, { teams: 2 })).toEqual(['A팀', 'B팀', 'A팀', 'B팀', 'A팀'])
    expect(L.preset('coffee', 3)).toEqual(['커피 쏘기', '꽝', '꽝'])
    expect(L.preset('custom', 3, { custom: ['1만원', '2만원'] })).toEqual(['1만원', '2만원', '꽝'])
    expect(L.parseList('김, 이\n박 ,,')).toEqual(['김', '이', '박'])
  })
})
