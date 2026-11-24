import { describe, it, expect, afterAll } from 'vitest'
import type { Locator, Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47922'

/** The small messenger window of the conversation with this title (also while it is minimised). */
function panelOf(p: Page, title: string): Locator {
  return p.locator('[data-testid="chat-panel"]', { has: p.locator('[data-testid="conv-title"]', { hasText: new RegExp(`^${title}$`) }) })
}

async function sendIn(panel: Locator, text: string): Promise<void> {
  await panel.getByLabel('메시지 입력').fill(text)
  await panel.getByLabel('메시지 입력').press('Enter')
}

describe('small messenger windows: open by name, several at once, add and remove people', () => {
  let a: Launched
  let b: Launched
  let c: Launched
  afterAll(async () => {
    await c?.close()
    await b?.close()
    await a?.close()
  })

  it('setup', async () => {
    a = await launch({ profile: 'e2e-docka' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-dockb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    c = await launch({ profile: 'e2e-dockc' })
    await joinAndApprove(a.page, c.page, PORT, '팀원C')
    a.page.on('dialog', (d) => void d.accept())
  }, 180000)

  it('a name on 홈 opens the 1:1 conversation in a window over the page, which stays usable', async () => {
    await go(a.page, '/home')
    // my own name is plain text
    expect(await a.page.getByTestId('presence-서버관리자').locator('[data-member-link]').count()).toBe(0)
    await a.page.getByTestId('presence-팀원B').locator('[data-member-link]').click()
    const pb = panelOf(a.page, '팀원B')
    await pb.waitFor({ timeout: 10000 })
    expect(await a.page.evaluate(() => window.location.hash)).toContain('/home')
    // not a dialog: the menu behind it still works, and the window survives the page change
    expect(await a.page.getByRole('dialog').count()).toBe(0)
    await a.page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '주소록', exact: true }).click()
    await expect.poll(() => a.page.evaluate(() => window.location.hash)).toContain('/directory')
    expect(await pb.count()).toBe(1)
    await sendIn(pb, '작은 창에서 보냅니다')
    await expect.poll(() => pb.getByTestId('message-list').textContent(), { timeout: 10000 }).toContain('작은 창에서 보냅니다')
    await go(b.page, '/chat')
    await b.page.getByTestId('conv-서버관리자').click()
    await expect.poll(() => b.page.getByTestId('message-list').textContent(), { timeout: 10000 }).toContain('작은 창에서 보냅니다')
  })

  it('a second window; the same name again does not open a third', async () => {
    await a.page.getByTestId('member-card-팀원C').locator('[data-member-link]').click()
    await panelOf(a.page, '팀원C').waitFor({ timeout: 10000 })
    expect(await a.page.getByTestId('chat-panel').count()).toBe(2)
    // the member card's 메시지 goes to the window that is already open
    await a.page.getByTestId('member-card-팀원B').click({ position: { x: 5, y: 5 } })
    await a.page.getByRole('dialog').getByRole('button', { name: '메시지' }).click()
    await expect.poll(() => a.page.getByRole('dialog').count()).toBe(0)
    expect(await a.page.getByTestId('chat-panel').count()).toBe(2)
  })

  it('minimise: a tab with the unread count; expand; close', async () => {
    const pb = panelOf(a.page, '팀원B')
    await pb.getByRole('button', { name: '최소화' }).click()
    await expect.poll(() => pb.getAttribute('data-minimized')).toBe('true')
    await b.page.getByLabel('메시지 입력').fill('최소화한 동안 온 메시지')
    await b.page.getByLabel('메시지 입력').press('Enter')
    await expect.poll(() => pb.getByTestId('chat-tab-unread').textContent(), { timeout: 10000 }).toBe('1')
    await pb.getByTestId('chat-tab').click()
    await expect.poll(() => pb.getAttribute('data-minimized')).toBe('false')
    await expect.poll(() => pb.getByTestId('message-list').textContent(), { timeout: 10000 }).toContain('최소화한 동안 온 메시지')
    await panelOf(a.page, '팀원C').getByRole('button', { name: '창 닫기' }).click()
    await expect.poll(() => a.page.getByTestId('chat-panel').count()).toBe(1)
  })

  it('adding a third person to a 1:1 makes a new room in the same window; then remove them', async () => {
    const pb = panelOf(a.page, '팀원B')
    await pb.getByRole('button', { name: '대화방 메뉴' }).click()
    await pb.getByRole('menuitem', { name: '참가자' }).click()
    const dlg = a.page.getByRole('dialog', { name: '참가자' })
    await dlg.getByRole('checkbox', { name: '팀원C' }).check()
    await dlg.getByRole('button', { name: '추가' }).click()
    const room = panelOf(a.page, '팀원B, 팀원C')
    await room.waitFor({ timeout: 10000 })
    expect(await a.page.getByTestId('chat-panel').count()).toBe(1)
    await expect.poll(() => room.getByTestId('conv-count').textContent()).toBe('3명')
    await expect.poll(() => room.getByTestId('message-list').textContent(), { timeout: 10000 }).toContain('새 대화방을 만들었습니다')
    // the 1:1 history was not copied
    expect(await room.getByTestId('message-list').textContent()).not.toContain('작은 창에서 보냅니다')
    await go(c.page, '/chat')
    await expect.poll(() => c.page.getByTestId('conv-서버관리자, 팀원B').count(), { timeout: 10000 }).toBe(1)

    await room.getByTestId('conv-count').click()
    await dlg.getByRole('button', { name: '팀원C 내보내기' }).click()
    await expect.poll(() => dlg.getByTestId('participant-팀원C').count(), { timeout: 10000 }).toBe(0)
    await dlg.getByRole('button', { name: '닫기' }).click()
    // an unnamed room is called after the people in it, so its title is "팀원B" again
    const left = a.page.getByTestId('chat-panel')
    await expect.poll(() => left.getByTestId('message-list').textContent(), { timeout: 10000 }).toContain('서버관리자님이 팀원C님을 내보냈습니다.')
    await expect.poll(() => left.getByTestId('conv-count').textContent()).toBe('2명')
    // gone from C's list at once
    await expect.poll(() => c.page.getByTestId('conv-서버관리자, 팀원B').count(), { timeout: 10000 }).toBe(0)
  })

  it('"메신저에서 열기" moves the conversation to the messenger page', async () => {
    const room = a.page.getByTestId('chat-panel').first()
    await room.getByRole('button', { name: '메신저에서 열기' }).click()
    await expect.poll(() => a.page.evaluate(() => window.location.hash)).toContain('/chat/')
    expect(await a.page.getByTestId('chat-panel').count()).toBe(0)
    await expect.poll(() => a.page.getByTestId('conv-title').textContent()).toBe('팀원B')
    // the page view has the same 참가자 dialog
    await a.page.getByRole('button', { name: '참가자', exact: true }).click()
    await a.page.getByRole('dialog', { name: '참가자' }).getByTestId('participant-팀원B').waitFor()
  })
})
