import { app, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { setupPaths, userDataPath } from './paths'
import { createMainWindow, setQuitting, showMainWindow } from './windows/main-window'
import { createTray } from './tray'
import { startedHidden } from './autostart'
import { openLocalDb, closeLocalDb, localDb } from './localdb'
import { registerAppIpc } from './ipc/app'
import { registerLocalIpc } from './ipc/local'
import { autoStartServer, registerConnectionIpc } from './ipc/connection'
import { registerNotifyIpc } from './ipc/notify'
import { registerPersonalIpc } from './ipc/personal'
import { startScheduler, stopScheduler } from './scheduler'
import { registerTransferIpc } from './ipc/transfer'
import { registerToolsIpc } from './ipc/tools'
import { startTools, stopTools } from './tools'
import { registerLauncherIpc } from './ipc/launcher'
import { startLauncher } from './launcher'
import { startSysutil } from './sysutil'
import { registerFilesIpc } from './ipc/files'
import { startFileIndex } from './files'
import { configureWebRtcSwitches, setupMediaPermissions } from './meetings'
import { registerMeetingIpc } from './ipc/meetings'
import { restoreTransfers, stopWatches } from './transfer'
import { onServerStatus, stopServer } from './server-host'

setupPaths()
configureWebRtcSwitches()
log.initialize()
log.transports.file.resolvePathFn = () => userDataPath('logs', 'main.log')
Object.assign(console, log.functions)

// node:sqlite prints an ExperimentalWarning once; it is expected (13.14).
process.removeAllListeners('warning')
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') log.warn(w)
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(() => {
    openLocalDb(userDataPath('local.db'))
    registerAppIpc()
    registerLocalIpc()
    registerConnectionIpc()
    registerNotifyIpc()
    registerPersonalIpc()
    registerTransferIpc()
    registerToolsIpc()
    registerLauncherIpc()
    registerFilesIpc()
    registerMeetingIpc()
    setupMediaPermissions()
    startScheduler()
    restoreTransfers()
    onServerStatus((st) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('server:status', st)
    })
    createTray()
    createMainWindow({ startHidden: startedHidden() })
    startTools()
    startLauncher()
    startSysutil()
    startFileIndex()
    localDb().notes.purgeOld()
    void autoStartServer()
    log.info(`TeamHub ${app.getVersion()} started (userData=${app.getPath('userData')})`)
  })

  let cleanedUp = false
  app.on('before-quit', (e) => {
    setQuitting(true)
    if (cleanedUp) return
    e.preventDefault()
    cleanedUp = true
    void stopServer()
      .catch(() => undefined)
      .finally(() => app.quit())
  })
  app.on('will-quit', () => {
    stopScheduler()
    stopTools()
    stopWatches()
    closeLocalDb()
  })
  // Keep running in the tray when all windows are hidden; quit only via tray/menu.
  app.on('window-all-closed', () => {
    /* stay alive in tray */
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow({ startHidden: false })
  })
}

process.on('uncaughtException', (err) => log.error('uncaughtException', err))
process.on('unhandledRejection', (err) => log.error('unhandledRejection', err))
