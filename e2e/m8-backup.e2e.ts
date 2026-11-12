import { describe, it, expect, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { go, launch, runWizard, type Launched } from './helpers'

const PORT = '47907'

const apiPost = (p: Page, path: string, body: unknown): Promise<{ status: number; data: { id?: string; name?: string } }> =>
  p.evaluate(
    async ({ path: u, body: b }) => {
      const c = await window.teamhub.invoke('conn:get', undefined as never)
      const r = await fetch(`${c.serverUrl}${u}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1' },
        body: JSON.stringify(b)
      })
      return { status: r.status, data: (await r.json()).data }
    },
    { path, body }
  )

describe('M8-1 backup and moving the server to another PC (profile)', () => {
  let a: Launched
  let c: Launched
  let backupFolder = ''
  afterAll(async () => {
    await c?.close()
    await a?.close()
  })

  it('A: data, then "지금 백업" in the admin screen', async () => {
    a = await launch({ profile: 'e2e-m8a' })
    a.page.on('dialog', (d) => void d.accept())
    await runWizard(a.page, PORT)
    const n = await apiPost(a.page, '/api/notices', { level: 'normal', title: '이전 확인 공지E2E', bodyHtml: '<p>옮겨 왔나요?</p>', scope: { type: 'team', groupIds: [], memberIds: [] } })
    expect(n.status).toBe(200)
    await go(a.page, '/admin/backup')
    await a.page.getByRole('button', { name: '지금 백업' }).click()
    await expect.poll(() => a.page.getByTestId('backup-item').count(), { timeout: 20000 }).toBe(1)
    backupFolder = await a.page.evaluate(async () => {
      const c = await window.teamhub.invoke('conn:get', undefined as never)
      const r = await fetch(`${c.serverUrl}/api/admin/backups`, { headers: { Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1' } })
      return ((await r.json()).data.backups[0] as { path: string }).path
    })
    console.log('[e2e] backup folder', backupFolder)
    expect(existsSync(join(backupFolder, 'teamhub.db'))).toBe(true)
  }, 90000)

  it('C (new PC): first run → "기존 서버 옮겨 오기" → same data, signed in as the admin', async () => {
    await a.close({ keepData: true }) // the old server is switched off
    c = await launch({ profile: 'e2e-m8c' })
    await c.page.getByRole('button', { name: /기존 서버의 백업으로/ }).click()
    await c.page.getByLabel('백업 폴더').fill(backupFolder)
    await c.page.getByLabel('백업 폴더').blur()
    await expect.poll(() => c.page.getByTestId('backup-info').textContent(), { timeout: 10000 }).toContain('E2E기관')
    await c.page.getByRole('button', { name: '옮겨 오기' }).click()
    await c.page.getByTestId('import-done').waitFor({ timeout: 30000 })
    await c.page.getByRole('button', { name: '시작하기' }).click()
    await c.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 20000 })
    await go(c.page, '/notices')
    await expect.poll(() => c.page.getByText('이전 확인 공지E2E').count(), { timeout: 15000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(() => c.page.getByTestId('team-name').textContent()).toBe('검증팀')
  }, 120000)
})
