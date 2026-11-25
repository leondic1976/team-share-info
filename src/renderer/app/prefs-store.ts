import { create } from 'zustand'
import { invoke, localKv } from '@renderer/lib/bridge'

export type Theme = 'light' | 'dark' | 'system'

export interface Prefs {
  theme: Theme
  fontSize: number
  sidebarCollapsed: boolean
  hiddenMenus: string[]
  menuOrder: string[]
  dndEnabled: boolean
  dndStart: string
  dndEnd: string
  homeWidgets: string[]
  hiddenWidgets: string[]
  /** wallpaper id: a built-in one, `custom:<id>` for the user's own picture, '' for none */
  wallpaper: string
  /** how strongly the wallpaper shows, 0–100 (capped by the readability guard) */
  wallpaperStrength: number
  /** blur of the user's own picture, px */
  wallpaperBlur: number
  /** new message: the "팀뿌요~" sound (지시 83) */
  msgSound: boolean
  /** new message: a card near the tray instead of a Windows notification (지시 83) */
  msgPreview: boolean
  /** where the cards show (지시 106) */
  previewCorner: 'bottom-right' | 'top-right'
}

const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  fontSize: 14,
  sidebarCollapsed: false,
  hiddenMenus: [],
  menuOrder: [],
  dndEnabled: false,
  dndStart: '18:00',
  dndEnd: '09:00',
  homeWidgets: [],
  hiddenWidgets: [],
  wallpaper: '',
  wallpaperStrength: 60,
  wallpaperBlur: 0,
  msgSound: true,
  msgPreview: true,
  previewCorner: 'bottom-right'
}
const KEY = 'prefs'

interface PrefsState extends Prefs {
  loaded: boolean
  load: () => Promise<void>
  update: (patch: Partial<Prefs>) => void
}

function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

function applyFont(px: number): void {
  document.documentElement.style.setProperty('--app-font-size', `${px}px`)
}

export const usePrefs = create<PrefsState>((set, get) => ({
  ...DEFAULT_PREFS,
  loaded: false,
  load: async () => {
    const saved = (await localKv.get<Partial<Prefs>>(KEY)) ?? {}
    const prefs = { ...DEFAULT_PREFS, ...saved }
    applyTheme(prefs.theme)
    applyFont(prefs.fontSize)
    void invoke('window:setTheme', { theme: prefs.theme })
    set({ ...prefs, loaded: true })
  },
  update: (patch) => {
    const cur = get()
    const next: Prefs = {
      theme: patch.theme ?? cur.theme,
      fontSize: Math.min(18, Math.max(13, patch.fontSize ?? cur.fontSize)),
      sidebarCollapsed: patch.sidebarCollapsed ?? cur.sidebarCollapsed,
      hiddenMenus: patch.hiddenMenus ?? cur.hiddenMenus,
      menuOrder: patch.menuOrder ?? cur.menuOrder,
      dndEnabled: patch.dndEnabled ?? cur.dndEnabled,
      dndStart: patch.dndStart ?? cur.dndStart,
      dndEnd: patch.dndEnd ?? cur.dndEnd,
      homeWidgets: patch.homeWidgets ?? cur.homeWidgets,
      hiddenWidgets: patch.hiddenWidgets ?? cur.hiddenWidgets,
      wallpaper: patch.wallpaper ?? cur.wallpaper,
      wallpaperStrength: Math.min(100, Math.max(0, patch.wallpaperStrength ?? cur.wallpaperStrength)),
      wallpaperBlur: Math.min(20, Math.max(0, patch.wallpaperBlur ?? cur.wallpaperBlur)),
      msgSound: patch.msgSound ?? cur.msgSound,
      msgPreview: patch.msgPreview ?? cur.msgPreview,
      previewCorner: patch.previewCorner === 'top-right' || patch.previewCorner === 'bottom-right' ? patch.previewCorner : cur.previewCorner
    }
    if (patch.theme) {
      applyTheme(next.theme)
      void invoke('window:setTheme', { theme: next.theme })
    }
    if (patch.fontSize) applyFont(next.fontSize)
    set(next)
    void localKv.set(KEY, next)
  }
}))

if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyTheme(usePrefs.getState().theme)
  })
}

/** Whether the dark theme is the one on screen (follows the system when the theme says so). */
export function isDarkNow(theme: Theme): boolean {
  return theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

/** Do-not-disturb applies to important/normal alerts only; urgent always shows (6.3). */
export function inDoNotDisturb(now = new Date()): boolean {
  const p = usePrefs.getState()
  if (!p.dndEnabled) return false
  const m = now.getHours() * 60 + now.getMinutes()
  const toMin = (s: string): number => {
    const [h, mm] = s.split(':').map(Number)
    return (h || 0) * 60 + (mm || 0)
  }
  const a = toMin(p.dndStart)
  const b = toMin(p.dndEnd)
  return a <= b ? m >= a && m < b : m >= a || m < b
}
