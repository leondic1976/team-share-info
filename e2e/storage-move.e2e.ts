import { describe, it, expect, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

/**
 * Moving the personal and the server data folder, and changing the backup folder
 * (instruction 132: "폴더 옮기기·백업/복구 폴더 변경 때 오류·다운"). The hard cases: another
 * drive (D: when there is one), spaces and Korean in the path, a member connected, a file another
 * program holds, a move cut off by a restart, moving twice, invalid targets, a restore right
 * after the backup folder changed.
 */
const PORT = '47933'
const SHOTS = process.env.TEAMHUB_E2E_SHOTS ?? join(tmpdir(), 'teamhub-e2e-shots')
mkdirSync(SHOTS, { recursive: true })
const onD = existsSync('D:\\') && (() => {
  try {
    const d = mkdtempSync('D:\\teamhub-e2e-move-')
    rmSync(d, { recursive: true })
    return true
  } catch {
    return false
  }
})()
// the far side: another drive when the PC has one, else a temp folder
const far = mkdtempSync(onD ? 'D:\\teamhub-e2e-move-' : join(tmpdir(), 'teamhub-e2e-far-'))
const near = mkdtempSync(join(tmpdir(), 'teamhub-e2e-near-'))

const answerFolderPicker = (app: ElectronApplication, dir: string | null): Promise<void> =>
  app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (async () => (d ? { canceled: false, filePaths: [d] } : { canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog
  }, dir)

type Api = { status: number; data: Record<string, unknown> & { error?: { message: string } } }
const api = (p: Page, method: string, path: string, body?: unknown): Promise<Api> =>
  p.evaluate(
    async ({ method: m, path: u, body: b }) => {
      const c = await window.teamhub.invoke('conn:get', undefined as never)
      const r = await fetch(`${c.serverUrl}${u}`, {
        method: m,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1' },
        body: b === undefined ? undefined : JSON.stringify(b)
      })
      const j = await r.json().catch(() => ({}))
      return { status: r.status, data: { ...(j.data ?? {}), error: j.error } }
    },
    { method, path, body }
  )

const memoCount = (p: Page): Promise<number> =>
  p.evaluate(async () => (await window.teamhub.invoke('local:memos.list', { q: '' })).filter((m: { body: string }) => m.body.includes('이동 확인 메모E2E')).length)
const storageInfo = (p: Page): ReturnType<Page['evaluate']> => p.evaluate(() => window.teamhub.invoke('storage:info', undefined as never))
const connected = (p: Page, timeout = 30000): Promise<void> => p.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout })
async function shot(p: Page, name: string): Promise<void> {
  for (const dark of [false, true]) {
    await p.evaluate((d) => document.documentElement.classList.toggle('dark', d), dark)
    await p.waitForTimeout(150)
    await p.screenshot({ path: join(SHOTS, `${name}-${dark ? 'dark' : 'light'}.png`) })
  }
  await p.evaluate(() => document.documentElement.classList.remove('dark'))
}
function newestFile(dir: string): string {
  let best = ''
  let at = 0
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (statSync(p).mtimeMs >= at) {
        at = statSync(p).mtimeMs
        best = p
      }
    }
  }
  walk(dir)
  return best
}
/** Another program holding a file with no sharing at all (as an editor that locks its document). */
function lockFile(file: string): Promise<ChildProcess> {
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'None'); 'locked'; Start-Sleep -Seconds 120`], { stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise((ok, fail) => {
    ps.stdout!.on('data', (d: Buffer) => d.toString().includes('locked') && ok(ps))
    ps.on('exit', () => fail(new Error('lock helper exited')))
  })
}

describe('storage moves and backup folder changes (instruction 132)', () => {
  let a: Launched
  let b: Launched
  let serverDir0 = ''
  let lock: ChildProcess | null = null
  afterAll(async () => {
    lock?.kill()
    await b?.close()
    await a?.close()
    for (const d of [far, near]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  })

  async function restartB(confirm: () => Promise<void>, env?: Record<string, string>, onFirstWindow?: (p: Page) => Promise<void>): Promise<void> {
    const closed = b.app.waitForEvent('close', { timeout: 30000 })
    await confirm()
    await closed // E2E: the app quits instead of relaunching itself
    b = await launch({ userData: b.userData, profile: 'e2e-smb', env, onFirstWindow })
    await connected(b.page)
    await b.page.waitForTimeout(500)
  }
  async function moveLocalB(to: string, opts: { env?: Record<string, string>; onFirstWindow?: (p: Page) => Promise<void> } = {}): Promise<void> {
    await go(b.page, '/settings')
    const card = b.page.getByTestId('storage-card-local')
    await answerFolderPicker(b.app, to)
    await card.getByTestId('storage-change').click()
    await expect.poll(() => b.page.getByTestId('storage-dialog').textContent(), { timeout: 15000 }).toMatch(/옮길 자료|같습니다|없습니다|모자랍니다|수 없습니다/)
    const text = (await b.page.getByTestId('storage-dialog').textContent()) ?? ''
    expect(text, text).toContain('옮길 자료')
    await restartB(() => b.page.getByTestId('storage-confirm').click(), opts.env, opts.onFirstWindow)
  }

  it('setup: server A with a notice and an attachment, member B with a memo and a local backup', async () => {
    console.log(`[e2e] far side: ${far} (D: ${onD})`)
    a = await launch({ profile: 'e2e-sma' })
    a.page.on('dialog', (d) => void d.accept())
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-smb' })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    expect((await api(a.page, 'POST', '/api/notices', { level: 'normal', title: '이동 확인 공지E2E', bodyHtml: '<p>x</p>', scope: { type: 'team', groupIds: [], memberIds: [] } })).status).toBe(200)
    const up = await a.page.evaluate(async () => {
      const c = await window.teamhub.invoke('conn:get', undefined as never)
      const r = await fetch(`${c.serverUrl}/api/attachments?name=${encodeURIComponent('잠긴 파일.txt')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1' },
        body: 'LOCKED-FILE-CONTENT'.repeat(1000)
      })
      return r.status
    })
    expect(up).toBe(200)
    serverDir0 = ((await storageInfo(a.page)) as { server: { dir: string } }).server.dir
    await b.page.evaluate(() => window.teamhub.invoke('local:memos.save', { body: '<p>이동 확인 메모E2E</p>', color: 'yellow', tags: [] }))
    expect((await b.page.evaluate(() => window.teamhub.invoke('local:backup.now', undefined as never))).ok).toBe(true)
    expect(await memoCount(b.page)).toBe(1)
  }, 120000)

  it('targets that cannot work are refused with a reason, and checking leaves nothing behind', async () => {
    const check = (p: Page, kind: 'Local' | 'Server', to: string): Promise<{ ok: boolean; error?: string; hasData: boolean }> =>
      p.evaluate(({ k, t }) => window.teamhub.invoke(`storage:check${k}` as 'storage:checkLocal', { to: t }), { k: kind, t: to })
    const cur = ((await storageInfo(b.page)) as { local: { dir: string } }).local.dir
    expect((await check(b.page, 'Local', cur)).error).toMatch(/같습니다/)
    expect((await check(b.page, 'Local', join(cur, 'sub'))).error).toMatch(/안의 폴더/)
    expect((await check(b.page, 'Local', '\\\\teamhub-no-such-host\\share\\x')).error).toMatch(/네트워크/)
    expect((await check(b.page, 'Local', 'C:\\Windows\\TeamHub')).error).toMatch(/시스템 폴더/)
    const missing = ['Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y'].find((l) => !existsSync(`${l}:\\`))
    if (missing) expect((await check(b.page, 'Local', `${missing}:\\TeamHub`)).error).toMatch(/드라이브를 찾을 수 없습니다/)
    writeFileSync(join(near, 'a-file.txt'), 'x')
    expect((await check(b.page, 'Local', join(near, 'a-file.txt'))).error).toMatch(/폴더가 아닙니다/)
    // the personal folder and the server folder never hold one another
    expect((await check(a.page, 'Local', join(serverDir0, 'mine'))).error).toMatch(/서버 자료 폴더/)
    expect((await check(a.page, 'Server', serverDir0)).error).toMatch(/같습니다/)
    expect((await check(a.page, 'Server', join(serverDir0, 'x'))).error).toMatch(/안의 폴더/)
    // a folder with the server's data in it is not a place to move to
    mkdirSync(join(near, 'other-server'))
    writeFileSync(join(near, 'other-server', 'teamhub.db'), '')
    expect((await check(a.page, 'Server', join(near, 'other-server'))).error).toMatch(/이미 TeamHub 서버 자료/)
    // a valid check does not create the folder (a cancelled change leaves nothing)
    const fresh = join(far, '확인만 한 폴더', '안쪽')
    expect((await check(b.page, 'Local', fresh)).ok).toBe(true)
    expect(existsSync(join(far, '확인만 한 폴더'))).toBe(false)
  }, 60000)

  it('UI: a cancelled picker does nothing; the same folder shows why, with only 닫기', async () => {
    await go(b.page, '/settings')
    const card = b.page.getByTestId('storage-card-local')
    await answerFolderPicker(b.app, null)
    await card.getByTestId('storage-change').click()
    await b.page.waitForTimeout(500)
    expect(await b.page.getByTestId('storage-dialog').count()).toBe(0)
    expect(await card.getByTestId('storage-msg').count()).toBe(0)
    await answerFolderPicker(b.app, ((await storageInfo(b.page)) as { local: { dir: string } }).local.dir)
    await card.getByTestId('storage-change').click()
    await expect.poll(() => b.page.getByTestId('storage-check-error').textContent()).toContain('같습니다')
    expect(await b.page.getByTestId('storage-confirm').count()).toBe(0)
    await shot(b.page, 'local-same-folder')
    await b.page.getByTestId('dialog-backdrop').getByText('닫기', { exact: true }).click()
    await expect.poll(() => b.page.getByTestId('storage-dialog').count()).toBe(0)
  }, 60000)

  it('B moves personal data to another drive (spaces, Korean): progress window, data and backups follow', async () => {
    const target = join(far, '팀 허브 내 자료 (B)')
    // enough data that the copy takes a moment and the progress window shows
    const big = join(b.userData, 'backups', 'zz-e2e-big')
    mkdirSync(big, { recursive: true })
    for (let i = 0; i < 60; i++) writeFileSync(join(big, `f${i}.bin`), Buffer.alloc(2 * 1024 * 1024, i))
    let splash = false
    await moveLocalB(target, {
      env: { TEAMHUB_E2E_SPLASH_MS: '0' },
      onFirstWindow: async (p) => {
        if (!p.url().startsWith('data:')) return
        splash = true
        await p.waitForLoadState('domcontentloaded').catch(() => undefined)
        await p.screenshot({ path: join(SHOTS, 'local-move-window-light.png') }).catch(() => undefined)
        await p.emulateMedia({ colorScheme: 'dark' }).catch(() => undefined)
        await p.screenshot({ path: join(SHOTS, 'local-move-window-dark.png') }).catch(() => undefined)
      }
    })
    console.log(`[e2e] progress window seen: ${splash}`)
    expect(existsSync(join(target, 'local.db'))).toBe(true)
    expect(existsSync(join(target, '.teamhub-moving'))).toBe(false)
    expect(existsSync(join(b.userData, 'local.db'))).toBe(false)
    expect(await memoCount(b.page)).toBe(1)
    const bk = await b.page.evaluate(() => window.teamhub.invoke('local:backup.info', undefined as never))
    expect(bk.dir).toBe(join(target, 'backups'))
    expect(bk.snapshots.length).toBe(1)
    // (a virus scan of the fresh files may hold them a moment; the later moves just copy them along then)
    try {
      rmSync(join(target, 'backups', 'zz-e2e-big'), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch (e) {
      console.log('[e2e] big test files not removed yet:', (e as Error).message)
    }
    await go(b.page, '/settings')
    await expect.poll(() => b.page.getByTestId('storage-card-local').getByTestId('storage-dir').textContent(), { timeout: 15000 }).toBe(target)
    expect(await b.page.getByTestId('storage-last').textContent()).toContain('옮겼습니다')
  }, 180000)

  it('moving twice in a row, then restoring a local backup right after the move', async () => {
    const second = join(near, '두 번째 위치')
    await moveLocalB(second)
    expect(existsSync(join(second, 'local.db'))).toBe(true)
    expect(existsSync(join(far, '팀 허브 내 자료 (B)', 'local.db'))).toBe(false)
    expect(await memoCount(b.page)).toBe(1)
    const snap = (await b.page.evaluate(() => window.teamhub.invoke('local:backup.info', undefined as never))).snapshots[0].id
    await restartB(async () => {
      expect((await b.page.evaluate((id) => window.teamhub.invoke('local:backup.restore', { id }), snap)).ok).toBe(true)
    })
    const info = await b.page.evaluate(() => window.teamhub.invoke('local:backup.info', undefined as never))
    expect(info.restore?.ok).toBe(true)
    expect(info.dir).toBe(join(second, 'backups'))
    expect(await memoCount(b.page)).toBe(1)
  }, 180000)

  it('a move cut off by a restart: the old folder is used, the half copy cleared, the next move works', async () => {
    const cut = join(far, '끊긴 복사')
    // what a start that was cut off while copying leaves: the pointer file says "moving", the target holds a half copy
    const userData = b.userData
    await b.close({ keepData: true })
    mkdirSync(join(cut, 'backups'), { recursive: true })
    writeFileSync(join(cut, 'local.db'), 'half a database')
    writeFileSync(join(cut, '.teamhub-moving'), '{}')
    const sf = join(userData, 'storage.json')
    const st = existsSync(sf) ? JSON.parse(readFileSync(sf, 'utf8')) : {}
    writeFileSync(sf, JSON.stringify({ ...st, moving: { to: cut, at: Date.now() } }))
    b = await launch({ userData, profile: 'e2e-smb' })
    await connected(b.page)
    expect(await memoCount(b.page)).toBe(1)
    expect(existsSync(join(cut, 'local.db'))).toBe(false)
    await go(b.page, '/settings')
    await expect.poll(() => b.page.getByTestId('storage-last').textContent(), { timeout: 15000 }).toContain('도중 프로그램이 닫혀')
    // a half copy that is still there (marker) is offered as an empty folder, not as "TeamHub data"
    writeFileSync(join(cut, 'local.db'), 'half a database')
    writeFileSync(join(cut, '.teamhub-moving'), '{}')
    const c = await b.page.evaluate((to) => window.teamhub.invoke('storage:checkLocal', { to }), cut)
    expect(c).toMatchObject({ ok: true, hasData: false })
    await moveLocalB(cut)
    expect(await memoCount(b.page)).toBe(1)
    expect(existsSync(join(cut, '.teamhub-moving'))).toBe(false)
    // and back to the default folder
    await go(b.page, '/settings')
    await b.page.getByTestId('storage-card-local').getByRole('button', { name: '기본 위치로' }).click()
    await expect.poll(() => b.page.getByTestId('storage-dialog').textContent(), { timeout: 15000 }).toMatch(/옮길 자료|같습니다|없습니다|모자랍니다|수 없습니다/)
    const text = (await b.page.getByTestId('storage-dialog').textContent()) ?? ''
    expect(text, text).toContain('옮길 자료')
    await restartB(() => b.page.getByTestId('storage-confirm').click())
    expect(existsSync(join(b.userData, 'local.db'))).toBe(true)
    expect(await memoCount(b.page)).toBe(1)
  }, 180000)

  it('server move while B is connected: a file another program holds stops it cleanly, the old folder keeps working', async () => {
    const file = newestFile(join(serverDir0, 'files'))
    expect(file).toBeTruthy()
    lock = await lockFile(file)
    const target = join(far, '서버 자료 (잠김 시험)')
    await go(a.page, '/admin/backup')
    const card = a.page.getByTestId('storage-card-server')
    await answerFolderPicker(a.app, target)
    await card.getByTestId('storage-change').click()
    await a.page.getByTestId('storage-dialog').or(card.getByTestId('storage-msg')).first().waitFor({ timeout: 20000 })
    const text = (await a.page.getByTestId('storage-dialog').or(card.getByTestId('storage-msg')).first().textContent()) ?? ''
    expect(text, text).toContain('옮길 자료')
    await shot(a.page, 'server-move-confirm')
    await a.page.getByTestId('storage-confirm').click()
    // the copy retries the held file for a few seconds: progress is shown meanwhile
    await a.page.getByTestId('storage-dialog').getByTestId('storage-progress').waitFor({ timeout: 10000 })
    await shot(a.page, 'server-move-progress')
    // another start (the 서버 다시 시작 button) is refused while the data is copied
    await expect.poll(async () => (await a.page.evaluate(() => window.teamhub.invoke('server:status', undefined as never))).state, { timeout: 10000 }).toBe('stopped')
    const st = await a.page.evaluate(() => window.teamhub.invoke('server:restart', undefined as never))
    expect(st.state).toBe('stopped')
    expect(st.message).toContain('옮기는 중')
    await expect.poll(async () => ((await card.getByTestId('storage-msg').count()) ? 'done' : ''), { timeout: 90000 }).toBe('done')
    const msg = (await card.getByTestId('storage-msg').textContent()) ?? ''
    console.log('[e2e] locked move:', msg)
    expect(msg).toContain('다른 프로그램이 쓰고 있는 파일')
    await shot(a.page, 'server-move-error')
    lock.kill()
    lock = null
    expect(existsSync(join(target, 'teamhub.db'))).toBe(false)
    expect(existsSync(join(serverDir0, 'teamhub.db'))).toBe(true)
    expect(((await storageInfo(a.page)) as { server: { dir: string; running: boolean } }).server).toMatchObject({ dir: serverDir0, running: true })
    await connected(b.page)
    await go(b.page, '/notices')
    await expect.poll(() => b.page.getByText('이동 확인 공지E2E').count(), { timeout: 20000 }).toBeGreaterThanOrEqual(1)
  }, 180000)

  it('server move to another drive with B connected: data, files and the default backups follow; restart keeps it', async () => {
    lock?.kill() // (in case the test above stopped early)
    lock = null
    await new Promise((r) => setTimeout(r, 500))
    // a backup in the default place (inside the data folder) before the move
    expect((await api(a.page, 'POST', '/api/admin/backups', {})).status).toBe(200)
    const target = join(far, '서버 자료 (이동)')
    await go(a.page, '/admin/backup')
    const card = a.page.getByTestId('storage-card-server')
    await answerFolderPicker(a.app, target)
    await card.getByTestId('storage-change').click()
    await a.page.getByTestId('storage-confirm').click()
    await expect.poll(async () => ((await card.getByTestId('storage-msg').count()) ? 'done' : ''), { timeout: 120000 }).toBe('done')
    expect(await card.getByTestId('storage-msg').textContent()).toContain('옮겼습니다')
    expect(existsSync(join(target, 'teamhub.db'))).toBe(true)
    expect(existsSync(join(target, '.teamhub-moving'))).toBe(false)
    expect(existsSync(join(serverDir0, 'teamhub.db'))).toBe(false)
    const list = await api(a.page, 'GET', '/api/admin/backups')
    expect(String(list.data.root).toLowerCase().startsWith(target.toLowerCase())).toBe(true)
    expect((list.data.backups as unknown[]).length).toBe(1)
    await connected(b.page)
    await go(b.page, '/notices')
    await expect.poll(() => b.page.getByText('이동 확인 공지E2E').count(), { timeout: 20000 }).toBeGreaterThanOrEqual(1)
    // restart: the server runs from the new folder
    const userData = a.userData
    await a.close({ keepData: true })
    a = await launch({ userData, profile: 'e2e-sma' })
    a.page.on('dialog', (d) => void d.accept())
    await connected(a.page)
    expect(((await storageInfo(a.page)) as { server: { dir: string } }).server.dir).toBe(target)
  }, 240000)

  it('server move into a half copy, then back to the first folder', async () => {
    const cut = join(near, '서버 끊긴 복사')
    mkdirSync(join(cut, 'files'), { recursive: true })
    writeFileSync(join(cut, 'teamhub.db'), 'half')
    writeFileSync(join(cut, '.teamhub-moving'), '{}')
    for (const to of [cut, serverDir0]) {
      await go(a.page, '/admin/backup')
      const card = a.page.getByTestId('storage-card-server')
      await answerFolderPicker(a.app, to)
      await card.getByTestId('storage-change').click()
      await a.page.getByTestId('storage-confirm').click()
      await expect.poll(async () => ((await card.getByTestId('storage-msg').count()) ? ((await card.getByTestId('storage-msg').textContent()) ?? '') : ''), { timeout: 120000 }).toContain('옮겼습니다')
      expect(((await storageInfo(a.page)) as { server: { dir: string } }).server.dir).toBe(to)
      await a.page.reload()
      await connected(a.page)
    }
    expect(existsSync(join(cut, 'teamhub.db'))).toBe(false)
    await connected(b.page)
  }, 240000)

  it('backup folder: a bad one is refused on save; a new one (other drive) backs up and restores at once', async () => {
    await go(a.page, '/admin/settings')
    const dirInput = a.page.getByLabel('백업 위치', { exact: true })
    await dirInput.waitFor()
    const missing = ['Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y'].find((l) => !existsSync(`${l}:\\`)) ?? 'Q'
    await dirInput.fill(`${missing}:\\없는 백업`)
    await a.page.getByRole('button', { name: '설정 저장' }).click()
    await expect.poll(() => a.page.getByText(/백업 위치: /).count(), { timeout: 10000 }).toBeGreaterThanOrEqual(1)
    await a.page.getByTestId('backup-dir-hint').scrollIntoViewIfNeeded()
    await shot(a.page, 'backup-dir-refused')
    const newDir = join(far, '팀 백업 (새 위치)')
    await answerFolderPicker(a.app, newDir)
    await a.page.getByRole('button', { name: '폴더 고르기…' }).click()
    await expect.poll(() => dirInput.inputValue()).toBe(newDir)
    await a.page.getByRole('button', { name: '설정 저장' }).click()
    await expect.poll(() => a.page.getByText('저장했습니다.').count(), { timeout: 10000 }).toBe(1)
    // back up into it, add a notice after, restore: the later notice is gone, the earlier one is there
    await go(a.page, '/admin/backup')
    await a.page.getByRole('button', { name: '지금 백업' }).click()
    await expect.poll(() => a.page.getByTestId('backup-item').count(), { timeout: 20000 }).toBe(1)
    expect(readdirSync(newDir).some((n) => n.startsWith('TeamHub-'))).toBe(true)
    expect((await api(a.page, 'POST', '/api/notices', { level: 'normal', title: '복구로 사라질 공지E2E', bodyHtml: '<p>x</p>', scope: { type: 'team', groupIds: [], memberIds: [] } })).status).toBe(200)
    await a.page.getByRole('button', { name: '이 백업으로 복구' }).click()
    await a.page.getByText('복구를 위해 서버를 다시 시작합니다').waitFor({ timeout: 10000 })
    await a.page.waitForTimeout(2000)
    await connected(a.page)
    await expect
      .poll(async () => {
        const r = await api(a.page, 'GET', '/api/notices').catch(() => null)
        const text = JSON.stringify(r?.data ?? {})
        return r?.status === 200 ? `${text.includes('이동 확인 공지E2E')}/${text.includes('복구로 사라질 공지E2E')}` : 'down'
      }, { timeout: 60000 })
      .toBe('true/false')
    await connected(b.page)
  }, 180000)
})
