/**
 * Settings: switch this PC between member PC and server, remembering the connections.
 * B joins A's server, becomes a server itself, goes back to A without a new approval,
 * returns to its own server, and keeps all of it across a restart.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT_A = '47912'
const PORT_B = '47913'

const conn = (p: Page): Promise<{ mode: string | null; serverUrl: string | null; memberId: string | null }> =>
  p.evaluate(() => window.teamhub.invoke('conn:get', undefined as never))
const online = (p: Page): Promise<void> => p.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
/** The window reloads after a switch: wait until the new connection is the one in use. */
const switched = async (p: Page, mode: 'server' | 'client'): Promise<void> => {
  await expect.poll(() => conn(p).then((c) => c.mode, () => null), { timeout: 60000 }).toBe(mode)
  await online(p)
}

describe('switching between member PC and server in settings', () => {
  let a: Launched
  let b: Launched
  let memberOnA: string | null = null
  afterAll(async () => {
    if (process.env.E2E_DEBUG && b) console.log(readFileSync(join(b.userData, 'logs', 'main.log'), 'utf8').split('\n').slice(-25).join('\n'))
    await b?.close()
    await a?.close()
  })

  it('B joins A, then switches out: the first screen offers the remembered connection', async () => {
    a = await launch({ profile: 'e2e-swa' })
    await runWizard(a.page, PORT_A)
    b = await launch({ profile: 'e2e-swb' })
    b.page.on('dialog', (d) => void d.accept())
    await joinAndApprove(a.page, b.page, PORT_A, '전환팀원')
    memberOnA = (await conn(b.page)).memberId
    await go(b.page, '/settings')
    await b.page.getByRole('button', { name: /서버로 전환/ }).click()
    await b.page.getByRole('button', { name: /이 PC를 서버로 사용/ }).waitFor({ timeout: 20000 })
    expect((await conn(b.page)).mode).toBeNull()
    await expect.poll(() => b.page.getByTestId('saved-connection').count(), { timeout: 10000 }).toBe(1)
    expect(await b.page.getByTestId('saved-connection').textContent()).toContain(`127.0.0.1:${PORT_A}`)
  }, 120000)

  it('B becomes a server; the member connection stays in the settings list', async () => {
    await runWizard(b.page, PORT_B)
    expect(await conn(b.page)).toMatchObject({ mode: 'server', serverUrl: `http://127.0.0.1:${PORT_B}` })
    await go(b.page, '/settings')
    await expect.poll(() => b.page.getByTestId('server-state').textContent(), { timeout: 15000 }).toContain(`포트 ${PORT_B}`)
    expect(await b.page.getByTestId('saved-connection').textContent()).toContain('팀원 PC')
  }, 120000)

  it('back to A with one click: same member, no new approval; B\'s server is stopped and remembered', async () => {
    await b.page.getByTestId('saved-connection').getByRole('button', { name: '이 연결로 전환' }).click()
    await switched(b.page, 'client')
    expect(await conn(b.page)).toMatchObject({ mode: 'client', serverUrl: `http://127.0.0.1:${PORT_A}`, memberId: memberOnA })
    const hello = await b.page.evaluate((port) => fetch(`http://127.0.0.1:${port}/api/hello`).then(() => 'up', () => 'down'), PORT_B)
    expect(hello).toBe('down')
    await go(b.page, '/settings')
    await expect.poll(() => b.page.getByTestId('saved-connection').textContent(), { timeout: 10000 }).toContain('이 PC가 서버')
    // A sees B online again
    await go(a.page, '/directory')
    await a.page.getByText('전환팀원').first().waitFor({ timeout: 15000 })
  }, 120000)

  it('and back to its own server; everything is still there after a restart', async () => {
    await b.page.getByTestId('saved-connection').getByRole('button', { name: '이 연결로 전환' }).click()
    await switched(b.page, 'server')
    expect(await conn(b.page)).toMatchObject({ mode: 'server', serverUrl: `http://127.0.0.1:${PORT_B}` })
    await b.close({ keepData: true })
    b = await launch({ profile: 'e2e-swb', userData: b.userData })
    b.page.on('dialog', (d) => void d.accept())
    await online(b.page)
    await go(b.page, '/settings')
    await expect.poll(() => b.page.getByTestId('server-state').textContent(), { timeout: 15000 }).toContain(`포트 ${PORT_B}`)
    const saved = b.page.getByTestId('saved-connection')
    expect(await saved.count()).toBe(1)
    expect(await saved.textContent()).toContain(`127.0.0.1:${PORT_A}`)
    // forgetting removes it from the list
    await saved.getByRole('button', { name: '기억한 연결 지우기' }).click()
    await expect.poll(() => b.page.getByTestId('saved-connection').count(), { timeout: 10000 }).toBe(0)
  }, 120000)
})
