import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { detectPii, detectPiiIn, isPiiRefusal, piiCounts, piiMessage, plainText } from '../../src/shared/pii'

const kinds = (t: string): string[] => detectPii(t).map((f) => f.kind)

describe('personal information check before sending', () => {
  it('finds resident and foreigner numbers, and hides most of them in the sample', () => {
    const f = detectPii('주민번호 900101-1234567 입니다. 외국인 8505056123456')
    expect(f.map((x) => [x.kind, x.count, x.samples])).toEqual([
      ['rrn', 1, ['900101-1******']],
      ['foreigner', 1, ['8505056******']]
    ])
    // not a date, or just a long number
    expect(kinds('991301-1234567')).toEqual([])
    expect(kinds('문서번호 20261120-1234567890')).toEqual([])
    expect(kinds('1234567890123456789')).toEqual([])
  })

  it('finds phones, e-mail, cards, accounts, passports and licences', () => {
    expect(detectPii('연락처 010-1234-5678, 01098765432')[0]).toMatchObject({ kind: 'mobile', count: 2, samples: ['010-****-****', '010********'] })
    expect(kinds('hong.gd@example.go.kr 로 보내 주세요')).toEqual(['email'])
    expect(kinds('카드 4111-1111-1111-1111')).toEqual(['card'])
    expect(kinds('번호 4111-1111-1111-1112')).toEqual([]) // fails the card checksum
    expect(detectPii('농협 301-0123-4567-89 홍길동')[0]).toMatchObject({ kind: 'account', samples: ['301-****-****-**'] })
    expect(kinds('계좌번호: 3020123456781')).toEqual(['account'])
    expect(kinds('여권 M12345678, 신여권 M123A4567')).toEqual(['passport'])
    expect(kinds('면허 11-23-123456-78')).toEqual(['license'])
  })

  it('leaves ordinary office text alone', () => {
    for (const t of ['내선 1234로 전화 주세요', '14시 회의 자료 지참', '예산 187,500원 (7명)', '2026-11-20 14:00 ~ 15:30', '02-123-4567 민원실', '문서 제2026-123호', 'v1.3.0 release'])
      expect(kinds(t), t).toEqual([])
  })

  it('reads rich text the way the reader sees it and words the question', () => {
    expect(kinds(plainText('<p>담당: <b>010</b>-1234-<i>5678</i></p>'))).toEqual([])
    expect(kinds(plainText('<p>담당</p><p>010-1234-5678</p>'))).toEqual(['mobile'])
    expect(plainText('a&nbsp;&lt;b&gt;&amp;<br>c')).toBe('a <b>&\nc')
    const msg = piiMessage(detectPii('010-1234-5678 / 010-2222-3333 / 010-4444-5555 / 010-6666-7777'), '받는 사람 모두가 보게 되며,')
    expect(msg).toContain('· 휴대폰 번호 4건: 010-****-****, 010-****-****, 010-****-**** …')
    expect(msg).toContain('그래도 보낼까요?')
  })

  it('checks the parts of one write together, the same way on the PC and on the server', () => {
    // title, rich-text body, empty poll fields: each read as plain text, joined by lines
    const found = detectPiiIn(['회의', '<p>담당</p><p>010-1234-5678</p>', null, undefined, '900101-1234567'])
    expect(found.map((f) => [f.kind, f.count])).toEqual([
      ['rrn', 1],
      ['mobile', 1]
    ])
    expect(detectPiiIn([])).toEqual([])
  })

  it('logs only kinds and counts, and knows the refusal the server sends', () => {
    const found = detectPii('010-1234-5678, 010-2222-3333, hong@example.go.kr')
    expect(piiCounts(found)).toEqual({ mobile: 2, email: 1 })
    expect(JSON.stringify(piiCounts(found))).not.toMatch(/010|hong/)
    expect(isPiiRefusal({ found })).toBe(true)
    expect(isPiiRefusal(JSON.parse(JSON.stringify({ found })))).toBe(true)
    for (const bad of [undefined, null, {}, { found: 'x' }, { found: [{ kind: 'nope', count: 1, samples: [] }] }, { found: [{ kind: 'toString', count: 1, samples: [] }] }, { found: [{ kind: 'rrn', count: 1.5, samples: [] }] }, { found: [{ kind: 'rrn', count: 1 }] }])
      expect(isPiiRefusal(bad), JSON.stringify(bad)).toBe(false)
  })
})

describe('Copilot helper: the question that is copied', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const ctx: Record<string, any> = {}
  runInNewContext(readFileSync(join(import.meta.dirname, '../../plugins/copilot/prompts.js'), 'utf8'), ctx)
  const P = ctx.CopilotPrompts

  it('puts the instruction first and the material between marks', () => {
    const r = P.build({ task: 'summary', text: '  회의 내용…  ', tone: 'plain', length: 'short', format: 'bullets' })
    expect(r.prompt).toBe(
      ['아래 글을 핵심만 요약해 주세요. 중요한 날짜·숫자·담당자·해야 할 일은 빠뜨리지 마세요.', '', '- 말투: 간결한 개조식(~함, ~임)', '- 분량: 짧게(3~5줄)', '- 형식: 글머리표 목록으로', '- 한국어로 답해 주세요.', '', '--- 아래부터 내용 ---', '회의 내용…', '--- 내용 끝 ---'].join('\n')
    )
    expect(P.build({ task: 'summary', text: ' ' }).error).toBe('요약할 글을(를) 적어 주세요.')
  })

  it('fills the extra field, keeps a free question as it is, and takes tasks the user made', () => {
    expect(P.build({ task: 'translate', text: '안녕하세요', extra: '', tone: 'formal', length: 'medium', format: 'any' }).prompt).toContain('아래 글을 영어로 번역해 주세요.')
    expect(P.build({ task: 'translate', text: '안녕하세요', extra: '일본어' }).prompt).toContain('일본어로 번역')
    expect(P.build({ task: 'free', text: '엑셀에서 중복을 지우는 방법은?', tone: 'friendly', length: 'medium', format: 'steps' }).prompt).toBe('엑셀에서 중복을 지우는 방법은?\n\n- 말투: 친근하고 부드러운 말투\n- 형식: 번호를 붙인 단계로\n- 한국어로 답해 주세요.')
    const mine = P.customTask(' 민원 답변 ', '아래 민원에 답해 주세요.')
    expect(mine).toMatchObject({ name: '민원 답변', custom: true })
    expect(P.customTask('', 'x')).toBeNull()
    expect(P.build({ task: mine.id, custom: [mine], text: '가로등 고장' }).prompt).toContain('아래 민원에 답해 주세요.')
    expect(P.build({ task: 'nope', text: '질문' }).prompt.startsWith('질문')).toBe(true)
    expect(P.titleOf('\n 첫 줄\n둘째')).toBe('첫 줄')
  })
})
