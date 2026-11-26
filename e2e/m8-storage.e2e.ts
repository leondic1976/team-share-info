import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47909'

/** The native folder picker cannot be driven: answer it from main. */
const answerFolderPicker = (app: ElectronApplication, dir: string): Promise<void> =>
  app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [d] })) as typeof dialog.showOpenDialog
  }, dir)

const memoCount = (p: Page): Promise<number> =>
  p.evaluate(async () => (await window.teamhub.invoke('local:memos.list', { q: '' })).filter((m: { body: string }) => m.body.includes('저장위치 메모E2E')).length)

describe('M8 storage folders: personal data and server data can be moved (6.20)', () => {
  let a: Launched
  let b: Launched
  const elsewhere = mkdtempSync(join(tmpdir(), 'teamhub-e2e-move-'))
  afterAll(async () => {
    await b?.close()
    await a?.close()
    rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('setup: server A, member B with a memo and a team notice', async () => {
    a = await launch({ profile: 'e2e-m8sa' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-m8sb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    await b.page.evaluate(() => window.teamhub.invoke('local:memos.save', { body: '<p>저장위치 메모E2E</p>', color: 'yellow', tags: [] }))
    expect(await memoCount(b.page)).toBe(1)
  }, 90000)

  it('B moves personal data to another folder: app restarts, data is there, old folder emptied', async () => {
    const target = join(elsewhere, '내 자료')
    await go(b.page, '/settings')
    const card = b.page.getByTestId('storage-card-local')
    await answerFolderPicker(b.app, target)
    await card.getByTestId('storage-change').click()
    await expect.poll(() => b.page.getByTestId('storage-dialog').textContent()).toContain('옮길 자료')
    const closed = b.app.waitForEvent('close', { timeout: 30000 })
    await b.page.getByTestId('storage-confirm').click()
    await closed // E2E: the app quits instead of relaunching itself
    const userData = b.userData
    b = await launch({ userData, profile: 'e2e-m8sb' })
    await b.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 20000 })
    expect(existsSync(join(target, 'local.db'))).toBe(true)
    expect(existsSync(join(userData, 'local.db'))).toBe(false)
    expect(await memoCount(b.page)).toBe(1)
    await go(b.page, '/settings')
    await expect.poll(() => b.page.getByTestId('storage-card-local').getByTestId('storage-dir').textContent()).toBe(target)
    expect(await b.page.getByTestId('storage-last').textContent()).toContain('옮겼습니다')
  }, 90000)

  it('B moves back to the default folder', async () => {
    const card = b.page.getByTestId('storage-card-local')
    await card.getByRole('button', { name: '기본 위치로' }).click()
    const closed = b.app.waitForEvent('close', { timeout: 30000 })
    await b.page.getByTestId('storage-confirm').click()
    await closed
    const userData = b.userData
    b = await launch({ userData, profile: 'e2e-m8sb' })
    await b.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 20000 })
    expect(existsSync(join(userData, 'local.db'))).toBe(true)
    expect(existsSync(join(elsewhere, '내 자료', 'local.db'))).toBe(false)
    expect(await memoCount(b.page)).toBe(1)
  }, 90000)

  it('a folder that already holds TeamHub data cannot be moved into, only used', async () => {
    const target = join(elsewhere, '내 자료')
    await answerFolderPicker(b.app, b.userData) // the current folder itself
    await go(b.page, '/settings')
    await b.page.getByTestId('storage-card-local').getByTestId('storage-change').click()
    await expect.poll(() => b.page.getByTestId('storage-dialog').textContent()).toContain('같습니다')
    expect(await b.page.getByTestId('storage-confirm').count()).toBe(0)
    // (a folder that cannot be chosen only offers 닫기)
    await b.page.getByTestId('dialog-backdrop').getByText('닫기', { exact: true }).click()
    expect(existsSync(target)).toBe(true)
  }, 30000)

  it('A moves the server data folder while B stays connected; shared data is kept', async () => {
    const status = await a.page.evaluate(async () => {
      const c = await window.teamhub.invoke('conn:get', undefined as never)
      const r = await fetch(`${c.serverUrl}/api/notices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1' },
        body: JSON.stringify({ level: 'normal', title: '서버 이동 확인 공지E2E', bodyHtml: '<p>내용</p>', scope: { type: 'team', groupIds: [], memberIds: [] } })
      })
      return r.status
    })
    expect(status).toBe(200)
    const before = (await a.page.evaluate(() => window.teamhub.invoke('storage:info', undefined as never))).server!.dir
    const target = join(elsewhere, '서버 자료')
    await go(a.page, '/admin/backup')
    const card = a.page.getByTestId('storage-card-server')
    await expect.poll(() => card.getByTestId('storage-dir').textContent()).toBe(before)
    await answerFolderPicker(a.app, target)
    await card.getByTestId('storage-change').click()
    await a.page.getByTestId('storage-confirm').click()
    await expect.poll(async () => ((await card.getByTestId('storage-msg').count()) ? 'done' : ''), { timeout: 90000 }).toBe('done')
    const msg = await card.getByTestId('storage-msg').textContent()
    console.log('[e2e] server move:', msg)
    expect(msg).toContain('옮겼습니다')
    expect(existsSync(join(target, 'teamhub.db'))).toBe(true)
    expect(existsSync(join(before, 'teamhub.db'))).toBe(false)
    await expect.poll(() => card.getByTestId('storage-dir').textContent()).toBe(target)
    // members reconnect by themselves and see the same shared data
    await b.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    await go(b.page, '/notices')
    await expect.poll(() => b.page.getByText('서버 이동 확인 공지E2E').count(), { timeout: 20000 }).toBeGreaterThanOrEqual(1)
  }, 150000)

  it('after a restart, the server runs from the new folder', async () => {
    const userData = a.userData
    await a.close({ keepData: true })
    a = await launch({ userData, profile: 'e2e-m8sa' })
    await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    const info = await a.page.evaluate(() => window.teamhub.invoke('storage:info', undefined as never))
    expect(info.server?.dir).toBe(join(elsewhere, '서버 자료'))
    await go(a.page, '/notices')
    await expect.poll(() => a.page.getByText('서버 이동 확인 공지E2E').count(), { timeout: 20000 }).toBeGreaterThanOrEqual(1)
  }, 90000)
})
