import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FeedbackError, INSTALL_ID_RE, installIdFrom, openSealed, signedOnce, submitBundle, type FeedbackCreds } from '../../src/node/feedback'
import { canonicalBundle, intakeBody, intakeTitle, type FeedbackBundle } from '../../src/shared/schemas/feedback'
import { startFakeGithub, FAKE_KEYS, type FakeGithub } from '../server/fake-github'

const ROOT = resolve(import.meta.dirname, '../..')
const pem = FAKE_KEYS.pem
let creds: FeedbackCreds
let fake: FakeGithub | null = null

const bundle = (over: Partial<FeedbackBundle> = {}): FeedbackBundle => ({
  schema: 1,
  type: 'bundle',
  bundleId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  serverId: installIdFrom({ mac: 'AA:BB:CC:DD:EE:FF', lanIp: '192.168.0.10', wanIp: '' }),
  period: { from: '2026-11-17T00:00:00.000Z', to: '2026-11-24T00:00:00.000Z' },
  createdAt: '2026-11-24T00:00:01.000Z',
  app: { version: '1.7.2' },
  items: [{ kind: 'bug', title: '자료실에서 큰 파일이 멈춥니다', body: '5GB 파일을 올리면 멈춥니다. @someone 확인 부탁', author: '', installId: 'ABCD-EFGH-JKLM', submissionId: '3f2b8c1e-9a4d-4e6f-8b1a-0c2d3e4f5a6b', createdAt: '2026-11-20T01:02:03.004Z' }],
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

describe('feedback: handing a bundle to GitHub', () => {
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

  it('checked one-time value -> temporary key -> an intake issue with the JSON alone -> key revoked', async () => {
    fake = await startFakeGithub()
    const b = bundle()
    const text = canonicalBundle(b)
    const r = await submitBundle({ ...creds, installationId: '77' }, text, { api: fake.url })
    expect(r).toEqual({ number: 1, url: 'https://github.com/leondic1976/team-share-info/issues/1' })
    const made = fake.issues[0]
    // the program does not write the post: a neutral title, the JSON alone, the intake label only
    expect(made.title).toBe(intakeTitle(b.bundleId))
    expect(made.title).toBe('[접수] 7c9e6679-7425-40de-944b-e07fc1f90ae7')
    expect(made.body).toBe(intakeBody(text))
    expect(made.body).toBe(`\`\`\`json\n${text}\n\`\`\`\n`)
    expect(made.labels).toEqual(['접수'])
    expect(made.body).not.toMatch(/192\.168|203\.0|AA:BB/i)
    // the temporary key does not outlive the hand-over
    expect(fake.revoked).toEqual(['tmp-1'])
    expect(fake.live.size).toBe(0)
  })

  it('finds the installation by itself; a bundle that is there already is not handed in twice', async () => {
    fake = await startFakeGithub()
    fake.dropAnswer = true
    const text = canonicalBundle(bundle())
    // "the issue was made but the answer never arrived"
    const first = await submitBundle(creds, text, { api: fake.url }).catch((e: unknown) => e)
    expect(first).toBeInstanceOf(FeedbackError)
    expect((first as FeedbackError).unsure).toBe(true)
    fake.dropAnswer = false
    const again = await submitBundle(creds, text, { api: fake.url })
    expect(again.number).toBe(1)
    expect(fake.issues).toHaveLength(1)
    // also after the workflow took it in and gave it another title
    fake.issues[0].title = '[묶음] 7c9e6679-7425-40de-944b-e07fc1f90ae7'
    expect((await submitBundle(creds, text, { api: fake.url })).number).toBe(1)
    expect(fake.issues).toHaveLength(1)
    expect(fake.live.size).toBe(0)
  })

  it('refuses to send what is not a bundle of the defined form', async () => {
    fake = await startFakeGithub()
    const good = canonicalBundle(bundle())
    for (const bad of [
      '{}',
      'not json',
      JSON.stringify(JSON.parse(good), null, 2),
      good.replace('"type":"bundle"', '"type":"bundle","orgName":"테스트기관"'),
      // one wrong item: this program made it, so nothing is sent rather than a part
      good.replace('"installId":"ABCD-EFGH-JKLM"', '"installId":"192.168.0.10"'),
      canonicalBundle(bundle({ items: [] }))
    ])
      await expect(submitBundle(creds, bad, { api: fake.url })).rejects.toThrow(/정해진 형식이 아니어서/)
    expect(fake.issues).toHaveLength(0)
    expect(fake.tokens).toBe(0) // not even a key was asked for
  })

  it('refuses: a key GitHub does not know, a connection that is not HTTPS, no label on the board, no internet', async () => {
    fake = await startFakeGithub()
    const text = canonicalBundle(bundle())
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    await expect(submitBundle({ appId: '4242', privateKey: other }, text, { api: fake.url })).rejects.toThrow(/인증에 실패/)
    await expect(submitBundle(creds, text, { api: 'http://example.com' })).rejects.toThrow(/HTTPS/)
    fake.rejectLabels = true
    await expect(submitBundle(creds, text, { api: fake.url })).rejects.toThrow(/접수 준비/)
    expect(fake.issues).toHaveLength(0)
    expect(fake.live.size).toBe(0)
    const off = await submitBundle(creds, text, { api: 'http://127.0.0.1:9', timeoutMs: 3000 }).catch((e: unknown) => e)
    expect(off).toBeInstanceOf(FeedbackError)
    expect((off as FeedbackError).offline).toBe(true)
  })

  it('the one-time value is different every time and short-lived', () => {
    const a = signedOnce(creds)
    expect(signedOnce(creds)).not.toBe(a)
    const claims = JSON.parse(Buffer.from(a.split('.')[1], 'base64url').toString()) as { exp: number; iat: number; iss: string }
    expect(claims.iss).toBe('4242')
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
  })
})
