import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47898'
const SHOTS = process.env.TEAMHUB_SHOT_DIR

/** With TEAMHUB_SHOT_DIR set: a screenshot in the light and in the dark theme. */
async function shot(p: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await p.waitForTimeout(400)
  await p.screenshot({ path: `${SHOTS}/${name}-light.png` })
  await p.evaluate(() => document.documentElement.classList.add('dark'))
  await p.waitForTimeout(300)
  await p.screenshot({ path: `${SHOTS}/${name}-dark.png` })
  await p.evaluate(() => document.documentElement.classList.remove('dark'))
}
const attach = join(tmpdir(), 'teamhub-e2e-chat-attach.txt')

async function closeDialog(p: Page): Promise<void> {
  await p.getByRole('dialog').getByRole('button', { name: '닫기' }).first().click()
  await expect.poll(() => p.getByRole('dialog').count()).toBe(0)
}

async function sendText(p: Page, text: string): Promise<void> {
  await p.getByLabel('메시지 입력').fill(text)
  await p.getByLabel('메시지 입력').press('Enter')
}

describe('M5 messenger and notes', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
    rmSync(attach, { force: true })
  })

  it('setup', async () => {
    a = await launch({ profile: 'e2e-m5a' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-m5b' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
  })

  it('1:1 chat round trip with read receipts', async () => {
    await go(a.page, '/chat')
    await a.page.getByRole('button', { name: '새 대화' }).click()
    await a.page.getByRole('dialog').getByLabel('팀원B').check()
    await a.page.getByRole('button', { name: '대화 시작' }).click()
    await expect.poll(() => a.page.getByTestId('conv-title').textContent()).toBe('팀원B')
    await sendText(a.page, '안녕하세요 E2E')
    await expect.poll(() => a.page.getByTestId('unread-by').last().textContent(), { timeout: 10000 }).toBe('1')
    // B sees the unread badge on the menu, opens the chat and reads
    await expect.poll(() => b.page.getByRole('link', { name: /메신저 \(1\)/ }).count(), { timeout: 10000 }).toBe(1)
    await go(b.page, '/chat')
    await b.page.getByTestId('conv-서버관리자').click()
    await expect.poll(() => b.page.getByTestId('message-list').textContent(), { timeout: 10000 }).toContain('안녕하세요 E2E')
    await b.page.bringToFront()
    await b.page.evaluate(() => window.dispatchEvent(new Event('focus')))
    // A: the "1" disappears once B has read it
    await expect.poll(() => a.page.getByTestId('unread-by').count(), { timeout: 15000 }).toBe(0)
    await sendText(b.page, '반갑습니다')
    await expect.poll(() => a.page.getByTestId('message-list').textContent(), { timeout: 10000 }).toContain('반갑습니다')
  })

  it('file message', async () => {
    writeFileSync(attach, 'attachment body')
    await a.page.getByLabel('보낼 파일').setInputFiles(attach)
    await expect.poll(() => b.page.getByTestId('message-list').textContent(), { timeout: 15000 }).toContain('teamhub-e2e-chat-attach.txt')
    // B fetches the file and opens it in one go; afterwards the line says where it went
    const chip = b.page.getByTestId('file-chip').last()
    await chip.getByRole('button', { name: '열기' }).click()
    await expect.poll(() => chip.getByTestId('file-chip-done').textContent(), { timeout: 15000 }).toContain('저장하고 열었습니다')
    const opened = await b.app.evaluate(() => (globalThis as unknown as { __teamhubOpened?: string[] }).__teamhubOpened ?? [])
    const got = opened.find((x) => x.endsWith('teamhub-e2e-chat-attach.txt'))
    expect(got, opened.join(', ')).toBeTruthy()
    expect(readFileSync(got!, 'utf8')).toBe('attachment body')
    // saving again does not overwrite: the copy gets a free name
    await chip.getByRole('button', { name: '저장' }).click()
    await expect.poll(() => chip.getByTestId('file-chip-done').textContent(), { timeout: 15000 }).toContain('저장했습니다')
    expect(readFileSync(got!, 'utf8')).toBe('attachment body')
  })

  it('messages sent while B is offline appear after B connects', async () => {
    await b.close({ keepData: true })
    await sendText(a.page, '꺼져 있을 때 보낸 메시지')
    b = await launch({ profile: 'e2e-m5b', userData: b.userData })
    await b.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 20000 })
    await go(b.page, '/chat')
    await b.page.getByTestId('conv-서버관리자').click()
    await expect.poll(() => b.page.getByTestId('message-list').textContent(), { timeout: 10000 }).toContain('꺼져 있을 때 보낸 메시지')
  })

  it('notes: send and read receipt', async () => {
    await a.page.getByRole('button', { name: '쪽지', exact: true }).click()
    await a.page.getByRole('button', { name: '쪽지 쓰기' }).click()
    await a.page.getByRole('dialog').getByLabel('팀원B').check()
    await a.page.getByLabel('쪽지 내용').fill('3시에 전화 주세요')
    await a.page.getByRole('dialog').getByRole('button', { name: '보내기' }).click()
    await b.page.getByRole('button', { name: '쪽지', exact: true }).click()
    await expect.poll(() => b.page.getByTestId('note-item').first().textContent(), { timeout: 10000 }).toContain('3시에 전화 주세요')
    await b.page.getByTestId('note-item').first().click()
    await b.page.getByRole('dialog').getByRole('button', { name: '닫기' }).click()
    await a.page.getByRole('button', { name: '보낸 쪽지' }).click()
    await expect.poll(() => a.page.getByTestId('note-item').first().textContent(), { timeout: 10000 }).toContain('읽음 1/1')
  })

  it('leave (inside the conversation): the 1:1 goes from my list after a confirmation and returns when the other writes', async () => {
    await go(b.page, '/chat')
    await b.page.getByRole('button', { name: '대화', exact: true }).click()
    await b.page.getByTestId('conv-서버관리자').click()
    const convId = (await b.page.evaluate(() => window.location.hash)).split('/chat/')[1]!
    // saying no keeps it
    let asked = ''
    b.page.once('dialog', (d) => {
      asked = d.message()
      void d.dismiss()
    })
    // the rows of the list carry no 나가기 any more (지시 82); it is in the conversation's header
    expect(await b.page.getByTestId(`conv-leave-${convId}`).count()).toBe(0)
    await b.page.getByRole('button', { name: '대화방 나가기' }).click()
    expect(asked).toContain('내 목록에서 지울까요')
    expect(asked).toContain('다시 나타납니다')
    expect(await b.page.getByTestId('conv-서버관리자').count()).toBe(1)
    // saying yes removes it and closes the open conversation
    b.page.once('dialog', (d) => void d.accept())
    await b.page.getByRole('button', { name: '대화방 나가기' }).click()
    await expect.poll(() => b.page.getByTestId('conv-서버관리자').count(), { timeout: 10000 }).toBe(0)
    await expect.poll(() => b.page.evaluate(() => window.location.hash)).toBe('#/chat')
    // the other person writes again: it is back, with the earlier messages
    await go(a.page, '/chat')
    await a.page.getByRole('button', { name: '대화', exact: true }).click()
    await a.page.getByTestId('conv-팀원B').click()
    await sendText(a.page, '나간 뒤에 보낸 메시지')
    await b.page.getByTestId('conv-서버관리자').waitFor({ timeout: 15000 })
    await b.page.getByTestId('conv-서버관리자').click()
    await expect.poll(() => b.page.getByTestId('message-list').textContent(), { timeout: 10000 }).toContain('나간 뒤에 보낸 메시지')
    expect(await b.page.getByTestId('message-list').textContent()).toContain('꺼져 있을 때 보낸 메시지')
  })

  it('새 대화 and 쪽지 쓰기 pickers show each person as 온라인 / 오프라인, live', async () => {
    const state = (): Promise<string | null> => a.page.getByRole('dialog').getByTestId('picker-presence-팀원B').getAttribute('data-presence')
    const label = (): Promise<string | null> => a.page.getByRole('dialog').getByTestId('picker-presence-팀원B').textContent()
    await go(a.page, '/chat')
    await a.page.getByRole('button', { name: '대화', exact: true }).click()
    await a.page.getByRole('button', { name: '새 대화' }).click()
    await expect.poll(state, { timeout: 10000 }).toBe('online')
    expect(await label()).toBe('온라인')
    await shot(a.page, 'presence-newchat')
    await closeDialog(a.page)
    // back on the 쪽지 tab, the earlier [쪽지 쓰기] press does not reopen the dialog by itself
    await a.page.getByRole('button', { name: '쪽지', exact: true }).click()
    await a.page.getByRole('button', { name: '받은 쪽지' }).waitFor()
    expect(await a.page.getByRole('dialog').count()).toBe(0)
    await a.page.getByRole('button', { name: '쪽지 쓰기' }).click()
    await expect.poll(state, { timeout: 10000 }).toBe('online')
    // the chosen person's chip carries the dot too
    await a.page.getByRole('dialog').getByLabel('팀원B').check()
    expect(await a.page.getByRole('dialog').locator('[aria-label="온라인"]').count()).toBe(2)
    await shot(a.page, 'presence-note')
    // B closes the app: the open picker turns to 오프라인 without reopening
    await b.close({ keepData: true })
    await expect.poll(state, { timeout: 15000 }).toBe('offline')
    expect(await label()).toBe('오프라인')
    await shot(a.page, 'presence-note-offline')
    await closeDialog(a.page)
    await a.page.getByRole('button', { name: '대화', exact: true }).click()
    await a.page.getByRole('button', { name: '새 대화' }).click()
    await expect.poll(state, { timeout: 10000 }).toBe('offline')
    expect(await label()).toBe('오프라인')
    await closeDialog(a.page)
  })
})
