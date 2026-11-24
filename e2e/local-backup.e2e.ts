import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Page } from 'playwright-core'
import { go, launch, runWizard, type Launched } from './helpers'

const PORT = '47923'
const SNAP = /^local-\d{8}-\d{6}-(auto|manual|safety)\.db$/

type Bridge = { teamhub: { invoke: (channel: string, req?: unknown) => Promise<unknown> } }
type Memo = { id: string; body: string }
const memos = (p: Page): Promise<Memo[]> => p.evaluate(() => (window as unknown as Bridge).teamhub.invoke('local:memos.list', { q: '' }) as Promise<Memo[]>)
const bodies = async (p: Page): Promise<string[]> => (await memos(p)).map((m) => m.body).sort()
const saveMemo = (p: Page, body: string): Promise<unknown> => p.evaluate((b) => (window as unknown as Bridge).teamhub.invoke('local:memos.save', { body: b }), body)
const snapshots = (userData: string, kind?: string): string[] => {
  const dir = join(userData, 'backups')
  return existsSync(dir) ? readdirSync(dir).filter((n) => SNAP.test(n) && (!kind || n.endsWith(`-${kind}.db`))) : []
}
/** Memo bodies inside a snapshot file, read straight from the file. */
function memosIn(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (db.prepare('SELECT body FROM memos').all() as { body: string }[]).map((r) => r.body).sort()
  } finally {
    db.close()
  }
}

describe('내 자료 백업 · 복구: snapshots of the personal data of this PC', () => {
  let a: Launched
  let userData = ''
  afterAll(async () => {
    await a?.close()
  })

  it('지금 백업 makes a snapshot next to the local DB and lists it', async () => {
    a = await launch({ profile: 'e2e-lb' })
    userData = a.userData
    await runWizard(a.page, PORT)
    await saveMemo(a.page, '백업 전에 쓴 메모')
    await saveMemo(a.page, '나중에 지울 메모')
    expect(await bodies(a.page)).toEqual(['나중에 지울 메모', '백업 전에 쓴 메모'])

    await go(a.page, '/settings')
    const card = a.page.getByTestId('backup-card')
    await card.waitFor({ timeout: 15000 })
    expect(await card.getByTestId('backup-status').textContent()).toContain('아직 백업이 없습니다')
    expect((await card.getByTestId('backup-dir').textContent())?.trim()).toBe(join(userData, 'backups'))
    // (E2E runs make no daily snapshot unless asked: nothing is there yet)
    expect(snapshots(userData)).toEqual([])
    // the existing file export/import live in this card now
    expect(await card.getByRole('button', { name: '파일로 내보내기' }).count()).toBe(1)
    expect(await card.getByRole('button', { name: '파일에서 가져오기' }).count()).toBe(1)

    await card.getByTestId('backup-now').click()
    await expect.poll(() => card.getByTestId('backup-rows').locator('li').count(), { timeout: 20000 }).toBe(1)
    expect(await card.getByTestId('backup-msg').textContent()).toContain('백업했습니다')
    expect(await card.getByTestId('backup-status').textContent()).toMatch(/마지막 백업 \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 백업 1개/)
    const made = snapshots(userData, 'manual')
    expect(made).toHaveLength(1)
    expect(memosIn(join(userData, 'backups', made[0]))).toEqual(['나중에 지울 메모', '백업 전에 쓴 메모'])
    // nothing half-made, no side files of the copy
    expect(readdirSync(join(userData, 'backups')).filter((n) => !SNAP.test(n) && n !== 'state.json')).toEqual([])
  }, 120000)

  it('the renderer can only name a snapshot: anything that looks like a path is refused', async () => {
    const tryRestore = (id: string): Promise<string> =>
      a.page.evaluate(
        (i) =>
          (window as unknown as Bridge).teamhub.invoke('local:backup.restore', { id: i }).then(
            (r) => JSON.stringify(r),
            () => 'refused'
          ),
        id
      )
    expect(await tryRestore('../local.db')).toBe('refused')
    expect(await tryRestore('..\\..\\seats.json')).toBe('refused')
    expect(await tryRestore(join(userData, 'local.db'))).toBe('refused')
    // a well-formed name of a snapshot that is not there
    expect(await tryRestore('local-20200101-000000-manual.db')).toContain('"ok":false')
    expect(existsSync(join(userData, 'backups', 'restore-pending.json'))).toBe(false)
  }, 30000)

  it('이 백업으로 복구: today is saved first, the program restarts with the snapshot, the memo is back', async () => {
    // the data moves on after the snapshot
    const all = await memos(a.page)
    const doomed = all.find((m) => m.body === '나중에 지울 메모')!
    await a.page.evaluate((id) => (window as unknown as Bridge).teamhub.invoke('local:memos.delete', { id }), doomed.id)
    await saveMemo(a.page, '백업 뒤에 쓴 메모')
    expect(await bodies(a.page)).toEqual(['백업 뒤에 쓴 메모', '백업 전에 쓴 메모'])

    const card = a.page.getByTestId('backup-card')
    await card.getByTestId('backup-rows').getByRole('button', { name: '이 백업으로 복구' }).click()
    const ask = a.page.getByTestId('backup-ask')
    const text = (await ask.textContent()) ?? ''
    expect(text).toContain('먼저 지금 자료를 따로 백업합니다')
    expect(text).toContain('다시 시작')
    expect(text).toContain('서버의 자료')
    const closed = a.app.waitForEvent('close', { timeout: 30000 })
    await a.page.getByTestId('backup-ask-ok').click()
    await closed // E2E: the app quits instead of relaunching itself

    // staged, and the state right before the restore is its own snapshot
    expect(existsSync(join(userData, 'backups', 'restore-pending.json'))).toBe(true)
    const safety = snapshots(userData, 'safety')
    expect(safety).toHaveLength(1)
    expect(memosIn(join(userData, 'backups', safety[0]))).toEqual(['백업 뒤에 쓴 메모', '백업 전에 쓴 메모'])

    a = await launch({ userData, profile: 'e2e-lb' })
    await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    expect(await bodies(a.page)).toEqual(['나중에 지울 메모', '백업 전에 쓴 메모'])
    expect(existsSync(join(userData, 'backups', 'restore-pending.json'))).toBe(false)
    expect(existsSync(join(userData, 'backups', 'restore-pending.db'))).toBe(false)
    expect(readdirSync(userData).filter((n) => n.includes('.replaced'))).toEqual([])

    await go(a.page, '/settings')
    const after = a.page.getByTestId('backup-card')
    await after.waitFor({ timeout: 15000 })
    expect(await after.getByTestId('backup-restore-result').textContent()).toContain('복구했습니다')
    // both snapshots are still listed: the one restored and the one made right before
    await expect.poll(() => after.getByTestId('backup-rows').locator('li').count(), { timeout: 10000 }).toBe(2)
    expect(await after.getByTestId('backup-row-safety').textContent()).toContain('복구 직전')
    await after.getByRole('button', { name: '알림 닫기' }).click()
    await expect.poll(() => after.getByTestId('backup-restore-result').count(), { timeout: 10000 }).toBe(0)
  }, 150000)

  it('undo: restoring the snapshot made right before brings the later memo back', async () => {
    const card = a.page.getByTestId('backup-card')
    await card.getByTestId('backup-row-safety').getByRole('button', { name: '이 백업으로 복구' }).click()
    const closed = a.app.waitForEvent('close', { timeout: 30000 })
    await a.page.getByTestId('backup-ask-ok').click()
    await closed
    a = await launch({ userData, profile: 'e2e-lb' })
    await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    expect(await bodies(a.page)).toEqual(['백업 뒤에 쓴 메모', '백업 전에 쓴 메모'])
    // the snapshot that was restored was not pruned by the safety snapshot made for this restore
    expect(snapshots(userData, 'safety')).toHaveLength(2)
  }, 120000)

  it('지우기 removes one snapshot; the keep count is saved', async () => {
    await go(a.page, '/settings')
    const card = a.page.getByTestId('backup-card')
    await card.waitFor({ timeout: 15000 })
    await expect.poll(() => card.getByTestId('backup-rows').locator('li').count(), { timeout: 10000 }).toBe(3)
    await card.getByTestId('backup-row-manual').getByRole('button', { name: '지우기' }).click()
    expect(await a.page.getByTestId('backup-ask').textContent()).toContain('되돌릴 수 없습니다')
    await a.page.getByTestId('backup-ask-ok').click()
    await expect.poll(() => card.getByTestId('backup-rows').locator('li').count(), { timeout: 10000 }).toBe(2)
    expect(snapshots(userData, 'manual')).toEqual([])
    expect(await bodies(a.page)).toEqual(['백업 뒤에 쓴 메모', '백업 전에 쓴 메모']) // the data in use is untouched

    await card.getByLabel('자동 백업 보관 개수').fill('2')
    await card.getByRole('button', { name: '개수 바꾸기' }).click()
    await expect.poll(() => card.getByTestId('backup-msg').textContent(), { timeout: 10000 }).toContain('3~30')
    await card.getByLabel('자동 백업 보관 개수').fill('12')
    await card.getByRole('button', { name: '개수 바꾸기' }).click()
    await expect.poll(() => card.getByTestId('backup-msg').textContent(), { timeout: 10000 }).toContain('12개')
    const info = (await a.page.evaluate(() => (window as unknown as Bridge).teamhub.invoke('local:backup.info'))) as { keep: number }
    expect(info.keep).toBe(12)
  }, 60000)

  it('the daily snapshot is made by itself once, and not again while nothing is due', async () => {
    await a.close({ keepData: true })
    a = await launch({ userData, profile: 'e2e-lb', env: { TEAMHUB_E2E_AUTOBACKUP: '1' } })
    await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    await expect.poll(() => snapshots(userData, 'auto').length, { timeout: 30000 }).toBe(1)
    await a.close({ keepData: true })
    a = await launch({ userData, profile: 'e2e-lb', env: { TEAMHUB_E2E_AUTOBACKUP: '1' } })
    await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    await a.page.waitForTimeout(5000)
    expect(snapshots(userData, 'auto')).toHaveLength(1)
    const info = (await a.page.evaluate(() => (window as unknown as Bridge).teamhub.invoke('local:backup.info'))) as { keep: number; note: string | null; snapshots: { kind: string }[] }
    expect(info.keep).toBe(12)
    expect(info.note).toBeNull()
    expect(info.snapshots.filter((s) => s.kind === 'auto')).toHaveLength(1)
  }, 150000)
})
