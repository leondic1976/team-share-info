import { app, BrowserWindow, shell } from 'electron'
import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import log from 'electron-log/main'
import { PROTOCOL_VERSION } from '../shared/constants'
import type { TransferItem } from '../shared/ipc'
import { readCredential } from './connection'
import { localDb } from './localdb'
import { winUser } from './ipc/app'

/**
 * File transfers run in the main process (M4-2). Both directions continue from where they
 * stopped, whatever stopped them (network drop, server restart, sleep, the app being closed):
 *  - uploads go in 8MB chunks; the server keeps the received offset and is asked for it
 *    before every continuation
 *  - downloads continue with HTTP Range, and If-Range makes sure the rest still belongs to
 *    the same content
 * A transfer that cannot reach the server waits ("paused") and tries again by itself.
 * Progress is pushed to all windows.
 */
const KV_KEY = 'transfers'
/** A chunk that takes longer than this is given up and sent again from the server's offset. */
const CHUNK_TIMEOUT_MS = 120_000
/** A download that receives nothing for this long is reconnected. */
const STALL_MS = 30_000
const RETRY_MIN_MS = 3_000
const RETRY_MAX_MS = 60_000
/** Server-side failures (5xx) are retried this many times in a row before giving up. */
const MAX_SERVER_FAILS = 10
const PART_SUFFIX = '.teamhub-part'

let items: TransferItem[] = []
let running = false
/** Cancelled by the user. */
const aborts = new Map<string, AbortController>()
/** Downloads waiting before their next try; calling the entry starts the try now. */
const waits = new Map<string, () => void>()
const downloads = new Map<string, Promise<string>>()
/** Failures in a row without any progress, per transfer. */
const fails = new Map<string, number>()
let retryTimer: NodeJS.Timeout | null = null
let retryDelay = 0
let emitTimer: NodeJS.Timeout | null = null

type TransferError = Error & { status?: number; code?: string; fatal?: boolean }

const unfinished = (i: TransferItem): boolean => i.status === 'queued' || i.status === 'running' || i.status === 'paused'

function persist(): void {
  localDb().kv.set(
    KV_KEY,
    items.filter((i) => unfinished(i) && !i.temp)
  )
}

function emit(): void {
  if (emitTimer) {
    clearTimeout(emitTimer)
    emitTimer = null
  }
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('transfer:update', items)
}

function update(id: string, patch: Partial<TransferItem>): void {
  const it = items.find((i) => i.id === id)
  if (it) Object.assign(it, patch)
  emit()
}

/** Byte counters change many times a second: windows are told a few times a second. */
function progress(item: TransferItem, done: number): void {
  item.done = done
  emitTimer ??= setTimeout(emit, 250)
}

/** Worth trying again later: no answer at all (network, timeout) or a failure on the server side. */
function retryable(e: TransferError): boolean {
  if (e.fatal) return false
  return !e.status || e.status >= 500 || e.status === 408 || e.status === 429
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
    const err = new Error(json.error?.message ?? `HTTP ${res.status}`) as TransferError
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
      const next = items.find((i) => i.status === 'queued' && i.direction === 'up')
      if (!next) break
      await runUpload(next)
    }
  } finally {
    running = false
  }
}

/** Try the waiting transfers again after a while (3s, 6s, ... up to a minute apart). */
function scheduleRetry(): void {
  if (retryTimer) return
  retryDelay = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, retryDelay * 2))
  retryTimer = setTimeout(() => {
    retryTimer = null
    resumeTransfers()
  }, retryDelay)
}

interface UploadState {
  state?: 'active' | 'done'
  received: number
  chunkSize: number
  fileId?: string
}

async function runUpload(item: TransferItem): Promise<void> {
  const ac = new AbortController()
  aborts.set(item.id, ac)
  update(item.id, { status: 'running', error: undefined })
  try {
    if (!existsSync(item.path!)) throw Object.assign(new Error('원본 파일을 찾을 수 없습니다.'), { fatal: true })
    const st = statSync(item.path!)
    if (st.size !== item.size || Math.abs(st.mtimeMs - (item.mtimeMs ?? st.mtimeMs)) > 2000) {
      // File changed while waiting: restart from scratch with the new content.
      update(item.id, { size: st.size, mtimeMs: st.mtimeMs, uploadId: undefined, done: 0 })
    }
    let uploadId = item.uploadId
    let offset = 0
    let chunkSize = 8 * 1024 * 1024
    /** Set when the server says the upload was completed already (its answer got lost). */
    let finishedFileId: string | null | undefined
    /** Ask the server where it is. */
    const sync = async (): Promise<void> => {
      const s = await call<UploadState>(`/api/uploads/${uploadId}`, { signal: ac.signal })
      if (s.state === 'done') finishedFileId = s.fileId ?? null
      offset = s.received
      chunkSize = s.chunkSize
    }
    if (uploadId) {
      try {
        await sync()
      } catch (e) {
        // only "the server does not know this upload" starts over; anything else is tried again later
        if ((e as TransferError).status !== 404) throw e
        uploadId = undefined
      }
    }
    if (!uploadId) {
      const s = await call<{ id: string; received: number; chunkSize: number }>('/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: item.name, size: st.size, folderId: item.folderId, fileId: item.fileId, note: item.note ?? '' }),
        signal: ac.signal
      })
      uploadId = s.id
      chunkSize = s.chunkSize
      offset = 0
      update(item.id, { uploadId })
      persist()
    }
    update(item.id, { done: offset })
    const fd = openSync(item.path!, 'r')
    try {
      const buf = Buffer.alloc(chunkSize)
      let conflicts = 0
      while (finishedFileId === undefined && offset < st.size) {
        if (ac.signal.aborted) throw new Error('aborted')
        const n = readSync(fd, buf, 0, Math.min(chunkSize, st.size - offset), offset)
        try {
          const r = await call<{ received: number }>(`/api/uploads/${uploadId}?offset=${offset}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: buf.subarray(0, n),
            signal: AbortSignal.any([ac.signal, AbortSignal.timeout(CHUNK_TIMEOUT_MS)])
          })
          offset = r.received
          conflicts = 0
          retryDelay = 0
          fails.delete(item.id)
        } catch (e) {
          // the server is at another position (part of an interrupted chunk arrived): continue from there
          if ((e as TransferError).status !== 409 || ++conflicts > 5) throw e
          await sync()
        }
        progress(item, offset)
      }
    } finally {
      closeSync(fd)
    }
    if (finishedFileId !== undefined) {
      update(item.id, { status: 'done', done: st.size, fileId: finishedFileId ?? item.fileId })
    } else {
      const res = await call<{ file: { id: string }; newVersion: boolean }>(`/api/uploads/${uploadId}/complete`, { method: 'POST', signal: ac.signal })
      update(item.id, { status: 'done', done: st.size, fileId: res.file.id, newVersion: res.newVersion })
    }
    fails.delete(item.id)
    retryDelay = 0
  } catch (e) {
    const err = e as TransferError
    const n = (fails.get(item.id) ?? 0) + 1
    fails.set(item.id, n)
    if (ac.signal.aborted) {
      update(item.id, { status: item.status === 'cancelled' ? 'cancelled' : 'paused' })
    } else if (err.status === 404) {
      update(item.id, { status: 'error', error: '업로드 정보를 찾을 수 없습니다. 다시 올려 주세요.', uploadId: undefined })
    } else if (retryable(err) && (!err.status || n <= MAX_SERVER_FAILS)) {
      // Network error, timeout or the server restarting: keep it and try again.
      update(item.id, { status: 'paused', error: '서버에 연결할 수 없어 멈췄습니다. 연결되면 이어서 올립니다.' })
      scheduleRetry()
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
  const active = aborts.has(id)
  update(id, { status: 'cancelled', error: undefined })
  aborts.get(id)?.abort()
  if (it.direction === 'up' && it.uploadId) void call(`/api/uploads/${it.uploadId}`, { method: 'DELETE' }).catch(() => undefined)
  // a download that is not running (restored, failed) has nobody else to remove its partial file
  if (it.direction === 'down' && !active && it.path) rmSync(it.path + PART_SUFFIX, { force: true })
  persist()
}

/** Continue waiting transfers now (called on reconnect, at startup and by the retry timer). */
export function resumeTransfers(): void {
  let changed = false
  for (const i of items) {
    if (i.direction === 'up' && (i.status === 'paused' || (i.status === 'error' && i.uploadId))) {
      i.status = 'queued'
      changed = true
    } else if (i.direction === 'down' && i.status === 'paused') {
      if (downloads.has(i.id)) waits.get(i.id)?.()
      else void startDownload(i).catch(() => undefined)
    }
  }
  if (changed) {
    emit()
    void pump()
  }
}

/** "다시 시도" on a transfer that failed, was cancelled or is waiting. */
export function retryTransfer(id: string): void {
  const it = items.find((i) => i.id === id)
  if (!it || (it.status !== 'error' && it.status !== 'cancelled' && it.status !== 'paused')) return
  fails.delete(id)
  if (it.direction === 'up') {
    update(id, { status: 'queued', error: undefined })
    persist()
    void pump()
  } else if (downloads.has(id)) {
    waits.get(id)?.()
  } else {
    void startDownload(it).catch(() => undefined)
  }
}

export function clearFinished(): void {
  items = items.filter(unfinished)
  emit()
}

/** Load transfers that were in progress when the app last closed and continue them. */
export function restoreTransfers(): void {
  const saved = localDb().kv.get<TransferItem[]>(KV_KEY) ?? []
  items = saved.map((i) => ({
    ...i,
    status: 'paused' as const,
    error: i.direction === 'up' ? '프로그램을 다시 시작해 이어서 올립니다.' : '프로그램을 다시 시작해 이어서 받습니다.'
  }))
  if (items.length) setTimeout(() => resumeTransfers(), 3000)
}

/**
 * Download to a path. Resolves when the file is complete: a dropped connection is retried from
 * the last received byte for as long as it takes; only a refusal by the server, a disk problem
 * or a cancel ends it.
 */
export function downloadTo(fileId: string, name: string, dest: string, versionId?: string, opts: { temp?: boolean } = {}): Promise<string> {
  // the same file asked for again while (or after) an earlier try: continue that one
  const prev = items.find((i) => i.direction === 'down' && i.path === dest && i.fileId === fileId && i.versionId === versionId && i.status !== 'done')
  const going = prev ? downloads.get(prev.id) : undefined
  if (prev && going && prev.status !== 'cancelled') {
    waits.get(prev.id)?.()
    return going
  }
  if (prev) items = items.filter((i) => i !== prev)
  // a partial file is continued only when we know which content it belongs to
  const etag = prev && prev.status !== 'cancelled' ? prev.etag : undefined
  if (!etag) rmSync(dest + PART_SUFFIX, { force: true })
  const item: TransferItem = {
    id: crypto.randomUUID(),
    direction: 'down',
    name,
    path: dest,
    size: prev?.size ?? 0,
    done: 0,
    status: 'running',
    createdAt: Date.now(),
    fileId,
    versionId,
    etag,
    temp: opts.temp
  }
  items.push(item)
  persist()
  emit()
  return startDownload(item)
}

function startDownload(item: TransferItem): Promise<string> {
  const p = runDownload(item).finally(() => downloads.delete(item.id))
  downloads.set(item.id, p)
  return p
}

/** Wait before the next try; resumeTransfers (reconnect) and "다시 시도" end the wait early. */
function waitForRetry(id: string, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const end = (): void => {
      clearTimeout(timer)
      waits.delete(id)
      signal.removeEventListener('abort', end)
      resolve()
    }
    const timer = setTimeout(end, ms)
    waits.set(id, end)
    signal.addEventListener('abort', end, { once: true })
  })
}

async function runDownload(item: TransferItem): Promise<string> {
  const ac = new AbortController()
  aborts.set(item.id, ac)
  const dest = item.path!
  const part = dest + PART_SUFFIX
  update(item.id, { status: 'running', error: undefined })
  let failed = 0
  try {
    for (;;) {
      try {
        await downloadAttempt(item, part, ac.signal, () => (failed = 0))
        break
      } catch (e) {
        const err = e as TransferError
        if (ac.signal.aborted) throw err
        failed++
        if (!retryable(err) || (err.status && failed > MAX_SERVER_FAILS)) throw err
        log.warn(`[transfer] download interrupted (${err.message}); try ${failed}`)
        update(item.id, { status: 'paused', error: '연결이 끊겨 멈췄습니다. 연결되면 이어서 받습니다.' })
        await waitForRetry(item.id, Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(failed - 1, 5)), ac.signal)
        if (ac.signal.aborted) throw err
        update(item.id, { status: 'running', error: undefined })
      }
    }
    if (existsSync(dest)) rmSync(dest, { force: true })
    renameSync(part, dest)
    update(item.id, { status: 'done', done: item.size || item.done, size: item.size || item.done, error: undefined })
    return dest
  } catch (e) {
    const err = e as TransferError
    if (ac.signal.aborted) {
      rmSync(part, { force: true })
      update(item.id, { status: 'cancelled', error: undefined })
      throw new Error('내려받기를 취소했습니다.', { cause: e })
    }
    update(item.id, { status: 'error', error: err.message })
    log.warn('[transfer] download failed', err.message)
    throw err
  } finally {
    aborts.delete(item.id)
    persist()
  }
}

/** One connection: continue the partial file (or start it) and read until the end or a failure. */
async function downloadAttempt(item: TransferItem, part: string, cancel: AbortSignal, onData: () => void): Promise<void> {
  let start = existsSync(part) ? statSync(part).size : 0
  if (start && !item.etag) start = 0
  const attempt = new AbortController()
  const stop = (): void => attempt.abort()
  cancel.addEventListener('abort', stop, { once: true })
  let stall: NodeJS.Timeout | undefined
  const alive = (): void => {
    clearTimeout(stall)
    stall = setTimeout(() => attempt.abort(new Error('stalled')), STALL_MS)
  }
  let diskError: Error | undefined
  try {
    alive()
    const url = new URL(`/api/files/${item.fileId}/download${item.versionId ? `?version=${item.versionId}` : ''}`, baseUrl())
    const res = await fetch(url, { headers: headers(start ? { Range: `bytes=${start}-`, 'If-Range': item.etag! } : {}), signal: attempt.signal })
    if (res.status === 416) {
      // the partial file does not fit this content: start over on the next try
      await res.body?.cancel().catch(() => undefined)
      rmSync(part, { force: true })
      throw new Error('restart')
    }
    if (!res.ok) {
      let message = res.status === 404 ? '파일을 찾을 수 없습니다(삭제되었거나 볼 권한이 없습니다).' : `내려받기 실패 (${res.status})`
      try {
        message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message
      } catch {
        // keep the default message
      }
      throw Object.assign(new Error(message), { status: res.status })
    }
    // 200 = the whole content (first try, or the content changed since the partial file was written)
    if (res.status === 200) start = 0
    const total = res.status === 206 ? Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? 0) : Number(res.headers.get('content-length') ?? 0)
    update(item.id, { status: 'running', error: undefined, size: total, done: start, etag: res.headers.get('etag') ?? undefined })
    persist()
    const out = createWriteStream(part, { flags: start ? 'a' : 'w' })
    out.on('error', (e) => (diskError = e))
    let done = start
    try {
      const reader = res.body!.getReader()
      for (;;) {
        const { value, done: end } = await reader.read()
        if (end) break
        alive()
        // wait for the disk when it is slower than the network, instead of piling the file up in memory
        if (!out.write(value)) await once(out, 'drain')
        done += value.length
        onData()
        progress(item, done)
      }
    } finally {
      // what arrived is flushed, so the next try continues exactly after it
      await new Promise<void>((r) => out.end(() => r()))
    }
    if (total && done !== total) throw new Error('incomplete')
  } catch (e) {
    if (diskError) throw Object.assign(new Error(`파일을 저장할 수 없습니다: ${diskError.message}`), { fatal: true })
    throw e
  } finally {
    clearTimeout(stall)
    cancel.removeEventListener('abort', stop)
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
  await downloadTo(fileId, name, dest, undefined, { temp: true })
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
