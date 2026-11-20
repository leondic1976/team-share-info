import { describe, it, expect, afterEach } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTestServer, type TestServer } from './helpers'

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const IP = '192.168.10.20'
const post = { id: 'TH-ABCDEFGH', kind: 'bug', title: '인터넷 없는 PC에서 보냄', body: '서버 PC를 거쳐 게시판에 올라가야 합니다.', author: '', environment: 'TeamHub test', installId: 'ABCD-EFGH-JKLM' }

let s: TestServer | null = null
let github: Server | null = null
afterEach(async () => {
  await s?.close()
  s = null
  await new Promise((r) => (github ? github.close(r) : r(null)))
  github = null
})

/** Just enough of api.github.com: hands out a key, takes issues, counts them. */
async function fakeGithub(): Promise<{ url: string; issues: { title: string; body: string }[] }> {
  const issues: { title: string; body: string }[] = []
  github = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const send = (status: number, body?: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(body === undefined ? '' : JSON.stringify(body))
      }
      if (req.method === 'POST' && req.url === '/app/installations/77/access_tokens') return send(201, { token: 'tmp' })
      if (req.method === 'POST' && req.url?.endsWith('/issues')) {
        issues.push(JSON.parse(raw))
        return send(201, { number: issues.length, html_url: `https://example/${issues.length}` })
      }
      if (req.method === 'DELETE') return send(204)
      send(404)
    })
  })
  await new Promise<void>((r) => github!.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(github.address() as AddressInfo).port}`, issues }
}

describe('feedback relay: a member PC without internet posts through the server PC', () => {
  it('says whether the server can pass posts on', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    expect((await s.req(b, { method: 'GET', url: '/api/feedback/relay', ip: IP })).json().data).toEqual({ available: false })
    expect((await s.req(b, { method: 'POST', url: '/api/feedback/relay', ip: IP, payload: post })).statusCode).toBe(400)
    s.ctx.feedback = { creds: { appId: '4242', privateKey: pem, installationId: '77' }, api: 'http://127.0.0.1:1', site: null }
    expect((await s.req(b, { method: 'GET', url: '/api/feedback/relay', ip: IP })).json().data).toEqual({ available: true })
    expect((await s.req(null, { method: 'GET', url: '/api/feedback/relay', ip: IP })).statusCode).toBe(401)
  })

  it('posts for the member, keeps the unique value of the member PC, and limits posts per day', async () => {
    const gh = await fakeGithub()
    s = await createTestServer()
    const b = await s.join('B')
    s.ctx.feedback = { creds: { appId: '4242', privateKey: pem, installationId: '77' }, api: gh.url, site: null }
    const r = await s.req(b, { method: 'POST', url: '/api/feedback/relay', ip: IP, payload: post })
    expect(r.json().data).toEqual({ ok: true, number: 1 })
    expect(gh.issues[0].title).toContain('인터넷 없는 PC에서 보냄')
    expect(gh.issues[0].body).toContain('고유값 ABCD-EFGH-JKLM')
    expect(gh.issues[0].body).toContain('접수번호 TH-ABCDEFGH')
    // malformed posts never leave the server
    expect((await s.req(b, { method: 'POST', url: '/api/feedback/relay', ip: IP, payload: { ...post, installId: 'x' } })).statusCode).toBe(400)
    for (let i = 0; i < 9; i++) expect((await s.req(b, { method: 'POST', url: '/api/feedback/relay', ip: IP, payload: post })).json().data.ok).toBe(true)
    expect((await s.req(b, { method: 'POST', url: '/api/feedback/relay', ip: IP, payload: post })).statusCode).toBe(400)
    expect(gh.issues).toHaveLength(10)
  })

  it('tells the member when the server PC has no internet either', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    s.ctx.feedback = { creds: { appId: '4242', privateKey: pem, installationId: '77' }, api: 'http://127.0.0.1:1', site: null }
    const d = (await s.req(b, { method: 'POST', url: '/api/feedback/relay', ip: IP, payload: post })).json().data
    expect(d.ok).toBe(false)
    expect(d.error).toContain('서버 PC도 인터넷')
  })
})
