import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './helpers'
import { pruneIdempotency } from '../../src/server/idempotency'
import { seal, unseal, isSealed } from '../../src/node/seal'
import { randomBytes } from 'node:crypto'

describe('idempotency key (outbox of a PC that was offline)', () => {
  let s: TestServer
  beforeEach(async () => {
    s = await createTestServer()
  })
  afterEach(async () => {
    await s.close()
  })

  const memo = (cred: TestServer['admin'], key?: string) =>
    s.req(cred, { method: 'POST', url: '/api/shared-memos', payload: { body: 'offline memo', color: 'yellow', scope: { type: 'team' } }, headers: key ? { 'x-idempotency-key': key } : {} })
  const count = async (): Promise<number> => ((await s.req(s.admin, { method: 'GET', url: '/api/shared-memos' })).json() as { data: unknown[] }).data.length

  it('the same key from the same member is answered again, not done twice', async () => {
    const key = '11111111-2222-4333-8444-555555555555'
    const a = await memo(s.admin, key)
    expect(a.statusCode).toBe(200)
    const b = await memo(s.admin, key)
    expect(b.statusCode).toBe(200)
    expect(b.headers['x-idempotent-replay']).toBe('1')
    expect(b.json()).toEqual(a.json())
    expect(await count()).toBe(1)
  })

  it('without a key, or with another key, the change is done each time', async () => {
    await memo(s.admin)
    await memo(s.admin)
    await memo(s.admin, 'aaaaaaaa-2222-4333-8444-555555555555')
    await memo(s.admin, 'bbbbbbbb-2222-4333-8444-555555555555')
    expect(await count()).toBe(4)
  })

  it('a key is the member\'s own: another member with the same key is not answered from the store', async () => {
    const key = 'cccccccc-2222-4333-8444-555555555555'
    const other = await s.join('kim')
    await memo(s.admin, key)
    const r = await memo(other, key)
    expect(r.headers['x-idempotent-replay']).toBeUndefined()
    expect(await count()).toBe(2)
  })

  it('a failed request is not remembered, and a replay still needs a valid login', async () => {
    const key = 'dddddddd-2222-4333-8444-555555555555'
    const bad = await s.req(s.admin, { method: 'POST', url: '/api/shared-memos', payload: {}, headers: { 'x-idempotency-key': key } })
    expect(bad.statusCode).toBeGreaterThanOrEqual(400)
    expect((await memo(s.admin, key)).headers['x-idempotent-replay']).toBeUndefined()
    const noLogin = await s.req(null, { method: 'POST', url: '/api/shared-memos', payload: {}, headers: { 'x-idempotency-key': key } })
    expect(noLogin.statusCode).toBe(401)
  })

  it('old keys are removed', async () => {
    const key = 'eeeeeeee-2222-4333-8444-555555555555'
    await memo(s.admin, key)
    pruneIdempotency(s.ctx, Date.now() + 31 * 86400_000)
    expect((await memo(s.admin, key)).headers['x-idempotent-replay']).toBeUndefined()
  })

  it('hello tells the PC that the server knows the key', async () => {
    const h = (await s.req(null, { method: 'GET', url: '/api/hello' })).json() as { data: { caps?: string[] } }
    expect(h.data.caps).toContain('idem')
  })
})

describe('seal (team data kept on a PC)', () => {
  it('round trip, and nothing readable without the key', () => {
    const key = randomBytes(32)
    const sealed = seal(key, '회의 자료 초안 — 김주무관')
    expect(isSealed(sealed)).toBe(true)
    expect(sealed).not.toContain('회의')
    expect(unseal(key, sealed)).toBe('회의 자료 초안 — 김주무관')
    expect(unseal(randomBytes(32), sealed)).toBeNull()
    expect(unseal(key, sealed.slice(0, -4) + 'AAAA')).toBeNull()
    expect(unseal(key, 'plain text from an older version')).toBeNull()
  })
})
