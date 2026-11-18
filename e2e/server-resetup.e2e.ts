/**
 * Setting the server up again on a PC that was a server before: the data folder still holds
 * the old team, so the wizard asks, moves the old data aside and creates the new team.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { go, launch, runWizard, type Launched } from './helpers'

const PORT = '47916'

describe('server set up again in a data folder that already has a team', () => {
  let a: Launched
  const dialogs: string[] = []
  afterAll(async () => {
    await a?.close()
  })

  it('after a connection reset the wizard creates a new team in the same folder', async () => {
    a = await launch({ profile: 'e2e-resetup' })
    a.page.on('dialog', (d) => {
      dialogs.push(d.message())
      void d.accept()
    })
    await runWizard(a.page, PORT)
    const dataDir = join(a.userData, 'server-data')
    expect(existsSync(join(dataDir, 'teamhub.db'))).toBe(true)

    await go(a.page, '/settings')
    await a.page.getByRole('button', { name: /연결 초기화/ }).click()
    await a.page.getByRole('button', { name: /이 PC를 서버로 사용/ }).waitFor({ timeout: 20000 })

    // same (suggested) data folder: asks once, then succeeds
    await runWizard(a.page, PORT)
    expect(dialogs.some((m) => m.includes('이미 "E2E기관 검증팀" 서버 자료가 있습니다'))).toBe(true)
    const previous = readdirSync(dataDir).filter((n) => n.startsWith('previous-'))
    expect(previous).toHaveLength(1)
    expect(existsSync(join(dataDir, previous[0]!, 'teamhub.db'))).toBe(true)
    expect(existsSync(join(dataDir, 'teamhub.db'))).toBe(true)
    const conn = await a.page.evaluate(() => window.teamhub.invoke('conn:get', undefined as never))
    expect(conn).toMatchObject({ mode: 'server', serverUrl: `http://127.0.0.1:${PORT}` })
  }, 180000)
})
