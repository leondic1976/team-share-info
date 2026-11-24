import { app, BrowserWindow, dialog } from 'electron'
import log from 'electron-log/main'
import { z } from 'zod'
import { handle } from './registry'
import { normalizeTarget, treeSize } from '../../node/datamove'
import { getMode, getServerConfig, setServerConfig } from '../connection'
import { serverStatus, startServer, stopServer } from '../server-host'
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
  removeOldServerData,
  stageLocalChange,
  driveLocalDir
} from '../storage'

const path = z.string().min(3).max(500)
let moving = false

/** IPC for 저장 위치 (6.20): personal data folder and, on the server PC, the server data folder. */
export function registerStorageIpc(): void {
  handle('storage:info', null, () => {
    const cfg = getMode() === 'server' ? getServerConfig() : null
    return {
      local: {
        dir: localDir(),
        isDefault: localDir() === defaultLocalDir(),
        defaultDir: defaultLocalDir(),
        bytes: treeSize(localDir(), LOCAL_ENTRIES).bytes,
        // data still in the app data folder (C:) while the PC has a D: drive: offer to move it there
        driveDir: localDir() === defaultLocalDir() ? driveLocalDir() : null
      },
      server: cfg ? { dir: cfg.dataDir, bytes: treeSize(cfg.dataDir).bytes, running: serverStatus().state === 'running' } : null,
      last: lastStorageResult()
    }
  })
  handle('storage:clearLast', null, () => clearLastStorageResult())

  handle('storage:pick', z.object({ kind: z.enum(['local', 'server']) }), async ({ kind }, e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts = { title: kind === 'local' ? '내 자료를 둘 폴더 고르기' : '서버 자료를 둘 폴더 고르기', properties: ['openDirectory' as const, 'createDirectory' as const] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const picked = r.canceled ? null : (r.filePaths[0] ?? null)
    return picked ? normalizeTarget(picked, kind === 'local' ? 'TeamHub 내 자료' : 'TeamHub 서버 자료') : null
  })

  // shared PC: 내 자료 저장 위치 is per person, and another person's folder is not a place to choose
  const checkLocal = (to: string): ReturnType<typeof checkLocalTarget> => {
    const c = checkLocalTarget(to)
    const other = otherSeatDataProblem(to)
    return other ? { ...c, ok: false, error: other } : c
  }
  handle('storage:checkLocal', z.object({ to: path }), ({ to }) => checkLocal(to))

  handle('storage:changeLocal', z.object({ to: path, mode: z.enum(['move', 'use']) }), ({ to, mode }) => {
    const c = checkLocal(to)
    if (!c.ok) return { ok: false, error: c.error }
    if (mode === 'use' && !c.hasData) return { ok: false, error: '그 폴더에 TeamHub 자료가 없습니다.' }
    if (mode === 'move' && c.hasData) return { ok: false, error: '그 폴더에 이미 TeamHub 자료가 있습니다. "그 폴더의 자료 쓰기"를 고르거나 빈 폴더를 고르세요.' }
    stageLocalChange(to, mode)
    // restart: the change is applied before the local DB opens
    setTimeout(() => {
      setQuitting(true)
      if (!process.env.TEAMHUB_E2E) app.relaunch()
      app.quit()
    }, 300)
    return { ok: true }
  })

  handle('storage:checkServer', z.object({ to: path }), ({ to }) => {
    const cfg = getMode() === 'server' ? getServerConfig() : null
    if (!cfg) return { ok: false, error: '이 PC는 서버가 아닙니다.', hasData: false, needBytes: 0, freeBytes: null }
    return checkServerTarget(cfg.dataDir, to)
  })

  handle('storage:moveServer', z.object({ to: path }), async ({ to }, e) => {
    const cfg = getMode() === 'server' ? getServerConfig() : null
    if (!cfg) return { ok: false, error: '이 PC는 서버가 아닙니다.' }
    if (moving) return { ok: false, error: '이미 옮기는 중입니다.' }
    const c = checkServerTarget(cfg.dataDir, to)
    if (!c.ok) return { ok: false, error: c.error }
    moving = true
    const from = cfg.dataDir
    const progress = (p: object): void => {
      if (!e.sender.isDestroyed()) e.sender.send('storage:progress', p as never)
    }
    log.info(`storage: moving server data ${from} → ${to}`)
    try {
      progress({ phase: 'stop', doneBytes: 0, totalBytes: 0 })
      const t0 = Date.now()
      await stopServer()
      log.info(`storage: server stopped in ${Date.now() - t0} ms`)
      let names: string[]
      try {
        names = (await copyServerData(from, to, progress)).names
      } catch (err) {
        log.error('storage: server data copy failed', err)
        await startServer(from, { preventSleep: cfg.preventSleep })
        return { ok: false, error: `옮기지 못했습니다(이전 폴더로 서버를 다시 켰습니다): ${(err as Error).message}` }
      }
      progress({ phase: 'start', doneBytes: 0, totalBytes: 0 })
      const st = await startServer(to, { preventSleep: cfg.preventSleep, failFast: true })
      if (st.state !== 'running') {
        removeOldServerData(to, names)
        await startServer(from, { preventSleep: cfg.preventSleep })
        return { ok: false, error: `새 폴더에서 서버가 켜지지 않아 이전 폴더로 되돌렸습니다: ${st.message ?? ''}` }
      }
      setServerConfig({ ...cfg, dataDir: to })
      progress({ phase: 'cleanup', doneBytes: 0, totalBytes: 0 })
      const left = removeOldServerData(from, names)
      log.info(`storage: server data moved to ${to}`)
      return { ok: true, warning: left.length ? `이전 폴더에서 지우지 못한 파일이 있습니다: ${left.slice(0, 5).join(', ')}` : undefined }
    } finally {
      moving = false
    }
  })
}
