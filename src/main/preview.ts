import { BrowserWindow, screen } from 'electron'
import log from 'electron-log/main'
import { join } from 'node:path'
import type { PreviewItem } from '../shared/ipc'
import { getMainWindow, loadRenderer, secureWebContents, showMainWindow } from './windows/main-window'
import { lockState } from './applock'

/**
 * 메시지 미리보기 (지시 83, 2026-11-25): new messages show as small cards at the top right of the
 * screen (지시 114: fixed there, away from the tray corner where other programs put their alerts),
 * also while the TeamHub window is hidden. One card per
 * conversation (the newest message, how many came), newest on top, four at most. A card stays
 * until it is clicked (opens the conversation) or closed (지시 63: alerts do not vanish by
 * themselves). The window never takes the focus away from what the person is typing in.
 * While the program is locked the cards say only that something came.
 */

const WIDTH = 340
const CARD = 76
const GAP = 8
const MAX = 4

let win: BrowserWindow | null = null
let items: PreviewItem[] = []
let guard: ReturnType<typeof setInterval> | null = null

/**
 * Other programs put their own always-on-top alert windows in the same corner (KakaoTalk's alert,
 * class EVA_Window_Dblclk, is a transparent layered window that keeps catching the mouse there).
 * A window that came later covers the cards and takes the clicks, so X seemed dead (지시 102).
 * The cards take the top back when the pointer comes onto them and every few seconds while shown;
 * this never takes the focus (moveTop does not activate the window).
 */
function raise(): void {
  if (!win || win.isDestroyed() || !win.isVisible()) return
  win.setAlwaysOnTop(true, 'pop-up-menu')
  win.moveTop()
}

function startGuard(): void {
  if (guard) return
  let inside = false
  let tick = 0
  guard = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return stopGuard()
    const p = screen.getCursorScreenPoint()
    const b = win.getBounds()
    const now = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
    const periodic = ++tick % 10 === 0
    if (now && !inside) log.info(`[preview] pointer on the cards at ${p.x},${p.y}`)
    if ((now && !inside) || periodic) raise()
    inside = now
  }, 300)
}

function stopGuard(): void {
  if (guard) clearInterval(guard)
  guard = null
}

/** Room left above the cards in the top right corner so the close and minimise buttons of a maximised window stay free. */
const TITLE_BAR = 40

function place(): void {
  if (!win || win.isDestroyed()) return
  const area = screen.getPrimaryDisplay().workArea
  // the cards, and the 모두 닫기 line above them when there are several
  const height = Math.max(1, items.length) * (CARD + GAP) + GAP + (items.length > 1 ? 28 : 0)
  win.setBounds({ x: area.x + area.width - WIDTH - 12, y: area.y + TITLE_BAR, width: WIDTH, height })
}

function ensureWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    width: WIDTH,
    height: CARD + 2 * GAP,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  win.setAlwaysOnTop(true, 'pop-up-menu')
  secureWebContents(win)
  loadRenderer(win, '/popup/preview')
  win.on('closed', () => {
    stopGuard()
    win = null
  })
  // what the cards receive, in main.log: when X "does nothing" this tells whether the click arrived (지시 122)
  win.webContents.on('console-message', (e) => {
    if (e.message.startsWith('[preview]')) log.info(e.message)
  })
  return win
}

function changed(sound: boolean): void {
  if (!items.length) {
    stopGuard()
    if (win && !win.isDestroyed()) win.hide()
    return
  }
  const w = ensureWindow()
  place()
  const send = (): void => w.webContents.send('preview:changed', { sound })
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
  else send()
  if (!w.isVisible()) w.showInactive()
  log.info(`[preview] shown: ${items.length} card(s) at ${JSON.stringify(w.getBounds())}`)
  raise()
  startGuard()
}

/** A new message (or note): put its card on top, merged with the earlier one of the same conversation. */
export function showPreview(p: { key: string; title: string; body: string; route?: string; sound: boolean }): void {
  const cur = items.find((x) => x.key === p.key)
  items = [{ key: p.key, title: p.title.slice(0, 100), body: p.body.slice(0, 300), route: p.route, count: (cur?.count ?? 0) + 1, at: Date.now() }, ...items.filter((x) => x.key !== p.key)].slice(0, MAX)
  if (process.env.TEAMHUB_E2E) {
    const g = globalThis as unknown as { __teamhubPreviews?: { key: string; title: string; body: string; sound: boolean }[] }
    ;(g.__teamhubPreviews ??= []).push({ key: p.key, title: p.title, body: p.body, sound: p.sound })
  }
  changed(p.sound)
}

/** What the cards show; while locked, only that something came. */
export function previewItems(): PreviewItem[] {
  if (!lockState().locked) return items
  return items.map((x) => ({ ...x, title: 'TeamHub', body: '새 알림이 있습니다. 잠금을 풀면 볼 수 있습니다.' }))
}

/** Close one card (or all, key null). */
export function dismissPreview(key: string | null): void {
  log.info(`[preview] closed ${key === null ? 'all' : key}`)
  items = key === null ? [] : items.filter((x) => x.key !== key)
  changed(false)
}

/** The card was clicked: the conversation opens in the TeamHub window. */
export function openPreview(key: string): void {
  const it = items.find((x) => x.key === key)
  dismissPreview(key)
  showMainWindow()
  if (it?.route) getMainWindow()?.webContents.send('app:navigate', { path: it.route })
}

/** The conversation was read in the program: its card is not needed any more. */
export function previewRead(key: string): void {
  if (items.some((x) => x.key === key)) dismissPreview(key)
}
