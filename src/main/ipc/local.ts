import { app, dialog, BrowserWindow } from 'electron'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { backup } from 'node:sqlite'
import { z } from 'zod'
import { handle } from './registry'
import { closeLocalDb, localDb, openLocalDb } from '../localdb'
import { vaultOpen, vaultSeal } from '../vault'
import type { OutboxItem } from '../../shared/ipc'

/** Cached server data older than this is dropped: stale team data should not sit on a PC for good. */
const CACHE_KEEP_MS = 60 * 86400_000
const CACHE_MAX_ROWS = 2000
const OUTBOX_MAX = 200
const likePrefix = (p: string): string => p.replace(/[%_]/g, '')

const keySchema = z.string().min(1).max(200)

export function registerLocalIpc(): void {
  handle('local:kv.get', z.object({ key: keySchema }), ({ key }) => localDb().kv.get(key) ?? null)
  handle('local:kv.set', z.object({ key: keySchema, value: z.unknown() }), ({ key, value }) => {
    localDb().kv.set(key, value)
  })
  handle('local:kv.delete', z.object({ key: keySchema }), ({ key }) => {
    localDb().kv.delete(key)
  })
  handle('local:kv.all', null, () => localDb().kv.all())

  handle('local:export', null, async (_req, e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const stamp = new Date().toISOString().slice(0, 10)
    const opts = {
      title: '개인 데이터 내보내기',
      defaultPath: `TeamHub-개인데이터-${stamp}.db`,
      filters: [{ name: 'TeamHub 개인 데이터', extensions: ['db'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { ok: false }
    try {
      if (existsSync(r.filePath)) rmSync(r.filePath)
      await backup(localDb().db.raw, r.filePath)
      return { ok: true, path: r.filePath }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  handle('local:import', null, async (_req, e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts = {
      title: '개인 데이터 가져오기',
      properties: ['openFile' as const],
      filters: [{ name: 'TeamHub 개인 데이터', extensions: ['db'] }]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const src = r.filePaths[0]
    if (r.canceled || !src) return { ok: false }
    const target = localDb().db.path
    const safety = `${target}.before-import`
    try {
      await backup(localDb().db.raw, safety)
      closeLocalDb()
      for (const ext of ['', '-wal', '-shm']) rmSync(target + ext, { force: true })
      copyFileSync(src, target)
      openLocalDb(target)
      app.relaunch()
      app.exit(0)
      return { ok: true, path: src }
    } catch (err) {
      // restore the previous data if the import failed midway
      try {
        closeLocalDb()
        copyFileSync(safety, target)
      } catch {
        // ignore
      }
      openLocalDb(target)
      return { ok: false, error: String(err) }
    }
  })

  // ---------- read cache of server data (13.11, M8-3): shown while the server is unreachable ----------
  // Values are sealed with a key kept under Windows DPAPI (vault.ts); without the key nothing is stored.
  handle('local:cache.save', z.object({ entries: z.array(z.object({ key: z.string().max(500), value: z.string().max(2_000_000) })).max(200) }), async ({ entries }) => {
    const sealed: { key: string; value: string }[] = []
    for (const e of entries) {
      const v = await vaultSeal(e.value)
      if (v === null) return
      sealed.push({ key: e.key, value: v })
    }
    const db = localDb().db
    const t = Date.now()
    db.tx(() => {
      for (const e of sealed) db.run('INSERT INTO query_cache (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [e.key, e.value, t])
      db.run('DELETE FROM query_cache WHERE updated_at < ?', [t - CACHE_KEEP_MS])
      db.run('DELETE FROM query_cache WHERE key NOT IN (SELECT key FROM query_cache ORDER BY updated_at DESC LIMIT ?)', [CACHE_MAX_ROWS])
    })
  })
  handle('local:cache.load', z.object({ prefix: z.string().max(200) }), async ({ prefix }) => {
    const rows = localDb().db.all<{ key: string; value: string; updated_at: number }>('SELECT key, value, updated_at FROM query_cache WHERE key LIKE ? AND updated_at >= ? ORDER BY updated_at DESC', [`${likePrefix(prefix)}%`, Date.now() - CACHE_KEEP_MS])
    const out: { key: string; value: string; updatedAt: number }[] = []
    for (const r of rows) {
      const v = await vaultOpen(r.value)
      if (v !== null) out.push({ key: r.key, value: v, updatedAt: r.updated_at })
    }
    return out
  })
  handle('local:cache.clear', z.object({ prefix: z.string().max(200) }), ({ prefix }) => {
    if (prefix) localDb().db.run('DELETE FROM query_cache WHERE key LIKE ?', [`${likePrefix(prefix)}%`])
    else localDb().db.run('DELETE FROM query_cache')
  })

  // ---------- outbox: written while the server was unreachable, sent when it is back ----------
  const owner = z.string().min(1).max(100)
  handle('local:outbox.list', z.object({ owner }), async (req) => {
    const rows = localDb().db.all<{ id: string; kind: string; label: string; body: string; state: string; error: string; created_at: number }>('SELECT * FROM outbox WHERE owner = ? ORDER BY created_at, rowid', [req.owner])
    const out: OutboxItem[] = []
    for (const r of rows) {
      const body = await vaultOpen(r.body)
      const label = await vaultOpen(r.label)
      // a row this PC cannot open (data copied from another PC) can never be sent
      if (body === null) localDb().db.run('DELETE FROM outbox WHERE id = ?', [r.id])
      else out.push({ id: r.id, kind: r.kind, label: label ?? '', body, state: r.state === 'failed' ? 'failed' : 'waiting', error: r.error, createdAt: r.created_at })
    }
    return out
  })
  handle('local:outbox.add', z.object({ id: z.string().uuid(), owner, kind: z.string().min(1).max(40), label: z.string().max(200), body: z.string().max(1_000_000) }), async (req) => {
    // the label quotes what was written, so it is sealed like the body
    const body = await vaultSeal(req.body)
    const label = await vaultSeal(req.label)
    if (body === null || label === null) return false
    const db = localDb().db
    if ((db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox WHERE owner = ?', [req.owner])?.n ?? 0) >= OUTBOX_MAX) return false
    db.run('INSERT OR IGNORE INTO outbox (id, owner, kind, label, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', [req.id, req.owner, req.kind, label, body, Date.now()])
    return true
  })
  handle('local:outbox.update', z.object({ id: z.string().uuid(), state: z.enum(['waiting', 'failed']), error: z.string().max(500) }), (req) => {
    localDb().db.run('UPDATE outbox SET state = ?, error = ? WHERE id = ?', [req.state, req.error, req.id])
  })
  handle('local:outbox.remove', z.object({ id: z.string().uuid() }), ({ id }) => {
    localDb().db.run('DELETE FROM outbox WHERE id = ?', [id])
  })
}
