import { describe, it, expect, afterAll } from 'vitest'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47934'

const popupOf = (l: Launched): Page | undefined => l.app.windows().find((w) => w.url().includes('/popup/urgent/') && !w.isClosed())
const popupCount = (l: Launched): number => l.app.windows().filter((w) => w.url().includes('/popup/urgent/') && !w.isClosed()).length

/** Sender: the red top-bar button, two-step send. Ends on the notice's page (receipts). */
async function sendEmergency(p: Page, title: string, opts: { ack?: boolean } = {}): Promise<void> {
  await p.getByTestId('emergency-button').click()
  await p.getByLabel('긴급공지 제목').fill(title)
  await p.getByLabel('긴급공지 내용').fill('동쪽 계단으로 이동하세요.')
  if (opts.ack === false) await p.getByRole('checkbox').first().uncheck()
  await p.getByRole('button', { name: '긴급 발송' }).click()
  await p.getByTestId('emergency-confirm').click()
  await p.getByRole('heading', { name: title }).first().waitFor({ timeout: 15000 })
}

async function waitPopup(l: Launched, title: string): Promise<Page> {
  await expect.poll(() => popupCount(l), { timeout: 20000, interval: 300 }).toBeGreaterThanOrEqual(1)
  const w = popupOf(l)!
  await w.getByTestId('urgent-popup').waitFor({ timeout: 15000 })
  await expect.poll(() => w.getByRole('heading').first().textContent(), { timeout: 10000 }).toContain(title)
  return w
}

describe('긴급공지: the red window goes away when it should', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup', async () => {
    a = await launch({ profile: 'e2e-ema' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-emb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
  }, 120000)

  it('confirming in the window closes it, the sender sees the confirmation, and no window opens on the sender PC', async () => {
    await sendEmergency(a.page, '화재 대피E2E')
    const w = await waitPopup(b, '화재 대피E2E')
    expect(popupCount(a)).toBe(0)
    await w.getByRole('button', { name: '확인' }).click()
    await expect.poll(() => popupCount(b), { timeout: 15000 }).toBe(0)
    await a.page.getByRole('button', { name: /^확인함/ }).click()
    await expect.poll(() => a.page.getByTestId('receipt-팀원B').count(), { timeout: 15000 }).toBe(1)
    // it does not come back by itself
    await b.page.waitForTimeout(3000)
    expect(popupCount(b)).toBe(0)
  }, 90000)

  it('confirming in the 공지 screen instead closes the window too', async () => {
    await sendEmergency(a.page, '정전 안내E2E')
    await waitPopup(b, '정전 안내E2E')
    await go(b.page, '/notices')
    await b.page.getByTestId('notice-item-정전 안내E2E').click()
    await b.page.getByRole('button', { name: '확인', exact: true }).click()
    await expect.poll(() => popupCount(b), { timeout: 15000 }).toBe(0)
  }, 90000)

  it('the sender ends the emergency: windows that were not confirmed close on every PC', async () => {
    await sendEmergency(a.page, '훈련 상황E2E')
    await waitPopup(b, '훈련 상황E2E')
    a.page.once('dialog', (d) => void d.accept())
    await a.page.getByTestId('urgent-end').click()
    await expect.poll(() => popupCount(b), { timeout: 15000 }).toBe(0)
    // ended: not shown again after B reconnects
    const userData = b.userData
    await b.close({ keepData: true })
    b = await launch({ userData, profile: 'e2e-emb' })
    await b.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 20000 })
    await b.page.waitForTimeout(4000)
    expect(popupCount(b)).toBe(0)
  }, 120000)

  it('the sender deletes the notice: the window closes; one left open is closable even when confirming fails', async () => {
    await sendEmergency(a.page, '잘못 보낸 공지E2E')
    const w = await waitPopup(b, '잘못 보낸 공지E2E')
    // B answers at the very moment the notice is deleted: the server says it is gone and the window closes itself
    a.page.once('dialog', (d) => void d.accept())
    await a.page.getByRole('button', { name: '삭제' }).click()
    await w.getByRole('button', { name: '확인' }).click().catch(() => undefined)
    await expect.poll(() => popupCount(b), { timeout: 15000 }).toBe(0)
  }, 90000)

  it('server off: confirming cannot be sent, but the window can be put away and comes back when the server is on again', async () => {
    await sendEmergency(a.page, '서버 점검E2E')
    const w = await waitPopup(b, '서버 점검E2E')
    const dataA = a.userData
    await a.close({ keepData: true })
    await w.getByRole('button', { name: '확인' }).click()
    await w.getByTestId('urgent-dismiss').waitFor({ timeout: 30000 })
    expect(await w.getByTestId('urgent-error').textContent()).toContain('서버에 연결되지 않아')
    await w.getByTestId('urgent-dismiss').click()
    await expect.poll(() => popupCount(b), { timeout: 10000 }).toBe(0)
    a = await launch({ userData: dataA, profile: 'e2e-ema' })
    await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    const again = await waitPopup(b, '서버 점검E2E')
    await again.getByRole('button', { name: '확인' }).click()
    await expect.poll(() => popupCount(b), { timeout: 15000 }).toBe(0)
  }, 180000)
})
