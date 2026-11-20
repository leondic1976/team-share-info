/* Cost-splitting logic (no DOM). Amounts are whole won. Exposed as globalThis.Dutch; unit-tested in tests/plugins. */
;(function (g) {
  'use strict'

  const UNITS = [1, 10, 100, 1000, 10000]
  const MODES = { up: '올림', round: '반올림', down: '내림' }

  /** "12,000원", "1.2만", "3천" -> whole won (0 when it is not an amount). */
  function parseMoney(text) {
    const s = String(text == null ? '' : text).replace(/[,\s원]/g, '')
    if (!s) return 0
    const m = /^(-?\d+(?:\.\d+)?)(만|천)?$/.exec(s)
    if (!m) return 0
    const n = Number(m[1]) * (m[2] === '만' ? 10000 : m[2] === '천' ? 1000 : 1)
    return Number.isFinite(n) ? Math.round(n) : 0
  }

  const won = (n) => (n < 0 ? '-' : '') + Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원'

  function roundTo(n, unit, mode) {
    const u = UNITS.includes(unit) ? unit : 1
    const f = mode === 'up' ? Math.ceil : mode === 'down' ? Math.floor : Math.round
    return f(n / u) * u
  }

  /**
   * Split `amount` by weights into whole won that add up exactly (largest remainder first).
   * A weight of 0 pays nothing.
   */
  function allot(amount, weights) {
    const total = weights.reduce((a, b) => a + Math.max(0, b), 0)
    if (!(total > 0)) return weights.map(() => 0)
    const sign = amount < 0 ? -1 : 1
    const abs = Math.abs(Math.round(amount))
    const exact = weights.map((w) => (abs * Math.max(0, w)) / total)
    const out = exact.map(Math.floor)
    let left = abs - out.reduce((a, b) => a + b, 0)
    const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
    for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k][1]]++
    return out.map((x) => x * sign)
  }

  /**
   * Quick split: (total - deducted) is shared by `people`; `extraPayers` people each pay
   * `extra` more than the others (the one who treats, late-comers pay less = negative).
   * Each amount is rounded to `unit`; `diff` is what is collected beyond (+) or short of (-) the bill.
   */
  function quick(o) {
    const total = Math.max(0, Math.round(o.total || 0))
    const deducted = Math.min(total, Math.max(0, Math.round(o.deduct || 0)))
    const people = Math.max(1, Math.floor(o.people || 1))
    const extraPayers = Math.min(people, Math.max(0, Math.floor(o.extraPayers || 0)))
    const extra = extraPayers ? Math.round(o.extra || 0) : 0
    const toSplit = total - deducted
    // everyone pays base; extra payers pay base + extra:  people*base + extraPayers*extra = toSplit
    const baseExact = Math.max(0, (toSplit - extraPayers * extra) / people)
    const base = roundTo(baseExact, o.unit, o.mode)
    const more = Math.max(0, base + extra)
    const collected = base * (people - extraPayers) + more * extraPayers
    return { total, deducted, toSplit, people, extraPayers, each: base, eachExtra: more, exact: baseExact, collected, diff: collected - toSplit }
  }

  /**
   * Itemised settlement.
   *   people:   [{ id, name, weight }]           weight: default share ratio (1 = normal)
   *   expenses: [{ title, amount, payer, sharers: [id], weights?: { id: ratio } }]
   * Returns each person's share and payment, and the fewest transfers that settle it.
   * Transfers are rounded to `unit` (the receiver gains or loses the small difference).
   */
  function settle(people, expenses, opts) {
    const o = opts || {}
    const ids = people.map((p) => p.id)
    const share = Object.fromEntries(ids.map((id) => [id, 0]))
    const paid = Object.fromEntries(ids.map((id) => [id, 0]))
    const problems = []
    let total = 0
    expenses.forEach((e, i) => {
      const amount = Math.round(e.amount || 0)
      if (!amount) return
      const label = e.title || `${i + 1}번 항목`
      if (!ids.includes(e.payer)) return void problems.push(`${label}: 낸 사람을 고르세요.`)
      const sharers = (e.sharers || []).filter((id) => ids.includes(id))
      const weights = sharers.map((id) => {
        const own = e.weights && e.weights[id]
        const w = own === undefined || own === null || own === '' ? people.find((p) => p.id === id).weight : Number(own)
        return Number.isFinite(w) && w > 0 ? w : 0
      })
      if (!sharers.length || !weights.some((w) => w > 0)) return void problems.push(`${label}: 함께한 사람을 한 명 이상 고르세요.`)
      total += amount
      paid[e.payer] += amount
      allot(amount, weights).forEach((x, k) => (share[sharers[k]] += x))
    })
    const balance = Object.fromEntries(ids.map((id) => [id, paid[id] - share[id]]))

    // largest debtor pays the largest creditor until everybody is even
    const debt = ids.filter((id) => balance[id] < 0).map((id) => ({ id, left: -balance[id] }))
    const credit = ids.filter((id) => balance[id] > 0).map((id) => ({ id, left: balance[id] }))
    const transfers = []
    while (debt.length && credit.length) {
      debt.sort((a, b) => b.left - a.left)
      credit.sort((a, b) => b.left - a.left)
      const x = Math.min(debt[0].left, credit[0].left)
      transfers.push({ from: debt[0].id, to: credit[0].id, exact: x, amount: roundTo(x, o.unit || 1, o.mode || 'round') })
      debt[0].left -= x
      credit[0].left -= x
      if (!debt[0].left) debt.shift()
      if (credit.length && !credit[0].left) credit.shift()
    }
    const name = (id) => (people.find((p) => p.id === id) || {}).name || '?'
    return {
      total,
      problems,
      rows: people.map((p) => ({ id: p.id, name: p.name, share: share[p.id], paid: paid[p.id], balance: balance[p.id] })),
      transfers: transfers.filter((t) => t.amount > 0).map((t) => Object.assign(t, { fromName: name(t.from), toName: name(t.to) })),
      roundingDiff: transfers.reduce((a, t) => a + (t.amount - t.exact), 0)
    }
  }

  function quickText(r, o) {
    const lines = [`[정산] ${o.title || 'N분의 1'}`, `총 ${won(r.total)}${r.deducted ? ` - 먼저 뺀 금액 ${won(r.deducted)} = ${won(r.toSplit)}` : ''} ÷ ${r.people}명`]
    if (r.extraPayers) lines.push(`${r.extraPayers}명: ${won(r.eachExtra)} / 나머지 ${r.people - r.extraPayers}명: 1인 ${won(r.each)}`)
    else lines.push(`1인 ${won(r.each)}`)
    if (r.diff) lines.push(r.diff > 0 ? `(단위 맞춤으로 ${won(r.diff)} 남음)` : `(단위 맞춤으로 ${won(-r.diff)} 모자람)`)
    if (o.account) lines.push(`보낼 곳: ${o.account}`)
    return lines.join('\n')
  }

  function settleText(r, o) {
    const lines = [`[정산] ${o.title || '항목별 정산'} · 총 ${won(r.total)}`]
    r.rows.forEach((x) => lines.push(`- ${x.name}: 부담 ${won(x.share)}${x.paid ? `, 낸 돈 ${won(x.paid)}` : ''}`))
    lines.push(r.transfers.length ? '보낼 돈' : '주고받을 돈이 없습니다.')
    r.transfers.forEach((t) => lines.push(`  ${t.fromName} → ${t.toName} ${won(t.amount)}`))
    if (o.account) lines.push(`계좌: ${o.account}`)
    return lines.join('\n')
  }

  g.Dutch = { UNITS, MODES, parseMoney, won, roundTo, allot, quick, settle, quickText, settleText }
})(typeof window !== 'undefined' ? window : globalThis)
