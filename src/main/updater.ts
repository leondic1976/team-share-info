import { app, BrowserWindow, net } from 'electron'
import log from 'electron-log/main'
import electronUpdater from 'electron-updater'
import { existsSync, writeFileSync } from 'node:fs'
import type { UpdateSettings, UpdateState } from '../shared/ipc'
import { WEB_UPDATE_FEED } from '../shared/constants'
import { compareVersions, SEMVER_RE } from '../shared/semver'
import { setQuitting } from './windows/main-window'
import { stopServer } from './server-host'
import { localDb } from './localdb'
import { userDataPath } from './paths'

/**
 * Auto-update (8, M1-6). Two feeds, same format (electron-updater "generic"):
 *  - web: the public download site (GitHub Pages) — PCs with internet
 *  - lan: the TeamHub server PC (/updates/) — closed networks
 * "auto" asks both and takes the newer version (the site wins a tie).
 *
 * This module decides which feed to use and whether there is anything newer;
 * electron-updater only downloads (hash-checked) and runs the installer.
 */
const { autoUpdater, CancellationToken } = electronUpdater

/** E2E drives the real check/download path of the unpackaged app; it never runs an installer. */
const E2E_UPDATER = !!process.env.TEAMHUB_E2E && process.env.TEAMHUB_E2E_UPDATER === '1'
const active = (): boolean => app.isPackaged || E2E_UPDATER
const webFeed = (): string => (process.env.TEAMHUB_E2E ? process.env.TEAMHUB_E2E_WEB_FEED : undefined) ?? WEB_UPDATE_FEED

const PROBE_TIMEOUT_MS = 8000
const STALL_MS = 5 * 60_000
const FIRST_CHECK_MS = 45_000
const CHECK_EVERY_MS = 30 * 60_000

let state: UpdateState = { status: active() ? 'idle' : 'disabled' }
let initialized = false
let currentFeed = ''
let checking: Promise<UpdateState> | null = null
let downloadActive = false
let downloadToken: InstanceType<typeof CancellationToken> | null = null
let lastProgressAt = 0
let downloadedFile: string | null = null
let hooks: UpdaterHooks = {}

export interface UpdaterHooks {
  /** server address this PC is connected to (or its own embedded server) */
  serverUrl?: () => string | null
  /** start the embedded server again when an install could not be started */
  resumeServer?: () => Promise<void>
}

const DEFAULTS: UpdateSettings = { auto: true, source: 'auto' }
export function updateSettings(): UpdateSettings {
  return { ...DEFAULTS, ...(localDb().kv.get<Partial<UpdateSettings>>('update') ?? {}) }
}
export function setUpdateSettings(s: UpdateSettings): void {
  localDb().kv.set('update', s)
}

function setState(s: UpdateState): void {
  state = { ...s, source: s.source ?? state.source, checkedAt: s.checkedAt ?? state.checkedAt }
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('update:state', state)
}

/** Korean text for the settings card; the original error is in the log. */
export function friendlyUpdateError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  if (/sha512 checksum mismatch/i.test(m)) return '내려받은 설치 파일이 손상되었습니다(해시 불일치). 잠시 뒤 다시 받습니다.'
  if (/ENOSPC/i.test(m)) return '디스크 공간이 부족해 업데이트를 내려받지 못했습니다.'
  if (/EPERM|EACCES|EBUSY/i.test(m)) return '설치 파일을 저장하지 못했습니다. 보안 프로그램이 막았는지 확인하세요.'
  if (/\b404\b|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|Cannot find/i.test(m)) return '설치 파일을 찾지 못했습니다. 잠시 뒤 다시 확인합니다.'
  if (/net::ERR_|ETIMEDOUT|ECONNRE|ENOTFOUND|EAI_AGAIN|socket hang up|timed? ?out|aborted/i.test(m)) return '업데이트 받을 곳에 연결하지 못했습니다(인터넷·서버 연결 확인).'
  return `업데이트 오류: ${m.split('\n')[0]!.slice(0, 160)}`
}

function init(): void {
  if (initialized) return
  initialized = true
  autoUpdater.logger = log
  // downloads are started here (startDownload) so that one code path owns them
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = !E2E_UPDATER
  autoUpdater.allowDowngrade = false
  // Only the newest installer is kept on the site and the server PC, so the previous
  // version's block map is never there: always take the whole file.
  autoUpdater.disableDifferentialDownload = true
  autoUpdater.disableWebInstaller = true
  if (E2E_UPDATER) {
    const cfg = userDataPath('dev-app-update.yml')
    writeFileSync(cfg, `provider: generic\nurl: ${webFeed()}\nupdaterCacheDirName: teamhub-updater-e2e\n`)
    autoUpdater.updateConfigPath = cfg
    autoUpdater.forceDevUpdateConfig = true
  }
  autoUpdater.on('update-available', (i) => setState({ status: 'available', version: i.version, checkedAt: Date.now() }))
  autoUpdater.on('update-not-available', () => setState({ status: 'none', checkedAt: Date.now() }))
  autoUpdater.on('download-progress', (p) => {
    lastProgressAt = Date.now()
    if (downloadActive) setState({ status: 'downloading', version: state.version, percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', (i) => {
    downloadedFile = i.downloadedFile
    setState({ status: 'downloaded', version: i.version })
  })
  autoUpdater.on('error', (e) => setState({ status: 'error', message: friendlyUpdateError(e), version: state.version }))
}

export function getUpdateState(): UpdateState {
  return state
}

type Probe = { reachable: false } | { reachable: true; version: string | null }

/** Read a feed's latest.yml. A feed that answers without a release is "reachable, nothing offered". */
async function probe(feed: string): Promise<Probe> {
  try {
    const r = await net.fetch(`${feed}latest.yml?t=${Date.now()}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store' })
    if (r.status === 404) return { reachable: true, version: null }
    if (!r.ok) return { reachable: false }
    const v = (/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(await r.text())?.[1] ?? '').trim()
    // anything else (a proxy's error page, a login portal) is not our feed
    return SEMVER_RE.test(v) ? { reachable: true, version: v } : { reachable: false }
  } catch {
    return { reachable: false }
  }
}

type Pick = { kind: 'offer'; feed: string; source: 'web' | 'lan'; version: string } | { kind: 'none'; source?: 'web' | 'lan' } | { kind: 'unreachable' }

/** Choose the feed for this check: the newest version among the feeds the settings allow. */
async function chooseFeed(serverUrl: string | null, allFeeds: boolean): Promise<Pick> {
  const s = updateSettings()
  const lan = serverUrl ? `${serverUrl.replace(/\/+$/, '')}/updates/` : null
  const feeds: { feed: string; source: 'web' | 'lan' }[] = []
  if (allFeeds || s.source !== 'lan') feeds.push({ feed: webFeed(), source: 'web' })
  if (lan && (allFeeds || s.source !== 'web')) feeds.push({ feed: lan, source: 'lan' })
  const probes = await Promise.all(feeds.map((f) => probe(f.feed)))
  let best: Extract<Pick, { kind: 'offer' }> | null = null
  let answered: 'web' | 'lan' | undefined
  for (let i = 0; i < feeds.length; i++) {
    const p = probes[i]!
    if (!p.reachable) continue
    answered ??= feeds[i]!.source
    if (p.version && (!best || compareVersions(p.version, best.version) > 0)) best = { kind: 'offer', ...feeds[i]!, version: p.version }
  }
  if (best) return best
  return answered ? { kind: 'none', source: answered } : { kind: 'unreachable' }
}

function startDownload(): void {
  if (downloadActive || state.status === 'downloaded') return
  downloadActive = true
  lastProgressAt = Date.now()
  const token = new CancellationToken()
  downloadToken = token
  setState({ status: 'downloading', version: state.version, percent: 0 })
  autoUpdater
    .downloadUpdate(token)
    .catch((e: unknown) => {
      // real failures also arrive as an 'error' event; a cancelled (stalled) download is restarted by the next check
      if (!token.cancelled && state.status !== 'error') setState({ status: 'error', message: friendlyUpdateError(e), version: state.version })
    })
    .finally(() => {
      if (downloadToken === token) {
        downloadActive = false
        downloadToken = null
      }
    })
}

async function runCheck(serverUrl: string | null, download: boolean, allFeeds: boolean): Promise<UpdateState> {
  init()
  // the source shown next to the result belongs to this check, not to an earlier one
  state = { ...state, source: undefined }
  setState({ status: 'checking', version: state.version })
  const pick = await chooseFeed(serverUrl, allFeeds)
  if (pick.kind === 'unreachable') {
    setState({ status: 'error', message: '업데이트 받을 곳에 연결하지 못했습니다(인터넷·서버 연결 확인).' })
    return state
  }
  if (pick.kind === 'none' || compareVersions(pick.version, app.getVersion()) <= 0) {
    state = { ...state, source: pick.source }
    setState({ status: 'none', checkedAt: Date.now() })
    return state
  }
  if (pick.feed !== currentFeed) {
    autoUpdater.setFeedURL({ provider: 'generic', url: pick.feed })
    currentFeed = pick.feed
  }
  state = { ...state, source: pick.source }
  try {
    const r = await autoUpdater.checkForUpdates()
    if (r?.isUpdateAvailable && download) startDownload()
  } catch (e) {
    if (state.status !== 'error') setState({ status: 'error', message: friendlyUpdateError(e) })
  }
  return state
}

/**
 * Check for an update.
 *  - automatic checks respect "자동 업데이트 끔" (nothing happens)
 *  - manual: always looks; with automatic download off it only reports what is available
 *  - force (required or mandatory update): looks at every feed and downloads regardless of the settings
 */
export async function checkForUpdates(serverUrl: string | null, manual = false, force = false): Promise<UpdateState> {
  if (!active()) {
    setState({ status: 'disabled', message: '개발 실행에서는 자동 업데이트를 사용하지 않습니다.' })
    return state
  }
  if (state.status === 'downloaded') return state
  if (downloadActive) {
    if (Date.now() - lastProgressAt < STALL_MS) return state
    // nothing arrived for a long time (network dropped mid-download): start over
    log.warn('update download stalled; restarting')
    downloadToken?.cancel()
    downloadActive = false
    downloadToken = null
  }
  const auto = updateSettings().auto
  if (!manual && !force && !auto) return state
  if (checking) return checking
  checking = runCheck(serverUrl ?? hooks.serverUrl?.() ?? null, auto || force, force).finally(() => {
    checking = null
  })
  return checking
}

/** Manual download when automatic download is off. */
export async function downloadUpdate(): Promise<UpdateState> {
  if (state.status === 'available' && !checking) startDownload()
  return state
}

export async function installUpdate(): Promise<void> {
  if (state.status !== 'downloaded') return
  if (E2E_UPDATER) {
    log.info('update install skipped (E2E)')
    return
  }
  if (!downloadedFile || !existsSync(downloadedFile)) {
    // e.g. removed by a security program after the download: get it again
    log.warn(`downloaded installer is missing: ${downloadedFile}`)
    downloadedFile = null
    setState({ status: 'error', message: '내려받은 설치 파일이 없어졌습니다(보안 프로그램 확인). 다시 받습니다.', version: state.version })
    void checkForUpdates(null, true, true)
    return
  }
  setQuitting(true)
  await stopServer()
  // The app quits within a moment when the installer starts; still being here later means it did not.
  const fallback = setTimeout(() => {
    log.error('update install did not start; resuming')
    setQuitting(false)
    void hooks.resumeServer?.()
    setState({ status: 'error', message: '설치를 시작하지 못했습니다. 다시 시도하거나 다운로드 사이트에서 설치 파일을 받아 설치하세요.', version: state.version })
  }, 15_000)
  try {
    autoUpdater.quitAndInstall(true, true)
  } catch (e) {
    clearTimeout(fallback)
    log.error('quitAndInstall failed', e)
    setQuitting(false)
    void hooks.resumeServer?.()
    setState({ status: 'error', message: friendlyUpdateError(e), version: state.version })
  }
}

/**
 * Periodic check owned by the main process, so updates keep working whatever screen
 * (or state) the window is in. The renderer adds event-driven checks on top.
 */
export function startUpdater(h: UpdaterHooks): void {
  hooks = h
  if (!active()) return
  const tick = (): void => void checkForUpdates(null).catch((e) => log.warn('update check failed', e))
  setTimeout(tick, FIRST_CHECK_MS)
  setInterval(tick, CHECK_EVERY_MS)
}
