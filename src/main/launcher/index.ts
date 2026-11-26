import { app, BrowserWindow, globalShortcut, screen, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import log from 'electron-log/main'
import { KNOWN_APPS, SYSTEM_APPS, isDocPath, isSafeTeamTarget, matchKnownApps, type DetectedApp, type LauncherItemDto, type RecentDocDto, type TeamLauncherDto } from '../../shared/schemas/launcher'
import { localDb } from '../localdb'
import { arr, runPsJson } from '../sysutil/ps'
import { baseUrl, headers } from '../transfer'
import { loadRenderer, secureWebContents } from '../windows/main-window'
import { resourcePath } from '../paths'

/** Program launcher (6.13): detection, personal/team items, templates, recent documents. */

const DETECT_PS = `
$ap=@(); foreach($r in 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths'){
  Get-ChildItem -LiteralPath $r | ForEach-Object { $v=$_.GetValue(''); if($v){ $ap+=@{name=$_.PSChildName; path=([Environment]::ExpandEnvironmentVariables([string]$v)).Trim().Trim('"')} } } }
$as=@{}; foreach($e in '.hwp','.xlsx','.docx','.pptx','.pdf'){ $p=(Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\\$e").'(default)'; if($p){ $c=(Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\\$p\\shell\\open\\command").'(default)'; if($c){ $as[$e]=[string]$c } } }
@{appPaths=$ap; assoc=$as} | ConvertTo-Json -Depth 4 -Compress`

function startMenuDirs(): string[] {
  return [join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')]
}

async function walkLnk(dir: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 4 || out.length > 2000) return out
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walkLnk(p, depth + 1, out)
    else if (e.name.toLowerCase().endsWith('.lnk')) out.push(p)
  }
  return out
}

const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Start menu programs: shortcut name and resolved target (.exe only). Yields so the main process stays responsive. */
let startMenuCache: { at: number; list: { name: string; target: string }[] } | null = null
export async function startMenuPrograms(): Promise<{ name: string; target: string }[]> {
  if (startMenuCache && Date.now() - startMenuCache.at < 60_000) return startMenuCache.list
  const seen = new Set<string>()
  const out: { name: string; target: string }[] = []
  let n = 0
  for (const dir of startMenuDirs()) {
    for (const lnk of await walkLnk(dir)) {
      if (++n % 20 === 0) await yieldLoop()
      try {
        const t = shell.readShortcutLink(lnk).target
        if (!t || !t.toLowerCase().endsWith('.exe') || /uninst|unins\d|setup|update/i.test(basename(t))) continue
        const key = t.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ name: basename(lnk, '.lnk'), target: t })
      } catch {
        // broken shortcut
      }
    }
  }
  const list = out.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  startMenuCache = { at: Date.now(), list }
  return list
}

export async function detectPrograms(): Promise<DetectedApp[]> {
  const raw = await runPsJson<{ appPaths: { name: string; path: string }[] | { name: string; path: string }; assoc: Record<string, string> }>('detect programs', DETECT_PS, 30000)
  const found = matchKnownApps(arr(raw?.appPaths), await startMenuPrograms(), raw?.assoc ?? {}, existsSync)
  const win = process.env.SystemRoot ?? 'C:\\Windows'
  for (const s of SYSTEM_APPS) {
    const p = [join(win, s.file), join(win, 'System32', s.file)].find(existsSync)
    if (p) found.push({ key: s.key, name: s.name, path: p, group: '도구' })
  }
  log.info(`[launcher] detected ${found.map((f) => f.key).join(', ')}`)
  return found
}

/** Register detected programs once (and again on "다시 찾기"). */
export async function autoRegister(force = false): Promise<{ added: number; found: DetectedApp[] }> {
  const kv = localDb().kv
  if (!force && kv.get<number>('launcher.detectedAt')) return { added: 0, found: [] }
  const found = await detectPrograms()
  const added = localDb().launcher.addDetected(found)
  kv.set('launcher.detectedAt', Date.now())
  return { added, found }
}

const icons = new Map<string, string | null>()
export async function iconFor(path: string): Promise<string | null> {
  if (icons.has(path)) return icons.get(path) ?? null
  let url: string | null = null
  try {
    if (/^[a-zA-Z]:\\|^\\\\/.test(path) && existsSync(path)) url = (await app.getFileIcon(path, { size: 'normal' })).toDataURL()
  } catch {
    url = null
  }
  icons.set(path, url)
  return url
}

function splitArgs(s: string): string[] {
  return [...s.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2])
}

/** E2E records what would be opened instead of starting programs on the test PC. */
function e2eOpened(target: string): boolean {
  if (!process.env.TEAMHUB_E2E) return false
  const g = globalThis as unknown as { __teamhubOpened?: string[] }
  ;(g.__teamhubOpened ??= []).push(target)
  return true
}

async function openExternal(url: string): Promise<void> {
  if (!e2eOpened(url)) await shell.openExternal(url)
}

async function openPath(p: string): Promise<string | null> {
  const err = e2eOpened(p) ? '' : await shell.openPath(p)
  if (err) return err
  if (isDocPath(p)) localDb().launcher.touchRecent(p)
  return null
}

/** Run a personal item from the local DB (only items the user registered). */
export async function runPersonal(id: string): Promise<string | null> {
  const it: LauncherItemDto | null = localDb().launcher.get(id)
  if (!it) return '항목을 찾을 수 없습니다.'
  if (it.kind === 'url') {
    if (!/^(https?:|mailto:)/i.test(it.target)) return '웹 주소만 열 수 있습니다.'
    await openExternal(it.target)
    return null
  }
  if (!existsSync(it.target)) return '파일이나 폴더가 없습니다. 위치가 바뀌었으면 항목을 고치세요.'
  if (it.kind === 'app' && it.args.trim() && !e2eOpened(it.target)) {
    try {
      // the program and arguments the person registered, as an argument list (no shell)
      log.info(`[launcher] run ${it.target}`)
      spawn(it.target, splitArgs(it.args), { detached: true, stdio: 'ignore', windowsHide: false }).unref()
      return null
    } catch (e) {
      return (e as Error).message
    }
  }
  return openPath(it.target)
}

/**
 * Template copies live in TeamHub's own folder, never in Documents: a program writing into
 * Documents on its own is what Windows ransomware protection reports (CLAUDE.md rules). The
 * person keeps a copy elsewhere with "다른 이름으로 저장" in Hangul/Office. Copies made by earlier
 * versions stay in Documents\TeamHub 양식 untouched.
 */
export const TEMPLATE_DIR = (): string => join(app.getPath('userData'), 'TeamHub 양식')

/** Team items from the server: web addresses, shared folders/documents, templates (copy then open). */
export async function runTeam(item: TeamLauncherDto): Promise<string | null> {
  if (item.kind === 'template') {
    if (!item.attachmentId || !item.fileName) return '양식 파일이 없습니다.'
    const res = await fetch(new URL(`/api/attachments/${item.attachmentId}`, baseUrl()), { headers: headers() })
    if (!res.ok) return `양식을 받지 못했습니다 (${res.status}).`
    const dir = TEMPLATE_DIR()
    mkdirSync(dir, { recursive: true })
    const ext = extname(item.fileName)
    const stem = basename(item.fileName, ext)
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    let dest = join(dir, `${stem}_${stamp}${ext}`)
    for (let n = 2; existsSync(dest); n++) dest = join(dir, `${stem}_${stamp}(${n})${ext}`)
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
    return openPath(dest)
  }
  // Values from the server are checked again here: no executables, only http(s).
  if (!isSafeTeamTarget(item.kind, item.target)) return '열 수 없는 항목입니다.'
  if (item.kind === 'url') {
    await openExternal(item.target)
    return null
  }
  return openPath(item.target)
}

/** Recent documents: Windows "Recent" shortcuts + documents opened from TeamHub, pins first. */
export function recentDocs(): RecentDocDto[] {
  const repo = localDb().launcher
  const mine = repo.recent()
  const pinned = new Set(mine.filter((m) => m.pinned).map((m) => m.path.toLowerCase()))
  const map = new Map<string, RecentDocDto>()
  for (const m of mine) if (existsSync(m.path)) map.set(m.path.toLowerCase(), { path: m.path, name: basename(m.path), openedAt: m.openedAt, pinned: m.pinned })
  const dir = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Recent')
  try {
    const lnks = readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.lnk'))
      .map((n) => {
        const p = join(dir, n)
        try {
          return { p, t: statSync(p).mtimeMs }
        } catch {
          return { p, t: 0 }
        }
      })
      .sort((a, b) => b.t - a.t)
      .slice(0, 80)
    for (const l of lnks) {
      try {
        const target = shell.readShortcutLink(l.p).target
        if (!target || !isDocPath(target) || !existsSync(target)) continue
        const k = target.toLowerCase()
        const cur = map.get(k)
        if (!cur || cur.openedAt < l.t) map.set(k, { path: target, name: basename(target), openedAt: l.t, pinned: pinned.has(k) })
      } catch {
        // unreadable shortcut
      }
    }
  } catch {
    // no Recent folder
  }
  return [...map.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.openedAt - a.openedAt).slice(0, 50)
}

export async function openRecent(path: string): Promise<string | null> {
  if (!isDocPath(path)) return '문서만 열 수 있습니다.'
  if (!existsSync(path)) return '파일이 없습니다.'
  return openPath(path)
}

// ---------- quick launcher window (Ctrl+Alt+Space) ----------
export const LAUNCHER_SHORTCUT = 'CommandOrControl+Alt+Space'
let bar: BrowserWindow | null = null

export function openLauncherBar(): void {
  if (bar && !bar.isDestroyed()) {
    bar.show()
    bar.focus()
    return
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  bar = new BrowserWindow({
    width: 560,
    height: 420,
    x: Math.round(area.x + (area.width - 560) / 2),
    y: Math.round(area.y + area.height / 5),
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    icon: resourcePath('icon.png'),
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  bar.setMenu(null)
  secureWebContents(bar)
  loadRenderer(bar, '/popup/launcher')
  bar.once('ready-to-show', () => {
    bar?.show()
    bar?.focus()
  })
  // Close when it loses focus, like a search box.
  bar.on('blur', () => {
    if (!process.env.TEAMHUB_E2E) bar?.close()
  })
  bar.on('closed', () => (bar = null))
}

export function startLauncher(): void {
  try {
    if (!globalShortcut.register(LAUNCHER_SHORTCUT, openLauncherBar)) log.warn(`[launcher] shortcut ${LAUNCHER_SHORTCUT} is taken`)
  } catch (e) {
    log.warn('[launcher] shortcut failed', e)
  }
  // First run: register Hangul/Office/browsers found on this PC (6.13 자동 감지).
  setTimeout(
    () =>
      void autoRegister(false)
        .then((r) => {
          if (r.added) for (const w of BrowserWindow.getAllWindows()) w.webContents.send('launcher:changed', { count: r.added })
        })
        .catch((e: unknown) => log.warn('[launcher] detect failed', e)),
    5000
  )
}

export const KNOWN_APP_KEYS = KNOWN_APPS.map((k) => k.key)
