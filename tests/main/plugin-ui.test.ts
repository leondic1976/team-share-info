import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Extension frames get the look of the program from resources/ui/base.css (served as __ui.css).
 * Its colour tokens are copies of the ones of the main screen (src/renderer/styles.css): when a
 * token of the program changes, this fails until the copy follows.
 */
const root = resolve(__dirname, '..', '..')
const app = readFileSync(join(root, 'src/renderer/styles.css'), 'utf8')
const base = readFileSync(join(root, 'resources/ui/base.css'), 'utf8')

/** The custom properties of the first rule with exactly this selector. */
function tokens(css: string, selector: string): Record<string, string> {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))
  if (!m) throw new Error(`no rule "${selector}"`)
  const out: Record<string, string> = {}
  for (const d of m[1].split(';')) {
    const i = d.indexOf(':')
    const name = d.slice(0, i).trim()
    if (i > 0 && name.startsWith('--')) out[name] = d.slice(i + 1).trim().toLowerCase()
  }
  return out
}

describe('look of the extension frames (resources/ui/base.css)', () => {
  const light = tokens(app, ':root')
  const dark = tokens(app, '.dark')
  const baseLight = tokens(base, ':root')
  const baseDark = tokens(base, "[data-theme='dark']")

  it('reads the tokens of the main screen', () => {
    expect(Object.keys(light)).toEqual(expect.arrayContaining(['--background', '--foreground', '--muted', '--muted-foreground', '--card', '--border', '--input', '--primary', '--primary-foreground', '--accent']))
    expect(Object.keys(dark).length).toBeGreaterThanOrEqual(10)
  })

  it('has every light token of the main screen, with the same value', () => {
    for (const [name, value] of Object.entries(light)) expect([name, baseLight[name]]).toEqual([name, value])
  })

  it('has every dark token of the main screen, with the same value', () => {
    for (const [name, value] of Object.entries(dark)) expect([name, baseDark[name]]).toEqual([name, value])
    // and no dark value for a token the main screen does not change in the dark
    expect(Object.keys(baseDark).filter((n) => !(n in dark))).toEqual([])
  })

  it('has the fixed colours of the theme (urgent, important, personal, success)', () => {
    const theme = tokens(app, '@theme')
    const fixed = Object.entries(theme).filter(([n, v]) => n.startsWith('--color-') && /^#[0-9a-f]{3,8}$/.test(v))
    expect(fixed.map(([n]) => n).sort()).toEqual(['--color-important', '--color-personal', '--color-success', '--color-urgent'])
    for (const [name, value] of fixed) expect([name, baseLight[name.replace('--color-', '--')]]).toEqual([name, value])
  })

  it('styles nothing but its own classes and pages that ask for it', () => {
    const rules = base
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@media[^{]*\{/g, '')
      .split('}')
      .map((r) => r.split('{')[0].trim())
      .filter(Boolean)
    for (const sel of rules.flatMap((r) => r.split(',').map((x) => x.trim()))) {
      if (sel === ':root' || sel === "[data-theme='dark']") continue
      expect(sel, sel).toMatch(/\.th-/)
    }
  })
})
