import { app } from 'electron'

/** Windows "start at login" (5.2). Starts minimized to the tray. */
const HIDDEN_ARG = '--hidden'

export function startedHidden(): boolean {
  return process.argv.includes(HIDDEN_ARG)
}

export function getAutostart(): boolean {
  if (!app.isPackaged) return false
  return app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin
}

export function setAutostart(enabled: boolean): boolean {
  // In dev the executable is electron.exe; registering it would be wrong. E2E runs must not touch login items.
  if (!app.isPackaged || process.env.TEAMHUB_E2E) return false
  app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_ARG] })
  return getAutostart()
}
