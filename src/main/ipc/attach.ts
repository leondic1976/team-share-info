import { app, BrowserWindow, dialog, net, shell } from 'electron'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import log from 'electron-log/main'
import { handle } from './registry'
import { headers } from '../transfer'
import { readCredential } from '../connection'
import { rememberSaveDir, saveDir, savePath } from '../save-dir'

/**
 * Files attached to messages, notices and posts: save to a place the user picks, or fetch
 * and open at once. The renderer never names a path: it gets a token for a file this
 * process saved in this session and asks to open or show that (13.8).
 */
const saved = new Map<string, string>()

/** Opening these runs code: they are saved, never started from here (9장: 실행 파일 경고). */
const RUNS_CODE = new Set(['.exe', '.msi', '.msix', '.bat', '.cmd', '.com', '.scr', '.pif', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.ps1', '.psm1', '.lnk', '.reg', '.hta', '.cpl', '.jar', '.dll', '.appx', '.gadget'])
export const runsCode = (name: string): boolean => RUNS_CODE.has(extname(name).toLowerCase())

const safeName = (n: string): string =>
  (
    [...n]
      .map((ch) => (ch < ' ' || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
      .join('')
      .replace(/[. ]+$/, '')
      .trim() || 'file'
  ).slice(0, 180)

/** "보고서.hwp" -> "보고서 (2).hwp" when the name is taken. */
function freeName(dir: string, name: string): string {
  const ext = extname(name)
  const stem = basename(name, ext)
  let p = join(dir, name)
  for (let i = 2; existsSync(p) && i < 1000; i++) p = join(dir, `${stem} (${i})${ext}`)
  return p
}

async function fetchTo(id: string, dest: string): Promise<void> {
  await fetchPathTo(`/api/attachments/${encodeURIComponent(id)}`, dest)
}

async function fetchPathTo(path: string, dest: string): Promise<void> {
  const c = readCredential()
  if (!c) throw new Error('서버에 연결되어 있지 않습니다.')
  const res = await net.fetch(`${c.serverUrl}${path}`, { headers: headers() })
  if (!res.ok || !res.body) {
    // the server's own message (e.g. 자료 취합: too large to bundle, not the requester)
    if (res.status === 413 || res.status === 403 || res.status === 409) {
      const msg = await (res.json() as Promise<{ error?: { message?: string } }>).then((j) => j.error?.message).catch(() => undefined)
      throw new Error(msg ?? `내려받지 못했습니다 (${res.status}).`)
    }
    // 410: a messenger file deleted from the server PC after its retention period; the server says so
    if (res.status === 410) {
      const msg = await (res.json() as Promise<{ error?: { message?: string } }>).then((j) => j.error?.message).catch(() => undefined)
      throw new Error(msg ?? '보관 기간이 지나 서버에서 삭제된 파일입니다.')
    }
    throw new Error(res.status === 404 ? '파일을 찾을 수 없습니다(지워졌거나 볼 수 없는 파일).' : `내려받지 못했습니다 (${res.status}).`)
  }
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  try {
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(part))
    rmSync(dest, { force: true })
    renameSync(part, dest)
  } catch (e) {
    rmSync(part, { force: true })
    throw e
  }
}

async function open(path: string): Promise<string | null> {
  if (process.env.TEAMHUB_E2E) {
    const g = globalThis as unknown as { __teamhubOpened?: string[] }
    ;(g.__teamhubOpened ??= []).push(path)
    return null
  }
  return (await shell.openPath(path)) || null
}

export function registerAttachIpc(): void {
  handle('attach:save', z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(260), open: z.boolean() }), async ({ id, name, open: openNow }, e) => {
    const file = safeName(name)
    let dest: string
    if (openNow || process.env.TEAMHUB_E2E) {
      // straight into the folder used last (Downloads at first, never a protected folder), under a name that is free
      const dir = process.env.TEAMHUB_E2E ? join(app.getPath('userData'), 'downloads') : saveDir()
      mkdirSync(dir, { recursive: true })
      dest = freeName(dir, file)
    } else {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
      const opts = { title: '저장할 위치', defaultPath: savePath(file) }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return { ok: false, canceled: true }
      dest = r.filePath
      rememberSaveDir(dest)
    }
    try {
      await fetchTo(id, dest)
    } catch (err) {
      log.warn('[attach] download failed', err)
      return { ok: false, error: (err as Error).message }
    }
    const token = randomUUID()
    saved.set(token, dest)
    const blocked = runsCode(dest)
    let opened = false
    let error: string | undefined
    if (openNow && !blocked) {
      const err = await open(dest)
      opened = !err
      if (err) error = `저장했지만 열지 못했습니다: ${err}`
    }
    return { ok: true, token, name: basename(dest), dir: dirname(dest), opened, blocked, error }
  })

  // 자료 취합: the requester saves the ZIP of everything handed in, or the 제출 현황 as CSV.
  // The renderer names only the request; the path on the server is made here (13.8).
  handle('collect:save', z.object({ id: z.string().min(1).max(100), kind: z.enum(['zip', 'csv']), name: z.string().min(1).max(260) }), async ({ id, kind, name }, e) => {
    const file = safeName(name)
    let dest: string
    if (process.env.TEAMHUB_E2E) {
      const dir = join(app.getPath('userData'), 'downloads')
      mkdirSync(dir, { recursive: true })
      dest = freeName(dir, file)
    } else {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
      const filters = kind === 'zip' ? [{ name: 'ZIP 압축 파일', extensions: ['zip'] }] : [{ name: 'CSV (엑셀)', extensions: ['csv'] }]
      const opts = { title: '저장할 위치', defaultPath: savePath(file), filters }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return { ok: false, canceled: true }
      dest = r.filePath
      rememberSaveDir(dest)
    }
    try {
      await fetchPathTo(`/api/collects/${encodeURIComponent(id)}/${kind}`, dest)
    } catch (err) {
      log.warn('[collect] download failed', err)
      return { ok: false, error: (err as Error).message }
    }
    const token = randomUUID()
    saved.set(token, dest)
    return { ok: true, token, name: basename(dest), dir: dirname(dest), opened: false, blocked: false }
  })

  handle('attach:open', z.object({ token: z.string().uuid() }), async ({ token }) => {
    const p = saved.get(token)
    if (!p || !existsSync(p)) return { ok: false, error: '파일이 그 자리에 없습니다. 다시 내려받으세요.' }
    if (runsCode(p)) return { ok: false, error: '실행 파일은 여기서 바로 열지 않습니다. 폴더를 열어 믿을 수 있는 파일인지 확인한 뒤 직접 실행하세요.' }
    const err = await open(p)
    return err ? { ok: false, error: err } : { ok: true }
  })

  handle('attach:reveal', z.object({ token: z.string().uuid() }), ({ token }) => {
    const p = saved.get(token)
    if (p && existsSync(p) && !process.env.TEAMHUB_E2E) shell.showItemInFolder(p)
  })
}
