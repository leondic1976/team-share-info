import { describe, it, expect } from 'vitest'
import { WALLPAPERS, WALLPAPER_CATEGORIES, WALLPAPER_TEXT, contrast, extremesOf, maxStrength, minVeil, parseHex, readableCss, veilFor, wallpaperExtremes, worstContrast, type Rgb } from '../../src/shared/wallpapers'

const mix = (veil: Rgb, under: Rgb, a: number): Rgb => [0, 1, 2].map((i) => veil[i]! * a + under[i]! * (1 - a)) as Rgb

describe('wallpapers', () => {
  it('offers 100 built-in wallpapers with unique ids and names, in every category', () => {
    expect(WALLPAPERS).toHaveLength(100)
    expect(new Set(WALLPAPERS.map((w) => w.id)).size).toBe(100)
    expect(new Set(WALLPAPERS.map((w) => w.name)).size).toBe(100)
    for (const c of WALLPAPER_CATEGORIES) expect(WALLPAPERS.filter((w) => w.category === c.key).length).toBeGreaterThanOrEqual(10)
  })

  it('uses only hex colours, so the guard sees every colour of a wallpaper', () => {
    for (const w of WALLPAPERS) {
      const css = readableCss(w.css)
      expect(css, w.id).not.toMatch(/rgba?\(|hsla?\(/)
      expect(css.replace(/transparent/g, ''), w.id).not.toMatch(/\b(white|black|red|blue|green|yellow|gray|grey|pink|orange|purple)\b/)
      expect(css.match(/#[0-9a-fA-F]{3,8}\b/g)?.length ?? 0, w.id).toBeGreaterThan(0)
    }
  })

  it('computes WCAG contrast', () => {
    expect(contrast(parseHex('#000000'), parseHex('#ffffff'))).toBeCloseTo(21, 5)
    expect(contrast(parseHex('#ffffff'), parseHex('#ffffff'))).toBe(1)
    expect(contrast(parseHex('#64748b'), parseHex('#fff'))).toBeCloseTo(4.76, 1)
  })

  it('keeps every text colour readable on every wallpaper, in both themes, at any strength', () => {
    const caps: number[] = []
    for (const theme of ['light', 'dark'] as const) {
      const t = WALLPAPER_TEXT[theme]
      for (const w of WALLPAPERS) {
        const ex = wallpaperExtremes(w)
        for (const strength of [0, 30, 60, 100]) {
          const veil = veilFor(theme, ex, strength)
          expect(veil).toBeGreaterThanOrEqual(minVeil(theme, ex))
          for (const under of [ex.darkest, ex.lightest, mix(ex.darkest, ex.lightest, 0.5)])
            for (const c of t.checks) expect(contrast(c.color, mix(t.background, under, veil)), `${theme} ${w.id} ${c.name} @${strength}`).toBeGreaterThanOrEqual(c.min)
          expect(worstContrast(theme, ex, veil).ok).toBe(true)
        }
        caps.push(maxStrength(theme, ex))
      }
    }
    // the guard must not make wallpapers pointless: each stays visible to some degree
    console.log('max strength: min', Math.min(...caps), 'median', [...caps].sort((a, b) => a - b)[caps.length / 2])
    expect(Math.min(...caps)).toBeGreaterThanOrEqual(10)
  })

  it('guards a photo with pure black and white (worst case) and lets a soft one show strongly', () => {
    const harsh = extremesOf([parseHex('#000'), parseHex('#fff')])
    const soft = extremesOf([parseHex('#fde2f3'), parseHex('#fff')])
    for (const theme of ['light', 'dark'] as const) {
      expect(minVeil(theme, harsh)).toBeGreaterThan(0.6)
      expect(worstContrast(theme, harsh, minVeil(theme, harsh)).ok).toBe(true)
      expect(worstContrast(theme, harsh, minVeil(theme, harsh) - 0.05).ok).toBe(false)
    }
    expect(maxStrength('light', soft)).toBeGreaterThan(80)
    expect(maxStrength('dark', soft)).toBeLessThan(40)
  })
})
