import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47910'
const ROOT = resolve(import.meta.dirname, '..')
const BUNDLE = join(ROOT, 'release', 'plugins', 'ledger-1.0.0.thplugin')
const frame = (p: Page) => p.frameLocator('[data-testid="plugin-frame"]')
const cell = (p: Page, v: number, c: number) => frame(p).locator(`#grid td[data-v="${v}"][data-c="${c}"]`)

const answerSave = (app: ElectronApplication, path: string): Promise<void> =>
  app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog
  }, path)
const answerOpen = (app: ElectronApplication, path: string): Promise<void> =>
  app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, path)

async function openLedger(p: Page): Promise<void> {
  await p.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '스마트 대장' }).click()
  await frame(p).locator('#side').waitFor()
}

describe('plugin: 스마트 대장 (spreadsheet-style ledger)', () => {
  let a: Launched
  let b: Launched
  const tmp = mkdtempSync(join(tmpdir(), 'teamhub-e2e-ledger-'))
  afterAll(async () => {
    await b?.close()
    await a?.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('setup: install from the .thplugin file on A (server) and B', async () => {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-plugins.mjs'), join(ROOT, 'release', 'plugins')])
    a = await launch({ profile: 'e2e-ldga' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-ldgb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    for (const x of [a, b]) {
      const info = await x.page.evaluate((path) => window.teamhub.invoke('plugins:inspectFile', { path }), BUNDLE)
      expect(info.manifest?.permissions).toContain('files')
      expect((await x.page.evaluate((path) => window.teamhub.invoke('plugins:installFile', { path }), BUNDLE)).ok).toBe(true)
    }
    await openLedger(a.page)
  }, 90000)

  it('new ledger from a template; typing with the keyboard; calculated column and totals', async () => {
    const f = frame(a.page)
    await f.locator('#newBook').click()
    await f.locator('#newName').fill('비품 대장E2E')
    await f.locator('#templates button[data-t="asset"]').click()
    await expect.poll(() => f.locator('#bookName').inputValue()).toBe('비품 대장E2E')
    await expect.poll(() => cell(a.page, 0, 5).textContent()).toBe('2,500,000원') // sample row: 2 × 1,250,000
    await cell(a.page, 1, 1).click()
    await a.page.keyboard.type('복사 용지')
    await a.page.keyboard.press('Tab')
    await a.page.keyboard.press('Tab')
    await a.page.keyboard.type('10')
    await a.page.keyboard.press('Tab')
    await a.page.keyboard.type('4,500')
    await a.page.keyboard.press('Enter')
    await expect.poll(() => cell(a.page, 1, 5).textContent()).toBe('45,000원')
    expect(await f.locator('#grid tfoot td[data-total="3"]').textContent()).toContain('12')
    expect(await f.locator('#grid tfoot td[data-total="5"]').textContent()).toContain('2,545,000원')
    // a cell formula with an A1 range; the formula bar shows it
    await cell(a.page, 2, 10).click()
    await a.page.keyboard.type('=SUM(D1:D2)*2')
    await a.page.keyboard.press('Enter')
    await expect.poll(() => cell(a.page, 2, 10).textContent()).toBe('24')
    await cell(a.page, 2, 10).click()
    expect(await f.locator('#fx').inputValue()).toBe('=SUM(D1:D2)*2')
    // dates typed the Korean way are normalised; a choice column takes a value
    await cell(a.page, 1, 6).click()
    await a.page.keyboard.type('2026.3.5')
    await a.page.keyboard.press('Enter')
    await expect.poll(() => cell(a.page, 1, 6).textContent()).toBe('2026-03-05')
  }, 60000)

  it('paste a block from Excel (grows rows), undo / redo, selection sum', async () => {
    const f = frame(a.page)
    await cell(a.page, 3, 1).click()
    await f.locator('#editor').evaluate((el) => {
      const dt = new DataTransfer()
      dt.setData('text/plain', '가위\t\t3\t1000\r\n풀\t\t5\t800\r\n테이프\t\t2\t1500\r\n')
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    await expect.poll(() => f.locator('#stat').textContent()).toContain('6행')
    expect(await cell(a.page, 5, 5).textContent()).toBe('3,000원')
    await a.page.keyboard.press('Control+z')
    await expect.poll(() => f.locator('#stat').textContent()).toContain('5행')
    await a.page.keyboard.press('Control+y')
    await expect.poll(() => f.locator('#stat').textContent()).toContain('6행')
    await cell(a.page, 3, 3).click()
    await cell(a.page, 5, 3).click({ modifiers: ['Shift'] })
    await expect.poll(() => f.locator('#selInfo').textContent()).toContain('합계 10')
  }, 60000)

  it('sort by a column (blanks last), find, column filter', async () => {
    const f = frame(a.page)
    await f.locator('#grid [data-menu="1"]').click()
    await f.locator('#ctx button', { hasText: '오름차순' }).click()
    await expect.poll(() => cell(a.page, 0, 1).textContent()).toBe('가위')
    expect(await cell(a.page, 5, 1).textContent()).toBe('') // the empty row goes last
    await f.locator('#search').fill('테이프')
    await expect.poll(() => f.locator('#stat').textContent()).toContain('1행 보임')
    await f.locator('#clearFilter').click()
    await expect.poll(() => f.locator('#stat').textContent()).not.toContain('보임')
  }, 30000)

  it('kept after leaving the screen; CSV export opens in Excel (BOM, header, plain numbers)', async () => {
    if (process.env.TEAMHUB_SHOTS) await a.page.screenshot({ path: join(process.env.TEAMHUB_SHOTS, 'ledger.png') })
    await a.page.waitForTimeout(800) // autosave
    await go(a.page, '/home')
    await openLedger(a.page)
    const f = frame(a.page)
    await expect.poll(() => f.locator('#books li').first().textContent()).toContain('비품 대장E2E')
    await expect.poll(() => cell(a.page, 0, 1).textContent()).toBe('가위')
    const out = join(tmp, '비품.csv')
    await answerSave(a.app, out)
    await f.locator('#moreBtn').click()
    await f.locator('#moreMenu button[data-act="csv"]').click()
    await expect.poll(() => f.locator('#toast').textContent()).toContain('저장했습니다')
    const csv = readFileSync(out, 'utf8')
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('관리번호,품명,규격,수량,단가,금액')
    expect(csv).toContain('복사 용지,,10,4500,45000,2026-03-05')
  }, 60000)

  it('CSV import guesses column types; an Excel Korean (CP949) file is read correctly', async () => {
    const f = frame(a.page)
    const utf = join(tmp, '수발신.csv')
    writeFileSync(utf, '﻿일자,제목,건수\r\n2026-11-01,"공문, 회신",3\r\n2026-11-02,협조 요청,5\r\n')
    await answerOpen(a.app, utf)
    await f.locator('#importCsv').click()
    await expect.poll(() => f.locator('#bookName').inputValue()).toBe('수발신')
    expect(await cell(a.page, 0, 1).textContent()).toBe('공문, 회신')
    expect(await f.locator('#grid tfoot td[data-total="2"]').textContent()).toContain('8') // number column → sum
    const cp949 = join(tmp, 'cp949.csv')
    writeFileSync(cp949, Buffer.from([0xb0, 0xa1, 0x0d, 0x0a, 0xb3, 0xaa, 0x0d, 0x0a])) // "가\r\n나\r\n"
    await answerOpen(a.app, cp949)
    await f.locator('#importCsv').click()
    await expect.poll(() => cell(a.page, 0, 0).textContent()).toBe('나')
    expect(await f.locator('#grid thead [data-h="0"] .t').textContent()).toBe('가')
  }, 60000)

  it('A shares the ledger read-only with the team; B sees it and copies it into own ledgers', async () => {
    const f = frame(a.page)
    await f.locator('#books li', { hasText: '비품 대장E2E' }).click()
    await expect.poll(() => f.locator('#bookName').inputValue()).toBe('비품 대장E2E')
    await f.locator('#moreBtn').click()
    await f.locator('#moreMenu button[data-act="share"]').click()
    await f.locator('#shareGo').click()
    await expect.poll(() => f.locator('#toast').textContent()).toContain('공유했습니다')

    await openLedger(b.page)
    const g = frame(b.page)
    await g.locator('#sharedBtn').click()
    await g.locator('#sharedList button[data-room]').first().click()
    await expect.poll(() => g.locator('#viewTitle').textContent()).toContain('비품 대장E2E')
    expect(await g.locator('#viewGrid tbody tr').count()).toBe(6)
    expect(await g.locator('#viewGrid tbody').textContent()).toContain('45,000원')
    await g.locator('#viewCopy').click()
    await expect.poll(() => g.locator('#bookName').inputValue()).toContain('비품 대장E2E')
    expect(await g.locator('#grid tbody').textContent()).toContain('복사 용지')
  }, 60000)
})
