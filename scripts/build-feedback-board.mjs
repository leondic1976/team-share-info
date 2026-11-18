// Writes the public board of feature requests and bug reports (feedback.json, shown by site/feedback.html).
// The posts are issues of this repository; the page cannot read them itself when the repository is
// private, so the site build exports what may be shown:
//   - issues labelled 기능요청 / 오류신고 (or with that prefix in the title), not labelled 비공개
//   - the writer's text, the receipt number and the app version; never the PC's unique value
//   - comments of the maintainers only, as answers
// Needs GH_TOKEN (Actions: github.token with issues: read). Without it the board that is online is kept.
//   node scripts/build-feedback-board.mjs <output file>
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const out = resolve(process.argv[2] ?? '_site/feedback.json')
const repo = process.env.GITHUB_REPOSITORY ?? 'leondic1976/team-share-info'
const site = process.env.SITE_URL ?? 'https://leondic1976.github.io/team-share-info/'
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? ''
const KINDS = { 기능요청: 'feature', 오류신고: 'bug' }
const HIDDEN = '비공개'
const MAX = 500

const gh = async (path) => {
  const r = await fetch(`https://api.github.com${path}`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'TeamHub-site', Authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${path}`)
  return r.json()
}

/** The parts of a post written by the app (src/node/feedback.ts issueOf); posts written on GitHub by hand are shown whole. */
export function parsePost(title, body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n')
  const receipt = /<!-- teamhub-feedback:(TH-[A-Z0-9]+) -->/.exec(text)?.[1] ?? null
  const author = /^\*\*작성자\*\*: (.*)$/m.exec(text)?.[1]?.trim() || null
  let content = text.replace(/<!--[\s\S]*?-->/g, '')
  let version = null
  if (receipt) {
    const cut = content.lastIndexOf('\n---\n')
    const foot = cut >= 0 ? content.slice(cut + 5) : ''
    version = /TeamHub \d+\.\d+\.\d+[^·\n]*(?:· Windows [^·\n]*)?/.exec(foot)?.[0]?.trim() ?? null
    if (cut >= 0) content = content.slice(0, cut)
    content = content.replace(/^\*\*분류\*\*: .*\n/m, '').replace(/^\*\*작성자\*\*: .*\n/m, '')
  }
  const m = /^\[(기능요청|오류신고)\]\s*(.*)$/.exec(String(title))
  return { prefix: m?.[1] ?? null, title: (m?.[2] ?? String(title)).trim(), author, receipt, version, body: content.trim() }
}

async function build() {
  const items = []
  for (let page = 1; page <= 10 && items.length < MAX; page++) {
    const list = await gh(`/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`)
    for (const i of list) {
      if (i.pull_request) continue
      const labels = i.labels.map((l) => (typeof l === 'string' ? l : l.name))
      if (labels.includes(HIDDEN)) continue
      const p = parsePost(i.title, i.body)
      const kindName = Object.keys(KINDS).find((k) => labels.includes(k)) ?? p.prefix
      if (!kindName) continue
      let answers = []
      if (i.comments > 0) {
        const cs = await gh(`/repos/${repo}/issues/${i.number}/comments?per_page=100`)
        answers = cs.filter((c) => ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c.author_association)).map((c) => ({ at: c.created_at, body: String(c.body ?? '').trim() }))
      }
      items.push({
        number: i.number,
        kind: KINDS[kindName],
        title: p.title,
        author: p.author ?? (p.receipt ? '익명' : i.user?.login ?? '익명'),
        body: p.body,
        receipt: p.receipt,
        version: p.version,
        state: i.state === 'closed' ? (i.state_reason === 'not_planned' ? 'declined' : 'done') : answers.length ? 'answered' : 'open',
        createdAt: i.created_at,
        closedAt: i.closed_at,
        answers
      })
    }
    if (list.length < 100) break
  }
  return { updatedAt: new Date().toISOString(), items }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  let board
  if (token) {
    board = await build()
    console.log(`feedback board: ${board.items.length} posts`)
  } else {
    // no access to the issues here (a build on a PC): keep the board that is online
    const r = await fetch(`${site}feedback.json`, { cache: 'no-store' }).catch(() => null)
    board = r?.ok ? await r.json().catch(() => null) : null
    console.log(board ? `feedback board: kept the published one (${board.items?.length ?? 0} posts)` : 'feedback board: empty (no token, nothing published yet)')
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(board ?? { updatedAt: new Date().toISOString(), items: [] }))
}
