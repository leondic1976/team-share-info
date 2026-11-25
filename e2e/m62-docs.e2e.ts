import { describe, it, expect, afterAll } from 'vitest'
import { fillDateTime, go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47901'

describe('M6-2 knowledge records', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup', async () => {
    a = await launch({ profile: 'e2e-m62a' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-m62b' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
  })

  it('must-read: unread on B, read status on A', async () => {
    await go(a.page, '/docs/mustread')
    await a.page.getByRole('button', { name: '알아둘 사항 쓰기' }).click()
    await a.page.getByLabel('문서 제목').fill('개인정보 처리 수칙')
    await a.page.getByRole('dialog').getByRole('button', { name: '저장' }).click()
    await a.page.getByTestId('doc-view').waitFor()
    await go(b.page, '/home')
    await expect.poll(() => b.page.getByTestId('widget-mustread').textContent(), { timeout: 10000 }).toContain('개인정보 처리 수칙')
    await b.page.getByTestId('widget-mustread').getByText('개인정보 처리 수칙').click()
    await b.page.getByTestId('doc-view').waitFor()
    await go(a.page, '/docs/mustread')
    await expect.poll(() => a.page.getByTestId('doc-item-개인정보 처리 수칙').textContent(), { timeout: 10000 }).toContain('읽음 1/1')
  })

  it('meeting -> minutes with attendees; follow-ups are plain text in the minutes', async () => {
    const start = Date.now() + 3600000
    await go(a.page, '/calendar')
    await a.page.getByRole('button', { name: '새 일정' }).click()
    const d = a.page.getByRole('dialog', { name: '새 일정' })
    await d.getByRole('radio', { name: /공유 일정/ }).click()
    await d.getByLabel('일정 제목').fill('주간 업무 회의')
    await fillDateTime(d, '시작', start)
    await fillDateTime(d, '끝', start + 3600000)
    await d.getByLabel('팀원B').check()
    await d.getByRole('button', { name: '저장' }).click()
    await d.waitFor({ state: 'detached' })
    await a.page.getByTestId('calendar').getByText('주간 업무 회의').first().click()
    await a.page.getByRole('button', { name: '회의록 작성' }).click()
    const ed = a.page.getByRole('dialog')
    await expect.poll(() => ed.getByLabel('문서 제목').inputValue()).toContain('회의록 - 주간 업무 회의')
    expect(await ed.getByRole('textbox', { name: '본문' }).textContent()).toContain('팀원B')
    await ed.getByRole('button', { name: '저장' }).click()
    await a.page.getByTestId('doc-view').waitFor()
    // follow-ups stay in the minutes as text: there is no "register as a task" action any more
    expect(await a.page.getByTestId('followup').count()).toBe(0)
  })

  it('annual task appears on the calendar', async () => {
    await go(a.page, '/docs/annual')
    await a.page.getByRole('button', { name: '연간 업무 추가' }).click()
    const d = a.page.getByRole('dialog')
    await d.getByLabel('연간 업무 이름').fill('하반기 예산 결산')
    await d.getByLabel('월').selectOption(String(new Date().getMonth() + 1))
    await d.getByLabel('일').fill('20')
    await d.getByRole('button', { name: '저장' }).click()
    await expect.poll(() => a.page.getByTestId(`annual-month-${new Date().getMonth() + 1}`).textContent()).toContain('하반기 예산 결산')
    await go(b.page, '/calendar')
    await expect.poll(() => b.page.getByTestId('calendar').textContent(), { timeout: 10000 }).toContain('하반기 예산 결산')
  })
})
