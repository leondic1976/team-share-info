import { describe, it, expect, afterAll } from 'vitest'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47941'

async function sendText(p: Page, text: string): Promise<void> {
  await p.getByLabel('메시지 입력').fill(text)
  await p.getByLabel('메시지 입력').press('Enter')
}

/** What Ctrl+V of a screen capture does: a paste event that carries an image file. */
async function pasteImage(p: Page): Promise<void> {
  await p.getByLabel('메시지 입력').evaluate((el) => {
    // a 1x1 PNG
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
}

describe('메신저: edit and delete (shown to everybody), pasted images wait for Enter, emoticons; notifications stay', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup: a 1:1 conversation', async () => {
    a = await launch({ profile: 'e2e-cea' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-ceb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    await go(a.page, '/chat')
    await a.page.getByRole('button', { name: '새 대화' }).click()
    await a.page.getByRole('dialog').getByLabel('팀원B').check()
    await a.page.getByRole('button', { name: '대화 시작' }).click()
    await expect.poll(() => a.page.getByTestId('conv-title').textContent()).toBe('팀원B')
    await sendText(a.page, '첫 메시지E2E')
    await go(b.page, '/chat')
    await b.page.getByTestId('conv-서버관리자').click()
    await expect.poll(() => b.page.getByTestId('message-list').textContent(), { timeout: 15000 }).toContain('첫 메시지E2E')
  }, 120000)

  it('the sender changes the text: both see the new text and "수정됨"', async () => {
    const msg = a.page.getByTestId('message').filter({ hasText: '첫 메시지E2E' })
    await msg.hover()
    await msg.getByRole('button', { name: '메시지 고치기' }).click()
    const box = a.page.getByLabel('메시지 고치기')
    await box.fill('고친 메시지E2E')
    await box.press('Enter')
    await expect.poll(() => a.page.getByTestId('message-edit').count(), { timeout: 10000 }).toBe(0)
    await expect.poll(() => a.page.getByTestId('message-edited').count(), { timeout: 10000 }).toBe(1)
    expect(await a.page.getByTestId('message-list').textContent()).toContain('고친 메시지E2E')
    // the other side, without reopening
    await expect.poll(() => b.page.getByTestId('message-list').textContent(), { timeout: 15000 }).toContain('고친 메시지E2E')
    expect(await b.page.getByTestId('message-list').textContent()).not.toContain('첫 메시지E2E')
    await expect.poll(() => b.page.getByTestId('message-edited').count(), { timeout: 10000 }).toBe(1)
    // nobody else's message can be changed or deleted
    const theirs = b.page.getByTestId('message').filter({ hasText: '고친 메시지E2E' })
    await theirs.hover()
    expect(await theirs.getByRole('button', { name: '메시지 고치기' }).count()).toBe(0)
    expect(await theirs.getByRole('button', { name: '메시지 삭제' }).count()).toBe(0)
  }, 60000)

  it('the sender deletes it: it stays in its place as "삭제된 메시지입니다." for both, also after reopening', async () => {
    const msg = a.page.getByTestId('message').filter({ hasText: '고친 메시지E2E' })
    await msg.hover()
    a.page.once('dialog', (d) => void d.accept())
    await msg.getByRole('button', { name: '메시지 삭제' }).click()
    await expect.poll(() => a.page.getByTestId('message-deleted').count(), { timeout: 10000 }).toBe(1)
    await expect.poll(() => b.page.getByTestId('message-deleted').count(), { timeout: 15000 }).toBe(1)
    expect(await b.page.getByTestId('message-list').textContent()).not.toContain('고친 메시지E2E')
    expect(await b.page.getByTestId('message-deleted').textContent()).toContain('삭제된 메시지입니다.')
    // no "수정됨" on a deleted one, no buttons
    expect(await a.page.getByTestId('message-edited').count()).toBe(0)
    await go(b.page, '/home')
    await go(b.page, '/chat')
    await b.page.getByTestId('conv-서버관리자').click()
    await expect.poll(() => b.page.getByTestId('message-deleted').count(), { timeout: 15000 }).toBe(1)
  }, 60000)

  it('a pasted image waits above the input; it can be taken out; Enter sends it with the text', async () => {
    const before = await b.page.getByTestId('message').count()
    await pasteImage(a.page)
    await a.page.getByTestId('staged-files').waitFor({ timeout: 5000 })
    // nothing was sent yet
    await a.page.waitForTimeout(1500)
    expect(await b.page.getByTestId('message').count()).toBe(before)
    // taken out again
    await a.page.getByRole('button', { name: /빼기$/ }).click()
    expect(await a.page.getByTestId('staged-files').count()).toBe(0)
    // pasted again and sent with Enter, together with a line of text
    await pasteImage(a.page)
    await a.page.getByTestId('staged-files').waitFor({ timeout: 5000 })
    await a.page.getByLabel('메시지 입력').fill('캡처 보냄E2E')
    await a.page.getByLabel('메시지 입력').press('Enter')
    await expect.poll(() => a.page.getByTestId('staged-files').count(), { timeout: 15000 }).toBe(0)
    await expect.poll(() => b.page.getByTestId('message-list').textContent(), { timeout: 15000 }).toContain('캡처 보냄E2E')
    await expect.poll(() => b.page.getByTestId('message-list').locator('img').count(), { timeout: 15000 }).toBeGreaterThan(0)
    // 보내기 works the same, with an image only
    await pasteImage(a.page)
    await a.page.getByTestId('staged-files').waitFor({ timeout: 5000 })
    await a.page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect.poll(() => a.page.getByTestId('staged-files').count(), { timeout: 15000 }).toBe(0)
    await expect.poll(() => b.page.getByTestId('message-list').locator('img').count(), { timeout: 15000 }).toBeGreaterThan(1)
  }, 90000)

  it('emoticons: more than 100 by situation, searchable; one sent alone is shown large', async () => {
    await a.page.getByRole('button', { name: '이모티콘' }).click()
    const picker = a.page.getByTestId('emoticon-picker')
    await picker.waitFor({ timeout: 5000 })
    const tabs = await picker.getByRole('tab').allTextContents()
    expect(tabs.length).toBeGreaterThanOrEqual(10)
    let total = 0
    for (const name of tabs.slice(1)) {
      await picker.getByRole('tab', { name }).click()
      total += await picker.locator('[data-emoticon]').count()
    }
    expect(total).toBeGreaterThanOrEqual(100)
    await picker.getByLabel('이모티콘 찾기').fill('감사')
    await picker.locator('[data-emoticon]').first().click()
    // it went into the input, not straight out
    expect((await a.page.getByLabel('메시지 입력').inputValue()).length).toBeGreaterThan(0)
    await a.page.keyboard.press('Escape')
    await expect.poll(() => a.page.getByTestId('emoticon-picker').count()).toBe(0)
    await a.page.getByLabel('메시지 입력').press('Enter')
    await expect.poll(() => b.page.getByTestId('message-emoticon').count(), { timeout: 15000 }).toBe(1)
    // the one used is first under 최근 next time
    await a.page.getByRole('button', { name: '이모티콘' }).click()
    expect(await a.page.getByTestId('emoticon-picker').getByRole('tab', { selected: true }).textContent()).toContain('최근')
    expect(await a.page.getByTestId('emoticon-picker').locator('[data-emoticon]').count()).toBe(1)
    await a.page.getByRole('button', { name: '이모티콘' }).click()
  }, 60000)

  it('a Windows notification stays until it is clicked (no time-out)', async () => {
    await b.page.evaluate(() => window.teamhub.invoke('notify:toast', { title: '알림E2E', body: '본문', route: '/notices' }))
    const got = await b.app.evaluate(() => ((globalThis as unknown as { __teamhubToasts?: { title: string; timeoutType?: string }[] }).__teamhubToasts ?? []).filter((t) => t.title === '알림E2E'))
    expect(got).toEqual([expect.objectContaining({ timeoutType: 'never' })])
  }, 30000)
})
