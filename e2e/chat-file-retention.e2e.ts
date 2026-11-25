import { describe, it, expect, afterAll } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47952'
const DAY = 86_400_000

/** What Ctrl+V of a screen capture does: a paste event that carries an image file. */
async function pasteImage(p: Page): Promise<void> {
  await p.getByLabel('메시지 입력').evaluate((el) => {
    const b64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
}

async function openConv(p: Page, title: string): Promise<void> {
  await go(p, '/home')
  await go(p, '/chat')
  await p.getByTestId(`conv-${title}`).click()
}

describe('메신저 파일 보관 기간 (지시 109): old files are deleted from the server PC, the messages stay', () => {
  let a: Launched
  let b: Launched
  let dataDir = ''
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup: a file and a pasted picture in a 1:1 conversation', async () => {
    a = await launch({ profile: 'e2e-cfa' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-cfb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    await go(a.page, '/chat')
    await a.page.getByRole('button', { name: '새 대화' }).click()
    await a.page.getByRole('dialog').getByLabel('팀원B').check()
    await a.page.getByRole('button', { name: '대화 시작' }).click()
    await expect.poll(() => a.page.getByTestId('conv-title').textContent()).toBe('팀원B')
    await a.page
      .getByLabel('보낼 파일')
      .setInputFiles({
        name: '오래된 보고서.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('report body')
      })
    await expect.poll(() => a.page.getByTestId('file-chip').count(), { timeout: 15000 }).toBe(1)
    await pasteImage(a.page)
    await a.page.getByTestId('staged-files').waitFor({ timeout: 5000 })
    await a.page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect
      .poll(() => a.page.getByTestId('message-list').locator('img').count(), { timeout: 15000 })
      .toBe(1)
    await a.page.getByLabel('메시지 입력').fill('파일 보냈어요E2E')
    await a.page.getByLabel('메시지 입력').press('Enter')
    await openConv(b.page, '서버관리자')
    await expect
      .poll(() => b.page.getByTestId('message-list').textContent(), { timeout: 15000 })
      .toContain('파일 보냈어요E2E')
    expect(await b.page.getByTestId('file-chip').count()).toBe(1)
    dataDir = await a.page.evaluate(async () => {
      const c = await window.teamhub.invoke('conn:get', undefined as never)
      const r = await fetch(`${c.serverUrl}/api/admin/status`, {
        headers: {
          Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`,
          'X-Win-User': encodeURIComponent(c.winUser),
          'X-Protocol': '1'
        }
      })
      return (await r.json()).data.dataDir as string
    })
    expect(dataDir).toBeTruthy()
  }, 150000)

  it('the admin sees the setting (90 days by default) with what it deletes', async () => {
    await go(a.page, '/admin/settings')
    const sel = a.page.getByLabel('메시지 파일 보관 기간')
    await sel.waitFor({ timeout: 10000 })
    expect(await sel.inputValue()).toBe('90')
    const options = await sel.locator('option').allTextContents()
    expect(options[0]).toContain('90일')
    expect(options.some((o) => o.includes('무기한'))).toBe(true)
    const hint = a.page.getByTestId('message-file-retention-hint')
    expect(await hint.textContent()).toContain('서버 PC에서 지웁니다')
    await expect.poll(() => hint.textContent(), { timeout: 10000 }).toContain('아직 지운 파일 없음')
  }, 30000)

  it('files 100 days old: after the server starts again they show as deleted, the text stays', async () => {
    const dataA = a.userData
    await a.close({ keepData: true })
    // age the two files (and their messages) as if they had been sent 100 days ago
    const db = new DatabaseSync(join(dataDir, 'teamhub.db'))
    const t = Date.now() - 100 * DAY
    db.prepare(`UPDATE messages SET created_at = ? WHERE kind IN ('file','image')`).run(t)
    db.prepare(`UPDATE attachments SET created_at = ? WHERE owner_type = 'message'`).run(t)
    db.close()
    a = await launch({ profile: 'e2e-cfa', userData: dataA })
    await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    // the job runs a few seconds after the start (E2E)
    await a.page.waitForTimeout(5000)
    await openConv(a.page, '팀원B')
    await expect.poll(() => a.page.getByTestId('file-expired').count(), { timeout: 15000 }).toBe(2)
    expect(await a.page.getByTestId('file-chip').count()).toBe(0)
    const list = (await a.page.getByTestId('message-list').textContent()) ?? ''
    expect(list).toContain('보관 기간이 지나 서버에서 삭제된 파일입니다.')
    expect(list).toContain('오래된 보고서.txt')
    expect(list).toContain('파일 보냈어요E2E')
    // the other PC, after reopening the conversation
    await b.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    await openConv(b.page, '서버관리자')
    await expect.poll(() => b.page.getByTestId('file-expired').count(), { timeout: 15000 }).toBe(2)
    expect(await b.page.getByTestId('message-list').textContent()).toContain('파일 보냈어요E2E')
    // the admin's settings tell what the cleanup did
    await go(a.page, '/admin/settings')
    await expect
      .poll(() => a.page.getByTestId('message-file-retention-hint').textContent(), { timeout: 10000 })
      .toContain('파일 2개')
  }, 150000)
})
