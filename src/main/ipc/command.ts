import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import { handle } from './registry'
import { closeCommandWindow, openControlWindow, openDrillWindow, openDrillWindows, type CommandWindowHost } from '../../../command/main/windows'
import { loadRenderer, secureWebContents } from '../windows/main-window'
import { resourcePath } from '../paths'

/** TeamHub's side of the 긴급구조지휘대 windows (command/main/windows.ts). */
const host = (): CommandWindowHost => ({
  preload: join(import.meta.dirname, '../preload/index.cjs'),
  icon: resourcePath('icon.png'),
  load: (win, route) => loadRenderer(win, route),
  secure: (win) => secureWebContents(win)
})

export function registerCommandIpc(): void {
  const id = z.object({ drillId: z.string().min(1).max(64), msgId: z.string().max(64).optional() })
  handle('command:openDrill', id, ({ drillId, msgId }) => openDrillWindow(host(), drillId, { msgId }))
  handle('command:openControl', id, ({ drillId }) => openControlWindow(host(), drillId))
  handle('command:closeWindow', null, (_r, e) => closeCommandWindow(BrowserWindow.fromWebContents(e.sender)))
  handle('command:openDrills', null, () => openDrillWindows())
}
