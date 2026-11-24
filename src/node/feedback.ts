import { PC_UID_RE } from '../shared/constants'
import { FEEDBACK_INTAKE_LABEL, intakeBody, intakeTitle, parseBundleText } from '../shared/schemas/feedback'
import { createDecipheriv, createHash, createSign, randomBytes, scryptSync } from 'node:crypto'

/**
 * Feature requests and bug reports are kept by the server PC of a team, which hands them to the
 * issue board of the app's GitHub repository once a week as one bundle (src/server/feedback.ts)
 * - without a GitHub login. The program acts as a GitHub App that may only read and write
 * issues of that one repository:
 *   1. a one-time value is made and signed for every hand-over (valid for a few minutes)
 *   2. GitHub checks it and hands out a temporary key (valid for an hour at most)
 *   3. the bundle is handed in with that key, and the key is revoked right away
 * Everything travels over HTTPS.
 *
 * What is handed in is a JSON document of a fixed shape (src/shared/schemas/feedback.ts) as an
 * issue with the intake label. Whether it is taken is decided on GitHub by a workflow of the
 * repository (scripts/feedback-intake.mjs), never by this program.
 *
 * The app's signing key is not in the repository: the build seals it into
 * resources/feedback.bin (scripts/build-feedback.mjs). Sealing keeps it out of plain sight,
 * it is not a vault - whoever takes the installer apart can get it, and then can do what
 * the app can do: write issues in this repository. Nothing else is reachable with it
 * (docs/feedback-submission.md lists what that means and how the key is replaced).
 */
export interface FeedbackCreds {
  appId: string
  privateKey: string
  installationId?: string
}

export interface FeedbackResult {
  number: number
  url: string
}

export const FEEDBACK_REPO = { owner: 'leondic1976', repo: 'team-share-info' }
export { FEEDBACK_LIMITS } from '../shared/schemas/feedback'

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

export class FeedbackError extends Error {
  constructor(
    message: string,
    /** The bundle may have been handed in although we got no answer (the next try looks for it first). */
    readonly unsure = false,
    /** GitHub could not be reached at all from this PC (no internet). */
    readonly offline = false
  ) {
    super(message)
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

interface Issue {
  number: number
  html_url: string
  title?: string
}

/**
 * Hand a bundle in to the issue board. `api` is https://api.github.com (tests pass their own).
 * Nothing that is not a bundle of the defined shape is sent. A bundle that is there already
 * (an earlier try whose answer was lost) is not handed in twice.
 * Throws FeedbackError with a message for the administrator.
 */
export async function submitBundle(creds: FeedbackCreds, text: string, opts: { api?: string; fetch?: Fetch; timeoutMs?: number } = {}): Promise<FeedbackResult> {
  const api = (opts.api ?? 'https://api.github.com').replace(/\/+$/, '')
  if (!/^https:\/\//.test(api) && !/^http:\/\/127\.0\.0\.1[:/]/.test(api)) throw new FeedbackError('보안 연결(HTTPS)이 아니어서 보내지 않았습니다.')
  const parsed = parseBundleText(text)
  if (!parsed.ok || parsed.skipped > 0) throw new FeedbackError('묶음이 정해진 형식이 아니어서 보내지 않았습니다.')
  const { bundleId } = parsed.value
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
      throw new FeedbackError('GitHub에 연결할 수 없습니다(서버 PC의 인터넷 연결을 확인하세요).', method === 'POST' && url.endsWith('/issues'), true)
    }
  }
  const refused = (r: Response, what: string): FeedbackError =>
    new FeedbackError(
      r.status === 401 || r.status === 403 || r.status === 404
        ? `${what}에 실패했습니다(${r.status}). 보내기 설정이 바뀌었을 수 있습니다. 서버 PC의 프로그램을 최신 버전으로 업데이트해 보세요.`
        : r.status === 429
          ? '요청이 많아 잠시 막혔습니다. 다음 시도에 다시 보냅니다.'
          : `${what}에 실패했습니다(${r.status}).`
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
    // handed in before (the answer got lost, or it was taken in already)?
    const title = intakeTitle(bundleId)
    const r0 = await call(key, 'GET', `${repo}/issues?state=all&sort=created&direction=desc&per_page=100`)
    const found = r0.ok ? ((await r0.json()) as Issue[]).find((i) => i.title === title || i.title === `[묶음] ${bundleId}`) : undefined
    if (found) return { number: found.number, url: found.html_url }
    // 3. the bundle: the JSON alone, with the intake label and nothing else
    const r = await call(key, 'POST', `${repo}/issues`, { title, body: intakeBody(text), labels: [FEEDBACK_INTAKE_LABEL] })
    if (r.status === 422) throw new FeedbackError('GitHub 쪽 접수 준비(라벨)가 끝나지 않았습니다. 프로그램 관리자(배포 담당)에게 알려 주세요.')
    if (!r.ok) throw refused(r, '전달')
    const made = (await r.json()) as Issue
    return { number: made.number, url: made.html_url }
  } finally {
    // the temporary key is not kept: it stops working now, not in an hour
    await call(key, 'DELETE', `${api}/installation/token`).catch(() => undefined)
  }
}
