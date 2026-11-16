import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { localKv } from '@renderer/lib/bridge'
import { extremesOf, parseHex, wallpaperExtremes, WALLPAPERS, type Extremes, type Rgb } from '@shared/wallpapers'
import { isDarkNow, usePrefs } from './prefs-store'

/**
 * The user's own wallpaper pictures. They stay on this PC (local DB): a small index with
 * thumbnails, and each full picture under its own key so only the one in use is loaded.
 */
export interface CustomWallpaper {
  id: string
  name: string
  thumb: string
  /** per-channel darkest / lightest colour of the picture, for the readability guard */
  darkest: string
  lightest: string
}

const INDEX_KEY = 'wallpaper.custom'
const dataKey = (id: string): string => `wallpaper.custom.${id}`
export const MAX_CUSTOM_WALLPAPERS = 12
const MAX_SIDE = 1920

interface WallpaperState {
  customs: CustomWallpaper[]
  loaded: boolean
  load: () => Promise<void>
  add: (file: File) => Promise<CustomWallpaper>
  remove: (id: string) => Promise<void>
}

const toHex = (c: Rgb): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`

function draw(src: ImageBitmap, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  // pictures with transparency are shown on white
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(src, 0, 0, w, h)
  return c
}

/** Darkest and lightest colour (per channel) of a picture, from a 32×32 reduction. */
function measure(src: ImageBitmap): Extremes {
  const d = draw(src, 32, 32).getContext('2d')!.getImageData(0, 0, 32, 32).data
  const px: Rgb[] = []
  for (let i = 0; i < d.length; i += 4) px.push([d[i]!, d[i + 1]!, d[i + 2]!])
  return extremesOf(px)
}

export const useWallpapers = create<WallpaperState>((set, get) => ({
  customs: [],
  loaded: false,
  load: async () => {
    if (get().loaded) return
    set({ customs: (await localKv.get<CustomWallpaper[]>(INDEX_KEY)) ?? [], loaded: true })
  },
  add: async (file) => {
    if (!file.type.startsWith('image/')) throw new Error('그림 파일만 쓸 수 있습니다.')
    if (file.size > 30 * 1024 * 1024) throw new Error('30MB보다 큰 그림은 쓸 수 없습니다.')
    if (get().customs.length >= MAX_CUSTOM_WALLPAPERS) throw new Error(`내 그림은 ${MAX_CUSTOM_WALLPAPERS}개까지 넣을 수 있습니다. 쓰지 않는 그림을 지우세요.`)
    let bmp: ImageBitmap
    try {
      bmp = await createImageBitmap(file)
    } catch {
      throw new Error('그림을 읽지 못했습니다. JPG·PNG·WebP·GIF·BMP 파일을 쓰세요.')
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height))
    const full = draw(bmp, Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale))).toDataURL('image/jpeg', 0.85)
    const ts = Math.min(1, 240 / Math.max(bmp.width, bmp.height))
    const thumb = draw(bmp, Math.max(1, Math.round(bmp.width * ts)), Math.max(1, Math.round(bmp.height * ts))).toDataURL('image/jpeg', 0.7)
    const ex = measure(bmp)
    bmp.close()
    const item: CustomWallpaper = { id: crypto.randomUUID(), name: file.name.replace(/\.[^.]+$/, '').slice(0, 40), thumb, darkest: toHex(ex.darkest), lightest: toHex(ex.lightest) }
    await localKv.set(dataKey(item.id), full)
    const customs = [...get().customs, item]
    await localKv.set(INDEX_KEY, customs)
    set({ customs })
    return item
  },
  remove: async (id) => {
    const customs = get().customs.filter((c) => c.id !== id)
    await localKv.set(INDEX_KEY, customs)
    await localKv.delete(dataKey(id))
    set({ customs })
    if (usePrefs.getState().wallpaper === `custom:${id}`) usePrefs.getState().update({ wallpaper: '' })
  }
}))

export const loadCustomImage = (id: string): Promise<string | null> => localKv.get<string>(dataKey(id))

/** The dark theme is on screen (follows the system setting live). */
export function useIsDark(): boolean {
  const theme = usePrefs((s) => s.theme)
  const [, tick] = useState(0)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (): void => tick((n) => n + 1)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return isDarkNow(theme)
}

export interface ResolvedWallpaper {
  /** CSS `background` value, null while a custom picture is loading */
  css: string | null
  extremes: Extremes
  custom: boolean
}

/** Look up a wallpaper id: built-in design or the user's own picture. */
export function resolveWallpaper(id: string, customs: CustomWallpaper[], customData?: string | null): ResolvedWallpaper | null {
  if (!id) return null
  if (id.startsWith('custom:')) {
    const c = customs.find((x) => `custom:${x.id}` === id)
    if (!c) return null
    return { css: customData ? `url("${customData}") center / cover no-repeat` : null, extremes: { darkest: parseHex(c.darkest), lightest: parseHex(c.lightest) }, custom: true }
  }
  const w = WALLPAPERS.find((x) => x.id === id)
  return w ? { css: w.css, extremes: wallpaperExtremes(w), custom: false } : null
}
