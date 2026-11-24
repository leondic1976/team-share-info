// Writes the public board of feature requests and bug reports (feedback.json, shown by site/feedback.html).
// The board trusts nothing but what the intake workflow checked (scripts/feedback-intake.mjs):
//   - only issues with the label 검증됨 (and not 비공개) whose kept item still passes the rules
//     and carries the seal of the workflow (secret FEEDBACK_SEAL_KEY)
//   - kind, title, text and writer come from that item, never from the title, the labels or the
//     readable text of the issue (those can be changed by whoever may write issues)
//   - never the unique value of a PC
//   - comments of the maintainers only, as answers
// Needs GH_TOKEN (Actions: github.token with issues: read). Without it the board that is online is kept.
//   node scripts/build-feedback-board.mjs <output file>
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { receiptOf } from './lib/feedback-schema.mjs'
import { LABELS, readItemIssue } from './lib/feedback-issue.mjs'

const MAX = 500

/**
 * Issues -> what the board shows. `answersOf(number)` gives the maintainers' comments.
 * `unverifiable`: posts that carry a seal while no key is at hand to check it (they are left out).
 */
export async function boardItems(issues, { sealKey = '', answersOf = async () => [] } = {}) {
  const items = []
  const seen = new Set()
  let unverifiable = 0
  // oldest first: when the same post exists twice, the first one is the real one
  for (const i of [...issues].sort((a, b) => a.number - b.number)) {
    if (i.pull_request) continue
    const labels = (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
    if (!labels.includes(LABELS.verified) || labels.includes(LABELS.hidden)) continue
    const kept = readItemIssue(i.body, sealKey)
    if (!kept) continue
    if (!sealKey && !/ - -->\s*$/.test(i.body)) {
      unverifiable++
      continue
    }
    const { item } = kept
    if (seen.has(item.submissionId)) continue
    seen.add(item.submissionId)
    const answers = i.comments > 0 ? await answersOf(i.number) : []
    items.push({
      number: i.number,
      kind: item.kind,
      title: item.title,
      author: item.author || '익명',
      body: item.body,
      receipt: receiptOf(item.submissionId),
      version: item.app ? `TeamHub ${item.app.version} · ${item.app.os}` : null,
      state: i.state === 'closed' ? (i.state_reason === 'not_planned' ? 'declined' : 'done') : answers.length ? 'answered' : 'open',
      createdAt: item.createdAt,
      closedAt: i.closed_at ?? null,
      answers
    })
  }
  return { items: items.sort((a, b) => b.number - a.number).slice(0, MAX), unverifiable }
}

async function build({ repo, token, sealKey }) {
  const gh = async (path) => {
    const r = await fetch(`https://api.github.com${path}`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'TeamHub-site', Authorization: `Bearer ${token}` } })
    if (!r.ok) throw new Error(`GitHub ${r.status} for ${path}`)
    return r.json()
  }
  const issues = []
  for (let page = 1; page <= 10; page++) {
    const list = await gh(`/repos/${repo}/issues?state=all&labels=${encodeURIComponent(LABELS.verified)}&sort=created&direction=desc&per_page=100&page=${page}`)
    issues.push(...list)
    if (list.length < 100) break
  }
  const answersOf = async (number) => {
    const cs = await gh(`/repos/${repo}/issues/${number}/comments?per_page=100`)
    return cs.filter((c) => ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c.author_association) && c.user?.type !== 'Bot').map((c) => ({ at: c.created_at, body: String(c.body ?? '').trim() }))
  }
  const { items, unverifiable } = await boardItems(issues, { sealKey, answersOf })
  // posts are sealed but this run has no key to check them: do not publish a board built on trust
  if (unverifiable) return null
  return { updatedAt: new Date().toISOString(), items }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const out = resolve(process.argv[2] ?? '_site/feedback.json')
  const site = process.env.SITE_URL ?? 'https://leondic1976.github.io/team-share-info/'
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? ''
  let board = token ? await build({ repo: process.env.GITHUB_REPOSITORY ?? 'leondic1976/team-share-info', token, sealKey: process.env.FEEDBACK_SEAL_KEY ?? '' }) : null
  if (board) console.log(`feedback board: ${board.items.length} posts`)
  else {
    // no access to the issues here (a build on a PC), or no key to check the seals: keep the board that is online
    const r = await fetch(`${site}feedback.json`, { cache: 'no-store' }).catch(() => null)
    board = r?.ok ? await r.json().catch(() => null) : null
    console.log(board ? `feedback board: kept the published one (${board.items?.length ?? 0} posts)` : 'feedback board: empty (nothing published yet)')
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(board ?? { updatedAt: new Date().toISOString(), items: [] }))
}
