import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

export interface Launched {
  app: ElectronApplication
  page: Page
  userData: string
  close: (opts?: { keepData?: boolean }) => Promise<void>
}

/** Launch the built app (pnpm build first) with an isolated userData folder. */
export async function launch(opts: { userData?: string; profile?: string; env?: Record<string, string> } = {}): Promise<Launched> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'teamhub-e2e-'))
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      TEAMHUB_USERDATA: userData,
      TEAMHUB_PROFILE: opts.profile ?? 'e2e',
      TEAMHUB_E2E: '1',
      ...opts.env
    } as Record<string, string>
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return {
    app,
    page,
    userData,
    close: async ({ keepData = false } = {}) => {
      await app.evaluate(({ app: a }) => {
        a.exit(0)
      }).catch(() => undefined)
      await app.close().catch(() => undefined)
      if (!keepData) rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
}

/** Complete the first-run server wizard with defaults (isolated data dir). */
export async function runWizard(page: Page, PORT: string): Promise<void> {
  await page.getByRole('button', { name: /이 PC를 서버로 사용/ }).click()
  await page.getByLabel('기관/회사명').fill('E2E기관')
  await page.getByLabel('소속 팀명').fill('검증팀')
  await page.getByRole('button', { name: '다음' }).click()
  await page.getByLabel('관리자 이름').fill('서버관리자')
  await page.getByRole('button', { name: '다음' }).click()
  await page.getByLabel('포트').fill(PORT)
  await page.getByLabel('허용 IP 대역').fill('')
  await page.getByRole('button', { name: '다음' }).click()
  await page.getByRole('button', { name: '다음' }).click() // storage (suggested dir inside isolated userData)
  await page.getByRole('button', { name: '다음' }).click() // backup
  await page.getByRole('button', { name: '다음' }).click() // notice
  await page.getByRole('button', { name: '다음' }).click() // ops
  await page.getByRole('button', { name: '설정 완료' }).click()
  await page.getByTestId('server-address').first().waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: '시작하기' }).click()
  // Let the main shell mount (it redirects / -> /home) before tests navigate.
  await page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 20000 })
  await page.waitForTimeout(500)
}


/** Member PC: request access to the server at 127.0.0.1:port; the admin page approves it. */
export async function joinAndApprove(admin: Page, member: Page, port: string, name: string): Promise<void> {
  await member.getByRole('button', { name: /서버에 접속/ }).click()
  await member.getByLabel('서버 주소').fill(`127.0.0.1:${port}`)
  await member.getByRole('button', { name: '연결 확인' }).click()
  await member.getByLabel('이름', { exact: true }).fill(name)
  await member.getByLabel('안내 동의').check()
  await member.getByRole('button', { name: '사용 신청' }).click()
  await member.getByTestId('pending').waitFor({ timeout: 10000 })
  await admin.evaluate(() => (window.location.hash = '/admin/approvals'))
  await admin.getByTestId('join-request').first().waitFor({ timeout: 10000 })
  await admin.getByRole('button', { name: '승인' }).first().click()
  await member.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 15000 })
}

export async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => (window.location.hash = h), hash)
}
