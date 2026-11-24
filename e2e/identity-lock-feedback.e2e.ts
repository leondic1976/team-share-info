import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47893'
const ROOT = resolve(import.meta.dirname, '..')
const UID = /[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/

/** Stand-in for api.github.com: checks the signed one-time value and keeps what was posted. */
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const posted: { title: string; body: string; labels?: string[] }[] = []
const revoked: string[] = []
let github: Server
let githubUrl = ''
const work = mkdtempSync(join(tmpdir(), 'teamhub-e2e-fb-'))
const sealed = join(work, 'feedback.bin')

beforeAll(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-feedback.mjs'), sealed], {
    env: { ...process.env, FEEDBACK_APP_ID: '777', FEEDBACK_APP_KEY: Buffer.from(pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()).toString('base64'), FEEDBACK_INSTALLATION_ID: '5' }
  })
  github = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const send = (status: number, body?: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(body === undefined ? '' : JSON.stringify(body))
      }
      const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      if (req.url === '/app/installations/5/access_tokens') {
        const [h, p, sig] = auth.split('.')
        const ok = !!sig && createVerify('RSA-SHA256').update(`${h}.${p}`).verify(pair.publicKey, Buffer.from(sig, 'base64url'))
        return ok ? send(201, { token: 'tmp-key' }) : send(401)
      }
      if (auth !== 'tmp-key' || revoked.length) return send(401)
      if (req.method === 'DELETE' && req.url === '/installation/token') {
        revoked.push(auth)
        return send(204)
      }
      if (req.method === 'POST' && req.url === '/repos/leondic1976/team-share-info/issues') {
        posted.push(JSON.parse(raw) as (typeof posted)[number])
        return send(201, { number: 12, html_url: 'https://github.com/leondic1976/team-share-info/issues/12' })
      }
      send(404)
    })
  })
  await new Promise<void>((r) => github.listen(0, '127.0.0.1', r))
  const a = github.address()
  githubUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
})

const settingsOf = async (p: Page): Promise<void> => {
  await go(p, '/settings')
  await p.getByTestId('pc-identity').waitFor({ timeout: 15000 })
}

describe('PC identity, fixed role, blocks, program lock and feedback', () => {
  let a: Launched
  let b: Launched
  const envA = (): Record<string, string> => ({ TEAMHUB_E2E_FEEDBACK_API: githubUrl, TEAMHUB_E2E_FEEDBACK_FILE: sealed })

  afterAll(async () => {
    await b?.close()
    await a?.close()
    await new Promise<void>((r) => {
      github.closeAllConnections()
      github.close(() => r())
    })
    rmSync(work, { recursive: true, force: true })
  })

  it('each PC has a unique value and a fixed role; switching server/member PC is gone', async () => {
    a = await launch({ profile: 'e2e-id-a', env: envA() })
    await runWizard(a.page, PORT)
    await settingsOf(a.page)
    const idA = (await a.page.getByTestId('pc-identity').textContent()) ?? ''
    expect(idA).toContain('서버용 PC')
    await expect.poll(async () => (await a.page.getByTestId('pc-identity').textContent()) ?? '', { timeout: 15000 }).toMatch(UID)
    expect(await a.page.getByRole('button', { name: /전환/ }).count()).toBe(0)
    const uidA = UID.exec((await a.page.getByTestId('pc-identity').textContent()) ?? '')![0]

    b = await launch({ profile: 'e2e-id-b' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    await settingsOf(b.page)
    const idB = (await b.page.getByTestId('pc-identity').textContent()) ?? ''
    expect(idB).toContain('일반용(팀원) PC')
    await b.page.reload()
    await settingsOf(b.page)
    await expect.poll(async () => (await b.page.getByTestId('pc-identity').textContent()) ?? '', { timeout: 15000 }).toMatch(UID)
    expect(UID.exec((await b.page.getByTestId('pc-identity').textContent()) ?? '')?.[0]).not.toBe(uidA)
  }, 120000)

  it('the member PC asks again after a reset: same account, no second person; it cannot become a server', async () => {
    b.page.once('dialog', (d) => void d.accept())
    await b.page.getByRole('button', { name: /연결 초기화/ }).click()
    await b.page.getByTestId('role-locked').waitFor({ timeout: 15000 })
    expect(await b.page.getByRole('button', { name: /이 PC를 서버로 사용/ }).isDisabled()).toBe(true)
    expect(await b.page.getByText('기존 서버의 백업으로').count()).toBe(0)

    await b.page.getByRole('button', { name: /서버에 접속/ }).click()
    await b.page.getByLabel('서버 주소').fill(`127.0.0.1:${PORT}`)
    await b.page.getByRole('button', { name: '연결 확인' }).click()
    await b.page.getByLabel('이름', { exact: true }).fill('팀원B 다시')
    await b.page.getByLabel('안내 동의').check()
    await b.page.getByRole('button', { name: '사용 신청' }).click()
    await b.page.getByTestId('pending').waitFor({ timeout: 10000 })
    await go(a.page, '/admin/approvals')
    await a.page.getByTestId('join-known').waitFor({ timeout: 15000 })
    expect(await a.page.getByTestId('join-known').textContent()).toContain('팀원B')
    await a.page.getByRole('button', { name: '승인', exact: true }).first().click()
    await b.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 20000 })

    await go(a.page, '/admin/members')
    await a.page.getByTestId('member-row-팀원B').waitFor({ timeout: 15000 })
    expect(await a.page.locator('[data-testid^="member-row-"]').count()).toBe(2) // the admin and one 팀원B
    expect(await a.page.getByTestId('member-row-팀원B 다시').count()).toBe(0)
  }, 120000)

  it('the admin corrects a member: shown everywhere, the member cannot change it back; the nickname is the member\'s', async () => {
    await a.page.getByTestId('member-row-팀원B').getByRole('button', { name: '정보 수정' }).click()
    await a.page.getByLabel('구성원 이름').fill('김팀원')
    await a.page.getByLabel('구성원 내선번호').fill('4321')
    await a.page.getByRole('dialog').getByRole('button', { name: '저장' }).click()
    await a.page.getByTestId('member-row-김팀원').waitFor({ timeout: 15000 })

    await go(b.page, '/directory')
    await b.page.getByRole('button', { name: /내 정보/ }).click()
    await expect.poll(() => b.page.getByLabel('내 이름').inputValue(), { timeout: 15000 }).toBe('김팀원')
    expect(await b.page.getByLabel('내 이름').isDisabled()).toBe(true)
    expect(await b.page.getByLabel('내 내선번호').isDisabled()).toBe(true)
    expect(await b.page.getByLabel('내 직위').isDisabled()).toBe(false)
    await b.page.getByLabel('내 필명').fill('팀원짱')
    await b.page.getByRole('button', { name: '저장', exact: true }).click()
    await b.page.getByText('저장했습니다.').waitFor({ timeout: 10000 })
    await expect.poll(() => a.page.getByTestId('member-row-김팀원').textContent(), { timeout: 15000 }).toContain('김팀원(팀원짱)')
  }, 90000)

  it('permanent block asks for a reason and a confirmation; the PC is cut off and listed; it can be taken off the list', async () => {
    const row = a.page.locator('[data-testid="device-row-김팀원"]').filter({ hasNotText: '차단 해제' })
    await row.getByRole('button', { name: '영구 차단' }).click()
    const dlg = a.page.getByRole('dialog', { name: 'PC 영구 차단' })
    const go4 = dlg.getByRole('button', { name: '영구 차단' })
    expect(await go4.isDisabled()).toBe(true)
    await dlg.getByLabel('차단 사유').fill('E2E 분실 PC')
    expect(await go4.isDisabled()).toBe(true) // the confirmation is still missing
    await dlg.getByLabel('영구 차단 확인').check()
    await go4.click()
    await a.page.getByTestId('blocked-pc').waitFor({ timeout: 15000 })
    expect(await a.page.getByTestId('blocked-pc').textContent()).toContain('E2E 분실 PC')
    await b.page.getByTestId('conn-state').filter({ hasText: '사용 중지됨' }).waitFor({ timeout: 20000 })

    a.page.once('dialog', (d) => void d.accept())
    await a.page.getByTestId('blocked-pc').getByRole('button', { name: '차단 해제' }).click()
    await expect.poll(() => a.page.getByTestId('blocked-pc').count(), { timeout: 15000 }).toBe(0)
  }, 90000)

  it('feedback: the button at the bottom of the settings opens a window; the post reaches the board with the unique value', async () => {
    await settingsOf(a.page)
    const uid = UID.exec((await a.page.getByTestId('pc-identity').textContent()) ?? '')![0]
    const opened = a.app.waitForEvent('window')
    await a.page.getByTestId('feedback-open').click()
    const w = await opened
    await w.getByTestId('feedback-window').waitFor({ timeout: 15000 })
    await expect.poll(() => w.getByTestId('feedback-install-id').textContent(), { timeout: 10000 }).toBe(uid)
    await w.getByRole('radio', { name: /오류신고/ }).click()
    await w.getByLabel('제목').fill('E2E 제목입니다')
    await w.getByLabel('내용').fill('E2E 내용입니다. 순서대로 적습니다.')
    await w.getByRole('button', { name: '보내기' }).click()
    await w.getByText(/등록했습니다\. 접수번호 TH-/).waitFor({ timeout: 20000 })
    expect(posted).toHaveLength(1)
    expect(posted[0].title).toBe('[오류신고] E2E 제목입니다')
    expect(posted[0].labels).toEqual(['오류신고'])
    expect(posted[0].body).toContain(`고유값 ${uid}`)
    expect(posted[0].body).toContain('E2E 내용입니다')
    expect(posted[0].body).not.toContain('서버관리자') // no names of people or of the organisation
    expect(posted[0].body).not.toContain('E2E기관')
    expect(revoked).toEqual(['tmp-key']) // the temporary key was given back
    await w.getByTestId('feedback-sent').waitFor({ timeout: 10000 })
    await w.close()
  }, 90000)

  it('program lock is optional: off by default, a PIN turns it on, asked at start, removable', async () => {
    await settingsOf(a.page)
    const card = a.page.getByTestId('lock-card')
    expect(await card.textContent()).toContain('사용 안 함')
    await card.getByLabel('새 PIN (숫자 4자리)').fill('2580')
    await card.getByLabel('새 PIN 다시 입력').fill('2580')
    await card.getByRole('button', { name: '잠금 PIN 켜기' }).click()
    await card.getByTestId('recovery-code').waitFor({ timeout: 10000 })
    const recovery = ((await card.getByTestId('recovery-code').textContent()) ?? '').trim()
    expect(recovery).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)

    await card.getByRole('button', { name: '지금 잠그기' }).click()
    const lock = a.page.getByTestId('lock-screen')
    await lock.waitFor({ timeout: 10000 })
    expect(await a.page.getByTestId('status-bar').count()).toBe(0) // nothing of the program behind the lock
    await lock.getByLabel('PIN', { exact: true }).fill('0000')
    await lock.getByText(/PIN이 맞지 않습니다/).waitFor({ timeout: 10000 })
    await lock.getByLabel('PIN', { exact: true }).fill('2580')
    await a.page.getByTestId('status-bar').waitFor({ timeout: 15000 })

    // asked when the program starts
    const userData = a.userData
    await a.close({ keepData: true })
    a = await launch({ profile: 'e2e-id-a', userData, env: envA() })
    await a.page.getByTestId('lock-screen').waitFor({ timeout: 20000 })
    // forgotten PIN: the recovery code makes a new one
    await a.page.getByRole('button', { name: 'PIN을 잊었습니다' }).click()
    await a.page.getByLabel('복구 코드').fill(recovery)
    await a.page.getByLabel('새 PIN (숫자 4자리)').fill('1357')
    await a.page.getByRole('button', { name: '새 PIN 만들기' }).click()
    await a.page.getByTestId('recovery-code').waitFor({ timeout: 10000 })
    await a.page.getByRole('button', { name: '적어 두었습니다' }).click()
    await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })

    // and off again
    await settingsOf(a.page)
    await a.page.getByTestId('lock-card').getByLabel('지금 PIN').fill('1357')
    await a.page.getByTestId('lock-card').getByRole('button', { name: '잠금 끄기' }).click()
    await expect.poll(() => a.page.getByTestId('lock-card').textContent(), { timeout: 10000 }).toContain('사용 안 함')
  }, 150000)
})
