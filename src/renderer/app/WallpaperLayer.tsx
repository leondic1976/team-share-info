import { useEffect, useState } from 'react'
import { veilFor } from '@shared/wallpapers'
import { usePrefs } from './prefs-store'
import { loadCustomImage, resolveWallpaper, useIsDark, useWallpapers } from './wallpaper-store'

/**
 * The personal wallpaper behind the main window, under a veil of the background colour.
 * The veil is never thinner than the readability guard allows (veilFor), so text keeps
 * its contrast on any wallpaper, including the user's own pictures.
 */
export function WallpaperLayer(): React.JSX.Element | null {
  const id = usePrefs((s) => s.wallpaper)
  const strength = usePrefs((s) => s.wallpaperStrength)
  const blur = usePrefs((s) => s.wallpaperBlur)
  const customs = useWallpapers((s) => s.customs)
  const load = useWallpapers((s) => s.load)
  const dark = useIsDark()
  const [data, setData] = useState<{ id: string; url: string | null } | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!id.startsWith('custom:')) return
    let alive = true
    void loadCustomImage(id.slice(7)).then((url) => alive && setData({ id, url }))
    return () => {
      alive = false
    }
  }, [id])

  const w = resolveWallpaper(id, customs, data?.id === id ? data.url : null)
  const on = !!w?.css

  // strengthened secondary text and a see-through sidebar only while a wallpaper is showing
  useEffect(() => {
    document.documentElement.classList.toggle('has-wallpaper', on)
    return () => document.documentElement.classList.remove('has-wallpaper')
  }, [on])

  if (!w?.css) return null
  const veil = veilFor(dark ? 'dark' : 'light', w.extremes, strength)
  const px = w.custom ? blur : 0
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" data-testid="wallpaper" data-veil={veil.toFixed(2)}>
      <div className="absolute" style={{ inset: px ? -px * 2 : 0, background: w.css, filter: px ? `blur(${px}px)` : undefined }} />
      <div className="absolute inset-0" style={{ background: 'var(--background)', opacity: veil }} />
    </div>
  )
}
