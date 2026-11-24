import { describe, it, expect, afterAll } from 'vitest'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47931'
const NEW = ['matjip', 'survey', 'dutchpay', 'ocr', 'copilot']
const frame = (p: Page) => p.frameLocator('[data-testid="plugin-frame"]')
const open = async (p: Page, id: string, ready: string): Promise<void> => {
  await go(p, `/plugins/${id}`)
  await frame(p).locator(ready).first().waitFor({ timeout: 20000 })
}

describe('extensions shipped with the app, personal-information check, messenger tabs', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup: the new extensions install with one click on both PCs', async () => {
    a = await launch({ profile: 'e2e-m10a' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-m10b' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    for (const l of [a, b])
      for (const id of NEW) {
        const r = await l.page.evaluate((pid) => window.teamhub.invoke('plugins:installCatalog', { id: pid, builtin: true }), id)
        expect(r.ok, `${id}: ${r.error ?? ''}`).toBe(true)
      }
    const menu = await a.page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link').allTextContents()
    for (const name of ['관리대장', '맛집 추천', '설문조사', 'N분의 1 정산', '이미지 글자 읽기 (OCR)', 'AI 도우미 (Copilot)']) expect(menu.some((m) => m.includes(name)), name).toBe(true)
  }, 120000)

  it('서식자료실: the official forms shipped with the program are in the file library of every member', async () => {
    await go(b.page, '/files')
    await b.page.getByText('서식자료실', { exact: true }).first().click()
    await b.page.getByText('행정업무 운영 서식', { exact: true }).first().click()
    await expect.poll(() => b.page.getByText('서식 01 - 기안문(시행문 겸용).hwp').count(), { timeout: 15000 }).toBe(1)
    expect(await b.page.getByText('서식 12 - 업무인계ㆍ인수서.hwp').count()).toBe(1)
  }, 60000)

  it('맛집 추천: A recommends a place; B likes it and comments; A sees both at once', async () => {
    await open(a.page, 'matjip', '.empty')
    const fa = frame(a.page)
    await fa.locator('#writeBtn').click()
    await fa.locator('#fName').fill('할매순대국E2E')
    await fa.locator('#fMenu').fill('순대국 특')
    await fa.locator('#fWalk').fill('5')
    await fa.locator('#fRating [data-n="5"]').click()
    await fa.locator('#fTags [data-tag="혼밥"]').click()
    await fa.locator('#fText').fill('국물이 진합니다')
    await fa.locator('#editorSave').click()
    await expect.poll(() => fa.locator('.post').count(), { timeout: 15000 }).toBe(1)
    expect(await fa.locator('.post .stars svg.th-fill').count()).toBe(5)

    await open(b.page, 'matjip', '.post')
    const fb = frame(b.page)
    expect(await fb.locator('.post').textContent()).toContain('할매순대국E2E')
    expect(await fb.locator('.post [data-act="edit"]').count()).toBe(0) // not B's post
    await fb.locator('.post [data-act="like"]').click()
    await expect.poll(() => fb.locator('.post [data-act="like"]').getAttribute('aria-pressed'), { timeout: 10000 }).toBe('true')
    await fb.locator('.post [data-act="comments"]').click()
    await fb.locator('.comment-form input').fill('저도 단골입니다')
    await fb.locator('.comment-form button').click()
    await expect.poll(() => fb.locator('.comment').count(), { timeout: 10000 }).toBe(1)
    // A's screen follows without a reload
    await expect.poll(() => fa.locator('.post [data-act="like"]').textContent(), { timeout: 15000 }).toContain('1')
    await expect.poll(() => fa.locator('.post [data-act="comments"]').textContent(), { timeout: 15000 }).toContain('1')
    await fa.locator('nav [data-tab="rank"]').click()
    expect(await fa.locator('.rank-row').first().textContent()).toContain('할매순대국E2E')
  }, 90000)

  it('설문조사: A asks the team, B answers, A sees the result and closes it', async () => {
    await open(a.page, 'survey', '.empty')
    const fa = frame(a.page)
    await fa.locator('#newBtn').click()
    await fa.locator('#bTitle').fill('워크숍 날짜E2E')
    await fa.locator('.bq [data-f="text"]').fill('언제가 좋나요?')
    await fa.locator('.bq [data-f="options"]').fill('5월 10일\n5월 17일')
    await fa.locator('#bAdd').click()
    await fa.locator('.bq').nth(1).locator('[data-f="type"]').selectOption('text')
    await fa.locator('.bq').nth(1).locator('[data-f="text"]').fill('건의 사항')
    await fa.locator('.bq').nth(1).locator('[data-f="required"]').uncheck()
    await fa.locator('#builderForm button[type="submit"]').click()
    await fa.locator('#answerForm').waitFor({ timeout: 15000 })

    await open(b.page, 'survey', '[data-open]')
    const fb = frame(b.page)
    expect(await fb.locator('[data-open]').textContent()).toContain('응답 필요')
    await fb.locator('[data-open]').click()
    await fb.locator('#answerForm button[type="submit"]').click() // the required question is not answered yet
    await expect.poll(() => fb.locator('#toast').textContent()).toContain('1번 문항')
    await fb.locator('label.choice', { hasText: '5월 17일' }).click()
    await fb.locator('#answerForm textarea').fill('버스 대절 부탁')
    await fb.locator('#answerForm button[type="submit"]').click()
    await expect.poll(() => fb.locator('.bar-row.top').textContent(), { timeout: 15000 }).toContain('5월 17일')

    // A (the creator) sees the answer arrive after going back to the list and in again
    await fa.locator('[data-act="back"]').click()
    await expect.poll(() => fa.locator('[data-open]').textContent(), { timeout: 15000 }).toContain('응답 1')
    await fa.locator('[data-open]').click()
    await expect.poll(() => fa.locator('.bar-row.top').textContent(), { timeout: 15000 }).toContain('1명 · 100%')
    expect(await fa.locator('.texts').textContent()).toContain('버스 대절 부탁')
    a.page.once('dialog', (d) => void d.accept())
    await fa.locator('[data-act="close"]').click()
    await expect.poll(() => fa.locator('.card-top .badge').first().textContent(), { timeout: 15000 }).toBe('마감')
  }, 120000)

  it('N분의 1 정산: quick split and an itemised settlement', async () => {
    await open(a.page, 'dutchpay', '#qTotal')
    const f = frame(a.page)
    await f.locator('#qTotal').fill('187,500')
    await f.locator('#qPeople').fill('7')
    await f.locator('#qMode').selectOption('up')
    await expect.poll(() => f.locator('#qResult .big').textContent()).toBe('26,800원')
    expect(await f.locator('#qResult').textContent()).toContain('남는 돈')
    await f.locator('nav [data-tab="items"]').click()
    await f.locator('#newPerson').fill('김, 이, 박')
    await f.locator('#addPerson').click()
    await expect.poll(() => f.locator('.person').count()).toBe(3)
    await f.locator('#addExpense').click()
    await f.locator('.expense [data-f="title"]').fill('1차')
    await f.locator('.expense [data-f="amount"]').fill('9만')
    await f.locator('#iUnit').selectOption('1')
    await expect.poll(() => f.locator('.transfer').count()).toBe(2)
    expect(await f.locator('#iResult').textContent()).toContain('30,000원')
    // the member list of the team can be loaded as well
    await f.locator('#loadMembers').click()
    await expect.poll(() => f.locator('.person').count(), { timeout: 10000 }).toBe(5)
  }, 60000)

  it('OCR: a picture put into the screen is read by Windows on this PC', async () => {
    await open(a.page, 'ocr', '#drop')
    const f = frame(a.page)
    // a picture with text, made in the page and handed to the file input
    await f.locator('#file').evaluate(async (input: HTMLInputElement) => {
      const c = document.createElement('canvas')
      c.width = 700
      c.height = 160
      const g = c.getContext('2d')!
      g.fillStyle = '#fff'
      g.fillRect(0, 0, c.width, c.height)
      g.fillStyle = '#000'
      g.font = '48px Arial'
      g.fillText('TeamHub 2026', 30, 100)
      const blob = await new Promise<Blob>((res) => c.toBlob((x) => res(x!), 'image/png'))
      const dt = new DataTransfer()
      dt.items.add(new File([blob], 't.png', { type: 'image/png' }))
      input.files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await f.locator('#stage:not(.hidden)').waitFor({ timeout: 10000 })
    await f.locator('#run').click()
    // a PC without any recognizer language says how to install one instead
    await expect
      .poll(async () => `${await f.locator('#text').inputValue()}|${await f.locator('#toast').textContent()}`, { timeout: 60000 })
      .toMatch(/TeamHub|광학 문자 인식/)
  }, 120000)

  it('Copilot helper: builds the question, asks before copying personal information', async () => {
    await open(a.page, 'copilot', '#tasks [data-task]')
    const f = frame(a.page)
    await f.locator('#text').fill('담당자 홍길동 010-1234-5678 에게 회신')
    await expect.poll(() => f.locator('#prompt').inputValue()).toContain('--- 아래부터 내용 ---')
    let asked = ''
    a.page.once('dialog', (d) => {
      asked = d.message()
      void d.dismiss()
    })
    await f.locator('#copyOnly').click()
    await expect.poll(() => asked, { timeout: 10000 }).toContain('휴대폰 번호 1건')
    expect(await f.locator('#toast').textContent()).not.toContain('복사했습니다')
    await f.locator('#text').fill('회의 결과를 정리한 글')
    await f.locator('#copyOnly').click()
    await expect.poll(() => f.locator('#toast').textContent(), { timeout: 10000 }).toContain('질문을 복사했습니다')
  }, 60000)

  it('messenger: everything sent to people is in one place; personal information is confirmed before sending', async () => {
    await go(a.page, '/chat')
    await a.page.getByRole('button', { name: '새 대화' }).waitFor({ timeout: 15000 })
    for (const name of ['대화', '쪽지', '공유 메모', '팀원 알람']) expect(await a.page.getByRole('button', { name, exact: true }).count(), name).toBe(1)
    await a.page.getByRole('button', { name: '새 대화' }).click()
    await a.page.getByRole('dialog').getByLabel('팀원B').check()
    await a.page.getByRole('button', { name: '대화 시작' }).click()
    await expect.poll(() => a.page.getByTestId('conv-title').textContent()).toBe('팀원B')
    let asked = ''
    a.page.once('dialog', (d) => {
      asked = d.message()
      void d.dismiss()
    })
    await a.page.getByLabel('메시지 입력').fill('주민번호 900101-1234567 입니다')
    await a.page.getByLabel('메시지 입력').press('Enter')
    await expect.poll(() => asked, { timeout: 10000 }).toContain('주민등록번호 1건: 900101-1******')
    expect(await a.page.getByTestId('message-list').textContent()).not.toContain('900101')
    a.page.once('dialog', (d) => void d.accept())
    await a.page.getByLabel('메시지 입력').press('Enter')
    await expect.poll(() => a.page.getByTestId('message-list').textContent(), { timeout: 10000 }).toContain('900101-1234567')
    // 쪽지 쓰기 is on the page header whichever tab is open
    await a.page.getByRole('button', { name: '쪽지 쓰기' }).click()
    await a.page.getByRole('dialog', { name: '쪽지 쓰기' }).waitFor()
    await a.page.getByRole('dialog').getByRole('button', { name: '닫기' }).click()
    // the member card of the directory opens a note to that member
    await go(a.page, '/directory')
    await a.page.getByTestId('member-card-팀원B').click()
    await a.page.getByRole('dialog').getByRole('button', { name: '쪽지' }).click()
    await a.page.getByRole('dialog', { name: '쪽지 쓰기' }).waitFor({ timeout: 10000 })
    expect(await a.page.getByRole('dialog', { name: '쪽지 쓰기' }).getByRole('checkbox', { name: '팀원B' }).isChecked()).toBe(true)
  }, 90000)
})
