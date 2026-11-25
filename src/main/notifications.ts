import { BrowserWindow, Notification, screen } from 'electron'
import { join } from 'node:path'
import type { UrgentPayload } from '../shared/schemas/notices'
import { getMainWindow, isQuitting, loadRenderer, secureWebContents, showMainWindow } from './windows/main-window'
import { resourcePath } from './paths'
import { localDb } from './localdb'
import { showPreview } from './preview'

/**
 * Urgent popup windows (6.3) and Windows toast notifications.
 * The popup is a separate always-on-top window that stays until the user confirms.
 */
const popups = new Map<string, BrowserWindow>()
const payloads = new Map<string, UrgentPayload>()

export function getPopupPayload(id: string): UrgentPayload | null {
  return payloads.get(id) ?? null
}

export function showUrgentPopup(p: UrgentPayload): void {
  payloads.set(p.id, p)
  const existing = popups.get(p.id)
  if (existing && !existing.isDestroyed()) {
    existing.webContents.send('popup:refresh', { id: p.id })
    existing.show()
    existing.moveTop()
    existing.focus()
    existing.flashFrame(true)
    return
  }
  // In the middle of the screen the person is looking at (where the mouse is), large enough to
  // be read from a step away.
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = Math.min(760, area.width - 40)
  const height = Math.min(520, area.height - 40)
  const offset = popups.size * 28
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2) + offset,
    y: Math.round(area.y + (area.height - height) / 2) + offset,
    minWidth: 480,
    minHeight: 360,
    backgroundColor: '#b91c1c',
    alwaysOnTop: true,
    skipTaskbar: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: `[긴급] ${p.title}`,
    icon: resourcePath('icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  win.setMenu(null)
  // Above full-screen apps (13.13).
  win.setAlwaysOnTop(true, 'screen-saver')
  secureWebContents(win)
  loadRenderer(win, `/popup/urgent/${p.id}`)
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
    win.flashFrame(true)
  })
  // Urgent notices that require acknowledgement are closed by confirming (6.3). The title-bar X
  // is not ignored: the window treats it as 확인 (or, with answers to choose, asks for one; when
  // the server cannot be reached, it puts the window away until it can).
  win.on('close', (e) => {
    // a window whose page is gone cannot answer: let it close
    if (payloads.get(p.id)?.requireAck && !isQuitting() && !win.webContents.isCrashed()) {
      e.preventDefault()
      win.webContents.send('popup:closeRequest', { id: p.id })
    }
  })
  win.on('closed', () => {
    popups.delete(p.id)
  })
  popups.set(p.id, win)
  getMainWindow()?.flashFrame(true)
}

/** Ids of the urgent windows that are open. */
export function openUrgentIds(): string[] {
  return [...popups].filter(([, w]) => !w.isDestroyed()).map(([id]) => id)
}

/** Close every urgent window whose notice is not in `ids` (it no longer waits for this person). */
export function syncUrgentPopups(ids: string[]): string[] {
  const keep = new Set(ids)
  const closed: string[] = []
  for (const id of openUrgentIds()) {
    if (keep.has(id)) continue
    closeUrgentPopup(id)
    closed.push(id)
  }
  return closed
}

export function closeUrgentPopup(id: string): void {
  const w = popups.get(id)
  if (w && !w.isDestroyed()) w.destroy()
  popups.delete(id)
  payloads.delete(id)
}

export interface ToastOptions {
  title: string
  body: string
  route?: string
  silent?: boolean
  /** cards with the same key are merged (a conversation); default: the route, else the title */
  key?: string
}

/** Focus mode (6.12 ③) holds back normal toasts; the gate returns false to hold. */
let toastGate: (o: ToastOptions) => boolean = () => true
export function setToastGate(fn: (o: ToastOptions) => boolean): void {
  toastGate = fn
}

/** 설정 → 알림: the card near the tray and the "팀뿌요~" sound (both on unless turned off). */
function alertPrefs(): { preview: boolean; sound: boolean } {
  try {
    const p = localDb().kv.get<{ msgPreview?: boolean; msgSound?: boolean }>('prefs') ?? {}
    return { preview: p.msgPreview !== false, sound: p.msgSound !== false }
  } catch {
    return { preview: true, sound: true }
  }
}

/** The "팀뿌요~" sound, played by the TeamHub window (it keeps running while hidden to the tray). */
function playAlertSound(): void {
  getMainWindow()?.webContents.send('app:sound', { kind: 'alert' })
}

/**
 * Every alert of the program (공지, 일정 알림, 알람, 메시지, 기록, 사용 신청 …, 지시 83·85): a card
 * at the top right of the screen (지시 114) and the "팀뿌요~" sound. With the card turned off in 설정, a
 * Windows notification instead (it stays until clicked, 지시 63).
 */
export function showToast(opts: ToastOptions, force = false): void {
  if (!force && !toastGate(opts)) return
  const prefs = alertPrefs()
  // timeoutType 'never': the notification stays on the screen until it is clicked or closed,
  // instead of going away after a few seconds (사용자 요청 2026-11-25, 지시 63)
  const options: Electron.NotificationConstructorOptions = { title: opts.title, body: opts.body, icon: resourcePath('icon.png'), silent: prefs.sound || (opts.silent ?? false), timeoutType: 'never' }
  if (process.env.TEAMHUB_E2E) {
    const g = globalThis as unknown as { __teamhubToasts?: (ToastOptions & { timeoutType?: string })[] }
    ;(g.__teamhubToasts ??= []).push({ ...opts, timeoutType: options.timeoutType })
  }
  if (prefs.sound && !opts.silent) playAlertSound()
  if (prefs.preview) {
    showPreview({ key: (opts.key ?? opts.route ?? opts.title).slice(0, 64), title: opts.title, body: opts.body, route: opts.route, sound: prefs.sound && !opts.silent })
    return
  }
  if (!Notification.isSupported()) return
  const n = new Notification(options)
  n.on('click', () => {
    showMainWindow()
    if (opts.route) getMainWindow()?.webContents.send('app:navigate', { path: opts.route })
  })
  n.show()
}
