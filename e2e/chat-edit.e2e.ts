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

  it('a new message while the window is hidden: a card at the top right, the 팀뿌요 sound, a click opens it', async () => {
    const mainOf = (l: Launched) => l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popup/'))!.id)
    const bMain = await mainOf(b)
    await b.app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.hide(), bMain)
    const before = await b.page.evaluate(() => (window as unknown as { __thSounds?: number }).__thSounds ?? 0)
    await sendText(a.page, '미리보기E2E 안녕하세요')
    const preview = async () => b.app.windows().find((w) => w.url().includes('/popup/preview') && !w.isClosed())
    await expect.poll(async () => !!(await preview()), { timeout: 15000 }).toBe(true)
    const w = (await preview())!
    await expect.poll(() => w.getByTestId('preview-card').first().textContent(), { timeout: 10000 }).toContain('미리보기E2E')
    expect(await w.getByTestId('preview-card').first().textContent()).toContain('서버관리자')
    // it does not take the focus, and it sits at the top right of the screen (지시 114)
    const pos = await b.app.evaluate(({ BrowserWindow, screen }) => {
      const pw = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/popup/preview'))!
      const area = screen.getPrimaryDisplay().workArea
      const r = pw.getBounds()
      return { focusable: pw.isFocusable(), right: area.x + area.width - (r.x + r.width), top: r.y - area.y, visible: pw.isVisible() }
    })
    expect(pos).toMatchObject({ focusable: false, visible: true })
    expect(pos.right).toBeLessThan(40)
    expect(pos.top).toBe(40)
    await expect.poll(() => b.page.evaluate(() => (window as unknown as { __thSounds?: number }).__thSounds ?? 0), { timeout: 5000 }).toBeGreaterThan(before)
    // a second message of the same conversation adds to the same card
    await sendText(a.page, '두번째E2E')
    await expect.poll(() => w.getByTestId('preview-card').count(), { timeout: 10000 }).toBe(1)
    await expect.poll(() => w.getByTestId('preview-card').first().textContent(), { timeout: 10000 }).toContain('두번째E2E')
    // clicking opens the conversation in the TeamHub window and the card goes
    await w.getByTestId('preview-card').first().click()
    await expect.poll(() => b.app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.isVisible(), bMain), { timeout: 10000 }).toBe(true)
    await expect.poll(() => b.page.getByTestId('message-list').textContent(), { timeout: 10000 }).toContain('두번째E2E')
    await expect.poll(() => b.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((x) => x.webContents.getURL().includes('/popup/preview') && x.isVisible())), { timeout: 10000 }).toBe(false)
  }, 90000)

  it('other alerts come the same way: a new shared event and an important notice give a card and the sound', async () => {
    // sounds within 1.5 s of each other are played once: start clear of the last message's
    await new Promise((r) => setTimeout(r, 1700))
    const before = await b.page.evaluate(() => (window as unknown as { __thSounds?: number }).__thSounds ?? 0)
    const post = (url: string, body: unknown) =>
      a.page.evaluate(
        async ({ url, body }) => {
          const c = await window.teamhub.invoke('conn:get', undefined as never)
          const r = await fetch(`${c.serverUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1' }, body: JSON.stringify(body) })
          return r.status
        },
        { url, body }
      )
    const TEAM = { type: 'team', groupIds: [], memberIds: [] }
    const start = Date.now() + 2 * 86400_000
    expect(await post('/api/events', { title: '새일정알림E2E', startAt: start, endAt: start + 3600_000, scope: TEAM })).toBe(200)
    const cards = () => b.app.windows().find((w) => w.url().includes('/popup/preview') && !w.isClosed())?.getByTestId('message-preview').textContent() ?? Promise.resolve('')
    await expect.poll(cards, { timeout: 15000 }).toContain('새일정알림E2E')
    expect(await cards()).toContain('새 일정 · 서버관리자')
    const sounds = () => b.page.evaluate(() => (window as unknown as { __thSounds?: number }).__thSounds ?? 0)
    await expect.poll(sounds, { timeout: 5000 }).toBeGreaterThanOrEqual(before + 1)
    // sounds within 1.5 s of each other are played once
    await new Promise((r) => setTimeout(r, 1700))
    expect(await post('/api/notices', { level: 'important', title: '중요공지알림E2E', bodyHtml: '<p>x</p>', scope: TEAM, requireAck: false, replyOptions: [], pinned: false, publishAt: null, expiresAt: null, renotifyMinutes: null, attachmentIds: [] })).toBe(200)
    await expect.poll(cards, { timeout: 15000 }).toContain('중요공지알림E2E')
    await expect.poll(sounds, { timeout: 5000 }).toBeGreaterThanOrEqual(before + 2)
    // the one who registered it gets nothing for their own event
    expect(await a.app.evaluate(() => ((globalThis as unknown as { __teamhubPreviews?: { title: string }[] }).__teamhubPreviews ?? []).filter((x) => x.title.startsWith('새 일정')).length)).toBe(0)
  }, 60000)

  it('a Windows notification stays until it is clicked (no time-out)', async () => {
    await b.page.evaluate(() => window.teamhub.invoke('notify:toast', { title: '알림E2E', body: '본문', route: '/notices' }))
    const got = await b.app.evaluate(() => ((globalThis as unknown as { __teamhubToasts?: { title: string; timeoutType?: string }[] }).__teamhubToasts ?? []).filter((t) => t.title === '알림E2E'))
    expect(got).toEqual([expect.objectContaining({ timeoutType: 'never' })])
  }, 30000)
})
