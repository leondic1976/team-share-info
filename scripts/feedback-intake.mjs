// The gate of "기능요청 및 오류신고" on GitHub. A server PC hands in one bundle a week as an issue
// with the label 접수 whose body is nothing but one fenced json block (src/node/feedback.ts). This
// script decides what happens to it - the PC never does:
//   refused : comment with a reason code, body replaced by a placeholder, label 거부, closed, locked
//   taken   : one post issue per good item (labels 기능요청|오류신고 + 검증됨), the bundle issue is
//             closed with the label 처리됨 and a summary
// Issues without the label 접수 are not touched. Running it again changes nothing.
//
// Node built-ins only; no text of an issue ever reaches a shell (see docs/feedback-submission.md).
//   in a workflow : node scripts/feedback-intake.mjs            (GITHUB_EVENT_PATH, GITHUB_TOKEN, GITHUB_REPOSITORY)
//   a bundle file : node scripts/feedback-intake.mjs --file <bundle.json> [--dry-run]   (GH_TOKEN or GITHUB_TOKEN)
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FEEDBACK_LIMITS, FEEDBACK_WINDOW, extractIntake, inFeedbackWindow, intakeBody, intakeTitle, parseBundleText } from './lib/feedback-schema.mjs'
import { LABELS, readBundleDone, readItemIssue, renderBundleDone, renderItemIssue } from './lib/feedback-issue.mjs'

export const MAX_BUNDLES_PER_DAY = 3
const DAY = 86_400_000

/** Why a bundle is refused as a whole. The comment on the issue shows the code and this sentence, nothing of the content. */
export const REASONS = {
  bad_envelope: '접수 형식(정해진 제목과 json 블록 하나)이 아닙니다.',
  too_large: '문서가 정해진 크기를 넘습니다.',
  bad_json: 'JSON으로 읽을 수 없습니다.',
  not_compact: 'JSON 표기가 정해진 형태(공백·중복 키 없음)가 아닙니다.',
  bad_format: '묶음의 형식이 정해진 형식과 다릅니다.',
  time_window: '만든 시각이 허용 범위를 벗어났습니다.',
  blocked: '이용이 제한된 서버 PC입니다.',
  duplicate: '이미 접수된 묶음입니다.',
  rate_limit: `한 서버 PC에서 하루에 받을 수 있는 묶음 수(${MAX_BUNDLES_PER_DAY})를 넘었습니다.`
}
/** Why a single item of a taken bundle is left out (counted in the summary). */
export const ITEM_REASONS = {
  bad_item: '형식이 다름',
  item_time: '작성 시각이 허용 범위 밖',
  item_blocked: '이용이 제한된 PC',
  item_duplicate: '이미 게시된 글'
}

const LABEL_COLORS = { [LABELS.intake]: 'ededed', [LABELS.verified]: '0e8a16', [LABELS.rejected]: 'b60205', [LABELS.done]: 'c5def5', [LABELS.feature]: '1d76db', [LABELS.bug]: 'd93f0b' }

const names = (issue) => (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
const must = (r, what) => {
  if (r.status < 200 || r.status >= 300) throw new Error(`GitHub ${r.status}: ${what}`)
  return r.data
}

/** A label that does not exist yet must not break a run. */
export async function ensureLabels(deps) {
  const have = new Set()
  for (let page = 1; page <= 5; page++) {
    const list = must(await deps.gh('GET', `/labels?per_page=100&page=${page}`), 'list labels')
    for (const l of list) have.add(l.name)
    if (list.length < 100) break
  }
  for (const [name, color] of Object.entries(LABEL_COLORS)) {
    if (have.has(name)) continue
    const r = await deps.gh('POST', '/labels', { name, color })
    // 422: somebody made it in the meantime
    if (r.status !== 201 && r.status !== 422) throw new Error(`GitHub ${r.status}: create label`)
  }
}

async function listIssues(deps, query, maxPages) {
  const out = []
  for (let page = 1; page <= maxPages; page++) {
    const list = must(await deps.gh('GET', `/issues?${query}&per_page=100&page=${page}`), 'list issues')
    for (const i of list) if (!i.pull_request) out.push(i)
    if (list.length < 100) break
  }
  return out
}

async function refuse(deps, number, code) {
  // one change does it all, so half a refusal cannot be left behind; the content does not stay in the issue
  must(
    await deps.gh('PATCH', `/issues/${number}`, {
      title: '[거부] 접수되지 않은 제출',
      body: '정해진 형식 확인을 통과하지 못해 내용을 지웠습니다.\n',
      labels: [LABELS.rejected],
      state: 'closed',
      state_reason: 'not_planned'
    }),
    'refuse'
  )
  must(await deps.gh('POST', `/issues/${number}/comments`, { body: `접수되지 않았습니다. 사유 코드: \`${code}\` (${REASONS[code]})` }), 'comment')
  const lock = await deps.gh('PUT', `/issues/${number}/lock`, { lock_reason: 'resolved' })
  if (lock.status !== 204) deps.log(`#${number}: not locked (${lock.status})`)
  deps.log(`#${number}: refused (${code})`)
  return { action: 'rejected', code }
}

/** Look at one issue and do what has to be done with it. */
export async function processIssue(number, deps) {
  const got = await deps.gh('GET', `/issues/${number}`)
  if (got.status === 404 || got.status === 410) return { action: 'ignored' }
  // the issue as it is now, never the copy in the event (which may be older than an earlier run)
  const issue = must(got, 'read issue')
  const labels = names(issue)
  if (issue.pull_request || issue.state !== 'open' || !labels.includes(LABELS.intake) || labels.includes(LABELS.rejected) || labels.includes(LABELS.done)) return { action: 'ignored' }

  const now = deps.now()
  const text = extractIntake(issue.body)
  if (text === null) return refuse(deps, number, typeof issue.body === 'string' && issue.body.length > FEEDBACK_LIMITS.bundleMaxBytes + 64 ? 'too_large' : 'bad_envelope')
  const parsed = parseBundleText(text)
  if (!parsed.ok) return refuse(deps, number, parsed.code)
  const bundle = parsed.value
  if (issue.title !== intakeTitle(bundle.bundleId)) return refuse(deps, number, 'bad_envelope')
  if (!inFeedbackWindow(bundle.createdAt, now)) return refuse(deps, number, 'time_window')
  if (deps.blocked.has(bundle.serverId)) return refuse(deps, number, 'blocked')

  // bundles taken before, and bundles handed in earlier that still wait: the later one loses
  const earlier = []
  for (const i of await listIssues(deps, `state=all&labels=${encodeURIComponent(LABELS.done)}&sort=created&direction=desc`, 30)) {
    const b = i.number !== number && readBundleDone(i.body, deps.sealKey)
    if (b) earlier.push({ ...b, at: Date.parse(i.created_at) })
  }
  for (const i of await listIssues(deps, `state=open&labels=${encodeURIComponent(LABELS.intake)}&sort=created&direction=asc`, 5)) {
    if (i.number >= number) continue
    const t = extractIntake(i.body)
    const p = t === null ? null : parseBundleText(t)
    if (p?.ok) earlier.push({ bundleId: p.value.bundleId, serverId: p.value.serverId, at: Date.parse(i.created_at) })
  }
  if (earlier.some((b) => b.bundleId === bundle.bundleId)) return refuse(deps, number, 'duplicate')
  const at = Date.parse(issue.created_at)
  if (earlier.filter((b) => b.serverId === bundle.serverId && Math.abs(at - b.at) < DAY).length >= MAX_BUNDLES_PER_DAY) return refuse(deps, number, 'rate_limit')

  // posts that exist already (an item is never posted twice, also not by a second run of this bundle)
  const since = new Date(now - FEEDBACK_WINDOW.pastMs - 10 * DAY).toISOString()
  const posted = new Map()
  for (const i of await listIssues(deps, `state=all&labels=${encodeURIComponent(LABELS.verified)}&since=${encodeURIComponent(since)}&sort=created&direction=desc`, 100)) {
    const p = readItemIssue(i.body, deps.sealKey)
    if (p && !posted.has(p.item.submissionId)) posted.set(p.item.submissionId, p.bundleId)
  }

  const skipped = { bad_item: parsed.skipped, item_time: 0, item_blocked: 0, item_duplicate: 0 }
  let made = 0
  let before = 0
  const mine = new Set()
  for (const item of bundle.items) {
    if (!inFeedbackWindow(item.createdAt, now)) skipped.item_time++
    else if (deps.blocked.has(item.installId)) skipped.item_blocked++
    else if (mine.has(item.submissionId)) skipped.item_duplicate++
    else if (posted.has(item.submissionId)) {
      // made by an earlier run of this very bundle that did not get to the end
      if (posted.get(item.submissionId) === bundle.bundleId) before++
      else skipped.item_duplicate++
    } else {
      // GitHub slows down accounts that create content too fast
      if (made) await deps.sleep(1000)
      must(await deps.gh('POST', '/issues', renderItemIssue(item, bundle.bundleId, deps.sealKey)), 'create post')
      made++
    }
    mine.add(item.submissionId)
  }

  const left = Object.entries(skipped).filter(([, n]) => n > 0)
  const leftTotal = left.reduce((a, [, n]) => a + n, 0)
  const summary = [`묶음을 처리했습니다. 게시 ${made + before}건, 제외 ${leftTotal}건.`, ...left.map(([code, n]) => `- 제외 \`${code}\` (${ITEM_REASONS[code]}): ${n}건`)]
  must(await deps.gh('PATCH', `/issues/${number}`, { ...renderBundleDone(bundle, [`묶음 ${bundle.bundleId} · 게시 ${made + before}건 · 제외 ${leftTotal}건`], deps.sealKey), state: 'closed', state_reason: 'completed' }), 'close bundle')
  const c = await deps.gh('POST', `/issues/${number}/comments`, { body: summary.join('\n') })
  if (c.status !== 201) deps.log(`#${number}: summary comment not written (${c.status})`)
  deps.log(`#${number}: taken (${made} posts made, ${before} made before, ${leftTotal} left out)`)
  return { action: 'accepted', made, before, skipped }
}

/** What a workflow run does: the issue of the event, or (run by hand / by the clock) everything that waits. */
export async function run(event, deps) {
  await ensureLabels(deps)
  const one = event?.issue?.number ?? (/^[0-9]{1,9}$/.test(String(event?.inputs?.issue ?? '')) ? Number(event.inputs.issue) : null)
  if (Number.isInteger(one) && one > 0) return [{ number: one, ...(await processIssue(one, deps)) }]
  const out = []
  const waiting = await listIssues(deps, `state=open&labels=${encodeURIComponent(LABELS.intake)}&sort=created&direction=asc`, 5)
  for (const i of waiting.sort((a, b) => a.number - b.number)) out.push({ number: i.number, ...(await processIssue(i.number, deps)) })
  return out
}

/**
 * A bundle that came as a file (the server PC has no internet or no key): checked here with the
 * same rules, then handed in as an intake issue - the workflow takes it from there like any other.
 */
export async function submitFile(file, deps, dryRun = false) {
  if (statSync(file).size > FEEDBACK_LIMITS.bundleMaxBytes + 2) return { ok: false, code: 'too_large' }
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r?\n$/, '')
  const parsed = parseBundleText(text)
  if (!parsed.ok) return { ok: false, code: parsed.code }
  const bundle = parsed.value
  if (!inFeedbackWindow(bundle.createdAt, deps.now())) return { ok: false, code: 'time_window' }
  if (deps.blocked.has(bundle.serverId)) return { ok: false, code: 'blocked' }
  if (dryRun) return { ok: true, bundleId: bundle.bundleId, items: bundle.items.length, skipped: parsed.skipped }
  await ensureLabels(deps)
  const recent = await listIssues(deps, 'state=all&sort=created&direction=desc', 3)
  const there = recent.find((i) => i.title === intakeTitle(bundle.bundleId) || i.title === `[묶음] ${bundle.bundleId}`)
  if (there) return { ok: true, bundleId: bundle.bundleId, items: bundle.items.length, skipped: parsed.skipped, number: there.number, existed: true }
  const made = must(await deps.gh('POST', '/issues', { title: intakeTitle(bundle.bundleId), body: intakeBody(text), labels: [LABELS.intake] }), 'create intake issue')
  return { ok: true, bundleId: bundle.bundleId, items: bundle.items.length, skipped: parsed.skipped, number: made.number }
}

/** PCs shut out by the maintainer: site/feedback-blocked.json, a list of unique values (server PCs and member PCs). */
export function readBlocked(root) {
  try {
    const list = JSON.parse(readFileSync(join(root, 'site', 'feedback-blocked.json'), 'utf8'))
    return new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function githubApi(token, repo, api = 'https://api.github.com') {
  return async (method, path, body) => {
    const r = await fetch(`${api}/repos/${repo}${path}`, {
      method,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'TeamHub-feedback-intake', Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await r.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      // not JSON: the status says enough
    }
    return { status: r.status, data }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve(import.meta.dirname, '..')
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  const repo = process.env.GITHUB_REPOSITORY || 'leondic1976/team-share-info'
  const args = process.argv.slice(2)
  const fileAt = args.indexOf('--file')
  const dryRun = args.includes('--dry-run')
  if (!token && !(fileAt >= 0 && dryRun)) {
    console.error('GITHUB_TOKEN (or GH_TOKEN) is not set')
    process.exit(1)
  }
  const deps = {
    gh: githubApi(token, repo, process.env.GITHUB_API_URL || 'https://api.github.com'),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => console.log(m),
    blocked: readBlocked(root),
    sealKey: process.env.FEEDBACK_SEAL_KEY || ''
  }
  if (fileAt >= 0) {
    const file = args[fileAt + 1]
    if (!file || !existsSync(file)) {
      console.error('usage: node scripts/feedback-intake.mjs --file <bundle.json> [--dry-run]')
      process.exit(1)
    }
    const r = await submitFile(resolve(file), deps, dryRun)
    if (!r.ok) {
      console.error(`refused: ${r.code} (${REASONS[r.code]})`)
      process.exit(2)
    }
    console.log(dryRun ? `ok: bundle ${r.bundleId}, ${r.items} items (${r.skipped} would be left out)` : `${r.existed ? 'already handed in' : 'handed in'}: issue #${r.number}, bundle ${r.bundleId}, ${r.items} items`)
  } else {
    const path = process.env.GITHUB_EVENT_PATH
    const event = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
    for (const r of await run(event, deps)) console.log(`#${r.number}: ${r.action}${r.code ? ` (${r.code})` : ''}`)
  }
}
