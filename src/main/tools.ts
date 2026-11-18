import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, nativeImage, screen, shell, type Rectangle } from 'electron'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import { newId } from '../node/sqlite'
import type { MainEvent, MainEventMap } from '../shared/ipc'
import type { AlarmFirePayload, AlarmPopupPayload, ClipboardSettings, FocusState, MemoDto } from '../shared/schemas/tools'
import { MEMO_COLORS } from '../shared/schemas/tools'
import { localDb } from './localdb'
import { isQuitting, loadRenderer, secureWebContents, showMainWindow, getMainWindow } from './windows/main-window'
import { resourcePath } from './paths'
import { onReminderPrefix, tick } from './scheduler'
import { setToastGate, showToast, type ToastOptions } from './notifications'

/**
 * Personal tools in the main process (6.12): sticky/quick memo windows, alarm popups,
 * focus timer, clipboard history and screen capture. Everything here is local only.
 */

export function broadcast<E extends MainEvent>(event: E, payload: MainEventMap[E]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(event, payload)
}

export function toolWindow(opts: Electron.BrowserWindowConstructorOptions, hash: string): BrowserWindow {
  const win = new BrowserWindow({
    icon: resourcePath('icon.png'),
    autoHideMenuBar: true,
    show: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    ...opts,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  })
  win.setMenu(null)
  secureWebContents(win)
  loadRenderer(win, hash)
  return win
}

const visible = (b: Rectangle): boolean =>
  screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return b.x + 40 < a.x + a.width && b.x + b.width - 40 > a.x && b.y >= a.y - 10 && b.y + 30 < a.y + a.height
  })

// ---------- sticky memos ----------
const stickies = new Map<string, BrowserWindow>()

export function openSticky(memo: MemoDto): void {
  const existing = stickies.get(memo.id)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }
  const area = screen.getPrimaryDisplay().workArea
  const n = stickies.size
  let b: Rectangle = { x: area.x + area.width - 300 - n * 24, y: area.y + 40 + n * 24, width: 260, height: 240 }
  if (memo.bounds) {
    const saved = { x: memo.bounds.x, y: memo.bounds.y, width: memo.bounds.w, height: memo.bounds.h }
    if (visible(saved)) b = saved
  }
  const win = toolWindow(
    {
      ...b,
      minWidth: 180,
      minHeight: 140,
      frame: false,
      skipTaskbar: true,
      alwaysOnTop: memo.alwaysOnTop,
      backgroundColor: MEMO_COLORS[memo.color],
      title: '스티커 메모'
    },
    `/popup/sticky/${memo.id}`
  )
  win.once('ready-to-show', () => win.showInactive())
  let t: NodeJS.Timeout | null = null
  const save = (): void => {
    if (t) clearTimeout(t)
    t = setTimeout(() => {
      if (win.isDestroyed()) return
      const nb = win.getBounds()
      localDb().memos.setBounds(memo.id, { x: nb.x, y: nb.y, w: nb.width, h: nb.height })
    }, 400)
  }
  win.on('moved', save)
  win.on('resized', save)
  // Closing a sticky (Alt+F4) takes it off the desktop; quitting keeps it for next start.
  win.on('close', () => {
    if (isQuitting()) return
    const nb = win.getBounds()
    localDb().memos.setBounds(memo.id, { x: nb.x, y: nb.y, w: nb.width, h: nb.height })
    localDb().memos.setSticky(memo.id, false)
    broadcast('memos:changed', { id: memo.id })
  })
  win.on('closed', () => stickies.delete(memo.id))
  stickies.set(memo.id, win)
}

export function setSticky(id: string, on: boolean): void {
  const memo = localDb().memos.get(id)
  if (!memo) return
  localDb().memos.setSticky(id, on)
  if (on) openSticky({ ...memo, sticky: true })
  else {
    const w = stickies.get(id)
    if (w && !w.isDestroyed()) w.close()
  }
  broadcast('memos:changed', { id })
}

export function setStickyOnTop(id: string, on: boolean): void {
  localDb().memos.setOnTop(id, on)
  stickies.get(id)?.setAlwaysOnTop(on)
  broadcast('memos:changed', { id })
}

export function memoChanged(id: string, deleted = false): void {
  const w = stickies.get(id)
  if (w && !w.isDestroyed()) {
    if (deleted) w.destroy()
    else {
      const m = localDb().memos.get(id)
      if (m) w.setBackgroundColor(MEMO_COLORS[m.color])
    }
  }
  broadcast('memos:changed', { id })
}

export function restoreStickies(): void {
  for (const m of localDb().memos.stickies()) openSticky(m)
}

// ---------- quick memo (Ctrl+Alt+M) ----------
let quickWin: BrowserWindow | null = null
export const QUICK_MEMO_SHORTCUT = 'CommandOrControl+Alt+M'

export function openQuickMemo(): void {
  if (quickWin && !quickWin.isDestroyed()) {
    quickWin.show()
    quickWin.focus()
    return
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  quickWin = toolWindow(
    {
      width: 440,
      height: 340,
      x: Math.round(area.x + (area.width - 440) / 2),
      y: Math.round(area.y + (area.height - 340) / 3),
      minWidth: 320,
      minHeight: 240,
      alwaysOnTop: true,
      title: '빠른 메모'
    },
    '/popup/quickmemo'
  )
  quickWin.once('ready-to-show', () => {
    quickWin?.show()
    quickWin?.focus()
  })
  quickWin.on('closed', () => (quickWin = null))
}

export function registerShortcuts(): void {
  try {
    if (!globalShortcut.register(QUICK_MEMO_SHORTCUT, openQuickMemo)) log.warn(`[tools] shortcut ${QUICK_MEMO_SHORTCUT} is taken by another program`)
  } catch (e) {
    log.warn('[tools] shortcut failed', e)
  }
}

// ---------- alarm popups ----------
const alarmPopups = new Map<string, { win: BrowserWindow; p: AlarmPopupPayload }>()
const shownRemote = new Set<string>()

export function getAlarmPopup(pid: string): AlarmPopupPayload | null {
  return alarmPopups.get(pid)?.p ?? null
}

export function showAlarmPopup(p: Omit<AlarmPopupPayload, 'pid'>): void {
  const pid = newId()
  const payload = { ...p, pid }
  const area = screen.getPrimaryDisplay().workArea
  const width = 380
  const height = 230
  const n = alarmPopups.size
  const win = toolWindow(
    {
      width,
      height,
      x: area.x + area.width - width - 16 - n * 20,
      y: area.y + area.height - height - 16 - n * 20,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: false,
      title: `알람 · ${p.title}`
    },
    `/popup/alarm/${pid}`
  )
  win.setAlwaysOnTop(true, 'screen-saver')
  win.once('ready-to-show', () => {
    win.showInactive()
    win.flashFrame(true)
  })
  win.on('closed', () => alarmPopups.delete(pid))
  alarmPopups.set(pid, { win, p: payload })
  if (process.env.TEAMHUB_E2E) {
    const g = globalThis as unknown as { __teamhubAlarms?: AlarmPopupPayload[] }
    ;(g.__teamhubAlarms ??= []).push(payload)
  }
}

export function alarmPopupAction(pid: string, action: 'dismiss' | 'snooze', minutes = 5): void {
  const entry = alarmPopups.get(pid)
  if (!entry) return
  const { p, win } = entry
  if (action === 'snooze') {
    const until = Date.now() + minutes * 60_000
    if (p.alarmId) localDb().alarms.snooze(p.alarmId, until)
    else localDb().alarms.save({ title: p.fromName ? `${p.title} (${p.fromName})` : p.title, note: p.body, kind: 'once', fireAt: until })
    broadcast('alarms:changed', { id: p.alarmId })
  }
  if (!win.isDestroyed()) win.destroy()
  alarmPopups.delete(pid)
}

export function showRemoteAlarm(a: AlarmFirePayload): void {
  if (shownRemote.has(a.id)) return
  shownRemote.add(a.id)
  showAlarmPopup({ alarmId: null, remoteId: a.id, title: a.title, body: a.body, fireAt: a.fireAt, fromName: a.fromName, sound: true })
}

function setupAlarmFiring(): void {
  onReminderPrefix('al:', (r) => {
    const [, id, t] = r.key.split(':')
    const a = localDb().alarms.get(id)
    if (!a) return
    localDb().alarms.fired(id, Number(t))
    showAlarmPopup({ alarmId: id, remoteId: null, title: a.title, body: a.note, fireAt: Number(t), fromName: null, sound: a.sound })
    broadcast('alarms:changed', { id })
  })
}

// ---------- focus timer ----------
let focus: { id: string; kind: 'focus' | 'break'; minutes: number; endsAt: number; timer: NodeJS.Timeout } | null = null
let held: ToastOptions[] = []

export function focusState(): FocusState {
  return { active: !!focus, kind: focus?.kind ?? 'focus', minutes: focus?.minutes ?? 0, endsAt: focus?.endsAt ?? null, held: held.length }
}

export function startFocus(minutes: number, kind: 'focus' | 'break'): FocusState {
  stopFocus(false)
  const id = localDb().tools.startFocus(minutes, kind)
  const endsAt = Date.now() + minutes * 60_000
  focus = { id, kind, minutes, endsAt, timer: setTimeout(() => stopFocus(true), minutes * 60_000) }
  broadcast('focus:state', focusState())
  return focusState()
}

export function stopFocus(completed: boolean): FocusState {
  if (!focus) return focusState()
  clearTimeout(focus.timer)
  const f = focus
  focus = null
  if (completed) localDb().tools.endFocus(f.id)
  else localDb().db.run('DELETE FROM focus_sessions WHERE id = ?', [f.id])
  if (completed) {
    showAlarmPopup({
      alarmId: null,
      remoteId: null,
      title: f.kind === 'focus' ? `집중 ${f.minutes}분 완료` : '휴식 끝',
      body: f.kind === 'focus' ? '잠시 쉬었다가 다시 시작하세요.' : '다시 집중할 시간입니다.',
      fireAt: Date.now(),
      fromName: null,
      sound: true
    })
  }
  if (held.length) {
    const n = held.length
    const last = held[held.length - 1]
    held = []
    showToast({ title: `집중하는 동안 보류된 알림 ${n}건`, body: last ? `${last.title} · ${last.body}` : '', route: last?.route }, true)
  }
  broadcast('focus:state', focusState())
  return focusState()
}

// ---------- clipboard history & screen capture ----------
let clipTimer: NodeJS.Timeout | null = null
let lastText = ''
let lastImg = ''
let captureUntil = 0

export function clipboardSettings(): ClipboardSettings {
  return { enabled: false, clearOnExit: false, ...(localDb().kv.get<Partial<ClipboardSettings>>('clipboard') ?? {}) }
}

/**
 * Electron 45 clipboard is async and W3C-like (read/readText/write/writeText).
 * Images are read as PNG blobs.
 */
async function readClipboardImage(): Promise<Buffer | null> {
  for (const item of await clipboard.read()) {
    const type = item.types.find((t) => t === 'image/png') ?? item.types.find((t) => t.startsWith('image/'))
    if (!type) continue
    const blob = (await item.getType(type)) as Blob
    return Buffer.from(await blob.arrayBuffer())
  }
  return null
}

const sigOf = (buf: Buffer): string => createHash('md5').update(buf).digest('hex')

let polling = false
async function pollClipboard(): Promise<void> {
  const s = clipboardSettings()
  const capturing = captureUntil > Date.now()
  if ((!s.enabled && !capturing) || polling) return
  polling = true
  try {
    const png = await readClipboardImage()
    if (png) {
      const sig = sigOf(png)
      if (sig === lastImg) return
      lastImg = sig
      let img = nativeImage.createFromBuffer(png)
      if (img.isEmpty()) return
      if (img.getSize().width > 1600) img = img.resize({ width: 1600 })
      const dataUrl = `data:image/png;base64,${img.toPNG().toString('base64')}`
      if (capturing) {
        captureUntil = 0
        showMainWindow()
        getMainWindow()?.webContents.send('capture:done', { dataUrl })
      }
      if (s.enabled && dataUrl.length < 3_000_000) {
        localDb().tools.addClipboard('image', dataUrl)
        broadcast('clipboard:changed', { count: 1 })
      }
      return
    }
    const text = await clipboard.readText()
    if (text && text !== lastText) {
      lastText = text
      if (s.enabled && text.length <= 20_000) {
        localDb().tools.addClipboard('text', text)
        broadcast('clipboard:changed', { count: 1 })
      }
    }
  } catch (e) {
    log.warn('[tools] clipboard poll failed', e)
  } finally {
    polling = false
  }
}

async function primeClipboard(): Promise<void> {
  try {
    lastText = await clipboard.readText()
    const png = await readClipboardImage()
    lastImg = png ? sigOf(png) : ''
  } catch {
    // empty clipboard
  }
}

export async function setClipboardSettings(s: ClipboardSettings): Promise<void> {
  const before = clipboardSettings()
  if (s.enabled && !before.enabled) await primeClipboard()
  localDb().kv.set('clipboard', s)
}

export async function writeClipboard(o: { text?: string; dataUrl?: string }): Promise<void> {
  if (o.dataUrl) {
    const png = nativeImage.createFromDataURL(o.dataUrl).toPNG()
    lastImg = sigOf(png)
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
  } else if (o.text !== undefined) {
    await clipboard.writeText(o.text)
  }
}

export async function startCapture(): Promise<void> {
  await primeClipboard()
  captureUntil = Date.now() + 120_000
  void shell.openExternal('ms-screenclip:').catch((e: unknown) => log.warn('[tools] screenclip failed', e))
}

export async function saveCaptureFile(dataUrl: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const r = await dialog.showSaveDialog({
    title: '캡처 저장',
    defaultPath: join(app.getPath('pictures'), `캡처_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`),
    filters: [{ name: 'PNG 이미지', extensions: ['png'] }]
  })
  if (r.canceled || !r.filePath) return { ok: false }
  try {
    writeFileSync(r.filePath, nativeImage.createFromDataURL(dataUrl).toPNG())
    return { ok: true, path: r.filePath }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ---------- lifecycle ----------
export function startTools(): void {
  setupAlarmFiring()
  setToastGate((o) => {
    if (focus?.kind !== 'focus') return true
    held.push(o)
    broadcast('focus:state', focusState())
    return false
  })
  if (clipboardSettings().enabled) void primeClipboard()
  clipTimer = setInterval(() => void pollClipboard(), 1000)
  registerShortcuts()
  restoreStickies()
  // Alarms saved while the app was off are picked up by the regular tick.
  setTimeout(() => tick(), 1500)
}

export function stopTools(): void {
  if (clipTimer) clearInterval(clipTimer)
  clipTimer = null
  globalShortcut.unregisterAll()
  if (clipboardSettings().clearOnExit) localDb().tools.deleteClipboard(null)
}
