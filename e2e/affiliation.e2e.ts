import { describe, it, expect, afterAll } from 'vitest'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47936'
const PATH = '행정지원본부 > 총무과 > 서무팀'

describe('affiliation (소속): a person types a multi-level affiliation; the server PC sees and confirms it', () => {
  let a: Launched
  let b: Launched

  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('a member types three levels in 내 정보: the levels that do not exist are added', async () => {
    a = await launch({ profile: 'e2e-aff-a' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-aff-b' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')

    await go(b.page, '/settings')
    const card = b.page.getByTestId('profile-card')
    await card.waitFor({ timeout: 15000 })
    await card.getByRole('button', { name: '목록에 없으면 직접 입력' }).click()
    // levels are split on ">" and on "/"
    await card.getByLabel('소속 직접 입력').fill('행정지원본부 > 총무과 / 서무팀')
    await expect.poll(() => card.getByTestId('dept-typed-levels').textContent(), { timeout: 10000 }).toContain('서무팀 · 새로 추가')
    expect(await card.getByTestId('dept-picked').textContent()).toBe(PATH)
    await card.getByRole('button', { name: '저장', exact: true }).click()
    await expect.poll(() => card.getByTestId('profile-msg').textContent(), { timeout: 10000 }).toContain('새로 입력한 소속 3개')
    // after saving it is an ordinary entry of the list, chosen
    await expect.poll(() => card.getByTestId('dept-picked').textContent(), { timeout: 10000 }).toBe(PATH)
    await expect.poll(() => card.getByTestId(`dept-option-${PATH}`).getAttribute('aria-selected'), { timeout: 10000 }).toBe('true')
  }, 150000)

  it('the server PC sees the mark in 조직 관리 and the full affiliation in 주소록 and 조직도', async () => {
    const p = a.page
    await go(p, '/settings')
    const org = p.getByTestId('org-manage-card')
    await org.waitFor({ timeout: 15000 })
    await expect.poll(() => org.getByTestId('org-entered-notice').textContent(), { timeout: 10000 }).toContain('구성원이 입력한 소속이 3개')
    expect(await org.getByTestId('org-entered-서무팀').textContent()).toContain('구성원이 입력한 소속 · 팀원B')
    // confirmed as typed: the mark goes, the department stays
    await org.getByRole('button', { name: '서무팀 확인' }).click()
    await expect.poll(() => org.getByTestId('org-entered-서무팀').count(), { timeout: 10000 }).toBe(0)
    expect(await org.getByTestId('org-dept-row-서무팀').count()).toBe(1)

    await go(p, '/directory')
    await p.getByTestId(`directory-dept-${PATH}`).waitFor({ timeout: 10000 })
    await p.getByTestId('member-card-팀원B').click()
    await expect.poll(() => p.getByTestId('member-affiliation').textContent(), { timeout: 10000 }).toBe(PATH)
    await p.keyboard.press('Escape')

    await go(p, '/org')
    await p.getByTestId('org-dept-서무팀').waitFor({ timeout: 10000 })
    await p.getByTestId('org-person-팀원B').click()
    await expect.poll(() => p.getByTestId('member-affiliation').textContent(), { timeout: 10000 }).toBe(PATH)
  }, 60000)
})
