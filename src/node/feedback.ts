import { PC_UID_RE } from '../shared/constants'
import { createDecipheriv, createHash, createSign, randomBytes, scryptSync } from 'node:crypto'

/**
 * Feature requests and bug reports go to the GitHub issue board of the app's repository
 * without a GitHub login on the user's PC. The app acts as a GitHub App that may only
 * read and write issues of that one repository:
 *   1. a one-time value is made and signed for every post (valid for a few minutes)
 *   2. GitHub checks it and hands out a temporary key (valid for an hour at most)
 *   3. the post is created with that key, and the key is revoked right away
 * Everything travels over HTTPS.
 *
 * The app's signing key is not in the repository: the build seals it into
 * resources/feedback.bin (scripts/build-feedback.mjs). Sealing keeps it out of plain sight,
 * it is not a vault - whoever takes the installer apart can get it, and then can do what
 * the app can do: write issues in this repository. Nothing else is reachable with it.
 */
export interface FeedbackCreds {
  appId: string
  privateKey: string
  installationId?: string
}

export type FeedbackKind = 'feature' | 'bug'

export interface FeedbackInput {
  /** Receipt number of this post (TH-XXXXXXXX); a repeated send with the same one is not posted twice. */
  id: string
  kind: FeedbackKind
  title: string
  body: string
  /** Shown as the writer; empty = 익명. */
  author: string
  /** "TeamHub 1.2.1 · Windows 10.0.26100" or '' when the writer chose not to send it. */
  environment: string
  /** The value that stands for the writer's PC (see installIdFrom); never an address. */
  installId: string
  /** A former try with this id may have reached GitHub: look for it before posting. */
  retry?: boolean
}

export interface FeedbackResult {
  number: number
  url: string
}

export const FEEDBACK_REPO = { owner: 'leondic1976', repo: 'team-share-info' }
export const FEEDBACK_LABELS: Record<FeedbackKind, string> = { feature: '기능요청', bug: '오류신고' }
export const FEEDBACK_LIMITS = { titleMin: 2, titleMax: 100, bodyMin: 5, bodyMax: 5000, authorMax: 30 }

const MAGIC = Buffer.from('THFB1')
// scripts/build-feedback.mjs seals with the same words
const SEAL_WORDS = ['teamhub', 'feedback', 'board', 'seal', 'v1']

/** Open resources/feedback.bin; null when it is missing, damaged or holds no key. */
export function openSealed(buf: Buffer | null | undefined): FeedbackCreds | null {
  try {
    if (!buf || buf.length < MAGIC.length + 16 + 12 + 16 + 2 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) return null
    let o = MAGIC.length
    const salt = buf.subarray(o, (o += 16))
    const iv = buf.subarray(o, (o += 12))
    const tag = buf.subarray(o, (o += 16))
    const d = createDecipheriv('aes-256-gcm', scryptSync(SEAL_WORDS.join(':'), salt, 32), iv)
    d.setAuthTag(tag)
    const c = JSON.parse(Buffer.concat([d.update(buf.subarray(o)), d.final()]).toString('utf8')) as Partial<FeedbackCreds>
    if (!c.appId || !c.privateKey?.includes('PRIVATE KEY')) return null
    return { appId: String(c.appId), privateKey: c.privateKey, installationId: c.installationId ? String(c.installationId) : undefined }
  } catch {
    return null
  }
}

export function newFeedbackId(): string {
  // no 0/O/1/I: the number is read out and typed by people
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return `TH-${[...randomBytes(8)].map((b) => abc[b % abc.length]).join('')}`
}

export const INSTALL_ID_RE = PC_UID_RE

/**
 * The value that stands for one installed PC on the board. It is made once from the PC's
 * network card address (MAC), its address in the office network and its address on the
 * internet, mixed with random bytes and hashed: the same PC keeps one value, and nobody
 * can work the addresses out of it (the board is public).
 */
export function installIdFrom(parts: { mac: string; lanIp: string; wanIp: string }, random: Buffer = randomBytes(16)): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const h = createHash('sha256').update([parts.mac.toLowerCase(), parts.lanIp, parts.wanIp, random.toString('hex')].join('|')).digest()
  const c = [...h.subarray(0, 12)].map((b) => abc[b % abc.length]).join('')
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url')

/** The one-time signed value GitHub checks (a JWT, RS256). It cannot be used after five minutes. */
export function signedOnce(creds: FeedbackCreds, now = Date.now()): string {
  const t = Math.floor(now / 1000)
  // iat a little in the past: PC clocks are rarely exact
  const head = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ iat: t - 60, exp: t + 300, iss: creds.appId, jti: randomBytes(12).toString('hex') }))}`
  return `${head}.${b64u(createSign('RSA-SHA256').update(head).sign(creds.privateKey))}`
}

/** No notifications to people named in a post, and no control characters. */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from text typed by users
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/@(?=[A-Za-z0-9])/g, '@​')
}

export function marker(id: string): string {
  return `<!-- teamhub-feedback:${id} -->`
}

export function issueOf(input: FeedbackInput): { title: string; body: string; labels: string[] } {
  const label = FEEDBACK_LABELS[input.kind]
  const author = clean(input.author).trim().slice(0, FEEDBACK_LIMITS.authorMax) || '익명'
  const foot = [input.environment.trim(), `고유값 ${input.installId}`, `접수번호 ${input.id}`].filter(Boolean).join(' · ')
  return {
    title: `[${label}] ${clean(input.title).replace(/\s+/g, ' ').trim().slice(0, FEEDBACK_LIMITS.titleMax)}`,
    body: `**분류**: ${label}\n**작성자**: ${author}\n\n${clean(input.body).trim().slice(0, FEEDBACK_LIMITS.bodyMax)}\n\n---\n${foot}\n${marker(input.id)}\n`,
    labels: [label]
  }
}

export class FeedbackError extends Error {
  constructor(
    message: string,
    /** The post may have been created although we got no answer. */
    readonly unsure = false
  ) {
    super(message)
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

interface Issue {
  number: number
  html_url: string
  body?: string | null
}

/**
 * Post to the issue board. `api` is https://api.github.com (tests pass their own).
 * Throws FeedbackError with a message for the user.
 */
export async function submitFeedback(creds: FeedbackCreds, input: FeedbackInput, opts: { api?: string; fetch?: Fetch; timeoutMs?: number } = {}): Promise<FeedbackResult> {
  const api = (opts.api ?? 'https://api.github.com').replace(/\/+$/, '')
  if (!/^https:\/\//.test(api) && !/^http:\/\/127\.0\.0\.1[:/]/.test(api)) throw new FeedbackError('보안 연결(HTTPS)이 아니어서 보내지 않았습니다.')
  if (!INSTALL_ID_RE.test(input.installId)) throw new FeedbackError('이 PC의 고유값을 확인할 수 없어 보내지 않았습니다.')
  const doFetch = opts.fetch ?? fetch
  const repo = `${api}/repos/${FEEDBACK_REPO.owner}/${FEEDBACK_REPO.repo}`
  const call = async (auth: string, method: string, url: string, body?: unknown): Promise<Response> => {
    try {
      return await doFetch(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'TeamHub-feedback',
          Authorization: `Bearer ${auth}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20000)
      })
    } catch {
      throw new FeedbackError('GitHub에 연결할 수 없습니다. 인터넷 연결을 확인하고 다시 보내 주세요.', method === 'POST' && url.endsWith('/issues'))
    }
  }
  const refused = (r: Response, what: string): FeedbackError =>
    new FeedbackError(
      r.status === 401 || r.status === 403 || r.status === 404
        ? `${what}에 실패했습니다(${r.status}). 프로그램을 최신 버전으로 업데이트한 뒤 다시 시도해 주세요.`
        : r.status === 429
          ? '요청이 많아 잠시 막혔습니다. 몇 분 뒤 다시 보내 주세요.'
          : `${what}에 실패했습니다(${r.status}). 잠시 뒤 다시 보내 주세요.`
    )

  // 1. the one-time signed value -> 2. GitHub checks it and hands out a temporary key
  const once = signedOnce(creds)
  let installation = creds.installationId
  if (!installation) {
    const r = await call(once, 'GET', `${repo}/installation`)
    if (!r.ok) throw refused(r, '인증')
    installation = String(((await r.json()) as { id: number }).id)
  }
  const tr = await call(once, 'POST', `${api}/app/installations/${installation}/access_tokens`, { repositories: [FEEDBACK_REPO.repo], permissions: { issues: 'write' } })
  if (!tr.ok) throw refused(tr, '인증')
  const key = ((await tr.json()) as { token: string }).token
  try {
    if (input.retry) {
      const r = await call(key, 'GET', `${repo}/issues?state=all&sort=created&direction=desc&per_page=50`)
      const found = r.ok ? ((await r.json()) as Issue[]).find((i) => i.body?.includes(marker(input.id))) : undefined
      if (found) return { number: found.number, url: found.html_url }
    }
    // 3. the post
    const issue = issueOf(input)
    let r = await call(key, 'POST', `${repo}/issues`, issue)
    // a label that does not exist on the board must not lose the post
    if (r.status === 422) r = await call(key, 'POST', `${repo}/issues`, { title: issue.title, body: issue.body })
    if (!r.ok) throw refused(r, '등록')
    const made = (await r.json()) as Issue
    return { number: made.number, url: made.html_url }
  } finally {
    // the temporary key is not kept: it stops working now, not in an hour
    await call(key, 'DELETE', `${api}/installation/token`).catch(() => undefined)
  }
}
