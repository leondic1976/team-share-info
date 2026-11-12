import { app, BrowserWindow, dialog, net, protocol } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import log from 'electron-log/main'
import { DOWNLOAD_SITE } from '../shared/constants'
import { compareVersions } from '../shared/semver'
import { pluginBundleSchema, PLUGIN_ID_RE, type CatalogPlugin, type InstalledPlugin, type PluginBundle, type PluginManifest } from '../shared/schemas/plugins'
import { localDb } from './localdb'
import { userDataPath } from './paths'
import { PLUGIN_SDK } from './plugin-sdk'

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

const root = (): string => userDataPath('plugins')
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
  protocol.registerSchemesAsPrivileged([{ scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: true } }])
}

export function servePlugins(): void {
  protocol.handle(PLUGIN_SCHEME, async (req) => {
    const u = new URL(req.url)
    const id = u.hostname
    const p = registry()[id]
    if (!p || !p.enabled || !PLUGIN_ID_RE.test(id)) return new Response('not installed', { status: 404 })
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || p.manifest.entry
    if (rel === '__sdk.js') return new Response(PLUGIN_SDK, { headers: { 'content-type': MIME['.js'], 'content-security-policy': CSP } })
    const base = join(root(), id)
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

export async function fetchCatalog(): Promise<CatalogPlugin[]> {
  const res = await fetch(`${DOWNLOAD_SITE}plugins/catalog.json`, { signal: AbortSignal.timeout(10000), cache: 'no-store' })
  if (!res.ok) throw new Error(`확장 기능 목록을 받지 못했습니다(${res.status}).`)
  return (await res.json()) as CatalogPlugin[]
}

/** Install from the download site; the file must match the catalog's SHA-256. */
export async function installFromCatalog(id: string): Promise<PluginManifest> {
  const entry = (await fetchCatalog()).find((p) => p.id === id)
  if (!entry) throw new Error('확장 기능 목록에 없습니다.')
  const res = await fetch(`${DOWNLOAD_SITE}plugins/${encodeURIComponent(entry.file)}`, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error(`확장 기능을 받지 못했습니다(${res.status}).`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (createHash('sha256').update(buf).digest('hex') !== entry.sha256) throw new Error('받은 파일이 목록과 다릅니다(해시 불일치). 설치하지 않았습니다.')
  return install(checkBundle(JSON.parse(buf.toString('utf8'))), 'catalog')
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

export function uninstallPlugin(id: string): void {
  if (!PLUGIN_ID_RE.test(id)) return
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
