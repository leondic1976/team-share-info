import { app, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '../shared/ipc'
import { setQuitting } from './windows/main-window'
import { stopServer } from './server-host'

/**
 * LAN auto-update (8, M1-6). The feed URL is the server PC address and is set
 * at runtime, because every installation talks to a different server.
 */
const { autoUpdater } = electronUpdater

let state: UpdateState = { status: app.isPackaged ? 'idle' : 'disabled' }
let initialized = false
let currentFeed = ''

function setState(s: UpdateState): void {
  state = s
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:state', state)
}

function init(): void {
  if (initialized) return
  initialized = true
  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }))
  autoUpdater.on('update-available', (i) => setState({ status: 'available', version: i.version }))
  autoUpdater.on('update-not-available', () => setState({ status: 'none' }))
  autoUpdater.on('download-progress', (p) => setState({ status: 'downloading', version: state.version, percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => setState({ status: 'downloaded', version: i.version }))
  autoUpdater.on('error', (e) => setState({ status: 'error', message: e.message, version: state.version }))
}

export function getUpdateState(): UpdateState {
  return state
}

export async function checkForUpdates(serverUrl: string): Promise<UpdateState> {
  if (!app.isPackaged) {
    setState({ status: 'disabled', message: '개발 실행에서는 자동 업데이트를 사용하지 않습니다.' })
    return state
  }
  if (state.status === 'downloading' || state.status === 'downloaded') return state
  init()
  const feed = `${serverUrl.replace(/\/+$/, '')}/updates/`
  if (feed !== currentFeed) {
    autoUpdater.setFeedURL({ provider: 'generic', url: feed })
    currentFeed = feed
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    setState({ status: 'error', message: e instanceof Error ? e.message : String(e) })
  }
  return state
}

export async function installUpdate(): Promise<void> {
  if (state.status !== 'downloaded') return
  setQuitting(true)
  await stopServer()
  autoUpdater.quitAndInstall(true, true)
}
