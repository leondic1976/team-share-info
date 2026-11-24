import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47921'
const HONG_PIN = '274913'
const KIM_PIN = '805162'

type Bridge = { teamhub: { invoke: (channel: string, req?: unknown) => Promise<unknown> } }
const memos = (p: Page): Promise<{ body: string }[]> => p.evaluate(() => (window as unknown as Bridge).teamhub.invoke('local:memos.list', { q: '' }) as Promise<{ body: string }[]>)
const userDataOf = async (p: Page): Promise<string> => ((await p.evaluate(() => (window as unknown as Bridge).teamhub.invoke('app:getInfo'))) as { userDataPath: string }).userDataPath

/** Sign in at the picker: the picker window closes and the main window of that person opens. */
async function signIn(b: Launched, name: string, pin: string): Promise<Page> {
  await b.page.getByTestId(`seat-${name}`).click()
  const opened = b.app.waitForEvent('window', { timeout: 30000 })
  await b.page.getByLabel('PIN', { exact: true }).fill(pin)
  await b.page.getByRole('button', { name: '시작' }).click()
  const main = await opened
  await main.waitForLoadState('domcontentloaded')
  return main
}

describe('shared PC: several people on one member PC, each with a name and a PIN', () => {
  let a: Launched
  let b: Launched
  let userData = ''

  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('off by default: the member PC starts straight into the program, the card offers to turn it on', async () => {
    a = await launch({ profile: 'e2e-sp-a' })
    await runWizard(a.page, PORT)
    // a server PC is not shared: no card there
    await go(a.page, '/settings')
    await a.page.getByTestId('pc-identity').waitFor({ timeout: 15000 })
    expect(await a.page.getByTestId('shared-pc-card').count()).toBe(0)

    b = await launch({ profile: 'e2e-sp-b' })
    userData = b.userData
    expect(await b.page.getByTestId('seat-picker').count()).toBe(0)
    await joinAndApprove(a.page, b.page, PORT, '홍길동')
    await b.page.evaluate(() => (window as unknown as Bridge).teamhub.invoke('local:memos.save', { body: '홍길동의 개인 메모' }))
    expect((await memos(b.page)).map((m) => m.body)).toEqual(['홍길동의 개인 메모'])

    await go(b.page, '/settings')
    const card = b.page.getByTestId('shared-pc-card')
    await card.waitFor({ timeout: 15000 })
    expect(await card.textContent()).toContain('사용 안 함')
    expect(await b.page.getByTestId('lock-card').count()).toBe(1)
    expect(existsSync(join(userData, 'seats.json'))).toBe(false)
  }, 150000)

  it('turning it on makes the person the PC 책임자 (recovery code shown once); a second person is added with that PIN', async () => {
    const card = b.page.getByTestId('shared-pc-card')
    await expect.poll(() => card.getByLabel('내 이름 (시작 화면에 표시)').inputValue(), { timeout: 10000 }).toBe('홍길동')
    // a weak PIN is refused
    await card.getByLabel(/^내 PIN \(/).fill('123456')
    await card.getByLabel('내 PIN 다시 입력').fill('123456')
    await card.getByRole('button', { name: '공용 PC 사용 켜기' }).click()
    await card.getByText(/이어지는 숫자는 PIN으로 쓸 수 없습니다/).waitFor({ timeout: 10000 })
    await card.getByLabel(/^내 PIN \(/).fill(HONG_PIN)
    await card.getByLabel('내 PIN 다시 입력').fill(HONG_PIN)
    await card.getByRole('button', { name: '공용 PC 사용 켜기' }).click()
    await card.getByTestId('seat-recovery-code').waitFor({ timeout: 10000 })
    expect(((await card.getByTestId('seat-recovery-code').textContent()) ?? '').trim()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(await card.getByTestId('seat-current').textContent()).toBe('홍길동')
    // one PIN per person: the optional program lock is not offered next to it
    await expect.poll(() => b.page.getByTestId('lock-card').count(), { timeout: 10000 }).toBe(0)

    // adding needs the PC 책임자 PIN
    await card.getByLabel('새 사용자 이름').fill('김주무')
    await card.getByLabel(/^새 사용자 PIN/).fill(KIM_PIN)
    await card.getByLabel('PC 책임자 PIN').fill('999999')
    await card.getByRole('button', { name: '사용자 추가' }).click()
    await card.getByText(/PC 책임자 PIN이 맞지 않습니다/).waitFor({ timeout: 10000 })
    await card.getByLabel('PC 책임자 PIN').fill(HONG_PIN)
    await card.getByRole('button', { name: '사용자 추가' }).click()
    await expect.poll(() => card.getByTestId('seat-rows').textContent(), { timeout: 10000 }).toContain('김주무')
    // the new person's folder exists below the base folder, with nothing of 홍길동 in it
    const users = readdirSync(join(userData, 'users'))
    expect(users).toHaveLength(1)
    expect(existsSync(join(userData, 'users', users[0], 'local.db'))).toBe(false)
    expect(existsSync(join(userData, 'users', users[0], 'device.dpapi'))).toBe(false)
  }, 90000)

  it('the lock covers the program and opens with the PIN of the signed-in person only', async () => {
    const card = b.page.getByTestId('shared-pc-card')
    await card.getByRole('button', { name: '지금 잠그기' }).click()
    const lock = b.page.getByTestId('lock-screen')
    await lock.waitFor({ timeout: 10000 })
    expect(await lock.getByTestId('lock-seat-name').textContent()).toBe('홍길동')
    expect(await b.page.getByTestId('status-bar').count()).toBe(0)
    await lock.getByLabel('PIN', { exact: true }).fill(KIM_PIN) // somebody else's PIN
    await lock.getByRole('button', { name: '잠금 풀기' }).click()
    await lock.getByText(/PIN이 맞지 않습니다/).waitFor({ timeout: 10000 })
    await lock.getByLabel('PIN', { exact: true }).fill(HONG_PIN)
    await lock.getByRole('button', { name: '잠금 풀기' }).click()
    await b.page.getByTestId('status-bar').waitFor({ timeout: 15000 })
  }, 60000)

  it('next start: only the sign-in window; a wrong PIN is refused; the second person starts with empty personal data', async () => {
    await b.close({ keepData: true })
    b = await launch({ profile: 'e2e-sp-b', userData })
    await b.page.getByTestId('seat-picker').waitFor({ timeout: 30000 })
    expect(b.app.windows()).toHaveLength(1) // no main window, no popups: nobody is signed in
    const names = (await b.page.getByTestId('seat-list').textContent()) ?? ''
    expect(names).toContain('홍길동')
    expect(names).toContain('김주무')
    // nothing of the program answers before sign-in
    const early = await b.page.evaluate(() =>
      (window as unknown as Bridge).teamhub.invoke('local:memos.list', { q: '' }).then(
        () => 'answered',
        () => 'refused'
      )
    )
    expect(early).toBe('refused')

    await b.page.getByTestId('seat-김주무').click()
    await b.page.getByLabel('PIN', { exact: true }).fill(HONG_PIN) // the PC 책임자's PIN is not a master key
    await b.page.getByRole('button', { name: '시작' }).click()
    await b.page.getByText(/PIN이 맞지 않습니다/).waitFor({ timeout: 10000 })
    expect(b.app.windows()).toHaveLength(1)
    await b.page.getByRole('button', { name: /사용자 선택으로/ }).click()

    const kim = await signIn(b, '김주무', KIM_PIN)
    // a fresh member PC for this person: not connected, cannot become a server, no memo of 홍길동
    await kim.getByTestId('role-locked').waitFor({ timeout: 30000 })
    expect(await memos(kim)).toEqual([])
    expect((await userDataOf(kim)).replace(/\\/g, '/')).toContain('/users/')

    // an own request, an own approval, an own account
    await joinAndApprove(a.page, kim, PORT, '김주무')
    await go(a.page, '/admin/members')
    await a.page.getByTestId('member-row-김주무').waitFor({ timeout: 15000 })
    expect(await a.page.getByTestId('member-row-홍길동').count()).toBe(1)
    expect(await a.page.locator('[data-testid^="member-row-"]').count()).toBe(3) // admin, 홍길동, 김주무
    // both entries of this PC are marked, and 홍길동's was not cut off
    await expect.poll(() => a.page.getByTestId('device-shared').count(), { timeout: 15000 }).toBe(2)
    expect(await a.page.getByTestId('device-row-홍길동').textContent()).not.toContain('차단 해제')
    b.page = kim
  }, 180000)

  it('the first person signs in again: own account still connected, own memo still there', async () => {
    await b.close({ keepData: true })
    b = await launch({ profile: 'e2e-sp-b', userData })
    await b.page.getByTestId('seat-picker').waitFor({ timeout: 30000 })
    const hong = await signIn(b, '홍길동', HONG_PIN)
    await hong.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    expect((await memos(hong)).map((m) => m.body)).toEqual(['홍길동의 개인 메모'])
    expect((await userDataOf(hong)).replace(/\\/g, '/')).not.toContain('/users/')
    b.page = hong

    // shared mode cannot be turned off while somebody else is registered
    await go(hong, '/settings')
    const card = hong.getByTestId('shared-pc-card')
    await card.waitFor({ timeout: 15000 })
    expect(await card.getByRole('button', { name: '공용 PC 사용 끄기' }).isDisabled()).toBe(true)
    // the PC 책임자 removes the other person (their data on this PC goes), then turns the mode off
    hong.once('dialog', (d) => void d.accept())
    await card.getByLabel('PC 책임자 PIN').fill(HONG_PIN)
    await card.getByTestId('seat-rows').getByRole('button', { name: '지우기' }).click()
    await expect.poll(() => card.getByTestId('seat-rows').textContent(), { timeout: 10000 }).not.toContain('김주무')
    expect(readdirSync(join(userData, 'users'))).toHaveLength(0)
    await card.getByLabel('PC 책임자 PIN').fill(HONG_PIN)
    await card.getByRole('button', { name: '공용 PC 사용 끄기' }).click()
    await expect.poll(() => card.textContent(), { timeout: 10000 }).toContain('사용 안 함')
    expect(existsSync(join(userData, 'seats.json'))).toBe(false)
    await expect.poll(() => hong.getByTestId('lock-card').count(), { timeout: 10000 }).toBe(1)
  }, 150000)
})
