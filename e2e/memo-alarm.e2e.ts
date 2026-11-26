import { describe, it, expect } from 'vitest'
import { go, launch, runWizard } from './helpers'

const log: string[] = []
const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    const r = await fn()
    log.push(`OK   ${name}${r !== undefined ? ` -> ${JSON.stringify(r)}` : ''}`)
  } catch (e) {
    log.push(`FAIL ${name}: ${String((e as Error).message).split('\n')[0]}`)
  }
}

/**
 * Walks through every button of 메모 (내 메모, 상용구, 클립보드 기록, 빠른 메모, 화면 캡처) and 알람
 * (한 번·반복·기한·타이머, 켜기/끄기, 고치기, 삭제, 바로 타이머, 집중 타이머) like a person would.
 * Any step that fails, or any error on the page, fails the test (2026-11-25: the 상용구 tab took
 * the whole window down, 지시 73·74).
 */
describe('메모 and 알람: every function, one after another', () => {
  it('works without an error', async () => {
    const a = await launch({ profile: 'e2e-memoalarm' })
    await runWizard(a.page, '47946')
    const p = a.page
    p.on('pageerror', (e) => log.push(`PAGEERROR ${e.message}`))
    p.on('console', (m) => m.type() === 'error' && log.push(`CONSOLE ${m.text().slice(0, 200)}`))
    await go(p, '/memos')
    await step('page title', () => p.getByRole('heading', { name: '메모' }).first().textContent({ timeout: 5000 }))
    await step('new memo', async () => {
      await p.getByRole('button', { name: '새 메모' }).click()
      await p.waitForTimeout(800)
      return p.getByTestId('memo-item').count()
    })
    await step('editor shown', () => p.getByRole('textbox', { name: '메모 내용' }).count())
    await step('type', async () => {
      await p.getByRole('textbox', { name: '메모 내용' }).click({ timeout: 3000 })
      await p.keyboard.type('첫 줄 메모\n둘째 줄')
      await p.waitForTimeout(1200)
      return p.getByTestId('memo-item').first().textContent()
    })
    await step('color', async () => {
      const btns = p.locator('[aria-label*="색"]')
      const n = await btns.count()
      if (n > 1) await btns.nth(1).click()
      await p.waitForTimeout(800)
      return n
    })
    await step('pin', async () => {
      await p.getByRole('button', { name: '고정' }).click({ timeout: 3000 })
      await p.waitForTimeout(800)
      return p.getByRole('button', { name: '고정됨' }).count()
    })
    await step('tags', async () => {
      await p.getByLabel('태그').fill('회의, 전화')
      await p.waitForTimeout(1200)
      return p.getByTestId('memo-list').textContent()
    })
    await step('search', async () => {
      await p.getByLabel('메모 검색').fill('둘째')
      await p.waitForTimeout(600)
      const n = await p.getByTestId('memo-item').count()
      await p.getByLabel('메모 검색').fill('')
      return n
    })
    await step('sticky on', async () => {
      await p.getByRole('button', { name: '바탕화면에 붙이기' }).click({ timeout: 3000 })
      await p.waitForTimeout(1500)
      return a.app.windows().map((w) => w.url().split('#')[1] ?? '')
    })
    await step('sticky off', async () => {
      await p.getByRole('button', { name: '바탕화면에서 떼기' }).click({ timeout: 3000 })
      await p.waitForTimeout(1000)
      return a.app.windows().length
    })
    await step('to event', async () => {
      await p.getByRole('button', { name: '일정으로' }).click({ timeout: 3000 })
      await p.waitForTimeout(800)
      return p.getByRole('status').textContent()
    })
    await step('to diary', async () => {
      await p.getByRole('button', { name: '다이어리로' }).click({ timeout: 3000 })
      await p.waitForTimeout(800)
      return p.getByRole('status').textContent()
    })
    await step('to alarm', async () => {
      await p.getByRole('button', { name: '알람으로' }).click({ timeout: 3000 })
      await p.waitForTimeout(1000)
      return p.evaluate(() => location.hash)
    })
    await go(p, '/memos')
    await step('second new memo', async () => {
      await p.getByRole('button', { name: '새 메모' }).click()
      await p.waitForTimeout(800)
      return p.getByTestId('memo-item').count()
    })
    await step('delete memo', async () => {
      p.once('dialog', (d) => void d.accept())
      await p.getByRole('button', { name: '메모 삭제' }).click({ timeout: 3000 })
      await p.waitForTimeout(800)
      return p.getByTestId('memo-item').count()
    })
    await step('snippet tab', async () => {
      await p.getByRole('tab', { name: '상용구' }).click()
      await p.waitForTimeout(1000)
      return p.locator('body').innerText().then((t) => t.slice(0, 120))
    })
    await step('add snippet', async () => {
      await p.getByRole('button', { name: '상용구 추가' }).click({ timeout: 3000 })
      await p.getByLabel('이름').fill('인사')
      await p.getByLabel('문구').fill('안녕하세요. 잘 부탁드립니다.')
      await p.getByRole('button', { name: '저장' }).click()
      await p.waitForTimeout(800)
      return p.getByTestId('snippet').count()
    })
    await step('copy snippet', async () => {
      await p.getByRole('button', { name: '복사' }).first().click({ timeout: 3000 })
      await p.waitForTimeout(600)
      return p.getByRole('status').textContent()
    })
    await step('clipboard tab', async () => {
      await p.getByRole('tab', { name: '클립보드 기록' }).click()
      await p.waitForTimeout(800)
      await p.getByRole('switch', { name: '클립보드 기록 사용' }).click({ timeout: 3000 })
      await p.waitForTimeout(800)
      return p.getByRole('switch', { name: '클립보드 기록 사용' }).getAttribute('aria-checked')
    })
    await step('back to memo tab', async () => {
      await p.getByRole('tab', { name: '내 메모' }).click()
      await p.waitForTimeout(800)
      return p.getByTestId('memo-item').count()
    })
    await step('quick memo', async () => {
      const before = a.app.windows().length
      await p.getByRole('button', { name: '빠른 메모' }).click()
      await p.waitForTimeout(2000)
      return [before, a.app.windows().length, a.app.windows().map((w) => w.url().split('#')[1] ?? '')]
    })
    await step('capture button', async () => {
      await p.getByRole('button', { name: '화면 캡처' }).click()
      await p.waitForTimeout(800)
      // the Windows snipping tool is not started in E2E (it would open on the person's screen); the request is recorded
      return a.app.evaluate(() => (globalThis as unknown as { __teamhubOpened?: string[] }).__teamhubOpened ?? [])
    })
    // ---------- alarms ----------
    await go(p, '/alarms')
    const dlg = p.getByRole('dialog')
    const d = new Date(Date.now() + 2 * 3600_000)
    const p2 = (n: number) => String(n).padStart(2, '0')
    await step('alarm once', async () => {
      await p.getByRole('button', { name: '알람 추가' }).click()
      await dlg.getByLabel('알람 이름').fill('한번알람')
      await dlg.getByLabel('울릴 일시', { exact: true }).fill(`${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`)
      await dlg.getByLabel('울릴 일시 시', { exact: true }).selectOption(String(d.getHours()))
      await dlg.getByLabel('울릴 일시 분', { exact: true }).selectOption('7')
      await dlg.getByRole('button', { name: '저장' }).click()
      await p.waitForTimeout(800)
      await p.getByRole('tab', { name: '내 알람' }).click()
      return p.getByTestId('alarm-list').textContent({ timeout: 3000 })
    })
    await step('alarm repeat', async () => {
      await p.getByRole('button', { name: '알람 추가' }).click()
      await dlg.getByLabel('알람 이름').fill('반복알람')
      await dlg.getByRole('radio', { name: '반복' }).click()
      await dlg.getByLabel('시각 시', { exact: true }).selectOption('8')
      await dlg.getByLabel('시각 분', { exact: true }).selectOption('45')
      await dlg.getByRole('button', { name: '저장' }).click()
      await p.waitForTimeout(800)
      return p.getByTestId('alarm-list').textContent({ timeout: 3000 })
    })
    await step('alarm deadline', async () => {
      await p.getByRole('button', { name: '알람 추가' }).click()
      await dlg.getByLabel('알람 이름').fill('기한알람')
      await dlg.getByRole('radio', { name: '기한' }).click()
      await dlg.getByLabel('마감 일시', { exact: true }).fill(`${d.getFullYear() + 1}-01-15`)
      await dlg.getByRole('button', { name: '저장' }).click()
      await p.waitForTimeout(800)
      return p.getByTestId('alarm-item').count()
    })
    await step('alarm timer', async () => {
      await p.getByRole('button', { name: '알람 추가' }).click()
      await dlg.getByLabel('알람 이름').fill('타이머알람')
      await dlg.getByRole('radio', { name: '타이머' }).click()
      await dlg.getByRole('button', { name: '저장' }).click()
      await p.waitForTimeout(800)
      return p.getByTestId('alarm-item').count()
    })
    await step('quick timer', async () => {
      await p.getByRole('button', { name: '5분', exact: true }).click()
      await p.waitForTimeout(800)
      return p.getByTestId('alarm-item').count()
    })
    await step('toggle off', async () => {
      const row = p.getByTestId('alarm-item').filter({ hasText: '타이머알람' })
      await row.getByRole('switch').click()
      await p.waitForTimeout(800)
      return p.getByTestId('alarm-item').filter({ hasText: '타이머알람' }).getByRole('switch').getAttribute('aria-checked')
    })
    await step('edit alarm', async () => {
      await p.getByTestId('alarm-item').filter({ hasText: '한번알람' }).getByText('한번알람').click()
      await dlg.getByLabel('알람 이름').fill('한번알람-고침', { timeout: 5000 })
      await dlg.getByRole('button', { name: '저장' }).click()
      await p.waitForTimeout(800)
      return p.getByTestId('alarm-list').textContent()
    })
    await step('delete alarm', async () => {
      p.once('dialog', (x) => void x.accept())
      await p.getByRole('button', { name: '반복알람 삭제' }).click()
      await p.waitForTimeout(800)
      return p.getByTestId('alarm-item').count()
    })
    await step('today tab', async () => {
      await p.getByRole('tab', { name: '오늘 울릴 알림' }).click()
      await p.waitForTimeout(800)
      return (await p.locator('main').innerText()).slice(0, 200)
    })
    await step('focus', async () => {
      await p.getByRole('tab', { name: '집중 타이머' }).click()
      await p.getByRole('button', { name: /집중 시작|시작/ }).first().click()
      await p.waitForTimeout(1500)
      const t = (await p.locator('main').innerText()).slice(0, 160)
      await p.getByRole('button', { name: /그만|멈추|종료|중지/ }).first().click().catch(() => undefined)
      return t
    })
    await a.close()
    expect(log.filter((l) => !l.startsWith('OK')), log.join('\n')).toEqual([])
  }, 180000)
})
