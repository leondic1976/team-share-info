/**
 * Real auto-update check (M1-6). Not part of `pnpm e2e`: it needs an installed
 * TeamHub (per-user NSIS) and a newer installer file.
 *   TEAMHUB_INSTALLED_EXE=...\TeamHub.exe  TEAMHUB_NEW_INSTALLER=...\TeamHub-Setup-0.1.1.exe
 *   npx vitest run -c vitest.e2e.config.ts --dir e2e update-installed.e2e.ts
 */
import { describe, it, expect } from 'vitest'
import { _electron as electron } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runWizard } from './helpers'

const EXE = process.env.TEAMHUB_INSTALLED_EXE ?? ''
const NEW = process.env.TEAMHUB_NEW_INSTALLER ?? ''

function fileVersion(path: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item '${path}').VersionInfo.ProductVersion`]).toString().trim()
}

describe.skipIf(!EXE || !NEW)('installed auto-update over LAN', () => {
  it('updates the installed app from the server feed', async () => {
    const before = fileVersion(EXE)
    const userData = mkdtempSync(join(tmpdir(), 'teamhub-upd-'))
    const app = await electron.launch({
      executablePath: EXE,
      env: { ...process.env, TEAMHUB_USERDATA: userData, TEAMHUB_E2E: '1' } as Record<string, string>
    })
    const page = await app.firstWindow()
    await runWizard(page, '47893')
    await page.getByRole('link', { name: '관리', exact: true }).click()
    await page.getByRole('link', { name: '업데이트 배포' }).click()
    await page.getByLabel('설치 파일').setInputFiles(NEW)
    await page.getByRole('button', { name: '배포' }).click()
    await expect.poll(() => page.getByText(/배포했습니다/).isVisible(), { timeout: 60000 }).toBe(true)
    // update.available -> download -> footer shows the install button
    const installBtn = page.getByRole('button', { name: /설치\(다시 시작\)/ })
    await expect.poll(() => installBtn.isVisible(), { timeout: 120000 }).toBe(true)
    await installBtn.click()
    await app.waitForEvent('close', { timeout: 60000 }).catch(() => undefined)
    // NSIS silent update runs, then the app relaunches; wait for the new file version.
    await expect.poll(() => fileVersion(EXE), { timeout: 120000, interval: 2000 }).not.toBe(before)
    console.log(`updated ${before} -> ${fileVersion(EXE)}`)
  }, 400000)
})
