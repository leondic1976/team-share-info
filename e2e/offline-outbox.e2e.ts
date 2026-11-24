import { describe, it, expect, afterAll } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47893'
const MARK = 'OFFLINE-OUTBOX-MARK-7Q2'
const CACHED = 'CACHED-ONLINE-MARK-4K9'

/** Any file under dir that holds the text as plain bytes. */
function filesWith(dir: string, text: string): string[] {
  const hit: string[] = []
  const needle = Buffer.from(text, 'utf8')
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p)
      else if (st.size < 64 * 1024 * 1024 && /\.(db|db-wal|sqlite|json|log)$/i.test(n)) {
        try {
          if (readFileSync(p).includes(needle)) hit.push(p)
        } catch {
          // locked by the running app
        }
      }
    }
  }
  walk(dir)
  return hit
}

async function leaveMemo(p: Page, text: string): Promise<void> {
  await go(p, '/chat')
  await p.getByRole('button', { name: '공유 메모', exact: true }).click()
  await p.getByRole('button', { name: '공유 메모 남기기' }).click()
  const dlg = p.getByRole('dialog', { name: '공유 메모 남기기' })
  await dlg.getByLabel('공유 메모 내용').fill(text)
  await dlg.getByRole('button', { name: '남기기' }).click()
}

describe('server PC off: cached data, outbox, sync when it is back', () => {
  let a: Launched
  let b: Launched
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup: member B sees a memo while the server is on', async () => {
    a = await launch({ profile: 'e2e-offa' })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-offb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    expect(await b.page.getByTestId('conn-chip').getAttribute('data-state')).toBe('on')
    await leaveMemo(a.page, CACHED)
    await go(b.page, '/chat')
    await b.page.getByRole('button', { name: '공유 메모', exact: true }).click()
    await expect.poll(() => b.page.getByText(CACHED).count(), { timeout: 10000 }).toBeGreaterThanOrEqual(1)
    await b.page.waitForTimeout(4000) // the cache is written a few seconds after loading
  })

  it('server off: the top bar says so, cached data stays, a new memo waits on this PC', async () => {
    await a.close({ keepData: true })
    await expect.poll(() => b.page.getByTestId('conn-chip').getAttribute('data-state'), { timeout: 30000 }).toBe('off')
    expect(await b.page.getByTestId('conn-chip').textContent()).toContain('서버 꺼짐')
    expect(await b.page.getByText(CACHED).count()).toBeGreaterThanOrEqual(1)
    await leaveMemo(b.page, MARK)
    await expect.poll(() => b.page.getByTestId('outbox-count').textContent(), { timeout: 10000 }).toContain('1')
    await b.page.getByTestId('conn-chip').click()
    expect(await b.page.getByTestId('outbox-list').textContent()).toContain('공유 메모')
    expect(await b.page.getByTestId('add-server').count()).toBe(1)
    await b.page.keyboard.press('Escape')
  }, 60000)

  it('what is kept on the PC is sealed: neither the cached memo nor the waiting one is readable in its files', async () => {
    await b.page.waitForTimeout(1500)
    expect(filesWith(b.userData, MARK)).toEqual([])
    expect(filesWith(b.userData, CACHED)).toEqual([])
  })

  it('B restarts with the server still off: cached memo and the waiting one are still there', async () => {
    const userData = b.userData
    await b.close({ keepData: true })
    b = await launch({ userData, profile: 'e2e-offb' })
    await expect.poll(() => b.page.getByTestId('conn-chip').getAttribute('data-state'), { timeout: 30000 }).not.toBe('on')
    await expect.poll(() => b.page.getByTestId('outbox-count').textContent(), { timeout: 10000 }).toContain('1')
    await go(b.page, '/chat')
    await b.page.getByRole('button', { name: '공유 메모', exact: true }).click()
    await expect.poll(() => b.page.getByText(CACHED).count(), { timeout: 10000 }).toBeGreaterThanOrEqual(1)
  }, 60000)

  it('server back: B reconnects by itself within seconds and the memo arrives once', async () => {
    const userData = a.userData
    a = await launch({ userData, profile: 'e2e-offa' })
    await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    await expect.poll(() => b.page.getByTestId('conn-chip').getAttribute('data-state'), { timeout: 30000 }).toBe('on')
    await expect.poll(() => b.page.getByTestId('outbox-count').count(), { timeout: 20000 }).toBe(0)
    await go(a.page, '/chat')
    await a.page.getByRole('button', { name: '공유 메모', exact: true }).click()
    await expect.poll(() => a.page.getByText(MARK).count(), { timeout: 15000 }).toBe(1)
    await expect.poll(() => b.page.getByText(MARK).count(), { timeout: 15000 }).toBe(1)
  }, 90000)
})
