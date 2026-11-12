import { app, BrowserWindow, desktopCapturer, screen, session } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'
import { loadRenderer, secureWebContents, getMainWindow } from './windows/main-window'
import { resourcePath } from './paths'
import type { MeetingInvitePayload } from '../shared/schemas/meetings'

/**
 * Video meetings (6.17). Media flows renderer-to-renderer (WebRTC); main handles
 * permissions, the screen/window picker source, the meeting window and invite pop-ups.
 */

/** Must run before app ready: show real LAN addresses instead of .local names (13.13). */
export function configureWebRtcSwitches(): void {
  app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns')
  // E2E: synthetic camera/microphone so two profiles can call each other on one PC.
  if (process.env.TEAMHUB_FAKE_MEDIA) app.commandLine.appendSwitch('use-fake-device-for-media-stream')
}

const isOwnPage = (url: string): boolean => url.startsWith('file://') || (!!process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))

let pendingSource: { id: string; audio: boolean } | null = null

export function setupMediaPermissions(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    // camera/mic/screen only for our own pages; everything else keeps Chromium defaults off
    if (['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen'].includes(permission)) return cb(isOwnPage(wc.getURL()))
    cb(false)
  })
  ses.setPermissionCheckHandler((wc, permission) => (permission === 'media' || permission === 'display-capture' ? !!wc && isOwnPage(wc.getURL()) : true))
  // getDisplayMedia(): use the source the user chose in TeamHub's picker.
  ses.setDisplayMediaRequestHandler(
    (_req, cb) => {
      const src = pendingSource
      pendingSource = null
      if (!src) return cb({})
      desktopCapturer
        .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
        .then((list) => {
          const s = list.find((x) => x.id === src.id)
          if (!s) return cb({})
          cb(src.audio && s.id.startsWith('screen:') ? { video: s, audio: 'loopback' } : { video: s })
        })
        .catch((e: unknown) => {
          log.warn('[rtc] getSources failed', e)
          cb({})
        })
    },
    { useSystemPicker: false }
  )
}

export async function captureSources(): Promise<{ id: string; name: string; thumbnail: string; kind: 'screen' | 'window'; displayId: string }[]> {
  const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false })
  return list
    .filter((s) => !/^TeamHub/.test(s.name) || s.id.startsWith('screen:'))
    .map((s, i) => ({ id: s.id, name: s.id.startsWith('screen:') ? `화면 ${i + 1}` : s.name, thumbnail: s.thumbnail.toDataURL(), kind: s.id.startsWith('screen:') ? ('screen' as const) : ('window' as const), displayId: s.display_id }))
}

export function chooseSource(id: string, audio: boolean): void {
  pendingSource = { id, audio }
}

// ---------- share border (6.17 공유 중 표시 테두리) ----------
let border: BrowserWindow | null = null
export function showShareBorder(displayId: string | null): void {
  hideShareBorder()
  const d = (displayId && screen.getAllDisplays().find((x) => String(x.id) === displayId)) || screen.getPrimaryDisplay()
  const b = d.bounds
  border = new BrowserWindow({ ...b, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false, hasShadow: false, show: false, webPreferences: { sandbox: true } })
  border.setIgnoreMouseEvents(true)
  border.setAlwaysOnTop(true, 'screen-saver')
  border.setContentProtection(true) // the border itself is not captured
  void border.loadURL(`data:text/html,<html><body style="margin:0;border:4px solid %23dc2626;box-sizing:border-box;height:100vh;background:transparent"><div style="position:fixed;top:0;left:50%25;transform:translateX(-50%25);background:%23dc2626;color:white;font:12px sans-serif;padding:2px 10px;border-radius:0 0 6px 6px">화면 공유 중</div></body></html>`)
  border.once('ready-to-show', () => border?.showInactive())
}
export function hideShareBorder(): void {
  if (border && !border.isDestroyed()) border.destroy()
  border = null
}

// ---------- meeting window ----------
const rooms = new Map<string, BrowserWindow>()

export function openMeetingWindow(id: string): void {
  const existing = rooms.get(id)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: 'TeamHub 회의',
    icon: resourcePath('icon.png'),
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#0f172a',
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  })
  win.setMenu(null)
  secureWebContents(win)
  // E2E: the camera comes from a canvas, because Chromium's fake capture service crashes now and then.
  loadRenderer(win, `/popup/meeting/${id}${process.env.TEAMHUB_FAKE_MEDIA ? '?fakecam=1' : ''}`)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    rooms.delete(id)
    hideShareBorder()
    getMainWindow()?.webContents.send('meeting:closed', { id })
  })
  rooms.set(id, win)
}

// ---------- invite pop-up ----------
const invites = new Map<string, { win: BrowserWindow; p: MeetingInvitePayload }>()
export const getInvite = (id: string): MeetingInvitePayload | null => invites.get(id)?.p ?? null

export function showInvite(p: MeetingInvitePayload): void {
  if (rooms.has(p.id) || invites.has(p.id)) return
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({
    width: 380,
    height: 200,
    x: area.x + area.width - 396,
    y: area.y + area.height - 216,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    title: `회의 초대 · ${p.title}`,
    icon: resourcePath('icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  })
  win.setMenu(null)
  win.setAlwaysOnTop(true, 'screen-saver')
  secureWebContents(win)
  loadRenderer(win, `/popup/invite/${p.id}`)
  win.once('ready-to-show', () => {
    win.showInactive()
    win.flashFrame(true)
  })
  win.on('closed', () => invites.delete(p.id))
  invites.set(p.id, { win, p })
  if (process.env.TEAMHUB_E2E) {
    const g = globalThis as unknown as { __teamhubInvites?: MeetingInvitePayload[] }
    ;(g.__teamhubInvites ??= []).push(p)
  }
}

export function closeInvite(id: string, accept: boolean): void {
  const e = invites.get(id)
  if (e && !e.win.isDestroyed()) e.win.destroy()
  invites.delete(id)
  if (accept) openMeetingWindow(id)
}
