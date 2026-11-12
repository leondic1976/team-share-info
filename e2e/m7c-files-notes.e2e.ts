import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { go, launch, runWizard, type Launched } from './helpers'

const PORT = '47904'

describe('M7-C personal files, search, organization, sites, notes', () => {
  let a: Launched
  let work = ''
  afterAll(async () => {
    await a?.close()
  })

  it('setup', async () => {
    a = await launch({ profile: 'e2e-m7c' })
    a.page.on('dialog', (d) => void d.accept())
    await runWizard(a.page, PORT)
    // ASCII names in the test process (13.13: Vitest crashes creating Korean file names)
    work = join(a.userData, 'work')
    mkdirSync(join(work, 'docs'), { recursive: true })
    writeFileSync(join(work, 'report-2026.txt'), 'r')
    writeFileSync(join(work, 'budget-plan.xlsx'), 'b')
    writeFileSync(join(work, 'docs', 'minutes-0115.hwp'), 'm')
  }, 60000)

  it('explorer: browse, new folder, rename, copy/paste, recycle bin; system folders are protected', async () => {
    const p = a.page
    await go(p, '/myfiles/explorer')
    await p.getByTestId('fm-crumbs').click()
    await p.getByLabel('경로').fill(work)
    await p.getByLabel('경로').press('Enter')
    await expect.poll(() => p.getByTestId('fm-entry').count()).toBe(3)
    await p.getByRole('button', { name: '새 폴더' }).click()
    const name = p.getByLabel('새 이름')
    await name.fill('보관함')
    await name.press('Enter')
    await expect.poll(() => existsSync(join(work, '보관함'))).toBe(true)
    // copy the report into the new folder
    await p.locator('[data-testid="fm-entry"][data-name="report-2026.txt"]').click()
    await p.getByRole('button', { name: '복사', exact: true }).click()
    await p.locator('[data-testid="fm-entry"][data-name="보관함"]').dblclick()
    await expect.poll(() => p.getByTestId('fm-crumbs').textContent()).toContain('보관함')
    await p.getByRole('button', { name: /붙여넣기/ }).click()
    await expect.poll(() => existsSync(join(work, '보관함', 'report-2026.txt'))).toBe(true)
    // paste again: never overwrites
    await p.getByRole('button', { name: /붙여넣기/ }).click()
    await expect.poll(() => existsSync(join(work, '보관함', 'report-2026 (2).txt'))).toBe(true)
    await p.locator('[data-testid="fm-entry"][data-name="report-2026 (2).txt"]').click()
    await p.getByRole('button', { name: '휴지통으로' }).click()
    await expect.poll(() => existsSync(join(work, '보관함', 'report-2026 (2).txt'))).toBe(false)
    const denied = await p.evaluate(() => window.teamhub.invoke('fm:rename', { path: 'C:\\Windows\\win.ini', name: 'x.ini' }))
    expect(denied.ok).toBe(false)
    expect(await p.evaluate(() => window.teamhub.invoke('fm:trash', { paths: ['C:\\Program Files'] }))).toMatchObject({ ok: false })
  })

  it('fast search: index, instant results, filters, live changes', async () => {
    const p = a.page
    await p.evaluate((w) => window.teamhub.invoke('fsx:addRoot', { path: w }), work)
    await p.evaluate(() => window.teamhub.invoke('fsx:watchNow', undefined as never))
    await go(p, '/myfiles/search')
    await expect.poll(() => p.getByTestId('index-status').textContent(), { timeout: 20000 }).toMatch(/색인 [5-9]개/)
    await p.getByLabel('파일 이름 검색').fill('report')
    await expect.poll(() => p.getByTestId('search-hit').count()).toBe(2)
    await p.getByLabel('파일 이름 검색').fill('minutes')
    await expect.poll(() => p.getByTestId('search-hits').textContent()).toContain('minutes-0115.hwp')
    await p.getByLabel('파일 이름 검색').fill('2026')
    await p.getByLabel('종류').selectOption('sheet')
    await expect.poll(() => p.getByTestId('search-hit').count()).toBe(0)
    await p.getByLabel('종류').selectOption('')
    // a new file shows up without a rescan (fs.watch)
    writeFileSync(join(work, 'docs', 'new-2026-notice.pdf'), 'n')
    await expect.poll(() => p.getByTestId('search-hits').textContent(), { timeout: 15000, interval: 1000 }).toContain('new-2026-notice.pdf')
    rmSync(join(work, 'docs', 'new-2026-notice.pdf'))
    await p.getByLabel('파일 이름 검색').fill('notice')
    await expect.poll(() => p.getByTestId('search-hit').count(), { timeout: 15000, interval: 1000 }).toBe(0)
  }, 60000)

  it('tags, virtual folders and smart folders keep files where they are', async () => {
    const p = a.page
    await p.getByLabel('파일 이름 검색').fill('budget')
    await p.getByTestId('search-hit').first().click()
    await p.getByRole('button', { name: '태그' }).click()
    await p.getByLabel('새 태그').fill('중요')
    await p.getByRole('dialog', { name: '태그' }).getByRole('button', { name: '저장' }).click()
    await expect.poll(() => p.getByTestId('search-hits').textContent()).toContain('중요')
    await p.getByTestId('search-hit').first().click()
    await p.getByRole('button', { name: '가상 폴더에' }).click()
    await p.getByLabel('새 가상 폴더 이름').fill('2026 예산 업무')
    await p.getByRole('button', { name: '만들고 넣기' }).click()
    await expect.poll(() => p.getByRole('dialog', { name: '가상 폴더에 넣기' }).getByRole('status').textContent()).toContain('1개를 넣었습니다')
    await p.keyboard.press('Escape')
    await p.getByLabel('파일 이름 검색').fill('2026')
    await p.getByRole('button', { name: '스마트 폴더로 저장' }).click()
    await p.getByLabel('스마트 폴더 이름').fill('2026 문서')
    await p.getByRole('dialog', { name: '스마트 폴더로 저장' }).getByRole('button', { name: '저장' }).click()

    await go(p, '/myfiles/organize')
    await p.getByRole('button', { name: /^중요/ }).click()
    await expect.poll(() => p.getByTestId('organize-items').textContent()).toContain('budget-plan.xlsx')
    await p.getByRole('button', { name: /2026 예산 업무/ }).first().click()
    await expect.poll(() => p.getByTestId('organize-item').count()).toBe(1)
    await p.getByRole('button', { name: /2026 문서/ }).click()
    await expect.poll(() => p.getByTestId('search-hit').count()).toBeGreaterThanOrEqual(2)
    // the file moves: the virtual folder shows it as missing
    rmSync(join(work, 'budget-plan.xlsx'))
    await p.getByRole('button', { name: /2026 예산 업무/ }).first().click()
    await expect.poll(() => p.getByTestId('organize-items').textContent()).toContain('찾을 수 없음')
  }, 60000)

  it('site collection: pick from presets and open', async () => {
    const p = a.page
    await go(p, '/launcher')
    await p.getByRole('tab', { name: '사이트 모음' }).click()
    await p.getByRole('button', { name: '주요 사이트 목록에서 고르기' }).click()
    await p.getByRole('checkbox', { name: '정부24' }).check()
    await p.getByRole('checkbox', { name: '홈택스' }).check()
    await p.getByRole('button', { name: '2개 추가' }).click()
    await expect.poll(() => p.getByTestId('bookmark').count()).toBe(2)
    await p.getByTestId('bookmark').filter({ hasText: '정부24' }).getByRole('button').first().click()
    await expect.poll(() => a.app.evaluate(() => (globalThis as unknown as { __teamhubOpened?: string[] }).__teamhubOpened ?? [])).toContain('https://www.gov.kr')
  })

  it('knowledge notes: pages, slash menu, page links with backlinks, database board', async () => {
    const p = a.page
    await go(p, '/notes')
    await p.getByRole('button', { name: '새 페이지' }).click()
    await p.getByLabel('페이지 제목').fill('회계 기준')
    await go(p, '/notes')
    await p.getByRole('button', { name: '새 페이지' }).click()
    await p.getByLabel('페이지 제목').fill('예산 편성 절차')
    const ed = p.getByRole('textbox', { name: '페이지 내용' })
    await ed.click()
    await p.keyboard.type('/제목')
    await expect.poll(() => p.getByTestId('note-menu').textContent()).toContain('제목 2')
    await p.keyboard.press('ArrowDown')
    await p.keyboard.press('Enter')
    await p.keyboard.type('개요')
    await expect.poll(() => ed.locator('h2').textContent()).toBe('개요')
    await p.keyboard.press('Enter')
    await p.keyboard.type('먼저 [[회계')
    await expect.poll(() => p.getByTestId('note-menu').textContent()).toContain('회계 기준')
    await p.keyboard.press('Enter')
    await expect.poll(() => ed.locator('a.note-link').textContent()).toBe('회계 기준')
    await p.waitForTimeout(800) // autosave
    await ed.locator('a.note-link').click()
    await expect.poll(() => p.getByLabel('페이지 제목').inputValue()).toBe('회계 기준')
    await expect.poll(() => p.getByTestId('backlinks').textContent()).toContain('예산 편성 절차')
    // search finds body text
    await p.getByLabel('노트 검색').fill('개요')
    await expect.poll(() => p.getByTestId('note-search-hit').count()).toBe(1)
    await p.getByLabel('노트 검색').fill('')

    // database with a board view
    await p.getByRole('button', { name: '새 데이터베이스' }).click()
    await expect.poll(() => p.getByTestId('note-db').count()).toBe(1)
    await p.getByText('+ 새 행').click()
    await expect.poll(() => p.getByTestId('db-row').count()).toBe(1)
    await p.getByTestId('db-row').getByLabel('이름').fill('보고서 제출')
    await p.getByTestId('db-row').getByLabel('이름').blur()
    await p.getByTestId('db-row').getByLabel('상태').selectOption('진행 중')
    await p.getByRole('button', { name: '보드' }).click()
    await expect.poll(() => p.getByTestId('db-board').textContent()).toContain('보고서 제출')
    expect(await p.getByTestId('db-card').count()).toBe(1)
  }, 60000)

  it('after restart notes, tags and virtual folders are still there', async () => {
    const userData = a.userData
    await a.close({ keepData: true })
    a = await launch({ userData, profile: 'e2e-m7c' })
    await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 20000 })
    await go(a.page, '/notes')
    await expect.poll(() => a.page.getByTestId('note-tree').textContent()).toContain('예산 편성 절차')
    await expect.poll(() => a.page.getByTestId('note-tree').textContent()).toContain('새 데이터베이스')
    await go(a.page, '/myfiles/organize')
    await expect.poll(() => a.page.getByRole('button', { name: /^중요/ }).count()).toBe(1)
    await expect.poll(() => a.page.getByRole('button', { name: /2026 예산 업무/ }).count()).toBeGreaterThanOrEqual(1)
  }, 60000)
})
