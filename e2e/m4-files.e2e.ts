import { describe, it, expect, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { TransferItem } from '../src/shared/ipc'
import { go, launch, runWizard, type Launched } from './helpers'

const PORT = '47897'
const BIG = 1024 * 1024 * 1024 // 1GB (13.12 M4 verification)
const bigPath = join(tmpdir(), `teamhub-e2e-1gb-${Date.now()}.bin`)
// ASCII name on disk: Vitest 5.1 workers crash when the test process creates non-ASCII file names on Windows (13.13).
const smallPath = join(tmpdir(), `teamhub-e2e-report.txt`)

function makeBigFile(): string {
  const hash = createHash('sha256')
  const block = Buffer.alloc(1024 * 1024)
  const fd = openSync(bigPath, 'w')
  for (let i = 0; i < BIG / block.length; i++) {
    for (let j = 0; j < block.length; j += 4096) block.writeUInt32LE((i * 2654435761 + j) >>> 0, j)
    writeSync(fd, block)
    hash.update(block)
  }
  closeSync(fd)
  return hash.digest('hex')
}

const transfers = (l: Launched): Promise<TransferItem[]> => l.page.evaluate(() => window.teamhub.invoke('transfer:list', undefined as never))

describe('M4 files', () => {
  let a: Launched
  let folderId = ''
  let expected = ''
  afterAll(async () => {
    await a?.close()
    rmSync(bigPath, { force: true })
    rmSync(smallPath, { force: true })
  })

  it('creates a root folder and uploads a small file through the UI flow', async () => {
    a = await launch({ profile: 'e2e-m4' })
    await runWizard(a.page, PORT)
    await go(a.page, '/files')
    await a.page.getByRole('button', { name: '새 폴더' }).click()
    await a.page.getByLabel('폴더 이름').fill('공용자료')
    await a.page.getByRole('dialog').getByRole('button', { name: '저장' }).click()
    await a.page.getByTestId('folder-row-공용자료').click()
    await expect.poll(() => a.page.evaluate(() => window.location.hash)).toMatch(/#\/files\/.+/)
    folderId = (await a.page.evaluate(() => window.location.hash)).split('/').pop()!
    writeFileSync(smallPath, '첫 번째 버전')
    await a.page.evaluate(([p, f]) => window.teamhub.invoke('transfer:upload', { paths: [p], folderId: f }), [smallPath, folderId])
    await a.page.getByTestId('file-row-teamhub-e2e-report.txt').waitFor({ timeout: 15000 })
    // same name again -> version 2
    writeFileSync(smallPath, '두 번째 버전입니다')
    await a.page.evaluate(([p, f]) => window.teamhub.invoke('transfer:upload', { paths: [p], folderId: f }), [smallPath, folderId])
    await expect.poll(() => a.page.getByTestId('file-row-teamhub-e2e-report.txt').textContent(), { timeout: 15000 }).toContain('v2')
    await a.page.getByTestId('file-row-teamhub-e2e-report.txt').click()
    await a.page.getByTestId('version-1').waitFor()
    expect(await a.page.getByTestId('version-2').textContent()).toContain('현재')
    await a.page.getByRole('dialog').getByRole('button', { name: '닫기' }).click()
  })

  it('1GB upload survives an app crash and resumes to a matching hash', async () => {
    // The default limit is 500MB per file; raise it in the admin settings first.
    await go(a.page, '/admin/settings')
    await a.page.getByLabel('파일당 최대 크기').fill('2048')
    await a.page.getByRole('button', { name: '설정 저장' }).click()
    await a.page.getByText('저장했습니다.').waitFor({ timeout: 10000 })
    await go(a.page, `/files/${folderId}`)
    expected = makeBigFile()
    await a.page.evaluate(([p, f]) => window.teamhub.invoke('transfer:upload', { paths: [p], folderId: f }), [bigPath, folderId])
    // wait until a good part is sent, then kill the app hard
    await expect.poll(async () => (await transfers(a)).find((t) => t.name.endsWith('.bin'))?.done ?? 0, { timeout: 120000, interval: 500 }).toBeGreaterThan(300 * 1024 * 1024)
    const before = (await transfers(a)).find((t) => t.name.endsWith('.bin'))!
    expect(before.status).toBe('running')
    // Simulate a crash: kill the whole Electron process tree.
    execFileSync('taskkill', ['/F', '/T', '/PID', String(a.app.process().pid)])
    await a.app.close().catch(() => undefined)
    await new Promise((r) => setTimeout(r, 2000))

    a = await launch({ profile: 'e2e-m4', userData: a.userData })
    try {
      await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    } catch (e) {
      const lines = readFileSync(join(a.userData, 'logs', 'main.log'), 'utf8').split(String.fromCharCode(10))
      console.log('MAINLOG', lines.slice(-40).join(String.fromCharCode(10)))
      throw e
    }
    await expect
      .poll(async () => (await transfers(a)).find((t) => t.name.endsWith('.bin'))?.status, { timeout: 300000, interval: 1000 })
      .toBe('done')
    const after = (await transfers(a)).find((t) => t.name.endsWith('.bin'))!
    expect(after.done).toBe(BIG)
    // The server stores blobs by content hash: the blob named after the original hash must exist with the full size.
    const blob = join(a.userData, 'server-data', 'files', expected.slice(0, 2), expected.slice(2, 4), expected)
    expect(existsSync(blob)).toBe(true)
    expect(statSync(blob).size).toBe(BIG)
    await go(a.page, `/files/${folderId}`)
    await a.page.getByTestId(`file-row-${after.name}`).waitFor({ timeout: 15000 })
  }, 600000)

  it('delete -> trash -> restore', async () => {
    const row = a.page.getByTestId('file-row-teamhub-e2e-report.txt')
    await row.getByRole('button', { name: '더 보기' }).click()
    a.page.once('dialog', (d) => void d.accept())
    await a.page.getByRole('button', { name: '삭제' }).click()
    await expect.poll(() => row.count(), { timeout: 10000 }).toBe(0)
    await a.page.getByRole('button', { name: '휴지통' }).click()
    await a.page.getByRole('button', { name: '복원' }).first().click()
    await a.page.getByRole('button', { name: '휴지통' }).click()
    await expect.poll(() => a.page.getByTestId('file-row-teamhub-e2e-report.txt').count(), { timeout: 10000 }).toBe(1)
  })
})
