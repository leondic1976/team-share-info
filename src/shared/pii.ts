/**
 * Personal information that should not be sent to other people by accident.
 * Looked for in what is about to be sent (messages, notes, posts, comments, notices); the
 * writer is asked to confirm. It is a reminder, not a filter: patterns miss things and
 * sometimes match numbers that are not personal.
 */

export type PiiKind = 'rrn' | 'foreigner' | 'passport' | 'license' | 'card' | 'account' | 'mobile' | 'email'

export const PII_LABEL: Record<PiiKind, string> = {
  rrn: '주민등록번호',
  foreigner: '외국인등록번호',
  passport: '여권번호',
  license: '운전면허번호',
  card: '카드번호',
  account: '계좌번호',
  mobile: '휴대폰 번호',
  email: '이메일 주소'
}

export interface PiiFinding {
  kind: PiiKind
  /** how many were found */
  count: number
  /** the first few, partly hidden, to show where they are */
  samples: string[]
}

/** Rich text (posts, notices) is checked as the reader sees it. */
export function plainText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

const digits = (s: string): string => s.replace(/\D/g, '')

/** YYMMDD of a resident number must be a date. */
function birth(d: string): boolean {
  const m = Number(d.slice(2, 4))
  const day = Number(d.slice(4, 6))
  return m >= 1 && m <= 12 && day >= 1 && day <= 31
}

function luhn(d: string): boolean {
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i])
    if (i % 2 === 1) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
  }
  return sum % 10 === 0
}

/** Keep the start, hide the rest: enough to find it, not enough to read it. */
function mask(s: string, keep: number): string {
  let seen = 0
  return s.replace(/[0-9A-Za-z]/g, (c) => (seen++ < keep ? c : '*'))
}

interface Rule {
  kind: PiiKind
  re: RegExp
  ok?: (match: string) => boolean
  keep: number
}

const RULES: Rule[] = [
  // 900101-1234567 (7th digit 1-4: citizens, 5-8: foreigners; 9, 0: born before 1900)
  { kind: 'rrn', re: /(?<!\d)\d{6}[-\s]?[1-4]\d{6}(?!\d)/g, ok: (m) => birth(digits(m)), keep: 7 },
  { kind: 'foreigner', re: /(?<!\d)\d{6}[-\s]?[5-8]\d{6}(?!\d)/g, ok: (m) => birth(digits(m)), keep: 7 },
  // M12345678, or the format used since 2021: M123A4567
  { kind: 'passport', re: /(?<![A-Za-z0-9])(?:[MSRODG]\d{8}|[MSRODG]\d{3}[A-Z]\d{4})(?![A-Za-z0-9])/g, keep: 3 },
  // 11-23-123456-78
  { kind: 'license', re: /(?<!\d)\d{2}-\d{2}-\d{6}-\d{2}(?!\d)/g, keep: 4 },
  { kind: 'card', re: /(?<!\d)\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}(?!\d)|(?<![\d-])\d{16}(?![\d-])/g, ok: (m) => luhn(digits(m)), keep: 4 },
  // a number after the name of a bank or the word 계좌
  {
    kind: 'account',
    re: /(?:은행|계좌|농협|수협|신협|우체국|새마을금고|카카오뱅크|케이뱅크|토스뱅크|입금)[^\d\n]{0,12}\d{2,6}(?:-\d{2,7}){1,4}(?!\d)|(?:은행|계좌)[^\d\n]{0,12}\d{10,14}(?!\d)/g,
    ok: (m) => {
      const n = digits(m).length
      return n >= 10 && n <= 16
    },
    keep: 0
  },
  { kind: 'mobile', re: /(?<!\d)01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g, keep: 3 },
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, keep: 2 }
]

/** What looks like personal information in the text. Empty: nothing found. */
export function detectPii(text: string): PiiFinding[] {
  const src = String(text ?? '')
  const found: PiiFinding[] = []
  // a span claimed by an earlier (more specific) rule is not reported again, e.g. a card number as an account
  const taken: [number, number][] = []
  for (const rule of RULES) {
    const samples: string[] = []
    let count = 0
    for (const m of src.matchAll(rule.re)) {
      const start = m.index
      const end = start + m[0].length
      if (taken.some(([a, b]) => start < b && end > a)) continue
      if (rule.ok && !rule.ok(m[0])) continue
      taken.push([start, end])
      count++
      if (samples.length < 3) {
        // the account rule matches its keyword too: show only the number
        const shown = rule.kind === 'account' ? (/\d[\d-]*$/.exec(m[0])?.[0] ?? m[0]) : m[0]
        samples.push(mask(shown.trim(), rule.kind === 'account' ? 3 : rule.keep))
      }
    }
    if (count) found.push({ kind: rule.kind, count, samples })
  }
  return found
}

/** The question put to the writer before sending. */
export function piiMessage(found: PiiFinding[], audience: string): string {
  const lines = found.map((f) => `· ${PII_LABEL[f.kind]} ${f.count}건: ${f.samples.join(', ')}${f.count > f.samples.length ? ' …' : ''}`)
  return `개인정보로 보이는 내용이 있습니다.\n\n${lines.join('\n')}\n\n${audience} 보내면 되돌리기 어렵습니다. 꼭 필요한 내용인지 확인하세요.\n그래도 보낼까요?`
}
