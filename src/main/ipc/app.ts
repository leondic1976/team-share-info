import { app, BrowserWindow, nativeTheme, powerMonitor, shell } from 'electron'
import { hostname, release, userInfo } from 'node:os'
import { z } from 'zod'
import { handle } from './registry'
import { PROFILE } from '../paths'
import { getAutostart, setAutostart } from '../autostart'
import { setQuitting, titleBarColors } from '../windows/main-window'
import { setTrayUnread } from '../tray'
import { localDb } from '../localdb'

export function winUser(): string {
  try {
    return process.env.USERNAME || userInfo().username
  } catch {
    return 'unknown'
  }
}

export function registerAppIpc(): void {
  handle('app:getInfo', null, () => ({
    version: app.getVersion(),
    profile: PROFILE,
    isPackaged: app.isPackaged,
    platform: process.platform,
    userDataPath: app.getPath('userData'),
    localDbPath: localDb().db.path,
    winUser: winUser(),
    pcName: process.env.COMPUTERNAME || hostname(),
    osRelease: release()
  }))
  handle('app:quit', null, () => {
    setQuitting(true)
    app.quit()
  })
  handle('app:getAutostart', null, () => getAutostart())
  handle('app:setAutostart', z.object({ enabled: z.boolean() }), ({ enabled }) => setAutostart(enabled))
  handle('app:openExternal', z.object({ url: z.string().regex(/^https?:\/\//i) }), async ({ url }) => {
    await shell.openExternal(url)
  })
  handle('app:setBadge', z.object({ count: z.number().int().min(0) }), ({ count }) => {
    setTrayUnread(count)
    for (const w of BrowserWindow.getAllWindows()) w.flashFrame(false)
  })

  // E2E runs unattended: the real idle time of the test PC would turn everyone "away".
  handle('app:idleSeconds', null, () => (process.env.TEAMHUB_E2E && !process.env.TEAMHUB_E2E_IDLE ? 0 : powerMonitor.getSystemIdleTime()))

  handle('window:hide', null, (_req, e) => {
    BrowserWindow.fromWebContents(e.sender)?.hide()
  })
  handle('window:minimize', null, (_req, e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })
  handle('window:toggleMaximize', null, (_req, e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  handle('window:setTheme', z.object({ theme: z.enum(['light', 'dark', 'system']) }), ({ theme }) => {
    nativeTheme.themeSource = theme
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.setTitleBarOverlay({ ...titleBarColors(), height: 44 })
      } catch {
        // window without overlay
      }
    }
  })
}
