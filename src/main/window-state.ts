import { screen, type BrowserWindow, type Rectangle } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { userDataPath } from './paths'

interface WindowState {
  bounds: Rectangle
  maximized: boolean
}

const FILE = (): string => userDataPath('window-state.json')
const DEFAULT: WindowState = { bounds: { x: 0, y: 0, width: 1280, height: 800 }, maximized: false }

export function loadWindowState(): WindowState & { centered: boolean } {
  try {
    const s = JSON.parse(readFileSync(FILE(), 'utf8')) as WindowState
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return s.bounds.x < a.x + a.width - 50 && s.bounds.x + s.bounds.width > a.x + 50 && s.bounds.y >= a.y - 20 && s.bounds.y < a.y + a.height - 50
    })
    if (visible) return { ...s, centered: false }
  } catch {
    // first run or unreadable file: fall back to defaults
  }
  return { ...DEFAULT, centered: true }
}

export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined
  const save = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized()) return
      const state: WindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
      try {
        writeFileSync(FILE(), JSON.stringify(state))
      } catch {
        // non-fatal
      }
    }, 400)
  }
  win.on('resize', save)
  win.on('move', save)
  win.on('maximize', save)
  win.on('unmaximize', save)
}
