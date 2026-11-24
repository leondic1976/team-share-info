import { app, BrowserWindow, dialog, net, protocol, shell } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import log from 'electron-log/main'
import { DOWNLOAD_SITE } from '../shared/constants'
import { compareVersions } from '../shared/semver'
import { fetchDownloadCounts, hitDownload, type CounterFetch } from '../shared/plugin-stats'
import { pluginBundleSchema, PLUGIN_ID_RE, type CatalogPlugin, type InstalledPlugin, type PluginBundle, type PluginManifest, type PluginPermission } from '../shared/schemas/plugins'
import { localDb } from './localdb'
import { localDataPath } from './storage'
import { PLUGIN_SDK } from './plugin-sdk'
import { resourcePath } from './paths'

/**
 * Plugins (확장 기능): install from the download site's catalog or from a .thplugin file,
 * always inside the app after the user confirms the permissions. Files are served to a
 * sandboxed frame through teamhub-plugin://<id>/… with a CSP that blocks network access.
 */
export const PLUGIN_SCHEME = 'teamhub-plugin'
const ALLOWED_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.woff', '.woff2', '.txt', '.md', '.mp3', '.wav'])
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}
const CSP = `default-src ${PLUGIN_SCHEME}:; script-src ${PLUGIN_SCHEME}: 'unsafe-inline'; style-src ${PLUGIN_SCHEME}: 'unsafe-inline'; img-src ${PLUGIN_SCHEME}: data: blob:; media-src ${PLUGIN_SCHEME}: data: blob:; font-src ${PLUGIN_SCHEME}: data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`

/**
 * Features of the app itself that run in the same isolated frame as plugins but ship in
 * resources/<folder> (no install, cannot be removed). 관리대장 used to be the "스마트 대장"
 * plugin with this id, so it keeps that id and its local data (kv keys plugin:ledger:*).
 */
export const BUILTIN_APPS: Record<string, string> = { ledger: 'ledger' }
const isBuiltinApp = (id: string): boolean => Object.hasOwn(BUILTIN_APPS, id)

const root = (): string => localDataPath('plugins')
const KV = 'plugins'

function registry(): Record<string, InstalledPlugin> {
  return localDb().kv.get<Record<string, InstalledPlugin>>(KV) ?? {}
}
function saveRegistry(r: Record<string, InstalledPlugin>): void {
  localDb().kv.set(KV, r)
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('plugins:changed', { count: Object.keys(r).length })
}

export const listPlugins = (): InstalledPlugin[] => Object.values(registry()).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, 'ko'))

/** Must run before app ready. */
export function registerPluginScheme(): void {
  // corsEnabled: fonts are always requested in CORS mode, and for a sandboxed frame (opaque
  // origin) even its own scheme is cross-origin. Only the font responses carry the allow header;
  // fetch stays off (supportFetchAPI false, connect-src 'none' in the CSP).
  protocol.registerSchemesAsPrivileged([{ scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true, stream: true } }])
}

/**
 * A plugin that became part of the app is taken out of the installed list. Its files go;
 * its local data stays, because the built-in feature keeps using it.
 */
function retireBuiltinPlugins(): void {
  const r = registry()
  const gone = Object.keys(r).filter(isBuiltinApp)
  if (!gone.length) return
  for (const id of gone) {
    rmSync(join(root(), id), { recursive: true, force: true })
    delete r[id]
    log.info(`[plugins] ${id} is now built in; removed the installed plugin and kept its data`)
  }
  saveRegistry(r)
}

export function servePlugins(): void {
  try {
    retireBuiltinPlugins()
  } catch (e) {
    log.warn('[plugins] could not retire built-in plugins', e)
  }
  try {
    refreshBuiltinPlugins()
  } catch (e) {
    log.warn('[plugins] could not refresh built-in plugins', e)
  }
  protocol.handle(PLUGIN_SCHEME, async (req) => {
    const u = new URL(req.url)
    const id = u.hostname
    const builtin = isBuiltinApp(id)
    const p = builtin ? undefined : registry()[id]
    if (!builtin && (!p || !p.enabled || !PLUGIN_ID_RE.test(id))) return new Response('not installed', { status: 404 })
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || (p ? p.manifest.entry : 'index.html')
    if (rel === '__sdk.js') return new Response(PLUGIN_SDK, { headers: { 'content-type': MIME['.js'], 'content-security-policy': CSP } })
    // the program's look, the same for every frame (resources/ui/base.css): the colours of the
    // main screen and the th-* component classes. A stylesheet needs no CORS header.
    if (rel === '__ui.css') {
      const f = join(resourcePath('ui'), 'base.css')
      const css = existsSync(f) ? await (await net.fetch(pathToFileURL(f).toString())).text() : ''
      return new Response(css, { headers: { 'content-type': MIME['.css'], 'content-security-policy': CSP, 'cache-control': 'no-cache' } })
    }
    // the program's fonts, the same for every frame (resources/fonts, scripts/build-fonts.mjs)
    if (rel === '__fonts.css' || /^__font\/[\w.-]+\.woff2$/.test(rel)) {
      const f = join(resourcePath('fonts'), rel === '__fonts.css' ? 'fonts.css' : rel.slice('__font/'.length))
      if (!existsSync(f)) return new Response(rel === '__fonts.css' ? '' : 'not found', { status: rel === '__fonts.css' ? 200 : 404, headers: { 'content-type': MIME['.css'] } })
      const r = await net.fetch(pathToFileURL(f).toString())
      // The frames are sandboxed (opaque origin), so a font request is cross-origin for them and
      // is refused without this header. The fonts are public files; nothing else is opened up.
      return new Response(r.body, { headers: { 'content-type': rel === '__fonts.css' ? MIME['.css'] : 'font/woff2', 'content-security-policy': CSP, 'cache-control': 'max-age=86400', 'access-control-allow-origin': '*' } })
    }
    const base = builtin ? resourcePath(BUILTIN_APPS[id]) : join(root(), id)
    const file = normalize(join(base, rel))
    if (!file.startsWith(base + '\\') || !ALLOWED_EXT.has(extname(file).toLowerCase()) || !existsSync(file)) return new Response('not found', { status: 404 })
    const res = await net.fetch(pathToFileURL(file).toString())
    return new Response(res.body, { headers: { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' } })
  })
}

function checkBundle(raw: unknown): PluginBundle {
  const b = pluginBundleSchema.parse(raw)
  if (compareVersions(app.getVersion(), b.manifest.minAppVersion) < 0) throw new Error(`TeamHub ${b.manifest.minAppVersion} 이상에서 쓸 수 있습니다. 먼저 TeamHub를 업데이트하세요.`)
  if (!b.files[b.manifest.entry]) throw new Error('시작 파일이 없습니다.')
  for (const f of Object.keys(b.files)) if (!ALLOWED_EXT.has(extname(f).toLowerCase())) throw new Error(`허용되지 않는 파일 형식: ${f}`)
  return b
}

function install(b: PluginBundle, source: InstalledPlugin['source']): PluginManifest {
  const id = b.manifest.id
  if (isBuiltinApp(id)) throw new Error('TeamHub에 기본으로 들어 있는 기능입니다. 왼쪽 메뉴에서 바로 쓸 수 있습니다.')
  const tmp = join(root(), `.${id}.${Date.now()}`)
  for (const [rel, data] of Object.entries(b.files)) {
    const f = normalize(join(tmp, rel))
    if (!f.startsWith(tmp + '\\')) throw new Error('잘못된 파일 경로')
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, Buffer.from(data, 'base64'))
  }
  writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(b.manifest, null, 2))
  const dest = join(root(), id)
  rmSync(dest, { recursive: true, force: true })
  renameSync(tmp, dest)
  const r = registry()
  r[id] = { manifest: b.manifest, installedAt: Date.now(), source, enabled: true }
  saveRegistry(r)
  log.info(`[plugins] installed ${id} ${b.manifest.version} (${source})`)
  return b.manifest
}

/** Plugins shipped inside the app (resources/plugins, packed by scripts/build-plugins.mjs): installable without a network. */
const builtinDir = (): string => join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', 'plugins')
function builtinCatalog(): CatalogPlugin[] {
  try {
    return (JSON.parse(readFileSync(join(builtinDir(), 'catalog.json'), 'utf8')) as CatalogPlugin[]).map((p) => ({ ...p, builtin: true }))
  } catch {
    return []
  }
}

async function fetchSiteCatalog(): Promise<CatalogPlugin[]> {
  // Chromium's network stack: follows the PC's proxy settings like the updater does
  const res = await net.fetch(`${DOWNLOAD_SITE}plugins/catalog.json`, { signal: AbortSignal.timeout(10000), cache: 'no-store' })
  if (!res.ok) throw new Error(`확장 기능 목록을 받지 못했습니다(${res.status}).`)
  return (await res.json()) as CatalogPlugin[]
}

/** What can be installed: the plugins shipped with the app, plus newer or additional ones on the download site. */
export async function fetchCatalog(): Promise<CatalogPlugin[]> {
  const byId = new Map(builtinCatalog().map((p) => [p.id, p]))
  try {
    for (const p of await fetchSiteCatalog()) {
      const have = byId.get(p.id)
      if (!have || compareVersions(p.version, have.version) > 0) byId.set(p.id, p)
    }
  } catch (e) {
    if (byId.size === 0) throw e
  }
  // an older download site may still list what is now part of the app
  return [...byId.values()].filter((p) => !isBuiltinApp(p.id)).sort((a, b) => a.name.localeCompare(b.name, 'ko'))
}

/**
 * Extensions shipped with the program follow the program: an installed one that is older than
 * the copy inside this version is replaced when the program starts (no internet, no question).
 * Otherwise an update of TeamHub would leave the old extension - with its old look - in place
 * until somebody pressed "update" by hand. On/off and the extension's data are kept.
 */
function refreshBuiltinPlugins(): void {
  const r = registry()
  for (const c of builtinCatalog()) {
    const have = r[c.id]
    if (!have || compareVersions(c.version, have.manifest.version) <= 0) continue
    try {
      const wasOn = have.enabled
      installBuiltin(c.id)
      if (!wasOn) setPluginEnabled(c.id, false)
      log.info(`[plugins] ${c.id} ${have.manifest.version} -> ${c.version} (shipped with this version)`)
    } catch (e) {
      log.warn(`[plugins] could not update ${c.id}`, e)
    }
  }
}

/** Install a plugin shipped with the app: no network, checked against its catalog hash. */
export function installBuiltin(id: string): PluginManifest {
  const entry = builtinCatalog().find((p) => p.id === id)
  if (!entry) throw new Error('기본 제공 확장 기능 목록에 없습니다.')
  const buf = readFileSync(join(builtinDir(), entry.file))
  if (createHash('sha256').update(buf).digest('hex') !== entry.sha256) throw new Error('확장 기능 파일이 손상되었습니다. TeamHub를 다시 설치하세요.')
  return install(checkBundle(JSON.parse(buf.toString('utf8'))), 'builtin')
}

/** Install from the download site; the file must match the catalog's SHA-256. */
export async function installFromCatalog(id: string): Promise<PluginManifest> {
  const entry = (await fetchCatalog()).find((p) => p.id === id)
  if (!entry) throw new Error('확장 기능 목록에 없습니다.')
  if (entry.builtin) return installBuiltin(id)
  const res = await net.fetch(`${DOWNLOAD_SITE}plugins/${encodeURIComponent(entry.file)}`, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error(`확장 기능을 받지 못했습니다(${res.status}).`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (createHash('sha256').update(buf).digest('hex') !== entry.sha256) throw new Error('받은 파일이 목록과 다릅니다(해시 불일치). 설치하지 않았습니다.')
  return install(checkBundle(JSON.parse(buf.toString('utf8'))), 'catalog')
}

// ---------- download counts of the gallery (optional, needs the internet) ----------
const counterFetch: CounterFetch = (url, init) => net.fetch(url, init)
const COUNTS_TTL = 5 * 60_000
let countsCache: { at: number; data: Record<string, number> } = { at: 0, data: {} }

/** Download counts by plugin id; empty when the counter cannot be reached (closed networks). */
export async function downloadCounts(ids: string[]): Promise<Record<string, number>> {
  const want = ids.filter((id) => PLUGIN_ID_RE.test(id))
  if (Date.now() - countsCache.at < COUNTS_TTL && want.every((id) => id in countsCache.data)) return countsCache.data
  const data = await fetchDownloadCounts(want, counterFetch)
  if (Object.keys(data).length) countsCache = { at: Date.now(), data: { ...countsCache.data, ...data } }
  return data
}

/**
 * Count an install from the gallery. Sends only the plugin's id, never waits and never
 * fails: the install is already done. Development and test runs do not count.
 */
export function countDownload(id: string): void {
  if (!app.isPackaged || !PLUGIN_ID_RE.test(id)) return
  void hitDownload(id, counterFetch).then((v) => {
    if (v !== null) countsCache.data[id] = v
  })
}

/** Read a .thplugin file and return its manifest for the confirmation dialog. */
export async function pickPluginFile(): Promise<{ ok: boolean; path?: string; manifest?: PluginManifest; error?: string }> {
  const r = await dialog.showOpenDialog({ title: '확장 기능 파일 열기', filters: [{ name: 'TeamHub 확장 기능', extensions: ['thplugin'] }], properties: ['openFile'] })
  if (r.canceled || !r.filePaths[0]) return { ok: false }
  return inspectFile(r.filePaths[0])
}
export function inspectFile(path: string): { ok: boolean; path?: string; manifest?: PluginManifest; error?: string } {
  try {
    return { ok: true, path, manifest: checkBundle(JSON.parse(readFileSync(path, 'utf8'))).manifest }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
export function installFromFile(path: string): PluginManifest {
  return install(checkBundle(JSON.parse(readFileSync(path, 'utf8'))), 'file')
}

// ---------- Copilot (permission 'copilot') ----------
/**
 * Open the Copilot that comes with Windows; where the app is not installed, its web page.
 * Only fixed addresses are opened: Copilot offers no supported way to hand it a question,
 * so the plugin copies the question and the user pastes it.
 */
export async function openCopilot(): Promise<{ ok: boolean; where?: 'app' | 'web'; error?: string }> {
  try {
    if (app.getApplicationNameForProtocol('ms-copilot:')) {
      await shell.openExternal('ms-copilot:')
      return { ok: true, where: 'app' }
    }
  } catch {
    // fall through to the web page
  }
  try {
    await shell.openExternal('https://copilot.microsoft.com/')
    return { ok: true, where: 'web' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------- files (permission 'files'): only through a dialog the user answers ----------
const FILE_EXT = ['csv', 'tsv', 'txt', 'json', 'md', 'html']
const MAX_FILE = 5 * 1024 * 1024
export const hasPluginPermission = (id: string, perm: PluginPermission): boolean => isBuiltinApp(id) || (!!registry()[id]?.enabled && !!registry()[id]?.manifest.permissions.includes(perm))
const hasFilesPermission = (id: string): boolean => hasPluginPermission(id, 'files')
const extOfName = (n: string): string => (/\.([a-z0-9]{1,5})$/i.exec(n)?.[1] ?? '').toLowerCase()

/** Save text a plugin made (e.g. CSV) where the user chooses. */
export async function pluginSaveFile(id: string, name: string, text: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!hasFilesPermission(id)) return { ok: false, error: '파일 권한이 없습니다.' }
  const safe = name.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120) || 'export.txt'
  const ext = extOfName(safe)
  if (!FILE_EXT.includes(ext)) return { ok: false, error: `저장할 수 없는 파일 형식입니다(.${ext || '?'}).` }
  if (text.length > MAX_FILE) return { ok: false, error: '파일이 너무 큽니다(5MB).' }
  const win = BrowserWindow.getFocusedWindow() ?? undefined
  const opts = { title: '파일로 저장', defaultPath: join(app.getPath('documents'), safe), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] }
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (r.canceled || !r.filePath) return { ok: false }
  const path = extOfName(r.filePath) === ext ? r.filePath : `${r.filePath}.${ext}`
  writeFileSync(path, text, 'utf8')
  log.info(`plugin ${id} saved a file: ${path}`)
  return { ok: true, path }
}

/** Open a text file the user chooses and give its content to the plugin. */
export async function pluginOpenFile(id: string, exts: string[]): Promise<{ ok: boolean; name?: string; text?: string; error?: string }> {
  if (!hasFilesPermission(id)) return { ok: false, error: '파일 권한이 없습니다.' }
  const allowed = exts.map((e) => e.toLowerCase()).filter((e) => FILE_EXT.includes(e))
  const win = BrowserWindow.getFocusedWindow() ?? undefined
  const opts = { title: '파일 열기', filters: [{ name: allowed.map((e) => e.toUpperCase()).join(', ') || '텍스트', extensions: allowed.length ? allowed : FILE_EXT }], properties: ['openFile' as const] }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  const p = r.canceled ? undefined : r.filePaths[0]
  if (!p) return { ok: false }
  if (!FILE_EXT.includes(extOfName(p))) return { ok: false, error: '열 수 없는 파일 형식입니다.' }
  const buf = readFileSync(p)
  if (buf.length > MAX_FILE) return { ok: false, error: '파일이 너무 큽니다(5MB).' }
  return { ok: true, name: p.split(/[\\/]/).pop(), text: decodeText(buf) }
}
/** UTF-8 (with or without BOM); Excel's Korean CSV (CP949/EUC-KR) when UTF-8 does not fit. */
function decodeText(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '')
  } catch {
    return new TextDecoder('euc-kr').decode(buf)
  }
}

export function uninstallPlugin(id: string): void {
  if (!PLUGIN_ID_RE.test(id) || isBuiltinApp(id)) return
  rmSync(join(root(), id), { recursive: true, force: true })
  const r = registry()
  delete r[id]
  saveRegistry(r)
  // the plugin's local data goes too
  localDb().db.run(`DELETE FROM kv WHERE key LIKE ?`, [`plugin:${id}:%`])
}

export function setPluginEnabled(id: string, enabled: boolean): void {
  const r = registry()
  if (!r[id]) return
  r[id].enabled = enabled
  saveRegistry(r)
}

// ---------- teamhub:// links from the download site (install happens in the app) ----------
export const APP_SCHEME = 'teamhub'
export function linkToRoute(argv: string[]): string | null {
  const link = argv.find((a) => a.startsWith(`${APP_SCHEME}://`))
  if (!link) return null
  try {
    const u = new URL(link)
    const id = u.searchParams.get('id') ?? ''
    if (u.hostname === 'plugins' && u.pathname.startsWith('/install') && PLUGIN_ID_RE.test(id)) return `/plugins?install=${id}`
  } catch {
    // ignore malformed links
  }
  return null
}
