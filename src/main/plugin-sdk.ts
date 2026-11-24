import { ICONS, LEGACY_ICON_NAMES } from '@shared/icons'

/**
 * Script served to plugins as teamhub-plugin://<id>/__sdk.js.
 *   const me = await TeamHub.call('me')
 *   TeamHub.on('room.changed', ({ roomId }) => …)
 * Calls go to the TeamHub window through postMessage; only declared permissions work.
 *   el.innerHTML = TeamHub.icon('utensils') + ' 식사'      // line icon as SVG markup (no emoji in the program)
 *   <i data-icon="search"></i>                          // in HTML: replaced by the icon when the page loads
 * It also links the program's look (__ui.css) and fonts (__fonts.css) into the frame.
 */
export const PLUGIN_SDK = `(() => {
  const ICONS = ${JSON.stringify(ICONS)}
  const LEGACY = ${JSON.stringify(LEGACY_ICON_NAMES)}
  let seq = 0
  const waiting = new Map()
  const handlers = new Map()
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return
    const m = e.data
    if (!m || m.th !== 1) return
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id)
      waiting.delete(m.id)
      m.error ? w.reject(Object.assign(new Error(m.error), { code: m.code || '' })) : w.resolve(m.result)
    } else if (m.event) {
      for (const cb of handlers.get(m.event) || []) { try { cb(m.data) } catch (err) { console.error(err) } }
    }
  })
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = 'c' + (++seq)
    waiting.set(id, { resolve, reject })
    window.parent.postMessage({ th: 1, id, method, params: params ?? null }, '*')
  })
  const on = (event, cb) => {
    if (!handlers.has(event)) handlers.set(event, new Set())
    handlers.get(event).add(cb)
    return () => handlers.get(event).delete(cb)
  }
  const params = new URLSearchParams(location.search)
  // Line icons shared by every frame (same table as the program: src/shared/icons.json).
  // An unknown name, or an emoji stored by an older version, becomes the fallback icon.
  const iconName = (name, fallback) => {
    if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(ICONS, name)) return name
    const old = typeof name === 'string' ? LEGACY[name.replace(/️/g, '')] : undefined
    if (old) return old
    return typeof fallback === 'string' && Object.prototype.hasOwnProperty.call(ICONS, fallback) ? fallback : 'puzzle'
  }
  const attr = (s) => String(s).replace(/[&<>"']/g, (ch) => '&#' + ch.charCodeAt(0) + ';')
  const icon = (name, opts) => {
    const o = opts || {}
    const size = Number(o.size) > 0 ? ' width="' + Number(o.size) + '" height="' + Number(o.size) + '" style="width:' + Number(o.size) + 'px;height:' + Number(o.size) + 'px"' : ''
    const a11y = o.label ? ' role="img" aria-label="' + attr(o.label) + '"' : ' aria-hidden="true"'
    return '<svg class="th-icon' + (o.fill ? ' th-fill' : '') + (o.cls ? ' ' + attr(o.cls) : '') + '"' + size + a11y + ' viewBox="0 0 24 24" fill="' + (o.fill ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[iconName(name, o.fallback)] + '</svg>'
  }
  /** Replace every <i data-icon="name" [data-size] [data-fill]> under root with its icon. */
  const hydrateIcons = (root) => {
    for (const el of (root || document).querySelectorAll('i[data-icon]')) {
      el.outerHTML = icon(el.dataset.icon, { size: el.dataset.size, fill: el.dataset.fill !== undefined, cls: el.className, label: el.getAttribute('aria-label') || '' })
    }
  }
  window.TeamHub = { call, on, room: params.get('room'), theme: params.get('theme') || 'light', icon, iconName, hydrateIcons, icons: Object.keys(ICONS) }
  const iconCss = document.createElement('style')
  iconCss.textContent = 'svg.th-icon{display:inline-block;width:1.15em;height:1.15em;vertical-align:-0.2em;flex:none}'
  document.head.appendChild(iconCss)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => hydrateIcons())
  else hydrateIcons()
  document.documentElement.dataset.theme = window.TeamHub.theme
  // TeamHub's look (resources/ui/base.css: the colours of the main screen and the th-* classes),
  // put before the extension's own styles so the extension can override it
  const ui = document.createElement('link')
  ui.rel = 'stylesheet'
  ui.href = '__ui.css'
  ui.setAttribute('blocking', 'render')
  document.head.insertBefore(ui, document.head.firstChild)
  // TeamHub's fonts (served by the program to every frame); after the extension's own styles so they apply
  const addFonts = () => {
    const l = document.createElement('link')
    l.rel = 'stylesheet'
    l.href = '__fonts.css'
    document.head.appendChild(l)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addFonts)
  else addFonts()
})()
`
