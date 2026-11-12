import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { launch, runWizard, type Launched } from './helpers'

const MENUS = ['홈', '공지', '일정', '자료실', '회의', '메신저', '할 일', '게시판', '주소록', '기록', '다이어리', '메모', '알람', '지식 노트', '내 파일', '런처', '유틸리티', '설정', '도움말', '관리']

describe('M0 app shell', () => {
  let l: Launched
  beforeAll(async () => {
    l = await launch()
    await runWizard(l.page, '47891')
  })
  afterAll(async () => {
    await l.close()
  })

  it('navigates every menu', async () => {
    const { page } = l
    for (const label of MENUS) {
      await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: label, exact: true }).click()
      await expect.poll(() => page.locator('main h1').first().textContent()).toContain(label)
    }
  })

  it('shows the manual on F1', async () => {
    const { page } = l
    await page.getByRole('link', { name: '홈', exact: true }).click()
    await page.keyboard.press('F1')
    await expect.poll(() => page.getByTestId('manual').textContent()).toContain('TeamHub 개요')
    await page.getByRole('button', { name: '관리 (관리자 전용)' }).click()
    await expect.poll(() => page.getByTestId('manual').textContent()).toContain('승인 관리')
  })

  it('keeps the status bar visible at minimum window size', async () => {
    const { app, page } = l
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.unmaximize()
      w.setSize(1024, 680)
    })
    await page.waitForTimeout(300)
    const bar = page.getByTestId('status-bar')
    await expect.poll(() => bar.isVisible()).toBe(true)
    const box = await bar.boundingBox()
    const vh = await page.evaluate(() => window.innerHeight)
    expect(box).not.toBeNull()
    expect(box!.y + box!.height).toBeLessThanOrEqual(vh + 1)
    expect(await bar.textContent()).toContain('공유할 수 없습니다')
  })

  it('persists theme and font size in the local db', async () => {
    const { page } = l
    await page.getByRole('link', { name: '설정', exact: true }).click()
    await page.getByRole('radio', { name: '어둡게' }).click()
    await page.getByRole('button', { name: '글자 크게' }).click()
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true)
    await expect.poll(() => page.getByTestId('font-size').textContent()).toBe('15px')
    const dbPath = await page.getByTestId('local-db-path').textContent()
    expect(dbPath).toContain(l.userData)

    await l.close({ keepData: true })
    l = await launch({ userData: l.userData })
    const p2 = l.page
    await p2.getByRole('link', { name: '설정', exact: true }).click()
    await expect.poll(() => p2.getByTestId('font-size').textContent()).toBe('15px')
    expect(await p2.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true)
  })
})
