import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The program shows no emoji: icons are line icons (lucide in the renderer, the shared
 * table `src/shared/icons.json` everywhere else). This runs the scanner of
 * `scripts/check-emoji.mjs` over everything a user can see: the app sources, the extensions,
 * the ledger frame, the download site and the manual.
 */

interface Hit {
  file: string
  line: number
  chars: string[]
  text: string
}
interface Scanner {
  scanEmoji: (o?: { root?: string; dirs?: string[]; symbols?: boolean }) => Hit[]
  EMOJI_RE: RegExp
  SCAN_DIRS: string[]
  EMOJI_FILES: string[]
}

const root = resolve(__dirname, '..', '..')
const load = async (): Promise<Scanner> => (await import(/* @vite-ignore */ pathToFileURL(join(root, 'scripts', 'check-emoji.mjs')).href)) as Scanner

/**
 * The only places where an emoji may stay in the scanned folders.
 * - Applied migrations are never edited (CLAUDE.md): two old `DEFAULT` values of an `icon`
 *   column are an emoji. The code always writes an icon name, and a stored emoji is mapped
 *   to its line icon when shown (`resolveIconName`), so these are never displayed.
 */
const ALLOWED: { file: string; pattern: RegExp; why: string }[] = [
  { file: 'src/main/localdb/migrations.ts', pattern: /^icon TEXT NOT NULL DEFAULT '.{1,2}',$/u, why: 'applied migration (local ledgers.icon default)' },
  { file: 'src/server/db/migrations.ts', pattern: /^icon TEXT NOT NULL DEFAULT '.{1,2}',$/u, why: 'applied migration (server ledgers.icon default)' }
]

describe('no emoji in the program', () => {
  it('scans the folders a user can see', async () => {
    const s = await load()
    expect(s.SCAN_DIRS).toEqual(['src', 'plugins', 'resources/ledger', 'site', 'docs/manual'])
  })

  it('recognises emoji and leaves plain typography alone', async () => {
    const { EMOJI_RE } = await load()
    // Only code points every Unicode version calls pictographic: the property of symbols such as
    // the star or the pencil differs between the ICU builds of Node releases (it failed on CI).
    for (const cp of [0x1f4c4, 0x1f512, 0x1f4cc, 0x1f465, 0x2705]) expect(EMOJI_RE.test(String.fromCodePoint(cp))).toBe(true)
    // arrows, sort triangles, bullets, the multiplication sign and (c) (r) TM are text
    for (const cp of [0x2192, 0x2190, 0x25b2, 0x25bc, 0x25cf, 0x25cb, 0x00d7, 0x00a9, 0x00ae, 0x2122]) expect(EMOJI_RE.test(String.fromCodePoint(cp))).toBe(false)
  })

  it('has no emoji in sources, extensions, the site or the manual', async () => {
    const { scanEmoji } = await load()
    const hits = scanEmoji().filter((h) => !ALLOWED.some((a) => a.file === h.file && a.pattern.test(h.text)))
    expect(hits.map((h) => `${h.file}:${h.line}: ${h.chars.join(' ')}`)).toEqual([])
  })

  it('leaves out only the messenger emoticon set (user decision 2026-11-25), which does hold emoji', async () => {
    const { EMOJI_FILES, EMOJI_RE } = await load()
    expect(EMOJI_FILES).toEqual(['src/renderer/features/chat/emoticons.ts'])
    expect(EMOJI_RE.test(readFileSync(join(root, EMOJI_FILES[0]!), 'utf8'))).toBe(true)
  })

  it('keeps the allowlist tight: every entry is still needed, once', async () => {
    const { scanEmoji } = await load()
    const hits = scanEmoji()
    for (const a of ALLOWED) expect(hits.filter((h) => h.file === a.file && a.pattern.test(h.text)).length, a.why).toBe(1)
  })
})
