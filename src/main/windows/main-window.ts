import { BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { loadWindowState, trackWindowState } from '../window-state'
import { resourcePath } from '../paths'

let mainWindow: BrowserWindow | null = null
let quitting = false

export function setQuitting(v: boolean): void {
  quitting = v
}
export function isQuitting(): boolean {
  return quitting
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export function rendererUrl(hash = ''): { url?: string; file?: string; hash: string } {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) return { url: `${devUrl}#${hash}`, hash }
  return { file: join(import.meta.dirname, '../renderer/index.html'), hash }
}

export function loadRenderer(win: BrowserWindow, hash = ''): void {
  const target = rendererUrl(hash)
  if (target.url) void win.loadURL(target.url)
  else if (target.file) void win.loadFile(target.file, { hash })
}

export function secureWebContents(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (dev && url.startsWith(dev)) return
    if (url.startsWith('file://')) return
    e.preventDefault()
  })
}

export function titleBarColors(): { color: string; symbolColor: string } {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#0f172a', symbolColor: '#e2e8f0' }
    : { color: '#ffffff', symbolColor: '#0f172a' }
}

export function createMainWindow(opts: { startHidden: boolean }): BrowserWindow {
  const state = loadWindowState()
  const win = new BrowserWindow({
    ...(state.centered ? { width: state.bounds.width, height: state.bounds.height } : state.bounds),
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'TeamHub',
    icon: resourcePath('icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f172a' : '#ffffff',
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...titleBarColors(), height: 44 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
      // Built-in PDF viewer for file previews.
      plugins: true
    }
  })
  win.setMenu(null)
  secureWebContents(win)
  trackWindowState(win)
  if (state.maximized) win.maximize()

  win.once('ready-to-show', () => {
    if (!opts.startHidden) win.show()
  })

  // Closing the window hides it to the tray (5.2); the app keeps receiving alerts.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })

  const sendMax = (): void => win.webContents.send('window:maximized', { maximized: win.isMaximized() })
  win.on('maximize', sendMax)
  win.on('unmaximize', sendMax)

  loadRenderer(win, '/')
  mainWindow = win
  return win
}

export function showMainWindow(): void {
  const win = getMainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
