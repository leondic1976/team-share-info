import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx: Record<string, any> = {}
runInNewContext(readFileSync(join(import.meta.dirname, '../../plugins/dutchpay/dutch.js'), 'utf8'), ctx)
const D = ctx.Dutch
const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0)

describe('dutchpay plugin: splitting costs', () => {
  it('reads amounts the way people type them', () => {
    expect(D.parseMoney('187,500원')).toBe(187500)
    expect(D.parseMoney('18.7만')).toBe(187000)
    expect(D.parseMoney('3천')).toBe(3000)
    expect(D.parseMoney('-5,000')).toBe(-5000)
    expect(D.parseMoney('abc')).toBe(0)
    expect(D.parseMoney('')).toBe(0)
    expect(D.won(1234567)).toBe('1,234,567원')
    expect(D.won(-500)).toBe('-500원')
  })

  it('allots whole won that always add up to the amount', () => {
    expect(D.allot(10000, [1, 1, 1])).toEqual([3334, 3333, 3333])
    expect(D.allot(10000, [1.5, 1, 0.5])).toEqual([5000, 3333, 1667])
    expect(D.allot(999, [1, 0, 1])).toEqual([500, 0, 499])
    expect(D.allot(100, [0, 0])).toEqual([0, 0])
    for (const [amount, w] of [[187500, [1, 1, 1, 1, 1, 1, 1]], [1, [1, 1, 1]], [77777, [2, 1, 0.5, 3]]] as [number, number[]][]) expect(sum(D.allot(amount, w))).toBe(amount)
  })

  it('quick split: rounding unit, what is left over or short', () => {
    const up = D.quick({ total: 187500, people: 7, unit: 100, mode: 'up' })
    expect(up).toMatchObject({ each: 26800, collected: 187600, diff: 100 })
    const down = D.quick({ total: 187500, people: 7, unit: 1000, mode: 'down' })
    expect(down).toMatchObject({ each: 26000, diff: -5500 })
    expect(D.quick({ total: 100000, people: 4, unit: 1, mode: 'round' })).toMatchObject({ each: 25000, diff: 0 })
    // a 50,000 subsidy comes off first
    expect(D.quick({ total: 250000, deduct: 50000, people: 8, unit: 100, mode: 'up' })).toMatchObject({ toSplit: 200000, each: 25000 })
    // one person pays 20,000 more than the other four
    expect(D.quick({ total: 120000, people: 5, extraPayers: 1, extra: 20000, unit: 100, mode: 'up' })).toMatchObject({ each: 20000, eachExtra: 40000, collected: 120000, diff: 0 })
    expect(D.quick({ total: 0, people: 0, unit: 100, mode: 'up' })).toMatchObject({ people: 1, each: 0 })
    expect(D.quickText(up, { title: '회식', account: '○○은행 1' })).toBe('[정산] 회식\n총 187,500원 ÷ 7명\n1인 26,800원\n(단위 맞춤으로 100원 남음)\n보낼 곳: ○○은행 1')
  })

  it('itemised: different payers and sharers settle with the fewest transfers', () => {
    const people = [
      { id: 'a', name: '김', weight: 1 },
      { id: 'b', name: '이', weight: 1 },
      { id: 'c', name: '박', weight: 1 }
    ]
    const r = D.settle(
      people,
      [
        { title: '1차', amount: 90000, payer: 'a', sharers: ['a', 'b', 'c'] },
        { title: '커피', amount: 12000, payer: 'b', sharers: ['a', 'b'] }
      ],
      { unit: 1, mode: 'round' }
    )
    expect(r.total).toBe(102000)
    expect(r.rows.map((x: any) => [x.name, x.share, x.paid, x.balance])).toEqual([
      ['김', 36000, 90000, 54000],
      ['이', 36000, 12000, -24000],
      ['박', 30000, 0, -30000]
    ])
    expect(sum(r.rows.map((x: any) => x.balance))).toBe(0)
    expect(r.transfers.map((t: any) => [t.fromName, t.toName, t.amount])).toEqual([
      ['박', '김', 30000],
      ['이', '김', 24000]
    ])
    expect(D.settleText(r, { title: '워크숍' })).toContain('박 → 김 30,000원')
  })

  it('itemised: weights, rounding of transfers and incomplete items', () => {
    const people = [
      { id: 'a', name: '과장', weight: 2 },
      { id: 'b', name: '주무관', weight: 1 },
      { id: 'c', name: '안 마신 사람', weight: 0 }
    ]
    const r = D.settle(people, [{ title: '2차', amount: 100000, payer: 'b', sharers: ['a', 'b', 'c'] }], { unit: 1000, mode: 'up' })
    expect(r.rows.map((x: any) => x.share)).toEqual([66667, 33333, 0])
    expect(r.transfers).toHaveLength(1)
    expect(r.transfers[0]).toMatchObject({ from: 'a', to: 'b', exact: 66667, amount: 67000 })
    expect(r.roundingDiff).toBe(333)
    const bad = D.settle(people, [{ title: '택시', amount: 9000, payer: '', sharers: ['a'] }, { amount: 5000, payer: 'a', sharers: [] }, { amount: 0, payer: '', sharers: [] }], {})
    expect(bad.total).toBe(0)
    expect(bad.problems).toEqual(['택시: 낸 사람을 고르세요.', '2번 항목: 함께한 사람을 한 명 이상 고르세요.'])
  })
})
