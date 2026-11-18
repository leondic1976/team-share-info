import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FeedbackError, INSTALL_ID_RE, installIdFrom, issueOf, marker, newFeedbackId, openSealed, signedOnce, submitFeedback, type FeedbackCreds, type FeedbackInput } from '../../src/node/feedback'

const ROOT = resolve(import.meta.dirname, '../..')
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
let creds: FeedbackCreds

/** A stand-in for api.github.com that checks what the real one checks. */
interface Fake {
  url: string
  issues: { number: number; html_url: string; title: string; body: string; labels?: string[] }[]
  live: Set<string>
  revoked: string[]
  rejectLabels: boolean
  dropAnswer: boolean
  close: () => Promise<void>
}
let fake: Fake | null = null

async function startFake(): Promise<Fake> {
  const f: Fake = { url: '', issues: [], live: new Set(), revoked: [], rejectLabels: false, dropAnswer: false, close: async () => undefined }
  let n = 0
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const send = (status: number, body?: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(body === undefined ? '' : JSON.stringify(body))
      }
      const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      if (req.url?.startsWith('/app/installations/') || req.url === '/repos/leondic1976/team-share-info/installation') {
        // the one-time value: signed by the app's key, not expired, issued by the app
        const [h, p, s] = auth.split('.')
        const claims = JSON.parse(Buffer.from(p ?? '', 'base64url').toString() || '{}') as { iss?: string; exp?: number; iat?: number }
        const good = !!s && createVerify('RSA-SHA256').update(`${h}.${p}`).verify(pair.publicKey, Buffer.from(s, 'base64url'))
        if (!good || claims.iss !== '4242' || (claims.exp ?? 0) * 1000 < Date.now() || (claims.exp ?? 0) - (claims.iat ?? 0) > 600) return send(401, { message: 'bad jwt' })
        if (req.method === 'GET') return send(200, { id: 77 })
        if (req.url !== '/app/installations/77/access_tokens') return send(404)
        expect(body).toEqual({ repositories: ['team-share-info'], permissions: { issues: 'write' } })
        const token = `tmp-${++n}`
        f.live.add(token)
        return send(201, { token })
      }
      if (!f.live.has(auth)) return send(401, { message: 'bad token' })
      if (req.method === 'DELETE' && req.url === '/installation/token') {
        f.live.delete(auth)
        f.revoked.push(auth)
        return send(204)
      }
      if (req.method === 'GET' && req.url?.startsWith('/repos/leondic1976/team-share-info/issues?')) return send(200, [...f.issues].reverse())
      if (req.method === 'POST' && req.url === '/repos/leondic1976/team-share-info/issues') {
        if (f.rejectLabels && body.labels) return send(422, { message: 'Validation Failed' })
        const number = f.issues.length + 1
        const issue = { number, html_url: `https://github.com/leondic1976/team-share-info/issues/${number}`, title: String(body.title), body: String(body.body), labels: body.labels as string[] | undefined }
        f.issues.push(issue)
        // "the post was made but the answer never arrived"
        if (f.dropAnswer) return void res.destroy()
        return send(201, issue)
      }
      send(404)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const a = server.address()
  f.url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
  f.close = () =>
    new Promise((r) => {
      server.closeAllConnections()
      server.close(() => r())
    })
  return f
}

const input = (over: Partial<FeedbackInput> = {}): FeedbackInput => ({
  id: newFeedbackId(),
  kind: 'bug',
  title: '자료실에서  큰 파일이\n멈춥니다',
  body: '5GB 파일을 올리면 멈춥니다. @someone 확인 부탁',
  author: '',
  environment: 'TeamHub 1.2.1 · Windows 10.0.26100',
  installId: installIdFrom({ mac: 'AA:BB:CC:DD:EE:FF', lanIp: '192.168.0.10', wanIp: '203.0.113.7' }),
  ...over
})

beforeAll(() => {
  // the build seals the key; the app opens it
  const dir = mkdtempSync(join(tmpdir(), 'teamhub-fb-'))
  const out = join(dir, 'feedback.bin')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-feedback.mjs'), out], { env: { ...process.env, FEEDBACK_APP_ID: '4242', FEEDBACK_APP_KEY: Buffer.from(pem).toString('base64') } })
  const sealed = readFileSync(out)
  creds = openSealed(sealed)!
  expect(creds).toMatchObject({ appId: '4242', privateKey: pem })
  expect(sealed.includes(Buffer.from('PRIVATE KEY'))).toBe(false) // not readable in the file
  const broken = Buffer.from(sealed)
  broken[broken.length - 1] ^= 1
  expect(openSealed(broken)).toBeNull()
  expect(openSealed(Buffer.from('nothing'))).toBeNull()
  rmSync(dir, { recursive: true, force: true })
})

afterEach(async () => {
  await fake?.close()
  fake = null
})

describe('feedback board', () => {
  it('the unique value of a PC: stable form, different per PC, addresses not in it', () => {
    const parts = { mac: 'AA:BB:CC:DD:EE:FF', lanIp: '192.168.0.10', wanIp: '203.0.113.7' }
    const salt = Buffer.alloc(16, 7)
    const id = installIdFrom(parts, salt)
    expect(id).toMatch(INSTALL_ID_RE)
    expect(installIdFrom({ ...parts, mac: 'aa:bb:cc:dd:ee:ff' }, salt)).toBe(id)
    expect(installIdFrom({ ...parts, mac: 'AA:BB:CC:DD:EE:00' }, salt)).not.toBe(id)
    expect(installIdFrom({ ...parts, lanIp: '192.168.0.11' }, salt)).not.toBe(id)
    expect(installIdFrom({ ...parts, wanIp: '203.0.113.8' }, salt)).not.toBe(id)
    // two installs on the very same PC and addresses still differ (random part)
    expect(installIdFrom(parts)).not.toBe(installIdFrom(parts))
  })

  it('a post: checked one-time value -> temporary key -> issue -> key revoked', async () => {
    fake = await startFake()
    const req = input()
    const r = await submitFeedback({ ...creds, installationId: '77' }, req, { api: fake.url })
    expect(r).toEqual({ number: 1, url: 'https://github.com/leondic1976/team-share-info/issues/1' })
    const made = fake.issues[0]
    expect(made.title).toBe('[오류신고] 자료실에서 큰 파일이 멈춥니다')
    expect(made.labels).toEqual(['오류신고'])
    expect(made.body).toContain('**작성자**: 익명')
    expect(made.body).toContain(`고유값 ${req.installId}`)
    expect(made.body).toContain(`접수번호 ${req.id}`)
    expect(made.body).toContain(marker(req.id))
    expect(made.body).not.toContain('@someone') // nobody is notified by a post
    expect(made.body).not.toMatch(/192\.168|203\.0|AA:BB/i)
    // the temporary key does not outlive the post
    expect(fake.revoked).toEqual(['tmp-1'])
    expect(fake.live.size).toBe(0)
  })

  it('finds the installation by itself, and posts without the label when the board has none', async () => {
    fake = await startFake()
    fake.rejectLabels = true
    const r = await submitFeedback(creds, input({ kind: 'feature', author: '총무팀 김' }), { api: fake.url })
    expect(r.number).toBe(1)
    expect(fake.issues[0].labels).toBeUndefined()
    expect(fake.issues[0].title.startsWith('[기능요청] ')).toBe(true)
    expect(fake.issues[0].body).toContain('**작성자**: 총무팀 김')
  })

  it('no answer after posting: sending again does not make a second post', async () => {
    fake = await startFake()
    fake.dropAnswer = true
    const req = input()
    const first = await submitFeedback(creds, req, { api: fake.url }).catch((e: unknown) => e)
    expect(first).toBeInstanceOf(FeedbackError)
    expect((first as FeedbackError).unsure).toBe(true)
    fake.dropAnswer = false
    const again = await submitFeedback(creds, { ...req, retry: true }, { api: fake.url })
    expect(again.number).toBe(1)
    expect(fake.issues).toHaveLength(1)
  })

  it('refuses: a key GitHub does not know, a missing unique value, a connection that is not HTTPS', async () => {
    fake = await startFake()
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    await expect(submitFeedback({ appId: '4242', privateKey: other }, input(), { api: fake.url })).rejects.toThrow(/인증에 실패/)
    await expect(submitFeedback(creds, input({ installId: 'nope' }), { api: fake.url })).rejects.toThrow(/고유값/)
    await expect(submitFeedback(creds, input(), { api: 'http://example.com' })).rejects.toThrow(/HTTPS/)
    expect(fake.issues).toHaveLength(0)
    await expect(submitFeedback(creds, input(), { api: 'http://127.0.0.1:9', timeoutMs: 3000 })).rejects.toThrow(/연결할 수 없습니다/)
  })

  it('the one-time value is different every time and short-lived', () => {
    const a = signedOnce(creds)
    expect(signedOnce(creds)).not.toBe(a)
    const claims = JSON.parse(Buffer.from(a.split('.')[1], 'base64url').toString()) as { exp: number; iat: number; iss: string }
    expect(claims.iss).toBe('4242')
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
    expect(issueOf(input({ title: 'x'.repeat(300) })).title.length).toBeLessThanOrEqual(110)
  })
})
