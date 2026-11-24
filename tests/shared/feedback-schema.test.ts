import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as ts from '../../src/shared/schemas/feedback'
import type { FeedbackBundle, FeedbackItem } from '../../src/shared/schemas/feedback'

/**
 * The format of a feedback item / bundle exists three times: Zod (the app and the server PC),
 * plain JS (the workflow on GitHub) and a JSON Schema file (people and tools). They must give
 * the same verdict on everything, also on the nasty inputs.
 */
const root = resolve(__dirname, '..', '..')
type Verdict = { ok: true; value: FeedbackBundle; skipped: number } | { ok: false; code: string }
interface Twin {
  FEEDBACK_LIMITS: typeof ts.FEEDBACK_LIMITS
  FEEDBACK_WINDOW: typeof ts.FEEDBACK_WINDOW
  FEEDBACK_PATTERNS: Record<string, string>
  FEEDBACK_INTAKE_LABEL: string
  FEEDBACK_KIND_LABELS: Record<string, string>
  FEEDBACK_SCHEMA_VERSION: number
  checkItem: (v: unknown) => { ok: boolean; value?: FeedbackItem; code?: string }
  checkBundle: (v: unknown) => Verdict
  parseBundleText: (t: string) => Verdict
  canonicalItem: (i: FeedbackItem) => string
  canonicalBundle: (b: FeedbackBundle) => string
  inFeedbackWindow: (iso: string, now: number) => boolean
  receiptOf: (id: string) => string
  intakeTitle: (id: string) => string
  intakeBody: (t: string) => string
  extractIntake: (body: unknown) => string | null
}
const twin = async (): Promise<Twin> => (await import(/* @vite-ignore */ pathToFileURL(join(root, 'scripts', 'lib', 'feedback-schema.mjs')).href)) as Twin
const jsonSchema = JSON.parse(readFileSync(join(root, 'docs', 'feedback-submission.schema.json'), 'utf8')) as Schema

// ---- a JSON Schema checker for the part of draft 2020-12 the file uses ----
interface Schema {
  type?: string
  const?: unknown
  enum?: unknown[]
  required?: string[]
  additionalProperties?: boolean
  properties?: Record<string, Schema>
  minLength?: number
  maxLength?: number
  pattern?: string
  allOf?: Schema[]
  items?: Schema
  minItems?: number
  maxItems?: number
  $ref?: string
  $defs?: Record<string, Schema>
}
const KNOWN = new Set(['$schema', '$id', 'title', 'description', 'type', 'const', 'enum', 'required', 'additionalProperties', 'properties', 'minLength', 'maxLength', 'pattern', 'allOf', 'items', 'minItems', 'maxItems', '$ref', '$defs'])
function valid(s: Schema, v: unknown): boolean {
  for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`the checker of this test does not know "${k}"`)
  if (s.$ref) return valid(jsonSchema.$defs![s.$ref.replace('#/$defs/', '')], v)
  if ('const' in s && v !== s.const) return false
  if (s.enum && !s.enum.includes(v)) return false
  if (s.type === 'string') {
    if (typeof v !== 'string') return false
    const n = [...v].length
    if (s.minLength !== undefined && n < s.minLength) return false
    if (s.maxLength !== undefined && n > s.maxLength) return false
  }
  // a keyword for strings says nothing about other values
  if (s.pattern && typeof v === 'string' && !new RegExp(s.pattern, 'u').test(v)) return false
  if (s.type === 'array') {
    if (!Array.isArray(v)) return false
    if (s.minItems !== undefined && v.length < s.minItems) return false
    if (s.maxItems !== undefined && v.length > s.maxItems) return false
    if (s.items && !v.every((x) => valid(s.items!, x))) return false
  }
  if (s.type === 'object') {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
    const o = v as Record<string, unknown>
    for (const k of s.required ?? []) if (!Object.hasOwn(o, k)) return false
    for (const k of Object.keys(o)) {
      const p = s.properties && Object.hasOwn(s.properties, k) ? s.properties[k] : undefined
      if (!p) {
        if (s.additionalProperties === false) return false
      } else if (!valid(p, o[k])) return false
    }
  }
  return (s.allOf ?? []).every((a) => valid(a, v))
}

// ---- samples ----
const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'bug',
  title: '자료실에서 큰 파일이 멈춥니다',
  body: '5GB 파일을 올리면 멈춥니다.\n\t다시 열면 됩니다.',
  author: '',
  installId: 'ABCD-EFGH-JKLM',
  submissionId: '3f2b8c1e-9a4d-4e6f-8b1a-0c2d3e4f5a6b',
  createdAt: '2026-11-20T01:02:03.004Z',
  ...over
})
const bundle = (items: unknown[] = [item()], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1,
  type: 'bundle',
  bundleId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  serverId: 'WXYZ-2345-6789',
  period: { from: '2026-11-17T00:00:00.000Z', to: '2026-11-24T00:00:00.000Z' },
  createdAt: '2026-11-24T00:00:01.000Z',
  app: { version: '1.7.2' },
  items,
  ...over
})
const without = (o: Record<string, unknown>, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key))
const text = (v: unknown): string => JSON.stringify(v)
const deep = (n: number): string => '['.repeat(n) + ']'.repeat(n)

/** [name, JSON text, what is expected: 'ok' | 'skip' (the item is left out) | a refusal code, beyond the JSON Schema?] */
type Sample = [string, string, 'ok' | 'skip' | 'too_large' | 'bad_json' | 'not_compact' | 'bad_format', boolean?]
const face = '\u{1F600}'
const SAMPLES: Sample[] = [
  ['a plain bundle', text(bundle()), 'ok'],
  ['with versions and a writer', text(bundle([item({ author: '총무팀 김', app: { version: '1.7.2', os: 'Windows 10.0.26100' } })])), 'ok'],
  ['several items', text(bundle([item(), item({ submissionId: '11111111-2222-4333-8444-555555555555', kind: 'feature' })])), 'ok'],
  ['text that only looks dangerous is text', text(bundle([item({ title: '<script>alert(1)</script> @admin #1', body: '```\n</details> <img src=x onerror=alert(1)> @someone #12 GH-3 [x](javascript:alert(1)) https://example.com\n```\n<!-- x -->' })])), 'ok'],
  ['characters outside the BMP count once', text(bundle([item({ title: face.repeat(100), author: face.repeat(30) })])), 'ok'],
  ['a very long line', text(bundle([item({ body: 'x'.repeat(5000) })])), 'ok'],
  ['a pre-release version', text(bundle([item()], { app: { version: '1.8.0-beta.1' } })), 'ok'],
  // one item is wrong: it is left out, the bundle stays
  ['item: title is a number', text(bundle([item({ title: 12345 })])), 'skip'],
  ['item: unknown key', text(bundle([item({ ip: '192.168.0.10' })])), 'skip'],
  ['item: __proto__ key', text(bundle([item()])).replace('"kind":"bug"', '"__proto__":{"polluted":true},"kind":"bug"'), 'skip'],
  ['item: constructor key', text(bundle([item({ constructor: { prototype: {} } })])), 'skip'],
  ['item: missing author', text(bundle([without(item(), 'author')])), 'skip'],
  ['item: title too long', text(bundle([item({ title: 'x'.repeat(101) })])), 'skip'],
  ['item: title too short', text(bundle([item({ title: 'x' })])), 'skip'],
  ['item: body too long', text(bundle([item({ body: 'x'.repeat(5001) })])), 'skip'],
  ['item: body too short', text(bundle([item({ body: 'abcd' })])), 'skip'],
  ['item: author too long', text(bundle([item({ author: 'x'.repeat(31) })])), 'skip'],
  ['item: too many characters outside the BMP', text(bundle([item({ title: face.repeat(101) })])), 'skip'],
  ['item: control character', text(bundle([item({ body: 'bell \u0007 rings' })])), 'skip'],
  ['item: carriage return', text(bundle([item({ body: 'line one\r\nline two' })])), 'skip'],
  ['item: line feed in the title', text(bundle([item({ title: 'two\nlines' })])), 'skip'],
  ['item: tab in the title', text(bundle([item({ title: 'a\tb' })])), 'skip'],
  ['item: DEL', text(bundle([item({ body: 'abc\u007fdef' })])), 'skip'],
  ['item: C1 control', text(bundle([item({ body: 'abc\u0085def' })])), 'skip'],
  ['item: bidi override', text(bundle([item({ title: 'safe\u202Eexe.txt' })])), 'skip'],
  ['item: bidi isolate', text(bundle([item({ body: 'abc \u2066 def' })])), 'skip'],
  ['item: zero width space', text(bundle([item({ body: 'ab\u200Bcd ef' })])), 'skip'],
  ['item: line separator', text(bundle([item({ body: 'abc\u2028def' })])), 'skip'],
  ['item: byte order mark', text(bundle([item({ body: '\uFEFFabcdef' })])), 'skip'],
  ['item: tag character', text(bundle([item({ body: `abcde${String.fromCodePoint(0xe0041)}` })])), 'skip'],
  ['item: lone surrogate', text(bundle([item()])).replace('"title":"', '"title":"\\ud800'), 'skip'],
  ['item: leading space', text(bundle([item({ title: ' title' })])), 'skip'],
  ['item: trailing line feed', text(bundle([item({ body: 'the body\n' })])), 'skip'],
  ['item: not NFC', text(bundle([item({ title: '한글' })])), 'skip', true],
  ['item: unknown kind', text(bundle([item({ kind: 'spam' })])), 'skip'],
  ['item: installId of another form', text(bundle([item({ installId: 'abcd-efgh-jklm' })])), 'skip'],
  ['item: installId with a letter that is never used', text(bundle([item({ installId: 'ABCD-EFGH-JKL0' })])), 'skip'],
  ['item: submissionId in capitals', text(bundle([item({ submissionId: '3F2B8C1E-9A4D-4E6F-8B1A-0C2D3E4F5A6B' })])), 'skip'],
  ['item: submissionId is not a v4 UUID', text(bundle([item({ submissionId: '3f2b8c1e-9a4d-1e6f-8b1a-0c2d3e4f5a6b' })])), 'skip'],
  ['item: time without milliseconds', text(bundle([item({ createdAt: '2026-11-20T01:02:03Z' })])), 'skip'],
  ['item: time with an offset', text(bundle([item({ createdAt: '2026-11-20T01:02:03.004+09:00' })])), 'skip'],
  ['item: a day that does not exist', text(bundle([item({ createdAt: '2026-02-30T01:02:03.004Z' })])), 'skip', true],
  ['item: time is a number', text(bundle([item({ createdAt: 1763600000000 })])), 'skip'],
  ['item: app with an unknown key', text(bundle([item({ app: { version: '1.7.2', os: 'Windows 10', pcName: 'PC-1' } })])), 'skip'],
  ['item: app without os', text(bundle([item({ app: { version: '1.7.2' } })])), 'skip'],
  ['item: version of another form', text(bundle([item({ app: { version: '1.7', os: 'Windows 10' } })])), 'skip'],
  ['item: os with other characters', text(bundle([item({ app: { version: '1.7.2', os: 'Windows <b>' } })])), 'skip'],
  ['item: app is null', text(bundle([item({ app: null })])), 'skip'],
  ['item: deep nesting instead of text', text(bundle([item({ body: JSON.parse(deep(200)) })])), 'skip'],
  ['item: an array', text(bundle([[1, 2, 3]])), 'skip'],
  ['item: null', text(bundle([null])), 'skip'],
  ['item: a string', text(bundle(['kind=bug'])), 'skip'],
  // the envelope is wrong: all of it is refused
  ['bundle: another schema number', text(bundle([item()], { schema: 2 })), 'bad_format'],
  ['bundle: schema as text', text(bundle([item()], { schema: '1' })), 'bad_format'],
  ['bundle: another type', text(bundle([item()], { type: 'item' })), 'bad_format'],
  ['bundle: unknown key', text(bundle([item()], { orgName: '테스트기관' })), 'bad_format'],
  ['bundle: __proto__ key', text(bundle()).replace('{"schema":1', '{"__proto__":{"a":1},"schema":1'), 'bad_format'],
  ['bundle: missing serverId', text(without(bundle(), 'serverId')), 'bad_format'],
  ['bundle: serverId of another form', text(bundle([item()], { serverId: '192.168.0.1' })), 'bad_format'],
  ['bundle: bundleId of another form', text(bundle([item()], { bundleId: 'bundle-1' })), 'bad_format'],
  ['bundle: no items', text(bundle([])), 'bad_format'],
  ['bundle: too many items', text(bundle(Array.from({ length: 201 }, () => 0))), 'bad_format'],
  ['bundle: items is an object', text(bundle([item()], { items: { 0: item() } })), 'bad_format'],
  ['bundle: period with an unknown key', text(bundle([item()], { period: { from: '2026-11-17T00:00:00.000Z', to: '2026-11-24T00:00:00.000Z', tz: 'KST' } })), 'bad_format'],
  ['bundle: period ends before it starts', text(bundle([item()], { period: { from: '2026-11-24T00:00:00.000Z', to: '2026-11-17T00:00:00.000Z' } })), 'bad_format', true],
  ['bundle: createdAt of another form', text(bundle([item()], { createdAt: '2026-11-24' })), 'bad_format'],
  ['bundle: app with an unknown key', text(bundle([item()], { app: { version: '1.7.2', os: 'Windows 10' } })), 'bad_format'],
  ['bundle: version of another form', text(bundle([item()], { app: { version: 'latest' } })), 'bad_format'],
  ['not a bundle: an array', text([bundle()]), 'bad_format'],
  ['not a bundle: null', 'null', 'bad_format'],
  ['not a bundle: a number', '1', 'bad_format'],
  ['not a bundle: text', '"bundle"', 'bad_format'],
  ['not a bundle: deep nesting', deep(2000), 'bad_format'],
  // the text is wrong
  ['text: not JSON', '{schema:1}', 'bad_json'],
  ['text: empty', '', 'bad_json'],
  ['text: cut off', text(bundle()).slice(0, -5), 'bad_json'],
  ['text: JavaScript instead of JSON', '(function(){return 1})()', 'bad_json'],
  ['text: a key twice', text(bundle()).replace('"type":"bundle"', '"type":"other","type":"bundle"'), 'not_compact'],
  ['text: a key of an item twice', text(bundle()).replace('"kind":"bug"', '"kind":"feature","kind":"bug"'), 'not_compact'],
  ['text: white space', JSON.stringify(bundle(), null, 2), 'not_compact'],
  ['text: a line feed at the end', `${text(bundle())}\n`, 'not_compact'],
  ['text: a number written another way', text(bundle()).replace('"schema":1', '"schema":1.0'), 'not_compact'],
  ['text: an escape that is not needed', text(bundle()).replace('"type":"bundle"', '"type":"\\u0062undle"'), 'not_compact'],
  ['text: too large', text(bundle(Array.from({ length: 4 }, (_, n) => item({ body: '가'.repeat(5000), submissionId: `0000000${n}-2222-4333-8444-555555555555` })))), 'too_large']
]

describe('feedback format: one set of rules in three places', () => {
  it('the constants and the patterns are the same in all three', async () => {
    const js = await twin()
    expect(js.FEEDBACK_LIMITS).toEqual(ts.FEEDBACK_LIMITS)
    expect(js.FEEDBACK_WINDOW).toEqual(ts.FEEDBACK_WINDOW)
    expect(js.FEEDBACK_PATTERNS).toEqual(ts.FEEDBACK_PATTERNS)
    expect(js.FEEDBACK_SCHEMA_VERSION).toBe(ts.FEEDBACK_SCHEMA_VERSION)
    expect(js.FEEDBACK_INTAKE_LABEL).toBe(ts.FEEDBACK_INTAKE_LABEL)
    expect(js.FEEDBACK_KIND_LABELS).toEqual(ts.FEEDBACK_KIND_LABELS)

    const P = ts.FEEDBACK_PATTERNS
    const L = ts.FEEDBACK_LIMITS
    const it = jsonSchema.$defs!.item
    expect(jsonSchema.additionalProperties).toBe(false)
    expect(it.additionalProperties).toBe(false)
    expect(Object.keys(jsonSchema.properties!)).toEqual(Object.keys(ts.feedbackBundleSchema.shape))
    expect(Object.keys(it.properties!)).toEqual(Object.keys(ts.feedbackItemSchema.shape))
    expect([...jsonSchema.required!].sort()).toEqual(Object.keys(ts.feedbackBundleSchema.shape).sort())
    expect([...it.required!].sort()).toEqual(Object.keys(ts.feedbackItemSchema.shape).filter((k) => k !== 'app').sort())
    expect(jsonSchema.properties!.schema.const).toBe(ts.FEEDBACK_SCHEMA_VERSION)
    expect(jsonSchema.properties!.items).toMatchObject({ minItems: 1, maxItems: L.bundleMaxItems })
    expect(jsonSchema.properties!.bundleId.pattern).toBe(P.uuid)
    expect(jsonSchema.properties!.serverId.pattern).toBe(P.pcUid)
    expect(jsonSchema.properties!.createdAt.pattern).toBe(P.time)
    expect(jsonSchema.properties!.period.properties!.from.pattern).toBe(P.time)
    expect(jsonSchema.properties!.app.properties!.version.pattern).toBe(P.version)
    expect(it.properties!.title).toMatchObject({ minLength: L.titleMin, maxLength: L.titleMax, allOf: [{ pattern: P.line }, { pattern: P.trimmed }] })
    expect(it.properties!.body).toMatchObject({ minLength: L.bodyMin, maxLength: L.bodyMax, allOf: [{ pattern: P.multi }, { pattern: P.trimmed }] })
    expect(it.properties!.author).toMatchObject({ minLength: 0, maxLength: L.authorMax, allOf: [{ pattern: P.line }, { pattern: P.trimmed }] })
    expect(it.properties!.installId.pattern).toBe(P.pcUid)
    expect(it.properties!.submissionId.pattern).toBe(P.uuid)
    expect(it.properties!.createdAt.pattern).toBe(P.time)
    expect(it.properties!.app.properties!.version.pattern).toBe(P.version)
    expect(it.properties!.app.properties!.os.pattern).toBe(P.os)
  })

  it.each(SAMPLES)('%s', async (_name, sample, expected, beyond) => {
    const js = await twin()
    const a = ts.parseBundleText(sample)
    const b = js.parseBundleText(sample)
    // the app and the workflow: the very same verdict, and the same canonical text for what is taken
    expect(b).toEqual(a)
    if (a.ok && b.ok) expect(js.canonicalBundle(b.value)).toBe(ts.canonicalBundle(a.value))
    if (expected === 'ok') expect(a).toMatchObject({ ok: true, skipped: 0 })
    else if (expected === 'skip') expect(a).toMatchObject({ ok: true, skipped: 1 })
    else expect(a).toEqual({ ok: false, code: expected })

    // the JSON Schema file (it knows the shape of the value, not the form of the text)
    if (expected === 'ok' || expected === 'skip' || expected === 'bad_format') {
      const value: unknown = JSON.parse(sample)
      expect(valid(jsonSchema, value)).toBe(beyond ? true : expected === 'ok')
      // items one by one: the two checkers and the JSON Schema again
      const items = (value as { items?: unknown } | null)?.items
      if (Array.isArray(items))
        for (const i of items) {
          const x = ts.checkItem(i)
          expect(js.checkItem(i)).toEqual(x)
          if (!beyond) expect(valid(jsonSchema.$defs!.item, i)).toBe(x.ok)
        }
    }
  })

  it('nothing but the known keys comes out, in a fixed order, and nothing is polluted', async () => {
    const js = await twin()
    const shuffled = { items: [{ createdAt: '2026-11-20T01:02:03.004Z', author: '', body: '내용입니다.', title: '제목', kind: 'bug', submissionId: '3f2b8c1e-9a4d-4e6f-8b1a-0c2d3e4f5a6b', installId: 'ABCD-EFGH-JKLM' }], app: { version: '1.7.2' }, createdAt: '2026-11-24T00:00:01.000Z', period: { to: '2026-11-24T00:00:00.000Z', from: '2026-11-17T00:00:00.000Z' }, serverId: 'WXYZ-2345-6789', bundleId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', type: 'bundle', schema: 1 }
    const a = ts.checkBundle(shuffled)
    const b = js.checkBundle(shuffled)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    const want = '{"schema":1,"type":"bundle","bundleId":"7c9e6679-7425-40de-944b-e07fc1f90ae7","serverId":"WXYZ-2345-6789","period":{"from":"2026-11-17T00:00:00.000Z","to":"2026-11-24T00:00:00.000Z"},"createdAt":"2026-11-24T00:00:01.000Z","app":{"version":"1.7.2"},"items":[{"kind":"bug","title":"제목","body":"내용입니다.","author":"","installId":"ABCD-EFGH-JKLM","submissionId":"3f2b8c1e-9a4d-4e6f-8b1a-0c2d3e4f5a6b","createdAt":"2026-11-20T01:02:03.004Z"}]}'
    expect(ts.canonicalBundle(a.value)).toBe(want)
    expect(js.canonicalBundle(b.value)).toBe(want)
    expect(ts.parseBundleText(want)).toMatchObject({ ok: true, skipped: 0 })
    // a parsed "__proto__" key is an own key of that one object: refused, and no prototype was touched
    js.parseBundleText('{"__proto__":{"polluted":true},"schema":1}')
    ts.parseBundleText('{"__proto__":{"polluted":true},"schema":1}')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    // an object that is not a plain one is no item
    class Fake {
      kind = 'bug'
    }
    expect(js.checkItem(new Fake()).ok).toBe(false)
    expect(js.checkItem(Object.assign(Object.create({ kind: 'bug' }), without(item(), 'kind'))).ok).toBe(false)
  })

  it('the time window, the receipt number and the intake form', async () => {
    const js = await twin()
    const now = Date.parse('2026-11-24T00:00:00.000Z')
    for (const f of [ts.inFeedbackWindow, js.inFeedbackWindow]) {
      expect(f('2026-11-24T00:00:00.000Z', now)).toBe(true)
      expect(f('2026-11-24T23:59:59.000Z', now)).toBe(true) // a PC clock that runs ahead by less than a day
      expect(f('2026-11-25T00:00:01.000Z', now)).toBe(false)
      expect(f('2026-06-01T00:00:00.000Z', now)).toBe(true)
      expect(f('2026-05-01T00:00:00.000Z', now)).toBe(false) // older than 180 days
      expect(f('never', now)).toBe(false)
    }
    const id = '3f2b8c1e-9a4d-4e6f-8b1a-0c2d3e4f5a6b'
    expect(ts.receiptOf(id)).toBe('TH-3F2B8C1E')
    expect(js.receiptOf(id)).toBe('TH-3F2B8C1E')
    expect(js.intakeTitle(id)).toBe(ts.intakeTitle(id))
    const canonical = text(bundle())
    expect(js.intakeBody(canonical)).toBe(ts.intakeBody(canonical))
    // exactly one fenced json block and nothing else
    expect(js.extractIntake(ts.intakeBody(canonical))).toBe(canonical)
    expect(js.extractIntake(ts.intakeBody(canonical).replace(/\n/g, '\r\n'))).toBe(canonical)
    expect(js.extractIntake(`hello\n${ts.intakeBody(canonical)}`)).toBeNull()
    expect(js.extractIntake(`${ts.intakeBody(canonical)}\n\`\`\`json\n{}\n\`\`\`\n`)).toBeNull() // a second block
    expect(js.extractIntake('```json\n{"a":1}\n```\n@admin please look')).toBeNull()
    expect(js.extractIntake('```json\n{"a":\n1}\n```\n')).toBeNull() // more than one line
    expect(js.extractIntake('```js\n{}\n```\n')).toBeNull()
    expect(js.extractIntake(null)).toBeNull()
    expect(js.extractIntake(`\`\`\`json\n${'x'.repeat(70000)}\n\`\`\`\n`)).toBeNull()
  })

  it('text typed by a person is tidied before an item is made; bundles are split by the caps', () => {
    expect(ts.tidyLine('  자료실에서\t큰 파일이\n멈춥니다\u202E  ', 100)).toBe('자료실에서 큰 파일이 멈춥니다')
    expect(ts.tidyLine('한', 100)).toBe('한')
    expect(ts.tidyText('one\r\ntwo\rthree\u0007\u200B\n\n', 100)).toBe('one\ntwo\nthree')
    expect([...ts.tidyLine(face.repeat(150), 100)]).toHaveLength(100)
    const made = ts.checkItem(item({ title: ts.tidyLine(' <b>제목</b> \u2066 ', 100), body: ts.tidyText('내용\r\n입니다\u0000.', 5000) }))
    expect(made.ok).toBe(true)

    expect(ts.packItems([1, 2, 3], () => 10)).toEqual([[1, 2, 3]])
    expect(ts.packItems(Array.from({ length: 450 }, (_, n) => n), () => 10).map((g) => g.length)).toEqual([200, 200, 50])
    expect(ts.packItems([1, 2, 3, 4], () => 25000).map((g) => g.length)).toEqual([2, 2])
    expect(ts.packItems([], () => 1)).toEqual([])
  })
})
