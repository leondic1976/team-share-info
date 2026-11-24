import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'
import { readDb, readXlsx, writeXlsx } from '../src/node/ledger-files'

const PORT = '47910'
const frame = (p: Page) => p.frameLocator('[data-testid="ledger-frame"]')
const cell = (p: Page, v: number, c: number) => frame(p).locator(`#grid td[data-v="${v}"][data-c="${c}"]`)

async function openLedger(p: Page): Promise<void> {
  await p.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '관리대장' }).click()
  await frame(p).locator('#side').waitFor()
}

describe('관리대장 (built-in ledger: personal, team and designated-people ledgers)', () => {
  let a: Launched
  let b: Launched
  let dbFile = ''
  const tmp = mkdtempSync(join(tmpdir(), 'teamhub-e2e-ledger-'))
  afterAll(async () => {
    await b?.close()
    await a?.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('setup: the ledger is under "확장 기능" in the menu of A (server) and B without installing anything', async () => {
    a = await launch({ profile: 'e2e-ldga' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-ldgb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    expect(await a.page.evaluate(() => window.teamhub.invoke('plugins:list', undefined))).toEqual([])
    const menu = await a.page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link').allTextContents()
    // listed with the extensions: right under "확장 기능", not between the shared menus
    expect(menu.slice(menu.indexOf('메신저'), menu.indexOf('메신저') + 2)).toEqual(['메신저', '게시판'])
    expect(menu.slice(menu.indexOf('확장 기능'), menu.indexOf('확장 기능') + 2)).toEqual(['확장 기능', '관리대장'])
    await openLedger(a.page)
    expect(await frame(a.page).locator('.th-page-header h1').textContent()).toContain('관리대장')
    expect(await frame(a.page).locator('#teamBooks').textContent()).toContain('팀용 대장이 없습니다')
    expect(await frame(a.page).locator('#pickBooks').textContent()).toContain('지정자용 대장이 없습니다')
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

  // the input box always sits on the current cell (IME), so a plain click on that cell is intercepted
  const pick = (p: Page, v: number, c: number): Promise<void> => cell(p, v, c).click({ force: true })
  const bar = (p: Page): Promise<string | null> => frame(p).locator('#teamBar').textContent()
  const more = async (p: Page, act: string): Promise<void> => {
    await frame(p).locator('#moreBtn').click()
    await frame(p).locator(`#moreMenu button[data-act="${act}"]`).click()
  }
  const toastOf = (p: Page): Promise<string | null> => frame(p).locator('#toast').textContent()
  const state = (p: Page): Promise<string | null> => frame(p).locator('#saveState').textContent()
  const type = async (p: Page, v: number, c: number, text: string): Promise<void> => {
    await pick(p, v, c)
    await p.keyboard.type(text)
    await p.keyboard.press('Enter')
  }
  /** 다른 이름으로 저장 in the given format; resolves to the path of the file (E2E: a folder of the test's data). */
  const saveAs = async (p: Page, format: string): Promise<string> => {
    const f = frame(p)
    await f.locator('#saveAs').click()
    await f.locator(`input[name="saveAsFormat"][value="${format}"]`).check()
    await f.locator('#toast').evaluate((el) => (el.textContent = ''))
    await f.locator('#saveAsGo').click()
    await expect.poll(() => toastOf(p), { timeout: 30000 }).toContain('저장했습니다: ')
    return ((await toastOf(p)) ?? '').replace('저장했습니다: ', '')
  }
  /** The file "파일에서 가져오기" will open (E2E cannot answer the dialog). */
  const importFile = async (l: Launched, path: string): Promise<void> => {
    await l.app.evaluate((_e, p) => void ((globalThis as unknown as { __teamhubOpenLedger?: string }).__teamhubOpenLedger = p), path)
    await frame(l.page).locator('#importFile').click()
  }
  const ledger = <T>(p: Page, fn: string): Promise<T> => frame(p).locator('body').evaluate((_el, code) => new Function('L', `return (${code})(L)`)((window as unknown as { __ledger: unknown }).__ledger) as T, fn)

  it('kept after leaving the screen; save as Excel (.xlsx, .xls), CSV and database (.db)', async () => {
    if (process.env.TEAMHUB_SHOTS) await a.page.screenshot({ path: join(process.env.TEAMHUB_SHOTS, 'ledger.png') })
    const f = frame(a.page)
    await expect.poll(() => state(a.page)).toContain('이 PC에 저장됨')
    await go(a.page, '/home')
    await openLedger(a.page)
    await expect.poll(() => f.locator('#books li').first().textContent()).toContain('비품 대장E2E')
    await expect.poll(() => cell(a.page, 0, 1).textContent()).toBe('가위')
    // the rows are records of the local DB, not one blob
    const list = await a.page.evaluate(() => window.teamhub.invoke('local:ledger.list', undefined))
    expect(list).toMatchObject([{ name: '비품 대장E2E', rows: 6, icon: 'package' }])

    const csv = readFileSync(await saveAs(a.page, 'csv'), 'utf8')
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('관리번호,품명,규격,수량,단가,금액')
    expect(csv).toContain('복사 용지,,10,4500,45000,2026-03-05')

    const xlsx = readXlsx(readFileSync(await saveAs(a.page, 'xlsx')))
    expect(xlsx.rows[0].slice(0, 6)).toEqual(['관리번호', '품명', '규격', '수량', '단가', '금액'])
    const paper = xlsx.rows.find((r) => r[1] === '복사 용지')!
    // numbers stay numbers and the date stays a date in Excel
    expect(paper.slice(3, 7)).toEqual([10, 4500, 45000, '2026-03-05'])

    const xls = readFileSync(await saveAs(a.page, 'xls'))
    expect(xls.subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1')
    expect(xls.includes(Buffer.from('복사 용지', 'utf16le'))).toBe(true)

    dbFile = await saveAs(a.page, 'db')
    const db = new DatabaseSync(dbFile, { readOnly: true })
    const row = db.prepare('SELECT "품명", "수량", "금액", "취득일" FROM data WHERE "품명" = ?').get('복사 용지')
    db.close()
    expect(row).toEqual({ 품명: '복사 용지', 수량: 10, 금액: 45000, 취득일: '2026-03-05' })
    expect((readDb(dbFile) as { name: string }).name).toBe('비품 대장E2E')
  }, 90000)

  it('import: CSV (types guessed, CP949 read), an Excel workbook, and a database saved before (formulas intact)', async () => {
    const f = frame(a.page)
    const utf = join(tmp, '수발신.csv')
    writeFileSync(utf, '﻿일자,제목,건수\r\n2026-11-01,"공문, 회신",3\r\n2026-11-02,협조 요청,5\r\n')
    await importFile(a, utf)
    await expect.poll(() => f.locator('#bookName').inputValue()).toBe('수발신')
    expect(await cell(a.page, 0, 1).textContent()).toBe('공문, 회신')
    expect(await f.locator('#grid tfoot td[data-total="2"]').textContent()).toContain('8') // number column → sum
    const cp949 = join(tmp, 'cp949.csv')
    writeFileSync(cp949, Buffer.from([0xb0, 0xa1, 0x0d, 0x0a, 0xb3, 0xaa, 0x0d, 0x0a])) // "가\r\n나\r\n"
    await importFile(a, cp949)
    await expect.poll(() => cell(a.page, 0, 0).textContent()).toBe('나')
    expect(await f.locator('#grid thead [data-h="0"] .t').textContent()).toBe('가')

    const book = join(tmp, '엑셀에서 온 표.xlsx')
    writeFileSync(book, writeXlsx({ name: 'Sheet1', columns: [{ name: '품명', kind: 'text' }, { name: '수량', kind: 'number' }, { name: '입고일', kind: 'date' }], rows: [['모니터', 3, '2026-10-01'], ['키보드', 7, '2026-10-02']] }))
    await importFile(a, book)
    await expect.poll(() => f.locator('#bookName').inputValue()).toBe('엑셀에서 온 표')
    expect(await cell(a.page, 1, 2).textContent()).toBe('2026-10-02')
    expect(await f.locator('#grid thead [data-h="1"] .ty').textContent()).toBe('123')
    expect(await f.locator('#grid tfoot td[data-total="1"]').textContent()).toContain('10')

    await importFile(a, dbFile)
    await expect.poll(() => f.locator('#bookName').inputValue()).toBe('비품 대장E2E (가져옴)')
    await expect.poll(() => cell(a.page, 0, 5).textContent()).toBe('3,000원') // the calculated column came along
    a.page.once('dialog', (d) => void d.accept())
    await more(a.page, 'delete')
    await expect.poll(() => toastOf(a.page)).toContain('휴지통으로 옮겼습니다')
  }, 90000)

  it('a large ledger: 30,000 rows from Excel — only the visible rows are drawn, edits save row by row', async () => {
    const f = frame(a.page)
    const big = join(tmp, '큰 대장.xlsx')
    writeFileSync(big, writeXlsx({ name: 'Sheet1', columns: [{ name: '품명', kind: 'text' }, { name: '수량', kind: 'number' }, { name: '단가', kind: 'number' }], rows: Array.from({ length: 30000 }, (_, i) => [`품목 ${i}`, i % 50, 1000]) }))
    await importFile(a, big)
    await expect.poll(() => f.locator('#bookName').inputValue(), { timeout: 30000 }).toBe('큰 대장')
    await expect.poll(() => f.locator('#stat').textContent()).toContain('30,000행')
    expect(await f.locator('#grid tbody tr').count()).toBeLessThan(200)
    // a calculated column over every row, then jump to the last row and edit it
    await f.locator('#addCol').click()
    await f.locator('#colName').fill('금액')
    await f.locator('#colType').selectOption('calc')
    await f.locator('#colCalc').fill('=[수량]*[단가]')
    await f.locator('#colTotal').selectOption('sum')
    await f.locator('#colOk').click()
    await expect.poll(() => cell(a.page, 1, 3).textContent()).toBe('1,000')
    await a.page.keyboard.press('Control+End')
    await expect.poll(() => cell(a.page, 29999, 0).textContent()).toBe('품목 29999')
    const before = await f.locator('#grid tfoot td[data-total="3"]').textContent()
    const t0 = Date.now()
    await type(a.page, 29999, 1, '100')
    if (process.env.TEAMHUB_SHOTS) await a.page.screenshot({ path: join(process.env.TEAMHUB_SHOTS, 'ledger-large.png') })
    await expect.poll(() => cell(a.page, 29999, 3).textContent()).toBe('100,000')
    const took = Date.now() - t0
    expect(await f.locator('#grid tfoot td[data-total="3"]').textContent()).not.toBe(before)
    expect(took).toBeLessThan(5000)
    await expect.poll(() => state(a.page), { timeout: 15000 }).toContain('이 PC에 저장됨')
    // one row was written, not thirty thousand
    expect(await ledger<number>(a.page, '(L) => L.shadow.version')).toBeLessThan(6)
    // find it again after coming back
    await go(a.page, '/home')
    await openLedger(a.page)
    await expect.poll(() => f.locator('#stat').textContent(), { timeout: 30000 }).toContain('30,000행')
    await f.locator('#search').fill('품목 29999')
    await expect.poll(() => f.locator('#stat').textContent(), { timeout: 10000 }).toContain('1행 보임')
    expect(await cell(a.page, 0, 3).textContent()).toBe('100,000')
    await f.locator('#clearFilter').click()
    const out = readXlsx(readFileSync(await saveAs(a.page, 'xlsx')))
    expect(out.rows).toHaveLength(30001)
    expect(out.rows[30000]).toEqual(['품목 29999', 100, 1000, 100000])
  }, 180000)

  it('A shares the ledger read-only with the team; B sees it and copies it into own ledgers', async () => {
    const f = frame(a.page)
    await f.locator('#books li', { hasText: '비품 대장E2E' }).click()
    await expect.poll(() => f.locator('#bookName').inputValue()).toBe('비품 대장E2E')
    await more(a.page, 'share')
    await f.locator('#shareGo').click()
    await expect.poll(() => toastOf(a.page)).toContain('공유했습니다')

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

  it('team ledger: A moves the personal ledger to the team; B is told and opens the same ledger from the server', async () => {
    const f = frame(a.page)
    await go(b.page, '/home')
    await more(a.page, 'toTeam')
    await expect.poll(() => f.locator('#teamTitle').textContent()).toContain('올리기')
    await f.locator('#teamGo').click()
    await expect.poll(() => toastOf(a.page)).toContain('팀용 대장으로 올렸습니다')
    await expect.poll(() => f.locator('#teamBooks li.on').textContent()).toContain('비품 대장E2E')
    expect(await f.locator('#books').textContent()).not.toContain('비품 대장E2E') // moved, not copied
    expect(await bar(a.page)).toContain('팀용')
    expect(await bar(a.page)).toContain('팀 전체')
    expect(await state(a.page)).toContain('서버에 저장됨')
    // the read-only share is for personal ledgers only
    await f.locator('#moreBtn').click()
    expect(await f.locator('#moreMenu button[data-act="share"]').isVisible()).toBe(false)
    expect(await f.locator('#moreMenu button[data-act="teamScope"]').isVisible()).toBe(true)
    await f.locator('#moreBtn').click()

    // B (on another screen): a notification and a count on the menu
    const toasts = (): Promise<string> =>
      b.app.evaluate(() => ((globalThis as unknown as { __teamhubToasts?: { title: string; body: string; route?: string }[] }).__teamhubToasts ?? []).map((t) => `${t.title}|${t.body}>${t.route}`).join('\n'))
    await expect.poll(toasts, { timeout: 10000 }).toContain('관리대장 공유 · 서버관리자|“비품 대장E2E” 대장을 함께 쓰게 되었습니다.>/ledger')
    await expect.poll(() => b.page.getByRole('link', { name: '관리대장 (1)', exact: true }).isVisible(), { timeout: 15000 }).toBe(true)
    await openLedger(b.page)
    const g = frame(b.page)
    await expect.poll(() => g.locator('#teamBooks li .dot').count(), { timeout: 10000 }).toBe(1)
    await g.locator('#teamBooks li', { hasText: '비품 대장E2E' }).click()
    await expect.poll(() => bar(b.page)).toContain('만든 사람 서버관리자')
    expect(await cell(b.page, 0, 1).textContent()).toBe('가위')
    expect(await cell(b.page, 0, 5).textContent()).toBe('3,000원') // formulas work on B too
    // opened: nothing new any more
    await expect.poll(() => b.page.getByRole('link', { name: '관리대장', exact: true }).isVisible(), { timeout: 15000 }).toBe(true)
    expect(await g.locator('#teamBooks li .dot').count()).toBe(0)
  }, 90000)

  it('A and B edit at the same time: both see each other live; a cell changed by both is never overwritten silently', async () => {
    const f = frame(a.page)
    await type(a.page, 0, 2, '대형')
    await expect.poll(() => state(a.page), { timeout: 10000 }).toContain('서버에 저장됨')
    await expect.poll(() => cell(b.page, 0, 2).textContent(), { timeout: 10000 }).toBe('대형')
    await expect.poll(() => bar(b.page)).toContain('서버관리자님이 방금 고침')
    // B types in another cell of the same row right away: nobody has to wait for anybody
    await type(b.page, 0, 7, '창고')
    await expect.poll(() => cell(a.page, 0, 7).textContent(), { timeout: 10000 }).toBe('창고')
    expect(await cell(a.page, 0, 2).textContent()).toBe('대형')
    await expect.poll(() => bar(a.page)).toContain('팀원B님이 방금 고침')

    // A is still typing in a cell when B's value for that very cell arrives: A's Enter does not overwrite it
    await pick(a.page, 1, 2)
    await a.page.keyboard.type('A가 쓰던 값')
    await type(b.page, 1, 2, 'B가 먼저 저장')
    await expect.poll(() => cell(a.page, 1, 2).textContent(), { timeout: 10000 }).toBe('B가 먼저 저장')
    await a.page.keyboard.press('Enter')
    await expect.poll(() => toastOf(a.page)).toContain('입력하는 동안 다른 사람이 이 칸을')
    expect(await cell(a.page, 1, 2).textContent()).toBe('B가 먼저 저장')
    await a.page.waitForTimeout(600)
    expect(await cell(b.page, 1, 2).textContent()).toBe('B가 먼저 저장')

    // A's screen misses the news of B's save (slow network): the server decides
    await ledger(a.page, '(L) => { L.deaf = true }')
    await type(b.page, 2, 2, 'B가 먼저')
    await expect.poll(() => state(b.page), { timeout: 10000 }).toContain('서버에 저장됨')
    expect(await cell(a.page, 2, 2).textContent()).toBe('')
    // the same cell: A's value is refused, B's is shown, and A's is kept for A as a personal ledger
    await type(a.page, 2, 2, 'A가 나중')
    await expect.poll(() => toastOf(a.page), { timeout: 10000 }).toContain('내 입력 1행은 반영되지 않았습니다')
    await expect.poll(() => cell(a.page, 2, 2).textContent()).toBe('B가 먼저')
    await expect.poll(() => f.locator('#books').textContent()).toContain('비품 대장E2E (저장 못 한 내 변경)')
    // another cell of a row B changed meanwhile: both are kept, and A gets B's cell with the answer to its own save
    await type(b.page, 3, 2, 'B의 칸')
    await expect.poll(() => state(b.page), { timeout: 10000 }).toContain('서버에 저장됨')
    expect(await cell(a.page, 3, 2).textContent()).toBe('')
    await type(a.page, 3, 7, 'A의 칸')
    await expect.poll(() => cell(a.page, 3, 2).textContent(), { timeout: 10000 }).toBe('B의 칸')
    await expect.poll(() => cell(b.page, 3, 7).textContent(), { timeout: 10000 }).toBe('A의 칸')
    await ledger(a.page, '(L) => { L.deaf = false }')
    await a.page.waitForTimeout(600)
    expect(await cell(b.page, 2, 2).textContent()).toBe('B가 먼저')
    // the copy holds what A typed
    await f.locator('#books li', { hasText: '저장 못 한 내 변경' }).click()
    await expect.poll(() => f.locator('#stat').textContent()).toContain('1행')
    expect(await cell(a.page, 0, 2).textContent()).toBe('A가 나중')
    await f.locator('#teamBooks li', { hasText: '비품 대장E2E' }).click()
    await expect.poll(() => bar(a.page)).toContain('팀용')

    // B's connection drops while typing: the edit waits and is saved when the server is back
    await b.page.evaluate(() => window.teamhub.invoke('local:kv.get', { key: 'noop' }))
    await ledger(b.page, '(L) => { window.__realCall = window.TeamHub.call; window.TeamHub.call = (m, p) => (m === "team.save" ? Promise.reject(Object.assign(new Error("연결할 수 없습니다."), { code: "" })) : window.__realCall(m, p)) }')
    await type(b.page, 4, 2, '끊긴 동안 입력')
    await expect.poll(() => state(b.page), { timeout: 10000 }).toContain('다시 시도 중')
    expect(await cell(a.page, 4, 2).textContent()).toBe('')
    await ledger(b.page, '(L) => { window.TeamHub.call = window.__realCall }')
    await expect.poll(() => state(b.page), { timeout: 15000 }).toContain('서버에 저장됨') // retried by itself
    await expect.poll(() => cell(a.page, 4, 2).textContent(), { timeout: 10000 }).toBe('끊긴 동안 입력')
  }, 120000)

  it('change history: the sheet before a round of edits is kept; go back to it, look at it as a copy', async () => {
    const f = frame(a.page)
    await f.locator('#history').click()
    await expect.poll(() => f.locator('#historyList li').first().textContent()).toContain('고치기 전')
    expect(await f.locator('#historyList li').last().textContent()).toContain('6행')
    // back to the sheet as it was when it was moved to the team (before anybody typed)
    a.page.once('dialog', (d) => void d.accept())
    await f.locator('#historyList li').last().locator('button[data-back]').click()
    await expect.poll(() => toastOf(a.page), { timeout: 10000 }).toContain('되돌렸습니다')
    await expect.poll(() => cell(a.page, 0, 2).textContent()).toBe('')
    await expect.poll(() => cell(b.page, 0, 2).textContent(), { timeout: 10000 }).toBe('') // B's screen follows
    expect(await cell(b.page, 4, 2).textContent()).toBe('')
    // the sheet of a moment ago was kept too: return to it
    await f.locator('#history').click()
    await expect.poll(() => f.locator('#historyList li').first().textContent()).toContain('되돌리기 전')
    a.page.once('dialog', (d) => void d.accept())
    await f.locator('#historyList li').first().locator('button[data-back]').click()
    await expect.poll(() => cell(a.page, 0, 2).textContent(), { timeout: 10000 }).toBe('대형')
    await expect.poll(() => cell(b.page, 4, 2).textContent(), { timeout: 10000 }).toBe('끊긴 동안 입력')
    // a kept version opens as a personal copy; the ledger itself is untouched
    await f.locator('#history').click()
    await f.locator('#historyKeep').click()
    await expect.poll(() => f.locator('#historyList li').first().textContent()).toContain('직접 보관')
    await f.locator('#historyList li').last().locator('button[data-copy]').click()
    await expect.poll(() => f.locator('#books li.on').textContent(), { timeout: 10000 }).toContain('시점)')
    expect(await cell(a.page, 0, 2).textContent()).toBe('')
    await f.locator('#teamBooks li', { hasText: '비품 대장E2E' }).click()
    await expect.poll(() => cell(a.page, 0, 2).textContent()).toBe('대형')
  }, 90000)

  it('edit mode "owner" makes it read-only for B; B keeps a personal copy; deleted ledgers wait in the trash', async () => {
    const f = frame(a.page)
    await more(a.page, 'teamScope')
    await f.locator('#teamEdit').selectOption('owner')
    await f.locator('#teamGo').click()
    await expect.poll(() => toastOf(a.page)).toContain('편집 권한을 바꿨습니다')

    const g = frame(b.page)
    await expect.poll(() => bar(b.page), { timeout: 10000 }).toContain('보기 전용')
    expect(await g.locator('#teamBooks li.on').textContent()).toContain('보기')
    await pick(b.page, 0, 2)
    await b.page.keyboard.type('x')
    await expect.poll(() => toastOf(b.page)).toContain('보기 전용 대장입니다')
    expect(await g.locator('#editor').inputValue()).toBe('')
    await g.locator('#moreBtn').click()
    expect(await g.locator('#moreMenu button[data-act="delete"]').isVisible()).toBe(false)
    await g.locator('#moreMenu button[data-act="dup"]').click()
    await expect.poll(() => toastOf(b.page)).toContain('개인용 대장으로 사본을 받았습니다')
    await expect.poll(() => g.locator('#books li.on').textContent()).toContain('비품 대장E2E (사본)')
    expect(await bar(b.page)).toContain('개인용')
    // the copy is B's own: editable, and A never sees it
    await type(b.page, 0, 2, '내 것')
    await expect.poll(() => cell(b.page, 0, 2).textContent()).toBe('내 것')
    await expect.poll(() => state(b.page)).toContain('이 PC에 저장됨')
    expect(await cell(a.page, 0, 2).textContent()).toBe('대형')

    await g.locator('#teamBooks li', { hasText: '비품 대장E2E' }).click()
    await expect.poll(() => bar(b.page)).toContain('보기 전용')
    a.page.once('dialog', (d) => void d.accept())
    await more(a.page, 'delete')
    await expect.poll(() => toastOf(a.page)).toContain('휴지통으로 옮겼습니다')
    await expect.poll(() => toastOf(b.page), { timeout: 10000 }).toContain('삭제되었습니다')
    await expect.poll(() => g.locator('#teamBooks').textContent()).toContain('팀용 대장이 없습니다')
    expect(await g.locator('#sheet').isVisible()).toBe(false)
    // B (not the creator) has nothing of it in the trash; A brings it back for everyone
    await g.locator('#trashBtn').click()
    await expect.poll(() => g.locator('#trashList').textContent()).not.toContain('불러오는 중')
    expect(await g.locator('#trashList').textContent()).not.toContain('비품 대장E2E')
    await g.locator('#trashDialog').press('Escape') // to the dialog itself: a page-level key press misses it when the frame has no focus
    await f.locator('#trashBtn').click()
    const item = f.locator('#trashList li', { hasText: '팀용' }).filter({ hasText: '비품 대장E2E' })
    await expect.poll(() => item.count()).toBe(1)
    // the personal ledgers deleted earlier are there as well
    expect(await f.locator('#trashList li', { hasText: '개인용' }).count()).toBeGreaterThanOrEqual(2)
    await item.locator('button[data-restore]').click()
    await expect.poll(() => toastOf(a.page)).toContain('되살렸습니다')
    await f.locator('#trashDialog').press('Escape')
    await expect.poll(() => f.locator('#trashDialog').evaluate((d) => (d as HTMLDialogElement).open)).toBe(false)
    await expect.poll(() => f.locator('#teamBooks').textContent()).toContain('비품 대장E2E')
    await expect.poll(() => g.locator('#teamBooks').textContent(), { timeout: 10000 }).toContain('비품 대장E2E')
  }, 120000)

  it('designated-people ledger; ledgers of v1.1.0 and the old "스마트 대장" plugin are carried over', async () => {
    const f = frame(a.page)
    await f.locator('#newBook').click()
    await f.locator('#newName').fill('차량 일지E2E')
    await f.locator('input[name="newWhere"][value="members"]').check()
    await f.locator('#templates button[data-t="vehicle"]').click()
    await expect.poll(() => f.locator('#teamTitle').textContent()).toBe('새 지정자용 대장')
    expect(await f.locator('input[name="teamTo"][value="members"]').isChecked()).toBe(true)
    await f.locator('#teamGo').click()
    await expect.poll(() => f.locator('#teamStateMsg').textContent()).toContain('지정하세요')
    await f.locator('#teamMembers label', { hasText: '팀원B' }).locator('input').check()
    await f.locator('#teamGo').click()
    await expect.poll(() => f.locator('#pickBooks li.on').textContent()).toContain('차량 일지E2E')
    expect(await f.locator('#teamBooks').textContent()).not.toContain('차량 일지E2E')
    expect(await bar(a.page)).toContain('지정자용')
    expect(await bar(a.page)).toContain('팀원B')
    await expect.poll(() => frame(b.page).locator('#pickBooks li', { hasText: '차량 일지E2E' }).count(), { timeout: 10000 }).toBe(1)

    // a PC updated from v1.1.0: the plugin entry goes, and a ledger kept whole under its old key becomes rows
    await a.page.evaluate(async () => {
      await window.teamhub.invoke('local:kv.set', {
        key: 'plugins',
        value: { ledger: { manifest: { id: 'ledger', name: '스마트 대장', version: '1.0.0', entry: 'index.html', permissions: ['storage'], icon: '📒' }, installedAt: 1, source: 'builtin', enabled: true } }
      })
      await window.teamhub.invoke('local:kv.set', { key: 'plugin:ledger:index', value: [{ id: 'old1', name: '옛 방식 대장', icon: '💰', rows: 1, updatedAt: 1700000000000 }] })
      await window.teamhub.invoke('local:kv.set', {
        key: 'plugin:ledger:book:old1',
        value: { id: 'old1', name: '옛 방식 대장', updatedAt: 1700000000000, cols: [{ id: 'c1', name: '항목', type: 'text' }, { id: 'c2', name: '금액', type: 'number', total: 'sum' }], rows: [{ id: 'r1', c: { c1: '옛 행', c2: 1200 } }] }
      })
    })
    await a.close({ keepData: true })
    a = await launch({ profile: 'e2e-ldga', userData: a.userData })
    await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    expect(await a.page.evaluate(() => window.teamhub.invoke('plugins:list', undefined))).toEqual([])
    expect(await a.page.evaluate(() => window.teamhub.invoke('local:kv.get', { key: 'plugin:ledger:book:old1' }))).toBeNull()
    await go(a.page, '/plugins/ledger') // an old link
    await frame(a.page).locator('#side').waitFor()
    expect(a.page.url()).toContain('#/ledger')
    const h = frame(a.page)
    await expect.poll(() => h.locator('#books').textContent()).toContain('수발신') // personal ledgers kept
    await expect.poll(() => h.locator('#pickBooks li.on').textContent(), { timeout: 10000 }).toContain('차량 일지E2E') // reopens the last one
    await h.locator('#books li', { hasText: '옛 방식 대장' }).click()
    await expect.poll(() => cell(a.page, 0, 0).textContent()).toBe('옛 행')
    expect(await h.locator('#grid tfoot td[data-total="1"]').textContent()).toContain('1,200')
  }, 120000)
})
