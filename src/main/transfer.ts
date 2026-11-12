import { app, BrowserWindow, shell } from 'electron'
import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import log from 'electron-log/main'
import { PROTOCOL_VERSION } from '../shared/constants'
import type { TransferItem } from '../shared/ipc'
import { readCredential } from './connection'
import { localDb } from './localdb'
import { winUser } from './ipc/app'

/**
 * File transfers run in the main process (M4-2): uploads are sent in 8MB chunks
 * and resume after an app restart (the server keeps the received offset);
 * downloads resume with HTTP Range. Progress is pushed to all windows.
 */
const KV_KEY = 'transfers'
let items: TransferItem[] = []
let running = false
const aborts = new Map<string, AbortController>()

function persist(): void {
  localDb().kv.set(
    KV_KEY,
    items.filter((i) => i.direction === 'up' && (i.status === 'queued' || i.status === 'running' || i.status === 'paused'))
  )
}

function emit(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('transfer:update', items)
}

function update(id: string, patch: Partial<TransferItem>): void {
  items = items.map((i) => (i.id === id ? { ...i, ...patch } : i))
  emit()
}

export function headers(extra: Record<string, string> = {}): Record<string, string> {
  const c = readCredential()
  if (!c) throw new Error('서버에 연결되어 있지 않습니다.')
  return {
    Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`,
    'X-Win-User': encodeURIComponent(winUser()),
    'X-Protocol': String(PROTOCOL_VERSION),
    'X-App-Version': app.getVersion(),
    ...extra
  }
}

export function baseUrl(): string {
  const c = readCredential()
  if (!c) throw new Error('서버에 연결되어 있지 않습니다.')
  return c.serverUrl
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(new URL(path, baseUrl()), { ...init, headers: { ...headers(), ...(init.headers as Record<string, string>) } })
  const text = await res.text()
  let json: { data?: T; error?: { code: string; message: string } } = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    // ignore
  }
  if (!res.ok) {
    const err = new Error(json.error?.message ?? `HTTP ${res.status}`) as Error & { status?: number; code?: string }
    err.status = res.status
    err.code = json.error?.code
    throw err
  }
  return json.data as T
}

export function listTransfers(): TransferItem[] {
  return items
}

/** Queue local files (and folders, recursively) for upload into a server folder. */
export async function enqueueUploads(paths: string[], folderId: string, opts: { fileId?: string; note?: string } = {}): Promise<number> {
  let count = 0
  const add = (path: string, targetFolder: string): void => {
    const st = statSync(path)
    items.push({
      id: crypto.randomUUID(),
      direction: 'up',
      name: basename(path),
      path,
      size: st.size,
      mtimeMs: st.mtimeMs,
      folderId: targetFolder,
      fileId: opts.fileId,
      note: opts.note,
      done: 0,
      status: 'queued',
      createdAt: Date.now()
    })
    count++
  }
  for (const p of paths) {
    if (!existsSync(p)) continue
    if (statSync(p).isDirectory()) await enqueueFolder(p, folderId, add)
    else add(p, folderId)
  }
  persist()
  emit()
  void pump()
  return count
}

/** Recreate the local folder tree on the server, then queue its files. */
async function enqueueFolder(dir: string, parentId: string, add: (p: string, f: string) => void): Promise<void> {
  let folder: { id: string }
  try {
    folder = await call<{ id: string }>('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentId, name: basename(dir) }) })
  } catch (e) {
    // Folder already exists: reuse it.
    const view = await call<{ folders: { id: string; name: string }[] }>(`/api/files/view?folderId=${parentId}`)
    const found = view.folders.find((f) => f.name === basename(dir))
    if (!found) throw e
    folder = found
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) await enqueueFolder(p, folder.id, add)
    else if (entry.isFile()) add(p, folder.id)
  }
}

async function pump(): Promise<void> {
  if (running) return
  running = true
  try {
    for (;;) {
      const next = items.find((i) => i.status === 'queued')
      if (!next) break
      if (next.direction === 'up') await runUpload(next)
    }
  } finally {
    running = false
  }
}

async function runUpload(item: TransferItem): Promise<void> {
  const ac = new AbortController()
  aborts.set(item.id, ac)
  update(item.id, { status: 'running', error: undefined })
  try {
    if (!existsSync(item.path!)) throw new Error('원본 파일을 찾을 수 없습니다.')
    const st = statSync(item.path!)
    if (st.size !== item.size || Math.abs(st.mtimeMs - (item.mtimeMs ?? st.mtimeMs)) > 2000) {
      // File changed while waiting: restart from scratch with the new content.
      item.uploadId = undefined
      update(item.id, { size: st.size, mtimeMs: st.mtimeMs, uploadId: undefined, done: 0 })
    }
    let uploadId = items.find((i) => i.id === item.id)!.uploadId
    let offset = 0
    let chunkSize = 8 * 1024 * 1024
    if (uploadId) {
      try {
        const s = await call<{ received: number; chunkSize: number }>(`/api/uploads/${uploadId}`)
        offset = s.received
        chunkSize = s.chunkSize
      } catch {
        uploadId = undefined
      }
    }
    if (!uploadId) {
      const s = await call<{ id: string; received: number; chunkSize: number }>('/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: item.name, size: st.size, folderId: item.folderId, fileId: item.fileId, note: item.note ?? '' })
      })
      uploadId = s.id
      chunkSize = s.chunkSize
      offset = 0
      update(item.id, { uploadId })
      persist()
    }
    const fd = openSync(item.path!, 'r')
    try {
      const buf = Buffer.alloc(chunkSize)
      while (offset < st.size) {
        if (ac.signal.aborted) throw new Error('aborted')
        const n = readSync(fd, buf, 0, Math.min(chunkSize, st.size - offset), offset)
        const r = await call<{ received: number }>(`/api/uploads/${uploadId}?offset=${offset}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf.subarray(0, n),
          signal: ac.signal
        })
        offset = r.received
        update(item.id, { done: offset })
      }
    } finally {
      closeSync(fd)
    }
    const res = await call<{ file: { id: string }; newVersion: boolean }>(`/api/uploads/${uploadId}/complete`, { method: 'POST' })
    update(item.id, { status: 'done', done: st.size, fileId: res.file.id, newVersion: res.newVersion })
  } catch (e) {
    const err = e as Error & { status?: number }
    if (ac.signal.aborted || err.message === 'aborted') {
      update(item.id, { status: items.find((i) => i.id === item.id)?.status === 'cancelled' ? 'cancelled' : 'paused' })
    } else if (err.status === 404) {
      update(item.id, { status: 'error', error: '업로드 정보를 찾을 수 없습니다. 다시 올려 주세요.', uploadId: undefined })
    } else if (!err.status) {
      // Network error (server offline): keep it for a later retry.
      update(item.id, { status: 'paused', error: '서버에 연결할 수 없어 멈췄습니다. 연결되면 이어서 올립니다.' })
    } else {
      update(item.id, { status: 'error', error: err.message })
    }
    log.warn('[transfer] upload failed', err.message)
  } finally {
    aborts.delete(item.id)
    persist()
  }
}

export function cancelTransfer(id: string): void {
  const it = items.find((i) => i.id === id)
  if (!it) return
  update(id, { status: 'cancelled' })
  aborts.get(id)?.abort()
  if (it.direction === 'up' && it.uploadId) void call(`/api/uploads/${it.uploadId}`, { method: 'DELETE' }).catch(() => undefined)
  persist()
}

/** Retry paused/errored uploads (called on reconnect and at startup). */
export function resumeTransfers(): void {
  let changed = false
  for (const i of items) {
    if (i.direction === 'up' && (i.status === 'paused' || (i.status === 'error' && i.uploadId))) {
      i.status = 'queued'
      changed = true
    }
  }
  if (changed) {
    emit()
    void pump()
  }
}

export function clearFinished(): void {
  items = items.filter((i) => i.status === 'queued' || i.status === 'running' || i.status === 'paused')
  emit()
}

/** Load uploads that were in progress when the app last closed. */
export function restoreTransfers(): void {
  const saved = localDb().kv.get<TransferItem[]>(KV_KEY) ?? []
  items = saved.map((i) => ({ ...i, status: 'paused' as const, error: '프로그램을 다시 시작해 이어서 올립니다.' }))
  if (items.length) setTimeout(() => resumeTransfers(), 3000)
}

/** Download to a path, resuming a previous partial download with Range. */
export async function downloadTo(fileId: string, name: string, dest: string, versionId?: string): Promise<string> {
  const id = crypto.randomUUID()
  const part = `${dest}.teamhub-part`
  let start = existsSync(part) ? statSync(part).size : 0
  items.push({ id, direction: 'down', name, path: dest, size: 0, done: start, status: 'running', createdAt: Date.now(), fileId })
  emit()
  const ac = new AbortController()
  aborts.set(id, ac)
  try {
    const url = new URL(`/api/files/${fileId}/download${versionId ? `?version=${versionId}` : ''}`, baseUrl())
    const res = await fetch(url, { headers: headers(start ? { Range: `bytes=${start}-` } : {}), signal: ac.signal })
    if (res.status === 416) start = 0
    if (!res.ok && res.status !== 206) throw new Error(`내려받기 실패 (${res.status})`)
    if (res.status === 200) start = 0
    const total = res.status === 206 ? Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? 0) : Number(res.headers.get('content-length') ?? 0)
    update(id, { size: total, done: start })
    const out = createWriteStream(part, { flags: start ? 'a' : 'w' })
    let done = start
    const reader = res.body!.getReader()
    for (;;) {
      const { value, done: end } = await reader.read()
      if (end) break
      out.write(value)
      done += value.length
      update(id, { done })
    }
    await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())))
    if (existsSync(dest)) rmSync(dest, { force: true })
    renameSync(part, dest)
    update(id, { status: 'done', done: total || done, size: total || done })
    return dest
  } catch (e) {
    update(id, { status: 'error', error: (e as Error).message })
    throw e
  } finally {
    aborts.delete(id)
  }
}

// ---- open in the associated program and watch for saves (M4-3) ----
interface Watch {
  fileId: string
  folderId: string
  name: string
  path: string
  mtime: number
  size: number
  timer: NodeJS.Timeout
  until: number
}
const watches = new Map<string, Watch>()

export function openDir(): string {
  const d = join(tmpdir(), 'TeamHub-open')
  mkdirSync(d, { recursive: true })
  return d
}

export async function openWithApp(fileId: string, name: string, folderId: string): Promise<string> {
  const dir = join(openDir(), fileId)
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, name)
  await downloadTo(fileId, name, dest)
  const err = await shell.openPath(dest)
  if (err) throw new Error(err)
  const st = statSync(dest)
  const prev = watches.get(fileId)
  if (prev) clearInterval(prev.timer)
  const w: Watch = {
    fileId,
    folderId,
    name,
    path: dest,
    mtime: st.mtimeMs,
    size: st.size,
    until: Date.now() + 12 * 3600 * 1000,
    timer: setInterval(() => checkWatch(fileId), 3000)
  }
  watches.set(fileId, w)
  return dest
}

function checkWatch(fileId: string): void {
  const w = watches.get(fileId)
  if (!w) return
  if (Date.now() > w.until || !existsSync(w.path)) {
    clearInterval(w.timer)
    watches.delete(fileId)
    return
  }
  const st = statSync(w.path)
  if (st.mtimeMs !== w.mtime || st.size !== w.size) {
    w.mtime = st.mtimeMs
    w.size = st.size
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('transfer:edited', { fileId, folderId: w.folderId, name: w.name, path: w.path })
  }
}

export function stopWatches(): void {
  for (const w of watches.values()) clearInterval(w.timer)
  watches.clear()
}
