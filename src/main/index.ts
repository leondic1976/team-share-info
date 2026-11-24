import { app, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { setupPaths, userDataPath } from './paths'
import { createMainWindow, setQuitting } from './windows/main-window'
import { createTray, getTray, refreshTrayMenu } from './tray'
import { markSessionStarted, onSeatsChanged, openSeatPicker, sessionStarted, setSessionStarter, sharedEnabled, showFront, startRemovedCleanup } from './seats'
import { applyStagedRestore, startLocalBackups, stopLocalBackups } from './localbackup'
import { registerSeatIpc } from './ipc/seats'
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
import { registerAttachIpc } from './ipc/attach'
import { registerToolsIpc } from './ipc/tools'
import { registerFeedbackIpc } from './ipc/feedback'
import { registerLockIpc } from './ipc/lock'
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
    // (shared PC, nobody signed in yet: the sign-in window)
    showFront()
    openLink(argv)
  })
  // The teamhub:// scheme is registered by the installer (electron-builder protocols), not at run time.

  /**
   * Everything that works for the person using the program: local DB, IPC, windows, alarms,
   * transfers, shortcuts, updater. On a shared PC it runs only after that person signed in
   * (userData already points at their folder); otherwise right at start, as always.
   */
  const startSession = async (fromPicker: boolean): Promise<void> => {
    // a staged change of the personal data folder is carried out before the local DB opens (6.20)
    await applyPendingLocalChange()
    resolveLocalDir()
    // a restore from a backup that was staged before the restart: swapped in before the DB opens
    applyStagedRestore(localDataPath('local.db'))
    openLocalDb(localDataPath('local.db'))
    markSessionStarted()
    registerAppIpc()
    registerStorageIpc()
    registerLocalIpc()
    registerLedgerIpc()
    registerConnectionIpc()
    registerNotifyIpc()
    registerPersonalIpc()
    registerTransferIpc()
    registerAttachIpc()
    registerToolsIpc()
    registerFeedbackIpc()
    registerLockIpc()
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
    if (!getTray()) createTray()
    // after the sign-in window the main window is what the person is waiting for
    createMainWindow({ startHidden: !fromPicker && startedHidden() })
    startTools()
    startLauncher()
    startSysutil()
    startFileIndex()
    localDb().notes.purgeOld()
    startLocalBackups()
    void autoStartServer()
    startUpdater({ serverUrl: () => readCredential()?.serverUrl ?? getPendingJoin()?.serverUrl ?? null, resumeServer: autoStartServer })
    getMainWindow()?.webContents.once('did-finish-load', () => setTimeout(() => openLink(process.argv), 1500))
    log.info(`TeamHub ${app.getVersion()} started (userData=${app.getPath('userData')})`)
  }

  app.whenReady().then(async () => {
    registerSeatIpc()
    setSessionStarter(startSession)
    onSeatsChanged(refreshTrayMenu)
    // people removed from a shared PC are kept 30 days, then erased
    startRemovedCleanup()
    if (!sharedEnabled()) return startSession(false)
    // Shared PC: nobody is signed in, so nothing of anybody is opened. Only the tray and the
    // sign-in window exist (started with Windows: the tray alone, until somebody opens TeamHub).
    createTray()
    openSeatPicker(!startedHidden())
    log.info(`TeamHub ${app.getVersion()} started on a shared PC: waiting for sign-in`)
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
    // quit from the sign-in window: no session was started, nothing to stop
    if (!sessionStarted()) return
    stopScheduler()
    stopLocalBackups()
    stopTools()
    stopWatches()
    closeLocalDb()
  })
  // Keep running in the tray when all windows are hidden; quit only via tray/menu.
  app.on('window-all-closed', () => {
    /* stay alive in tray */
  })
  app.on('activate', () => {
    if (sessionStarted() && BrowserWindow.getAllWindows().length === 0) createMainWindow({ startHidden: false })
  })
}

process.on('uncaughtException', (err) => log.error('uncaughtException', err))
process.on('unhandledRejection', (err) => log.error('unhandledRejection', err))
