import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { PLUGIN_SDK } from '../../src/main/plugin-sdk'
import { ICONS, iconSvg, resolveIconName } from '../../src/shared/icons'

interface Sdk {
  icon: (name: unknown, opts?: Record<string, unknown>) => string
  iconName: (name: unknown, fallback?: string) => string
  icons: string[]
}

/** Run the SDK script the way a frame does, with just enough of a page around it. */
function loadSdk(): Sdk {
  const el = (): Record<string, unknown> => ({ dataset: {}, appendChild: () => undefined })
  const window: Record<string, unknown> = { addEventListener: () => undefined, parent: { postMessage: () => undefined } }
  const document = { documentElement: el(), head: el(), readyState: 'complete', createElement: el, addEventListener: () => undefined, querySelectorAll: () => [] }
  runInNewContext(PLUGIN_SDK, { window, document, location: { search: '?theme=dark' }, URLSearchParams, console })
  return window.TeamHub as Sdk
}

describe('plugin SDK icons (TeamHub.icon)', () => {
  const sdk = loadSdk()

  it('draws a line icon of the shared table as SVG markup', () => {
    const svg = sdk.icon('utensils')
    expect(svg).toMatch(/^<svg class="th-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"/)
    expect(svg).toContain(ICONS.utensils)
    expect(sdk.icons).toEqual(Object.keys(ICONS))
  })

  it('takes a size, a fill and a label', () => {
    const svg = sdk.icon('heart', { size: 20, fill: true, label: '좋아요 "함"' })
    expect(svg).toContain('width="20" height="20"')
    expect(svg).toContain('fill="currentColor"')
    expect(svg).toContain('role="img" aria-label="좋아요 &#34;함&#34;"')
  })

  it('never shows an unknown value: fallback icon, and older emoji values map to a name', () => {
    expect(sdk.icon('no-such-icon')).toContain(ICONS.puzzle)
    expect(sdk.icon('<script>', { fallback: 'file-text' })).toContain(ICONS['file-text'])
    expect(sdk.iconName('\u{1F4E6}')).toBe('package')
    expect(sdk.iconName('\u{1F5D3}\u{FE0F}')).toBe('calendar-days')
    expect(sdk.iconName(undefined, 'file-text')).toBe('file-text')
  })
})

describe('shared icon table', () => {
  it('resolves names the same way outside the frames', () => {
    expect(resolveIconName('soup')).toBe('soup')
    expect(resolveIconName('\u{1F4C4}')).toBe('file-text')
    expect(resolveIconName('\u{1F363}')).toBe('puzzle')
    expect(resolveIconName('', 'file-text')).toBe('file-text')
    expect(iconSvg('ladder', { size: 16 })).toContain("width='16'")
  })

  it('holds only stroke shapes (no scripts, no text)', () => {
    for (const [name, body] of Object.entries(ICONS)) {
      expect(name).toMatch(/^[a-z0-9-]+$/)
      expect(body).toMatch(/^(<(path|circle|rect|line|ellipse|polyline|polygon) [^<>]*\/>)+$/)
    }
  })
})
