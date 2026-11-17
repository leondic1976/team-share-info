import { app, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { setupPaths, userDataPath } from './paths'
import { createMainWindow, setQuitting, showMainWindow } from './windows/main-window'
import { createTray } from './tray'
import { startedHidden } from './autostart'
import { openLocalDb, closeLocalDb, localDb } from './localdb'
import { registerAppIpc } from './ipc/app'
import { registerLocalIpc } from './ipc/local'
import { registerLedgerIpc } from './ipc/ledger'
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
import { registerPluginIpc } from './ipc/plugins'
import { linkToRoute, registerPluginScheme, servePlugins } from './plugins'
import { getMainWindow } from './windows/main-window'
import { restoreTransfers, stopWatches } from './transfer'
import { onServerStatus, stopServer } from './server-host'
import { applyPendingLocalChange, localDataPath, resolveLocalDir } from './storage'
import { registerStorageIpc } from './ipc/storage'
import { startUpdater } from './updater'
import { getPendingJoin, readCredential } from './connection'

setupPaths()
configureWebRtcSwitches()
registerPluginScheme()
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
  // teamhub:// links (download site "TeamHub에서 설치") arrive as arguments.
  const openLink = (argv: string[]): void => {
    const route = linkToRoute(argv)
    if (route) getMainWindow()?.webContents.send('app:navigate', { path: route })
  }
  app.on('second-instance', (_e, argv) => {
    showMainWindow()
    openLink(argv)
  })
  // The teamhub:// scheme is registered by the installer (electron-builder protocols), not at run time.

  app.whenReady().then(async () => {
    // a staged change of the personal data folder is carried out before the local DB opens (6.20)
    await applyPendingLocalChange()
    resolveLocalDir()
    openLocalDb(localDataPath('local.db'))
    registerAppIpc()
    registerStorageIpc()
    registerLocalIpc()
    registerLedgerIpc()
    registerConnectionIpc()
    registerNotifyIpc()
    registerPersonalIpc()
    registerTransferIpc()
    registerToolsIpc()
    registerLauncherIpc()
    registerFilesIpc()
    registerMeetingIpc()
    registerPluginIpc()
    servePlugins()
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
    startUpdater({ serverUrl: () => readCredential()?.serverUrl ?? getPendingJoin()?.serverUrl ?? null, resumeServer: autoStartServer })
    getMainWindow()?.webContents.once('did-finish-load', () => setTimeout(() => openLink(process.argv), 1500))
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
