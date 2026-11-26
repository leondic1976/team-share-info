import { app, BrowserWindow, dialog } from 'electron'
import log from 'electron-log/main'
import { z } from 'zod'
import { handle } from './registry'
import { isInside, normalizeTarget, samePath, treeSizeAsync } from '../../node/datamove'
import type { StorageCheck, StorageProgress } from '../../shared/ipc'
import { getMode, getServerConfig, setServerConfig } from '../connection'
import { holdServer, serverStatus, startServer, stopServer } from '../server-host'
import { setQuitting } from '../windows/main-window'
import { otherSeatDataProblem } from '../seats'
import {
  checkLocalTarget,
  checkServerTarget,
  clearLastStorageResult,
  copyServerData,
  defaultLocalDir,
  lastStorageResult,
  LOCAL_ENTRIES,
  localDir,
  moveErrorText,
  removeOldServerData,
  stageLocalChange,
  driveLocalDir
} from '../storage'

const path = z.string().min(3).max(500)

/** One move at a time, for both folders; kept here so a screen opened later still sees it. */
let busy: { kind: 'local' | 'server'; progress: StorageProgress | null } | null = null
/** Result of the last server-folder move (the screen that started it may be gone by then). */
let lastServer: { ok: boolean; message: string; at: number } | null = null

const failCheck = (error: string): StorageCheck => ({ ok: false, error, hasData: false, needBytes: 0, freeBytes: null })

/** The personal folder and the server folder must never hold one another (a move of one would take the other along). */
function crossProblem(kind: 'local' | 'server', to: string): string | null {
  const server = getMode() === 'server' ? getServerConfig()?.dataDir : undefined
  const mine = localDir()
  if (kind === 'local' && server && (samePath(to, server) || isInside(to, server) || isInside(server, to)))
    return '서버 자료 폴더와 겹치는 곳에는 내 자료를 둘 수 없습니다. 서버 자료 폴더 밖의 다른 폴더를 고르세요.'
  if (kind === 'server') {
    // (the app data folder is the parent of everything by default: only a folder that holds personal data itself counts)
    const holdsMine = samePath(mine, to) || (isInside(to, mine) && !samePath(mine, defaultLocalDir()))
    if (holdsMine || isInside(mine, to)) return '내 자료 폴더와 겹치는 곳에는 서버 자료를 둘 수 없습니다. 다른 폴더를 고르세요.'
  }
  return null
}

/** IPC for 저장 위치 (6.20): personal data folder and, on the server PC, the server data folder. */
export function registerStorageIpc(): void {
  handle('storage:info', null, async () => {
    const cfg = getMode() === 'server' ? getServerConfig() : null
    return {
      local: {
        dir: localDir(),
        isDefault: samePath(localDir(), defaultLocalDir()),
        defaultDir: defaultLocalDir(),
        bytes: (await treeSizeAsync(localDir(), LOCAL_ENTRIES)).bytes,
        // data still in the app data folder (C:) while the PC has a D: drive: offer to move it there
        driveDir: samePath(localDir(), defaultLocalDir()) ? driveLocalDir() : null
      },
      server: cfg ? { dir: cfg.dataDir, bytes: (await treeSizeAsync(cfg.dataDir)).bytes, running: serverStatus().state === 'running' } : null,
      last: lastStorageResult(),
      busy,
      lastServer
    }
  })
  handle('storage:clearLast', null, () => clearLastStorageResult())
  handle('storage:clearLastServer', null, () => {
    lastServer = null
  })

  handle('storage:pick', z.object({ kind: z.enum(['local', 'server']) }), async ({ kind }, e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts = { title: kind === 'local' ? '내 자료를 둘 폴더 고르기' : '서버 자료를 둘 폴더 고르기', properties: ['openDirectory' as const, 'createDirectory' as const] }
    try {
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const picked = r.canceled ? null : (r.filePaths[0] ?? null)
      return picked ? normalizeTarget(picked, kind === 'local' ? 'TeamHub 내 자료' : 'TeamHub 서버 자료') : null
    } catch (err) {
      log.warn('storage: folder picker failed', err)
      return null
    }
  })

  // shared PC: 내 자료 저장 위치 is per person, and another person's folder is not a place to choose
  const checkLocal = async (to: string): Promise<StorageCheck> => {
    try {
      const other = otherSeatDataProblem(to) ?? crossProblem('local', to)
      if (other) return failCheck(other)
      return await checkLocalTarget(to)
    } catch (err) {
      log.warn('storage: local target check failed', err)
      return failCheck(`그 폴더를 확인하지 못했습니다: ${moveErrorText(err)}`)
    }
  }
  handle('storage:checkLocal', z.object({ to: path }), ({ to }) => checkLocal(to))

  handle('storage:changeLocal', z.object({ to: path, mode: z.enum(['move', 'use']) }), async ({ to, mode }) => {
    if (busy) return { ok: false, error: '다른 폴더를 옮기는 중입니다. 끝난 뒤 다시 해 보세요.' }
    const c = await checkLocal(to)
    if (!c.ok) return { ok: false, error: c.error }
    if (mode === 'use' && !c.hasData) return { ok: false, error: '그 폴더에 TeamHub 자료가 없습니다.' }
    if (mode === 'move' && c.hasData) return { ok: false, error: '그 폴더에 이미 TeamHub 자료가 있습니다. "그 폴더의 자료 쓰기"를 고르거나 빈 폴더를 고르세요.' }
    try {
      stageLocalChange(to, mode)
    } catch (err) {
      log.error('storage: could not stage the local change', err)
      return { ok: false, error: `준비하지 못했습니다(지금 자료는 그대로입니다): ${moveErrorText(err)}` }
    }
    busy = { kind: 'local', progress: null }
    // restart: the change is applied before the local DB opens
    setTimeout(() => {
      setQuitting(true)
      if (!process.env.TEAMHUB_E2E) app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') })
      app.quit()
    }, 300)
    return { ok: true }
  })

  handle('storage:checkServer', z.object({ to: path }), async ({ to }) => {
    const cfg = getMode() === 'server' ? getServerConfig() : null
    if (!cfg) return failCheck('이 PC는 서버가 아닙니다.')
    try {
      const cross = crossProblem('server', to)
      if (cross) return failCheck(cross)
      return await checkServerTarget(cfg.dataDir, to)
    } catch (err) {
      log.warn('storage: server target check failed', err)
      return failCheck(`그 폴더를 확인하지 못했습니다: ${moveErrorText(err)}`)
    }
  })

  handle('storage:moveServer', z.object({ to: path }), async ({ to }, e) => {
    const cfg = getMode() === 'server' ? getServerConfig() : null
    if (!cfg) return { ok: false, error: '이 PC는 서버가 아닙니다.' }
    if (busy) return { ok: false, error: '이미 옮기는 중입니다.' }
    busy = { kind: 'server', progress: null }
    const from = cfg.dataDir
    const progress = (p: StorageProgress): void => {
      if (busy) busy.progress = p
      if (!e.sender.isDestroyed()) e.sender.send('storage:progress', p)
    }
    const finish = (ok: boolean, message: string, warning?: string): { ok: boolean; error?: string; warning?: string } => {
      lastServer = { ok, message: warning ? `${message} (${warning})` : message, at: Date.now() }
      log[ok ? 'info' : 'error'](`storage: ${lastServer.message}`)
      return ok ? { ok, warning } : { ok, error: message }
    }
    /** Back to the old folder (nothing of it was changed); the server is started there again. */
    const resume = async (): Promise<string> => {
      try {
        const st = await startServer(from, { preventSleep: cfg.preventSleep, holder: true })
        return st.state === 'running' ? '' : ` 서버가 켜지지 않았습니다: ${st.message ?? ''} 관리 → 서버 상태에서 다시 시작해 보세요.`
      } catch (err) {
        log.error('storage: server did not start again on the old folder', err)
        return ' 서버를 다시 켜지 못했습니다. 프로그램을 다시 시작하세요.'
      }
    }
    log.info(`storage: moving server data ${from} -> ${to}`)
    try {
      const c = crossProblem('server', to) ? { ok: false, error: crossProblem('server', to)! } : await checkServerTarget(from, to)
      if (!c.ok) return finish(false, c.error ?? '그 폴더로는 옮길 수 없습니다.')
      holdServer('server data folder move')
      progress({ phase: 'stop', doneBytes: 0, totalBytes: 0 })
      const t0 = Date.now()
      await stopServer()
      log.info(`storage: server stopped in ${Date.now() - t0} ms`)
      let names: string[]
      try {
        names = (await copyServerData(from, to, progress)).names
      } catch (err) {
        log.error('storage: server data copy failed', err)
        return finish(false, `옮기지 못했습니다(이전 폴더 그대로 사용, 자료는 바뀌지 않았습니다): ${moveErrorText(err)}${await resume()}`)
      }
      progress({ phase: 'start', doneBytes: 0, totalBytes: 0 })
      const st = await startServer(to, { preventSleep: cfg.preventSleep, failFast: true, holder: true })
      if (st.state !== 'running') {
        // stop it for good first (a failed start schedules its own retry) and only then clear the new copy
        await stopServer()
        removeOldServerData(to, names)
        return finish(false, `새 폴더에서 서버가 켜지지 않아 이전 폴더로 되돌렸습니다: ${st.message ?? ''}${await resume()}`)
      }
      // the switch: from here on the new folder is the server's data folder
      setServerConfig({ ...cfg, dataDir: to })
      progress({ phase: 'cleanup', doneBytes: 0, totalBytes: 0 })
      const left = removeOldServerData(from, names)
      return finish(true, `서버 자료를 옮겼습니다: ${to}`, left.length ? `이전 폴더(${from})에서 지우지 못한 파일이 있습니다. 다른 프로그램이 열고 있던 파일입니다. 그 프로그램을 닫은 뒤 직접 지워도 됩니다: ${left.slice(0, 3).join(', ')}` : undefined)
    } catch (err) {
      log.error('storage: server data move failed', err)
      const back = serverStatus().state === 'running' ? '' : await resume()
      return finish(false, `옮기지 못했습니다: ${moveErrorText(err)}${back}`)
    } finally {
      holdServer(null)
      busy = null
    }
  })
}
