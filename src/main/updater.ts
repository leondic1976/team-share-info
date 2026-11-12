import { app, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import electronUpdater from 'electron-updater'
import type { UpdateSettings, UpdateState } from '../shared/ipc'
import { WEB_UPDATE_FEED } from '../shared/constants'
import { setQuitting } from './windows/main-window'
import { stopServer } from './server-host'
import { localDb } from './localdb'

/**
 * Auto-update (8, M1-6). Two feeds, same format (electron-updater "generic"):
 *  - web: the public download site (GitHub Pages) — PCs with internet
 *  - lan: the TeamHub server PC (/updates/) — closed networks
 * "auto" tries the web first and falls back to the server PC.
 */
const { autoUpdater } = electronUpdater

let state: UpdateState = { status: app.isPackaged ? 'idle' : 'disabled' }
let initialized = false
let currentFeed = ''

const DEFAULTS: UpdateSettings = { auto: true, source: 'auto' }
export function updateSettings(): UpdateSettings {
  return { ...DEFAULTS, ...(localDb().kv.get<Partial<UpdateSettings>>('update') ?? {}) }
}
export function setUpdateSettings(s: UpdateSettings): void {
  localDb().kv.set('update', s)
  autoUpdater.autoDownload = s.auto
}

function setState(s: UpdateState): void {
  state = { ...s, source: s.source ?? state.source, checkedAt: s.checkedAt ?? state.checkedAt }
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:state', state)
}

function init(): void {
  if (initialized) return
  initialized = true
  autoUpdater.logger = log
  autoUpdater.autoDownload = updateSettings().auto
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }))
  autoUpdater.on('update-available', (i) => setState({ status: 'available', version: i.version, checkedAt: Date.now() }))
  autoUpdater.on('update-not-available', () => setState({ status: 'none', checkedAt: Date.now() }))
  autoUpdater.on('download-progress', (p) => setState({ status: 'downloading', version: state.version, percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => setState({ status: 'downloaded', version: i.version }))
  autoUpdater.on('error', (e) => setState({ status: 'error', message: e.message, version: state.version }))
}

export function getUpdateState(): UpdateState {
  return state
}

async function reachable(feed: string): Promise<boolean> {
  try {
    const r = await fetch(`${feed}latest.yml`, { method: 'GET', signal: AbortSignal.timeout(5000), cache: 'no-store' })
    return r.ok
  } catch {
    return false
  }
}

/** Pick the feed for this check: web site or server PC, per settings and reachability. */
async function chooseFeed(serverUrl: string | null): Promise<{ feed: string; source: 'web' | 'lan' } | null> {
  const s = updateSettings()
  const lan = serverUrl ? `${serverUrl.replace(/\/+$/, '')}/updates/` : null
  if (s.source === 'lan') return lan ? { feed: lan, source: 'lan' } : null
  if (s.source === 'web') return { feed: WEB_UPDATE_FEED, source: 'web' }
  if (await reachable(WEB_UPDATE_FEED)) return { feed: WEB_UPDATE_FEED, source: 'web' }
  return lan ? { feed: lan, source: 'lan' } : null
}

/**
 * Check for an update. Automatic checks respect "자동 업데이트 끔" (nothing happens);
 * a manual check always looks and, with auto download off, only reports what is available.
 */
export async function checkForUpdates(serverUrl: string | null, manual = false): Promise<UpdateState> {
  if (!app.isPackaged) {
    setState({ status: 'disabled', message: '개발 실행에서는 자동 업데이트를 사용하지 않습니다.' })
    return state
  }
  if (state.status === 'downloading' || state.status === 'downloaded') return state
  if (!manual && !updateSettings().auto) return state
  init()
  const pick = await chooseFeed(serverUrl)
  if (!pick) {
    setState({ status: 'error', message: '업데이트 받을 곳이 없습니다(인터넷·서버 연결 확인).' })
    return state
  }
  if (pick.feed !== currentFeed) {
    autoUpdater.setFeedURL({ provider: 'generic', url: pick.feed })
    currentFeed = pick.feed
  }
  state = { ...state, source: pick.source }
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    setState({ status: 'error', message: e instanceof Error ? e.message : String(e) })
  }
  return state
}

/** Manual download when automatic download is off. */
export async function downloadUpdate(): Promise<UpdateState> {
  if (state.status !== 'available') return state
  try {
    await autoUpdater.downloadUpdate()
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
