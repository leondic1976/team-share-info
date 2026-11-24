// How feedback looks as GitHub issues, written by the intake workflow (scripts/feedback-intake.mjs)
// and read back by the board builder (scripts/build-feedback-board.mjs). Node built-ins only.
//
//   post issue   : labels 기능요청|오류신고 + 검증됨. The readable text is for people on GitHub; the
//                  board never reads it. The checked item itself is kept in a comment at the end
//                  (base64url of its canonical JSON) with a seal, and that is what the board shows.
//   bundle issue : after it was taken in: label 처리됨, closed; the comment at the end keeps which
//                  bundle of which server PC it was (for "already taken" and bundles per day).
import { createHmac, timingSafeEqual } from 'node:crypto'
import { FEEDBACK_KIND_LABELS, FEEDBACK_INTAKE_LABEL, FEEDBACK_PATTERNS, canonicalItem, parseItemText, receiptOf } from './feedback-schema.mjs'

export const LABELS = { intake: FEEDBACK_INTAKE_LABEL, verified: '검증됨', rejected: '거부', done: '처리됨', hidden: '비공개', feature: FEEDBACK_KIND_LABELS.feature, bug: FEEDBACK_KIND_LABELS.bug }

const ZW = '\u200B'
const UUID = FEEDBACK_PATTERNS.uuid.slice(1, -1)
const PC_UID = FEEDBACK_PATTERNS.pcUid.slice(1, -1)

/**
 * The seal: an HMAC only the workflows of the repository can make (secret FEEDBACK_SEAL_KEY).
 * The key built into the program can write issues, but it cannot make a seal - so a post that
 * did not come through the intake workflow never reaches the board. '-' when no secret is set.
 */
export function sealOf(key, what, ...parts) {
  return key ? createHmac('sha256', key).update(['teamhub-feedback', 'v1', what, ...parts].join('\n')).digest('hex') : '-'
}
function sealed(key, seal, what, ...parts) {
  if (!key) return true
  const want = Buffer.from(sealOf(key, what, ...parts))
  const got = Buffer.from(String(seal))
  return want.length === got.length && timingSafeEqual(want, got)
}

/**
 * Text of a user -> Markdown that shows it as written and does nothing else: no HTML, no
 * formatting, no notification of people (@name), no link to issues (#1, GH-1) or web addresses.
 */
export function neutralise(s) {
  return String(s)
    .replace(/@/g, `@${ZW}`)
    .replace(/#(?=[0-9])/g, `#${ZW}`)
    .replace(/(gh)-(?=[0-9])/gi, `$1-${ZW}`)
    .replace(/:\/\//g, `:${ZW}//`)
    .replace(/www\./gi, `www${ZW}.`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+\-.!|~=$:^]/g, '\\$&')
    .replace(/^[ \t]+/gm, (m) => '&nbsp;'.repeat(m.length))
}

/** The issue a checked item becomes. */
export function renderItemIssue(item, bundleId, sealKey) {
  const label = FEEDBACK_KIND_LABELS[item.kind]
  const canonical = canonicalItem(item)
  const foot = [item.app ? `TeamHub ${item.app.version} · ${item.app.os}` : '', `고유값 ${item.installId}`, `접수번호 ${receiptOf(item.submissionId)}`, item.submissionId].filter(Boolean).join(' · ')
  return {
    title: `[${label}] ${item.title.replace(/@/g, `@${ZW}`)}`,
    body: [
      `**분류**: ${label}`,
      `**작성자**: ${item.author ? neutralise(item.author) : '익명'}`,
      '',
      neutralise(item.body),
      '',
      '---',
      neutralise(foot),
      '',
      `<!-- teamhub-feedback:v1 ${Buffer.from(canonical, 'utf8').toString('base64url')} ${bundleId} ${sealOf(sealKey, 'item', bundleId, canonical)} -->`,
      ''
    ].join('\n'),
    labels: [label, LABELS.verified]
  }
}

const ITEM_RE = new RegExp(`<!-- teamhub-feedback:v1 ([A-Za-z0-9_-]{1,40000}) (${UUID}) ([0-9a-f]{64}|-) -->\\s*$`)

/** The checked item kept in a post; null when there is none, it was changed, or the seal is not ours. */
export function readItemIssue(body, sealKey) {
  if (typeof body !== 'string' || body.length > 70000 || body.split('<!-- teamhub-feedback').length !== 2) return null
  const m = ITEM_RE.exec(body)
  if (!m) return null
  const canonical = Buffer.from(m[1], 'base64url').toString('utf8')
  const r = parseItemText(canonical)
  if (!r.ok || canonicalItem(r.value) !== canonical || !sealed(sealKey, m[3], 'item', m[2], canonical)) return null
  return { item: r.value, bundleId: m[2] }
}

/** What a bundle issue is turned into once it was taken in. */
export function renderBundleDone(bundle, summaryLines, sealKey) {
  return {
    title: `[묶음] ${bundle.bundleId}`,
    body: [...summaryLines, '', `<!-- teamhub-feedback-bundle:v1 ${bundle.bundleId} ${bundle.serverId} ${sealOf(sealKey, 'bundle', bundle.bundleId, bundle.serverId)} -->`, ''].join('\n'),
    labels: [LABELS.done]
  }
}

const BUNDLE_RE = new RegExp(`<!-- teamhub-feedback-bundle:v1 (${UUID}) (${PC_UID}) ([0-9a-f]{64}|-) -->\\s*$`)

export function readBundleDone(body, sealKey) {
  if (typeof body !== 'string' || body.length > 70000 || body.split('<!-- teamhub-feedback').length !== 2) return null
  const m = BUNDLE_RE.exec(body)
  if (!m || !sealed(sealKey, m[3], 'bundle', m[1], m[2])) return null
  return { bundleId: m[1], serverId: m[2] }
}
