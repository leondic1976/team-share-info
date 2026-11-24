import { describe, expect, it, beforeAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalBundle, intakeBody, intakeTitle, type FeedbackBundle, type FeedbackItem } from '../../src/shared/schemas/feedback'

/**
 * The gate on GitHub (scripts/feedback-intake.mjs) and the board builder
 * (scripts/build-feedback-board.mjs), run against a stand-in for the issues of a repository.
 */
const root = resolve(__dirname, '..', '..')
const load = async <T>(...p: string[]): Promise<T> => (await import(/* @vite-ignore */ pathToFileURL(join(root, ...p)).href)) as T

interface Issue {
  number: number
  title: string
  body: string
  labels: { name: string }[]
  state: 'open' | 'closed'
  state_reason: string | null
  created_at: string
  closed_at: string | null
  comments: number
  locked: boolean
  pull_request?: object
}
type Api = (method: string, path: string, body?: Record<string, unknown>) => Promise<{ status: number; data: unknown }>
interface Deps {
  gh: Api
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (m: string) => void
  blocked: Set<string>
  sealKey: string
}
interface Result {
  number?: number
  action: 'ignored' | 'accepted' | 'rejected'
  code?: string
  made?: number
  before?: number
  skipped?: Record<string, number>
}
interface Intake {
  MAX_BUNDLES_PER_DAY: number
  REASONS: Record<string, string>
  processIssue: (n: number, deps: Deps) => Promise<Result>
  run: (event: unknown, deps: Deps) => Promise<Result[]>
  submitFile: (file: string, deps: Deps, dryRun?: boolean) => Promise<{ ok: boolean; code?: string; number?: number; existed?: boolean; items?: number; skipped?: number }>
  readBlocked: (root: string) => Set<string>
}
interface BoardItem {
  number: number
  kind: string
  title: string
  author: string
  body: string
  receipt: string
  version: string | null
  state: string
  answers: { at: string; body: string }[]
}
interface Board {
  boardItems: (issues: Issue[], o?: { sealKey?: string; answersOf?: (n: number) => Promise<{ at: string; body: string }[]> }) => Promise<{ items: BoardItem[]; unverifiable: number }>
}
interface IssueLib {
  neutralise: (s: string) => string
  renderItemIssue: (item: FeedbackItem, bundleId: string, sealKey: string) => { title: string; body: string; labels: string[] }
  readItemIssue: (body: string, sealKey: string) => { item: FeedbackItem; bundleId: string } | null
}

let intake: Intake
let board: Board
let lib: IssueLib
beforeAll(async () => {
  intake = await load<Intake>('scripts', 'feedback-intake.mjs')
  board = await load<Board>('scripts', 'build-feedback-board.mjs')
  lib = await load<IssueLib>('scripts', 'lib', 'feedback-issue.mjs')
})

const NOW = Date.parse('2026-11-24T03:00:00.000Z')
const DAY = 86_400_000
const SEAL = 'seal-key-of-the-repository'

/** The issues of a repository, as far as the scripts use them. */
class Repo {
  issues: Issue[] = []
  labels = new Set<string>()
  comments = new Map<number, string[]>()
  calls: string[] = []
  clock = NOW
  /** let the n-th creation of an issue fail (GitHub slows an account down) */
  failCreateAt = 0
  private creations = 0

  /** `fresh`: a repository in which none of the labels exists yet */
  constructor(fresh = false) {
    if (!fresh) for (const l of ['접수', '검증됨', '거부', '처리됨', '기능요청', '오류신고']) this.labels.add(l)
  }

  add(title: string, body: string, labels: string[], over: Partial<Issue> = {}): Issue {
    for (const l of labels) this.labels.add(l)
    const i: Issue = { number: this.issues.length + 1, title, body, labels: labels.map((name) => ({ name })), state: 'open', state_reason: null, created_at: new Date(this.clock).toISOString(), closed_at: null, comments: 0, locked: false, ...over }
    this.issues.push(i)
    return i
  }
  /** what a server PC does: the JSON alone, the intake label */
  hand(b: FeedbackBundle | string, title?: string): Issue {
    const text = typeof b === 'string' ? b : canonicalBundle(b)
    return this.add(title ?? intakeTitle(typeof b === 'string' ? ((JSON.parse(b) as { bundleId?: string }).bundleId ?? 'x') : b.bundleId), intakeBody(text), ['접수'])
  }
  api: Api = async (method, path, body) => {
    this.calls.push(`${method} ${path.split('?')[0]}`)
    const [p, q = ''] = path.split('?')
    const query = new URLSearchParams(q)
    const one = /^\/issues\/(\d+)(\/comments|\/lock)?$/.exec(p)
    if (p === '/labels' && method === 'GET') return { status: 200, data: query.get('page') === '1' ? [...this.labels].map((name) => ({ name })) : [] }
    if (p === '/labels' && method === 'POST') {
      if (this.labels.has(String(body!.name))) return { status: 422, data: null }
      this.labels.add(String(body!.name))
      return { status: 201, data: body }
    }
    if (p === '/issues' && method === 'GET') {
      if (query.get('page') !== '1') return { status: 200, data: [] }
      const label = query.get('labels')
      const state = query.get('state')
      return { status: 200, data: structuredClone(this.issues.filter((i) => (!label || i.labels.some((l) => l.name === label)) && (state === 'all' || !state || i.state === state)).reverse()) }
    }
    if (p === '/issues' && method === 'POST') {
      if (++this.creations === this.failCreateAt) return { status: 403, data: { message: 'secondary rate limit' } }
      const labels = (body!.labels as string[]) ?? []
      // GitHub makes a label that does not exist yet only for those who may; here it has to exist
      if (labels.some((l) => !this.labels.has(l))) return { status: 422, data: null }
      return { status: 201, data: structuredClone(this.add(String(body!.title), String(body!.body), labels)) }
    }
    if (one) {
      const i = this.issues.find((x) => x.number === Number(one[1]))
      if (!i) return { status: 404, data: null }
      if (!one[2] && method === 'GET') return { status: 200, data: structuredClone(i) }
      if (!one[2] && method === 'PATCH') {
        if (typeof body!.title === 'string') i.title = body!.title
        if (typeof body!.body === 'string') i.body = body!.body
        if (Array.isArray(body!.labels)) i.labels = (body!.labels as string[]).map((name) => ({ name }))
        if (body!.state === 'closed') {
          i.state = 'closed'
          i.state_reason = String(body!.state_reason ?? 'completed')
          i.closed_at = new Date(this.clock).toISOString()
        }
        return { status: 200, data: structuredClone(i) }
      }
      if (one[2] === '/comments' && method === 'POST') {
        this.comments.set(i.number, [...(this.comments.get(i.number) ?? []), String(body!.body)])
        i.comments++
        return { status: 201, data: {} }
      }
      if (one[2] === '/lock' && method === 'PUT') {
        i.locked = true
        return { status: 204, data: null }
      }
    }
    return { status: 404, data: null }
  }
  deps(over: Partial<Deps> = {}): Deps {
    return { gh: this.api, now: () => this.clock, sleep: async () => undefined, log: () => undefined, blocked: new Set(), sealKey: SEAL, ...over }
  }
  names(n: number): string[] {
    return this.issues[n - 1].labels.map((l) => l.name)
  }
  posts(): Issue[] {
    return this.issues.filter((i) => i.labels.some((l) => l.name === '검증됨'))
  }
  snapshot(): string {
    return JSON.stringify([this.issues, [...this.comments], [...this.labels]])
  }
}

const uuid = (n: number, tail = '555555555555'): string => `${String(n).padStart(8, '0')}-2222-4333-8444-${tail}`
const item = (n = 1, over: Partial<FeedbackItem> = {}): FeedbackItem => ({
  kind: 'bug',
  title: `자료실에서 큰 파일이 멈춥니다 ${n}`,
  body: '5GB 파일을 올리면 멈춥니다.',
  author: '',
  installId: 'ABCD-EFGH-JKLM',
  submissionId: uuid(n),
  createdAt: '2026-11-20T01:02:03.004Z',
  ...over
})
const bundle = (n = 1, items: FeedbackItem[] = [item(n)], over: Partial<FeedbackBundle> = {}): FeedbackBundle => ({
  schema: 1,
  type: 'bundle',
  bundleId: uuid(n, 'bbbbbbbbbbbb'),
  serverId: 'WXYZ-2345-6789',
  period: { from: '2026-11-17T00:00:00.000Z', to: '2026-11-24T00:00:00.000Z' },
  createdAt: '2026-11-24T00:00:01.000Z',
  app: { version: '1.7.2' },
  items,
  ...over
})

describe('feedback intake: the gate on GitHub', () => {
  it('takes a good bundle: one post per item, text made harmless, the bundle closed as done; a second run changes nothing', async () => {
    const repo = new Repo(true)
    const nasty = item(2, {
      kind: 'feature',
      title: '<script>alert(1)</script> @admin #1',
      author: '@everyone',
      body: '```\n</details>\n<img src=x onerror=alert(1)> @someone 확인 #12, GH-3\n[링크](javascript:alert(1)) https://evil.example/x www.evil.example\n# 큰 제목\n    code\n<!-- teamhub-feedback:v1 x -->',
      app: { version: '1.7.2', os: 'Windows 10.0.26100' }
    })
    repo.hand(bundle(1, [item(1), nasty]))
    const r = await intake.run({ action: 'opened', issue: { number: 1, title: 'ignored: the script asks GitHub', body: 'ignored' } }, repo.deps())
    expect(r).toEqual([{ number: 1, action: 'accepted', made: 2, before: 0, skipped: { bad_item: 0, item_time: 0, item_blocked: 0, item_duplicate: 0 } }])

    // labels that did not exist were made
    expect([...repo.labels].sort()).toEqual(['거부', '검증됨', '기능요청', '오류신고', '접수', '처리됨'].sort())
    const [a, b] = repo.posts()
    expect(a.title).toBe('[오류신고] 자료실에서 큰 파일이 멈춥니다 1')
    expect(repo.names(a.number)).toEqual(['오류신고', '검증됨'])
    expect(repo.names(b.number)).toEqual(['기능요청', '검증됨'])
    expect(a.body).toContain('**작성자**: 익명')
    // nothing of the nasty text does anything on GitHub: no HTML, no fence, no mention, no reference, no link
    const shown = b.body.slice(0, b.body.lastIndexOf('<!-- teamhub-feedback:v1'))
    expect(shown).not.toMatch(/<[a-z!/]/i)
    expect(shown).not.toMatch(/@[A-Za-z0-9]/)
    expect(shown).not.toMatch(/#[0-9]/)
    expect(shown).not.toMatch(/GH-[0-9]/i)
    expect(shown).not.toMatch(/(^|[^\\])`/)
    expect(shown).not.toContain('://')
    expect(shown).not.toContain('www.')
    expect(shown).not.toMatch(/^ {4}/m)
    expect(shown).not.toMatch(/(^|[^\\])[[\]()]/)
    expect(b.title).not.toMatch(/@[A-Za-z]/)
    expect(b.body.split('<!-- teamhub-feedback').length).toBe(2) // the one at the end is the only one
    // the checked item is kept for the board, sealed
    expect(lib.readItemIssue(b.body, SEAL)).toEqual({ item: nasty, bundleId: uuid(1, 'bbbbbbbbbbbb') })

    // the bundle issue: closed as done, the JSON is gone from it, a summary was written
    const done = repo.issues[0]
    expect(done).toMatchObject({ title: `[묶음] ${uuid(1, 'bbbbbbbbbbbb')}`, state: 'closed', state_reason: 'completed', locked: false })
    expect(repo.names(1)).toEqual(['처리됨'])
    expect(done.body).not.toContain('```json')
    expect(repo.comments.get(1)).toEqual(['묶음을 처리했습니다. 게시 2건, 제외 0건.'])

    // again (the "labeled" event of the same issue, a manual run, the daily run): nothing changes
    const before = repo.snapshot()
    expect(await intake.run({ action: 'labeled', issue: { number: 1 } }, repo.deps())).toEqual([{ number: 1, action: 'ignored' }])
    expect(await intake.run({ inputs: { issue: '1' } }, repo.deps())).toEqual([{ number: 1, action: 'ignored' }])
    expect(await intake.run({}, repo.deps())).toEqual([])
    expect(await intake.run({ action: 'edited', issue: { number: 2 } }, repo.deps())).toEqual([{ number: 2, action: 'ignored' }])
    expect(repo.snapshot()).toBe(before)
  })

  it('leaves alone what is not an intake issue', async () => {
    const repo = new Repo()
    repo.add('버그가 있습니다', '관리자가 직접 쓴 이슈 @someone', ['bug'])
    repo.add('[접수] 흉내', intakeBody(canonicalBundle(bundle())), []) // anybody can open an issue, but not set a label
    repo.add(intakeTitle(bundle().bundleId), intakeBody(canonicalBundle(bundle())), ['접수'], { state: 'closed' })
    repo.add('a pull request', 'x', ['접수'], { pull_request: {} })
    const before = JSON.stringify(repo.issues)
    for (const n of [1, 2, 3, 4, 99]) expect(await intake.processIssue(n, repo.deps())).toEqual({ action: 'ignored' })
    expect(await intake.run({ inputs: { issue: '1; rm -rf /' } }, repo.deps())).toEqual([])
    expect(JSON.stringify(repo.issues)).toBe(before)
    expect(repo.comments.size).toBe(0)
    expect(repo.calls.filter((c) => c.startsWith('PATCH') || c.startsWith('PUT') || c === 'POST /issues')).toEqual([])
  })

  it('refuses a bundle whose envelope is wrong: reason code, placeholder, 거부, closed, locked - and nothing of the content stays', async () => {
    const good = canonicalBundle(bundle(1, [item(1, { title: '비밀 제목 SECRET', body: '주민번호 900101-1234567 SECRET' })]))
    const cases: [string, (repo: Repo) => Issue, Partial<Deps>?][] = [
      ['bad_envelope', (r) => r.add(intakeTitle(bundle().bundleId), `안녕하세요 SECRET\n${intakeBody(good)}`, ['접수'])],
      ['bad_envelope', (r) => r.add(intakeTitle(bundle().bundleId), `${intakeBody(good)}\n\`\`\`json\n{"SECRET":1}\n\`\`\`\n`, ['접수'])],
      ['bad_envelope', (r) => r.add('[접수] SECRET 다른 제목', intakeBody(good), ['접수'])],
      ['bad_envelope', (r) => r.add(intakeTitle(bundle(2).bundleId), intakeBody(good), ['접수'])],
      ['bad_envelope', (r) => r.add(intakeTitle(bundle().bundleId), '', ['접수'])],
      ['too_large', (r) => r.add(intakeTitle(bundle().bundleId), intakeBody(`{"SECRET":"${'x'.repeat(61000)}"}`), ['접수'])],
      ['too_large', (r) => r.add(intakeTitle(bundle().bundleId), `SECRET ${'x'.repeat(70000)}`, ['접수'])],
      ['bad_json', (r) => r.hand('{SECRET:1}', intakeTitle(bundle().bundleId))],
      ['not_compact', (r) => r.hand(good.replace('"type":"bundle"', '"type":"SECRET","type":"bundle"'))],
      ['not_compact', (r) => r.hand(good.replace('{"schema":1,', '{"schema":1, '))],
      ['bad_format', (r) => r.hand(good.replace('"type":"bundle"', '"type":"bundle","orgName":"SECRET"'))],
      ['bad_format', (r) => r.hand(good.replace('{"schema":1', '{"__proto__":{"SECRET":1},"schema":1'))],
      ['bad_format', (r) => r.hand(good.replace('"serverId":"WXYZ-2345-6789"', '"serverId":"SECRET"'))],
      ['time_window', (r) => r.hand(good.replace('"createdAt":"2026-11-24T00:00:01.000Z"', '"createdAt":"2026-11-26T00:00:01.000Z"'))],
      ['time_window', (r) => r.hand(good.replace('"createdAt":"2026-11-24T00:00:01.000Z"', '"createdAt":"2026-01-01T00:00:01.000Z"'))],
      ['blocked', (r) => r.hand(good), { blocked: new Set(['WXYZ-2345-6789']) }]
    ]
    for (const [code, make, over] of cases) {
      const repo = new Repo()
      const i = make(repo)
      const r = await intake.processIssue(i.number, repo.deps(over))
      expect([code, r]).toEqual([code, { action: 'rejected', code }])
      expect(repo.issues[0]).toMatchObject({ title: '[거부] 접수되지 않은 제출', state: 'closed', state_reason: 'not_planned', locked: true })
      expect(repo.names(1)).toEqual(['거부'])
      expect(repo.comments.get(1)).toEqual([`접수되지 않았습니다. 사유 코드: \`${code}\` (${intake.REASONS[code]})`])
      expect(JSON.stringify([repo.issues, [...repo.comments]])).not.toMatch(/SECRET|900101/)
      expect(repo.posts()).toEqual([])
      // idempotent
      const before = repo.snapshot()
      expect(await intake.processIssue(i.number, repo.deps(over))).toEqual({ action: 'ignored' })
      expect(repo.snapshot()).toBe(before)
    }
  })

  it('the same bundle twice: the later one is refused; so is a bundle that waits behind an earlier copy', async () => {
    const repo = new Repo()
    repo.hand(bundle(1))
    expect((await intake.processIssue(1, repo.deps())).action).toBe('accepted')
    repo.hand(bundle(1))
    expect(await intake.processIssue(3, repo.deps())).toEqual({ action: 'rejected', code: 'duplicate' })
    expect(repo.posts()).toHaveLength(1)

    // two copies handed in at the same moment, the runs in the "wrong" order: the higher number loses
    const two = new Repo()
    two.hand(bundle(2))
    two.hand(bundle(2))
    expect(await intake.processIssue(2, two.deps())).toEqual({ action: 'rejected', code: 'duplicate' })
    expect((await intake.processIssue(1, two.deps())).action).toBe('accepted')
    expect(two.posts()).toHaveLength(1)

    // a "taken" note that does not carry the seal of the workflow does not count as taken (and cannot shut a bundle out)
    const forged = new Repo()
    forged.add('[묶음] x', `x\n<!-- teamhub-feedback-bundle:v1 ${bundle(3).bundleId} WXYZ-2345-6789 ${'0'.repeat(64)} -->\n`, ['처리됨'], { state: 'closed' })
    forged.hand(bundle(3))
    expect((await intake.processIssue(2, forged.deps())).action).toBe('accepted')
  })

  it('three bundles a day from one server PC; another server PC is not held back', async () => {
    const repo = new Repo()
    expect(intake.MAX_BUNDLES_PER_DAY).toBe(3)
    for (let n = 1; n <= 3; n++) {
      const i = repo.hand(bundle(n))
      expect((await intake.processIssue(i.number, repo.deps())).action).toBe('accepted')
      repo.clock += 3600_000
    }
    const fourth = repo.hand(bundle(4))
    expect(await intake.processIssue(fourth.number, repo.deps())).toEqual({ action: 'rejected', code: 'rate_limit' })
    const other = repo.hand(bundle(5, [item(5)], { serverId: 'AAAA-BBBB-CCCC' }))
    expect((await intake.processIssue(other.number, repo.deps())).action).toBe('accepted')
    repo.clock += DAY
    const next = repo.hand(bundle(6))
    expect((await intake.processIssue(next.number, repo.deps())).action).toBe('accepted')
  })

  it('items are checked one by one: wrong form, time, blocked PC and posts that exist already are left out and counted', async () => {
    const repo = new Repo()
    repo.hand(bundle(1, [item(1)]))
    await intake.processIssue(1, repo.deps())
    const text = canonicalBundle(
      bundle(2, [
        item(1), // posted by the earlier bundle
        item(2),
        item(2, { title: '같은 글을 한 번 더' }), // the same id twice in one bundle
        item(3, { createdAt: '2026-01-01T00:00:00.000Z' }), // older than 180 days
        item(4, { installId: 'BBBB-CCCC-DDDD' }), // a PC that was shut out
        item(5),
        item(6)
      ])
    ).replace(`"submissionId":"${uuid(5)}"`, '"submissionId":"not-a-uuid"')
    const i = repo.hand(text)
    const r = await intake.processIssue(i.number, repo.deps({ blocked: new Set(['BBBB-CCCC-DDDD']) }))
    expect(r).toEqual({ action: 'accepted', made: 2, before: 0, skipped: { bad_item: 1, item_time: 1, item_blocked: 1, item_duplicate: 2 } })
    expect(repo.posts().map((p) => p.title)).toEqual(['[오류신고] 자료실에서 큰 파일이 멈춥니다 1', '[오류신고] 자료실에서 큰 파일이 멈춥니다 2', '[오류신고] 자료실에서 큰 파일이 멈춥니다 6'])
    expect(repo.comments.get(i.number)![0]).toBe(
      ['묶음을 처리했습니다. 게시 2건, 제외 5건.', '- 제외 `bad_item` (형식이 다름): 1건', '- 제외 `item_time` (작성 시각이 허용 범위 밖): 1건', '- 제외 `item_blocked` (이용이 제한된 PC): 1건', '- 제외 `item_duplicate` (이미 게시된 글): 2건'].join('\n')
    )
    expect(repo.issues[i.number - 1]).toMatchObject({ state: 'closed', state_reason: 'completed' })

    // every item wrong: the bundle is still taken (the envelope was right), nothing is posted
    const none = repo.hand(canonicalBundle(bundle(3, [item(7)])).replace('"kind":"bug"', '"kind":"spam"'))
    expect(await intake.processIssue(none.number, repo.deps())).toMatchObject({ action: 'accepted', made: 0, skipped: { bad_item: 1 } })
  })

  it('a run that broke off half way is finished by the next one, without posting anything twice', async () => {
    const repo = new Repo()
    repo.hand(bundle(1, [item(1), item(2), item(3)]))
    repo.failCreateAt = 2
    await expect(intake.processIssue(1, repo.deps())).rejects.toThrow(/GitHub 403/)
    expect(repo.posts()).toHaveLength(1)
    expect(repo.issues[0].state).toBe('open') // still waiting: the daily run picks it up
    expect(repo.names(1)).toEqual(['접수'])
    expect(await intake.run({}, repo.deps())).toEqual([{ number: 1, action: 'accepted', made: 2, before: 1, skipped: { bad_item: 0, item_time: 0, item_blocked: 0, item_duplicate: 0 } }])
    expect(repo.posts().map((p) => p.title.slice(-1))).toEqual(['1', '2', '3'])
    expect(repo.comments.get(1)).toEqual(['묶음을 처리했습니다. 게시 3건, 제외 0건.'])
  })

  it('a bundle that came as a file: checked with the same rules, handed in once, taken by the same gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamhub-intake-'))
    try {
      const repo = new Repo()
      const good = join(dir, 'bundle.json')
      writeFileSync(good, `${canonicalBundle(bundle(1, [item(1), item(2)]))}\n`)
      expect(await intake.submitFile(good, repo.deps(), true)).toMatchObject({ ok: true, items: 2, skipped: 0 })
      expect(repo.issues).toHaveLength(0)
      expect(repo.calls).toEqual([]) // a dry run asks GitHub nothing

      const bad = join(dir, 'bad.json')
      writeFileSync(bad, JSON.stringify(bundle(1), null, 2))
      expect(await intake.submitFile(bad, repo.deps())).toEqual({ ok: false, code: 'not_compact' })
      writeFileSync(bad, canonicalBundle(bundle(1)).replace('"schema":1', '"schema":2'))
      expect(await intake.submitFile(bad, repo.deps())).toEqual({ ok: false, code: 'bad_format' })
      writeFileSync(bad, 'x'.repeat(70000))
      expect(await intake.submitFile(bad, repo.deps())).toEqual({ ok: false, code: 'too_large' })
      expect(await intake.submitFile(good, repo.deps({ blocked: new Set(['WXYZ-2345-6789']) }))).toEqual({ ok: false, code: 'blocked' })
      expect(repo.issues).toHaveLength(0)

      expect(await intake.submitFile(good, repo.deps())).toMatchObject({ ok: true, number: 1, items: 2 })
      expect(repo.issues[0]).toMatchObject({ title: intakeTitle(bundle(1).bundleId), body: intakeBody(canonicalBundle(bundle(1, [item(1), item(2)]))) })
      expect(repo.names(1)).toEqual(['접수'])
      expect(await intake.submitFile(good, repo.deps())).toMatchObject({ ok: true, number: 1, existed: true })
      expect(repo.issues).toHaveLength(1)
      expect(await intake.run({ action: 'opened', issue: { number: 1 } }, repo.deps())).toMatchObject([{ action: 'accepted', made: 2 }])
      expect(await intake.submitFile(good, repo.deps())).toMatchObject({ ok: true, number: 1, existed: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the list of shut-out PCs from the repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamhub-intake-'))
    try {
      expect(intake.readBlocked(dir)).toEqual(new Set())
      expect(intake.readBlocked(root)).toEqual(new Set(JSON.parse(readFileSync(join(root, 'site', 'feedback-blocked.json'), 'utf8')) as string[]))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('feedback board: only what the gate checked is shown', () => {
  it('shows the checked item, not the issue: a changed title, changed labels or a changed text do not reach the board', async () => {
    const repo = new Repo()
    repo.hand(bundle(1, [item(1, { author: '총무팀 김', app: { version: '1.7.2', os: 'Windows 10.0.26100' } }), item(2, { kind: 'feature', title: '<b>굵게</b> @admin', body: '<script>alert(1)</script>' })]))
    await intake.processIssue(1, repo.deps())
    const [a, b] = repo.posts()
    // somebody who can write issues (the key of the program) changes what people see on GitHub
    a.title = '[기능요청] 광고 https://spam.example'
    a.labels = [{ name: '기능요청' }, { name: '검증됨' }]
    a.body = a.body.replace('5GB 파일을 올리면 멈춥니다', '광고 문구')
    b.state = 'closed'
    b.state_reason = 'not_planned'
    b.closed_at = '2026-11-25T00:00:00.000Z'
    a.comments = 2
    const answersOf = async (): Promise<{ at: string; body: string }[]> => [{ at: '2026-11-25T00:00:00.000Z', body: '다음 버전에서 고칩니다.' }]
    const { items, unverifiable } = await board.boardItems(repo.issues, { sealKey: SEAL, answersOf })
    expect(unverifiable).toBe(0)
    expect(items).toEqual([
      { number: b.number, kind: 'feature', title: '<b>굵게</b> @admin', author: '익명', body: '<script>alert(1)</script>', receipt: 'TH-00000002', version: null, state: 'declined', createdAt: '2026-11-20T01:02:03.004Z', closedAt: '2026-11-25T00:00:00.000Z', answers: [] },
      { number: a.number, kind: 'bug', title: '자료실에서 큰 파일이 멈춥니다 1', author: '총무팀 김', body: '5GB 파일을 올리면 멈춥니다.', receipt: 'TH-00000001', version: 'TeamHub 1.7.2 · Windows 10.0.26100', state: 'answered', createdAt: '2026-11-20T01:02:03.004Z', closedAt: null, answers: [{ at: '2026-11-25T00:00:00.000Z', body: '다음 버전에서 고칩니다.' }] }
    ])
    // the unique value of a PC is never published
    expect(JSON.stringify(items)).not.toMatch(/ABCD-EFGH-JKLM|WXYZ-2345-6789/)
  })

  it('leaves out: no 검증됨 label, 비공개, a changed or missing item, a seal that is not the workflow\'s, a copy of a post', async () => {
    const repo = new Repo()
    repo.hand(bundle(1, [item(1), item(2), item(3)]))
    await intake.processIssue(1, repo.deps())
    const [a, b, c] = repo.posts()
    // an ordinary issue of a maintainer with the old labels
    repo.add('[오류신고] 손으로 쓴 이슈', '내용', ['오류신고'])
    // written directly with the key of the program: the right labels, a valid item - but no seal of the workflow
    const forged = lib.renderItemIssue(item(9, { title: '게이트를 거치지 않은 글' }), uuid(9, 'bbbbbbbbbbbb'), 'a-guessed-key')
    repo.add(forged.title, forged.body, forged.labels)
    const unsealed = lib.renderItemIssue(item(10, { title: '봉인 없는 글' }), uuid(9, 'bbbbbbbbbbbb'), '')
    repo.add(unsealed.title, unsealed.body, unsealed.labels)
    // the kept item of a real post changed afterwards (other text under the old seal)
    const other = lib.renderItemIssue(item(2, { body: '바꿔치기한 내용입니다.' }), uuid(1, 'bbbbbbbbbbbb'), '')
    b.body = b.body.replace(/<!-- teamhub-feedback:v1 \S+/, /<!-- teamhub-feedback:v1 \S+/.exec(other.body)![0])
    // a real post copied into a second issue
    repo.add(a.title, a.body, ['오류신고', '검증됨'])
    // hidden by the maintainer
    c.labels.push({ name: '비공개' })
    // the kept item removed
    repo.add('[오류신고] 흔적 없음', '**분류**: 오류신고', ['오류신고', '검증됨'])
    repo.add('[오류신고] 두 개', `${a.body}\n${a.body}`, ['오류신고', '검증됨'])

    const { items } = await board.boardItems(repo.issues, { sealKey: SEAL })
    expect(items.map((i) => [i.number, i.title])).toEqual([[a.number, '자료실에서 큰 파일이 멈춥니다 1']])

    // a run that has no key cannot tell real seals from forged ones: it says so instead of trusting
    const blind = await board.boardItems(repo.issues, { sealKey: '' })
    expect(blind.unverifiable).toBeGreaterThan(0)
    expect(blind.items.map((i) => i.title)).toEqual(['봉인 없는 글'])
  })
})

describe('feedback on GitHub: rules that must stay', () => {
  it('text of a user becomes harmless Markdown', () => {
    const n = lib.neutralise
    expect(n('@admin @한글 a@b.c')).toBe('@\u200Badmin @\u200B한글 a@\u200Bb\\.c')
    expect(n('#1 # 제목')).toBe('\\#\u200B1 \\# 제목')
    expect(n('<b>x</b> & y')).toBe('&lt;b&gt;x&lt;/b&gt; &amp; y')
    expect(n('`code` **bold** _i_ [a](b) ![i](u) ~~s~~ $x$')).toBe('\\`code\\` \\*\\*bold\\*\\* \\_i\\_ \\[a\\]\\(b\\) \\!\\[i\\]\\(u\\) \\~\\~s\\~\\~ \\$x\\$')
    expect(n('1. one\n- two\n> quote\n---\n    code\n\tcode')).toBe('1\\. one\n\\- two\n&gt; quote\n\\-\\-\\-\n&nbsp;&nbsp;&nbsp;&nbsp;code\n&nbsp;code')
    expect(n('http://a.b/c javascript:alert(1)')).toBe('http\\:\u200B//a\\.b/c javascript\\:alert\\(1\\)')
  })

  it('the workflow: no text of an issue in a shell line, own actions only, smallest permissions', () => {
    const yml = readFileSync(join(root, '.github', 'workflows', 'feedback-intake.yml'), 'utf8')
    const code = yml
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
    // the only thing taken from the event in the file is the number (for the concurrency group)
    expect(code.match(/\$\{\{[^}]*\}\}/g)).toEqual(["${{ github.event.issue.number || 'all' }}", '${{ github.token }}', '${{ secrets.FEEDBACK_SEAL_KEY }}'])
    expect(code.match(/^\s*run: .*$/gm)).toEqual(['        run: node scripts/feedback-intake.mjs'])
    expect(code).not.toContain('pull_request')
    expect(code.match(/uses: \S+/g)).toEqual(['uses: actions/checkout@v7', 'uses: actions/setup-node@v7'])
    expect(code).toContain('persist-credentials: false')
    expect(/\npermissions:\n((?: {2}\S.*\n)+)/.exec(code)![1]).toBe('  contents: read\n  issues: write\n')
    expect(code).toMatch(/issues:\n\s+types: \[opened, edited, reopened, labeled\]/)
    // the site is rebuilt after the gate ran, with the key that checks the seals
    const site = readFileSync(join(root, '.github', 'workflows', 'site.yml'), 'utf8')
    expect(site).toMatch(/workflow_run:\n\s+workflows: \[feedback-intake\]/)
    expect(site).toContain('FEEDBACK_SEAL_KEY: ${{ secrets.FEEDBACK_SEAL_KEY }}')
  })

  it('the scripts use Node itself only, and never run text as code', () => {
    for (const f of ['scripts/feedback-intake.mjs', 'scripts/build-feedback-board.mjs', 'scripts/lib/feedback-schema.mjs', 'scripts/lib/feedback-issue.mjs']) {
      const src = readFileSync(join(root, f), 'utf8')
      for (const m of src.matchAll(/from '([^']+)'/g)) expect(m[1].startsWith('node:') || m[1].startsWith('./')).toBe(true)
      expect(src).not.toMatch(/\beval\(|new Function\(|child_process|execSync|spawn\(/)
    }
  })

  it('the board page puts everything on the page as text', () => {
    const html = readFileSync(join(root, 'site', 'feedback.html'), 'utf8')
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
    expect(html).toContain('textContent')
    expect(html).toContain("u.protocol === 'https:' || u.protocol === 'http:'")
  })
})
