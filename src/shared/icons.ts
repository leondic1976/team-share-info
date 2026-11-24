import DATA from './icons.json'

/**
 * The program's icon whitelist outside React: name -> inner SVG markup (24x24 line icons,
 * path data from lucide, ISC licence; "ladder" is drawn here in the same style).
 * One table for extension manifests ("iconName"), the SDK served to extension frames
 * (TeamHub.icon), note/ledger icons, the download site's catalog and the icon wallpapers.
 * No emoji anywhere: a value that is not in this table is shown as the fallback icon.
 */
export const ICONS: Readonly<Record<string, string>> = DATA

export const DEFAULT_ICON = 'puzzle'

export const isIconName = (name: unknown): name is string => typeof name === 'string' && Object.prototype.hasOwnProperty.call(ICONS, name)

/**
 * Icons that older versions stored as emoji (note icons, ledger template icons). Written as
 * code points so that no emoji is typed in the source; used only to keep a meaningful icon
 * for data saved before icons had names.
 */
const LEGACY: Readonly<Record<string, string>> = {
  '\u{1F4C4}': 'file-text',
  '\u{1F4DD}': 'notebook-pen',
  '\u{1F4DA}': 'library',
  '\u{1F4C1}': 'folder',
  '\u{1F5D3}': 'calendar-days',
  '\u{2705}': 'circle-check',
  '\u{1F4A1}': 'lightbulb',
  '\u{1F4CC}': 'pin',
  '\u{2B50}': 'star',
  '\u{1F516}': 'bookmark',
  '\u{1F4CA}': 'chart-column',
  '\u{1F9ED}': 'compass',
  '\u{1F6E0}': 'wrench',
  '\u{1F4DE}': 'phone',
  '\u{1F3E2}': 'building-2',
  '\u{1F3AF}': 'target',
  '\u{1F4BC}': 'briefcase',
  '\u{1F512}': 'lock',
  '\u{1F4CE}': 'paperclip',
  '\u{1F9FE}': 'receipt',
  '\u{1F5C3}': 'database',
  '\u{1F4E6}': 'package',
  '\u{1F4E8}': 'inbox',
  '\u{1F4B0}': 'coins',
  '\u{1F697}': 'car',
  '\u{1F511}': 'key-round',
  '\u{1F9F3}': 'luggage',
  '\u{1F393}': 'graduation-cap',
  '\u{1F4D2}': 'notebook-tabs'
}

/** A stored icon value (a name, or an emoji from an older version) -> a name of the table. */
export function resolveIconName(value: unknown, fallback: string = DEFAULT_ICON): string {
  if (isIconName(value)) return value
  if (typeof value === 'string' && value) {
    const legacy = LEGACY[value.replace(/\u{FE0F}/gu, '')]
    if (legacy) return legacy
  }
  return isIconName(fallback) ? fallback : DEFAULT_ICON
}

export const LEGACY_ICON_NAMES = LEGACY

/** Complete <svg> markup of an icon (stroke currentColor unless a colour is given). */
export function iconSvg(name: unknown, opts: { size?: number; fallback?: string; stroke?: string; attrs?: string } = {}): string {
  const n = resolveIconName(name, opts.fallback)
  const s = opts.size ?? 24
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}' viewBox='0 0 24 24' fill='none' stroke='${opts.stroke ?? 'currentColor'}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'${opts.attrs ? ` ${opts.attrs}` : ''}>${ICONS[n]}</svg>`
}
