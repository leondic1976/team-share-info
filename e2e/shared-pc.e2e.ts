import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47921'
// every PIN that is made has exactly 4 digits
const HONG_PIN = '2749'
const KIM_PIN = '8051'

type Bridge = { teamhub: { invoke: (channel: string, req?: unknown) => Promise<unknown> } }
const memos = (p: Page): Promise<{ body: string }[]> => p.evaluate(() => (window as unknown as Bridge).teamhub.invoke('local:memos.list', { q: '' }) as Promise<{ body: string }[]>)
const userDataOf = async (p: Page): Promise<string> => ((await p.evaluate(() => (window as unknown as Bridge).teamhub.invoke('app:getInfo'))) as { userDataPath: string }).userDataPath
const lockState = (p: Page): Promise<{ hasPin: boolean; locked: boolean }> => p.evaluate(() => (window as unknown as Bridge).teamhub.invoke('lock:state') as Promise<{ hasPin: boolean; locked: boolean }>)
/** Seconds the PC "was not touched" (E2E runs unattended: the idle time is what the test says). */
const setIdle = (b: Launched, seconds: number): Promise<void> =>
  b.app.evaluate((_e, v) => {
    ;(globalThis as unknown as { __teamhubIdle?: number }).__teamhubIdle = v
  }, seconds)

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

describe('shared PC: several people on one member PC, each with a name and (if they want one) a 4-digit PIN', () => {
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
    // what the PIN is, and what it is not, is said before the mode is turned on
    expect(await card.getByTestId('seat-pin-rule').textContent()).toContain('숫자 4자리')
    expect(await card.getByTestId('seat-pin-rule').textContent()).toContain('쓰지 않아도 됩니다')
    expect(await card.getByTestId('seat-limits').textContent()).toContain('Windows 계정을 따로')
    // a PIN is 4 digits: the field takes no more, and a weak one is refused
    await card.getByLabel(/^내 PIN \(/).fill('274913')
    expect(await card.getByLabel(/^내 PIN \(/).inputValue()).toBe('2749')
    await card.getByLabel(/^내 PIN \(/).fill('1234')
    await card.getByLabel('내 PIN 다시 입력').fill('1234')
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
    await card.getByLabel('PC 책임자 PIN').fill('9999')
    await card.getByRole('button', { name: '사용자 추가' }).click()
    await card.getByText(/PC 책임자 PIN이 맞지 않습니다/).waitFor({ timeout: 10000 })
    await card.getByLabel('PC 책임자 PIN').fill(HONG_PIN)
    await card.getByRole('button', { name: '사용자 추가' }).click()
    await expect.poll(() => card.getByTestId('seat-rows').textContent(), { timeout: 10000 }).toContain('김주무')
    // the idle time logs out now (it used to lock); the wording says so
    expect(await card.getByTestId('seat-idle-note').textContent()).toContain('10분 동안 쓰지 않으면 자동으로 로그아웃됩니다')
    expect(await card.getByLabel('자동 로그아웃 시간(분)').inputValue()).toBe('10')
    expect(await card.textContent()).not.toContain('자동 잠금')
    // the new person's folder exists below the base folder, with nothing of 홍길동 in it
    const users = readdirSync(join(userData, 'users'))
    expect(users).toHaveLength(1)
    expect(existsSync(join(userData, 'users', users[0], 'local.db'))).toBe(false)
    expect(existsSync(join(userData, 'users', users[0], 'device.dpapi'))).toBe(false)
  }, 90000)

  it('one PIN per person: "지금 잠그기" covers the program and opens with the PIN the person signs in with', async () => {
    const card = b.page.getByTestId('shared-pc-card')
    expect(await lockState(b.page)).toMatchObject({ hasPin: true, locked: false })
    // no second, separate lock PIN can be made while the mode is on
    const second = (await b.page.evaluate(() => (window as unknown as Bridge).teamhub.invoke('lock:create', { pin: '2580' }))) as { ok: boolean; error?: string }
    expect(second.ok).toBe(false)
    expect(second.error).toContain('사용자 PIN 하나만')
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
    await kim.evaluate(() => (window as unknown as Bridge).teamhub.invoke('local:memos.save', { body: '김주무의 개인 메모' }))
    expect((await memos(kim)).map((m) => m.body)).toEqual(['김주무의 개인 메모'])
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
    expect(await card.getByTestId('seat-removed').count()).toBe(0)
    const [kimId] = readdirSync(join(userData, 'users'))
    expect(existsSync(join(userData, 'users', kimId, 'local.db'))).toBe(true)
    // the PC 책임자 removes the other person
    // pressing 지우기 asks for the PC 책임자's PIN in its own window; a wrong PIN is refused there
    await card.getByTestId('seat-rows').getByRole('button', { name: '지우기' }).click()
    const ask = hong.getByTestId('seat-ask')
    // the window says what really happens: kept for 30 days, restorable, then erased
    expect(await ask.textContent()).toContain('30일 동안 보관')
    await hong.getByTestId('seat-ask-ok').click()
    await expect.poll(() => ask.getByRole('alert').textContent(), { timeout: 5000 }).toContain('PIN을 입력하세요')
    await ask.getByLabel('PC 책임자 PIN').fill('1357')
    await hong.getByTestId('seat-ask-ok').click()
    await expect.poll(() => ask.getByRole('alert').textContent(), { timeout: 5000 }).toContain('PIN')
    expect(await card.getByTestId('seat-rows').textContent()).toContain('김주무')
    await ask.getByLabel('PC 책임자 PIN').fill(HONG_PIN)
    await hong.getByTestId('seat-ask-ok').click()
    await expect.poll(() => card.getByTestId('seat-rows').textContent(), { timeout: 10000 }).not.toContain('김주무')

    // not erased: the whole folder sits in the holding area with the record that puts the person back
    expect(readdirSync(join(userData, 'users'))).toHaveLength(0)
    const kept = join(userData, 'removed-users', kimId)
    expect(existsSync(join(kept, 'seat', 'local.db'))).toBe(true)
    expect(existsSync(join(kept, 'seat', 'device.dpapi'))).toBe(true)
    const meta = JSON.parse(readFileSync(join(kept, 'meta.json'), 'utf8')) as { name: string; record: { id: string; hash: string } }
    expect(meta).toMatchObject({ name: '김주무', record: { id: kimId } })
    expect(JSON.stringify(meta)).not.toContain(`"${KIM_PIN}"`)
    const gone = card.getByTestId('seat-removed-rows')
    await expect.poll(() => gone.textContent(), { timeout: 10000 }).toContain('김주무')
    expect(await gone.textContent()).toContain('30일 뒤 완전히 지워짐')

    // 복구 asks for the PC 책임자's PIN in the same kind of window
    await gone.getByRole('button', { name: '복구' }).click()
    expect(await ask.textContent()).toContain('예전 PIN')
    await ask.getByLabel('PC 책임자 PIN').fill(KIM_PIN) // not the PC 책임자's
    await hong.getByTestId('seat-ask-ok').click()
    await expect.poll(() => ask.getByRole('alert').textContent(), { timeout: 5000 }).toContain('PIN')
    expect(existsSync(kept)).toBe(true)
    await ask.getByLabel('PC 책임자 PIN').fill(HONG_PIN)
    await hong.getByTestId('seat-ask-ok').click()
    await expect.poll(() => card.getByTestId('seat-rows').textContent(), { timeout: 10000 }).toContain('김주무')
    await expect.poll(() => card.getByTestId('seat-removed').count(), { timeout: 10000 }).toBe(0)
    expect(existsSync(kept)).toBe(false)
    expect(existsSync(join(userData, 'removed-users'))).toBe(false)
    expect(existsSync(join(userData, 'users', kimId, 'local.db'))).toBe(true)
    expect(existsSync(join(userData, 'users', kimId, 'device.dpapi'))).toBe(true)
  }, 150000)

  it('the restored person signs in with the old PIN: connected as before, own memo still there', async () => {
    await b.close({ keepData: true })
    b = await launch({ profile: 'e2e-sp-b', userData })
    await b.page.getByTestId('seat-picker').waitFor({ timeout: 30000 })
    const kim = await signIn(b, '김주무', KIM_PIN)
    // the device key came back with the folder: no new request, no new approval
    await kim.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    expect((await memos(kim)).map((m) => m.body)).toEqual(['김주무의 개인 메모'])
    expect((await userDataOf(kim)).replace(/\\/g, '/')).toContain('/users/')
    b.page = kim
    // still one account each on the server
    await go(a.page, '/admin/members')
    await a.page.getByTestId('member-row-김주무').waitFor({ timeout: 15000 })
    expect(await a.page.locator('[data-testid^="member-row-"]').count()).toBe(3)
  }, 120000)

  it('a person without a PIN signs in by the name alone; the idle time warns, "계속 사용" cancels, then it logs out', async () => {
    await b.close({ keepData: true })
    b = await launch({ profile: 'e2e-sp-b', userData })
    await b.page.getByTestId('seat-picker').waitFor({ timeout: 30000 })
    // who has a PIN is shown by a lock
    expect(await b.page.getByTestId('seat-pin-홍길동').count()).toBe(1)
    expect(await b.page.getByTestId('seat-pin-김주무').count()).toBe(1)
    const hong = await signIn(b, '홍길동', HONG_PIN)
    b.page = hong
    await go(hong, '/settings')
    const card = hong.getByTestId('shared-pc-card')
    await card.waitFor({ timeout: 15000 })

    // the PIN field left empty: a person without a PIN
    await card.getByLabel('새 사용자 이름').fill('이주무')
    await card.getByLabel('PC 책임자 PIN').fill(HONG_PIN)
    await card.getByRole('button', { name: '사용자 추가' }).click()
    await expect.poll(() => card.getByTestId('seat-rows').textContent(), { timeout: 10000 }).toContain('이주무')
    expect(await card.getByTestId('seat-rows').locator('li', { hasText: '이주무' }).textContent()).toContain('PIN 없음')
    expect(await card.getByTestId('seat-rows').locator('li', { hasText: '김주무' }).textContent()).not.toContain('PIN 없음')

    // nine and a half minutes without input (of 10): the warning comes up in a window of its own
    const logoutFile = join(userData, 'e2e-logout.json')
    rmSync(logoutFile, { force: true })
    const opened = b.app.waitForEvent('window', { timeout: 30000 })
    await setIdle(b, 10 * 60 - 30)
    const warn = await opened
    await warn.waitForLoadState('domcontentloaded')
    await warn.getByTestId('logout-warning').waitFor({ timeout: 15000 })
    await expect.poll(() => warn.getByTestId('logout-left').textContent(), { timeout: 10000 }).toMatch(/^(2\d|30)초$/)
    expect(await warn.getByTestId('logout-warning').textContent()).toContain('뒤 자동 로그아웃됩니다')
    expect(await warn.getByTestId('logout-warning').textContent()).toContain('홍길동')
    // 계속 사용: the notice goes away, nobody is logged out, the program is as it was
    const closed = warn.waitForEvent('close', { timeout: 15000 })
    await warn.getByRole('button', { name: '계속 사용' }).click()
    await closed
    await hong.waitForTimeout(3000)
    expect(existsSync(logoutFile)).toBe(false)
    expect(await card.getByTestId('seat-current').textContent()).toBe('홍길동')

    // the time runs out with nobody there: logged out (E2E records the request instead of restarting)
    // (the idle time counts from "계속 사용": ten more minutes, less three seconds)
    await setIdle(b, 10 * 60 - 30 + 10 * 60 - 3)
    await expect.poll(() => existsSync(logoutFile), { timeout: 30000 }).toBe(true)
    expect(JSON.parse(readFileSync(logoutFile, 'utf8'))).toMatchObject({ reason: 'idle' })

    // back at the sign-in window: the person without a PIN is marked, and the name alone opens their TeamHub
    await b.close({ keepData: true })
    b = await launch({ profile: 'e2e-sp-b', userData })
    await b.page.getByTestId('seat-picker').waitFor({ timeout: 30000 })
    expect(await b.page.getByTestId('seat-nopin-이주무').textContent()).toBe('PIN 없음')
    expect(await b.page.getByTestId('seat-pin-이주무').count()).toBe(0)
    const mainWin = b.app.waitForEvent('window', { timeout: 30000 })
    await b.page.getByTestId('seat-이주무').click()
    const lee = await mainWin
    await lee.waitForLoadState('domcontentloaded')
    await lee.getByTestId('role-locked').waitFor({ timeout: 30000 })
    expect((await userDataOf(lee)).replace(/\\/g, '/')).toContain('/users/')
    expect(await memos(lee)).toEqual([])
    // nothing to lock with: the lock screen never appears for this person
    await lee.evaluate(() => (window as unknown as Bridge).teamhub.invoke('lock:now'))
    expect(await lockState(lee)).toMatchObject({ hasPin: false, locked: false })
    expect(await lee.getByTestId('lock-screen').count()).toBe(0)
    b.page = lee

    // the person is taken off again at the sign-in window: no PIN to ask, the confirmation alone
    await b.close({ keepData: true })
    b = await launch({ profile: 'e2e-sp-b', userData })
    await b.page.getByTestId('seat-picker').waitFor({ timeout: 30000 })
    await b.page.getByRole('button', { name: '사용자 지우기' }).click()
    await b.page.getByRole('button', { name: '이주무' }).click()
    await b.page.getByTestId('seat-remove-nopin').waitFor({ timeout: 10000 })
    expect(await b.page.getByLabel(/PIN$/).count()).toBe(0)
    await b.page.getByLabel('자료 삭제 확인').check()
    await b.page.getByRole('button', { name: '이 PC에서 지우기' }).click()
    await expect.poll(() => b.page.getByTestId('seat-list').textContent(), { timeout: 15000 }).not.toContain('이주무')
    // and the kept data of that person is erased, so the next test starts from two people
    const back = await signIn(b, '홍길동', HONG_PIN)
    b.page = back
    await go(back, '/settings')
    const card2 = back.getByTestId('shared-pc-card')
    await card2.getByTestId('seat-removed-rows').getByRole('button', { name: '완전히 지우기' }).click()
    await back.getByTestId('seat-ask').getByLabel('PC 책임자 PIN').fill(HONG_PIN)
    await back.getByTestId('seat-ask-ok').click()
    await expect.poll(() => card2.getByTestId('seat-removed').count(), { timeout: 10000 }).toBe(0)
    expect(readdirSync(join(userData, 'users'))).toHaveLength(1)
  }, 240000)

  it('완전히 지우기 erases the kept data for good; a PC 책임자 without a PIN manages without one; turning the mode off', async () => {
    await b.close({ keepData: true })
    b = await launch({ profile: 'e2e-sp-b', userData })
    await b.page.getByTestId('seat-picker').waitFor({ timeout: 30000 })
    const hong = await signIn(b, '홍길동', HONG_PIN)
    b.page = hong
    await go(hong, '/settings')
    const card = hong.getByTestId('shared-pc-card')
    await card.waitFor({ timeout: 15000 })
    const [kimId] = readdirSync(join(userData, 'users'))
    const kept = join(userData, 'removed-users', kimId)
    const ask = hong.getByTestId('seat-ask')
    await card.getByTestId('seat-rows').getByRole('button', { name: '지우기' }).click()
    await ask.getByLabel('PC 책임자 PIN').fill(HONG_PIN)
    await hong.getByTestId('seat-ask-ok').click()
    const gone = card.getByTestId('seat-removed-rows')
    await expect.poll(() => gone.textContent(), { timeout: 10000 }).toContain('김주무')
    expect(existsSync(join(kept, 'seat', 'local.db'))).toBe(true)

    // turning the mode off with a kept backup: asked first, and saying no leaves everything as it is
    let asked = ''
    hong.once('dialog', (d) => {
      asked = d.message()
      void d.dismiss()
    })
    await card.getByLabel('PC 책임자 PIN').fill(HONG_PIN)
    await card.getByRole('button', { name: '공용 PC 사용 끄기' }).click()
    await expect.poll(() => asked, { timeout: 10000 }).toContain('다시 켜야 복구할 수 있습니다')
    expect(await card.getByTestId('seat-current').count()).toBe(1)
    expect(existsSync(join(userData, 'seats.json'))).toBe(true)

    // 완전히 지우기: wrong PIN refused, then gone from the disk
    await gone.getByRole('button', { name: '완전히 지우기' }).click()
    expect(await ask.textContent()).toContain('되돌릴 수 없습니다')
    await ask.getByLabel('PC 책임자 PIN').fill('1357')
    await hong.getByTestId('seat-ask-ok').click()
    await expect.poll(() => ask.getByRole('alert').textContent(), { timeout: 5000 }).toContain('PIN')
    expect(existsSync(kept)).toBe(true)
    await ask.getByLabel('PC 책임자 PIN').fill(HONG_PIN)
    await hong.getByTestId('seat-ask-ok').click()
    await expect.poll(() => card.getByTestId('seat-removed').count(), { timeout: 10000 }).toBe(0)
    expect(existsSync(kept)).toBe(false)
    expect(readdirSync(join(userData, 'users'))).toHaveLength(0)

    // the PC 책임자 stops using a PIN (asked first, with the current PIN): from then on the
    // management actions ask for nothing, which the card says in a warning
    expect(await card.getByTestId('seat-owner-nopin').count()).toBe(0)
    let said = ''
    hong.once('dialog', (d) => {
      said = d.message()
      void d.accept()
    })
    await card.getByLabel('지금 내 PIN').fill(HONG_PIN)
    await card.getByRole('button', { name: 'PIN 없이 쓰기' }).click()
    await card.getByTestId('seat-owner-nopin').waitFor({ timeout: 10000 })
    expect(said).toContain('누구나 내 이름만 눌러')
    expect(await card.getByTestId('seat-owner-nopin').textContent()).toContain('누구나 PIN 확인 없이')
    expect(await card.getByTestId('seat-nopin-note').textContent()).toContain('PIN 없이 쓰고 있습니다')
    expect(await card.getByLabel('PC 책임자 PIN').count()).toBe(0)
    expect(await card.getByRole('button', { name: '지금 잠그기' }).count()).toBe(0)
    expect(await lockState(hong)).toMatchObject({ hasPin: false, locked: false })
    expect(JSON.parse(readFileSync(join(userData, 'seats.json'), 'utf8'))).toMatchObject({ recoveryHash: null, seats: [{ owner: true, salt: null, hash: null }] })
    // a management action without any PIN
    await card.getByLabel('자동 로그아웃 시간(분)').fill('15')
    await card.getByRole('button', { name: '시간 바꾸기' }).click()
    await expect.poll(() => card.getByTestId('seat-idle-note').textContent(), { timeout: 10000 }).toContain('15분')
    // the PC 책임자 makes a PIN again: a new recovery code, and the PIN is asked again
    await card.getByLabel('새 PIN (숫자 4자리)').fill('3141')
    await card.getByLabel('새 PIN 다시 입력').fill('3141')
    await card.getByRole('button', { name: '내 PIN 만들기' }).click()
    await card.getByTestId('seat-recovery-code').waitFor({ timeout: 10000 })
    await expect.poll(() => card.getByTestId('seat-owner-nopin').count(), { timeout: 10000 }).toBe(0)
    await card.getByRole('button', { name: '공용 PC 사용 끄기' }).click()
    await expect.poll(() => card.textContent(), { timeout: 10000 }).toContain('PC 책임자 PIN을 입력하세요')
    expect(existsSync(join(userData, 'seats.json'))).toBe(true)

    await card.getByLabel('PC 책임자 PIN').fill('3141')
    await card.getByRole('button', { name: '공용 PC 사용 끄기' }).click()
    await expect.poll(() => card.textContent(), { timeout: 10000 }).toContain('사용 안 함')
    expect(existsSync(join(userData, 'seats.json'))).toBe(false)
    await expect.poll(() => hong.getByTestId('lock-card').count(), { timeout: 10000 }).toBe(1)
  }, 150000)
})
