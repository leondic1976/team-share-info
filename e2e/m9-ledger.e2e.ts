import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'
import { PROTOCOL_VERSION } from '../src/shared/constants'

const PORT = '47910'
const frame = (p: Page) => p.frameLocator('[data-testid="ledger-frame"]')
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
  await p.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '관리대장' }).click()
  await frame(p).locator('#side').waitFor()
}

describe('관리대장 (built-in ledger: personal, team and designated-people ledgers)', () => {
  let a: Launched
  let b: Launched
  const tmp = mkdtempSync(join(tmpdir(), 'teamhub-e2e-ledger-'))
  afterAll(async () => {
    await b?.close()
    await a?.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('setup: the ledger is in the main menu of A (server) and B without installing anything', async () => {
    a = await launch({ profile: 'e2e-ldga' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-ldgb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    expect(await a.page.evaluate(() => window.teamhub.invoke('plugins:list', undefined))).toEqual([])
    await openLedger(a.page)
    expect(await frame(a.page).locator('#side h1').textContent()).toContain('관리대장')
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

  const more = async (p: Page, act: string): Promise<void> => {
    await frame(p).locator('#moreBtn').click()
    await frame(p).locator(`#moreMenu button[data-act="${act}"]`).click()
  }
  // the input box always sits on the current cell (IME), so a plain click on that cell is intercepted
  const pick = (p: Page, v: number, c: number): Promise<void> => cell(p, v, c).click({ force: true })
  const bar = (p: Page): Promise<string | null> => frame(p).locator('#teamBar').textContent()

  it('team ledger: A moves the personal ledger to the team; B opens the same ledger from the server', async () => {
    const f = frame(a.page)
    await more(a.page, 'toTeam')
    await expect.poll(() => f.locator('#teamTitle').textContent()).toContain('올리기')
    await f.locator('#teamGo').click()
    await expect.poll(() => f.locator('#toast').textContent()).toContain('팀용 대장으로 올렸습니다')
    await expect.poll(() => f.locator('#teamBooks li.on').textContent()).toContain('비품 대장E2E')
    expect(await f.locator('#books').textContent()).not.toContain('비품 대장E2E') // moved, not copied
    expect(await bar(a.page)).toContain('팀용 대장')
    expect(await bar(a.page)).toContain('팀 전체')
    // the read-only share is for personal ledgers only
    await f.locator('#moreBtn').click()
    expect(await f.locator('#moreMenu button[data-act="share"]').isVisible()).toBe(false)
    expect(await f.locator('#moreMenu button[data-act="teamScope"]').isVisible()).toBe(true)
    await f.locator('#moreBtn').click()

    const g = frame(b.page)
    await expect.poll(() => g.locator('#teamBooks li', { hasText: '비품 대장E2E' }).count(), { timeout: 10000 }).toBe(1) // arrives live
    await g.locator('#teamBooks li', { hasText: '비품 대장E2E' }).click()
    await expect.poll(() => bar(b.page)).toContain('만든 사람 서버관리자')
    expect(await cell(b.page, 0, 1).textContent()).toBe('가위')
    expect(await cell(b.page, 0, 5).textContent()).toBe('3,000원') // formulas work on B too
  }, 60000)

  it('one editor at a time: A types (saved automatically), B sees it live and cannot edit until A is done', async () => {
    const f = frame(a.page)
    const g = frame(b.page)
    await pick(a.page, 0, 2)
    await a.page.keyboard.type('대형')
    await a.page.keyboard.press('Enter')
    await expect.poll(() => bar(a.page)).toContain('내가 편집 중')
    await expect.poll(() => f.locator('#saveState').textContent(), { timeout: 10000 }).toContain('서버에 저장됨')
    await expect.poll(() => cell(b.page, 0, 2).textContent(), { timeout: 10000 }).toBe('대형')
    await expect.poll(() => bar(b.page)).toContain('서버관리자님이 편집 중')
    expect(await g.locator('#teamBooks li.on').textContent()).toContain('서버관리자님이 편집 중')
    // B is stopped before typing anything
    await pick(b.page, 1, 2)
    await b.page.keyboard.type('x')
    await expect.poll(() => g.locator('#toast').textContent()).toContain('서버관리자님이 편집 중입니다')
    expect(await g.locator('#editor').inputValue()).toBe('')
    await b.page.keyboard.press('Delete')
    expect(await cell(b.page, 0, 2).textContent()).toBe('대형')

    // A finishes; B edits and A sees it
    await f.locator('#teamDone').click()
    await expect.poll(() => bar(b.page), { timeout: 10000 }).toContain('입력을 시작하면')
    await pick(b.page, 0, 2)
    await b.page.keyboard.type('소형')
    await b.page.keyboard.press('Enter')
    await expect.poll(() => bar(b.page)).toContain('내가 편집 중')
    await expect.poll(() => cell(a.page, 0, 2).textContent(), { timeout: 10000 }).toBe('소형')
    await expect.poll(() => bar(a.page)).toContain('팀원B님이 편집 중')
    // undo by B travels too
    await b.page.keyboard.press('Control+z')
    await expect.poll(() => cell(a.page, 0, 2).textContent(), { timeout: 10000 }).toBe('대형')
    // leaving the screen frees the ledger at once
    await go(b.page, '/home')
    await expect.poll(() => bar(a.page), { timeout: 10000 }).toContain('입력을 시작하면')
  }, 90000)

  it('conflict detection: a save made on an old version is refused, the typed content is kept as a personal copy', async () => {
    const f = frame(a.page)
    await pick(a.page, 1, 2)
    await a.page.keyboard.type('첫 입력')
    await a.page.keyboard.press('Enter')
    await expect.poll(() => f.locator('#saveState').textContent(), { timeout: 10000 }).toContain('서버에 저장됨')
    const id = await f.locator('body').evaluate(() => (window as unknown as { __ledger: { team: { id: string } } }).__ledger.team.id)
    // the same ledger is saved from somewhere else behind this screen's back (a second window of the
    // same person, or anyone after this screen was cut off long enough to lose its edit lock)
    const status = await a.page.evaluate(
      async ({ ledgerId, protocol }) => {
        const c = await window.teamhub.invoke('conn:get', undefined)
        const headers = { authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'x-win-user': encodeURIComponent(c.winUser), 'x-protocol': String(protocol), 'content-type': 'application/json' }
        const url = `${c.serverUrl}/api/ledgers/${ledgerId}`
        const cur = (await (await fetch(url, { headers })).json()).data
        cur.doc.note = '다른 곳에서 먼저 저장'
        const stale = (await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ doc: cur.doc, version: cur.version - 1 }) })).status
        const ok = (await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ doc: cur.doc, version: cur.version }) })).status
        return { stale, ok }
      },
      { ledgerId: id, protocol: PROTOCOL_VERSION }
    )
    expect(status).toEqual({ stale: 409, ok: 200 })
    await pick(a.page, 2, 2)
    await a.page.keyboard.type('충돌할 입력')
    await a.page.keyboard.press('Enter')
    await expect.poll(() => f.locator('#toast').textContent(), { timeout: 10000 }).toContain('사본으로 남겼습니다')
    await expect.poll(() => f.locator('#books').textContent()).toContain('비품 대장E2E (저장 못 한 내 변경)')
    // the screen went back to the server's version; nothing of the other save was overwritten
    await expect.poll(() => f.locator('#note').inputValue(), { timeout: 10000 }).toBe('다른 곳에서 먼저 저장')
    expect(await cell(a.page, 2, 2).textContent()).not.toBe('충돌할 입력')
    expect(await cell(a.page, 1, 2).textContent()).toBe('첫 입력')
    // and the copy holds what was typed
    await f.locator('#books li', { hasText: '저장 못 한 내 변경' }).click()
    await expect.poll(() => cell(a.page, 2, 2).textContent()).toBe('충돌할 입력')
    await f.locator('#teamBooks li', { hasText: '비품 대장E2E' }).click()
    await expect.poll(() => bar(a.page)).toContain('팀용 대장')
  }, 90000)

  it('edit mode "owner" makes it read-only for B; B keeps a personal copy; deleting removes it everywhere', async () => {
    const f = frame(a.page)
    await more(a.page, 'teamScope')
    await f.locator('#teamEdit').selectOption('owner')
    await f.locator('#teamGo').click()
    await expect.poll(() => f.locator('#toast').textContent()).toContain('편집 권한을 바꿨습니다')

    await openLedger(b.page)
    const g = frame(b.page)
    await expect.poll(() => bar(b.page), { timeout: 10000 }).toContain('보기 전용') // reopened where B left off
    expect(await g.locator('#teamBooks li.on').textContent()).toContain('보기')
    await pick(b.page, 0, 2)
    await b.page.keyboard.type('x')
    await expect.poll(() => g.locator('#toast').textContent()).toContain('보기 전용 대장입니다')
    await g.locator('#moreBtn').click()
    expect(await g.locator('#moreMenu button[data-act="delete"]').isVisible()).toBe(false)
    await g.locator('#moreMenu button[data-act="dup"]').click()
    await expect.poll(() => g.locator('#toast').textContent()).toContain('개인용 대장으로 사본을 받았습니다')
    await expect.poll(() => g.locator('#books li.on').textContent()).toContain('비품 대장E2E (사본)')
    expect(await g.locator('#teamBar').isVisible()).toBe(false)
    // the copy is B's own: editable, and A never sees it
    await pick(b.page, 0, 2)
    await b.page.keyboard.type('내 것')
    await b.page.keyboard.press('Enter')
    await expect.poll(() => cell(b.page, 0, 2).textContent()).toBe('내 것')
    await expect.poll(() => g.locator('#saveState').textContent()).toContain('저장됨')
    expect(await cell(a.page, 0, 2).textContent()).toBe('대형')

    await g.locator('#teamBooks li', { hasText: '비품 대장E2E' }).click()
    await expect.poll(() => bar(b.page)).toContain('보기 전용')
    a.page.once('dialog', (d) => void d.accept())
    await more(a.page, 'delete')
    await expect.poll(() => f.locator('#toast').textContent()).toContain('삭제했습니다')
    await expect.poll(() => g.locator('#toast').textContent(), { timeout: 10000 }).toContain('삭제되었습니다')
    await expect.poll(() => g.locator('#teamBooks').textContent()).toContain('팀용 대장이 없습니다')
    expect(await g.locator('#sheet').isVisible()).toBe(false)
  }, 90000)

  it('designated-people ledger; the old "스마트 대장" plugin is retired and its ledgers stay', async () => {
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
    expect(await bar(a.page)).toContain('지정자용 대장')
    expect(await bar(a.page)).toContain('팀원B')
    await expect.poll(() => frame(b.page).locator('#pickBooks li', { hasText: '차량 일지E2E' }).count(), { timeout: 10000 }).toBe(1)

    // a PC that had the plugin installed: after the update it is gone from the plugin list, the ledgers are still there
    await a.page.evaluate(() =>
      window.teamhub.invoke('local:kv.set', {
        key: 'plugins',
        value: { ledger: { manifest: { id: 'ledger', name: '스마트 대장', version: '1.0.0', entry: 'index.html', permissions: ['storage'], icon: '📒' }, installedAt: 1, source: 'builtin', enabled: true } }
      })
    )
    await a.close({ keepData: true })
    a = await launch({ profile: 'e2e-ldga', userData: a.userData })
    await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    expect(await a.page.evaluate(() => window.teamhub.invoke('plugins:list', undefined))).toEqual([])
    await go(a.page, '/plugins/ledger') // an old link
    await frame(a.page).locator('#side').waitFor()
    expect(a.page.url()).toContain('#/ledger')
    await expect.poll(() => frame(a.page).locator('#books').textContent()).toContain('수발신') // personal ledgers kept
    await expect.poll(() => frame(a.page).locator('#pickBooks li.on').textContent(), { timeout: 10000 }).toContain('차량 일지E2E') // reopens the last one
  }, 120000)
})
