import { z } from 'zod'
import { PC_UID_RE } from '../constants'

/**
 * "기능요청 및 오류신고" travels in two hops, both with a JSON document of a fixed shape:
 *   1. a PC hands an ITEM to the server PC of its team (POST /api/feedback), which keeps it
 *   2. once a week the server PC puts the items into a BUNDLE and hands that to the developer's
 *      GitHub repository (an issue with the intake label); a workflow there checks it and
 *      decides what becomes a post on the public board (scripts/feedback-intake.mjs)
 *
 * The same rules exist three times and are kept identical by tests/shared/feedback-schema.test.ts:
 *   - this file (Zod; the app and the server PC)
 *   - scripts/lib/feedback-schema.mjs (plain JS; the workflow and the board builder)
 *   - docs/feedback-submission.schema.json (JSON Schema, for people and tools)
 * A change here is a change in all three (and a new `schema` number when the shape changes).
 */
export const FEEDBACK_SCHEMA_VERSION = 1

/** Lengths are counted in characters (Unicode code points); *Bytes: the document as UTF-8. */
export const FEEDBACK_LIMITS = {
  titleMin: 2,
  titleMax: 100,
  bodyMin: 5,
  bodyMax: 5000,
  authorMax: 30,
  /** an item that keeps the lengths above always fits */
  itemMaxBytes: 24576,
  bundleMaxItems: 200,
  /** a GitHub issue body holds 65,536 characters */
  bundleMaxBytes: 60000
}

/** `createdAt` of a bundle and of its items must lie in this window around the clock of GitHub's runner. */
export const FEEDBACK_WINDOW = { pastMs: 180 * 86_400_000, futureMs: 86_400_000 }

export const FEEDBACK_INTAKE_LABEL = '접수'
export const FEEDBACK_KIND_LABELS = { feature: '기능요청', bug: '오류신고' } as const

/**
 * Characters that are never accepted in text: control characters, characters that change the
 * reading direction (bidi), invisible format characters, line/paragraph separators, tag
 * characters, noncharacters and lone surrogates. Written for a character class of a regular
 * expression with the `u` flag.
 */
const NEVER = '\\u007F-\\u009F\\u061C\\u200B\\u200E\\u200F\\u2028-\\u202E\\u2060-\\u2069\\uFEFF\\uFFF9-\\uFFFB\\uFFFE\\uFFFF\\u{E0000}-\\u{E007F}\\p{Cs}'

/** Sources of the patterns (flag `u`); the JSON Schema file holds the very same strings. */
export const FEEDBACK_PATTERNS = {
  /** one line: no control character at all */
  line: `^[^\\u0000-\\u001F${NEVER}]*$`,
  /** several lines: tab and line feed are the only control characters */
  multi: `^[^\\u0000-\\u0008\\u000B-\\u001F${NEVER}]*$`,
  /** no white space at the start or the end */
  trimmed: '^(\\S([\\s\\S]*\\S)?)?$',
  /** the unique value of a PC (installId of a member PC, serverId of a server PC) */
  pcUid: PC_UID_RE.source,
  uuid: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  time: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$',
  version: '^(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})(-[0-9A-Za-z.-]{1,20})?$',
  os: '^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,59}$'
} as const

const re = (k: keyof typeof FEEDBACK_PATTERNS): RegExp => new RegExp(FEEDBACK_PATTERNS[k], 'u')
const RE = { line: re('line'), multi: re('multi'), trimmed: re('trimmed'), pcUid: re('pcUid'), uuid: re('uuid'), time: re('time'), version: re('version'), os: re('os') }

const chars = (s: string): number => {
  let n = 0
  for (const _ of s) n++
  return n
}
const bytes = (s: string): number => new TextEncoder().encode(s).length

const text = (min: number, max: number, allowed: RegExp): z.ZodType<string> =>
  z
    .string()
    // a cheap bound first (a character is at most two UTF-16 units)
    .max(max * 2)
    .regex(allowed)
    .regex(RE.trimmed)
    .refine((s) => {
      const n = chars(s)
      return n >= min && n <= max
    })
    .refine((s) => s === s.normalize('NFC'))

/** A real point in time, written exactly the way `Date.prototype.toISOString` writes it. */
const realTime = (s: string): boolean => {
  const t = Date.parse(s)
  return Number.isFinite(t) && new Date(t).toISOString() === s
}
const time = z.string().regex(RE.time).refine(realTime)

/** What one PC hands to its server PC. Nothing else leaves the PC. */
export const feedbackItemSchema = z.strictObject({
  kind: z.enum(['feature', 'bug']),
  title: text(FEEDBACK_LIMITS.titleMin, FEEDBACK_LIMITS.titleMax, RE.line),
  body: text(FEEDBACK_LIMITS.bodyMin, FEEDBACK_LIMITS.bodyMax, RE.multi),
  /** shown as the writer; '' = 익명 */
  author: text(0, FEEDBACK_LIMITS.authorMax, RE.line),
  /** the unique value of the PC (src/node/feedback.ts installIdFrom): a salted hash, never an address */
  installId: z.string().regex(RE.pcUid),
  /** UUID v4, new for every post: the same one is never taken twice */
  submissionId: z.string().regex(RE.uuid),
  /** ISO 8601, UTC, milliseconds */
  createdAt: time,
  /** only when the writer left "버전 정보 함께 보내기" on */
  app: z.strictObject({ version: z.string().regex(RE.version), os: z.string().regex(RE.os) }).optional()
})
export type FeedbackItem = z.infer<typeof feedbackItemSchema>
export type FeedbackKind = FeedbackItem['kind']

const envelope = {
  schema: z.literal(FEEDBACK_SCHEMA_VERSION),
  type: z.literal('bundle'),
  bundleId: z.string().regex(RE.uuid),
  /** the unique value of the server PC: the key GitHub checks (block list, bundles per day) */
  serverId: z.string().regex(RE.pcUid),
  period: z.strictObject({ from: time, to: time }).refine((p) => p.from <= p.to),
  createdAt: time,
  app: z.strictObject({ version: z.string().regex(RE.version) })
}
/** What a server PC hands to GitHub: the items of one period. No names, no member ids, no addresses. */
export const feedbackBundleSchema = z.strictObject({ ...envelope, items: z.array(feedbackItemSchema).min(1).max(FEEDBACK_LIMITS.bundleMaxItems) })
export type FeedbackBundle = z.infer<typeof feedbackBundleSchema>
/** The bundle without a verdict on its items: one bad item does not lose the others. */
const looseBundle = z.strictObject({ ...envelope, items: z.array(z.unknown()).min(1).max(FEEDBACK_LIMITS.bundleMaxItems) })

/** A copy with nothing but the known keys, in the one order they are written in. */
function orderedItem(s: FeedbackItem): FeedbackItem {
  const o: FeedbackItem = { kind: s.kind, title: s.title, body: s.body, author: s.author, installId: s.installId, submissionId: s.submissionId, createdAt: s.createdAt }
  if (s.app) o.app = { version: s.app.version, os: s.app.os }
  return o
}
function orderedBundle(b: Omit<FeedbackBundle, 'items'>, items: FeedbackItem[]): FeedbackBundle {
  return { schema: b.schema, type: b.type, bundleId: b.bundleId, serverId: b.serverId, period: { from: b.period.from, to: b.period.to }, createdAt: b.createdAt, app: { version: b.app.version }, items: items.map(orderedItem) }
}

export type FeedbackItemCheck = { ok: true; value: FeedbackItem } | { ok: false; code: 'bad_item' }
/** Is this value an item? Anything that is not exactly the defined shape is refused. */
export function checkItem(value: unknown): FeedbackItemCheck {
  const r = feedbackItemSchema.safeParse(value)
  return r.success ? { ok: true, value: orderedItem(r.data) } : { ok: false, code: 'bad_item' }
}

export type FeedbackBundleCheck = { ok: true; value: FeedbackBundle; skipped: number } | { ok: false; code: 'too_large' | 'bad_json' | 'not_compact' | 'bad_format' }
/**
 * Is this value a bundle? A wrong envelope refuses the whole bundle; an item that is not
 * exactly the defined shape is left out and counted (`skipped`), the others stay.
 */
export function checkBundle(value: unknown): FeedbackBundleCheck {
  const r = looseBundle.safeParse(value)
  if (!r.success) return { ok: false, code: 'bad_format' }
  const items: FeedbackItem[] = []
  for (const raw of r.data.items) {
    const i = checkItem(raw)
    if (i.ok) items.push(i.value)
  }
  return { ok: true, value: orderedBundle(r.data, items), skipped: r.data.items.length - items.length }
}

/** The one way an item / a bundle is written as text: fixed key order, no white space. */
export function canonicalItem(s: FeedbackItem): string {
  return JSON.stringify(orderedItem(s))
}
export function canonicalBundle(b: FeedbackBundle): string {
  return JSON.stringify(orderedBundle(b, b.items))
}

/**
 * Text -> bundle. The size is checked before anything is parsed, and the text must be compact
 * JSON that reads back to itself: a second copy of a key or extra white space is refused.
 */
export function parseBundleText(text: string): FeedbackBundleCheck {
  if (typeof text !== 'string' || text.length > FEEDBACK_LIMITS.bundleMaxBytes || bytes(text) > FEEDBACK_LIMITS.bundleMaxBytes) return { ok: false, code: 'too_large' }
  let value: unknown
  try {
    value = JSON.parse(text)
    if (JSON.stringify(value) !== text) return { ok: false, code: 'not_compact' }
  } catch {
    return { ok: false, code: 'bad_json' }
  }
  return checkBundle(value)
}

/** A time of a document against a clock (the workflow uses the clock of GitHub's runner). */
export function inFeedbackWindow(iso: string, now: number): boolean {
  const t = Date.parse(iso)
  return Number.isFinite(t) && t >= now - FEEDBACK_WINDOW.pastMs && t <= now + FEEDBACK_WINDOW.futureMs
}

/** The short number people read out (접수번호): made from the id of the post. */
export function receiptOf(submissionId: string): string {
  return `TH-${submissionId.slice(0, 8).toUpperCase()}`
}

/** How a bundle is handed in: an issue with this title, this body and the intake label only. */
export function intakeTitle(bundleId: string): string {
  return `[${FEEDBACK_INTAKE_LABEL}] ${bundleId}`
}
export function intakeBody(canonical: string): string {
  return `\`\`\`json\n${canonical}\n\`\`\`\n`
}

/**
 * Items -> the fewest bundles that keep the caps (items per bundle, bytes per bundle).
 * `overhead`: bytes of the bundle around its items.
 */
export function packItems<T>(items: T[], size: (item: T) => number, overhead = 400): T[][] {
  const out: T[][] = []
  let cur: T[] = []
  let used = overhead
  for (const it of items) {
    const n = size(it) + 1
    if (cur.length && (cur.length >= FEEDBACK_LIMITS.bundleMaxItems || used + n > FEEDBACK_LIMITS.bundleMaxBytes)) {
      out.push(cur)
      cur = []
      used = overhead
    }
    cur.push(it)
    used += n
  }
  if (cur.length) out.push(cur)
  return out
}
export const feedbackBytes = bytes

const NEVER_RE = new RegExp(`[${NEVER}]`, 'gu')
const cut = (s: string, max: number): string => (chars(s) > max ? [...s].slice(0, max).join('') : s)

/** Text typed by a person -> text the schema accepts (done before an item is built). */
export function tidyLine(s: string, max: number): string {
  return cut(
    s
      .normalize('NFC')
      .replace(NEVER_RE, '')
      // eslint-disable-next-line no-control-regex -- control characters typed or pasted by users
      .replace(/[\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    max
  ).trim()
}
export function tidyText(s: string, max: number): string {
  return cut(
    s
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      .replace(NEVER_RE, '')
      // eslint-disable-next-line no-control-regex -- control characters typed or pasted by users
      .replace(/[\u0000-\u0008\u000b-\u001f]/g, '')
      .trim(),
    max
  ).trim()
}

/** What the member's window and the admin tab show of an item kept on the server PC. */
export type FeedbackItemState = 'received' | 'bundled' | 'uploaded'
export interface FeedbackItemDto {
  id: string
  receipt: string
  kind: FeedbackKind
  title: string
  body: string
  author: string
  createdAt: number
  receivedAt: number
  state: FeedbackItemState
  bundleId: string | null
  /** admin list only */
  memberName?: string
}
export type FeedbackBundleState = 'pending' | 'uploaded' | 'failed'
export interface FeedbackBundleDto {
  id: string
  periodFrom: number
  periodTo: number
  itemCount: number
  state: FeedbackBundleState
  tries: number
  lastError: string | null
  createdAt: number
  uploadedAt: number | null
  /** number of the intake issue on GitHub; null: handed over as a file */
  issueNumber: number | null
}
export interface FeedbackAdminDto {
  items: FeedbackItemDto[]
  bundles: FeedbackBundleDto[]
  /** the program of the server PC has the key for sending */
  canUpload: boolean
  /** when the next weekly bundle is made (null: nothing is waiting) */
  nextBundleAt: number | null
}
