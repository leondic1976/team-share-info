/**
 * 긴급구조지휘대: the windows of the module in the Electron main process — the 훈련 창 (in the
 * middle of the screen, always on top, one per drill) and the 훈련 통제실 (a big window for those
 * in charge). The host gives how to load a route of its screens.
 */
import { BrowserWindow, screen } from 'electron'

export interface CommandWindowHost {
  /** the preload script of the host's screens */
  preload: string
  icon?: string
  /** loads a route of the host's screens into a window (e.g. '/popup/drill/<id>') */
  load(win: BrowserWindow, route: string): void
  /** hardening of the host for every window it makes */
  secure?(win: BrowserWindow): void
}

const drills = new Map<string, BrowserWindow>()
const controls = new Map<string, BrowserWindow>()

function make(host: CommandWindowHost, o: { width: number; height: number; title: string; onTop: boolean; minW: number; minH: number }): BrowserWindow {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = Math.min(o.width, area.width - 40)
  const height = Math.min(o.height, area.height - 40)
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    minWidth: o.minW,
    minHeight: o.minH,
    title: o.title,
    icon: host.icon,
    autoHideMenuBar: true,
    show: false,
    alwaysOnTop: o.onTop,
    webPreferences: { preload: host.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  })
  win.setMenu(null)
  host.secure?.(win)
  return win
}

/** The 훈련 창 of a drill: comes to the front again when it is open already. */
export function openDrillWindow(host: CommandWindowHost, drillId: string, poke?: { msgId?: string }): void {
  const cur = drills.get(drillId)
  if (cur && !cur.isDestroyed()) {
    cur.webContents.send('command:poke', { drillId, msgId: poke?.msgId ?? null })
    cur.show()
    cur.moveTop()
    cur.focus()
    cur.flashFrame(true)
    return
  }
  const win = make(host, { width: 760, height: 560, title: '[훈련] 긴급구조지휘대', onTop: true, minW: 520, minH: 380 })
  // above full-screen programs, like the 긴급공지 window
  win.setAlwaysOnTop(true, 'screen-saver')
  host.load(win, `/popup/drill/${drillId}`)
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
    win.flashFrame(true)
  })
  win.on('closed', () => drills.delete(drillId))
  drills.set(drillId, win)
}

/** The 훈련 통제실 of a drill (one per drill). */
export function openControlWindow(host: CommandWindowHost, drillId: string): void {
  const cur = controls.get(drillId)
  if (cur && !cur.isDestroyed()) {
    if (cur.isMinimized()) cur.restore()
    cur.show()
    cur.focus()
    return
  }
  const win = make(host, { width: 1600, height: 960, title: '훈련 통제실 · 긴급구조지휘대', onTop: false, minW: 1000, minH: 640 })
  host.load(win, `/popup/drill-control/${drillId}`)
  win.once('ready-to-show', () => {
    win.maximize()
    win.show()
  })
  win.on('closed', () => controls.delete(drillId))
  controls.set(drillId, win)
}

export function closeCommandWindow(win: BrowserWindow | null): void {
  if (win && !win.isDestroyed()) win.close()
}

/** Ids of the open 훈련 창 (tests and diagnostics). */
export const openDrillWindows = (): string[] => [...drills].filter(([, w]) => !w.isDestroyed()).map(([id]) => id)
