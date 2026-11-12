import { describe, it, expect, afterAll } from 'vitest'
import type { ElectronApplication, Page } from 'playwright-core'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { go, launch, runWizard, type Launched } from './helpers'

const PORT = '47903'

async function windowWith(app: ElectronApplication, frag: string): Promise<Page> {
  await expect.poll(() => app.windows().some((w) => w.url().includes(frag)), { timeout: 20000, interval: 500 }).toBe(true)
  const w = app.windows().find((x) => x.url().includes(frag))!
  await w.waitForLoadState('domcontentloaded')
  return w
}
const opened = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { __teamhubOpened?: string[] }).__teamhubOpened ?? [])

describe('M7 launcher and PC utilities', () => {
  let a: Launched
  afterAll(async () => {
    await a?.close()
  })

  it('setup', async () => {
    a = await launch({ profile: 'e2e-m7a' })
    await runWizard(a.page, PORT)
  }, 60000)

  it('programs installed on this PC are registered automatically', async () => {
    await go(a.page, '/launcher')
    // detection runs a few seconds after start
    await expect.poll(() => a.page.getByTestId('launcher-item').count(), { timeout: 40000, interval: 1000 }).toBeGreaterThan(0)
    const names = await a.page.getByTestId('launcher-item').allTextContents()
    console.log('[e2e] detected launcher items:', names.join(', '))
    expect(names).toContain('메모장')
    expect(names.some((n) => /Excel|Word|PowerPoint|한글|Chrome|Edge/.test(n))).toBe(true)
  }, 60000)

  it('missing targets give a clear message; a web item opens the browser', async () => {
    await a.page.evaluate(() => window.teamhub.invoke('launcher:save', { kind: 'path', name: '없는폴더E2E', target: 'C:\\no\\such\\folder', groupName: 'E2E' }))
    await a.page.evaluate(() => window.teamhub.invoke('launcher:save', { kind: 'url', name: '사이트E2E', target: 'https://example.com/e2e', groupName: 'E2E' }))
    await a.page.getByTestId('launcher-item').filter({ hasText: '없는폴더E2E' }).getByRole('button').first().click()
    await expect.poll(() => a.page.getByRole('status').textContent()).toContain('파일이나 폴더가 없습니다')
    await a.page.getByTestId('launcher-item').filter({ hasText: '사이트E2E' }).getByRole('button').first().click()
    await expect.poll(() => opened(a.app)).toContain('https://example.com/e2e')
  })

  it('team launcher: admin adds a site and a template; template opens as a new copy', async () => {
    await go(a.page, '/admin/launcher')
    await a.page.getByLabel('공용 항목 이름').fill('전자결재E2E')
    await a.page.getByLabel('공용 항목 대상').fill('https://intra.example/approval')
    await a.page.getByRole('button', { name: '추가' }).first().click()
    await expect.poll(() => a.page.getByText('전자결재E2E').count()).toBe(1)
    const dir = mkdtempSync(join(tmpdir(), 'teamhub-e2e-tpl-'))
    const tpl = join(dir, 'leave-form.txt')
    writeFileSync(tpl, 'TEMPLATE')
    await a.page.getByLabel('공용 항목 종류').selectOption('template')
    await a.page.getByLabel('공용 항목 이름').fill('휴가신청서E2E')
    await a.page.getByLabel('양식 파일').setInputFiles(tpl)
    await a.page.getByRole('button', { name: '추가' }).first().click()
    await expect.poll(() => a.page.getByText('leave-form.txt').count(), { timeout: 10000 }).toBe(1)

    await go(a.page, '/launcher')
    await a.page.getByRole('tab', { name: '팀 공용·양식함' }).click()
    await a.page.getByTestId('launcher-team').getByRole('button', { name: /휴가신청서E2E/ }).click()
    await expect.poll(async () => (await opened(a.app)).some((p) => /TeamHub 양식[\\/]leave-form_\d{8}\.txt$/.test(p)), { timeout: 10000 }).toBe(true)
    await a.page.getByTestId('launcher-team').getByRole('button', { name: /휴가신청서E2E/ }).click()
    await expect.poll(async () => (await opened(a.app)).some((p) => /leave-form_\d{8}\(2\)\.txt$/.test(p)), { timeout: 10000 }).toBe(true)
    // the copy shows in recent documents
    await a.page.getByRole('tab', { name: '최근 문서' }).click()
    await expect.poll(() => a.page.getByTestId('recent-docs').textContent()).toContain('leave-form_')
  })

  it('quick launcher window finds items', async () => {
    await a.page.evaluate(() => window.teamhub.invoke('launcher:openBar', undefined as never))
    const bar = await windowWith(a.app, '/popup/launcher')
    await bar.getByLabel('실행할 항목 검색').fill('전자결재')
    await expect.poll(() => bar.getByRole('option').count()).toBe(1)
    await bar.keyboard.press('Enter').catch(() => undefined)
    await expect.poll(() => opened(a.app)).toContain('https://intra.example/approval')
  })

  it('PC resources, network diagnosis and temp list', async () => {
    await go(a.page, '/utilities')
    await expect.poll(() => a.page.getByTestId('sys-resources').textContent(), { timeout: 15000 }).toMatch(/CPU\d+%/)
    await a.page.getByRole('tab', { name: '네트워크 진단' }).click()
    await a.page.getByRole('button', { name: '진단 시작' }).click()
    await expect.poll(() => a.page.getByTestId('net-steps').textContent(), { timeout: 60000 }).toContain('TeamHub 서버')
    expect(await a.page.getByTestId('net-steps').textContent()).toContain('연결됨')
    await a.page.getByRole('tab', { name: '임시 파일 정리' }).click()
    await a.page.getByTestId('temp-list').waitFor()
  }, 90000)

  it('security check runs locally, includes designated programs and stays on this PC', async () => {
    await go(a.page, '/admin/launcher')
    await a.page.getByLabel('보안프로그램 이름').fill('E2E보안')
    await a.page.getByLabel('프로세스 이름').fill('electron.exe')
    await a.page.getByRole('button', { name: '추가' }).last().click()
    await expect.poll(() => a.page.getByText('E2E보안').count()).toBe(1)
    await go(a.page, '/utilities')
    await a.page.getByRole('tab', { name: '보안 점검' }).click()
    await a.page.getByRole('button', { name: '보안 점검 시작' }).click()
    const rows = a.page.locator('[data-testid="security-items"] [data-status]')
    await expect.poll(() => rows.count(), { timeout: 100000, interval: 2000 }).toBeGreaterThanOrEqual(9)
    const summary = await rows.evaluateAll((els) => els.map((e) => `${e.querySelector('.font-semibold')?.textContent}=${e.getAttribute('data-status')}`))
    console.log('[e2e] security:', summary.join(' | '))
    expect(await a.page.locator('[data-testid="security-items"] [data-status="good"]').filter({ hasText: 'E2E보안' }).count()).toBe(1)
    // most checks should be readable without admin rights
    expect(summary.filter((s) => s.endsWith('=unknown')).length).toBeLessThanOrEqual(3)
    // nothing about the check reached the server
    const acts = await a.page.evaluate(async () => {
      const c = await window.teamhub.invoke('conn:get', undefined as never)
      const r = await fetch(`${c.serverUrl}/api/admin/activity?limit=200`, { headers: { Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1' } })
      return JSON.stringify(await r.json())
    })
    expect(acts).not.toMatch(/security_result|security\.run|bitlocker/i)
    expect((await a.page.evaluate(() => window.teamhub.invoke('security:history', undefined as never))).length).toBe(1)
  }, 150000)
})
