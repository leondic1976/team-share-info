import { Menu, Tray, app, nativeImage } from 'electron'
import { resourcePath, PROFILE } from './paths'
import { setQuitting, showMainWindow } from './windows/main-window'
import { openQuickMemo, startCapture } from './tools'
import { openLauncherBar } from './launcher'
import { activeSeat, askSwitchUser, sessionStarted, showFront } from './seats'
import { lockNow } from './applock'

let tray: Tray | null = null
let unread = 0

function icon(hasUnread: boolean): Electron.NativeImage {
  return nativeImage.createFromPath(resourcePath(hasUnread ? 'tray-unread.png' : 'tray.png'))
}

function tooltip(): string {
  const base = PROFILE ? `TeamHub (${PROFILE})` : 'TeamHub'
  return unread > 0 ? `${base} - 읽지 않은 알림 ${unread}건` : base
}

/** Shared PC: nobody signed in yet means no personal tools; a signed-in person can hand the PC over. */
export function refreshTrayMenu(): void {
  if (!tray) return
  const quit: Electron.MenuItemConstructorOptions = {
    label: '종료',
    click: () => {
      setQuitting(true)
      app.quit()
    }
  }
  if (!sessionStarted()) {
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'TeamHub 열기', click: () => showFront() }, { type: 'separator' }, quit]))
    return
  }
  const seat = activeSeat()
  const menu = Menu.buildFromTemplate([
    { label: 'TeamHub 열기', click: () => showMainWindow() },
    { label: '빠른 실행 (Ctrl+Alt+Space)', click: () => openLauncherBar() },
    { label: '빠른 메모 (Ctrl+Alt+M)', click: () => openQuickMemo() },
    { label: '화면 캡처', click: () => void startCapture() },
    ...(seat
      ? ([
          { type: 'separator' },
          { label: `사용자: ${seat.name}`, enabled: false },
          { label: '지금 잠그기', click: () => lockNow() },
          { label: '사용자 바꾸기', click: () => void askSwitchUser() }
        ] satisfies Electron.MenuItemConstructorOptions[])
      : []),
    { type: 'separator' },
    quit
  ])
  tray.setContextMenu(menu)
}

export function createTray(): Tray {
  tray = new Tray(icon(false))
  tray.setToolTip(tooltip())
  refreshTrayMenu()
  tray.on('click', () => showFront())
  tray.on('double-click', () => showFront())
  return tray
}

export function setTrayUnread(count: number): void {
  unread = Math.max(0, Math.floor(count))
  if (!tray) return
  tray.setImage(icon(unread > 0))
  tray.setToolTip(tooltip())
}

export function getTray(): Tray | null {
  return tray
}
