import { createVerify, generateKeyPairSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'

/**
 * A stand-in for api.github.com that checks what the real one checks: the signed one-time value
 * of the GitHub App, the temporary key it hands out, and that the key is given back.
 * Shared by the tests of the hand-over (tests/main/feedback.test.ts) and of the weekly job of
 * the server PC (tests/server/feedback.test.ts).
 */
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
export const FAKE_KEYS = { pem: pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), appId: '4242' }

export interface FakeIssue {
  number: number
  html_url: string
  title: string
  body: string
  labels?: string[]
}
export interface FakeGithub {
  url: string
  issues: FakeIssue[]
  live: Set<string>
  revoked: string[]
  /** temporary keys handed out */
  tokens: number
  rejectLabels: boolean
  dropAnswer: boolean
  /** answer every request for a key with this status */
  failAuth: number
  close: () => Promise<void>
}

export async function startFakeGithub(): Promise<FakeGithub> {
  const f: FakeGithub = { url: '', issues: [], live: new Set(), revoked: [], tokens: 0, rejectLabels: false, dropAnswer: false, failAuth: 0, close: async () => undefined }
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
        if (f.failAuth) return send(f.failAuth, { message: 'no' })
        // the one-time value: signed by the app's key, not expired, issued by the app
        const [h, p, s] = auth.split('.')
        const claims = JSON.parse(Buffer.from(p ?? '', 'base64url').toString() || '{}') as { iss?: string; exp?: number; iat?: number }
        const good = !!s && createVerify('RSA-SHA256').update(`${h}.${p}`).verify(pair.publicKey, Buffer.from(s, 'base64url'))
        if (!good || claims.iss !== FAKE_KEYS.appId || (claims.exp ?? 0) * 1000 < Date.now() || (claims.exp ?? 0) - (claims.iat ?? 0) > 600) return send(401, { message: 'bad jwt' })
        if (req.method === 'GET') return send(200, { id: 77 })
        if (req.url !== '/app/installations/77/access_tokens') return send(404)
        // the narrowest key: issues of this one repository
        if (JSON.stringify(body) !== JSON.stringify({ repositories: ['team-share-info'], permissions: { issues: 'write' } })) return send(422, { message: 'unexpected scope' })
        const token = `tmp-${++f.tokens}`
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
        const issue: FakeIssue = { number, html_url: `https://github.com/leondic1976/team-share-info/issues/${number}`, title: String(body.title), body: String(body.body), labels: body.labels as string[] | undefined }
        f.issues.push(issue)
        // "the issue was made but the answer never arrived"
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
