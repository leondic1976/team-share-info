import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { go, launch, runWizard, type Launched } from './helpers'

const PORT = '47907'
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

const apiPut = (p: Page, path: string, body: unknown): Promise<number> =>
  p.evaluate(
    async ({ path: u, body: b }) => {
      const c = await window.teamhub.invoke('conn:get', undefined as never)
      const r = await fetch(`${c.serverUrl}${u}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1' },
        body: JSON.stringify(b)
      })
      return r.status
    },
    { path, body }
  )

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
    // no backup folder set: the backups are in the server data folder, on the same drive
    await a.page.getByTestId('backup-warn-same-drive').waitFor({ timeout: 10000 })
    await expect.poll(() => a.page.getByTestId('backup-warn-failed').count()).toBe(0)
    await shot(a.page, 'backup-same-drive')
  }, 90000)

  it('A: a failed backup is shown on 백업·복구 and 서버 상태, and the server PC gets one reminder card', async () => {
    // a backup folder that was fine when it was saved and is gone later, like a USB drive that was taken out
    // (saving an unusable folder is refused, 지시 132): after saving, the folder becomes a file
    const usb = join(a.userData, 'usb-backup')
    mkdirSync(usb, { recursive: true })
    // the daily slot set late, so today's automatic run is not about to start (that holds the reminder back for up to a minute)
    expect(await apiPut(a.page, '/api/admin/settings', { backup: { dir: usb, time: '23:59' } })).toBe(200)
    rmSync(usb, { recursive: true, force: true })
    writeFileSync(usb, 'x')
    await go(a.page, '/admin/backup')
    await a.page.getByRole('button', { name: '지금 백업' }).click()
    await a.page.getByTestId('backup-warn-failed').filter({ hasText: '마지막 백업이 실패했습니다' }).waitFor({ timeout: 10000 })
    await shot(a.page, 'backup-failed')
    await go(a.page, '/admin/status')
    await a.page.getByTestId('backup-warn-failed').waitFor({ timeout: 10000 })
    await expect.poll(() => a.page.getByTestId('status-backup').textContent()).toContain('마지막 시도 실패')
    await shot(a.page, 'status-backup-failed')
    // "백업 위치 바꾸기" opens 조직·운영 설정 on the backup location
    await a.page.getByTestId('backup-warn-same-drive').getByRole('button', { name: '백업 위치 바꾸기' }).click()
    await expect.poll(() => a.page.evaluate(() => document.activeElement?.id), { timeout: 10000 }).toBe('backup-dir')
    await shot(a.page, 'settings-backup-dir')

    // the reminder card comes after a reload (the hook checks a few seconds after going online), once a day
    const toasts = (): Promise<string[]> =>
      a.app.evaluate(() => ((globalThis as unknown as { __teamhubToasts?: { title: string; route?: string }[] }).__teamhubToasts ?? []).map((t) => `${t.title}>${t.route}`))
    await a.page.reload()
    await expect.poll(toasts, { timeout: 30000 }).toContain('서버 백업이 실패했습니다>/admin/backup')
    expect(await a.page.evaluate(() => localStorage.getItem('teamhub.backupReminder'))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // once a day: another reload does not repeat it
    await a.page.reload()
    await a.page.waitForTimeout(8000)
    expect((await toasts()).filter((t) => t.startsWith('서버 백업')).length).toBe(1)
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
