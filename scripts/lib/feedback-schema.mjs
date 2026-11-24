// The rules of a feedback item and a feedback bundle, in plain JavaScript (Node built-ins only),
// for the intake workflow and the board builder. The app and the server PC use the same rules
// written with Zod (src/shared/schemas/feedback.ts); the JSON Schema for people is
// docs/feedback-submission.schema.json. tests/shared/feedback-schema.test.ts proves that all
// three give the same verdict - change them together.

export const FEEDBACK_SCHEMA_VERSION = 1
export const FEEDBACK_LIMITS = { titleMin: 2, titleMax: 100, bodyMin: 5, bodyMax: 5000, authorMax: 30, itemMaxBytes: 24576, bundleMaxItems: 200, bundleMaxBytes: 60000 }
export const FEEDBACK_WINDOW = { pastMs: 180 * 86_400_000, futureMs: 86_400_000 }
export const FEEDBACK_INTAKE_LABEL = '접수'
export const FEEDBACK_KIND_LABELS = { feature: '기능요청', bug: '오류신고' }

const NEVER = '\\u007F-\\u009F\\u061C\\u200B\\u200E\\u200F\\u2028-\\u202E\\u2060-\\u2069\\uFEFF\\uFFF9-\\uFFFB\\uFFFE\\uFFFF\\u{E0000}-\\u{E007F}\\p{Cs}'

export const FEEDBACK_PATTERNS = {
  line: `^[^\\u0000-\\u001F${NEVER}]*$`,
  multi: `^[^\\u0000-\\u0008\\u000B-\\u001F${NEVER}]*$`,
  trimmed: '^(\\S([\\s\\S]*\\S)?)?$',
  pcUid: '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$',
  uuid: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  time: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$',
  version: '^(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})(-[0-9A-Za-z.-]{1,20})?$',
  os: '^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,59}$'
}
const RE = Object.fromEntries(Object.entries(FEEDBACK_PATTERNS).map(([k, v]) => [k, new RegExp(v, 'u')]))

const chars = (s) => {
  let n = 0
  for (const _ of s) n++
  return n
}

/** A plain object (as JSON.parse makes it) with exactly these keys; `optional` ones may be missing. */
function plain(v, required, optional = []) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return false
  const keys = Reflect.ownKeys(v)
  for (const k of keys) if (typeof k !== 'string' || (!required.includes(k) && !optional.includes(k))) return false
  for (const k of required) if (!Object.hasOwn(v, k)) return false
  return true
}

const str = (v, pattern) => typeof v === 'string' && pattern.test(v)

function text(v, min, max, allowed) {
  if (typeof v !== 'string' || v.length > max * 2 || !allowed.test(v) || !RE.trimmed.test(v)) return false
  const n = chars(v)
  return n >= min && n <= max && v === v.normalize('NFC')
}

function time(v) {
  if (!str(v, RE.time)) return false
  const t = Date.parse(v)
  return Number.isFinite(t) && new Date(t).toISOString() === v
}

/** Is this value an item? The result holds copies of the known keys only, in the fixed order. */
export function checkItem(v) {
  const bad = { ok: false, code: 'bad_item' }
  if (!plain(v, ['kind', 'title', 'body', 'author', 'installId', 'submissionId', 'createdAt'], ['app'])) return bad
  if (v.kind !== 'feature' && v.kind !== 'bug') return bad
  if (!text(v.title, FEEDBACK_LIMITS.titleMin, FEEDBACK_LIMITS.titleMax, RE.line)) return bad
  if (!text(v.body, FEEDBACK_LIMITS.bodyMin, FEEDBACK_LIMITS.bodyMax, RE.multi)) return bad
  if (!text(v.author, 0, FEEDBACK_LIMITS.authorMax, RE.line)) return bad
  if (!str(v.installId, RE.pcUid) || !str(v.submissionId, RE.uuid) || !time(v.createdAt)) return bad
  const value = { kind: v.kind, title: v.title, body: v.body, author: v.author, installId: v.installId, submissionId: v.submissionId, createdAt: v.createdAt }
  if (Object.hasOwn(v, 'app')) {
    // `app: undefined` cannot come out of JSON; the app's own check lets it pass as "not given"
    if (v.app !== undefined) {
      if (!plain(v.app, ['version', 'os']) || !str(v.app.version, RE.version) || !str(v.app.os, RE.os)) return bad
      value.app = { version: v.app.version, os: v.app.os }
    }
  }
  return { ok: true, value }
}

/** Is this value a bundle? A wrong envelope refuses all of it; a wrong item is left out and counted. */
export function checkBundle(v) {
  const bad = { ok: false, code: 'bad_format' }
  if (!plain(v, ['schema', 'type', 'bundleId', 'serverId', 'period', 'createdAt', 'app', 'items'])) return bad
  if (v.schema !== FEEDBACK_SCHEMA_VERSION || v.type !== 'bundle') return bad
  if (!str(v.bundleId, RE.uuid) || !str(v.serverId, RE.pcUid) || !time(v.createdAt)) return bad
  if (!plain(v.period, ['from', 'to']) || !time(v.period.from) || !time(v.period.to) || v.period.from > v.period.to) return bad
  if (!plain(v.app, ['version']) || !str(v.app.version, RE.version)) return bad
  if (!Array.isArray(v.items) || v.items.length < 1 || v.items.length > FEEDBACK_LIMITS.bundleMaxItems) return bad
  const items = []
  for (const raw of v.items) {
    const i = checkItem(raw)
    if (i.ok) items.push(i.value)
  }
  return {
    ok: true,
    value: { schema: v.schema, type: v.type, bundleId: v.bundleId, serverId: v.serverId, period: { from: v.period.from, to: v.period.to }, createdAt: v.createdAt, app: { version: v.app.version }, items },
    skipped: v.items.length - items.length
  }
}

// The one way an item / a bundle is written as text: known keys only, fixed order, no white space.
// (For values that passed checkItem / checkBundle.)
const orderedItem = (s) => {
  const o = { kind: s.kind, title: s.title, body: s.body, author: s.author, installId: s.installId, submissionId: s.submissionId, createdAt: s.createdAt }
  if (s.app) o.app = { version: s.app.version, os: s.app.os }
  return o
}
export const canonicalItem = (item) => JSON.stringify(orderedItem(item))
export const canonicalBundle = (b) =>
  JSON.stringify({ schema: b.schema, type: b.type, bundleId: b.bundleId, serverId: b.serverId, period: { from: b.period.from, to: b.period.to }, createdAt: b.createdAt, app: { version: b.app.version }, items: b.items.map(orderedItem) })

/** Text -> bundle: size first, then JSON.parse (never eval), compact form, then the shape. */
export function parseBundleText(text) {
  if (typeof text !== 'string' || text.length > FEEDBACK_LIMITS.bundleMaxBytes || Buffer.byteLength(text, 'utf8') > FEEDBACK_LIMITS.bundleMaxBytes) return { ok: false, code: 'too_large' }
  let value
  try {
    value = JSON.parse(text)
    if (JSON.stringify(value) !== text) return { ok: false, code: 'not_compact' }
  } catch {
    return { ok: false, code: 'bad_json' }
  }
  return checkBundle(value)
}

/** Text -> item (the board builder reads the item kept in a post). */
export function parseItemText(text) {
  if (typeof text !== 'string' || text.length > FEEDBACK_LIMITS.itemMaxBytes || Buffer.byteLength(text, 'utf8') > FEEDBACK_LIMITS.itemMaxBytes) return { ok: false, code: 'bad_item' }
  let value
  try {
    value = JSON.parse(text)
    if (JSON.stringify(value) !== text) return { ok: false, code: 'bad_item' }
  } catch {
    return { ok: false, code: 'bad_item' }
  }
  return checkItem(value)
}

export function inFeedbackWindow(iso, now) {
  const t = Date.parse(iso)
  return Number.isFinite(t) && t >= now - FEEDBACK_WINDOW.pastMs && t <= now + FEEDBACK_WINDOW.futureMs
}

export const receiptOf = (submissionId) => `TH-${submissionId.slice(0, 8).toUpperCase()}`
export const intakeTitle = (bundleId) => `[${FEEDBACK_INTAKE_LABEL}] ${bundleId}`
export const intakeBody = (canonical) => `\`\`\`json\n${canonical}\n\`\`\`\n`

/** The one fenced json block an intake issue consists of; null when the body is anything else. */
export function extractIntake(body) {
  if (typeof body !== 'string' || body.length > FEEDBACK_LIMITS.bundleMaxBytes + 64) return null
  const m = /^```json\n([^\n]+)\n```\n?$/.exec(body.replace(/\r\n/g, '\n'))
  return m ? m[1] : null
}
