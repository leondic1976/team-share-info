import { describe, it, expect } from 'vitest'
import { csvToContacts, parseCsv, toCsv } from '../../src/shared/csv'

describe('csv', () => {
  it('round-trips quotes, commas and newlines with a BOM', () => {
    const rows = [
      ['기관', '이름', '메모'],
      ['A사, 본사', '김"대리"', '줄1\n줄2']
    ]
    const text = toCsv(rows)
    expect(text.startsWith('﻿')).toBe(true)
    expect(parseCsv(text)).toEqual(rows)
  })
  it('maps Korean/English headers to contact fields', () => {
    const c = csvToContacts(parseCsv('성명,회사,휴대전화,unknown\r\n홍길동,○○구청,010-1,x\r\n'))
    expect(c).toEqual([{ name: '홍길동', org: '○○구청', mobile: '010-1' }])
  })
})
