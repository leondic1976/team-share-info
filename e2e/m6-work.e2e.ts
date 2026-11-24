import { describe, it, expect, afterAll } from 'vitest'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47900'
const csv = join(tmpdir(), 'teamhub-e2e-contacts.csv')

describe('M6 boards, directory', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
    rmSync(csv, { force: true })
  })

  it('setup', async () => {
    a = await launch({ profile: 'e2e-m6a' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-m6b' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
  })

  it('board with poll: admin creates board, member posts, votes are counted', async () => {
    await go(a.page, '/boards')
    await a.page.getByRole('button', { name: '게시판 만들기' }).click()
    await a.page.getByLabel('게시판 이름').fill('자유게시판')
    await a.page.getByRole('dialog').getByRole('button', { name: '저장' }).click()
    await go(b.page, '/boards')
    await b.page.getByRole('button', { name: '글쓰기' }).click()
    const d = b.page.getByRole('dialog')
    await d.getByLabel('글 제목').fill('회식 날짜 투표')
    await d.getByText('투표 넣기').click()
    await d.getByLabel('선택지 1').fill('목요일')
    await d.getByLabel('선택지 2').fill('금요일')
    await d.getByRole('button', { name: '등록' }).click()
    await b.page.getByTestId('post-view').waitFor()
    await go(a.page, '/boards')
    await a.page.getByTestId('post-item-회식 날짜 투표').click()
    await a.page.getByTestId('poll').getByLabel('금요일').check()
    await a.page.getByTestId('poll').getByRole('button', { name: '투표' }).click()
    await expect.poll(() => a.page.getByTestId('poll').textContent(), { timeout: 10000 }).toContain('1명 참여')
    await b.page.getByTestId('post-item-회식 날짜 투표').click()
    await expect.poll(() => b.page.getByTestId('post-view').textContent(), { timeout: 10000 }).toContain('조회 1')
  })

  it('contacts: CSV import and search', async () => {
    writeFileSync(csv, '﻿기관,이름,전화\r\nA구청,홍주무관,02-111-2222\r\nB공사,김과장,02-333-4444\r\n')
    await go(a.page, '/directory')
    await a.page.getByRole('button', { name: '외부 연락처' }).click()
    a.page.once('dialog', (dlg) => void dlg.accept())
    await a.page.getByLabel('CSV 파일 선택').setInputFiles(csv)
    await expect.poll(() => a.page.getByTestId('contact-홍주무관').count(), { timeout: 10000 }).toBe(1)
    await go(b.page, '/directory')
    await b.page.getByRole('button', { name: '외부 연락처' }).click()
    await b.page.getByLabel('연락처 검색').fill('333-4444')
    await expect.poll(() => b.page.getByTestId('contact-김과장').count(), { timeout: 10000 }).toBe(1)
    expect(await b.page.getByTestId('contact-홍주무관').count()).toBe(0)
  })
})
