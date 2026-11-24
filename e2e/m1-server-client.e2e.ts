import { describe, it, expect, afterAll } from 'vitest'
import { launch, runWizard, type Launched } from './helpers'

const PORT = '47890'

describe('M1 server + member', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('sets up the server through the wizard', async () => {
    a = await launch({ profile: 'e2e-a' })
    await runWizard(a.page, PORT)
    await expect.poll(() => a.page.getByTestId('conn-state').textContent(), { timeout: 20000 }).toContain('서버 연결됨')
    expect(await a.page.getByTestId('org-text').textContent()).toBe('E2E기관 검증팀')
    await expect.poll(() => a.page.getByTestId('presence-서버관리자').getAttribute('data-presence')).toBe('online')
  })

  it('member finds the server, requests access and waits', async () => {
    b = await launch({ profile: 'e2e-b' })
    const p = b.page
    await p.getByRole('button', { name: /서버에 접속/ }).click()
    await p.getByLabel('서버 주소').fill(`127.0.0.1:${PORT}`)
    await p.getByRole('button', { name: '연결 확인' }).click()
    await p.getByLabel('이름', { exact: true }).fill('팀원B')
    await p.getByLabel('소속', { exact: true }).fill('검증팀')
    await p.getByLabel('안내 동의').check()
    await p.getByRole('button', { name: '사용 신청' }).click()
    await expect.poll(() => p.getByTestId('pending').isVisible(), { timeout: 10000 }).toBe(true)
  })

  it('the server PC is told about the request (notification, menu badge, tray)', async () => {
    const toasts = (): Promise<string> =>
      a.app.evaluate(() => ((globalThis as unknown as { __teamhubToasts?: { title: string; route?: string }[] }).__teamhubToasts ?? []).map((t) => `${t.title}>${t.route}`).join('|'))
    await expect.poll(toasts, { timeout: 10000 }).toContain('사용 신청 · 팀원B · 검증팀>/admin/approvals')
    await expect.poll(() => a.page.getByRole('link', { name: '관리 (1)', exact: true }).isVisible(), { timeout: 10000 }).toBe(true)
  })

  it('admin approves and the member enters the app', async () => {
    const p = a.page
    await p.getByRole('link', { name: '관리 (1)', exact: true }).click()
    await expect.poll(() => p.getByTestId('join-request').count(), { timeout: 10000 }).toBe(1)
    await p.getByRole('button', { name: '승인' }).click()
    await expect.poll(() => b.page.getByTestId('conn-state').textContent(), { timeout: 15000 }).toContain('서버 연결됨')
    expect(await b.page.getByTestId('org-text').textContent()).toBe('E2E기관 검증팀')
    await expect.poll(() => p.getByRole('link', { name: '관리', exact: true }).isVisible(), { timeout: 10000 }).toBe(true)
    await p.getByRole('link', { name: '홈', exact: true }).click()
    await expect.poll(() => p.getByTestId('presence-팀원B').getAttribute('data-presence'), { timeout: 10000 }).toBe('online')
  })

  it('notice text change reaches the member live', async () => {
    const p = a.page
    await p.getByRole('link', { name: '관리', exact: true }).click()
    await p.getByRole('link', { name: '조직·운영 설정' }).click()
    await p.getByLabel('하단 안내문').fill('E2E 안내문 변경')
    await p.getByRole('button', { name: '설정 저장' }).click()
    await expect.poll(() => b.page.getByTestId('notice-text').textContent(), { timeout: 10000 }).toBe('E2E 안내문 변경')
  })

  it('member reconnects after the server restarts', async () => {
    const p = a.page
    await p.getByRole('link', { name: '설정', exact: true }).click()
    await p.getByRole('button', { name: '서버 다시 시작' }).click()
    await expect.poll(() => a.page.getByTestId('server-state').textContent(), { timeout: 20000 }).toContain('실행 중')
    await expect.poll(() => b.page.getByTestId('conn-state').textContent(), { timeout: 30000 }).toContain('서버 연결됨')
  })

  it('revoking the device blocks the member immediately', async () => {
    const p = a.page
    await p.getByRole('link', { name: '관리', exact: true }).click()
    await p.getByRole('link', { name: '구성원·PC' }).click()
    await p.getByTestId('device-row-팀원B').getByRole('button', { name: '차단', exact: true }).click()
    await expect.poll(() => b.page.getByRole('heading', { name: '사용이 중지되었습니다' }).isVisible(), { timeout: 10000 }).toBe(true)
  })

  it('restarting the server app keeps the identity (auto start)', async () => {
    await a.close({ keepData: true })
    a = await launch({ profile: 'e2e-a', userData: a.userData })
    await expect.poll(() => a.page.getByTestId('conn-state').textContent(), { timeout: 30000 }).toContain('서버 연결됨')
  })
})
